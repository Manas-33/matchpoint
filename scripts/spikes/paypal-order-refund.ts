// Phase 0 PayPal test: create order -> buyer approves in sandbox -> capture -> partial refund.
// Usage: npm run spike:paypal [-- --order <ORDER_ID>]   (pass --order to resume an approved order)
import { randomUUID } from "node:crypto";
import {
  ApiError,
  CheckoutPaymentIntent,
  OrdersController,
  PaymentsController,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
  type ApiResponse,
} from "@paypal/paypal-server-sdk";
import { paypalClient } from "./lib/paypal.js";
import { saveFixture } from "./lib/fixtures.js";

const PRICE = "120.00";
const PARTIAL_REFUND = "15.00";
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

const client = paypalClient();
const orders = new OrdersController(client);
const payments = new PaymentsController(client);

// Fixtures keep PayPal's raw JSON, not the SDK's camelCased mapping.
const raw = (res: ApiResponse<unknown>) =>
  typeof res.body === "string" ? JSON.parse(res.body) : res.result;

async function createOrder(): Promise<string> {
  const runId = Date.now();
  const res = await orders.createOrder({
    paypalRequestId: randomUUID(),
    prefer: "return=representation",
    body: {
      intent: CheckoutPaymentIntent.Capture,
      purchaseUnits: [
        {
          referenceId: "spike",
          invoiceId: `spike-${runId}`,
          description: "Matchpoint Phase 0 spike: matched price",
          amount: { currencyCode: "USD", value: PRICE },
        },
      ],
      paymentSource: {
        paypal: {
          experienceContext: {
            brandName: "Matchpoint Demo Shop",
            shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
            userAction: PaypalExperienceUserAction.PayNow,
            returnUrl: "https://example.com/matchpoint/return",
            cancelUrl: "https://example.com/matchpoint/cancel",
          },
        },
      },
    },
  });
  const body = raw(res);
  saveFixture("paypal/01-create-order", body);
  const approve = body.links?.find((l: { rel: string }) => l.rel === "payer-action" || l.rel === "approve");
  console.log(`\nOrder ${body.id} created (${body.status}).`);
  console.log(`Open this link, log in as a sandbox PERSONAL buyer and click Pay:\n\n  ${approve?.href}\n`);
  console.log("(After paying you land on example.com — that's expected. Waiting for approval...)");
  return body.id;
}

async function waitForApproval(id: string) {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await orders.getOrder({ id });
    const body = raw(res);
    if (body.status === "APPROVED" || body.status === "COMPLETED") {
      saveFixture("paypal/02-order-approved", body);
      return body.status as string;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`Order ${id} not approved within ${APPROVAL_TIMEOUT_MS / 60_000} minutes`);
}

async function main() {
  const flag = process.argv.indexOf("--order");
  const id = flag > -1 ? process.argv[flag + 1] : await createOrder();
  const status = await waitForApproval(id);
  console.log(`Order ${id} is ${status}.`);

  const captureRes = await orders.captureOrder({
    id,
    paypalRequestId: `capture-${id}`,
    prefer: "return=representation",
  });
  const order = raw(captureRes);
  saveFixture("paypal/03-capture-order", order);
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  console.log(`Captured ${capture.amount.value} ${capture.amount.currency_code}: capture ${capture.id} (${capture.status})`);

  // Stable request ID: re-running the refund for the same capture can't pay twice.
  const refundRes = await payments.refundCapturedPayment({
    captureId: capture.id,
    paypalRequestId: `spike-refund-${capture.id}`,
    prefer: "return=representation",
    body: {
      amount: { currencyCode: "USD", value: PARTIAL_REFUND },
      noteToPayer: "Matchpoint price protection: an approved store dropped its price.",
      invoiceId: `spike-refund-${capture.id}`,
    },
  });
  const refund = raw(refundRes);
  saveFixture("paypal/04-partial-refund", refund);
  console.log(`Refunded ${refund.amount?.value} ${refund.amount?.currency_code}: refund ${refund.id} (${refund.status})`);

  const after = raw(await payments.getCapturedPayment({ captureId: capture.id }));
  saveFixture("paypal/05-capture-after-refund", after);
  console.log(`Capture ${capture.id} is now ${after.status}.`);
  console.log("\nPASS: order created, captured and partially refunded via the PayPal Server SDK.");
}

main().catch((err) => {
  if (err instanceof ApiError) {
    console.error(`PayPal API error ${err.statusCode}:`, err.body);
  } else {
    console.error(err);
  }
  process.exit(1);
});
