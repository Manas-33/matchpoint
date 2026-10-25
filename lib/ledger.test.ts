// PayPal webhook handling with the recorded deliveries in fixtures/paypal/webhooks/: signature checks
// (against a stand-in for PayPal's verify-webhook-signature endpoint) and duplicate deliveries.
import { describe, expect, it, vi } from "vitest";
import { handlePayPalWebhook, type LedgerEventRow, type LedgerStore, type RecordResult } from "./ledger";
import { verifyPayPalWebhook, type PayPalWebhookVerification } from "./paypal";
import { paypalDeliveries, paypalDelivery, recordedContentLength, type Delivery } from "./paypal-webhook-fixtures";

const WEBHOOK_ID = "8PT597110X687430LKGECATA"; // stands in for the sandbox app's webhook ID

// Plays PayPal's verify-webhook-signature: SUCCESS only when the transmission headers, the webhook ID and
// the event are exactly those of a recorded delivery. Records each request body it was sent.
function fakePayPalVerifyEndpoint() {
  const recorded = paypalDeliveries();
  const requests: string[] = [];
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body);
    requests.push(body);
    const req = JSON.parse(body);
    const match = recorded.find(
      (d) =>
        d.headers.get("paypal-transmission-id") === req.transmission_id &&
        d.headers.get("paypal-transmission-sig") === req.transmission_sig &&
        d.headers.get("paypal-transmission-time") === req.transmission_time &&
        d.headers.get("paypal-cert-url") === req.cert_url &&
        JSON.stringify(d.event) === JSON.stringify(req.webhook_event),
    );
    const ok = match && req.webhook_id === WEBHOOK_ID;
    return Response.json({ verification_status: ok ? "SUCCESS" : "FAILURE" });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests, calls: fetch };
}

const verifierWith = (endpoint: ReturnType<typeof fakePayPalVerifyEndpoint>, webhookId: string | undefined = WEBHOOK_ID) =>
  (headers: Headers, rawBody: string) =>
    verifyPayPalWebhook({ headers, rawBody, webhookId, accessToken: async () => "test-token", fetch: endpoint.fetch });

// Same semantics as dbLedgerStore (checked against Postgres in ledger.db.test.ts).
function memoryStore() {
  const rows = new Map<string, LedgerEventRow>();
  const store: LedgerStore = {
    async record(row): Promise<RecordResult> {
      const existing = rows.get(row.paypalEventId);
      if (!existing) {
        rows.set(row.paypalEventId, row);
        return "inserted";
      }
      if (!existing.verified && row.verified) {
        rows.set(row.paypalEventId, row);
        return "upgraded";
      }
      return "duplicate";
    },
  };
  return { store, rows };
}

const tamper = (d: Delivery, change: (event: Delivery["event"] & Record<string, unknown>) => void): Delivery => {
  const event = structuredClone(d.event) as Delivery["event"] & Record<string, unknown>;
  change(event);
  return { ...d, event, rawBody: JSON.stringify(event) };
};

const completed = () => paypalDelivery("PAYMENT.CAPTURE.COMPLETED");
const refunded = () => paypalDelivery("PAYMENT.CAPTURE.REFUNDED");

describe("recorded deliveries", () => {
  it("re-serialise to the exact bytes PayPal sent", () => {
    for (const d of paypalDeliveries()) {
      expect(Buffer.byteLength(d.rawBody), d.name).toBe(recordedContentLength(`${d.name}.json`));
    }
  });
});

