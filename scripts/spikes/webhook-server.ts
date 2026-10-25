// Phase 0 webhook receiver for PayPal and Channel3, run behind a tunnel.
//   POST /paypal/webhook    verifies the signature with PayPal, saves the event
//   POST /channel3/webhook  saves the raw price.changed payload (verifies if signed)
// Usage: npm run spike:webhooks   then   cloudflared tunnel --url http://localhost:8787
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { parse } from "dotenv";
import { OAuthAuthorizationController } from "@paypal/paypal-server-sdk";
import "./lib/env.js";
import { PAYPAL_API, paypalClient } from "./lib/paypal.js";
import { saveFixture, slug } from "./lib/fixtures.js";

const PORT = Number(process.env.WEBHOOK_PORT ?? 8787);

const header = (h: IncomingHttpHeaders, name: string) => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

async function paypalAccessToken(): Promise<string> {
  const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
  const oauth = new OAuthAuthorizationController(paypalClient());
  const res = await oauth.requestToken({
    authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
  });
  return res.result.accessToken;
}

// PayPal's verify endpoint re-hashes webhook_event, so we splice in the raw body
// instead of re-serialising the parsed JSON (key order or number formatting could differ).
async function verifyPaypal(headers: IncomingHttpHeaders, rawBody: string) {
  // Re-read .env so the webhook ID can be added while the receiver is running.
  const webhookId = (existsSync(".env") && parse(readFileSync(".env")).PAYPAL_WEBHOOK_ID) || process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return { verified: false, reason: "PAYPAL_WEBHOOK_ID not set" };
  const fields = {
    auth_algo: header(headers, "paypal-auth-algo"),
    cert_url: header(headers, "paypal-cert-url"),
    transmission_id: header(headers, "paypal-transmission-id"),
    transmission_sig: header(headers, "paypal-transmission-sig"),
    transmission_time: header(headers, "paypal-transmission-time"),
    webhook_id: webhookId,
  };
  const body = `${JSON.stringify(fields).slice(0, -1)},"webhook_event":${rawBody}}`;
  const res = await fetch(`${PAYPAL_API}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await paypalAccessToken()}` },
    body,
  });
  const json = (await res.json()) as { verification_status?: string };
  return { verified: json.verification_status === "SUCCESS", http_status: res.status, response: json };
}

// Channel3 doesn't document webhook signing yet. If the request carries Svix /
// Standard Webhooks headers and a secret is configured, check them; otherwise just record.
function verifyChannel3(headers: IncomingHttpHeaders, rawBody: string) {
  const id = header(headers, "svix-id") ?? header(headers, "webhook-id");
  const ts = header(headers, "svix-timestamp") ?? header(headers, "webhook-timestamp");
  const sigs = header(headers, "svix-signature") ?? header(headers, "webhook-signature");
  const secret = process.env.CHANNEL3_WEBHOOK_SECRET;
  if (!id || !ts || !sigs) return { verified: null, reason: "no Svix/Standard Webhooks signature headers" };
  if (!secret) return { verified: null, reason: "signed, but CHANNEL3_WEBHOOK_SECRET not set" };
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest();
  const verified = sigs.split(" ").some((s) => {
    const given = Buffer.from(s.split(",")[1] ?? "", "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return { verified, scheme: "svix-hmac-sha256" };
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const receivedAt = new Date().toISOString();
    try {
      if (req.method === "POST" && req.url === "/paypal/webhook") {
        const event = JSON.parse(rawBody);
        const verification = await verifyPaypal(req.headers, rawBody);
        console.log(`[paypal] ${event.event_type} ${event.id} verified=${verification.verified}`);
        saveFixture(`paypal/webhooks/${slug(event.event_type)}-${event.id}`, {
          received_at: receivedAt,
          headers: req.headers,
          verification,
          event,
        });
        res.writeHead(200).end();
      } else if (req.method === "POST" && req.url === "/channel3/webhook") {
        let event: { type?: string } | string;
        try {
          event = JSON.parse(rawBody);
        } catch {
          event = rawBody;
        }
        const type = typeof event === "object" && event?.type ? event.type : "unknown";
        const verification = verifyChannel3(req.headers, rawBody);
        console.log(`[channel3] ${type} verified=${verification.verified}`);
        saveFixture(`channel3/webhooks/${slug(type)}-${receivedAt.replace(/[:.]/g, "-")}`, {
          received_at: receivedAt,
          headers: req.headers,
          verification,
          raw_body: rawBody,
          event,
        });
        res.writeHead(200).end();
      } else {
        res.writeHead(200, { "Content-Type": "text/plain" }).end("matchpoint webhook spike\n");
      }
    } catch (err) {
      console.error(err);
      res.writeHead(500).end();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Webhook receiver on http://localhost:${PORT}`);
  console.log("  POST /paypal/webhook    POST /channel3/webhook");
});
