import { describe, expect, it } from "vitest";
import type { Product } from "./db/schema";
import { productImages, productVariantOptions, variantLabel } from "./shop";

const product = (overrides: Partial<Product>): Product =>
  ({
    title: "Bose QuietComfort Ultra Headphones (2nd Gen)",
    variant: [],
    variantOptions: [],
    channel3Snapshot: {},
    ...overrides,
  }) as Product;

describe("productImages", () => {
  it("puts the main image first, prefers the cleaned image and keeps only Channel3's CDN", () => {
    const p = product({
      channel3Snapshot: {
        images: [
          { url: "https://cdn.trychannel3.com/a", cleaned_url: "https://cdn.trychannel3.com/cleaned/v1/a", alt_text: "side" },
          { url: "https://assets.bosecreative.com/b.png", alt_text: "brand asset" },
          { url: "https://cdn.trychannel3.com/c", is_main_image: true },
        ],
      },
    });
    expect(productImages(p)).toEqual([
      { url: "https://cdn.trychannel3.com/c", alt: p.title },
      { url: "https://cdn.trychannel3.com/cleaned/v1/a", alt: "side" },
    ]);
  });
});

describe("productVariantOptions", () => {
  it("shows the stocked value and counts the other listed values, decoded and de-duplicated", () => {
    const p = product({
      variant: [{ name: "Color", label: "Black" }],
      variantOptions: [
        { name: "Color", values: [{ label: "Black" }, { label: "MIDNIGHT%20VIOLET" }, { label: "MIDNIGHT VIOLET" }, { label: "Gone", exists: false }] },
        { name: "Size", values: [{ label: "S" }, { label: "M" }] },
      ],
    });
    expect(productVariantOptions(p)).toEqual([{ name: "Color", label: "Black", otherCount: 1 }]);
    expect(variantLabel(p.variant)).toBe("Black");
  });
});
