import { describe, expect, it } from "vitest";
import {
  evaluatePriceDrop,
  isApprovedDomain,
  parseChannel3Time,
  refundRequestId,
  textSparkline,
  type OfferCheck,
  type PriceEventFacts,
  type ProtectedOrder,
  type ProtectionPolicy,
} from "./protection";
import { simulatedDropCents } from "./price-protection";

const policy: ProtectionPolicy = { version: 1, approvedDomains: ["zappos.com", "rei.com"], autoRefundCapCents: 5000, minRefundCents: 100 };
const order: ProtectedOrder = {
  channel3ProductId: "9KcTGLh",
  status: "active",
  pricePaidCents: 2799,
  currency: "USD",
  capturedAt: new Date("2026-11-10T21:18:44Z"),
  windowEndsAt: new Date("2026-11-24T21:18:44Z"),
  alreadyRefundedCents: 0,
};
const event: PriceEventFacts = {
  channel3ProductId: "9KcTGLh",
  domain: "zappos.com",
  newPriceCents: 2199,
  currency: "USD",
  observedAt: new Date("2026-11-11T10:00:00Z"),
};
const inStock: OfferCheck = { availability: "InStock", condition: "new" };

const decide = (e: Partial<PriceEventFacts> = {}, o: Partial<ProtectedOrder> = {}, offer: OfferCheck = inStock, p: Partial<ProtectionPolicy> = {}) =>
  evaluatePriceDrop({ ...event, ...e }, { ...order, ...o }, offer, { ...policy, ...p });
const lastCode = (d: ReturnType<typeof decide>) => d.reasons.at(-1)?.code;

describe("evaluatePriceDrop", () => {
  it("refunds the difference automatically under the cap", () => {
    const d = decide();
    expect(d).toMatchObject({ action: "refund", amountCents: 600 });
    expect(d.reasons.map((r) => r.code)).toEqual(["same_product", "store_approved", "in_stock", "within_window", "price_difference", "under_cap"]);
  });

  it("queues a difference over the cap for the owner", () => {
    const d = decide({ newPriceCents: 999 }, { pricePaidCents: 9999 });
    expect(d).toMatchObject({ action: "queue", amountCents: 9000 });
    expect(lastCode(d)).toBe("over_cap");
  });

  it("refunds exactly the cap automatically", () => {
    expect(decide({ newPriceCents: 4999 }, { pricePaidCents: 9999 })).toMatchObject({ action: "refund", amountCents: 5000 });
  });

  it("skips a difference under the minimum", () => {
    const d = decide({ newPriceCents: 2750 });
    expect(d).toMatchObject({ action: "skip", amountCents: 0 });
    expect(lastCode(d)).toBe("below_minimum");
    expect(decide({ newPriceCents: 2699 })).toMatchObject({ action: "refund", amountCents: 100 });
  });

  it("skips a price that isn't lower", () => {
    expect(lastCode(decide({ newPriceCents: 2799 }))).toBe("not_lower");
    expect(lastCode(decide({ newPriceCents: 3500 }))).toBe("not_lower");
  });

  it("only refunds what earlier refunds haven't covered", () => {
    expect(decide({ newPriceCents: 1999 }, { alreadyRefundedCents: 600 })).toMatchObject({ action: "refund", amountCents: 200 });
    expect(lastCode(decide({ newPriceCents: 2500 }, { alreadyRefundedCents: 600 }))).toBe("already_refunded");
  });

  it("skips stores that aren't approved, including lookalike domains", () => {
    expect(lastCode(decide({ domain: "amazon.com" }))).toBe("store_not_approved");
    expect(lastCode(decide({ domain: "notzappos.com" }))).toBe("store_not_approved");
    expect(lastCode(decide({ domain: null }))).toBe("store_not_approved");
    expect(decide({ domain: "www.Zappos.com" }).action).toBe("refund");
  });

  it("requires an in-stock, new offer at that store", () => {
    expect(lastCode(decide({}, {}, null))).toBe("offer_not_found");
    expect(lastCode(decide({}, {}, { availability: "OutOfStock", condition: "new" }))).toBe("out_of_stock");
    expect(lastCode(decide({}, {}, { availability: "InStock", condition: "used" }))).toBe("not_new");
    // Channel3 often reports condition as null; stock is what's checked then.
    expect(decide({}, {}, { availability: "InStock", condition: null }).action).toBe("refund");
  });

  it("requires the same canonical product and currency", () => {
    expect(lastCode(decide({ channel3ProductId: "other" }))).toBe("different_product");
    expect(lastCode(decide({ currency: "CAD" }))).toBe("currency_mismatch");
  });

  it("only counts prices seen inside the protection window", () => {
    expect(lastCode(decide({ observedAt: new Date("2026-11-25T00:00:00Z") }))).toBe("outside_window");
    expect(lastCode(decide({ observedAt: new Date("2026-11-09T00:00:00Z") }))).toBe("outside_window");
    expect(lastCode(decide({}, { status: "expired" }))).toBe("protection_inactive");
  });
});

describe("helpers", () => {
  it("builds a stable PayPal-Request-Id from protection and event", () => {
    expect(refundRequestId("p1", "e1")).toBe(refundRequestId("p1", "e1"));
    expect(refundRequestId("p1", "e1")).not.toBe(refundRequestId("p1", "e2"));
    const long = refundRequestId("77746999-3ff9-4fd4-a244-c01e07d105a4", "77746999-3ff9-4fd4-a244-c01e07d105a4");
    expect(long.length).toBeLessThanOrEqual(108);
  });

  it("matches approved domains and subdomains", () => {
    expect(isApprovedDomain("shop.rei.com", ["rei.com"])).toBe(true);
    expect(isApprovedDomain("rei.com.evil.io", ["rei.com"])).toBe(false);
  });

  it("parses Channel3 nanosecond timestamps as UTC", () => {
    expect(parseChannel3Time("2026-10-20T01:47:49.434643902")?.toISOString()).toBe("2026-10-20T01:47:49.434Z");
    expect(parseChannel3Time("2026-10-20T01:47:49Z")?.toISOString()).toBe("2026-10-20T01:47:49.000Z");
    expect(parseChannel3Time("yesterday")).toBeNull();
  });

  it("picks a simulated price about 20% under the price paid, ending in .99", () => {
    expect(simulatedDropCents(2799)).toBe(2199);
    expect(simulatedDropCents(44900)).toBe(35899);
  });

  it("draws a text sparkline", () => {
    expect(textSparkline([1, 2, 3, 4, 5, 6, 7, 8])).toBe("▁▂▃▄▅▆▇█");
    expect(textSparkline([25, 25, 25])).toBe("▄▄▄");
    expect(textSparkline([])).toBe("");
  });
});
