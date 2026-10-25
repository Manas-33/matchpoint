// Every service client in demo mode, answering from the recorded fixtures with no network or keys.
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("DEMO_MODE", "true");
  vi.stubEnv("DATABASE_URL", "postgres://u:p@localhost:5433/db");
  for (const key of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "CHANNEL3_API_KEY", "ANTHROPIC_API_KEY", "RESEND_API_KEY"]) {
    vi.stubEnv(key, "");
  }
});

const BESTBUY_XM5 = "https://www.bestbuy.com/site/sony-wh-1000xm5-wireless-noise-canceling-headphones-black/6505727.p";

describe("Channel3 demo", () => {
  it("looks up a recorded competitor URL, ignoring www, query and trailing slash", async () => {
    const { getChannel3 } = await import("./channel3");
    const c3 = getChannel3();
    expect(c3.mode).toBe("demo");
    const product = await c3.lookup(BESTBUY_XM5.replace("www.", "") + "/?utm_source=x");
    expect(product.title).toMatch(/WH.1000XM5/);
    expect(product.offers?.some((o) => o.domain === "bestbuy.com")).toBe(true);
  });

  it("fails clearly for a URL with no recording", async () => {
    const { getChannel3 } = await import("./channel3");
    const { MissingFixtureError } = await import("./fixtures");
    await expect(getChannel3().lookup("https://example.com/p/1")).rejects.toBeInstanceOf(MissingFixtureError);
  });

  it("serves catalog products, search, similar and price history", async () => {
    const { getChannel3 } = await import("./channel3");
    const c3 = getChannel3();
    expect((await c3.retrieve("mgo7x7F")).title).toMatch(/QuietComfort Ultra/);
    const results = await c3.search("Bose QuietComfort Ultra headphones", { limit: 3 });
    expect(results).toHaveLength(3);
    const similar = await c3.findSimilar("mgo7x7F", 2);
    expect(similar.map((p) => p.id)).not.toContain("mgo7x7F");
    const history = await c3.priceHistory("mgo7x7F");
    expect(history.history?.[0].timestamp).toBeInstanceOf(Date);
    expect(history.statistics?.current_status).toBe("typical");
  });
});

describe("Channel3 webhook signatures", () => {
  const secret = `whsec_${Buffer.from("matchpoint-test-secret").toString("base64")}`;
  const body = JSON.stringify({ type: "price.changed", canonical_product_id: "mgo7x7F", domain: "bestbuy.com", new_price: 279 });

  async function signed(timestamp: number, payload = body) {
    const { createHmac } = await import("node:crypto");
    const key = Buffer.from(secret.slice("whsec_".length), "base64");
    const sig = createHmac("sha256", key).update(`msg_1.${timestamp}.${payload}`).digest("base64");
    return new Headers({ "svix-id": "msg_1", "svix-timestamp": String(timestamp), "svix-signature": `v1,${sig}` });
  }

  it("accepts a valid signature and rejects tampering, staleness and a missing secret", async () => {
    const { verifyChannel3Webhook } = await import("./channel3");
    const now = Date.now();
    const ts = Math.floor(now / 1000);
    expect(verifyChannel3Webhook(await signed(ts), body, secret, { now })).toEqual({ verified: true });
    expect(verifyChannel3Webhook(await signed(ts), body.replace("279", "1"), secret, { now }).verified).toBe(false);
    expect(verifyChannel3Webhook(await signed(ts - 3600), body, secret, { now }).verified).toBe(false);
    expect(verifyChannel3Webhook(await signed(ts), body, undefined, { now }).verified).toBe(false);
    expect(verifyChannel3Webhook(new Headers(), body, secret).verified).toBeNull();
  });

  it("parses the flat price.changed payload", async () => {
    const { PriceChangedEvent } = await import("./channel3");
    expect(PriceChangedEvent.parse(JSON.parse(body))).toMatchObject({ domain: "bestbuy.com", new_price: 279, currency: "USD" });
  });
});

describe("PayPal demo", () => {
  const order = {
    amountCents: 39899,
    description: "Sony WH-1000XM5",
    invoiceId: "mp-order-1",
    requestId: "create-mp-order-1",
    returnUrl: "http://localhost:3000/return",
    cancelUrl: "http://localhost:3000/cancel",
  };

  it("creates, captures and partially refunds with the requested amounts", async () => {
    const { getPayPal } = await import("./paypal");
    const pp = getPayPal();
    const created = await pp.createOrder(order);
    expect(created.orderId).toMatch(/^DEMO[0-9A-F]{15}$/);
    expect(created.raw.purchase_units[0].amount.value).toBe("398.99");
    // Same idempotency key, same order.
    expect((await pp.createOrder(order)).orderId).toBe(created.orderId);

    const captured = await pp.captureOrder(created.orderId);
    expect(captured).toMatchObject({ orderId: created.orderId, status: "COMPLETED", amountCents: 39899 });

    const refund = await pp.refundCapture({
      captureId: captured.captureId,
      amountCents: 2000,
      noteToPayer: "Price protection",
      invoiceId: "mp-refund-1",
      requestId: "protection-1:event-1",
    });
    expect(refund).toMatchObject({ status: "COMPLETED", amountCents: 2000 });
  });

  it("returns the recorded verification for a replayed webhook delivery", async () => {
    const { getPayPal } = await import("./paypal");
    const { listFixtures, loadFixture } = await import("./fixtures");
    const file = listFixtures("paypal/webhooks").find((f) => f.startsWith("payment-capture-completed"))!;
    const recorded = loadFixture<{ headers: Record<string, string>; raw_body?: string; event: unknown }>(`paypal/webhooks/${file}`);
    const result = await getPayPal().verifyWebhookSignature(new Headers(recorded.headers), JSON.stringify(recorded.event));
    expect(result.verified).toBe(true);
    expect((await getPayPal().verifyWebhookSignature(new Headers(), "{}")).verified).toBe(false);
  });
});

describe("Claude demo", () => {
  it("serves the recorded same-product judgment for a known pair", async () => {
    const { getClaude } = await import("./claude");
    const { loadFixture } = await import("./fixtures");
    const shop = loadFixture<import("./claude").Listing>("channel3/catalog/hrz4MAW");
    const competitor = loadFixture<import("./claude").Listing>(
      "channel3/lookup/bestbuy-com-sony-wh-1000xm5-wireless-noise-06d46e",
    );
    const result = await getClaude().judgeSameProduct(shop, competitor);
    expect(result.outcome).toBe("ok");
    if (result.outcome === "ok") expect(result.decision.same_product).toBe(true);
  });

  it("sends an unrecorded pair to review", async () => {
    const { getClaude } = await import("./claude");
    const { loadFixture } = await import("./fixtures");
    const shop = loadFixture<import("./claude").Listing>("channel3/catalog/oAZYjS0");
    const result = await getClaude().judgeSameProduct(shop, { url: "https://example.com/x", product: shop.product });
    expect(result.outcome).toBe("review");
  });
});

describe("Email demo", () => {
  it("logs instead of sending", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { getEmail } = await import("./email");
    const sent = await getEmail().send({ to: "buyer@example.com", subject: "Refund", html: "<p>hi</p>", text: "hi" });
    expect(sent.transport).toBe("log");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("buyer@example.com"));
    log.mockRestore();
  });
});
