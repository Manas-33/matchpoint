// The scripted demo links shown under the "Found it cheaper?" box, keyed by the shop product's Channel3 ID.
// Real retailer URLs, recorded with `npm run match:record` (fixtures/channel3/lookup, history, similar and
// fixtures/claude). `constructed: true` cases are built by hand and only offered in demo mode.
export type DemoCase = { label: string; url: string; expect: "match" | "decline"; constructed?: boolean };

export const DEMO_CASES: Record<string, DemoCase[]> = {
  // Bose QuietComfort Ultra Headphones (2nd Gen), Black
  mgo7x7F: [
    {
      label: "Best Buy",
      url: "https://www.bestbuy.com/product/bose-quietcomfort-ultra-headphones-2nd-gen-black/J7C5V6W7LP",
      expect: "match",
    },
    {
      label: "Best Buy open-box",
      url: "https://www.bestbuy.com/product/bose-quietcomfort-ultra-headphones-2nd-gen-black/6642778/openbox",
      expect: "decline",
    },
    {
      label: "Crutchfield one-day low",
      url: "https://www.crutchfield.com/p_018QCULT2B/Bose-QuietComfort-Ultra-Headphones-2nd-Gen-Black.html",
      expect: "decline",
      constructed: true,
    },
  ],
};

export function demoCasesFor(channel3ProductId: string, demoMode: boolean): DemoCase[] {
  return (DEMO_CASES[channel3ProductId] ?? []).filter((c) => demoMode || !c.constructed);
}
