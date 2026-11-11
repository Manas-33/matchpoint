// Numbers for the merchant console overview (/admin): what price protection covered and paid out, how
// price-match requests were decided, and the latest decisions.
import { and, count, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import { VALUE_OFFER_CODE } from "./match/value-offer";

const hasValueOffer = sql<boolean>`${schema.matchRequests.reasons} @> ${JSON.stringify([{ code: VALUE_OFFER_CODE }])}::jsonb`;

export async function consoleOverview(now = new Date()) {
  const db = getDb();
  const m = schema.matchRequests;
  const o = schema.orders;
  const [covered, refunded, pendingRefunds, decisions, valueOffered, valueTaken, agentRequests, activeProtections, recent] = await Promise.all([
    db
      .select({ cents: sql<number>`coalesce(sum(${o.pricePaidCents}), 0)::int`, orders: count() })
      .from(schema.protections)
      .innerJoin(o, eq(schema.protections.orderId, o.id)),
    db
      .select({ cents: sql<number>`coalesce(sum(${schema.refunds.amountCents}), 0)::int`, refunds: count() })
      .from(schema.refunds)
      .where(eq(schema.refunds.status, "completed")),
    db.select({ n: count() }).from(schema.refunds).where(eq(schema.refunds.status, "pending_approval")),
    db.select({ decision: m.decision, n: count() }).from(m).groupBy(m.decision),
    db.select({ n: count() }).from(m).where(hasValueOffer),
    // The customer took the alternative: a paid order on a match, at more than the matched price.
    db
      .select({ n: count() })
      .from(o)
      .innerJoin(m, eq(o.matchRequestId, m.id))
      .where(and(inArray(o.status, ["completed", "partially_refunded"]), gt(o.pricePaidCents, sql`${m.matchedPriceCents}`))),
    db.select({ n: count() }).from(m).where(eq(m.source, "agent")),
    db
      .select({ n: count() })
      .from(schema.protections)
      .where(and(eq(schema.protections.status, "active"), gt(schema.protections.windowEndsAt, now))),
    db
      .select({ match: m, product: { title: schema.products.title, slug: schema.products.slug, currency: schema.products.currency } })
      .from(m)
      .innerJoin(schema.products, eq(m.productId, schema.products.id))
      .orderBy(desc(m.createdAt))
      .limit(12),
  ]);

  const recentIds = recent.map((r) => r.match.id);
  const recentOrders = recentIds.length
    ? await db
        .select({ matchRequestId: o.matchRequestId, status: o.status, pricePaidCents: o.pricePaidCents })
        .from(o)
        .where(inArray(o.matchRequestId, recentIds))
        .orderBy(desc(o.createdAt))
    : [];

  const byDecision = Object.fromEntries(decisions.map((d) => [d.decision, d.n])) as Partial<Record<"match" | "decline" | "review", number>>;
  return {
    coveredCents: covered[0].cents,
    coveredOrders: covered[0].orders,
    refundedCents: refunded[0].cents,
    refunds: refunded[0].refunds,
    netCents: covered[0].cents - refunded[0].cents,
    pendingRefunds: pendingRefunds[0].n,
    matched: byDecision.match ?? 0,
    declined: byDecision.decline ?? 0,
    review: byDecision.review ?? 0,
    valueOffered: valueOffered[0].n,
    valueTaken: valueTaken[0].n,
    agentRequests: agentRequests[0].n,
    activeProtections: activeProtections[0].n,
    recent: recent.map((r) => ({ ...r, order: recentOrders.find((x) => x.matchRequestId === r.match.id) ?? null })),
  };
}
