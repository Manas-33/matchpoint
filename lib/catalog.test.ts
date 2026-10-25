import { describe, expect, it } from "vitest";
import { hasCompleteVariants, isFullySelected, newInStockOffers, shopPricing, toProductRow } from "./catalog";
import type { Product } from "./channel3";
import { loadFixture } from "./fixtures";

const catalog = (id: string) => loadFixture<{ product: Product }>(`channel3/catalog/${id}`).product;

function product(overrides: Partial<Product>): Product {
  return { ...catalog("mgo7x7F"), ...overrides };
}

const offer = (domain: string, price: number, extra: Record<string, unknown> = {}) => ({
  url: `https://${domain}/p`,
  domain,
  price: { price, compare_at_price: null, currency: "USD" },
  availability: "InStock",
  condition: "new",
  ...extra,
});

describe("variant completeness", () => {
  it("accepts a product that names its selected variant", () => {
    expect(hasCompleteVariants(catalog("mgo7x7F"))).toBe(true);
  });

  it("rejects missing variants, empty options or no selection", () => {
    expect(hasCompleteVariants(catalog("hrz4MAW"))).toBe(false); // variants: null
    expect(hasCompleteVariants(product({ variants: { options: [], selected: [{ name: "Color", label: "Black" }] } }))).toBe(false);
    expect(hasCompleteVariants(product({ variants: { ...catalog("mgo7x7F").variants!, selected: [] } }))).toBe(false);
  });

  it("doesn't count condition (New / Used) as a variant", () => {
    const condition = { name: "Condition", values: [{ label: "New", exists: true }, { label: "Used", exists: true }] };
    const color = { name: "Color", values: [{ label: "Natural", exists: true }] };
    const conditionOnly = product({
      variants: { options: [condition], selected: [{ name: "Condition", label: "New" }] } as Product["variants"],
    });
    expect(hasCompleteVariants(conditionOnly)).toBe(false);
    expect(isFullySelected(conditionOnly)).toBe(false);

    const withColor = product({
      variants: {
        options: [condition, color],
        selected: [
          { name: "Condition", label: "New" },
          { name: "Color", label: "Natural" },
        ],
      } as Product["variants"],
    });
    expect(hasCompleteVariants(withColor)).toBe(true);
    expect(isFullySelected(withColor)).toBe(true);
    expect(toProductRow(withColor).variant).toEqual([{ name: "Color", label: "Natural" }]);
  });

  it("tells fully and partly selected variants apart", () => {
    expect(isFullySelected(catalog("mgo7x7F"))).toBe(true);
    expect(isFullySelected(catalog("3FRZAlJ"))).toBe(false); // colour selected, size not
  });
});

describe("shop pricing", () => {
  it("lists at the median offer, ending in .99, with cost from the category margin", () => {
    // Bose 2nd Gen: $279.00000000000006, $299, $397 -> median $299 -> $299.99; electronics cost 75%
    expect(shopPricing(catalog("mgo7x7F"))).toEqual({ shopPriceCents: 29999, unitCostCents: 22499 });
  });

  it("averages the two middle offers and uses the default 60% cost elsewhere", () => {
    const p = product({
      category: { slug: "jackets", title: "Jackets", path: [{ slug: "apparel", title: "Apparel" }] } as Product["category"],
      offers: [offer("rei.com", 200), offer("zappos.com", 230)] as Product["offers"],
    });
    expect(shopPricing(p)).toEqual({ shopPriceCents: 21599, unitCostCents: 12959 });
  });

  it("ignores used and out-of-stock offers", () => {
    const p = product({
      offers: [
        offer("rei.com", 100, { condition: "used" }),
        offer("zappos.com", 120, { availability: "OutOfStock" }),
        offer("backcountry.com", 150, { condition: null }),
      ] as Product["offers"],
    });
    expect(newInStockOffers(p).map((o) => o.domain)).toEqual(["backcountry.com"]);
    expect(shopPricing(p).shopPriceCents).toBe(15099);
    expect(() => shopPricing(product({ offers: [] }))).toThrow(/no in-stock offer/);
  });
});

describe("product rows", () => {
  it("maps a Channel3 product to the products table", () => {
    const row = toProductRow(catalog("mgo7x7F"));
    expect(row).toMatchObject({
      channel3ProductId: "mgo7x7F",
      slug: "bose-quietcomfort-ultra-headphones-2nd-gen-mgo7x7f",
      brand: "Bose",
      variant: [{ name: "Color", label: "Black" }],
      shopPriceCents: 29999,
    });
    expect(Number.isInteger(row.shopPriceCents) && Number.isInteger(row.unitCostCents)).toBe(true);
  });
});
