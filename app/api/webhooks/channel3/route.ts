import { handleChannel3Webhook } from "@/lib/channel3-webhook";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { processPriceEvent, recordPriceEvent } from "@/lib/price-protection";

// Channel3 price.changed endpoint (register https://<public host>/api/webhooks/channel3 in Channel3).
export async function POST(req: Request) {
  const rawBody = await req.text();
  const svixId = req.headers.get("svix-id");
  try {
    const outcome = await handleChannel3Webhook(req.headers, rawBody, {
      secret: getEnv().CHANNEL3_WEBHOOK_SECRET,
      record: (row) => recordPriceEvent(getDb(), row),
      process: (eventId) => processPriceEvent(eventId),
    });
    console.log(JSON.stringify({ msg: "channel3 webhook", svixId, ...outcome }));
    return Response.json({ result: outcome.result }, { status: outcome.status });
  } catch (err) {
    // Stored but not evaluated (or not stored): a 500 makes Svix redeliver, and evaluation is idempotent.
    console.error(JSON.stringify({ msg: "channel3 webhook failed", svixId, error: String(err) }));
    return Response.json({ result: "error" }, { status: 500 });
  }
}