describe("verifyPayPalWebhook", () => {
  it("verifies a recorded PAYMENT.CAPTURE.COMPLETED delivery", async () => {
    const endpoint = fakePayPalVerifyEndpoint();
    const d = completed();
    await expect(verifierWith(endpoint)(d.headers, d.rawBody)).resolves.toMatchObject({ verified: true });
  });

  it("sends PayPal the raw body unchanged, with the transmission headers and webhook ID", async () => {
    const endpoint = fakePayPalVerifyEndpoint();
    const d = completed();
    await verifierWith(endpoint)(d.headers, d.rawBody);
    const [url, init] = endpoint.calls.mock.calls[0];
    expect(String(url)).toBe("https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect(endpoint.requests[0].endsWith(`"webhook_event":${d.rawBody}}`)).toBe(true);
    expect(JSON.parse(endpoint.requests[0])).toMatchObject({
      auth_algo: "SHA256withRSA",
      transmission_id: d.headers.get("paypal-transmission-id"),
      webhook_id: WEBHOOK_ID,
    });
  });

  it("rejects a delivery whose body was changed after signing", async () => {
    const endpoint = fakePayPalVerifyEndpoint();
    const forged = tamper(completed(), (e) => {
      (e.resource as { amount: { value: string } }).amount.value = "1.00";
    });
    const result = await verifierWith(endpoint)(forged.headers, forged.rawBody);
    expect(result).toMatchObject({ verified: false, reason: "verification_status FAILURE" });
  });

  it("rejects a delivery signed for a different webhook", async () => {
    const endpoint = fakePayPalVerifyEndpoint();
    const d = completed();
    await expect(verifierWith(endpoint, "SOME-OTHER-WEBHOOK")(d.headers, d.rawBody)).resolves.toMatchObject({ verified: false });
  });

  it("rejects a delivery without PayPal's signature headers, without calling PayPal", async () => {
    const endpoint = fakePayPalVerifyEndpoint();
    const d = completed();
    const headers = new Headers(d.headers);
    headers.delete("paypal-transmission-sig");
    await expect(verifierWith(endpoint)(headers, d.rawBody)).resolves.toEqual({ verified: false, reason: "missing PayPal headers" });
    expect(endpoint.calls).not.toHaveBeenCalled();
  });

  it("can't verify anything without PAYPAL_WEBHOOK_ID", async () => {
    const endpoint = fakePayPalVerifyEndpoint();
    const d = completed();
    const verify = (h: Headers, b: string) =>
      verifyPayPalWebhook({ headers: h, rawBody: b, webhookId: undefined, accessToken: async () => "t", fetch: endpoint.fetch });
    await expect(verify(d.headers, d.rawBody)).resolves.toMatchObject({ verified: false, reason: "PAYPAL_WEBHOOK_ID not set" });
    expect(endpoint.calls).not.toHaveBeenCalled();
  });

  it("throws when PayPal's verify endpoint is down, so the delivery is retried", async () => {
    const d = completed();
    const fetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof globalThis.fetch;
    await expect(
      verifyPayPalWebhook({ headers: d.headers, rawBody: d.rawBody, webhookId: WEBHOOK_ID, accessToken: async () => "t", fetch }),
    ).rejects.toThrow(/503/);
  });
});

describe("handlePayPalWebhook", () => {
  it("records a verified PAYMENT.CAPTURE.COMPLETED in the ledger", async () => {
    const { store, rows } = memoryStore();
    const onCaptureCompleted = vi.fn();
    const d = completed();
    const outcome = await handlePayPalWebhook(d.headers, d.rawBody, { verify: verifierWith(fakePayPalVerifyEndpoint()), store, onCaptureCompleted });
    expect(outcome).toMatchObject({ status: 200, result: "recorded", verified: true, eventType: "PAYMENT.CAPTURE.COMPLETED" });
    expect(rows.get(d.event.id)).toMatchObject({
      paypalEventId: "WH-8S525160UL795563H-2DE73718KB1560458",
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      resourceId: "2S321369LL635443S",
      verified: true,
    });
    expect(onCaptureCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "2S321369LL635443S", amountCents: 12000, currency: "USD", paypalOrderId: "0VR4998765084373W" }),
    );
  });

  it("records a verified PAYMENT.CAPTURE.REFUNDED with the refund as its resource", async () => {
    const { store, rows } = memoryStore();
    const d = refunded();
    const outcome = await handlePayPalWebhook(d.headers, d.rawBody, { verify: verifierWith(fakePayPalVerifyEndpoint()), store });
    expect(outcome).toMatchObject({ status: 200, result: "recorded", verified: true });
    expect(rows.get(d.event.id)).toMatchObject({ resourceId: "3M986776R8117221S", verified: true });
  });

  it("ignores a redelivery of the same event", async () => {
    const { store, rows } = memoryStore();
    const deps = { verify: verifierWith(fakePayPalVerifyEndpoint()), store };
    const d = completed();
    await handlePayPalWebhook(d.headers, d.rawBody, deps);
    const again = await handlePayPalWebhook(d.headers, d.rawBody, deps);
    expect(again).toMatchObject({ status: 200, result: "duplicate", eventId: d.event.id });
    expect(rows.size).toBe(1);
  });

  it("deduplicates on the event ID, not the transmission (PayPal retries send new transmission IDs)", async () => {
    const { store, rows } = memoryStore();
    const verify = async (): Promise<PayPalWebhookVerification> => ({ verified: true });
    const d = completed();
    const retry = new Headers(d.headers);
    retry.set("paypal-transmission-id", "a-later-retry");
    await handlePayPalWebhook(d.headers, d.rawBody, { verify, store });
    await expect(handlePayPalWebhook(retry, d.rawBody, { verify, store })).resolves.toMatchObject({ result: "duplicate" });
    expect(rows.size).toBe(1);
  });

  it("flags a forged event as unverified and refuses it", async () => {
    const { store, rows } = memoryStore();
    const forged = tamper(completed(), (e) => {
      e.id = "WH-FORGED";
    });
    const onCaptureCompleted = vi.fn();
    const outcome = await handlePayPalWebhook(forged.headers, forged.rawBody, {
      verify: verifierWith(fakePayPalVerifyEndpoint()),
      store,
      onCaptureCompleted,
    });
    expect(outcome).toMatchObject({ status: 400, result: "unverified", verified: false });
    expect(rows.get("WH-FORGED")?.verified).toBe(false);
    expect(onCaptureCompleted).not.toHaveBeenCalled();
  });

  it("doesn't let a forged copy overwrite a verified event", async () => {
    const { store, rows } = memoryStore();
    const deps = { verify: verifierWith(fakePayPalVerifyEndpoint()), store };
    const d = completed();
    await handlePayPalWebhook(d.headers, d.rawBody, deps);
    const forged = tamper(d, (e) => {
      (e.resource as { amount: { value: string } }).amount.value = "1.00";
    });
    await expect(handlePayPalWebhook(forged.headers, forged.rawBody, deps)).resolves.toMatchObject({ status: 400, result: "unverified" });
    expect(rows.get(d.event.id)).toMatchObject({ verified: true, rawPayload: d.event });
  });

  it("replaces an unverified row when the genuine delivery arrives (no ID squatting)", async () => {
    const { store, rows } = memoryStore();
    const d = completed();
    const squat = tamper(d, (e) => {
      (e.resource as { amount: { value: string } }).amount.value = "1.00";
    });
    const deps = { verify: verifierWith(fakePayPalVerifyEndpoint()), store };
    await handlePayPalWebhook(squat.headers, squat.rawBody, deps);
    expect(rows.get(d.event.id)?.verified).toBe(false);
    await expect(handlePayPalWebhook(d.headers, d.rawBody, deps)).resolves.toMatchObject({ status: 200, result: "upgraded" });
    expect(rows.get(d.event.id)).toMatchObject({ verified: true, rawPayload: d.event });
  });

  it("acknowledges other event types without verifying or storing them", async () => {
    const { store, rows } = memoryStore();
    const verify = vi.fn();
    const d = paypalDelivery("CHECKOUT.ORDER.APPROVED");
    await expect(handlePayPalWebhook(d.headers, d.rawBody, { verify, store })).resolves.toMatchObject({ status: 200, result: "ignored" });
    expect(verify).not.toHaveBeenCalled();
    expect(rows.size).toBe(0);
  });

  it("rejects a body that isn't a webhook event", async () => {
    const { store } = memoryStore();
    const verify = vi.fn();
    await expect(handlePayPalWebhook(new Headers(), "not json", { verify, store })).resolves.toMatchObject({ status: 400, result: "invalid" });
    await expect(handlePayPalWebhook(new Headers(), "{}", { verify, store })).resolves.toMatchObject({ status: 400, result: "invalid" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("stores nothing when the signature can't be checked, so PayPal's retry gets a clean slate", async () => {
    const { store, rows } = memoryStore();
    const verify = async () => {
      throw new Error("PayPal webhook verification unavailable (HTTP 503)");
    };
    const d = completed();
    await expect(handlePayPalWebhook(d.headers, d.rawBody, { verify, store })).rejects.toThrow(/503/);
    expect(rows.size).toBe(0);
  });
});
