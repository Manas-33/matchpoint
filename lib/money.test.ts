import { describe, expect, it } from "vitest";
import { applyBps, centsToPaypalValue, dollarsToCents, formatCents, paypalValueToCents } from "./money";

describe("money", () => {
  it("rounds Channel3 float prices to cents", () => {
    expect(dollarsToCents(279.00000000000006)).toBe(27900);
    expect(dollarsToCents(369.95)).toBe(36995);
    expect(dollarsToCents(0.1 + 0.2)).toBe(30);
  });

  it("parses PayPal decimal strings without floats", () => {
    expect(paypalValueToCents("120.00")).toBe(12000);
    expect(paypalValueToCents("15.5")).toBe(1550);
    expect(paypalValueToCents("7")).toBe(700);
    expect(paypalValueToCents("-4.68")).toBe(-468);
    expect(() => paypalValueToCents("12.345")).toThrow();
    expect(() => paypalValueToCents("abc")).toThrow();
  });

  it("formats cents as PayPal values", () => {
    expect(centsToPaypalValue(12000)).toBe("120.00");
    expect(centsToPaypalValue(1505)).toBe("15.05");
    expect(centsToPaypalValue(9)).toBe("0.09");
    expect(() => centsToPaypalValue(12.5)).toThrow();
  });

  it("round-trips PayPal values", () => {
    for (const cents of [0, 1, 99, 100, 39899, 123456]) {
      expect(paypalValueToCents(centsToPaypalValue(cents))).toBe(cents);
    }
  });

  it("applies basis points with cent rounding", () => {
    expect(applyBps(39899, 1500)).toBe(5985);
    expect(applyBps(10000, 6000)).toBe(6000);
  });

  it("formats for display", () => {
    expect(formatCents(39899)).toBe("$398.99");
  });
});
