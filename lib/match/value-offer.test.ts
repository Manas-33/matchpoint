// Value match: which counter-offer the agent makes before a cash price match.
import { describe, expect, it } from "vitest";
import { DEFAULT_VALUE_OFFERS, type ValueOfferRule } from "../policy";
import { chooseValueOffer, priceOffer, savedValueOffer, VALUE_OFFER_CODE } from "./value-offer";

// The seeded Bose QC Ultra: $371.99 list, $278.99 unit cost (75%).
const SHOP = 37199;
const COST = 27899;
const credit = DEFAULT_VALUE_OFFERS.find((r) => r.kind === "store_credit")!;
const service = DEFAULT_VALUE_OFFERS.find((r) => r.kind === "service")!;

describe("pricing an offer", () => {
  it("gives whole dollars of store credit, costing the shop its unit-cost share", () => {
    const o = priceOffer(credit, 1200, SHOP, COST);
    expect(o.customerValueCents).toBe(1500); // $12 x 1.25
    expect(o.shopCostCents).toBe(1125); // $15 x 75%, rounded up
    expect(o.insteadOfCents).toBe(1200);
  });

  it("rounds credit up to the next dollar", () => {
    expect(priceOffer(credit, 1001, SHOP, COST).customerValueCents).toBe(1300);
  });

  it("prices a service at its fixed value and cost", () => {
    const o = priceOffer(service, 1200, SHOP, COST);
    expect(o).toMatchObject({ customerValueCents: 4000, shopCostCents: 800 });
  });
});

describe("choosing the counter-offer", () => {
  it("offers the cheapest alternative for the shop when it's worth at least the cash discount", () => {
    // $12 off in cash: gear care ($40 value, costs $8) beats credit ($15, costs $11.25) and cash ($12).
    expect(chooseValueOffer(DEFAULT_VALUE_OFFERS, 1200, SHOP, COST)?.id).toBe("gear-care");
  });

  it("skips an alternative worth less to the customer than the cash discount", () => {
    // $60 off: gear care is only worth $40, so store credit ($75, costs $56.25) is offered.
    const o = chooseValueOffer(DEFAULT_VALUE_OFFERS, 6000, SHOP, COST);
    expect(o?.id).toBe("store-credit");
    expect(o?.customerValueCents).toBe(7500);
  });

  it("offers nothing when no alternative is cheaper for the shop than cash", () => {
    // At a 100% cost ratio, store credit costs the shop more than cash; no service is allowed.
    expect(chooseValueOffer([credit], 1200, 10000, 10000)).toBeNull();
    expect(chooseValueOffer([], 1200, SHOP, COST)).toBeNull();
    expect(chooseValueOffer(DEFAULT_VALUE_OFFERS, 0, SHOP, COST)).toBeNull();
  });

  it("breaks a cost tie in favour of the customer", () => {
    const a: ValueOfferRule = { id: "a", kind: "service", title: "A", description: "", valueCents: 2000, shopCostCents: 500 };
    const b: ValueOfferRule = { ...a, id: "b", valueCents: 3000 };
    expect(chooseValueOffer([a, b], 1200, SHOP, COST)?.id).toBe("b");
  });
});

describe("the saved offer", () => {
  it("is read back from the match request's reasons", () => {
    const offer = chooseValueOffer(DEFAULT_VALUE_OFFERS, 1200, SHOP, COST)!;
    const reasons = [{ code: "store", message: "ok" }, { code: VALUE_OFFER_CODE, message: "offered", offer }];
    expect(savedValueOffer(reasons)).toEqual(offer);
    expect(savedValueOffer([{ code: "store" }])).toBeNull();
    expect(savedValueOffer(null)).toBeNull();
  });
});
