// The match engine's rules and verdict: unit cases for each check, and the three scripted demo cases run
// through the recorded Channel3 and Claude fixtures (no network, no database).
import type { Channel3Api } from "@channel3/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JudgmentResult, SameProductDecision } from "../claude";
import { DEFAULT_POLICY, lowestMatchPriceCents } from "../policy";
import { DEMO_CASES } from "./demo-cases";
import {
  domainOf,
  evaluateMatch,
  isApprovedDomain,
  summarizeHistory,
  unverifiedVerdict,
  type HistoryStats,
  type MatchEvaluationInput,
  type MatchPolicy,
} from "./rules";

const policy: MatchPolicy = { ...DEFAULT_POLICY };
// The seeded Bose QC Ultra (2nd Gen): $371.99, cost $278.99, so the lowest match is $328.23.
const SHOP = { shopPriceCents: 37199, unitCostCents: 27899 };
const URL_BB = "https://www.bestbuy.com/product/bose-qc-ultra/J7C5V6W7LP";

const product = (offer: Partial<NonNullable<Channel3Api.Product["offers"]>[number]> = {}): Channel3Api.Product =>
  ({
    id: "GrrCAIt",
    title: "Bose QuietComfort Ultra Headphones (2nd Gen)",
    offers: [
      {
        url: "https://buy.example/x",
        domain: "bestbuy.com",
        price: { price: 359.99, compare_at_price: null, currency: "USD" },
        availability: "InStock",
        condition: null,
        ...offer,
      },
    ],
  }) as unknown as Channel3Api.Product;

const judgment = (d: Partial<SameProductDecision> = {}): JudgmentResult => ({
  outcome: "ok",
  model: "test",
  decision: {
    same_product: true,
    variant_match: true,
    condition: "new",
    bundle_or_accessory: false,
    model_year_mismatch: false,
    confidence: 0.9,
    reasons: [{ listing: "both", field: "title", observation: "Same model." }],
    customer_message: "Same headphones.",
    ...d,
  },
});

const typicalHistory = (typical: number, days = 30) =>
  ({ typicalCents: typical, daysAtOrBelow: 5, dropBps: 1000, glitch: false, windowDays: days }) as unknown as HistoryStats;

function evaluate(overrides: Partial<MatchEvaluationInput> = {}) {
  return evaluateMatch({
    competitorUrl: URL_BB,
    competitor: product(),
    ...SHOP,
    policy,
    history: typicalHistory(40000),
    judgment: judgment(),
    ...overrides,
  });
}

const statusOf = (v: ReturnType<typeof evaluate>, code: string) => v.checks.find((c) => c.code === code)?.status;

describe("helpers", () => {
  it("reads the store domain from a link", () => {
    expect(domainOf("https://www.BestBuy.com/x?y=1")).toBe("bestbuy.com");
    expect(domainOf("ftp://bestbuy.com/x")).toBeNull();
    expect(domainOf("not a url")).toBeNull();
  });

  it("approves listed stores and their subdomains only", () => {
    expect(isApprovedDomain("bestbuy.com", ["bestbuy.com"])).toBe(true);
    expect(isApprovedDomain("m.bestbuy.com", ["bestbuy.com"])).toBe(true);
    expect(isApprovedDomain("notbestbuy.com", ["bestbuy.com"])).toBe(false);
    expect(isApprovedDomain("amazon.com", DEFAULT_POLICY.approvedDomains)).toBe(false);
  });
});

