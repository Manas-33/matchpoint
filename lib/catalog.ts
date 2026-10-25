// Turning Channel3 products into the shop's catalog: which products qualify, and what the shop charges.
import type { Product } from "./channel3";
import type { NewProduct, VariantSelection } from "./db/schema";
import { slug } from "./fixtures";
import { dollarsToCents, type Cents } from "./money";

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// Complete variant data: every option lists its values, and the product says which variant it is.
export function hasCompleteVariants(p: Product): boolean {
  const v = p.variants;
  if (!v?.options?.length || !v.selected?.length) return false;
  const optionNames = new Set(v.options.map((o) => o.name));
  return (
    v.options.every((o) => o.name && o.values.length > 0 && o.values.every((val) => val.label)) &&
    v.selected.every((s) => s.label && optionNames.has(s.name))
  );
}

// Every option has a selected value (e.g. both colour and size), not just some of them.
export function isFullySelected(p: Product): boolean {
  const selected = new Set(p.variants?.selected?.map((s) => s.name));
  return !!p.variants?.options?.length && p.variants.options.every((o) => selected.has(o.name));
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

// The shop lists at the median current price (rounded up to end in .99), so some approved stores are
// cheaper (price-match candidates) and some dearer. Unit cost is a fixed share of the shop price.
export function shopPricing(p: Product): { shopPriceCents: Cents; unitCostCents: Cents } {
  const prices = newInStockOffers(p)
    .map((o) => dollarsToCents(o.price.price))
    .sort((a, b) => a - b);
  if (prices.length === 0) throw new Error(`Product ${p.id} has no in-stock offer to price from`);
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 ? prices[mid] : Math.round((prices[mid - 1] + prices[mid]) / 2);
  const shopPriceCents = Math.ceil((median + 1) / 100) * 100 - 1;
  const ratio = COST_RATIO_BPS[p.category?.path?.[0]?.slug ?? ""] ?? DEFAULT_COST_RATIO_BPS;
  return { shopPriceCents, unitCostCents: Math.round((shopPriceCents * ratio) / 10_000) };
}

export function toProductRow(p: Product): NewProduct {
  const image = p.images?.find((i) => i.is_main_image) ?? p.images?.[0];
  const variant: VariantSelection = (p.variants?.selected ?? []).map((s) => ({ name: s.name, label: decode(s.label) }));
  return {
    slug: `${slug(p.title).slice(0, 48)}-${p.id.toLowerCase()}`,
    channel3ProductId: p.id,
    title: p.title,
    brand: p.brands?.[0]?.name ?? null,
    category: p.category?.title ?? null,
    variant,
    variantOptions: p.variants?.options ?? [],
    imageUrl: image?.cleaned_url ?? image?.url ?? null,
    ...shopPricing(p),
    currency: "USD",
    channel3Snapshot: p,
  };
}
