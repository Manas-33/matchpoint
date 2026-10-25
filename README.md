# Matchpoint

**An AI pricing agent for independent shops.** It matches a competitor's price at checkout and protects the customer if the price drops after the sale. Every decision is checked against real product data from [Channel3](https://docs.trychannel3.com) and settled in [PayPal](https://developer.paypal.com).

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com). The product is described in [IDEA.md](IDEA.md) and the build plan in [PLAN.md](PLAN.md).

> **Status:** project scaffold (Phase 1). The shop, checkout, match engine and price protection come in later phases.

## How it works

- **Match at checkout:** a customer pastes a competitor's link. Matchpoint resolves it with Channel3, checks it's the same product, variant and condition at an approved store, applies the shop's policy, and either creates a PayPal order at the matched price or declines with a reason.
- **Protect after the sale:** when an approved store drops its price within the protection window, Matchpoint issues a PayPal partial refund automatically (up to a cap) and emails the customer an evidence card.

Money maths and policy checks run in plain code, with amounts as integer cents. Claude only judges whether two listings are the same product and writes explanations.

## Tech stack

| Area | Choice |
|---|---|
| App | Next.js 16 (App Router, TypeScript), Tailwind CSS |
| Database | Postgres with Drizzle ORM; money as integer cents, rates as basis points |
| Payments | PayPal Orders v2 and Refunds via [`@paypal/paypal-server-sdk`](https://github.com/paypal/PayPal-TypeScript-Server-SDK) (APIMatic-generated), sandbox only |
| Product data | Channel3 via [`@channel3/sdk`](https://docs.trychannel3.com): lookup, search, price history and tracking, Collections |
| AI | Claude via `@anthropic-ai/sdk`, structured outputs (model set by `ANTHROPIC_MODEL`, default `claude-sonnet-5-5`) |
| Email | Resend, or logged to the console without a key |
| Tests | Vitest, with recorded fixtures |

## Setup

You need Node.js 22.12 or later and Docker (for local Postgres).

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in the sandbox keys in `.env` (PayPal, Channel3, Anthropic), or set `DEMO_MODE=true` to run without any keys. Then start Postgres, create the tables and seed the shop:

```bash
npm run db:up
```

```bash
npm run db:migrate
```

```bash
npm run seed
```

```bash
npm run dev
```

Open http://localhost:3000. The home page shows the run mode, the seeded catalog and the active policy.

### Demo mode

With `DEMO_MODE=true`, Channel3, PayPal and Claude calls are answered from the recorded responses in [`fixtures/`](fixtures) and email is only logged, so the app works with no API keys and no network access to those services. Use the demo variants of the commands:

```bash
npm run seed:demo
```

```bash
npm run dev:demo
```

The environment is validated at startup ([`lib/env.ts`](lib/env.ts)): live mode refuses to start without the PayPal, Channel3 and Anthropic keys, and says which one is missing.

### Seed data

`npm run seed` stores 12 Channel3 catalog products with complete variant data, each with a shop price (the median current price, ending in .99) and a unit cost. It creates the "Matchpoint approved stores" Collection in Channel3 and the default policy (version 1): 18 approved stores, 15% margin floor, 20% maximum discount, 14-day protection window, automatic refunds up to $50.

The chosen product IDs are in [`fixtures/seed/catalog.json`](fixtures/seed/catalog.json), so live and demo mode seed the same catalog. `npm run seed -- --pick` re-checks the chosen products against live Channel3 data and replaces any that no longer qualify (delete `fixtures/seed/catalog.json` to choose all of them from scratch). `--record` refreshes the recorded fixtures, and `--reset` empties every table first. Condition (New / Used) never counts as variant data. Re-running the seed is safe: products are upserted and an existing policy is never overwritten.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `npm run dev:demo` | Start the app in live or demo mode |
| `npm run build` / `npm start` | Production build and server |
| `npm test` | Unit tests (Vitest), no network or keys needed |
| `npm run lint` / `npm run typecheck` | ESLint and TypeScript |
| `npm run db:up` / `npm run db:down` | Start or stop local Postgres (Docker, port 5433) |
| `npm run db:generate` / `npm run db:migrate` | Generate a migration from `lib/db/schema.ts` / apply migrations |
| `npm run seed` / `npm run seed:demo` | Seed the shop from Channel3 or from fixtures |
| `npm run spike:*` | Phase 0 proof-of-concept tests (see [`scripts/spikes/`](scripts/spikes/README.md)) |

## Project layout

```
app/                 Next.js App Router pages
lib/env.ts           Environment validation (Zod)
lib/db/              Drizzle schema and client; migrations are in drizzle/
lib/paypal.ts        Orders, captures, partial refunds, webhook verification
lib/channel3.ts      Lookup, search, price history, tracking, Collections, webhook verification
lib/claude.ts        Same-product judgment (structured output)
lib/email.ts         Evidence emails (Resend or log)
lib/money.ts         Integer-cents helpers
lib/catalog.ts       Catalog rules and shop pricing
lib/policy.ts        Default policy and approved stores
scripts/seed.ts      npm run seed
scripts/spikes/      Phase 0 proof-of-concept tests and findings
fixtures/            Recorded API responses (secrets redacted), used by demo mode and tests
```

## Architecture

_To come: diagram of the match engine, protection evaluator, PayPal webhooks and ledger._

## Evaluation

_To come: match precision and recall, false-match and false-refund rates on a labelled test set._

## Known limits

- Price protection covers products that Channel3 can verify and track.
- PayPal runs in the sandbox only.

## License

[MIT](LICENSE)
