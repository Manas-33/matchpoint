// Price protection (PLAN.md Phase 4): enrol captured orders, record price events (Channel3 webhook,
// fallback poll, demo replay), run the rules in lib/protection.ts against every active protection for
// the product, and issue PayPal partial refunds. Each refund is keyed on (protection, price event) in the
// database and in its PayPal-Request-Id, so one price drop refunds an order at most once.
import { and, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { getChannel3, type Channel3Service, type Product as Channel3Product } from "./channel3";
import { getDb, schema, type Db } from "./db";
import type { DecisionReason } from "./db/schema";
import { getEmail, type EmailService } from "./email";
import { getEnv } from "./env";
import { listFixtures, loadFixture } from "./fixtures";
import { dollarsToCents, formatCents, type Cents } from "./money";
import { getPayPal, type PayPalService } from "./paypal";
import {
  evaluatePriceDrop,
  isApprovedDomain,
  normalizeDomain,
  refundRequestId,
  isSimulated,
  parseChannel3Time,
  type OfferCheck,
  type ProtectionDecision,
} from "./protection";
import { loadEvidence, renderEvidenceEmail } from "./evidence";
import { SHOP } from "./shop-info";

const DAY_MS = 24 * 60 * 60 * 1000;

export type ProtectionDeps = {
  db: Db;
  channel3: Channel3Service;
  paypal: PayPalService;
  email: EmailService;
  appUrl: string;
  now: () => Date;
};

export const defaultDeps = (): ProtectionDeps => ({
  db: getDb(),
  channel3: getChannel3(),
  paypal: getPayPal(),
  email: getEmail(),
  appUrl: getEnv().APP_URL,
  now: () => new Date(),
});

type PriceEvent = typeof schema.priceEvents.$inferSelect;
type Refund = typeof schema.refunds.$inferSelect;
type RefundStatus = Refund["status"];

const log = (msg: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ msg, ...fields }));

async function activePolicy(db: Db) {
  const [policy] = await db.select().from(schema.policies).orderBy(desc(schema.policies.version)).limit(1);
  if (!policy) throw new Error("No policy found (run `npm run seed`)");
  return policy;
}

// ---------------------------------------------------------------------------------------------------
// Enrolment

// Creates the order's protection (once) and makes sure Channel3 tracks the product's price. Tracking
// failures are logged, not thrown: the fallback poll still covers the order.
export async function enrolProtection(orderId: string, deps: ProtectionDeps = defaultDeps()) {
  const { db } = deps;
  const [row] = await db
    .select({ order: schema.orders, product: schema.products })
    .from(schema.orders)
    .innerJoin(schema.products, eq(schema.orders.productId, schema.products.id))
    .where(eq(schema.orders.id, orderId))
    .limit(1);
  if (!row?.order.capturedAt || !["completed", "partially_refunded"].includes(row.order.status)) return null;

  const policy = await activePolicy(db);
  const windowEndsAt = new Date(row.order.capturedAt.getTime() + policy.protectionDays * DAY_MS);
  const [created] = await db
    .insert(schema.protections)
    .values({ orderId, channel3ProductId: row.product.channel3ProductId, windowEndsAt })
    .onConflictDoNothing({ target: schema.protections.orderId })
    .returning();
  const protection =
    created ?? (await db.select().from(schema.protections).where(eq(schema.protections.orderId, orderId)))[0];
  if (created) log("protection enrolled", { orderId, protectionId: created.id, windowEndsAt });

  try {
    const tracked = await deps.channel3.listTrackedProductIds();
    if (!tracked.includes(row.product.channel3ProductId)) {
      await deps.channel3.startTracking(row.product.channel3ProductId);
      log("channel3 tracking started", { channel3ProductId: row.product.channel3ProductId });
    }
  } catch (err) {
    console.error(JSON.stringify({ msg: "channel3 tracking failed", channel3ProductId: row.product.channel3ProductId, error: String(err) }));
  }
  return protection;
}

