// The MCP tools through a real MCP client (in-memory transport), with the engine, checkout and database
// stubbed: what an agent sees for a match, a decline, and a status check.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { Product } from "../db/schema";
import type { MatchResult } from "../match/engine";
import { createMatchpointMcpServer, type McpDeps } from "./tools";

const product = {
  id: "9c036341-0442-49bc-900d-3524daa906c6",
  slug: "bose-qc-ultra",
  channel3ProductId: "mgo7x7F",
  title: "Bose QuietComfort Ultra Headphones (2nd Gen)",
  brand: "Bose",
  category: "Headphones",
  variant: [{ name: "Color", label: "Black" }],
  shopPriceCents: 40799,
  unitCostCents: 30599,
  currency: "USD",
} as unknown as Product;

const competitorUrl = "https://www.bestbuy.com/product/bose/J7C5V6W7LP";

function result(decision: MatchResult["decision"]): MatchResult {
  return {
    decision,
    headline: decision === "match" ? "We'll match $359.99." : "That's an open-box listing.",
    decidedBy: decision === "match" ? "match" : "condition",
    competitorDomain: "bestbuy.com",
    competitorPriceCents: 35999,
    matchedPriceCents: decision === "match" ? 35999 : null,
    lowestMatchCents: 34679,
    checks: [{ code: "approved_store", label: "Approved store", status: "pass", message: "bestbuy.com is approved.", source: "competitor.url" }],
    modelReasons: [{ listing: "both", field: "title", observation: "Same model." }],
    customerMessage: null,
    matchRequestId: "ae1687ff-d5e5-46bd-a0d0-a9de98f57f08",
    productId: product.id,
    productSlug: product.slug,
    shopPriceCents: 40799,
    currency: "USD",
    savingsCents: decision === "match" ? 4800 : null,
    competitorUrl,
    competitorTitle: "Bose QC Ultra (2nd Gen)",
    history: null,
    alternatives: [],
    valueOffer:
      decision === "match"
        ? { id: "credit", kind: "store_credit", title: "Store credit", description: "Spend it on anything.", customerValueCents: 6000, shopCostCents: 4500, insteadOfCents: 4800 }
        : null,
    policyVersion: 1,
    model: "claude-sonnet-5-5",
    mode: "demo",
  } as MatchResult;
}

async function connect(deps: Partial<McpDeps>) {
  const full: McpDeps = {
    appUrl: () => "http://shop.test",
    listProducts: async () => [product],
    findProduct: async (ref) => (ref === product.id || ref === product.slug ? product : null),
    runMatch: vi.fn(async () => result("match")),
    createCheckoutOrder: vi.fn(async () => ({
      orderId: "c171f194-6a4c-4300-b229-b0f5aecea9bd" as const,
      paypalOrderId: "5O190127TN364715T",
      approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T",
      amountCents: 35999,
      currency: "USD",
    })),
    paypalMode: () => "live",
    matchStatus: async () => null,
    ...deps,
  };
  const server = createMatchpointMcpServer("claude-desktop", full);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  type R = { structuredContent?: Record<string, unknown>; content: { text: string }[]; isError?: boolean };
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<R>;
  return { client, call, deps: full };
}

describe("matchpoint MCP server", () => {
  it("exposes the three tools", async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_match_status", "list_products", "request_price_match"]);
  });

  it("lists products with IDs and prices, filtered by query", async () => {
    const { call } = await connect({});
    const all = await call("list_products", {});
    expect(all.structuredContent?.products).toEqual([
      expect.objectContaining({ product_id: product.id, price: "$407.99", variant: "Black", url: "http://shop.test/products/bose-qc-ultra" }),
    ]);
    const none = await call("list_products", { query: "garmin" });
    expect(none.structuredContent?.products).toEqual([]);
  });

  it("runs the engine as an agent request and returns a PayPal approval link on a match", async () => {
    const { call, deps } = await connect({});
    const r = await call("request_price_match", { product: product.slug, competitor_url: competitorUrl, buyer_email: "buyer@example.com" });
    expect(deps.runMatch).toHaveBeenCalledWith({ productId: product.id, competitorUrl }, undefined, { source: "agent", agentName: "claude-desktop" });
    expect(deps.createCheckoutOrder).toHaveBeenCalledWith(product.slug, "ae1687ff-d5e5-46bd-a0d0-a9de98f57f08", "match", { buyerEmail: "buyer@example.com" });
    const s = r.structuredContent!;
    expect(s.decision).toBe("match");
    expect(s.reasons).toEqual([{ check: "Approved store", status: "pass", detail: "bestbuy.com is approved.", evidence: "competitor.url" }]);
    expect(s.value_offer).toMatchObject({ title: "Store credit", worth: "$60.00", instead_of_cash_discount: "$48.00" });
    expect(s.checkout).toMatchObject({
      amount: "$359.99",
      approval_url: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T",
      simulated_payment: false,
    });
    expect(r.content[0].text).toMatch(/^Matched at \$359\.99 \(saves \$48\.00\)/);
  });

  it("takes the value offer when asked", async () => {
    const { call, deps } = await connect({});
    await call("request_price_match", { product: product.id, competitor_url: competitorUrl, option: "value" });
    expect(deps.createCheckoutOrder).toHaveBeenCalledWith(product.slug, expect.any(String), "value", { buyerEmail: undefined });
  });

  it("links demo-mode orders to the return route, which simulates the approval", async () => {
    const { call } = await connect({ paypalMode: () => "demo" });
    const r = await call("request_price_match", { product: product.id, competitor_url: competitorUrl });
    expect(r.structuredContent?.checkout).toMatchObject({
      simulated_payment: true,
      approval_url: "http://shop.test/api/checkout/return?orderId=c171f194-6a4c-4300-b229-b0f5aecea9bd&token=5O190127TN364715T",
    });
  });

  it("creates no order on a decline", async () => {
    const { call, deps } = await connect({ runMatch: vi.fn(async () => result("decline")) });
    const r = await call("request_price_match", { product: product.id, competitor_url: competitorUrl });
    expect(r.structuredContent).toMatchObject({ decision: "decline", checkout: null });
    expect(deps.createCheckoutOrder).not.toHaveBeenCalled();
  });

  it("rejects unknown products and bad links", async () => {
    const { call } = await connect({});
    expect((await call("request_price_match", { product: "nope", competitor_url: competitorUrl })).isError).toBe(true);
    expect((await call("request_price_match", { product: product.id, competitor_url: "ftp://x" })).isError).toBe(true);
  });

  it("reports the order and payment status of a match", async () => {
    const created = new Date("2026-11-10T12:00:00Z");
    const { call } = await connect({
      matchStatus: async () => ({
        match: { id: "m1", decision: "match", competitorUrl, competitorPriceCents: 35999, matchedPriceCents: 35999, createdAt: created },
        product,
        orders: [{ id: "o1", status: "completed", pricePaidCents: 35999, currency: "USD", paypalOrderId: "P1", paypalCaptureId: "C1", capturedAt: created }],
        protections: [{ orderId: "o1", status: "active", windowEndsAt: new Date("2026-11-24T12:00:00Z") }],
        refundedCents: 0,
      }) as never,
    });
    const r = await call("get_match_status", { match_id: "m1" });
    expect(r.structuredContent).toMatchObject({
      decision: "match",
      order: { status: "completed", payment: "paid", paypal_capture_id: "C1" },
      price_protection: { status: "active", refunded: "$0.00" },
    });
    expect((await (await connect({})).call("get_match_status", { match_id: "missing" })).isError).toBe(true);
  });
});
