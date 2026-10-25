# Matchpoint: build plan

The steps to build Matchpoint, in order. No timeline; each phase ends with a **Done when** check. The product description is in [IDEA.md](IDEA.md).

---

## Architecture at a glance

```
Customer / staff ──► Next.js app ─┬─► Match engine ──► Channel3 (lookup, offers, history, similar)
                                  │        │
                                  │        └──► Claude (same-product judgment, explanations)
                                  │
                                  ├─► Checkout ──► PayPal (Orders: create / capture)
                                  │
Channel3 price.changed ──────────►├─► Protection evaluator ──► PayPal (partial refund) ──► Evidence email
Daily price-history poll ────────►│
                                  │
PayPal webhooks ─────────────────►└─► Ledger (verified events)  ◄── Merchant console (policy, approvals, ledger)
```

**Rule of thumb:** money maths and policy checks run in deterministic code. Claude only judges whether two listings are the same product and writes explanations.

## Tech stack (defaults)

| Area | Choice |
|---|---|
| App | Next.js (App Router, TypeScript), server routes for all API calls |
| Database | Postgres (Neon or Supabase) with Drizzle ORM; all money stored as integer cents |
| PayPal | `@paypal/paypal-server-sdk` (APIMatic-generated) for Orders and refunds; PayPal JS SDK buttons on checkout; REST call for webhook signature verification |
| Channel3 | `@channel3/sdk` (REST): `lookup`, offers, price history, price tracking, Collections, `similar` |
| AI | `@anthropic-ai/sdk` with `claude-opus-5-5`, effort set explicitly. Structured outputs (`messages.parse()` with a Zod schema) for every decision. Enable server-side refusal fallbacks; if a request still ends in `refusal`, send the item to human review |
| Email | Resend, with a log-only fallback in development |
| Jobs | Hosting platform cron for the daily price-history poll |
| Agent access (later) | `@modelcontextprotocol/sdk` server over Streamable HTTP |
| Tests | Vitest, with recorded fixtures for Channel3 and Claude calls |
| Local webhooks | cloudflared or ngrok tunnel |

## Data model

| Table | Key fields |
|---|---|
| `products` | Channel3 canonical product ID, title, variant, image, shop price, unit cost |
| `policies` | approved domains, Channel3 collection ID, margin floor %, max discount %, protection days, auto-refund cap. Each change creates a new version |
| `match_requests` | product, competitor URL, lookup snapshot, history stats, model output, decision (`match` / `decline` / `review`), reasons, matched price, policy version |
| `orders` | PayPal order ID, capture ID, product, price paid, match request (if any), buyer email, status |
| `protections` | order, canonical product ID, window end, status |
| `price_events` | source (`webhook` / `poll` / `replay`), raw payload, product, store, new price, received at |
| `refunds` | protection, price event, amount, PayPal refund ID, status, decision reasons, approved by (`auto` / owner) |
| `ledger_events` | PayPal webhook event ID, type, resource ID, verified flag, raw payload |

---

## Phase 0: Accounts and proof-of-concept tests

1. **PayPal sandbox setup.** Create a business account and 2–3 personal buyer accounts. Create a standard merchant REST app, not a platform app.
2. **PayPal test.** Using the Server SDK: create and capture an order, then issue a partial refund on the capture. Set up a webhook through a tunnel and verify the signature of a real `PAYMENT.CAPTURE.COMPLETED` event.
3. **Channel3 access.** Get the API key and apply the hackathon credits.
4. **Channel3 lookup test.** Run `lookup` on 5 real competitor product URLs and save the responses as fixtures. Confirm the offer fields we rely on: price, availability, condition, domain, variants.
5. **Channel3 price-tracking test.** Start tracking 5–10 volatile catalog products (for example headphones, GPUs, running shoes). Configure the webhook endpoint and read the price-history endpoint. Save the first real `price.changed` payload as a fixture.
6. **Claude test.** Get a structured-output call working that compares two saved lookups and returns a schema-valid decision.
7. **Tooling.** Install the APIMatic Context Plugin for the PayPal Server SDK in Claude Code: `npx context-plugins install https://github.com/paypaldev/server-sdk-context-plugin-preview`.

