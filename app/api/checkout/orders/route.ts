import { z } from "zod";
import { checkoutErrorResponse, createCheckoutOrder } from "@/lib/checkout";

// Only the product (and, for a price match, the match request) is accepted: the amount comes from the database.
const body = z.object({ productSlug: z.string().min(1).max(200), matchRequestId: z.uuid().optional() });

// POST /api/checkout/orders {productSlug, matchRequestId?} -> {orderId, paypalOrderId}
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "BAD_REQUEST", message: "Expected {productSlug}" }, { status: 400 });
  try {
    return Response.json(await createCheckoutOrder(parsed.data.productSlug, parsed.data.matchRequestId), { status: 201 });
  } catch (err) {
    return checkoutErrorResponse(err);
  }
}
