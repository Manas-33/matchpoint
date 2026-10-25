// Phase 0 Claude test: compare two saved Channel3 lookups and return a schema-valid
// same-product judgment via structured outputs. Money maths stays out of the model.
// Usage: npm run spike:claude [-- <shop-lookup.json> <competitor-lookup.json>]
// With no args it runs every pair it can build from fixtures/channel3/lookup/:
// the same canonical product at two stores (expect a match) and two different products (expect no match).
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Channel3Api } from "@channel3/sdk";
import { requireEnv } from "./lib/env.js";
import { listFixtures, loadFixture, saveFixture } from "./lib/fixtures.js";

requireEnv("ANTHROPIC_API_KEY");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

export const SameProductDecision = z.object({
  same_product: z.boolean().describe("Both listings are the same manufacturer product (same model)."),
  variant_match: z.boolean().describe("Size, colour, capacity and other variant options match."),
  condition_ok: z.boolean().describe("The competitor offer is new, not used/refurbished/open-box."),
  bundle_or_accessory: z.boolean().describe("Either listing is a bundle, multipack, accessory or part rather than the product itself."),
  model_year_mismatch: z.boolean().describe("The listings are different generations or model years."),
  confidence: z.number().describe("0 to 1: how sure you are about same_product and variant_match together."),
  reasons: z
    .array(
      z.object({
        listing: z.enum(["shop", "competitor", "both"]),
        field: z.string().describe("The listing field this reason cites, e.g. title, variants.selected, offers[0].condition."),
        observation: z.string(),
      }),
    )
    .describe("Each reason cites a field from one or both listings."),
  customer_message: z.string().describe("One or two plain sentences for the shopper explaining the outcome."),
});
export type SameProductDecision = z.infer<typeof SameProductDecision>;

type LookupFixture = { url: string; product: Channel3Api.Product };

const SYSTEM = `You verify price-match requests for an independent shop.
You get two product listings from Channel3: the shop's own listing and a competitor's listing.
Judge only whether they are the same product, the same variant, and an acceptable condition, and flag bundles, accessories and model-year differences.
Do not decide prices, discounts or whether the match is approved: deterministic code does that.
Every reason must cite a specific field of a listing. When data is missing or ambiguous, say so and lower your confidence.`;

// Only the fields that bear on identity; prices and URLs stay for context but the model never computes with them.
function listing(fx: LookupFixture) {
  const p = fx.product;
  return {
    url: fx.url,
    canonical_product_id: p.id,
    title: p.title,
    brands: p.brands,
    category: p.category,
    description: p.description,
    key_features: p.key_features,
    colors: p.colors,
    variants: p.variants,
    structured_attributes: p.structured_attributes,
    offers: (p.offers ?? []).map((o) => ({
      domain: o.domain,
      price: o.price,
      availability: o.availability,
      condition: o.condition ?? null,
    })),
  };
}

async function judge(client: Anthropic, shop: LookupFixture, competitor: LookupFixture) {
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high", format: betaZodOutputFormat(SameProductDecision) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `<shop_listing>\n${JSON.stringify(listing(shop), null, 2)}\n</shop_listing>\n\n<competitor_listing>\n${JSON.stringify(listing(competitor), null, 2)}\n</competitor_listing>`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    return { outcome: "review" as const, reason: "refusal", stop_details: response.stop_details, response };
  }
  // parse() already validated against the schema; safeParse again so the test fails loudly if not.
  const check = SameProductDecision.safeParse(response.parsed_output);
  if (!check.success) {
    return { outcome: "invalid" as const, reason: check.error.message, response };
  }
  return { outcome: "ok" as const, decision: check.data, response };
}

function pairs(): { name: string; shop: string; competitor: string; expect?: boolean }[] {
  const args = process.argv.slice(2).filter((a) => a.endsWith(".json"));
  if (args.length === 2) return [{ name: "custom", shop: args[0], competitor: args[1] }];

  const files = listFixtures("channel3/lookup").map((f) => `channel3/lookup/${f}`);
  const byProduct = new Map<string, string[]>();
  for (const f of files) {
    const id = loadFixture<LookupFixture>(f).product.id;
    byProduct.set(id, [...(byProduct.get(id) ?? []), f]);
  }
  const out: { name: string; shop: string; competitor: string; expect?: boolean }[] = [];
  const same = [...byProduct.values()].find((fs) => fs.length >= 2);
  if (same) out.push({ name: "same-product", shop: same[0], competitor: same[1], expect: true });
  const distinct = [...byProduct.values()].map((fs) => fs[0]);
  if (distinct.length >= 2) out.push({ name: "different-product", shop: distinct[0], competitor: distinct[1], expect: false });
  return out;
}

async function main() {
  const todo = pairs();
  if (todo.length === 0) {
    console.error("BLOCKED: no lookup fixtures. Run `npm run spike:c3:lookup` first, or pass two lookup JSON paths.");
    process.exit(2);
  }
  const client = new Anthropic();
  let failures = 0;

  for (const pair of todo) {
    const shop = loadFixture<LookupFixture>(pair.shop.replace(/^fixtures\//, ""));
    const competitor = loadFixture<LookupFixture>(pair.competitor.replace(/^fixtures\//, ""));
    console.log(`\n[${pair.name}] ${shop.product.title}\n   vs ${competitor.product.title}`);
    const result = await judge(client, shop, competitor);
    saveFixture(`claude/${pair.name}`, {
      model: MODEL,
      shop_fixture: pair.shop,
      competitor_fixture: pair.competitor,
      outcome: result.outcome,
      decision: result.outcome === "ok" ? result.decision : null,
      stop_reason: result.response.stop_reason,
      usage: result.response.usage,
      content: result.response.content,
    });
    if (result.outcome !== "ok") {
      console.log(`  ${result.outcome}: ${result.reason}`);
      failures++;
      continue;
    }
    const d = result.decision;
    console.log(`  same_product=${d.same_product} variant_match=${d.variant_match} condition_ok=${d.condition_ok} bundle=${d.bundle_or_accessory} model_year_mismatch=${d.model_year_mismatch} confidence=${d.confidence}`);
    for (const r of d.reasons) console.log(`  - [${r.listing}.${r.field}] ${r.observation}`);
    console.log(`  customer: ${d.customer_message}`);
    if (pair.expect !== undefined && d.same_product !== pair.expect) {
      console.log(`  UNEXPECTED: expected same_product=${pair.expect}`);
      failures++;
    }
  }

  if (failures) process.exit(1);
  console.log("\nPASS: schema-valid same-product decisions from saved lookups.");
}

main().catch((err) => {
  if (err instanceof Anthropic.AuthenticationError) console.error("Anthropic: invalid API key");
  else if (err instanceof Anthropic.RateLimitError) console.error("Anthropic: rate limited, retry later");
  else if (err instanceof Anthropic.APIError) console.error(`Anthropic API error ${err.status}:`, err.message);
  else console.error(err);
  process.exit(1);
});