// Marks protections whose window has ended as expired.
async function expireProtections(deps: ProtectionDeps) {
  await deps.db
    .update(schema.protections)
    .set({ status: "expired" })
    .where(and(eq(schema.protections.status, "active"), lt(schema.protections.windowEndsAt, deps.now())));
}

// ---------------------------------------------------------------------------------------------------
// Price events

export type NewPriceEvent = typeof schema.priceEvents.$inferInsert;

// Stores the event once per external ID. A redelivery returns the stored row with duplicate: true.
export async function recordPriceEvent(db: Db, row: NewPriceEvent): Promise<{ event: PriceEvent; duplicate: boolean }> {
  const productId = row.productId ?? (await productIdFor(db, row.channel3ProductId));
  const [inserted] = await db
    .insert(schema.priceEvents)
    .values({ ...row, productId })
    .onConflictDoNothing({ target: schema.priceEvents.externalId })
    .returning();
  if (inserted) return { event: inserted, duplicate: false };
  const [existing] = await db.select().from(schema.priceEvents).where(eq(schema.priceEvents.externalId, row.externalId!));
  return { event: existing, duplicate: true };
}

async function productIdFor(db: Db, channel3ProductId: string) {
  const [p] = await db
    .select({ id: schema.products.id })
    .from(schema.products)
    .where(eq(schema.products.channel3ProductId, channel3ProductId));
  return p?.id ?? null;
}

const observedAt = (event: PriceEvent) =>
  parseChannel3Time((event.rawPayload as { timestamp?: unknown }).timestamp) ?? event.receivedAt;

function offerAt(product: Channel3Product | null, domain: string | null): OfferCheck {
  if (!product || !domain) return null;
  const offer = product.offers?.find((o) => normalizeDomain(o.domain) === normalizeDomain(domain));
  return offer ? { availability: offer.availability ?? null, condition: offer.condition ?? null } : null;
}

// ---------------------------------------------------------------------------------------------------
// Evaluation

export type ProtectionOutcome = {
  protectionId: string;
  orderId: string;
  decision: ProtectionDecision["action"] | "duplicate";
  amountCents: Cents;
  reasons: DecisionReason[];
  refund?: Pick<Refund, "id" | "status" | "paypalRefundId" | "amountCents">;
  error?: string;
};

// Already refunded or reserved for an order, not counting this event's own refund.
const COUNTED: RefundStatus[] = ["completed", "processing", "pending_approval"];

// Runs the rules for one price event against every active protection on its product. Safe to repeat:
// an event that already produced a refund for a protection reports "duplicate" (or retries a failed call
// with the same PayPal-Request-Id).
export async function processPriceEvent(eventId: string, deps: ProtectionDeps = defaultDeps()): Promise<ProtectionOutcome[]> {
  const { db } = deps;
  await expireProtections(deps);
  const [event] = await db.select().from(schema.priceEvents).where(eq(schema.priceEvents.id, eventId));
  if (!event) throw new Error(`Price event ${eventId} not found`);

  const candidates = await db
    .select({ protection: schema.protections, order: schema.orders })
    .from(schema.protections)
    .innerJoin(schema.orders, eq(schema.protections.orderId, schema.orders.id))
    .where(and(eq(schema.protections.channel3ProductId, event.channel3ProductId), eq(schema.protections.status, "active")));
  if (candidates.length === 0) {
    log("price event: no active protections", { eventId, channel3ProductId: event.channel3ProductId });
    return [];
  }

  const policy = await activePolicy(db);
  // Stock and condition at the event's store, as Channel3 lists them now. Only needed (and only paid
  // for) when the store is approved.
  const product = isApprovedDomain(event.domain, policy.approvedDomains)
    ? await deps.channel3.retrieve(event.channel3ProductId)
    : null;
  const offer = offerAt(product, event.domain);

  const outcomes: ProtectionOutcome[] = [];
  for (const { protection, order } of candidates) {
    outcomes.push(await evaluateOne(deps, event, protection, order, offer, policy));
  }
  return outcomes;
}

