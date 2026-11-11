// The match engine's deterministic half: policy checks on the competitor listing, the price-history glitch
// check, and the final verdict that combines them with Claude's same-product judgment. Pure functions:
// no database, network or clock, so every rule is unit-tested (rules.test.ts).
import type { Channel3Api } from "@channel3/sdk";
import type { JudgmentResult, SameProductDecision } from "../claude";
import type { DecisionReason, Policy } from "../db/schema";
import { dollarsToCents, formatCents, type Cents } from "../money";
import { lowestMatchPriceCents } from "../policy";

export type MatchPolicy = Pick<
  Policy,
  "approvedDomains" | "marginFloorBps" | "maxDiscountBps" | "glitchAction" | "unknownConditionAction"
>;

// Glitch check: a price this far below the typical price (median of the window) that showed up on at most
// GLITCH_MAX_DAYS days of the window is treated as a short-lived glitch, not a real sale.
export const HISTORY_WINDOW_DAYS = 30;
export const GLITCH_DROP_BPS = 2000;
// Channel3 marking the current price "low" lowers the bar to this drop.
export const GLITCH_DROP_BPS_WHEN_LOW = 1000;
export const GLITCH_MAX_DAYS = 1;
// A history point within 1% of the competitor price counts as "at that price".
const SAME_PRICE_TOLERANCE_BPS = 100;
// Below this, Claude's judgment can't decide on its own: the request goes to staff review.
export const MIN_CONFIDENCE = 0.7;

export type MatchDecision = "match" | "decline" | "review";
export type CheckStatus = "pass" | "fail" | "review" | "skip";
// One line of evidence. `source` names the listing field (or history statistic) the check read.
export type Check = DecisionReason & { label: string; status: CheckStatus };

export const domainOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

const sameOrSubdomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export const isApprovedDomain = (domain: string, approved: string[]) => approved.some((d) => sameOrSubdomain(domain, d));

// The offer at the store the customer linked to. A lookup returns the canonical product with every store's offers.
export function linkedOffer(product: Channel3Api.Product, domain: string) {
  return (product.offers ?? []).find((o) => sameOrSubdomain(domain, o.domain) || sameOrSubdomain(o.domain, domain));
}

// ---------- price history ----------

export type HistoryPoint = { timestamp: Date | string; price: number };
export type HistoryInput = {
  canonical_product_id?: string;
  history?: HistoryPoint[] | null;
  statistics?: { current_status?: string | null } | null;
};

export type HistoryStats = {
  productId: string | null;
  windowDays: number;
  points: number;
  typicalCents: Cents;
  lowCents: Cents;
  highCents: Cents;
  // Days in the window when the price was at (or below) the competitor's price.
  daysAtOrBelow: number;
  // How far the competitor price is below the typical price, in basis points (negative: above it).
  dropBps: number;
  currentStatus: string | null;
  glitch: boolean;
  // The window's daily prices, oldest first, for the evidence sparkline.
  series: { date: string; cents: Cents }[];
};

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

// Channel3 history is per canonical product (all stores together), daily, with outliers. The median is
// robust to the outliers; the day count tells a one-day low from a sale that has run for a while.
export function summarizeHistory(input: HistoryInput, competitorPriceCents: Cents): HistoryStats | null {
  const points = (input.history ?? [])
    .filter((p) => typeof p.price === "number" && p.price > 0)
    .map((p) => ({ t: new Date(p.timestamp), cents: dollarsToCents(p.price) }))
    .sort((a, b) => a.t.getTime() - b.t.getTime())
    .slice(-HISTORY_WINDOW_DAYS);
  if (points.length < 7) return null;
  const cents = points.map((p) => p.cents);
  const typicalCents = median(cents);
  const ceiling = Math.floor((competitorPriceCents * (10_000 + SAME_PRICE_TOLERANCE_BPS)) / 10_000);
  const daysAtOrBelow = cents.filter((c) => c <= ceiling).length;
  const dropBps = Math.round(((typicalCents - competitorPriceCents) * 10_000) / typicalCents);
  const currentStatus = input.statistics?.current_status ?? null;
  const threshold = currentStatus === "low" ? GLITCH_DROP_BPS_WHEN_LOW : GLITCH_DROP_BPS;
  return {
    productId: input.canonical_product_id ?? null,
    windowDays: points.length,
    points: points.length,
    typicalCents,
    lowCents: Math.min(...cents),
    highCents: Math.max(...cents),
    daysAtOrBelow,
    dropBps,
    currentStatus,
    glitch: dropBps >= threshold && daysAtOrBelow <= GLITCH_MAX_DAYS,
    series: points.map((p) => ({ date: p.t.toISOString().slice(0, 10), cents: p.cents })),
  };
}