describe("price history", () => {
  const days = (prices: number[]) =>
    prices.map((price, i) => ({ timestamp: new Date(Date.UTC(2026, 9, 1 + i)), price }));

  it("flags a one-day low far below the typical price", () => {
    const stats = summarizeHistory({ history: days([...Array(29).fill(449), 329.99]) }, 32999)!;
    expect(stats.typicalCents).toBe(44900);
    expect(stats.daysAtOrBelow).toBe(1);
    expect(stats.glitch).toBe(true);
  });

  it("does not flag a sale that has lasted several days", () => {
    const stats = summarizeHistory({ history: days([...Array(25).fill(449), ...Array(5).fill(329.99)]) }, 32999)!;
    expect(stats.daysAtOrBelow).toBe(5);
    expect(stats.glitch).toBe(false);
  });

  it("does not flag a modest discount, and ignores one-day outliers in the typical price", () => {
    const stats = summarizeHistory({ history: days([...Array(28).fill(409), 29, 359.99]) }, 35999)!;
    expect(stats.typicalCents).toBe(40900);
    expect(stats.glitch).toBe(false);
  });

  it("uses a lower bar when Channel3 calls the current price low", () => {
    const history = days([...Array(29).fill(399), 349]);
    expect(summarizeHistory({ history }, 34900)!.glitch).toBe(false);
    expect(summarizeHistory({ history, statistics: { current_status: "low" } }, 34900)!.glitch).toBe(true);
  });

  it("needs at least a week of history", () => {
    expect(summarizeHistory({ history: days([449, 449, 449]) }, 30000)).toBeNull();
  });
});

describe("verdict", () => {
  it("matches a cheaper, new, in-stock, same product at an approved store, at the competitor's price", () => {
    const v = evaluate();
    expect(v.decision).toBe("match");
    expect(v.matchedPriceCents).toBe(35999);
    expect(v.checks.every((c) => c.status === "pass")).toBe(true);
    expect(v.customerMessage).toBe("Same headphones.");
  });

  it("declines a store that isn't approved, even when Claude is happy", () => {
    const v = evaluate({ competitorUrl: "https://www.amazon.com/dp/B0X", competitor: product({ domain: "amazon.com" }) });
    expect(v.decision).toBe("decline");
    expect(v.decidedBy).toBe("store");
    expect(v.matchedPriceCents).toBeNull();
  });

  it("declines out-of-stock and used offers", () => {
    expect(evaluate({ competitor: product({ availability: "OutOfStock" }) }).decidedBy).toBe("in_stock");
    expect(evaluate({ competitor: product({ condition: "used" }) }).decidedBy).toBe("condition");
  });

  it("lets Claude's read of the listing overrule an offer field that says new (Channel3 merges open-box pages)", () => {
    const v = evaluate({ competitor: product({ condition: "new" }), judgment: judgment({ condition: "not_new" }) });
    expect(v.decision).toBe("decline");
    expect(v.decidedBy).toBe("condition");
  });

  it("applies the policy to an unknown condition", () => {
    const unknown = { judgment: judgment({ condition: "unknown" }) };
    expect(evaluate(unknown).decision).toBe("review");
    expect(evaluate({ ...unknown, policy: { ...policy, unknownConditionAction: "allow" } }).decision).toBe("match");
    expect(evaluate({ ...unknown, policy: { ...policy, unknownConditionAction: "decline" } }).decision).toBe("decline");
  });

  it("declines when the competitor isn't cheaper", () => {
    const v = evaluate({ competitor: product({ price: { price: 452.99, compare_at_price: null, currency: "USD" } }) });
    expect(v.decidedBy).toBe("cheaper");
  });

  it("declines below the lowest price the margin floor and maximum discount allow", () => {
    expect(lowestMatchPriceCents(SHOP.shopPriceCents, SHOP.unitCostCents, policy)).toBe(32823);
    const below = evaluate({ competitor: product({ price: { price: 328.22, compare_at_price: null, currency: "USD" } }) });
    expect(below.decidedBy).toBe("limits");
    const at = evaluate({ competitor: product({ price: { price: 328.23, compare_at_price: null, currency: "USD" } }) });
    expect(at.decision).toBe("match");
  });

  it("declines a price-history glitch, or matches the typical price when the policy says so", () => {
    const glitch = { typicalCents: 36500, daysAtOrBelow: 1, dropBps: 2500, glitch: true, windowDays: 30 } as HistoryStats;
    const declined = evaluate({ history: glitch });
    expect(declined.decision).toBe("decline");
    expect(declined.decidedBy).toBe("history");
    expect(declined.headline).toMatch(/Typical price is \$365\.00/);
    const typical = evaluate({ history: glitch, policy: { ...policy, glitchAction: "match_typical" } });
    expect(typical.decision).toBe("match");
    expect(typical.matchedPriceCents).toBe(36500);
  });

  it("goes ahead without price history, noting it was skipped", () => {
    const v = evaluate({ history: null });
    expect(v.decision).toBe("match");
    expect(statusOf(v, "history")).toBe("skip");
  });

  it("declines a different product, model year, bundle or variant when Claude is confident", () => {
    expect(evaluate({ judgment: judgment({ same_product: false }) }).decidedBy).toBe("same_product");
    expect(evaluate({ judgment: judgment({ model_year_mismatch: true }) }).decidedBy).toBe("model_year");
    expect(evaluate({ judgment: judgment({ bundle_or_accessory: true }) }).decidedBy).toBe("bundle");
    expect(evaluate({ judgment: judgment({ variant_match: false }) }).decidedBy).toBe("variant");
  });

  it("sends low confidence to review instead of deciding, either way", () => {
    expect(evaluate({ judgment: judgment({ confidence: 0.5 }) }).decision).toBe("review");
    expect(evaluate({ judgment: judgment({ confidence: 0.5, variant_match: false }) }).decision).toBe("review");
  });

  it("sends a refusal or failed judgment to review, but a rule failure still declines", () => {
    const refused: JudgmentResult = { outcome: "review", reason: "refusal", model: "test" };
    expect(evaluate({ judgment: refused }).decision).toBe("review");
    expect(evaluate({ judgment: refused, competitor: product({ availability: "OutOfStock" }) }).decision).toBe("decline");
  });

  it("sends a link with no price for that store to review", () => {
    const v = evaluate({ competitorUrl: "https://www.target.com/p/x" });
    expect(v.decision).toBe("review");
    expect(v.decidedBy).toBe("offer");
  });

  it("sends an unresolvable link to review", () => {
    const v = unverifiedVerdict(URL_BB, "that page isn't a product page", 32823);
    expect(v.decision).toBe("review");
    expect(v.competitorDomain).toBe("bestbuy.com");
  });

  it("cites a source for every check", () => {
    for (const c of evaluate().checks) expect(c.source).toBeTruthy();
  });
});

