// Recorded PayPal webhook deliveries (fixtures/paypal/webhooks/) as the route receives them: headers
// plus the raw body. For tests and the replay script.
import { listFixtures, loadFixture } from "./fixtures";

type RecordedDelivery = {
  headers: Record<string, string>;
  verification: { verified: boolean };
  event: { id: string; event_type: string; resource?: { id?: string } };
};

export type Delivery = {
  name: string;
  headers: Headers;
  // The fixture keeps the parsed event; PayPal's compact JSON re-serialises to the same bytes
  // (the length matches the recorded content-length).
  rawBody: string;
  event: RecordedDelivery["event"];
  recordedVerification: boolean;
};

// Only PayPal's own headers: the rest (host, ngrok forwarding) belonged to the Phase 0 tunnel.
const PAYPAL_HEADERS = /^(paypal-|content-type$|correlation-id$|user-agent$)/;

export function paypalDeliveries(): Delivery[] {
  return listFixtures("paypal/webhooks").map((file) => {
    const recorded = loadFixture<RecordedDelivery>(`paypal/webhooks/${file}`);
    const headers = new Headers(Object.entries(recorded.headers).filter(([k]) => PAYPAL_HEADERS.test(k)));
    return {
      name: file.replace(/\.json$/, ""),
      headers,
      rawBody: JSON.stringify(recorded.event),
      event: recorded.event,
      recordedVerification: recorded.verification.verified,
    };
  });
}

export function paypalDelivery(eventType: string): Delivery {
  const delivery = paypalDeliveries().find((d) => d.event.event_type === eventType);
  if (!delivery) throw new Error(`No recorded PayPal delivery for ${eventType}`);
  return delivery;
}

export function recordedContentLength(name: string): number {
  return Number(loadFixture<RecordedDelivery>(`paypal/webhooks/${name}`).headers["content-length"]);
}
