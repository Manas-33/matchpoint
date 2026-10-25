# Matchpoint

**An AI pricing agent for independent shops.** It matches a competitor's price at checkout and protects the customer if the price drops after the sale. Every decision is checked against real product data from Channel3 and settled in PayPal.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com).

---

## The problem

A customer is standing in a local bike, outdoor or music shop. They look up the same item on their phone and see it $20 cheaper online.

Big chains have price-match and price-protection policies backed by pricing teams. An independent shop has none of that:

- Staff search on a phone and guess whether it's really the same item (same model? same colour? new or used? a bundle?).
- Fake screenshots and marketplace listings make it worse.
- No one has time to watch prices after a sale, so the shop can't offer "we'll refund you if it drops".
- The customer walks out, or waits for a sale somewhere else.

## Who it's for

Independent retailers selling branded goods that are also sold online: bikes, outdoor gear, instruments, electronics, kitchenware. The owner wants to compete on trust without giving away margin.

## How it works

### The shop's policy (set once)
- **Approved stores** to match against (for example major outdoor retailers, but not marketplace sellers).
- **Margin floor** and a **maximum discount**.
- **Protection window** (for example 14 days).
- **How much the agent decides on its own:** refund automatically up to $X, and ask the owner above that.

### Act 1: Match at checkout
1. The customer, or a staff member, pastes a competitor's link.
2. The agent looks it up in **Channel3** to confirm it's the same product, variant and condition, that it's in stock, and that the seller is an approved store.
3. It checks **price history**. Is that price normal, or a one-day glitch?
4. It applies the shop's policy and either:
   - **matches**, creating a **PayPal order** at the matched price, which the customer pays; or
   - **declines with a reason** ("that's a bundle", "last year's model", "used listing", "out of stock") and suggests an equivalent the shop stocks.

### Act 2: Protect after the sale
1. Products that have been sold are tracked through Channel3 for price changes.
2. When an approved store drops the price within the window, the agent checks the policy.
3. Under the limit, it issues a **PayPal partial refund** automatically. Over the limit, it asks the owner.
4. The customer receives an **evidence card** by email: both prices, dates, the price-history chart, the refund amount and the PayPal refund ID.

### Why a shop would refund automatically
Price protection is a **conversion tool**. "Buy today, and if it drops we'll cover it" stops customers from leaving to wait for a sale. The policy caps the cost. The dashboard shows the trade-off: **sales covered by protection vs refunds paid out**.

## How it's built

| Piece | Role |
|---|---|
| **AI (Claude)** | Judges whether two listings are the same product, reasons over the shop's policy, explains every decision, and flags suspicious match attempts. Money calculations stay in deterministic code; the model only judges and explains. |
| **Channel3** | Turns any competitor URL into a canonical product (`lookup`), supplies offers (price, condition, availability, store), price history with a low/typical/high status, price tracking and `price.changed` events, approved-store Collections, and `similar` for alternatives. |
| **PayPal** | Creates and captures the order at the matched price (Orders v2), issues partial refunds (Refunds), and sends payment events by webhook. Built on the PayPal Server SDK. |
| **APIMatic** | The PayPal Server SDK is APIMatic-generated, and the integration is built with APIMatic's PayPal Context Plugin. |

## Scope

**v1**
- A demo shop catalog of about a dozen products.
- One product page, one checkout, a merchant policy page and a ledger page.
- Match verification with a matched PayPal order, plus clear decline cases.
- Price tracking on sold items and automatic partial refunds under the policy, with a daily price-history check as a fallback.
- The customer evidence card (email and web page).
- The "sales covered vs refunds paid" view.
- A ledger fed by PayPal webhooks.

**Next**
1. A `request_price_match` MCP tool, so a shopper's own AI agent can ask the shop's agent for a match and receive a ready-to-pay PayPal order.
2. A public Matchpoint API, with SDKs and docs, so shops can add it to their own storefronts.

**Not planned**
- Repricing the shop's own catalog.
- A full storefront.

## Notes

- Price protection covers products that Channel3 can verify and track.
- Buy links from Channel3 carry a commission disclosure.

## References

- Channel3 docs: https://docs.trychannel3.com
- PayPal Orders v2: https://developer.paypal.com/docs/api/orders/v2/
- PayPal webhooks: https://developer.paypal.com/api/rest/webhooks/
- PayPal Server SDK (TypeScript): https://github.com/paypal/PayPal-TypeScript-Server-SDK
