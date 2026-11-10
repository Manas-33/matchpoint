// PayPal webhooks into the ledger. Every delivery's signature is checked with PayPal, payment events are
// stored once per PayPal event ID (redeliveries are ignored), and each row says whether it was verified.
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./db";
import { schema } from "./db";
import { paypalValueToCents } from "./money";
import type { PayPalWebhookVerification } from "./paypal";

export const LEDGER_EVENT_TYPES = ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED"] as const;
type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];
const isLedgerEventType = (t: string): t is LedgerEventType => (LEDGER_EVENT_TYPES as readonly string[]).includes(t);

export type LedgerEventRow = typeof schema.ledgerEvents.$inferInsert;

// inserted: first delivery. upgraded: an unverified row with this event ID is replaced by a verified
// delivery (so a forged event can't squat a real event's ID). duplicate: already stored, nothing changed.
export type RecordResult = "inserted" | "upgraded" | "duplicate";

export interface LedgerStore {
  record(row: LedgerEventRow): Promise<RecordResult>;
}

export type PayPalWebhookEvent = {
  id: string;
  event_type: string;
  create_time?: string;
  resource?: {
    id?: string;
    status?: string;
    amount?: { value: string; currency_code: string };
    create_time?: string;
    supplementary_data?: { related_ids?: { order_id?: string } };
  };
};

export type CaptureCompleted = {
  id: string;
  amountCents: number;
  currency: string;
  paypalOrderId: string;
  capturedAt: Date;
};

export type WebhookDeps = {
  verify: (headers: Headers, rawBody: string) => Promise<PayPalWebhookVerification>;
  store: LedgerStore;
  // Called for each verified PAYMENT.CAPTURE.COMPLETED delivery, redeliveries included.
  onCaptureCompleted?: (capture: CaptureCompleted) => Promise<unknown>;
};

export type WebhookOutcome = {
  // HTTP status for PayPal: 2xx stops redelivery; anything else is retried for up to 3 days.
  status: number;
  result: "recorded" | "upgraded" | "duplicate" | "ignored" | "unverified" | "invalid";
  eventId?: string;
  eventType?: string;
  resourceId?: string | null;
  verified?: boolean;
  reason?: string;
};

function parseEvent(rawBody: string): PayPalWebhookEvent | null {
  try {
    const event = JSON.parse(rawBody);
    return typeof event?.id === "string" && typeof event?.event_type === "string" ? event : null;
  } catch {
    return null;
  }
}

function captureCompleted(event: PayPalWebhookEvent): CaptureCompleted | null {
  const r = event.resource;
  const paypalOrderId = r?.supplementary_data?.related_ids?.order_id;
  if (!r?.id || !r.amount || !paypalOrderId) return null;
  return {
    id: r.id,
    amountCents: paypalValueToCents(r.amount.value),
    currency: r.amount.currency_code,
    paypalOrderId,
    capturedAt: new Date(r.create_time ?? event.create_time ?? Date.now()),
  };
}

// Throws if PayPal can't be reached to verify the signature; the route answers 500 and PayPal redelivers.
export async function handlePayPalWebhook(headers: Headers, rawBody: string, deps: WebhookDeps): Promise<WebhookOutcome> {
  const event = parseEvent(rawBody);
  if (!event) return { status: 400, result: "invalid", reason: "body is not a PayPal webhook event" };
  const base = { eventId: event.id, eventType: event.event_type, resourceId: event.resource?.id ?? null };

  // Other subscribed events (e.g. CHECKOUT.ORDER.APPROVED) are acknowledged so PayPal stops sending them.
  if (!isLedgerEventType(event.event_type)) return { ...base, status: 200, result: "ignored", reason: "not a ledger event" };

  const verification = await deps.verify(headers, rawBody);
  const recorded = await deps.store.record({
    paypalEventId: event.id,
    eventType: event.event_type,
    resourceId: event.resource?.id ?? null,
    verified: verification.verified,
    rawPayload: event,
  });

  // Reconciling is idempotent, so it runs on redeliveries too (in case it failed the first time).
  if (verification.verified && event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const capture = captureCompleted(event);
    if (capture) await deps.onCaptureCompleted?.(capture);
  }

  const outcome = { ...base, verified: verification.verified, reason: verification.reason };
  // Unverified deliveries are kept (flagged) for the audit trail, but refused: if the failure was ours
  // (say, the wrong PAYPAL_WEBHOOK_ID), PayPal's redelivery can still verify and replace the row.
  if (!verification.verified) return { ...outcome, status: 400, result: "unverified" };
  return { ...outcome, status: 200, result: recorded === "inserted" ? "recorded" : recorded };
}

// Postgres store. The unique paypal_event_id makes deduplication atomic: concurrent redeliveries can't
// both insert. A conflicting row is only replaced when it's unverified and the new delivery is verified.
export function dbLedgerStore(db: Db): LedgerStore {
  const e = schema.ledgerEvents;
  return {
    async record(row) {
      const rows = await db
        .insert(e)
        .values(row)
        .onConflictDoUpdate({
          target: e.paypalEventId,
          set: {
            eventType: row.eventType,
            resourceId: row.resourceId,
            verified: true,
            rawPayload: row.rawPayload,
            receivedAt: sql`now()`,
          },
          setWhere: and(eq(e.verified, false), sql`excluded.verified`),
        })
        // xmax is 0 on a freshly inserted row and non-zero on one rewritten by ON CONFLICT DO UPDATE.
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      if (rows.length === 0) return "duplicate";
      return rows[0].inserted ? "inserted" : "upgraded";
    },
  };
}
