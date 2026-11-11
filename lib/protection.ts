// Price protection rules: given a price event and one protected order, decide whether to refund the
// difference automatically, queue it for the owner, or skip it. Pure code over integer cents, so every
// rule is unit-tested; lib/price-protection.ts does the I/O around it.
import type { DecisionReason } from "./db/schema";
import { formatCents, type Cents } from "./money";

export type ProtectionPolicy = {
  version: number;
  approvedDomains: string[];
  autoRefundCapCents: Cents;
  minRefundCents: Cents;
};

export type PriceEventFacts = {
  channel3ProductId: string;
  domain: string | null;
  newPriceCents: Cents;
  currency: string;
  // When the competitor price was seen (the event's own timestamp, else when we received it).
  observedAt: Date;
};

export type ProtectedOrder = {
  channel3ProductId: string;
  status: "active" | "expired" | "closed";
  pricePaidCents: Cents;
  currency: string;
  capturedAt: Date;
  windowEndsAt: Date;
  // Refunds already paid or reserved (pending approval) under this protection.
  alreadyRefundedCents: Cents;
};

// The competitor's offer at the event's store, as Channel3 lists it now. null: no offer at that store.
export type OfferCheck = { availability: string | null; condition: string | null } | null;

export type ProtectionDecision =
  | { action: "refund" | "queue"; amountCents: Cents; reasons: DecisionReason[] }
  | { action: "skip"; amountCents: 0; reasons: DecisionReason[] };

export const normalizeDomain = (d: string) => d.trim().toLowerCase().replace(/^www\./, "");

export function isApprovedDomain(domain: string | null, approved: string[]): boolean {
  if (!domain) return false;
  const d = normalizeDomain(domain);
  return approved.some((a) => {
    const n = normalizeDomain(a);
    return d === n || d.endsWith(`.${n}`);
  });
}

export function evaluatePriceDrop(
  event: PriceEventFacts,
  order: ProtectedOrder,
  offer: OfferCheck,
  policy: ProtectionPolicy,
): ProtectionDecision {
  const reasons: DecisionReason[] = [];
  const skip = (code: string, message: string): ProtectionDecision => ({
    action: "skip",
    amountCents: 0,
    reasons: [...reasons, { code, message }],
  });
  const cur = order.currency;

  if (order.status !== "active") return skip("protection_inactive", `Protection is ${order.status}.`);
  if (event.channel3ProductId !== order.channel3ProductId) {
    return skip("different_product", `Event is for ${event.channel3ProductId}, the order is ${order.channel3ProductId}.`);
  }
  reasons.push({ code: "same_product", message: `Same Channel3 canonical product (${order.channel3ProductId}).`, source: "channel3" });

  if (event.currency !== cur) return skip("currency_mismatch", `Price is in ${event.currency}, the order was paid in ${cur}.`);

  if (!isApprovedDomain(event.domain, policy.approvedDomains)) {
    return skip("store_not_approved", `${event.domain ?? "Unknown store"} isn't on the approved list.`);
  }
  reasons.push({ code: "store_approved", message: `${event.domain} is an approved store (policy v${policy.version}).`, source: "policy" });

  if (!offer) return skip("offer_not_found", `Channel3 lists no offer for this product at ${event.domain}.`);
  if (offer.availability !== "InStock") {
    return skip("out_of_stock", `The offer at ${event.domain} is ${offer.availability ?? "of unknown availability"}.`);
  }
  if (offer.condition && offer.condition !== "new") {
    return skip("not_new", `The offer at ${event.domain} is ${offer.condition}, not new.`);
  }
  reasons.push({ code: "in_stock", message: `The offer at ${event.domain} is in stock.`, source: "channel3" });

  if (event.observedAt < order.capturedAt || event.observedAt > order.windowEndsAt) {
    return skip("outside_window", `Price seen ${event.observedAt.toISOString()}, outside the protection window.`);
  }
  reasons.push({ code: "within_window", message: `Seen within the protection window (ends ${order.windowEndsAt.toISOString().slice(0, 10)}).`, source: "policy" });

  const difference = order.pricePaidCents - event.newPriceCents;
  if (difference <= 0) {
    return skip("not_lower", `${formatCents(event.newPriceCents, cur)} isn't below the ${formatCents(order.pricePaidCents, cur)} paid.`);
  }
  const amountCents = difference - order.alreadyRefundedCents;
  if (amountCents <= 0) {
    return skip("already_refunded", `${formatCents(order.alreadyRefundedCents, cur)} already refunded covers this price.`);
  }
  reasons.push({
    code: "price_difference",
    message: `Paid ${formatCents(order.pricePaidCents, cur)}, now ${formatCents(event.newPriceCents, cur)} at ${event.domain}${
      order.alreadyRefundedCents > 0 ? `, ${formatCents(order.alreadyRefundedCents, cur)} already refunded` : ""
    }: owed ${formatCents(amountCents, cur)}.`,
  });

  if (amountCents < policy.minRefundCents) {
    return skip("below_minimum", `${formatCents(amountCents, cur)} is under the ${formatCents(policy.minRefundCents, cur)} minimum.`);
  }
  if (amountCents > policy.autoRefundCapCents) {
    return {
      action: "queue",
      amountCents,
      reasons: [...reasons, { code: "over_cap", message: `Over the ${formatCents(policy.autoRefundCapCents, cur)} auto-refund cap: needs owner approval.`, source: "policy" }],
    };
  }
  return {
    action: "refund",
    amountCents,
    reasons: [...reasons, { code: "under_cap", message: `Within the ${formatCents(policy.autoRefundCapCents, cur)} auto-refund cap: refunded automatically.`, source: "policy" }],
  };
}

// A replayed payload we had to build or edit (the recorded one carried placeholder values).
export const isSimulated = (event: { rawPayload: unknown }) =>
  (event.rawPayload as { simulated_drop?: unknown } | null)?.simulated_drop === true;

// Channel3 timestamps look like "2026-10-20T01:47:49.434643902" (nanoseconds, no zone; UTC).
export function parseChannel3Time(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}${(m[2] ?? "").slice(0, 4)}${m[3] ?? "Z"}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// PayPal-Request-Id for the refund: the same protection and price event always reuse the same key, so a
// retried call returns the first refund instead of paying again.
export const refundRequestId = (protectionId: string, priceEventId: string) => `pp-${protectionId}-${priceEventId}`;

// A five-level sparkline from price points, for plain-text and HTML email.
const BARS = "▁▂▃▄▅▆▇█";
export function textSparkline(values: number[], width = 30): string {
  if (values.length === 0) return "";
  const step = Math.max(1, Math.ceil(values.length / width));
  const sampled = values.filter((_, i) => i % step === 0 || i === values.length - 1);
  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  return sampled.map((v) => BARS[max === min ? 3 : Math.round(((v - min) / (max - min)) * (BARS.length - 1))]).join("");
}
