// Price protection against real Postgres with fake Channel3, PayPal and email: one price drop refunds an
// order once, replays and redeliveries do nothing, and later events only refund what's still owed.
// Runs in a rolled-back transaction, and is skipped when no database is reachable.
import "../scripts/load-env";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Channel3Service } from "./channel3";
import type { Db } from "./db";
import * as schema from "./db/schema";
import type { EmailService } from "./email";
import type { PayPalService, RefundInput } from "./paypal";
import { enrolProtection, processPriceEvent, recordPriceEvent, replaySimulatedDrop, type ProtectionDeps } from "./price-protection";

const url = process.env.DATABASE_URL;
const client = url ? postgres(url, { max: 1, connect_timeout: 2, onnotice: () => {} }) : null;
const reachable = client ? await client`select 1`.then(() => true, () => false) : false;
afterAll(() => client?.end());

class Rollback extends Error {}
async function inRolledBackTransaction(fn: (db: Db) => Promise<void>) {
  const db = drizzle({ client: client!, schema });
  await expect(
    db.transaction(async (tx) => {
      await fn(tx as unknown as Db);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
}

const C3_ID = "TESTc3prod";
const offers = [{ domain: "zappos.com", url: "https://zappos.com/x", price: { price: 25, currency: "USD" }, availability: "InStock", condition: "new" }];

function fakes(db: Db) {
  const refundCalls: RefundInput[] = [];
  const paypal = {
    mode: "demo",
    refundCapture: vi.fn(async (input: RefundInput) => {
      refundCalls.push(input);
      return { refundId: `REF-${input.requestId.slice(-6)}`, status: "COMPLETED", amountCents: input.amountCents, currency: "USD", raw: {} };
    }),
  } as unknown as PayPalService;
  const channel3 = {
    mode: "demo",
    retrieve: vi.fn(async () => ({ id: C3_ID, offers })),
    priceHistory: vi.fn(async () => ({ history: [{ timestamp: new Date(), price: 25, currency: "USD" }] })),
    listTrackedProductIds: vi.fn(async () => []),
    startTracking: vi.fn(async () => ({})),
  } as unknown as Channel3Service;
  const email = { transport: "log", send: vi.fn(async () => ({ id: "log-1", transport: "log" })) } as unknown as EmailService;
  const deps: ProtectionDeps = { db, channel3, paypal, email, appUrl: "http://localhost:3000", now: () => new Date() };
  return { deps, refundCalls, channel3, email };
}

async function seedOrder(db: Db, pricePaidCents = 2799) {
  const [policy] = await db
    .insert(schema.policies)
    .values({
      version: 999_999,
      approvedDomains: ["zappos.com"],
      marginFloorBps: 1500,
      maxDiscountBps: 2000,
      protectionDays: 14,
      autoRefundCapCents: 5000,
      minRefundCents: 100,
    })
    .returning();
  const [product] = await db
    .insert(schema.products)
    .values({
      slug: "test-protected-socks",
      channel3ProductId: C3_ID,
      title: "Test socks",
      shopPriceCents: pricePaidCents,
      unitCostCents: 1000,
      channel3Snapshot: { offers },
    })
    .returning();
  const [order] = await db
    .insert(schema.orders)
    .values({
      paypalOrderId: "TEST-ORDER-1",
      paypalCaptureId: "TEST-CAPTURE-1",
      productId: product.id,
      pricePaidCents,
      status: "completed",
      buyerEmail: "buyer@example.com",
      capturedAt: new Date(Date.now() - 60_000),
    })
    .returning();
  return { policy, product, order };
}

describe.skipIf(!reachable)("price protection (Postgres)", () => {
  it("enrols a captured order once and starts tracking", async () => {
    await inRolledBackTransaction(async (db) => {
      const { order } = await seedOrder(db);
      const { deps, channel3 } = fakes(db);
      const first = await enrolProtection(order.id, deps);
      const again = await enrolProtection(order.id, deps);
      expect(again?.id).toBe(first?.id);
      expect(first?.windowEndsAt.getTime()).toBe(order.capturedAt!.getTime() + 14 * 86_400_000);
      expect(channel3.startTracking).toHaveBeenCalledWith(C3_ID);
    });
  });

  it("refunds a price drop once: replaying or reprocessing the same event does nothing", async () => {
    await inRolledBackTransaction(async (db) => {
      const { order } = await seedOrder(db);
      const { deps, refundCalls, email } = fakes(db);
      const protection = (await enrolProtection(order.id, deps))!;

      const first = await replaySimulatedDrop(protection.id, deps);
      expect(first.duplicate).toBe(false);
      expect(first.outcomes).toMatchObject([{ decision: "refund", amountCents: 600, refund: { status: "completed" } }]);
      expect(refundCalls).toHaveLength(1);
      expect(refundCalls[0]).toMatchObject({ captureId: "TEST-CAPTURE-1", amountCents: 600, requestId: `pp-${protection.id}-${first.eventId}` });
      expect(refundCalls[0].noteToPayer).toMatch(/^\[SIMULATED price drop, demo\]/);
      expect(email.send).toHaveBeenCalledTimes(1);

      const replay = await replaySimulatedDrop(protection.id, deps);
      expect(replay).toMatchObject({ duplicate: true, eventId: first.eventId, outcomes: [{ decision: "duplicate" }] });
      expect(await processPriceEvent(first.eventId, deps)).toMatchObject([{ decision: "duplicate" }]);
      expect(refundCalls).toHaveLength(1);

      const refunds = await db.select().from(schema.refunds).where(eq(schema.refunds.protectionId, protection.id));
      expect(refunds).toHaveLength(1);
      expect(refunds[0].decisionReasons[0].code).toBe("simulated_drop");
      const [updated] = await db.select().from(schema.orders).where(eq(schema.orders.id, order.id));
      expect(updated.status).toBe("partially_refunded");
    });
  });

  it("a later, deeper drop refunds only the remaining difference; a shallower one nothing", async () => {
    await inRolledBackTransaction(async (db) => {
      const { order, product } = await seedOrder(db);
      const { deps, refundCalls } = fakes(db);
      await enrolProtection(order.id, deps);
      const event = (externalId: string, newPriceCents: number) =>
        recordPriceEvent(db, { source: "webhook", externalId, channel3ProductId: C3_ID, productId: product.id, domain: "zappos.com", newPriceCents, verified: true, rawPayload: {} });

      const a = await event("svix:test-a", 2500);
      expect(await processPriceEvent(a.event.id, deps)).toMatchObject([{ decision: "refund", amountCents: 299 }]);
      const b = await event("svix:test-b", 2600);
      expect(await processPriceEvent(b.event.id, deps)).toMatchObject([{ decision: "skip" }]);
      const c = await event("svix:test-c", 2199);
      expect(await processPriceEvent(c.event.id, deps)).toMatchObject([{ decision: "refund", amountCents: 301 }]);
      expect((await event("svix:test-c", 2199)).duplicate).toBe(true);
      expect(refundCalls.map((r) => r.amountCents)).toEqual([299, 301]);
    });
  });

  it("queues a drop over the cap without calling PayPal", async () => {
    await inRolledBackTransaction(async (db) => {
      const { order } = await seedOrder(db, 39900);
      const { deps, refundCalls } = fakes(db);
      const protection = (await enrolProtection(order.id, deps))!;
      const out = await replaySimulatedDrop(protection.id, deps);
      expect(out.outcomes).toMatchObject([{ decision: "queue", amountCents: 8001, refund: { status: "pending_approval" } }]);
      expect(refundCalls).toHaveLength(0);
    });
  });
});
