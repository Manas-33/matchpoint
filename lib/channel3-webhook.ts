// Channel3 price.changed webhooks (Svix-signed). The signature is checked against the raw body, the
// event is stored once per svix-id in price_events, and then evaluated against active protections.
import { PriceChangedEvent, verifyChannel3Webhook } from "./channel3";
import { dollarsToCents } from "./money";
import type { NewPriceEvent } from "./price-protection";

export type Channel3WebhookDeps = {
  secret: string | undefined;
  record: (row: NewPriceEvent) => Promise<{ event: { id: string }; duplicate: boolean }>;
  // Runs the protection rules for a stored event (idempotent, so redeliveries run it again safely).
  process: (eventId: string) => Promise<unknown>;
  now?: number;
};

export type Channel3WebhookOutcome = {
  status: number;
  result: "recorded" | "duplicate" | "ignored" | "unverified" | "invalid";
  eventId?: string;
  reason?: string;
};

export async function handleChannel3Webhook(headers: Headers, rawBody: string, deps: Channel3WebhookDeps): Promise<Channel3WebhookOutcome> {
  // Channel3 signs every delivery, so an unsigned or badly signed one is refused (Svix retries on 4xx too,
  // which lets a fixed secret pick it up).
  const verification = verifyChannel3Webhook(headers, rawBody, deps.secret, { now: deps.now });
  if (verification.verified !== true) return { status: 401, result: "unverified", reason: verification.reason };

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { status: 400, result: "invalid", reason: "body is not JSON" };
  }
  if ((body as { type?: unknown })?.type !== "price.changed") {
    return { status: 200, result: "ignored", reason: `not price.changed` };
  }
  const parsed = PriceChangedEvent.safeParse(body);
  if (!parsed.success) return { status: 400, result: "invalid", reason: parsed.error.issues[0]?.message };
  const e = parsed.data;

  const { event, duplicate } = await deps.record({
    source: "webhook",
    externalId: `svix:${headers.get("svix-id") ?? headers.get("webhook-id")}`,
    channel3ProductId: e.canonical_product_id,
    domain: e.domain,
    oldPriceCents: e.old_price != null ? dollarsToCents(e.old_price) : null,
    newPriceCents: dollarsToCents(e.new_price),
    currency: e.currency.toUpperCase(),
    verified: true,
    rawPayload: body,
  });
  await deps.process(event.id);
  return { status: 200, result: duplicate ? "duplicate" : "recorded", eventId: event.id };
}