describe("scripted demo cases (recorded fixtures)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("DATABASE_URL", "postgres://u:p@localhost:5433/db");
  });

  async function run(url: string) {
    const { getChannel3 } = await import("../channel3");
    const { getClaude } = await import("../claude");
    const { loadFixture } = await import("../fixtures");
    const c3 = getChannel3();
    const shop = loadFixture<{ url: string; product: Channel3Api.Product }>("channel3/catalog/mgo7x7F");
    const competitor = await c3.lookup(url);
    const offer = competitor.offers!.find((o) => url.includes(o.domain))!;
    const raw = await c3.priceHistory(competitor.id);
    return evaluateMatch({
      competitorUrl: url,
      competitor,
      ...SHOP,
      policy,
      history: summarizeHistory(raw, Math.round(offer.price.price * 100)),
      judgment: await getClaude().judgeSameProduct(shop, { url, product: competitor }),
    });
  }

  const [match, openBox, glitch] = DEMO_CASES.mgo7x7F;

  it("matches the Best Buy listing at its price", async () => {
    const v = await run(match.url);
    expect(v.decision).toBe("match");
    expect(v.matchedPriceCents).toBe(35999);
  });

  it("declines the Best Buy open-box listing on condition", async () => {
    const v = await run(openBox.url);
    expect(v.decision).toBe("decline");
    expect(v.decidedBy).toBe("condition");
  });

  it("declines the constructed one-day low on price history", async () => {
    const v = await run(glitch.url);
    expect(v.decision).toBe("decline");
    expect(v.decidedBy).toBe("history");
    expect(v.headline).toMatch(/Typical price is \$449\.00\. \$329\.99 showed up on one day/);
  });
});
