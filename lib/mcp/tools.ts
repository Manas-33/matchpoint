// The shopper-agent MCP server: lets a customer's AI agent browse the catalog, ask for a price match and
// follow it up. `request_price_match` runs the same engine as POST /api/match and the same checkout as the
// product page; the agent gets an approval link, and the buyer approves the payment in PayPal themselves.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { CheckoutError, createCheckoutOrder, MATCH_VALID_MS, type MatchOption } from "../checkout";
import { getDb, schema } from "../db";
import type { Product } from "../db/schema";
import { getEnv } from "../env";
import { MatchError, runMatch, type MatchResult } from "../match/engine";
import { formatCents } from "../money";
import { getPayPal } from "../paypal";
import { listProducts, variantLabel } from "../shop";

export type McpDeps = {
  appUrl: () => string;
  listProducts: () => Promise<Product[]>;
  findProduct: (ref: string) => Promise<Product | null>;
  runMatch: typeof runMatch;
  createCheckoutOrder: typeof createCheckoutOrder;
  paypalMode: () => "live" | "demo";
  matchStatus: (matchId: string) => Promise<MatchStatus | null>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A product by our ID, its slug, or its Channel3 product ID.
async function findProduct(ref: string): Promise<Product | null> {
  const p = schema.products;
  const [row] = await getDb()
    .select()
    .from(p)
    .where(UUID.test(ref) ? eq(p.id, ref) : or(eq(p.slug, ref), eq(p.channel3ProductId, ref)))
    .limit(1);
  return row ?? null;
}

export type MatchStatus = {
  match: typeof schema.matchRequests.$inferSelect;
  product: Product;
  orders: (typeof schema.orders.$inferSelect)[];
  protections: (typeof schema.protections.$inferSelect)[];
  refundedCents: number;
};

async function matchStatus(matchId: string): Promise<MatchStatus | null> {
  if (!UUID.test(matchId)) return null;
  const db = getDb();
  const [row] = await db
    .select({ match: schema.matchRequests, product: schema.products })
    .from(schema.matchRequests)
    .innerJoin(schema.products, eq(schema.matchRequests.productId, schema.products.id))
    .where(eq(schema.matchRequests.id, matchId))
    .limit(1);
  if (!row) return null;
  const orders = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.matchRequestId, matchId))
    .orderBy(desc(schema.orders.createdAt));
  const orderIds = orders.map((o) => o.id);
  const protections = orderIds.length
    ? await db.select().from(schema.protections).where(inArray(schema.protections.orderId, orderIds))
    : [];
  const protectionIds = protections.map((p) => p.id);
  const [refunded] = protectionIds.length
    ? await db
        .select({ total: sql<number>`coalesce(sum(${schema.refunds.amountCents}), 0)::int` })
        .from(schema.refunds)
        .where(and(inArray(schema.refunds.protectionId, protectionIds), eq(schema.refunds.status, "completed")))
    : [{ total: 0 }];
  return { ...row, orders, protections, refundedCents: refunded.total };
}

export const defaultDeps: McpDeps = {
  appUrl: () => getEnv().APP_URL,
  listProducts,
  findProduct,
  runMatch,
  createCheckoutOrder,
  paypalMode: () => getPayPal().mode,
  matchStatus,
};

const money = (cents: number | null | undefined, currency = "USD") => (cents == null ? null : formatCents(cents, currency));

const PAYMENT_STATUS: Record<string, string> = {
  created: "awaiting buyer approval in PayPal",
  approved: "approved, capture pending",
  completed: "paid",
  partially_refunded: "paid, partly refunded by price protection",
  refunded: "refunded",
  voided: "voided",
  failed: "failed",
};

