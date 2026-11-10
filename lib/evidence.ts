// The evidence card for a price-protection refund: what the customer paid, the lower price at the
// approved store, Channel3's price history, the PayPal refund and the rule that triggered it. Shown at
// /evidence/[refundId] and emailed to the buyer. The explanation is deterministic text, not model output.
import { desc, eq } from "drizzle-orm";
import { schema } from "./db";
import { formatCents, dollarsToCents, type Cents } from "./money";
import type { ProtectionDeps } from "./price-protection";
import { isSimulated, parseChannel3Time, textSparkline } from "./protection";
import { SHOP } from "./shop-info";

export type HistoryPoint = { at: string; priceCents: Cents };

// Channel3 history is daily, so one read per product per hour is plenty (saves credits on page views).
const historyCache = ((globalThis as { matchpointHistoryCache?: Map<string, { at: number; points: HistoryPoint[] }> })
  .matchpointHistoryCache ??= new Map());

async function cachedHistory(productId: string, channel3: ProtectionDeps["channel3"]): Promise<HistoryPoint[]> {
  const hit = historyCache.get(productId);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.points;
  try {
    const h = await channel3.priceHistory(productId);
    const points = (h.history ?? []).map((p) => ({ at: new Date(p.timestamp).toISOString(), priceCents: dollarsToCents(p.price) }));
    historyCache.set(productId, { at: Date.now(), points });
    return points;
  } catch (err) {
    console.error(JSON.stringify({ msg: "evidence: price history unavailable", productId, error: String(err) }));
    return [];
  }
}

export async function loadEvidence(refundId: string, deps: Pick<ProtectionDeps, "db" | "channel3">) {
  const { db } = deps;
  const [row] = await db
    .select({
      refund: schema.refunds,
      protection: schema.protections,
      order: schema.orders,
      product: schema.products,
      event: schema.priceEvents,
    })
    .from(schema.refunds)
    .innerJoin(schema.protections, eq(schema.refunds.protectionId, schema.protections.id))
    .innerJoin(schema.orders, eq(schema.protections.orderId, schema.orders.id))
    .innerJoin(schema.products, eq(schema.orders.productId, schema.products.id))
    .innerJoin(schema.priceEvents, eq(schema.refunds.priceEventId, schema.priceEvents.id))
    .where(eq(schema.refunds.id, refundId));
  if (!row) return null;
  const [policy] = await db.select().from(schema.policies).orderBy(desc(schema.policies.version)).limit(1);

  const history = await cachedHistory(row.protection.channel3ProductId, deps.channel3);

  const ledger = row.refund.paypalRefundId
    ? await db.select().from(schema.ledgerEvents).where(eq(schema.ledgerEvents.resourceId, row.refund.paypalRefundId))
    : [];
  const observedAt = parseChannel3Time((row.event.rawPayload as { timestamp?: unknown }).timestamp) ?? row.event.receivedAt;
  return { ...row, policy, history, ledger, observedAt, simulated: isSimulated(row.event) };
}

export type Evidence = NonNullable<Awaited<ReturnType<typeof loadEvidence>>>;

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

export function shopRule(e: Pick<Evidence, "policy" | "order">): string {
  const p = e.policy;
  if (!p) return "Price protection.";
  return `Price protection (policy v${p.version}): for ${p.protectionDays} days after purchase, if one of our ${p.approvedDomains.length} approved stores sells the same item new and in stock for less, we refund the difference. Up to ${formatCents(p.autoRefundCapCents)} is refunded automatically; differences under ${formatCents(p.minRefundCents)} aren't.`;
}

export function explanation(e: Evidence): string {
  const paid = formatCents(e.order.pricePaidCents, e.order.currency);
  const now = formatCents(e.event.newPriceCents, e.event.currency);
  const amount = formatCents(e.refund.amountCents, e.refund.currency);
  const when = e.refund.approvedBy === "owner" ? "The shop owner approved it" : "It was under the auto-refund cap, so it went out automatically";
  const seen = e.simulated
    ? `a simulated price drop (demo replay) put the same item at ${now} at ${e.event.domain}, where it is in stock`
    : `${e.event.domain} listed the same item for ${now}, in stock`;
  return `You paid ${paid} at ${SHOP.name} on ${dateFormat.format(e.order.capturedAt ?? e.order.createdAt)}. On ${dateFormat.format(
    e.observedAt,
  )}, ${seen}. That is within your protection window, so we refunded ${amount} to your PayPal account. ${when}.`;
}

export function renderEvidenceEmail(e: Evidence, appUrl: string) {
  const amount = formatCents(e.refund.amountCents, e.refund.currency);
  const url = `${appUrl}/evidence/${e.refund.id}`;
  const spark = textSparkline(e.history.map((h) => h.priceCents));
  const sim = e.simulated ? "[SIMULATED price drop, demo] " : "";
  const subject = `${sim}${SHOP.name}: we refunded you ${amount} (price protection)`;
  const lines = [
    e.simulated ? "SIMULATED PRICE DROP (demo replay): this price was not observed at the store.\n" : "",
    explanation(e),
    "",
    `You paid:   ${formatCents(e.order.pricePaidCents, e.order.currency)} at ${SHOP.name}, ${dateFormat.format(e.order.capturedAt ?? e.order.createdAt)}`,
    `Now:        ${formatCents(e.event.newPriceCents, e.event.currency)} at ${e.event.domain}, ${dateFormat.format(e.observedAt)}`,
    `Refunded:   ${amount}`,
    `PayPal refund ID: ${e.refund.paypalRefundId ?? "pending"}`,
    spark ? `Price history (Channel3, ${e.history.length} days): ${spark}` : "",
    "",
    `Rule: ${shopRule(e)}`,
    "",
    `Full evidence: ${url}`,
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "");
  const text = lines.join("\n");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const row = (k: string, v: string) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#6b6b6b">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;color:#1c1c1c">
${e.simulated ? `<p style="background:#fde9c8;padding:8px 12px;border-radius:8px;font-weight:600">SIMULATED price drop (demo replay): this price was not observed at the store.</p>` : ""}
<h2 style="margin:0 0 8px">We refunded you ${esc(amount)}</h2>
<p>${esc(explanation(e))}</p>
<table style="border-collapse:collapse;font-size:14px">
${row("You paid", `${formatCents(e.order.pricePaidCents, e.order.currency)} at ${SHOP.name}, ${dateFormat.format(e.order.capturedAt ?? e.order.createdAt)}`)}
${row("Now", `${formatCents(e.event.newPriceCents, e.event.currency)} at ${e.event.domain}, ${dateFormat.format(e.observedAt)}`)}
${row("Refunded", amount)}
${row("PayPal refund ID", e.refund.paypalRefundId ?? "pending")}
${spark ? row(`Price history (${e.history.length} days)`, spark) : ""}
</table>
<p style="font-size:13px;color:#6b6b6b">${esc(shopRule(e))}</p>
<p><a href="${esc(url)}">See the full evidence card</a></p>
</div>`;
  return { subject, text, html };
}
