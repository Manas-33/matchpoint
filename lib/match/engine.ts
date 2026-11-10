// The match engine (PLAN.md Phase 3): resolve the competitor link with Channel3, ask Claude whether it's
// the same product, check the price history, apply the shop's rules, and save the decision with its evidence.
import { eq, inArray } from "drizzle-orm";
import { getChannel3, Channel3RequestError, type Product as C3Product } from "../channel3";
import { getClaude, type JudgmentResult } from "../claude";
import { getDb, schema } from "../db";
import type { Product } from "../db/schema";
import { MissingFixtureError } from "../fixtures";
import { DEFAULT_VALUE_OFFERS, lowestMatchPriceCents } from "../policy";
import { getActivePolicy } from "../shop";
import { dollarsToCents, formatCents } from "../money";
import {
  domainOf,
  evaluateMatch,
  linkedOffer,
  summarizeHistory,
  unverifiedVerdict, type HistoryStats, type Verdict } from "./rules";
import { chooseValueOffer, VALUE_OFFER_CODE, type ValueOffer } from "./value-offer";

export type MatchStep = "lookup" | "compare" | "history" | "rules";
export const MATCH_STEPS: MatchStep[] = ["lookup", "compare", "history", "rules"];

export type Alternative = {
  slug: string;
  title: string;
  priceCents: number;
  imageUrl: string | null;
  // Channel3 `similar` returned the very product this page sells (a new one, from us).
  isThisProduct: boolean;
};

export type MatchResult = Verdict & {
  matchRequestId: string;
  productId: string;
  productSlug: string;
  shopPriceCents: number;
  currency: string;
  savingsCents: number | null;
  competitorUrl: string;
  competitorTitle: string | null;
  history: Pick<HistoryStats, "typicalCents" | "daysAtOrBelow" | "windowDays" | "currentStatus" | "series"> | null;
  alternatives: Alternative[];
  // Value match: offered before the cash match (null when no allowed alternative beats cash for the shop).
  valueOffer: ValueOffer | null;
  policyVersion: number;
  model: string | null;
  mode: "live" | "demo";
};

export class MatchError extends Error {
  constructor(
    readonly code: "PRODUCT_NOT_FOUND" | "NO_POLICY",
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "MatchError";
  }
}

const LOOKUP_FAILURE: Record<string, string> = {
  not_product_page: "that page isn't a product page",
  extraction_failed: "the store's page couldn't be read",
  not_found: "the product isn't in our product database",
  rate_limited: "the product database is busy",
  other: "the product database returned an error",
};

function lookupFailureReason(err: unknown): string {
  if (err instanceof Channel3RequestError) return LOOKUP_FAILURE[err.kind];
  if (err instanceof MissingFixtureError) return "demo mode only knows the recorded links";
  return "the lookup failed";
}

async function loadHistory(ids: string[], competitorPriceCents: number | null) {
  if (competitorPriceCents == null) return { stats: null, raw: null };
  const c3 = getChannel3();
  for (const id of ids) {
    try {
      const raw = await c3.priceHistory(id);
      const stats = summarizeHistory(raw, competitorPriceCents);
      if (stats) return { stats, raw: { canonical_product_id: id, statistics: raw.statistics } };
    } catch {
      // No history for this ID (non-catalog products can't be tracked): try the next.
    }
  }
  return { stats: null, raw: null };
}

// Channel3 `similar` for the competitor's product, kept to products the shop stocks.
async function findAlternatives(ids: string[], productId: string): Promise<Alternative[]> {
  const c3 = getChannel3();
  for (const id of ids) {
    const similar: C3Product[] = await c3.findSimilar(id, 20).catch(() => []);
    if (!similar.length) continue;
    const ranked = similar.map((p) => p.id);
    const stocked = await getDb()
      .select()
      .from(schema.products)
      .where(inArray(schema.products.channel3ProductId, ranked));
    if (!stocked.length) continue;
    return stocked
      .sort((a, b) => ranked.indexOf(a.channel3ProductId) - ranked.indexOf(b.channel3ProductId))
      .slice(0, 3)
      .map((p) => ({
        slug: p.slug,
        title: p.title,
        priceCents: p.shopPriceCents,
        imageUrl: p.imageUrl,
        isThisProduct: p.id === productId,
      }));
  }
  return [];
}

export async function getProductById(id: string): Promise<Product | null> {
  const [product] = await getDb().select().from(schema.products).where(eq(schema.products.id, id)).limit(1);
  return product ?? null;
}

type StepListener = (step: MatchStep, status: "running" | "done") => void;

