import { describe, expect, it } from "vitest";
import { hasCompleteVariants, isFullySelected, msrpCents, newInStockOffers, shopPricing, toProductRow } from "./catalog";
import type { Product } from "./channel3";
import { listFixtures, loadFixture } from "./fixtures";
import { dollarsToCents } from "./money";
import { DEFAULT_POLICY, lowestMatchPriceCents } from "./policy";

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
    expect(toProductRow(withColor, DEFAULT_POLICY).variant).toEqual([{ name: "Color", label: "Natural" }]);
  });

  it("tells fully and partly selected variants apart", () => {
    expect(isFullySelected(catalog("mgo7x7F"))).toBe(true);
    expect(isFullySelected(catalog("3FRZAlJ"))).toBe(false); // colour selected, size not
  });
});

describe("shop pricing", () => {
  const electronics = { slug: "headphones", title: "Headphones", path: [{ slug: "electronics", title: "Electronics" }] };
  const apparel = { slug: "jackets", title: "Jackets", path: [{ slug: "apparel", title: "Apparel" }] };

  it("lists at MSRP when the cheapest approved store stays matchable", () => {
    // Bose 2nd Gen: compare-at $449 at bose.com; the only approved store is Best Buy at $397.
    expect(msrpCents(catalog("mgo7x7F"))).toBe(44900);
    const bose = shopPricing(catalog("mgo7x7F"), DEFAULT_POLICY);
    expect(bose).toEqual({ shopPriceCents: 44900, unitCostCents: 33675 }); // electronics cost 75%
    expect(lowestMatchPriceCents(bose.shopPriceCents, bose.unitCostCents, DEFAULT_POLICY)).toBeLessThanOrEqual(39700);
  });

  it("takes MSRP from in-stock offers only", () => {
    // KitchenAid: an out-of-stock offer has compare-at $500; in-stock ones say $399.99 and $400.
    expect(msrpCents(catalog("qW2Da5V"))).toBe(40000);
    expect(shopPricing(catalog("qW2Da5V"), DEFAULT_POLICY)).toEqual({ shopPriceCents: 40000, unitCostCents: 24000 });
  });

  it("without an MSRP, lists 10% above the cheapest approved store, ending in .99", () => {
    const p = product({
      category: apparel as Product["category"],
      offers: [offer("rei.com", 200), offer("zappos.com", 230), offer("example-shop.com", 150)] as Product["offers"],
    });
    // Cheapest approved is REI at $200 (example-shop.com isn't approved) -> $220 -> $220.99; cost 60%.
    expect(shopPricing(p, DEFAULT_POLICY)).toEqual({ shopPriceCents: 22099, unitCostCents: 13259 });
  });

  it("lowers an MSRP that would put the approved store below the margin floor", () => {
    const p = product({
      category: electronics as Product["category"],
      offers: [offer("bestbuy.com", 397, { price: { price: 397, compare_at_price: 600, currency: "USD" } })] as Product["offers"],
    });
    const { shopPriceCents, unitCostCents } = shopPricing(p, DEFAULT_POLICY);
    // $449.99 would need a $397.05 floor; $448.99 is the highest .99 price that keeps $397 matchable.
    expect(shopPriceCents).toBe(44899);
    expect(lowestMatchPriceCents(shopPriceCents, unitCostCents, DEFAULT_POLICY)).toBeLessThanOrEqual(39700);
    expect(lowestMatchPriceCents(44999, 33749, DEFAULT_POLICY)).toBeGreaterThan(39700);
  });

  it("ignores used and out-of-stock offers, and needs an approved store", () => {
    const p = product({
      offers: [
        offer("rei.com", 100, { condition: "used" }),
        offer("zappos.com", 120, { availability: "OutOfStock" }),
        offer("backcountry.com", 150, { condition: null }),
      ] as Product["offers"],
    });
    expect(newInStockOffers(p).map((o) => o.domain)).toEqual(["backcountry.com"]);
    expect(() => shopPricing(product({ offers: [offer("example-shop.com", 99)] as Product["offers"] }), DEFAULT_POLICY)).toThrow(
      /no in-stock offer at an approved store/,
    );
  });

  it("leaves every seeded product with an approved store the shop can match", () => {
    const { products } = loadFixture<{ products: { id: string }[] }>("seed/catalog");
    expect(products.length).toBe(12);
    for (const { id } of products) {
      const p = catalog(id);
      const { shopPriceCents, unitCostCents } = shopPricing(p, DEFAULT_POLICY);
      const cheapest = Math.min(...newInStockOffers(p, DEFAULT_POLICY.approvedDomains).map((o) => dollarsToCents(o.price.price)));
      expect(cheapest, id).toBeLessThan(shopPriceCents);
      expect(lowestMatchPriceCents(shopPriceCents, unitCostCents, DEFAULT_POLICY), id).toBeLessThanOrEqual(cheapest);
    }
    expect(listFixtures("channel3/catalog").length).toBeGreaterThanOrEqual(12);
  });
});

describe("match limits", () => {
  it("is the higher of the margin floor and the maximum discount, rounded up", () => {
    // $100 at 60% cost: margin floor $70.59 (60 / 0.85), max discount $80 -> $80
    expect(lowestMatchPriceCents(10000, 6000, DEFAULT_POLICY)).toBe(8000);
    // $100 at 75% cost: margin floor $88.24 -> binds before the discount
    expect(lowestMatchPriceCents(10000, 7500, DEFAULT_POLICY)).toBe(8824);
  });
});

describe("product rows", () => {
  it("maps a Channel3 product to the products table", () => {
    const row = toProductRow(catalog("mgo7x7F"), DEFAULT_POLICY);
    expect(row).toMatchObject({
      channel3ProductId: "mgo7x7F",
      slug: "bose-quietcomfort-ultra-headphones-2nd-gen-mgo7x7f",
      brand: "Bose",
      variant: [{ name: "Color", label: "Black" }],
      shopPriceCents: 44900,
    });
    expect(Number.isInteger(row.shopPriceCents) && Number.isInteger(row.unitCostCents)).toBe(true);
  });
});