async function evaluateOne(
  deps: ProtectionDeps,
  event: PriceEvent,
  protection: typeof schema.protections.$inferSelect,
  order: typeof schema.orders.$inferSelect,
  offer: OfferCheck,
  policy: Awaited<ReturnType<typeof activePolicy>>,
): Promise<ProtectionOutcome> {
  const base = { protectionId: protection.id, orderId: order.id };
  const r = schema.refunds;

  // Decide and reserve in one transaction, with the protection row locked, so two events for the same
  // order can't both count the same headroom.
  const reserved = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from protections where id = ${protection.id} for update`);
    const [existing] = await tx.select().from(r).where(and(eq(r.protectionId, protection.id), eq(r.priceEventId, event.id)));
    if (existing) return { existing };

    const [{ total }] = await tx
      .select({ total: sql<number>`coalesce(sum(${r.amountCents}), 0)::int` })
      .from(r)
      .where(and(eq(r.protectionId, protection.id), inArray(r.status, COUNTED), ne(r.priceEventId, event.id)));

    const decision = evaluatePriceDrop(
      {
        channel3ProductId: event.channel3ProductId,
        domain: event.domain,
        newPriceCents: event.newPriceCents,
        currency: event.currency,
        observedAt: observedAt(event),
      },
      {
        channel3ProductId: protection.channel3ProductId,
        status: protection.status,
        pricePaidCents: order.pricePaidCents,
        currency: order.currency,
        capturedAt: order.capturedAt ?? protection.createdAt,
        windowEndsAt: protection.windowEndsAt,
        alreadyRefundedCents: total,
      },
      offer,
      policy,
    );
    const reasons = isSimulated(event)
      ? [{ code: "simulated_drop", message: "SIMULATED price drop (demo replay): this price was not observed at the store." }, ...decision.reasons]
      : decision.reasons;
    if (decision.action === "skip") return { decision, reasons };

    const [refund] = await tx
      .insert(r)
      .values({
        protectionId: protection.id,
        priceEventId: event.id,
        amountCents: decision.amountCents,
        currency: order.currency,
        paypalRequestId: refundRequestId(protection.id, event.id),
        status: decision.action === "refund" ? "processing" : "pending_approval",
        decisionReasons: reasons,
        approvedBy: decision.action === "refund" ? "auto" : null,
      })
      .returning();
    return { decision, reasons, refund };
  });

  if ("existing" in reserved && reserved.existing) {
    const existing = reserved.existing;
    // A call that failed or never finished is retried with the same PayPal-Request-Id.
    if (existing.status === "processing" || existing.status === "failed") {
      const issued = await issueRefund(existing.id, deps);
      return { ...base, decision: "refund", amountCents: existing.amountCents, reasons: existing.decisionReasons, refund: issued.refund, error: issued.error };
    }
    log("price event: already decided", { ...base, eventId: event.id, refundId: existing.id, status: existing.status });
    return { ...base, decision: "duplicate", amountCents: 0, reasons: existing.decisionReasons, refund: pickRefund(existing) };
  }

  const { decision, reasons, refund } = reserved as { decision: ProtectionDecision; reasons: DecisionReason[]; refund?: Refund };
  log("price event evaluated", { ...base, eventId: event.id, action: decision.action, amountCents: decision.amountCents, codes: reasons.map((x) => x.code) });
  if (!refund) return { ...base, decision: decision.action, amountCents: 0, reasons };
  if (decision.action === "queue") return { ...base, decision: "queue", amountCents: refund.amountCents, reasons, refund: pickRefund(refund) };

  const issued = await issueRefund(refund.id, deps);
  return { ...base, decision: "refund", amountCents: refund.amountCents, reasons, refund: issued.refund, error: issued.error };
}

const pickRefund = (r: Refund) => ({ id: r.id, status: r.status, paypalRefundId: r.paypalRefundId, amountCents: r.amountCents });

// ---------------------------------------------------------------------------------------------------
// Refunds

export function noteToPayer(o: { domain: string | null; newPriceCents: Cents; paidCents: Cents; amountCents: Cents; simulated: boolean }) {
  const note = `${SHOP.name} price protection: ${o.domain ?? "an approved store"} now sells your item for ${formatCents(
    o.newPriceCents,
  )} (you paid ${formatCents(o.paidCents)}), so we refunded ${formatCents(o.amountCents)}.`;
  return (o.simulated ? `[SIMULATED price drop, demo] ${note}` : note).slice(0, 255);
}

// Sends the refund to PayPal (or resends it: the PayPal-Request-Id makes that safe), records the
// result and emails the evidence card.
export async function issueRefund(refundId: string, deps: ProtectionDeps = defaultDeps()) {
  const { db } = deps;
  const [row] = await db
    .select({ refund: schema.refunds, order: schema.orders, event: schema.priceEvents })
    .from(schema.refunds)
    .innerJoin(schema.protections, eq(schema.refunds.protectionId, schema.protections.id))
    .innerJoin(schema.orders, eq(schema.protections.orderId, schema.orders.id))
    .innerJoin(schema.priceEvents, eq(schema.refunds.priceEventId, schema.priceEvents.id))
    .where(eq(schema.refunds.id, refundId));
  if (!row) throw new Error(`Refund ${refundId} not found`);
  const { refund, order, event } = row;
  if (!order.paypalCaptureId) throw new Error(`Order ${order.id} has no PayPal capture`);

  try {
    const issued = await deps.paypal.refundCapture({
      captureId: order.paypalCaptureId,
      amountCents: refund.amountCents,
      currency: refund.currency,
      invoiceId: `refund-${refund.id}`,
      requestId: refund.paypalRequestId,
      noteToPayer: noteToPayer({
        domain: event.domain,
        newPriceCents: event.newPriceCents,
        paidCents: order.pricePaidCents,
        amountCents: refund.amountCents,
        simulated: isSimulated(event),
      }),
    });
    if (issued.amountCents !== refund.amountCents) {
      throw new Error(`PayPal refunded ${issued.amountCents}, expected ${refund.amountCents}`);
    }
    const status: RefundStatus = issued.status === "COMPLETED" ? "completed" : issued.status === "PENDING" ? "processing" : "failed";
    const [updated] = await db
      .update(schema.refunds)
      .set({ paypalRefundId: issued.refundId, status })
      .where(eq(schema.refunds.id, refund.id))
      .returning();

    const [{ total }] = await db
      .select({ total: sql<number>`coalesce(sum(${schema.refunds.amountCents}), 0)::int` })
      .from(schema.refunds)
      .where(and(eq(schema.refunds.protectionId, refund.protectionId), eq(schema.refunds.status, "completed")));
    await db
      .update(schema.orders)
      .set({ status: total >= order.pricePaidCents ? "refunded" : "partially_refunded" })
      .where(eq(schema.orders.id, order.id));
    log("refund issued", { refundId: refund.id, paypalRefundId: issued.refundId, status: issued.status, amountCents: refund.amountCents, orderId: order.id });

    if (status !== "failed") await sendEvidenceEmail(refund.id, deps);
    return { refund: pickRefund(updated) };
  } catch (err) {
    const [updated] = await db.update(schema.refunds).set({ status: "failed" }).where(eq(schema.refunds.id, refund.id)).returning();
    console.error(JSON.stringify({ msg: "refund failed", refundId: refund.id, error: String(err) }));
    return { refund: pickRefund(updated), error: String(err) };
  }
}

// The owner approves a refund over the cap: it is issued with the same PayPal-Request-Id.
export async function approveRefund(refundId: string, deps: ProtectionDeps = defaultDeps()) {
  const [updated] = await deps.db
    .update(schema.refunds)
    .set({ status: "processing", approvedBy: "owner" })
    .where(and(eq(schema.refunds.id, refundId), eq(schema.refunds.status, "pending_approval")))
    .returning();
  if (!updated) return { error: "Not pending approval" };
  return issueRefund(refundId, deps);
}

export async function rejectRefund(refundId: string, deps: ProtectionDeps = defaultDeps()) {
  const [updated] = await deps.db
    .update(schema.refunds)
    .set({ status: "rejected", approvedBy: "owner" })
    .where(and(eq(schema.refunds.id, refundId), eq(schema.refunds.status, "pending_approval")))
    .returning();
  return updated ? { refund: pickRefund(updated) } : { error: "Not pending approval" };
}

async function sendEvidenceEmail(refundId: string, deps: ProtectionDeps) {
  try {
    const evidence = await loadEvidence(refundId, deps);
    if (!evidence?.order.buyerEmail) return;
    const message = renderEvidenceEmail(evidence, deps.appUrl);
    const sent = await deps.email.send({ to: evidence.order.buyerEmail, ...message, idempotencyKey: `evidence-${refundId}` });
    log("evidence email sent", { refundId, emailId: sent.id, transport: sent.transport });
  } catch (err) {
    console.error(JSON.stringify({ msg: "evidence email failed", refundId, error: String(err) }));
  }
}

export async function getOrderRefunds(orderId: string, db: Db = getDb()) {
  return db
    .select({ refund: schema.refunds, event: schema.priceEvents })
    .from(schema.refunds)
    .innerJoin(schema.protections, eq(schema.refunds.protectionId, schema.protections.id))
    .innerJoin(schema.priceEvents, eq(schema.refunds.priceEventId, schema.priceEvents.id))
    .where(eq(schema.protections.orderId, orderId))
    .orderBy(desc(schema.refunds.createdAt));
}

// ---------------------------------------------------------------------------------------------------
// Fallback poll

export type PollResult = {
  channel3ProductId: string;
  checked: { domain: string; priceCents: Cents } | null;
  historyLatest: { priceCents: Cents; at: string } | null;
  eventId?: string;
  duplicate?: boolean;
  outcomes: ProtectionOutcome[];
  error?: string;
};

// For every product with an active protection: read Channel3's price history and the product's current
// offers, and record the cheapest in-stock offer at an approved store as a `poll` price event. Price
// history has no store, so the store-level price comes from the offers; one event per store, price
// and day, so polling again the same day does nothing new.
export async function runPriceCheck(deps: ProtectionDeps = defaultDeps()): Promise<PollResult[]> {
  const { db } = deps;
  await expireProtections(deps);
  const policy = await activePolicy(db);
  const products = await db
    .selectDistinct({ channel3ProductId: schema.protections.channel3ProductId })
    .from(schema.protections)
    .where(eq(schema.protections.status, "active"));

  const results: PollResult[] = [];
  for (const { channel3ProductId } of products) {
    try {
      const [history, product] = await Promise.all([
        deps.channel3.priceHistory(channel3ProductId).catch(() => null),
        deps.channel3.retrieve(channel3ProductId),
      ]);
      const last = history?.history?.at(-1);
      const historyLatest = last ? { priceCents: dollarsToCents(last.price), at: new Date(last.timestamp).toISOString() } : null;
      const offers = (product.offers ?? [])
        .filter((o) => o.availability === "InStock" && (!o.condition || o.condition === "new") && o.price?.currency === "USD")
        .filter((o) => isApprovedDomain(o.domain, policy.approvedDomains))
        .map((o) => ({ domain: normalizeDomain(o.domain), priceCents: dollarsToCents(o.price.price), url: o.url }))
        .sort((a, b) => a.priceCents - b.priceCents);
      const best = offers[0];
      if (!best) {
        results.push({ channel3ProductId, checked: null, historyLatest, outcomes: [] });
        continue;
      }
      const now = deps.now();
      const { event, duplicate } = await recordPriceEvent(db, {
        source: "poll",
        externalId: `poll:${channel3ProductId}:${best.domain}:${best.priceCents}:${now.toISOString().slice(0, 10)}`,
        channel3ProductId,
        domain: best.domain,
        newPriceCents: best.priceCents,
        currency: "USD",
        verified: null,
        rawPayload: {
          type: "poll",
          canonical_product_id: channel3ProductId,
          domain: best.domain,
          new_price: best.priceCents / 100,
          currency: "USD",
          buy_url: best.url,
          timestamp: now.toISOString(),
          approved_offers: offers,
          history_statistics: history?.statistics ?? null,
          history_latest: historyLatest,
        },
      });
      const outcomes = await processPriceEvent(event.id, deps);
      results.push({ channel3ProductId, checked: best, historyLatest, eventId: event.id, duplicate, outcomes });
    } catch (err) {
      results.push({ channel3ProductId, checked: null, historyLatest: null, outcomes: [], error: String(err) });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------------------------------
// Demo replay

type RecordedChannel3Webhook = { received_at: string; headers: Record<string, string>; raw_body: string; event: Record<string, unknown> };

export function recordedPriceChanged(): { file: string; svixId: string; event: Record<string, unknown> } {
  const file = listFixtures("channel3/webhooks").find((f) => f.startsWith("price-changed"));
  if (!file) throw new Error("No recorded Channel3 price.changed payload in fixtures/channel3/webhooks");
  const recorded = loadFixture<RecordedChannel3Webhook>(`channel3/webhooks/${file}`);
  return { file, svixId: recorded.headers["svix-id"], event: JSON.parse(recorded.raw_body) };
}

// The simulated price: about 20% under what the customer paid, ending in .99.
export const simulatedDropCents = (paidCents: Cents) => Math.max(99, Math.floor((paidCents * 0.8) / 100) * 100 - 1);

// Re-injects the recorded Channel3 price.changed payload for a protected order's product. The recorded
// payload is a dashboard test send with placeholder values, so the product, store and prices are filled
// in and the event is marked as a SIMULATED drop in its payload, its external ID, the refund's reasons
// and the PayPal note to the payer. Replaying the same drop again finds the same event and does nothing.
export async function replaySimulatedDrop(protectionId: string, deps: ProtectionDeps = defaultDeps()) {
  const { db } = deps;
  const [row] = await db
    .select({ protection: schema.protections, order: schema.orders, product: schema.products })
    .from(schema.protections)
    .innerJoin(schema.orders, eq(schema.protections.orderId, schema.orders.id))
    .innerJoin(schema.products, eq(schema.orders.productId, schema.products.id))
    .where(eq(schema.protections.id, protectionId));
  if (!row) throw new Error(`Protection ${protectionId} not found`);
  const policy = await activePolicy(db);

  // An approved store that really lists the product (as seeded), so the stock check is a real one.
  const snapshot = row.product.channel3Snapshot as Channel3Product;
  const offer =
    snapshot.offers?.find((o) => isApprovedDomain(o.domain, policy.approvedDomains) && o.availability === "InStock") ??
    snapshot.offers?.find((o) => isApprovedDomain(o.domain, policy.approvedDomains));
  const domain = normalizeDomain(offer?.domain ?? policy.approvedDomains[0]);
  const newPriceCents = simulatedDropCents(row.order.pricePaidCents);
  const recorded = recordedPriceChanged();
  const now = deps.now();

  const payload = {
    ...recorded.event,
    canonical_product_id: row.protection.channel3ProductId,
    domain,
    old_price: offer ? offer.price.price : row.order.pricePaidCents / 100,
    new_price: newPriceCents / 100,
    currency: row.order.currency,
    buy_url: offer?.url ?? null,
    timestamp: now.toISOString(),
    simulated_drop: true,
    simulated_note:
      "SIMULATED price drop for the demo. Built from the recorded Channel3 price.changed payload, whose values were placeholders (a dashboard test send). This price was not observed at the store.",
    replayed_from: { fixture: `fixtures/channel3/webhooks/${recorded.file}`, svix_id: recorded.svixId },
  };
  const { event, duplicate } = await recordPriceEvent(db, {
    source: "replay",
    externalId: `replay:simulated:${recorded.svixId}:${row.protection.channel3ProductId}:${domain}:${newPriceCents}`,
    channel3ProductId: row.protection.channel3ProductId,
    productId: row.product.id,
    domain,
    oldPriceCents: payload.old_price != null ? dollarsToCents(payload.old_price) : null,
    newPriceCents,
    currency: row.order.currency,
    verified: null,
    rawPayload: payload,
  });
  log("replay: simulated price drop", { protectionId, eventId: event.id, duplicate, domain, newPriceCents });
  const outcomes = await processPriceEvent(event.id, deps);
  return { eventId: event.id, duplicate, outcomes };
}