export async function runMatch(
  { productId, competitorUrl }: { productId: string; competitorUrl: string },
  onStep: StepListener = () => {},
): Promise<MatchResult> {
  const [product, policy] = await Promise.all([getProductById(productId), getActivePolicy()]);
  if (!product) throw new MatchError("PRODUCT_NOT_FOUND", "That product isn't in the catalog", 404);
  if (!policy) throw new MatchError("NO_POLICY", "The shop has no price-match policy yet", 503);

  const c3 = getChannel3();
  const claude = getClaude();
  const shopListing = { url: `channel3:${product.channel3ProductId}`, product: product.channel3Snapshot as C3Product };

  // 1. Look up the listing.
  onStep("lookup", "running");
  let competitor: C3Product | null = null;
  let lookupError: string | null = null;
  try {
    competitor = await c3.lookup(competitorUrl);
  } catch (err) {
    lookupError = lookupFailureReason(err);
    console.warn(JSON.stringify({ msg: "match lookup failed", competitorUrl, error: err instanceof Error ? err.message : String(err) }));
  }
  onStep("lookup", "done");

  let verdict: Verdict;
  let judgment: JudgmentResult | null = null;
  let history: { stats: HistoryStats | null; raw: unknown } = { stats: null, raw: null };

  if (!competitor) {
    for (const step of ["compare", "history", "rules"] as const) onStep(step, "done");
    verdict = unverifiedVerdict(competitorUrl, lookupError ?? "unknown error", lowestMatchPriceCents(product.shopPriceCents, product.unitCostCents, policy));
  } else {
    // 2–3. Claude's comparison and the price history run together; progress is reported in order.
    onStep("compare", "running");
    const domain = domainOf(competitorUrl);
    const offerPrice = domain ? linkedOffer(competitor, domain)?.price?.price : undefined;
    const historyIds = [...new Set([competitor.id, product.channel3ProductId])];
    const historyPromise = loadHistory(historyIds, offerPrice ? dollarsToCents(offerPrice) : null);
    judgment = await claude.judgeSameProduct(shopListing, { url: competitorUrl, product: competitor }).catch(
      (err): JudgmentResult => {
        console.error(JSON.stringify({ msg: "match judgment failed", error: err instanceof Error ? err.message : String(err) }));
        return { outcome: "review", reason: "model error", model: "unknown" };
      },
    );
    onStep("compare", "done");
    onStep("history", "running");
    history = await historyPromise;
    onStep("history", "done");

    // 4. Apply the shop's rules.
    onStep("rules", "running");
    verdict = evaluateMatch({
      competitorUrl,
      competitor,
      shopPriceCents: product.shopPriceCents,
      unitCostCents: product.unitCostCents,
      currency: product.currency,
      policy,
      history: history.stats,
      judgment,
    });
    onStep("rules", "done");
  }

  // Value match: the counter-offer to make before cash, priced from the shop's allowed alternatives.
  const valueOffer =
    verdict.decision === "match" && verdict.matchedPriceCents != null
      ? chooseValueOffer(DEFAULT_VALUE_OFFERS, product.shopPriceCents - verdict.matchedPriceCents, product.shopPriceCents, product.unitCostCents)
      : null;

  // 5. Save the decision and every piece of evidence behind it. The counter-offer is saved alongside the
  // checks so checkout can honour exactly what was offered.
  const valueOfferReason = valueOffer
    ? [
        {
          code: VALUE_OFFER_CODE,
          message: `Offered ${valueOffer.title} (worth ${formatCents(valueOffer.customerValueCents)}, costs the shop ${formatCents(valueOffer.shopCostCents)}) before ${formatCents(valueOffer.insteadOfCents)} off in cash.`,
          source: "policy.value_offers",
          offer: valueOffer,
        },
      ]
    : [];
  const [saved] = await getDb()
    .insert(schema.matchRequests)
    .values({
      productId: product.id,
      competitorUrl,
      competitorDomain: verdict.competitorDomain,
      lookupSnapshot: competitor ? { url: competitorUrl, product: competitor } : { url: competitorUrl, error: lookupError },
      historyStats: history.stats ? { ...history.stats, source: history.raw } : null,
      model: judgment?.model ?? null,
      modelOutput: judgment,
      decision: verdict.decision,
      reasons: [...verdict.checks, ...valueOfferReason],
      competitorPriceCents: verdict.competitorPriceCents,
      matchedPriceCents: verdict.matchedPriceCents,
      policyId: policy.id,
    })
    .returning({ id: schema.matchRequests.id });

  const alternatives =
    verdict.decision === "decline" && competitor
      ? await findAlternatives([competitor.id, product.channel3ProductId], product.id)
      : [];

  console.log(
    JSON.stringify({
      msg: "match decision",
      matchRequestId: saved.id,
      product: product.slug,
      competitorUrl,
      decision: verdict.decision,
      decidedBy: verdict.decidedBy,
      competitorPriceCents: verdict.competitorPriceCents,
      matchedPriceCents: verdict.matchedPriceCents,
      policyVersion: policy.version,
    }),
  );

  const h = history.stats;
  return {
    ...verdict,
    matchRequestId: saved.id,
    productId: product.id,
    productSlug: product.slug,
    shopPriceCents: product.shopPriceCents,
    currency: product.currency,
    savingsCents: verdict.matchedPriceCents != null ? product.shopPriceCents - verdict.matchedPriceCents : null,
    competitorUrl,
    competitorTitle: competitor?.title ?? null,
    history: h
      ? { typicalCents: h.typicalCents, daysAtOrBelow: h.daysAtOrBelow, windowDays: h.windowDays, currentStatus: h.currentStatus, series: h.series }
      : null,
    alternatives,
    valueOffer,
    policyVersion: policy.version,
    model: judgment?.model ?? null,
    mode: c3.mode,
  };
}
