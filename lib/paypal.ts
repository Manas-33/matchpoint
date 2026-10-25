// PayPal (sandbox only): create and capture orders, partial refunds on captures, and webhook signature
// verification. Built on the APIMatic-generated @paypal/paypal-server-sdk; ported from scripts/spikes/.
// Demo mode replays the recorded responses in fixtures/paypal/ with IDs and amounts filled in.
import { createHash } from "node:crypto";
import {
  ApiError,
  CheckoutPaymentIntent,
  Client,
  Environment,
  OAuthAuthorizationController,
  OrdersController,
  PaymentsController,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
  type ApiResponse,
} from "@paypal/paypal-server-sdk";
import { getEnv } from "./env";
import { listFixtures, loadFixture } from "./fixtures";
import { centsToPaypalValue, paypalValueToCents, type Cents } from "./money";

const PAYPAL_API = "https://api-m.sandbox.paypal.com";

// PayPal's JSON as returned on the wire (snake_case), kept for the ledger and evidence.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PayPalJson = any;

export type CreateOrderInput = {
  amountCents: Cents;
  currency?: string;
  description: string;
  // Our reference (order or match request ID), echoed back as purchase_units[0].invoice_id.
  invoiceId: string;
  referenceId?: string;
  // PayPal-Request-Id: the same key returns the same order instead of creating another.
  requestId: string;
  returnUrl: string;
  cancelUrl: string;
};
export type CreatedOrder = { orderId: string; status: string; approveUrl: string | null; raw: PayPalJson };

export type CapturedOrder = {
  orderId: string;
  status: string;
  captureId: string;
  captureStatus: string;
  amountCents: Cents;
  currency: string;
  payerEmail: string | null;
  raw: PayPalJson;
};

export type RefundInput = {
  captureId: string;
  amountCents: Cents;
  currency?: string;
  noteToPayer: string;
  invoiceId: string;
  // Stable per refund decision (protection + price event) so a retry can't pay twice.
  requestId: string;
};
export type IssuedRefund = { refundId: string; status: string; amountCents: Cents; currency: string; raw: PayPalJson };

export type PayPalWebhookVerification = { verified: boolean; reason?: string; response?: unknown };

export interface PayPalService {
  readonly mode: "live" | "demo";
  createOrder(input: CreateOrderInput): Promise<CreatedOrder>;
  captureOrder(orderId: string): Promise<CapturedOrder>;
  refundCapture(input: RefundInput): Promise<IssuedRefund>;
  verifyWebhookSignature(headers: Headers, rawBody: string): Promise<PayPalWebhookVerification>;
}

function orderBody(input: CreateOrderInput) {
  return {
    intent: CheckoutPaymentIntent.Capture,
    purchaseUnits: [
      {
        referenceId: input.referenceId ?? "default",
        invoiceId: input.invoiceId,
        description: input.description,
        amount: { currencyCode: input.currency ?? "USD", value: centsToPaypalValue(input.amountCents) },
      },
    ],
    paymentSource: {
      paypal: {
        experienceContext: {
          brandName: "Matchpoint Demo Shop",
          shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
          userAction: PaypalExperienceUserAction.PayNow,
          returnUrl: input.returnUrl,
          cancelUrl: input.cancelUrl,
        },
      },
    },
  };
}

const approveLink = (order: PayPalJson): string | null =>
  order.links?.find((l: { rel: string }) => l.rel === "payer-action" || l.rel === "approve")?.href ?? null;

function toCaptured(order: PayPalJson): CapturedOrder {
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture) throw new Error(`PayPal order ${order.id} has no capture`);
  return {
    orderId: order.id,
    status: order.status,
    captureId: capture.id,
    captureStatus: capture.status,
    amountCents: paypalValueToCents(capture.amount.value),
    currency: capture.amount.currency_code,
    payerEmail: order.payment_source?.paypal?.email_address ?? order.payer?.email_address ?? null,
    raw: order,
  };
}

const toRefund = (refund: PayPalJson): IssuedRefund => ({
  refundId: refund.id,
  status: refund.status,
  amountCents: paypalValueToCents(refund.amount.value),
  currency: refund.amount.currency_code,
  raw: refund,
});

const header = (headers: Headers, name: string) => headers.get(name) ?? undefined;

