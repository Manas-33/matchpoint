import { eq } from "drizzle-orm";
import { captureCheckoutOrder } from "@/lib/checkout";
import { getDb, schema } from "@/lib/db";
import { getEnv } from "@/lib/env";

// GET /api/checkout/return?orderId=...&token=<PayPal order ID>
// Where PayPal sends the buyer after they approve an order a shopping agent created (the approval link
// from the MCP tool `request_price_match`). Captures the payment, then shows the order page.
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const orderId = params.get("orderId") ?? "";
  const token = params.get("token");
  const appUrl = getEnv().APP_URL;
  const [order] = /^[0-9a-f-]{36}$/i.test(orderId)
    ? await getDb().select().from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1)
    : [];
  if (!order) return Response.redirect(`${appUrl}/`, 303);
  // PayPal adds the order's own ID as `token`; anything else isn't a return from this order's approval.
  if (token === order.paypalOrderId && !order.paypalCaptureId) {
    try {
      await captureCheckoutOrder(order.paypalOrderId);
    } catch (err) {
      console.error(JSON.stringify({ msg: "agent checkout return: capture failed", orderId, error: String(err) }));
    }
  }
  return Response.redirect(`${appUrl}/orders/${order.id}`, 303);
}
