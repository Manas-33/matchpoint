// Value match: pick the counter-offer to make before a cash price match. Pure money maths in integer cents.
import type { Cents } from "../money";
import type { ValueOfferRule } from "../policy";

export type ValueOffer = {
  id: string;
  kind: ValueOfferRule["kind"];
  title: string;
  description: string;
  // What the customer gets, in their terms (credit amount or the service's price).
  customerValueCents: Cents;
  // What it costs the shop. Store credit is redeemed against goods, so it costs the unit-cost share of it.
  shopCostCents: Cents;
  // The cash discount it replaces.
  insteadOfCents: Cents;
};

export function priceOffer(
  rule: ValueOfferRule,
  cashDiscountCents: Cents,
  shopPriceCents: Cents,
  unitCostCents: Cents,
): ValueOffer {
  const base = { id: rule.id, kind: rule.kind, title: rule.title, description: rule.description, insteadOfCents: cashDiscountCents };
  if (rule.kind === "service") {
    return { ...base, customerValueCents: rule.valueCents, shopCostCents: rule.shopCostCents };
  }
  // Whole dollars of credit, rounded up.
  const credit = Math.ceil((cashDiscountCents * rule.creditBps) / 10_000 / 100) * 100;
  return { ...base, customerValueCents: credit, shopCostCents: Math.ceil((credit * unitCostCents) / shopPriceCents) };
}

// The cheapest-to-the-shop offer that is worth at least the cash discount to the customer and costs the
// shop less than the cash discount would. Ties go to the one worth more to the customer. null: just match.
export function chooseValueOffer(
  rules: ValueOfferRule[],
  cashDiscountCents: Cents,
  shopPriceCents: Cents,
  unitCostCents: Cents,
): ValueOffer | null {
  if (cashDiscountCents <= 0) return null;
  const candidates = rules
    .map((r) => priceOffer(r, cashDiscountCents, shopPriceCents, unitCostCents))
    .filter((o) => o.customerValueCents >= cashDiscountCents && o.shopCostCents < cashDiscountCents)
    .sort((a, b) => a.shopCostCents - b.shopCostCents || b.customerValueCents - a.customerValueCents);
  return candidates[0] ?? null;
}

// The match_requests.reasons entry that holds the counter-offer made with a match, so checkout honours
// exactly what was offered.
export const VALUE_OFFER_CODE = "value_offer";
export function savedValueOffer(reasons: unknown): ValueOffer | null {
  const list = Array.isArray(reasons) ? (reasons as { code?: string; offer?: ValueOffer }[]) : [];
  return list.find((r) => r?.code === VALUE_OFFER_CODE)?.offer ?? null;
}
