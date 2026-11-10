import { enrolSafely, reconcileCaptureCompleted } from "@/lib/checkout";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { dbLedgerStore, handlePayPalWebhook } from "@/lib/ledger";
import { getPayPal } from "@/lib/paypal";

// PayPal webhook endpoint (register https://<public host>/api/webhooks/paypal on the sandbox app).
export async function POST(req: Request) {
  // The raw body, unparsed: PayPal's signature check re-hashes it byte for byte.
  const rawBody = await req.text();
  const transmissionId = req.headers.get("paypal-transmission-id");
  try {
    const outcome = await handlePayPalWebhook(req.headers, rawBody, {
      verify: (headers, body) => getPayPal().verifyWebhookSignature(headers, body),
      store: dbLedgerStore(getDb()),
      onCaptureCompleted: async (capture) => {
        const orderId = await reconcileCaptureCompleted(capture);
        if (orderId) console.log(JSON.stringify({ msg: "paypal webhook reconciled order", orderId, captureId: capture.id }));
        // Enrol the captured order in price protection (idempotent; covers a capture route that died).
        const [order] = await getDb()
          .select({ id: schema.orders.id })
          .from(schema.orders)
          .where(eq(schema.orders.paypalCaptureId, capture.id));
        if (order) await enrolSafely(order.id);
      },
    });
    console.log(JSON.stringify({ msg: "paypal webhook", transmissionId, ...outcome }));
    return Response.json({ result: outcome.result }, { status: outcome.status });
  } catch (err) {
    console.error(JSON.stringify({ msg: "paypal webhook failed", transmissionId, error: String(err) }));
    return Response.json({ result: "error" }, { status: 500 });
  }
}