**Done when:** each test works end to end and its responses are saved in `fixtures/`.

## Phase 1: Project scaffold

1. Create the Next.js TypeScript app with lint, Vitest, and environment validation (Zod). Add `.env.example`.
2. Add Postgres and Drizzle. Write the schema and migrations for the tables above.
3. Write one client module per service (`lib/paypal.ts`, `lib/channel3.ts`, `lib/claude.ts`, `lib/email.ts`). Each has a demo mode that serves recorded fixtures.
4. **Seed script.** Pick about 12 products from Channel3's catalog that have complete variant data. Store each with a shop price and unit cost. Create the default policy and the approved-stores Collection through the Channel3 API.
5. Add `LICENSE` (MIT) and a README skeleton.

**Done when:** `npm run seed` fills the database, and the app boots locally in both live and demo mode.

## Phase 2: Shop and checkout

1. Build the catalog page and a product page with a "Found it cheaper?" box.
2. Build the checkout with PayPal JS SDK buttons. Add server routes to create and capture the order. The price always comes from the server, never the browser.
3. Add the PayPal webhook endpoint. Verify every event's signature, record `PAYMENT.CAPTURE.COMPLETED` and `PAYMENT.CAPTURE.REFUNDED` in the ledger, and ignore duplicate deliveries by checking the event ID.

**Done when:** a sandbox buyer can buy a product at list price, and the ledger shows the verified capture event.

## Phase 3: Match engine (Act 1)

1. Add a `POST /api/match` route taking `{productId, competitorUrl}`.
2. **Resolve the competitor listing** with Channel3 `lookup`. If the URL isn't a product page, extraction fails, or the product isn't in Channel3's catalog, return "couldn't verify — sent for staff review".
3. **Run deterministic checks in code:**
   - the store is approved;
   - the offer is in stock and new;
   - the competitor's price is lower than ours;
   - the matched price stays above the margin floor and within the maximum discount.
4. **Run a price-history check.** Use the history statistics and `current_status` to refuse matching a short-lived glitch (the policy decides: match the typical price, or decline).
5. **Get Claude's same-product judgment** as structured output. The fields are:
   - `same_product`, `variant_match`, `condition_ok`;
   - flags for `bundle_or_accessory` and `model_year_mismatch`;
   - `confidence`;
   - `reasons[]`, each citing a field from one of the two listings;
   - a short `customer_message`.

   Code combines this with the deterministic checks to make the final decision. A refusal or low confidence goes to review.
6. **Act on the decision:**
   - **Match:** create a PayPal order at the matched price, with the match ID in the order description or `invoice_id`, and show the decision card.
   - **Decline:** show the reason, plus alternatives from Channel3 `similar`, filtered to products the shop stocks.
7. **Save the evidence** for every request: lookup snapshot, history stats, model output and policy version.

**Done when:** three scripted cases behave correctly: a valid match that gets paid, a bundle that's declined, and a one-day price glitch that's declined.

## Phase 4: Price protection (Act 2)

1. **On capture,** create a protection record with its window end date, and start Channel3 tracking for that product if it isn't tracked already.
2. **Receive Channel3 price changes.** Add a `price.changed` webhook receiver that stores the raw payload and verifies its signature if Channel3 signs events.
3. **Add a daily poll** over active protections using the price-history endpoint, as a fallback when no webhook arrives.
4. **Add a replay action** in the console that re-injects a recorded real payload. It's clearly marked "replay" in the UI and the ledger.
5. **Write the evaluator.** For each price event, it:
   - finds active protections for that product;
   - confirms the store is approved, the offer is in stock, and it's the same canonical product;
   - computes the difference;
   - applies the policy: refund automatically under the cap, queue for the owner above it, and skip drops below a minimum;
   - issues at most one refund per order per price drop.