// ---------- the verdict ----------

export type MatchEvaluationInput = {
  competitorUrl: string;
  competitor: Channel3Api.Product;
  shopPriceCents: Cents;
  unitCostCents: Cents;
  currency?: string;
  policy: MatchPolicy;
  history: HistoryStats | null;
  judgment: JudgmentResult;
};

export type Verdict = {
  decision: MatchDecision;
  // The one-line reason shown first: the first failing check, else the first one needing review.
  headline: string;
  // Which check decided it ("match" when every check passed).
  decidedBy: string;
  competitorDomain: string | null;
  competitorPriceCents: Cents | null;
  matchedPriceCents: Cents | null;
  lowestMatchCents: Cents;
  checks: Check[];
  // Claude's reasons, each citing a listing field (empty when there was no judgment).
  modelReasons: SameProductDecision["reasons"];
  customerMessage: string | null;
};

const check = (code: string, label: string, status: CheckStatus, message: string, source?: string): Check => ({
  code,
  label,
  status,
  message,
  ...(source ? { source } : {}),
});

const CLAUDE_CODES = new Set(["same_product", "model_year", "bundle", "variant", "condition", "confidence"]);

export function evaluateMatch(input: MatchEvaluationInput): Verdict {
  const { policy, history, judgment } = input;
  const fmt = (c: Cents) => formatCents(c, input.currency ?? "USD");
  const domain = domainOf(input.competitorUrl);
  const offer = domain ? linkedOffer(input.competitor, domain) : undefined;
  const offerSrc = `competitor.offers[${offer?.domain ?? domain}]`;
  const competitorPriceCents = offer?.price?.price ? dollarsToCents(offer.price.price) : null;
  const lowestMatchCents = lowestMatchPriceCents(input.shopPriceCents, input.unitCostCents, policy);
  const decision = judgment.outcome === "ok" ? judgment.decision : null;
  const confident = decision ? decision.confidence >= MIN_CONFIDENCE : false;
  // Claude's "no" only declines on its own when it's confident; otherwise a person takes a look.
  const claudeFail = confident ? "fail" : "review";
  const checks: Check[] = [];

  // 1. The store.
  if (!domain) {
    checks.push(check("store", "Approved store", "fail", "That link isn't a web address we can check.", "competitor.url"));
  } else if (isApprovedDomain(domain, policy.approvedDomains)) {
    checks.push(check("store", "Approved store", "pass", `${domain} is on our list of approved stores.`, "competitor.url"));
  } else {
    checks.push(
      check("store", "Approved store", "fail", `We don't match ${domain}: it isn't one of our approved stores.`, "competitor.url"),
    );
  }

  // 2. The offer at that store: found, priced, in stock.
  if (domain && (!offer || competitorPriceCents == null)) {
    checks.push(check("offer", "Price found", "review", `We couldn't read a ${domain} price from that page.`, "competitor.offers"));
  } else if (offer) {
    const inStock = offer.availability === "InStock";
    checks.push(
      check(
        "in_stock",
        "In stock",
        inStock ? "pass" : "fail",
        inStock ? `In stock at ${offer.domain}.` : `It's ${offer.availability === "OutOfStock" ? "out of stock" : "not available"} at ${offer.domain}.`,
        `${offerSrc}.availability`,
      ),
    );
  }

  // 3. Condition. A used/refurbished offer field declines outright. Otherwise Claude's read of the listing
  // decides: Channel3 folds open-box and refurbished pages into the new product, so an offer field saying
  // "new" doesn't overrule a URL or title that says otherwise.
  const offerCondition = offer?.condition ?? null;
  const conditionRead = decision?.condition ?? (offerCondition === "new" ? "new" : "unknown");
  const conditionSrc = decision ? conditionSource(decision) : `${offerSrc}.condition`;
  if (offerCondition && offerCondition !== "new") {
    checks.push(check("condition", "New condition", "fail", `That listing is ${offerCondition}, not new.`, `${offerSrc}.condition`));
  } else if (conditionRead === "new") {
    checks.push(check("condition", "New condition", "pass", "Listed as new.", conditionSrc));
  } else if (conditionRead === "not_new") {
    checks.push(
      check("condition", "New condition", claudeFail, "That listing is used, refurbished or open-box, and we only match new items.", conditionSrc),
    );
  } else {
    const action = policy.unknownConditionAction;
    const status = action === "allow" ? "pass" : action === "decline" ? "fail" : "review";
    checks.push(check("condition", "New condition", status, "The listing doesn't say whether it's new.", conditionSrc));
  }

  // 4. Same product, generation, not a bundle, same variant (Claude's judgment).
  if (judgment.outcome === "review") {
    checks.push(check("judgment", "Same product", "review", "We couldn't verify it's the same product automatically.", `model: ${judgment.reason}`));
  } else if (decision) {
    checks.push(
      decision.same_product
        ? check("same_product", "Same product", "pass", "It's the same product.", reasonField(decision, ["title", "brand", "model"]))
        : check("same_product", "Same product", claudeFail, "That's a different product from ours.", reasonField(decision, ["title"])),
    );
    if (decision.model_year_mismatch) {
      checks.push(check("model_year", "Same generation", claudeFail, "That's a different model year or generation.", reasonField(decision, ["title", "year", "gen"])));
    }
    if (decision.bundle_or_accessory) {
      checks.push(check("bundle", "Not a bundle", claudeFail, "That listing is a bundle or an accessory, not the item on its own.", reasonField(decision, ["title", "bundle", "description"])));
    }
    checks.push(
      decision.variant_match
        ? check("variant", "Same variant", "pass", "Same colour and options as ours.", reasonField(decision, ["variant", "color", "colour"]))
        : check("variant", "Same variant", claudeFail, "It's a different variant (colour, size or options) from the one we stock.", reasonField(decision, ["variant", "color", "colour"])),
    );
    checks.push(
      confident
        ? check("confidence", "Confidence", "pass", `Confidence ${decision.confidence.toFixed(2)}.`, "model.confidence")
        : check("confidence", "Confidence", "review", `Not sure enough to decide automatically (confidence ${decision.confidence.toFixed(2)}).`, "model.confidence"),
    );
  }

  // 5. Price history: refuse a one-day glitch, or match the typical price instead if the policy says so.
  let targetCents = competitorPriceCents;
  if (competitorPriceCents != null) {
    if (!history) {
      checks.push(check("history", "Price history", "skip", "No price history available for this product.", "history"));
    } else if (history.glitch) {
      const days = history.daysAtOrBelow === 1 ? "one day" : history.daysAtOrBelow === 0 ? "no day" : `${history.daysAtOrBelow} days`;
      const msg = `Typical price is ${fmt(history.typicalCents)}. ${fmt(competitorPriceCents)} showed up on ${days} in the last ${history.windowDays}, so it looks like a pricing glitch.`;
      if (policy.glitchAction === "match_typical") {
        targetCents = history.typicalCents;
        checks.push(check("history", "Price history", "pass", `${msg} We can match the typical price instead.`, "history.typical"));
      } else {
        checks.push(check("history", "Price history", "fail", msg, "history.typical"));
      }
    } else {
      checks.push(
        check(
          "history",
          "Price history",
          "pass",
          `Typical price over the last ${history.windowDays} days is ${fmt(history.typicalCents)}; ${fmt(competitorPriceCents)} is a normal price for it.`,
          "history.typical",
        ),
      );
    }
  }

  // 6. Cheaper than us, and within the margin floor and maximum discount.
  if (targetCents != null) {
    if (targetCents >= input.shopPriceCents) {
      checks.push(check("cheaper", "Cheaper than us", "fail", `Our price, ${fmt(input.shopPriceCents)}, is already at or below ${fmt(targetCents)}.`, `${offerSrc}.price`));
    } else {
      checks.push(
        check("cheaper", "Cheaper than us", "pass", `${fmt(targetCents)} is ${fmt(input.shopPriceCents - targetCents)} below our ${fmt(input.shopPriceCents)}.`, `${offerSrc}.price`),
      );
      checks.push(
        targetCents >= lowestMatchCents
          ? check("limits", "Within our limits", "pass", `Within our match limits (we can go down to ${fmt(lowestMatchCents)}).`, "policy.lowest_match_price")
          : check("limits", "Within our limits", "fail", `The lowest we can match is ${fmt(lowestMatchCents)}, and ${fmt(targetCents)} is below that.`, "policy.lowest_match_price"),
      );
    }
  }

  const firstFail = checks.find((c) => c.status === "fail");
  const firstReview = checks.find((c) => c.status === "review");
  const verdict: MatchDecision = firstFail ? "decline" : firstReview ? "review" : "match";
  const decisive = firstFail ?? firstReview;
  const headline =
    verdict === "match"
      ? `Matched: ${fmt(targetCents!)} from ${offer?.domain ?? domain}.`
      : verdict === "review"
        ? `${decisive!.message} A member of staff will check it.`
        : decisive!.message;

  return {
    decision: verdict,
    headline,
    decidedBy: decisive?.code ?? "match",
    competitorDomain: offer?.domain ?? domain,
    competitorPriceCents,
    matchedPriceCents: verdict === "match" ? targetCents : null,
    lowestMatchCents,
    checks,
    modelReasons: decision?.reasons ?? [],
    // Claude's own words only when its judgment decided the outcome; code explains price and policy outcomes.
    customerMessage: decision && (verdict === "match" || CLAUDE_CODES.has(decisive?.code ?? "")) ? decision.customer_message : null,
  };
}

// The field Claude cited for a point, e.g. "competitor.title". Falls back to the generic "model".
function reasonField(d: SameProductDecision, hints: string[]): string {
  const hit = d.reasons.find((r) => hints.some((h) => `${r.field} ${r.observation}`.toLowerCase().includes(h)));
  return hit ? `${hit.listing}.${hit.field}` : "model";
}

function conditionSource(d: SameProductDecision): string {
  return reasonField(d, ["condition", "open-box", "openbox", "refurb", "used", "renewed", "url"]);
}

// A verdict for a link Channel3 couldn't resolve to a product: there is nothing to check, so a person looks.
export function unverifiedVerdict(competitorUrl: string, why: string, lowestMatchCents: Cents): Verdict {
  return {
    decision: "review",
    headline: `We couldn't verify that link (${why}). It's been sent to staff for review.`,
    decidedBy: "lookup",
    competitorDomain: domainOf(competitorUrl),
    competitorPriceCents: null,
    matchedPriceCents: null,
    lowestMatchCents,
    checks: [check("lookup", "Listing found", "review", `Couldn't read the listing: ${why}.`, "competitor.url")],
    modelReasons: [],
    customerMessage: null,
  };
}
