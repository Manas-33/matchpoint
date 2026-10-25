# Phase 0 spikes

Throwaway proof-of-concept tests for the three services. Each saves real responses to `fixtures/`.
Copy `.env.example` to `.env` and fill in sandbox/test keys first. A script with a missing key exits with `BLOCKED: set … in .env`.

| Command | Needs | What it proves |
|---|---|---|
| `npm run spike:paypal` | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Server SDK: create order → buyer approves in sandbox → capture → partial refund |
| `npm run spike:webhooks` | `PAYPAL_WEBHOOK_ID` (+ optional `CHANNEL3_WEBHOOK_SECRET`) | Receives `/paypal/webhook` (signature verified with PayPal) and `/channel3/webhook` (raw `price.changed`) |
| `npm run spike:c3:lookup` | `CHANNEL3_API_KEY` | `lookup` on real retailer URLs; checks price, availability, condition, domain, variants |
| `npm run spike:c3:track` | `CHANNEL3_API_KEY` | Starts tracking 5–10 catalog products, lists subscriptions, reads price history |
| `npm run spike:claude` | `ANTHROPIC_API_KEY`, lookup fixtures | Structured-output same-product decision on two saved lookups |

Order: lookup → track → claude. For webhooks, run the receiver and a tunnel in two terminals:

```bash
npm run spike:webhooks
```

```bash
cloudflared tunnel --url http://localhost:8787
```

Then register `https://<tunnel>/paypal/webhook` and `https://<tunnel>/channel3/webhook`. Quick-tunnel URLs change on every restart.

`spike:c3:lookup` and `spike:c3:track` accept explicit URLs / product IDs as arguments; `spike:paypal -- --order <id>` resumes an already-approved order.
