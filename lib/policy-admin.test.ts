import { describe, expect, it } from "vitest";
import type { Policy } from "./db/schema";
import { DEFAULT_POLICY } from "./policy";
import { describeChanges, normalizeDomain, parsePolicyForm, policyToFields } from "./policy-admin";

const v1 = { ...DEFAULT_POLICY, id: "p1", version: 1, channel3CollectionId: "C1", createdBy: "seed", createdAt: new Date() } as Policy;

describe("normalizeDomain", () => {
  it("reduces links and casing to a bare domain", () => {
    expect(normalizeDomain("https://www.REI.com/product/123")).toBe("rei.com");
    expect(normalizeDomain(" bestbuy.com ")).toBe("bestbuy.com");
    expect(normalizeDomain("shop.example.co.uk")).toBe("shop.example.co.uk");
  });
  it("rejects things that aren't domains", () => {
    expect(normalizeDomain("not a store")).toBeNull();
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("")).toBeNull();
  });
});

describe("parsePolicyForm", () => {
  it("round-trips the current policy through the form's units", () => {
    const parsed = parsePolicyForm(policyToFields(v1));
    expect(parsed).toEqual({ ok: true, value: { ...DEFAULT_POLICY, approvedDomains: DEFAULT_POLICY.approvedDomains } });
  });

  it("turns percentages into basis points and dollars into cents", () => {
    const parsed = parsePolicyForm({
      ...policyToFields(v1),
      marginFloorBps: "12.5",
      maxDiscountBps: "10",
      autoRefundCapCents: "75.50",
      approvedDomains: "https://www.bestbuy.com/x, rei.com\nREI.com",
    });
    expect(parsed.ok && parsed.value).toMatchObject({
      marginFloorBps: 1250,
      maxDiscountBps: 1000,
      autoRefundCapCents: 7550,
      approvedDomains: ["bestbuy.com", "rei.com"],
    });
  });

  it("names every field that's wrong", () => {
    const parsed = parsePolicyForm({ ...policyToFields(v1), maxDiscountBps: "120", protectionDays: "two weeks", approvedDomains: "  " });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toEqual(
        expect.arrayContaining([
          "Maximum discount: must be between 0 and 90%",
          "Protection window: enter a whole number of days",
          "Approved stores: list at least one store",
        ]),
      );
    }
  });
});

describe("describeChanges", () => {
  it("lists only what changed, in words", () => {
    const parsed = parsePolicyForm({ ...policyToFields(v1), maxDiscountBps: "10", approvedDomains: [...v1.approvedDomains.filter((d) => d !== "target.com"), "costco.com"].join("\n") });
    expect(parsed.ok && describeChanges(v1, parsed.value)).toEqual(["Maximum discount: 20% → 10%", "Approved stores: added costco.com; removed target.com"]);
  });
  it("is empty when nothing changed", () => {
    const parsed = parsePolicyForm(policyToFields(v1));
    expect(parsed.ok && describeChanges(v1, parsed.value)).toEqual([]);
  });
});
