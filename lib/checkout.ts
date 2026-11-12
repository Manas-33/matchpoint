// Checkout at list price: create the PayPal order from the product's price in the database, and capture
// it once the buyer approves. The browser only ever names a product; it never sends an amount.
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { getDb, schema } from "./db";
import { getEnv } from "./env";
import { formatCents } from "./money";
import { getPayPal, PayPalApiError, type CapturedOrder } from "./paypal";
import { savedValueOffer } from "./match/value-offer";
import { enrolProtection } from "./price-protection";
import { getProductBySlug, variantLabel } from "./shop";

type OrderStatus = (typeof schema.orderStatus.enumValues)[number];

export class CheckoutError extends Error {
  constructor(
    readonly code:
      | "PRODUCT_NOT_FOUND"
      | "ORDER_NOT_FOUND"
      | "MATCH_NOT_VALID"
      | "INSTRUMENT_DECLINED"
      | "AMOUNT_MISMATCH"
      | "PAYPAL_ERROR",
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}

// JSON error body for the checkout routes: our errors keep their code; anything else is a generic 500.
export function checkoutErrorResponse(err: unknown) {
  if (err instanceof CheckoutError) return Response.json({ error: err.code, message: err.message }, { status: err.httpStatus });
  console.error(err);
  return Response.json({ error: "INTERNAL", message: "Something went wrong. Please try again." }, { status: 500 });
}

// PayPal's description field is limited to 127 characters.
const orderDescription = (title: string, variant: string) => (variant ? `${title} (${variant})` : title).slice(0, 127);

// A matched price is honoured for this long after the decision.
export const MATCH_VALID_MS = 24 * 60 * 60 * 1000;

// What the customer chose after a match: the cash price match, or the value-match counter-offer
// (pay the list price and get the alternative instead).
export type MatchOption = "match" | "value";

// The price for this checkout: the list price, or, for an approved match request on this product, the
// matched price or the list price with the counter-offer. The browser only names the match request and
// the option; the amount always comes from the database.
async function checkoutPrice(product: { id: string; shopPriceCents: number }, matchRequestId?: string, option: MatchOption = "match") {
  if (!matchRequestId) return { amountCents: product.shopPriceCents, match: null, valueOffer: null };
  const [match] = await getDb()
    .select()
    .from(schema.matchRequests)
    .where(eq(schema.matchRequests.id, matchRequestId))
    .limit(1);
  if (
    !match ||
    match.productId !== product.id ||
    match.decision !== "match" ||
    match.matchedPriceCents == null ||
    Date.now() - match.createdAt.getTime() > MATCH_VALID_MS
  ) {
    throw new CheckoutError("MATCH_NOT_VALID", "That price match isn't valid any more. Please check the link again.", 409);
  }
  if (option === "value") {
    const valueOffer = savedValueOffer(match.reasons);
    if (!valueOffer) throw new CheckoutError("MATCH_NOT_VALID", "There's no alternative offer on that price match.", 409);
    return { amountCents: product.shopPriceCents, match, valueOffer };
  }
  return { amountCents: match.matchedPriceCents, match, valueOffer: null };
}

// Orders created for a shopping agent: the buyer approves on PayPal's own page (no JS SDK popup), so
// PayPal sends them back to the return route, which captures the payment and shows the order.
export type AgentCheckout = { buyerEmail?: string };

export async function createCheckoutOrder(
  productSlug: string,
  matchRequestId?: string,
  option: MatchOption = "match",
  agent?: AgentCheckout,
) {
  const product = await getProductBySlug(productSlug);
  if (!product) throw new CheckoutError("PRODUCT_NOT_FOUND", "That product isn't in the catalog", 404);
  const { amountCents, match, valueOffer } = await checkoutPrice(product, matchRequestId, option);

  // Our order ID doubles as PayPal's invoice_id and the idempotency key. A matched order names the store
  // in its description and carries the match request ID as the purchase unit's reference_id.
  const id = randomUUID();
  const appUrl = getEnv().APP_URL;
  const description = orderDescription(product.title, variantLabel(product.variant));
  const created = await getPayPal().createOrder({
    amountCents,
    currency: product.currency,
    description: (valueOffer
      ? `${description.slice(0, 70)} + ${valueOffer.title} (price-match alternative)`
      : match
        ? `${description.slice(0, 90)} - price matched to ${match.competitorDomain}`
        : description
    ).slice(0, 127),
    invoiceId: id,
    referenceId: match ? `match-${match.id}` : product.id,
    requestId: `order-${id}`,
    returnUrl: agent ? `${appUrl}/api/checkout/return?orderId=${id}` : `${appUrl}/orders/${id}`,
    cancelUrl: `${appUrl}/products/${product.slug}`,
  });

  await getDb().insert(schema.orders).values({
    id,
    paypalOrderId: created.orderId,
    productId: product.id,
    matchRequestId: match?.id ?? null,
    pricePaidCents: amountCents,
    currency: product.currency,
    // PayPal's payer email replaces this at capture.
    buyerEmail: agent?.buyerEmail ?? null,
    status: "created",
  });
  console.log(
    JSON.stringify({ msg: "checkout order created", orderId: id, paypalOrderId: created.orderId, product: product.slug, amount: formatCents(amountCents), matchRequestId: match?.id, option: match ? option : undefined }),
  );
  return { orderId: id, paypalOrderId: created.orderId, approveUrl: created.approveUrl, amountCents, currency: product.currency };
}

const captureStatus = (status: string): OrderStatus =>
  status === "COMPLETED" ? "completed" : status === "PENDING" ? "approved" : "failed";

// PayPal error responses name the problem in details[].issue, e.g. INSTRUMENT_DECLINED.
function paypalIssue(err: unknown): string | undefined {
  if (!(err instanceof PayPalApiError)) return undefined;
  const result = (err.result ?? (typeof err.body === "string" ? safeJson(err.body) : undefined)) as
    | { name?: string; details?: { issue?: string }[] }
    | undefined;
  return result?.details?.[0]?.issue ?? result?.name;
}
const safeJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

export async function captureCheckoutOrder(paypalOrderId: string) {
  const db = getDb();
  const [order] = await db.select().from(schema.orders).where(eq(schema.orders.paypalOrderId, paypalOrderId)).limit(1);
  if (!order) throw new CheckoutError("ORDER_NOT_FOUND", "No checkout matches that PayPal order", 404);
  // Already captured (a double click, or the webhook got there first).
  if (order.paypalCaptureId) return { orderId: order.id, status: order.status, captureId: order.paypalCaptureId };

  let captured: CapturedOrder;
  try {
    captured = await getPayPal().captureOrder(paypalOrderId);
  } catch (err) {
    const issue = paypalIssue(err);
    console.error(JSON.stringify({ msg: "checkout capture failed", orderId: order.id, paypalOrderId, issue }));
    if (issue === "INSTRUMENT_DECLINED") {
      throw new CheckoutError("INSTRUMENT_DECLINED", "PayPal declined that payment method. Please try another.", 422);
    }
    throw new CheckoutError("PAYPAL_ERROR", "PayPal couldn't complete the payment. Please try again.", 502);
  }

  // The amount was set by us when the order was created; anything else means the order isn't ours.
  if (captured.amountCents !== order.pricePaidCents || captured.currency !== order.currency) {
    await db.update(schema.orders).set({ status: "failed" }).where(eq(schema.orders.id, order.id));
    console.error(
      JSON.stringify({ msg: "checkout amount mismatch", orderId: order.id, expected: order.pricePaidCents, captured: captured.amountCents }),
    );
    throw new CheckoutError("AMOUNT_MISMATCH", "The captured amount doesn't match the order", 409);
  }

  const status = captureStatus(captured.captureStatus);
  const [updated] = await db
    .update(schema.orders)
    .set({
      paypalCaptureId: captured.captureId,
      status,
      buyerEmail: captured.payerEmail,
      capturedAt: status === "failed" ? null : new Date(),
    })
    .where(and(eq(schema.orders.id, order.id), isNull(schema.orders.paypalCaptureId)))
    .returning();
  console.log(
    JSON.stringify({ msg: "checkout order captured", orderId: order.id, paypalOrderId, captureId: captured.captureId, captureStatus: captured.captureStatus }),
  );
  if ((updated?.status ?? status) === "completed") await enrolSafely(order.id);
  return { orderId: order.id, status: updated?.status ?? status, captureId: captured.captureId };
}

// Price protection starts at capture. A failure here must not fail the payment: it's logged, and the
// PayPal capture webhook (or `npm run protection:backfill`) enrols the order again.
export async function enrolSafely(orderId: string) {
  try {
    await enrolProtection(orderId);
  } catch (err) {
    console.error(JSON.stringify({ msg: "protection enrolment failed", orderId, error: String(err) }));
  }
}

// A verified PAYMENT.CAPTURE.COMPLETED fills in an order the capture route didn't finish (the buyer
// closed the tab, or the capture came back PENDING). Returns the order ID it updated, if any.
export async function reconcileCaptureCompleted(capture: {
  id: string;
  amountCents: number;
  currency: string;
  paypalOrderId: string;
  capturedAt: Date;
}): Promise<string | null> {
  const db = getDb();
  const o = schema.orders;
  const [updated] = await db
    .update(o)
    .set({ paypalCaptureId: capture.id, status: "completed", capturedAt: capture.capturedAt })
    .where(
      and(
        eq(o.paypalOrderId, capture.paypalOrderId),
        inArray(o.status, ["created", "approved"]),
        or(isNull(o.paypalCaptureId), eq(o.paypalCaptureId, capture.id)),
        eq(o.pricePaidCents, capture.amountCents),
        eq(o.currency, capture.currency),
      ),
    )
    .returning({ id: o.id });
  return updated?.id ?? null;
}
