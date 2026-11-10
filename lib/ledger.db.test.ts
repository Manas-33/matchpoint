// dbLedgerStore against real Postgres: deduplication by PayPal event ID, and an unverified row being
// replaced by the verified delivery. Runs inside a transaction that is rolled back, and is skipped when
// no database is reachable (DATABASE_URL from the shell or .env; `npm run db:up` starts one).
import "../scripts/load-env";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import * as schema from "./db/schema";
import type { Db } from "./db";
import { dbLedgerStore } from "./ledger";
import { paypalDelivery } from "./paypal-webhook-fixtures";

const url = process.env.DATABASE_URL;
const client = url ? postgres(url, { max: 1, connect_timeout: 2, onnotice: () => {} }) : null;
const reachable = client ? await client`select 1`.then(() => true, () => false) : false;

afterAll(() => client?.end());

class Rollback extends Error {}

// Runs `fn` in a transaction and rolls it back, so the shared dev database is left untouched.
async function inRolledBackTransaction(fn: (db: Db) => Promise<void>) {
  const db = drizzle({ client: client!, schema });
  await expect(
    db.transaction(async (tx) => {
      await fn(tx as unknown as Db);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
}

describe.skipIf(!reachable)("dbLedgerStore (Postgres)", () => {
  const event = paypalDelivery("PAYMENT.CAPTURE.COMPLETED").event;
  const row = (verified: boolean, payload: unknown = event) => ({
    paypalEventId: `TEST-${event.id}`,
    eventType: event.event_type,
    resourceId: event.resource?.id ?? null,
    verified,
    rawPayload: payload,
  });

  it("stores an event once and reports redeliveries as duplicates", async () => {
    await inRolledBackTransaction(async (db) => {
      const store = dbLedgerStore(db);
      expect(await store.record(row(true))).toBe("inserted");
      expect(await store.record(row(true))).toBe("duplicate");
      expect(await store.record(row(false, { forged: true }))).toBe("duplicate");
      const rows = await db.select().from(schema.ledgerEvents).where(eq(schema.ledgerEvents.paypalEventId, `TEST-${event.id}`));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ verified: true, rawPayload: event });
    });
  });

  it("replaces an unverified row with the verified delivery, once", async () => {
    await inRolledBackTransaction(async (db) => {
      const store = dbLedgerStore(db);
      expect(await store.record(row(false, { forged: true }))).toBe("inserted");
      expect(await store.record(row(false, { forged: "again" }))).toBe("duplicate");
      expect(await store.record(row(true))).toBe("upgraded");
      expect(await store.record(row(true))).toBe("duplicate");
      const [stored] = await db.select().from(schema.ledgerEvents).where(eq(schema.ledgerEvents.paypalEventId, `TEST-${event.id}`));
      expect(stored).toMatchObject({ verified: true, rawPayload: event });
    });
  });
});
