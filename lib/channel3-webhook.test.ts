// The Channel3 webhook handler: Svix signature checks over the raw body, then store-once and evaluate.
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleChannel3Webhook, type Channel3WebhookDeps } from "./channel3-webhook";

const SECRET = `whsec_${Buffer.from("test-secret-for-matchpoint").toString("base64")}`;
const NOW = 1_800_000_000_000;

function signed(body: string, { id = "msg_test1", ts = NOW / 1000, secret = SECRET } = {}) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return new Headers({ "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${sig}` });
}

const priceChanged = JSON.stringify({
  type: "price.changed",
  canonical_product_id: "9KcTGLh",
  domain: "zappos.com",
  old_price: 25,
  new_price: 21.99,
  currency: "USD",
  buy_url: null,
  timestamp: "2026-11-11T10:00:00.123456789",
});

function deps(duplicate = false) {
  const record = vi.fn<Channel3WebhookDeps["record"]>(async () => ({ event: { id: "evt-1" }, duplicate }));
  const process = vi.fn<Channel3WebhookDeps["process"]>(async () => []);
  return { record, process, secret: SECRET, now: NOW };
}

describe("handleChannel3Webhook", () => {
  it("stores and evaluates a correctly signed price.changed", async () => {
    const d = deps();
    const out = await handleChannel3Webhook(signed(priceChanged), priceChanged, d);
    expect(out).toMatchObject({ status: 200, result: "recorded", eventId: "evt-1" });
    expect(d.record).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "webhook",
        externalId: "svix:msg_test1",
        channel3ProductId: "9KcTGLh",
        domain: "zappos.com",
        oldPriceCents: 2500,
        newPriceCents: 2199,
        verified: true,
      }),
    );
    expect(d.process).toHaveBeenCalledWith("evt-1");
  });

  it("reports a redelivery as a duplicate (evaluation is idempotent, so it runs again)", async () => {
    const d = deps(true);
    expect(await handleChannel3Webhook(signed(priceChanged), priceChanged, d)).toMatchObject({ status: 200, result: "duplicate" });
  });

  it("refuses a tampered body", async () => {
    const d = deps();
    const tampered = priceChanged.replace("21.99", "1.99");
    const out = await handleChannel3Webhook(signed(priceChanged), tampered, d);
    expect(out).toMatchObject({ status: 401, result: "unverified", reason: "signature mismatch" });
    expect(d.record).not.toHaveBeenCalled();
  });

  it("refuses a signature made with another secret", async () => {
    const other = `whsec_${Buffer.from("someone-else").toString("base64")}`;
    const out = await handleChannel3Webhook(signed(priceChanged, { secret: other }), priceChanged, deps());
    expect(out).toMatchObject({ status: 401, reason: "signature mismatch" });
  });

  it("refuses an unsigned delivery", async () => {
    const out = await handleChannel3Webhook(new Headers(), priceChanged, deps());
    expect(out).toMatchObject({ status: 401, result: "unverified", reason: "no signature headers" });
  });

  it("refuses a replayed old delivery outside the timestamp tolerance", async () => {
    const out = await handleChannel3Webhook(signed(priceChanged, { ts: NOW / 1000 - 3600 }), priceChanged, deps());
    expect(out).toMatchObject({ status: 401, reason: "timestamp outside tolerance" });
  });

  it("refuses everything when no secret is configured", async () => {
    const out = await handleChannel3Webhook(signed(priceChanged), priceChanged, { ...deps(), secret: undefined });
    expect(out).toMatchObject({ status: 401, reason: "CHANNEL3_WEBHOOK_SECRET not set" });
  });

  it("acknowledges other event types without storing them", async () => {
    const body = JSON.stringify({ type: "product.updated" });
    const d = deps();
    expect(await handleChannel3Webhook(signed(body), body, d)).toMatchObject({ status: 200, result: "ignored" });
    expect(d.record).not.toHaveBeenCalled();
  });

  it("rejects a signed but malformed price.changed", async () => {
    const body = JSON.stringify({ type: "price.changed", domain: "zappos.com" });
    expect(await handleChannel3Webhook(signed(body), body, deps())).toMatchObject({ status: 400, result: "invalid" });
  });
});