function json(value: unknown, summary: string) {
  return { content: [{ type: "text" as const, text: `${summary}\n\n${JSON.stringify(value, null, 2)}` }], structuredContent: value as Record<string, unknown> };
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// The verdict as an agent sees it: every check with the evidence it read, Claude's cited reasons, and the
// counter-offer. Internal fields (the full price history series, raw lookups) are left out.
export function describeVerdict(r: MatchResult, appUrl: string) {
  return {
    match_id: r.matchRequestId,
    decision: r.decision,
    headline: r.headline,
    customer_message: r.customerMessage,
    product: { id: r.productId, slug: r.productSlug, shop_price: money(r.shopPriceCents, r.currency) },
    competitor: {
      url: r.competitorUrl,
      store: r.competitorDomain,
      title: r.competitorTitle,
      price: money(r.competitorPriceCents, r.currency),
    },
    matched_price: money(r.matchedPriceCents, r.currency),
    savings: money(r.savingsCents, r.currency),
    reasons: r.checks.map((c) => ({ check: c.label, status: c.status, detail: c.message, evidence: c.source ?? null })),
    same_product_judgment: r.modelReasons.map((m) => ({ listing: m.listing, field: m.field, observation: m.observation })),
    price_history: r.history
      ? {
          typical_price: money(r.history.typicalCents, r.currency),
          current_status: r.history.currentStatus,
          days_at_or_below_this_price: r.history.daysAtOrBelow,
          window_days: r.history.windowDays,
        }
      : null,
    value_offer: r.valueOffer
      ? {
          title: r.valueOffer.title,
          description: r.valueOffer.description,
          worth: money(r.valueOffer.customerValueCents, r.currency),
          instead_of_cash_discount: money(r.valueOffer.insteadOfCents, r.currency),
          how_to_accept: 'Call request_price_match again with option "value" to pay the list price and get this instead.',
        }
      : null,
    alternatives: r.alternatives.map((a) => ({ slug: a.slug, title: a.title, price: money(a.priceCents, r.currency) })),
    policy_version: r.policyVersion,
    evidence_url: `${appUrl}/matches/${r.matchRequestId}`,
    mode: r.mode,
  };
}

export function createMatchpointMcpServer(agentName: string, deps: McpDeps = defaultDeps): McpServer {
  const server = new McpServer(
    { name: "matchpoint", version: "1.0.0" },
    {
      instructions:
        "Matchpoint is the price-match desk of Larkspur & Co., an independent shop. Use list_products to find a product, then request_price_match with a link to the same product at another store. A match returns a PayPal approval link: give it to the buyer, who approves the payment themselves. You can't pay on their behalf.",
    },
  );

  server.registerTool(
    "list_products",
    {
      title: "List products",
      description: "List the shop's products with their IDs, prices and variants. Optionally filter by a search term.",
      inputSchema: { query: z.string().max(200).optional().describe("Words to look for in the title or brand") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query }) => {
      const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const products = (await deps.listProducts()).filter((p) => {
        const hay = `${p.title} ${p.brand ?? ""} ${p.category ?? ""}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      const appUrl = deps.appUrl();
      const items = products.map((p) => ({
        product_id: p.id,
        slug: p.slug,
        title: p.title,
        brand: p.brand,
        variant: variantLabel(p.variant) || null,
        price: money(p.shopPriceCents, p.currency),
        url: `${appUrl}/products/${p.slug}`,
      }));
      return json({ products: items }, `${items.length} product${items.length === 1 ? "" : "s"} at Larkspur & Co.`);
    },
  );

  server.registerTool(
    "request_price_match",
    {
      title: "Request a price match",
      description:
        "Ask the shop to match a cheaper price found at another store. The shop verifies the competitor link (same product, variant and condition, approved store, in stock, not a pricing glitch) and returns match, decline or review with the evidence for each check. When matched it may offer a better-value alternative (e.g. store credit) and creates a PayPal order at the agreed price: the buyer must open approval_url and approve the payment themselves.",
      inputSchema: {
        product: z.string().min(1).max(200).describe("The shop's product_id or slug from list_products"),
        competitor_url: z.url({ protocol: /^https?$/ }).max(2000).describe("Link to the same product at another store"),
        buyer_email: z.email().optional().describe("The buyer's email, for the order and price-protection notices"),
        option: z
          .enum(["match", "value"])
          .default("match")
          .describe('"match": pay the matched price. "value": pay the list price and take the value_offer instead.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ product: ref, competitor_url, buyer_email, option }) => {
      const product = await deps.findProduct(ref);
      if (!product) return toolError(`No product "${ref}". Call list_products for valid product IDs.`);
      let result: MatchResult;
      try {
        result = await deps.runMatch({ productId: product.id, competitorUrl: competitor_url }, undefined, {
          source: "agent",
          agentName,
        });
      } catch (err) {
        if (err instanceof MatchError) return toolError(err.message);
        throw err;
      }
      const appUrl = deps.appUrl();
      const verdict = describeVerdict(result, appUrl);
      if (result.decision !== "match") {
        const summary =
          result.decision === "decline"
            ? `Declined: ${result.headline}`
            : `Needs a person to review: ${result.headline}. The shop will follow up; you can check with get_match_status.`;
        return json({ ...verdict, checkout: null }, summary);
      }

      const chosen: MatchOption = option === "value" && result.valueOffer ? "value" : "match";
      let checkout;
      try {
        const order = await deps.createCheckoutOrder(product.slug, result.matchRequestId, chosen, { buyerEmail: buyer_email });
        const simulated = deps.paypalMode() === "demo";
        // Demo mode has no PayPal page to send the buyer to: the link goes straight to the return route,
        // which captures the simulated payment.
        const approvalUrl = simulated
          ? `${appUrl}/api/checkout/return?orderId=${order.orderId}&token=${encodeURIComponent(order.paypalOrderId)}`
          : order.approveUrl;
        checkout = {
          option: chosen,
          order_id: order.orderId,
          paypal_order_id: order.paypalOrderId,
          amount: money(order.amountCents, order.currency),
          approval_url: approvalUrl,
          simulated_payment: simulated,
          valid_until: new Date(Date.now() + MATCH_VALID_MS).toISOString(),
          next_step: "Give approval_url to the buyer. They approve the payment in PayPal; the shop captures it and the order is covered by price protection.",
        };
      } catch (err) {
        if (err instanceof CheckoutError) return json({ ...verdict, checkout: null, checkout_error: err.message }, `Matched, but the order couldn't be created: ${err.message}`);
        throw err;
      }
      const summary =
        chosen === "value"
          ? `Matched. Chosen: ${result.valueOffer!.title} at the list price ${checkout.amount}. Buyer approves here: ${checkout.approval_url}`
          : `Matched at ${checkout.amount} (saves ${verdict.savings}). Buyer approves here: ${checkout.approval_url}`;
      return json({ ...verdict, checkout }, summary);
    },
  );

  server.registerTool(
    "get_match_status",
    {
      title: "Get price-match status",
      description: "The decision on a price match and the status of its order, payment and price protection.",
      inputSchema: { match_id: z.string().describe("match_id from request_price_match") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ match_id }) => {
      const status = await deps.matchStatus(match_id);
      if (!status) return toolError(`No price match with ID ${match_id}.`);
      const { match, product, orders, protections, refundedCents } = status;
      const order = orders[0] ?? null;
      const protection = order ? protections.find((p) => p.orderId === order.id) ?? null : null;
      const value = {
        match_id: match.id,
        decision: match.decision,
        product: { id: product.id, slug: product.slug, title: product.title },
        competitor_url: match.competitorUrl,
        competitor_price: money(match.competitorPriceCents, product.currency),
        matched_price: money(match.matchedPriceCents, product.currency),
        decided_at: match.createdAt.toISOString(),
        match_valid_until: match.decision === "match" ? new Date(match.createdAt.getTime() + MATCH_VALID_MS).toISOString() : null,
        order: order
          ? {
              order_id: order.id,
              status: order.status,
              payment: PAYMENT_STATUS[order.status] ?? order.status,
              amount: money(order.pricePaidCents, order.currency),
              paypal_order_id: order.paypalOrderId,
              paypal_capture_id: order.paypalCaptureId,
              paid_at: order.capturedAt?.toISOString() ?? null,
              order_url: `${deps.appUrl()}/orders/${order.id}`,
            }
          : null,
        price_protection: protection
          ? { status: protection.status, until: protection.windowEndsAt.toISOString(), refunded: money(refundedCents, product.currency) }
          : null,
        evidence_url: `${deps.appUrl()}/matches/${match.id}`,
      };
      const summary = order
        ? `${match.decision}; order ${order.id.slice(0, 8)}: ${value.order!.payment}.`
        : `${match.decision}; no order yet.`;
      return json(value, summary);
    },
  );

  return server;
}
