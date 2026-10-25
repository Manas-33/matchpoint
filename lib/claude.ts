// Claude judges whether two listings are the same product and explains decisions. It never does money
// maths or approves anything: deterministic code combines its judgment with the policy checks.
// Ported from scripts/spikes/claude-same-product.ts. Demo mode serves the judgments in fixtures/claude/.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Channel3Api } from "@channel3/sdk";
import { z } from "zod";
import { getEnv } from "./env";
import { listFixtures, loadFixture } from "./fixtures";

export const SameProductDecision = z.object({
  same_product: z.boolean().describe("Both listings are the same manufacturer product (same model)."),
  variant_match: z.boolean().describe("Size, colour, capacity and other variant options match."),
  condition_ok: z.boolean().describe("The competitor offer is new, not used/refurbished/open-box."),
  bundle_or_accessory: z
    .boolean()
    .describe("Either listing is a bundle, multipack, accessory or part rather than the product itself."),
  model_year_mismatch: z.boolean().describe("The listings are different generations or model years."),
  confidence: z.number().describe("0 to 1: how sure you are about same_product and variant_match together."),
  reasons: z
    .array(
      z.object({
        listing: z.enum(["shop", "competitor", "both"]),
        field: z
          .string()
          .describe("The listing field this reason cites, e.g. title, variants.selected, offers[0].condition."),
        observation: z.string(),
      }),
    )
    .describe("Each reason cites a field from one or both listings."),
  customer_message: z.string().describe("One or two plain sentences for the shopper explaining the outcome."),
});
export type SameProductDecision = z.infer<typeof SameProductDecision>;

// A listing as Claude sees it: the Channel3 product plus the URL it came from (a retailer link,
// or `channel3:<id>` for the shop's own catalog product).
export type Listing = { url: string; product: Channel3Api.Product };

export type JudgmentResult =
  | { outcome: "ok"; decision: SameProductDecision; model: string; usage?: unknown }
  // No usable judgment (refusal, schema failure, nothing recorded in demo mode): send to staff review.
  | { outcome: "review"; reason: string; model: string; details?: unknown };

const SYSTEM = `You verify price-match requests for an independent shop.
You get two product listings from Channel3: the shop's own listing and a competitor's listing.
Judge only whether they are the same product, the same variant, and an acceptable condition, and flag bundles, accessories and model-year differences.
Do not decide prices, discounts or whether the match is approved: deterministic code does that.
Every reason must cite a specific field of a listing. When data is missing or ambiguous, say so and lower your confidence.`;

// Only the fields that bear on identity; prices and URLs stay for context but the model never computes with them.
export function toPromptListing({ url, product: p }: Listing) {
  const host = url.startsWith("http") ? new URL(url).hostname.replace(/^www\./, "") : null;
  const offers = (p.offers ?? []).map((o) => ({
    domain: o.domain,
    price: o.price,
    availability: o.availability,
    condition: o.condition ?? null,
  }));
  return {
    url,
    // The offer at the store the link points to; the others are the same canonical product elsewhere.
    linked_offer: host ? (offers.find((o) => o.domain === host) ?? null) : null,
    canonical_product_id: p.id,
    title: p.title,
    brands: p.brands,
    category: p.category,
    description: p.description,
    key_features: p.key_features,
    colors: p.colors,
    variants: p.variants,
    structured_attributes: p.structured_attributes,
    offers,
  };
}

export interface ClaudeService {
  readonly mode: "live" | "demo";
  judgeSameProduct(shop: Listing, competitor: Listing): Promise<JudgmentResult>;
}

function liveClaude(apiKey: string, model: string): ClaudeService {
  const client = new Anthropic({ apiKey });
  return {
    mode: "live",
    async judgeSameProduct(shop, competitor) {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "high", format: betaZodOutputFormat(SameProductDecision) },
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: `<shop_listing>\n${JSON.stringify(toPromptListing(shop), null, 2)}\n</shop_listing>\n\n<competitor_listing>\n${JSON.stringify(toPromptListing(competitor), null, 2)}\n</competitor_listing>`,
          },
        ],
      });
      if (response.stop_reason === "refusal") {
        return { outcome: "review", reason: "refusal", model: response.model, details: response.stop_details };
      }
      const check = SameProductDecision.safeParse(response.parsed_output);
      if (!check.success) {
        return { outcome: "review", reason: "invalid structured output", model: response.model, details: check.error.issues };
      }
      return { outcome: "ok", decision: check.data, model: response.model, usage: response.usage };
    },
  };
}

type RecordedJudgment = {
  model: string;
  shop_fixture: string;
  competitor_fixture: string;
  outcome: string;
  decision: SameProductDecision | null;
  usage?: unknown;
};

// Recorded judgments keyed by (shop product ID, competitor URL), built from fixtures/claude/*.json.
function recordedJudgments() {
  const byKey = new Map<string, RecordedJudgment>();
  for (const file of listFixtures("claude")) {
    const rec = loadFixture<RecordedJudgment>(`claude/${file}`);
    const shop = loadFixture<Listing>(rec.shop_fixture.replace(/^fixtures\//, ""));
    const competitor = loadFixture<Listing>(rec.competitor_fixture.replace(/^fixtures\//, ""));
    byKey.set(`${shop.product.id} ${competitor.url}`, rec);
  }
  return byKey;
}

function demoClaude(): ClaudeService {
  let index: Map<string, RecordedJudgment> | undefined;
  return {
    mode: "demo",
    async judgeSameProduct(shop, competitor) {
      index ??= recordedJudgments();
      const rec = index.get(`${shop.product.id} ${competitor.url}`);
      if (!rec?.decision) {
        return { outcome: "review", reason: "demo mode: no recorded judgment for this pair", model: "demo" };
      }
      return { outcome: "ok", decision: SameProductDecision.parse(rec.decision), model: rec.model, usage: rec.usage };
    },
  };
}

let service: ClaudeService | undefined;

export function getClaude(): ClaudeService {
  if (!service) {
    const env = getEnv();
    service = env.DEMO_MODE ? demoClaude() : liveClaude(env.ANTHROPIC_API_KEY!, env.ANTHROPIC_MODEL);
  }
  return service;
}
