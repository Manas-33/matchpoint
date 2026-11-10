import { captureCheckoutOrder, checkoutErrorResponse } from "@/lib/checkout";

// POST /api/checkout/orders/:paypalOrderId/capture -> {orderId, status, captureId}
export async function POST(_req: Request, { params }: RouteContext<"/api/checkout/orders/[paypalOrderId]/capture">) {
  const { paypalOrderId } = await params;
  try {
    return Response.json(await captureCheckoutOrder(paypalOrderId));
  } catch (err) {
    return checkoutErrorResponse(err);
  }
}