function livePayPal(clientId: string, clientSecret: string, webhookId: string | undefined): PayPalService {
  // The SDK defaults to no timeout and no retries (DEFAULT_CONFIGURATION / DEFAULT_RETRY_CONFIG).
  // Only GETs are retried here; POSTs carry PayPal-Request-Id and are retried by callers that own the key.
  // No `logging` option: any value turns on console logging of every request (at the given level).
  const client = new Client({
    clientCredentialsAuthCredentials: { oAuthClientId: clientId, oAuthClientSecret: clientSecret },
    environment: Environment.Sandbox,
    timeout: 30_000,
    httpClientOptions: { retryConfig: { maxNumberOfRetries: 2, maximumRetryWaitTime: 10 } },
  });
  const orders = new OrdersController(client);
  const payments = new PaymentsController(client);
  const oauth = new OAuthAuthorizationController(client);

  // Keep PayPal's raw JSON, not the SDK's camelCased mapping.
  const raw = (res: ApiResponse<unknown>): PayPalJson =>
    typeof res.body === "string" ? JSON.parse(res.body) : res.result;

  let token: { value: string; expiresAt: number } | undefined;
  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value;
    const res = await oauth.requestToken({
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    });
    const ttlSeconds = Number(res.result.expiresIn ?? 300n);
    token = { value: res.result.accessToken, expiresAt: Date.now() + ttlSeconds * 1000 };
    return token.value;
  }

  return {
    mode: "live",
    async createOrder(input) {
      const order = raw(
        await orders.createOrder({
          paypalRequestId: input.requestId,
          prefer: "return=representation",
          body: orderBody(input),
        }),
      );
      return { orderId: order.id, status: order.status, approveUrl: approveLink(order), raw: order };
    },
    async captureOrder(orderId) {
      const order = raw(
        await orders.captureOrder({ id: orderId, paypalRequestId: `capture-${orderId}`, prefer: "return=representation" }),
      );
      return toCaptured(order);
    },
    async refundCapture(input) {
      const refund = raw(
        await payments.refundCapturedPayment({
          captureId: input.captureId,
          paypalRequestId: input.requestId,
          prefer: "return=representation",
          body: {
            amount: { currencyCode: input.currency ?? "USD", value: centsToPaypalValue(input.amountCents) },
            noteToPayer: input.noteToPayer,
            invoiceId: input.invoiceId,
          },
        }),
      );
      return toRefund(refund);
    },
    // Not in the SDK: POST /v1/notifications/verify-webhook-signature. PayPal re-hashes webhook_event,
    // so the raw body is spliced in rather than re-serialised (key order or number formatting could differ).
    async verifyWebhookSignature(headers, rawBody) {
      if (!webhookId) return { verified: false, reason: "PAYPAL_WEBHOOK_ID not set" };
      const fields = {
        auth_algo: header(headers, "paypal-auth-algo"),
        cert_url: header(headers, "paypal-cert-url"),
        transmission_id: header(headers, "paypal-transmission-id"),
        transmission_sig: header(headers, "paypal-transmission-sig"),
        transmission_time: header(headers, "paypal-transmission-time"),
        webhook_id: webhookId,
      };
      if (!fields.transmission_id || !fields.transmission_sig) return { verified: false, reason: "missing PayPal headers" };
      const res = await fetch(`${PAYPAL_API}/v1/notifications/verify-webhook-signature`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await accessToken()}` },
        body: `${JSON.stringify(fields).slice(0, -1)},"webhook_event":${rawBody}}`,
      });
      const json = (await res.json()) as { verification_status?: string };
      return json.verification_status === "SUCCESS"
        ? { verified: true, response: json }
        : { verified: false, reason: `verification_status ${json.verification_status ?? res.status}`, response: json };
    },
  };
}

// Demo IDs are derived from the idempotency key, so repeating a request returns the same IDs (like PayPal).
const demoId = (prefix: string, key: string) =>
  `${prefix}${createHash("sha256").update(key).digest("hex").slice(0, 15).toUpperCase()}`;

type RecordedWebhook = { headers: Record<string, string>; verification: { verified: boolean } };

function demoPayPal(): PayPalService {
  // Orders created in this process, so a capture returns the amount that was ordered.
  const created = new Map<string, CreateOrderInput>();

  return {
    mode: "demo",
    async createOrder(input) {
      const orderId = demoId("DEMO", input.requestId);
      created.set(orderId, input);
      const order = structuredClone(loadFixture<PayPalJson>("paypal/01-create-order"));
      order.id = orderId;
      Object.assign(order.purchase_units[0], {
        reference_id: input.referenceId ?? "default",
        invoice_id: input.invoiceId,
        description: input.description,
        amount: { currency_code: input.currency ?? "USD", value: centsToPaypalValue(input.amountCents) },
      });
      // There is no PayPal checkout to send the buyer to in demo mode.
      order.links = [];
      return { orderId, status: order.status, approveUrl: null, raw: order };
    },
    async captureOrder(orderId) {
      const input = created.get(orderId);
      const order = structuredClone(loadFixture<PayPalJson>("paypal/03-capture-order"));
      const unit = order.purchase_units[0];
      const capture = unit.payments.captures[0];
      order.id = orderId;
      capture.id = demoId("DEMOCAP", orderId);
      capture.links = [];
      if (input) {
        const amount = { currency_code: input.currency ?? "USD", value: centsToPaypalValue(input.amountCents) };
        Object.assign(unit, { amount, invoice_id: input.invoiceId, description: input.description });
        Object.assign(capture, { amount, invoice_id: input.invoiceId });
        delete capture.seller_receivable_breakdown;
      }
      return toCaptured(order);
    },
    async refundCapture(input) {
      const refund = structuredClone(loadFixture<PayPalJson>("paypal/04-partial-refund"));
      const amount = { currency_code: input.currency ?? "USD", value: centsToPaypalValue(input.amountCents) };
      Object.assign(refund, {
        id: demoId("DEMOREF", input.requestId),
        amount,
        note_to_payer: input.noteToPayer,
        invoice_id: input.invoiceId,
        links: [],
      });
      delete refund.seller_payable_breakdown;
      return toRefund(refund);
    },
    // Replayed deliveries keep the verification result recorded when they first arrived.
    async verifyWebhookSignature(headers) {
      const transmissionId = header(headers, "paypal-transmission-id");
      const recorded = listFixtures("paypal/webhooks")
        .map((f) => loadFixture<RecordedWebhook>(`paypal/webhooks/${f}`))
        .find((w) => w.headers["paypal-transmission-id"] === transmissionId);
      return recorded
        ? { verified: recorded.verification.verified, reason: "demo mode: recorded verification" }
        : { verified: false, reason: "demo mode: delivery not in fixtures" };
    },
  };
}

let service: PayPalService | undefined;

export function getPayPal(): PayPalService {
  if (!service) {
    const env = getEnv();
    service = env.DEMO_MODE
      ? demoPayPal()
      : livePayPal(env.PAYPAL_CLIENT_ID!, env.PAYPAL_CLIENT_SECRET!, env.PAYPAL_WEBHOOK_ID);
  }
  return service;
}

export { ApiError as PayPalApiError };
