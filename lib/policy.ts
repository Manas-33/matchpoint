import type { NewPolicy } from "./db/schema";
import type { Cents } from "./money";

// Major retailers the shop matches and protects against: national and specialty chains across the
// shop's categories. Marketplaces (Amazon, eBay, Walmart marketplace sellers) are deliberately absent.
export const DEFAULT_APPROVED_DOMAINS = [
  "bestbuy.com",
  "bhphotovideo.com",
  "crutchfield.com",
  "adorama.com",
  "abt.com",
  "target.com",
  "rei.com",
  "backcountry.com",
  "dickssportinggoods.com",
  "scheels.com",
  "zappos.com",
  "sweetwater.com",
  "guitarcenter.com",
  "musicarts.com",
  "williams-sonoma.com",
  "surlatable.com",
  "crateandbarrel.com",
  "competitivecyclist.com",
];

// Version 1 of the shop's policy. Rates are basis points, amounts are cents.
export const DEFAULT_POLICY = {
  approvedDomains: DEFAULT_APPROVED_DOMAINS,
  marginFloorBps: 1500, // a matched price must keep at least a 15% gross margin
  maxDiscountBps: 2000, // match at most 20% below the shop price
  protectionDays: 14,
  autoRefundCapCents: 5000, // refund up to $50 automatically, ask the owner above that
  minRefundCents: 100, // ignore drops under $1
  glitchAction: "decline",
  unknownConditionAction: "review",
} satisfies Omit<NewPolicy, "version">;

export type MatchLimits = Pick<NewPolicy, "marginFloorBps" | "maxDiscountBps">;

// The lowest price the shop can match at: it keeps the margin floor over unit cost and is at most the
// maximum discount below the shop price. Rounded up to the cent, so the limits are never crossed.
export function lowestMatchPriceCents(
  shopPriceCents: Cents,
  unitCostCents: Cents,
  { marginFloorBps, maxDiscountBps }: MatchLimits,
): Cents {
  const marginFloor = Math.ceil((unitCostCents * 10_000) / (10_000 - marginFloorBps));
  const maxDiscount = Math.ceil((shopPriceCents * (10_000 - maxDiscountBps)) / 10_000);
  return Math.max(marginFloor, maxDiscount);
}