6. **Issue the refund.** Use a partial refund on the capture, with `note_to_payer` and a stable `PayPal-Request-Id` (protection ID + event ID) so a retry can't pay twice. Save it, and match it to the `PAYMENT.CAPTURE.REFUNDED` webhook in the ledger.
7. **Send the evidence card** as a web page and an email: both prices, timestamps, a price-history sparkline, the refund amount and the PayPal refund ID. Claude writes the short explanation as structured output.

**Done when:** a replayed price drop leads to a sandbox refund, the evidence email, and a verified refund event in the ledger. Replaying the same event again does nothing.

## Phase 5: Merchant console

1. **Policy page:** approved stores (kept in sync with the Channel3 Collection), margin floor, maximum discount, protection window, and auto-refund cap.
2. **Approvals queue** for refunds above the cap and for matches sent to review. Approving runs the action; rejecting records a note.
3. **Ledger page:** orders, matches, protections, refunds and PayPal events, each with a "verified" badge.
4. **Decision log:** the reasons and evidence behind each match and refund.
5. **"Sales covered vs refunds paid" tile:** protected sales and revenue compared with total refunds paid out.

**Done when:** the owner changes the policy and the next decision follows the new rules, with the policy version recorded.

## Phase 6: Quality and evaluation

1. **Build a labelled test set** of competitor-link pairs with known answers. Include hard negatives: bundles, last year's model, a different colour, used listings, marketplace sellers, out of stock.
2. **Write an eval script** that runs the match engine over the set and reports match precision and recall plus the false-match rate. Do the same for the refund evaluator, reporting the false-refund rate.
3. **Write unit tests** for the money maths and policy rules (integer cents), refund de-duplication, and webhook signature verification.
4. **Record and replay** the Claude and Channel3 calls so tests run in CI without network access or API keys.

**Done when:** the eval metrics are published in the README and CI passes.

## Phase 7: Reliability and demo mode

1. **Demo mode** (env flag) serves recorded Channel3 responses and replayed events, so the full flow works even if the API or credits fail.
2. **Error handling:**
   - Channel3 `429`: honour `Retry-After`.
   - PayPal: retry transient errors.
   - Claude errors or refusals: send the item to the review queue, never to an automatic action.
3. **Cache** lookups and price history per product per day to save credits.
4. **Logging:** a structured log entry for every decision. The ledger doubles as the audit trail.

**Done when:** the full demo runs end to end with live Channel3 access switched off.

## Phase 8 (next): Shopper-agent access over MCP

1. Run an MCP server over Streamable HTTP with two tools:
   - `request_price_match` (product, competitor URL, buyer email). It returns the decision and a PayPal approval link.
   - `get_match_status`.
2. Give each calling agent its own API key, and rate-limit requests.
3. Test it from a real shopper agent, such as Claude Desktop with the MCP server added.

**Done when:** an external agent requests a match and gets back a ready-to-pay PayPal order.

## Phase 9 (next): Public API and SDK

1. Write an OpenAPI spec for `verify-match`, `create-matched-order` and `enroll-protection`.
2. Generate SDKs, a docs portal and a Context Plugin from the spec with APIMatic.
3. Add an example snippet for adding Matchpoint to an existing storefront.

**Done when:** a sample storefront calls Matchpoint through the generated SDK.

## Phase 10: Ship

1. **Deploy** to Vercel or Fly with managed Postgres, the daily cron job, and environment variables. Register the public webhook URLs with PayPal and Channel3.
2. **Keep it running** through the evaluation period: always-on hosting, active keys and credits, and a working demo mode.
3. **Write the README:** what it is, an architecture diagram, setup in under 10 minutes (seed plus demo mode), the sandbox buyer login, every tool used, eval results, and known limits (catalog coverage, replayed events).
4. **Record the demo video:** under 3 minutes, public on YouTube.
5. **Submit on Devpost:** description, tools used, repo link, video, and demo URL.
6. **Final checks:**
   - `git status --ignored` shows `notes/` as ignored;
   - the license is detected on the repo page;
   - a commission disclosure appears next to any Channel3 buy links;
   - no retailer logos appear in the video.
