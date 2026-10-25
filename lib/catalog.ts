// Turning Channel3 products into the shop's catalog: which products qualify, and what the shop charges.
import type { Product } from "./channel3";
import type { NewProduct, VariantSelection } from "./db/schema";
import { slug } from "./fixtures";
import { applyBps, dollarsToCents, type Cents } from "./money";
import { lowestMatchPriceCents, type MatchLimits } from "./policy";

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// Channel3 sometimes lists condition (New / Used) as a variant option. Condition describes an offer,
// not the product, so it never counts as variant data.
const isConditionOption = (name: string) => /^condition$/i.test(name.trim());

export function variantOptions(p: Product) {
  return (p.variants?.options ?? []).filter((o) => !isConditionOption(o.name));
}

export function variantSelection(p: Product) {
  return (p.variants?.selected ?? []).filter((s) => !isConditionOption(s.name));
}

// Complete variant data: every option lists its values, and the product says which variant it is.
export function hasCompleteVariants(p: Product): boolean {
  const options = variantOptions(p);
  const selected = variantSelection(p);
  if (!options.length || !selected.length) return false;
  const optionNames = new Set(options.map((o) => o.name));
  return (
    options.every((o) => o.name && o.values.length > 0 && o.values.every((val) => val.label)) &&
    selected.every((s) => s.label && optionNames.has(s.name))
  );
}

// Every option has a selected value (e.g. both colour and size), not just some of them.
export function isFullySelected(p: Product): boolean {
  const options = variantOptions(p);
  const selected = new Set(variantSelection(p).map((s) => s.name));
  return options.length > 0 && options.every((o) => selected.has(o.name));
}

// In-stock offers that aren't known to be used. Channel3 usually reports condition as null (unknown).
export function newInStockOffers(p: Product, domains?: string[]) {
  return (p.offers ?? []).filter(
    (o) =>
      o.availability === "InStock" &&
      o.condition !== "used" &&
      o.price?.price > 0 &&
      o.price.currency === "USD" &&
      (!domains || domains.includes(o.domain)),
  );
}

// Electronics carry thinner margins than outdoor gear, instruments and kitchenware.
const COST_RATIO_BPS: Record<string, number> = { electronics: 7500 };
const DEFAULT_COST_RATIO_BPS = 6000;
// Without an MSRP, list this far above the cheapest approved store.
const NO_MSRP_MARKUP_BPS = 1000;

export type PricingPolicy = MatchLimits & { approvedDomains: string[] };

const costRatioBps = (p: Product) => COST_RATIO_BPS[p.category?.path?.[0]?.slug ?? ""] ?? DEFAULT_COST_RATIO_BPS;
// Prices end in .99: the next one up from `cents`, and the next one strictly below it.
const ninetyNineAtOrAbove = (cents: Cents) => Math.ceil((cents + 1) / 100) * 100 - 1;
const ninetyNineBelow = (cents: Cents) => Math.floor((cents - 100) / 100) * 100 + 99;

// MSRP: the highest compare-at ("was") price among in-stock, not-used offers.
export function msrpCents(p: Product): Cents | undefined {
  const prices = newInStockOffers(p)
    .map((o) => o.price.compare_at_price)
    .filter((v): v is number => typeof v === "number" && v > 0)
    .map(dollarsToCents);
  return prices.length ? Math.max(...prices) : undefined;
}

// Like an independent shop, list at MSRP (or a bit above the cheapest approved store when there's no
// MSRP), so approved stores undercut the shop and a price match is possible. The price is then lowered,
// one .99 step at a time, until the cheapest approved store is within the policy's margin floor and
// maximum discount. Unit cost is a fixed share of the shop price.
export function shopPricing(p: Product, policy: PricingPolicy): { shopPriceCents: Cents; unitCostCents: Cents } {
  const approved = newInStockOffers(p, policy.approvedDomains).map((o) => dollarsToCents(o.price.price));
  if (approved.length === 0) throw new Error(`Product ${p.id} has no in-stock offer at an approved store`);
  const cheapest = Math.min(...approved);
  const ratio = costRatioBps(p);
  const msrp = msrpCents(p);

  let shop = msrp && msrp > cheapest ? msrp : ninetyNineAtOrAbove(applyBps(cheapest, 10_000 + NO_MSRP_MARKUP_BPS));
  while (shop > cheapest && lowestMatchPriceCents(shop, applyBps(shop, ratio), policy) > cheapest) {
    shop = ninetyNineBelow(shop);
  }
  if (shop <= cheapest) throw new Error(`Product ${p.id}: no shop price leaves its cheapest approved store matchable`);
  return { shopPriceCents: shop, unitCostCents: applyBps(shop, ratio) };
}

export function toProductRow(p: Product, policy: PricingPolicy): NewProduct {
  const image = p.images?.find((i) => i.is_main_image) ?? p.images?.[0];
  const variant: VariantSelection = variantSelection(p).map((s) => ({ name: s.name, label: decode(s.label) }));
  return {
    slug: `${slug(p.title).slice(0, 48)}-${p.id.toLowerCase()}`,
    channel3ProductId: p.id,
    title: p.title,
    brand: p.brands?.[0]?.name ?? null,
    category: p.category?.title ?? null,
    variant,
    variantOptions: variantOptions(p),
    imageUrl: image?.cleaned_url ?? image?.url ?? null,
    ...shopPricing(p, policy),
    currency: "USD",
    channel3Snapshot: p,
  };
}
