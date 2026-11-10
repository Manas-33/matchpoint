// Re-sends the recorded PayPal webhook deliveries (fixtures/paypal/webhooks/) to the app's webhook route,
// byte for byte with their original signature headers, to exercise verification and deduplication.
//
//   npm run webhooks:replay                      # to http://localhost:3000/api/webhooks/paypal
//   npm run webhooks:replay -- https://host/api/webhooks/paypal
//
// They were signed for the Phase 0 webhook, so they verify only while PAYPAL_WEBHOOK_ID is that webhook's
// ID; against any other webhook ID they are (correctly) stored unverified and refused.
import { paypalDeliveries } from "../lib/paypal-webhook-fixtures";

const target = process.argv[2] ?? "http://localhost:3000/api/webhooks/paypal";

for (const d of paypalDeliveries()) {
  const res = await fetch(target, { method: "POST", headers: d.headers, body: d.rawBody });
  const body = await res.json().catch(() => ({}));
  console.log(`${res.status}  ${d.event.event_type.padEnd(26)} ${d.event.id}  ${body.result ?? ""}`);
}
