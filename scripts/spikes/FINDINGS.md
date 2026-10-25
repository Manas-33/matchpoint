# Phase 0 findings

What the spikes showed against the live APIs (Oct 2026). Fixtures for each point are in `fixtures/`.

## Channel3

- **Canonical IDs aren't unique per product.** Bose QC Ultra (2nd Gen) appears under 3 IDs and Sony WH-1000XM5 under 5 (`fixtures/channel3/search/`). A real competitor link usually resolves to a different ID from the shop's catalog product, so the same-product check can't be "IDs equal". Claude's judgment carries it.
- **`condition` is usually `null`** on links fetched in real time. Bose's refurbished page resolves to the new 2nd Gen product with `condition: null` (`lookup/bose-com-…`). Treat `null` as unknown, never as new; the URL path (`/refurbished/`) was the only signal.
- **Extraction can be wrong.** Sweetwater's Player II (maple) page came back titled "Stratocaster Electric Guitar", $99, rosewood. Code needs a price sanity check against the shop's price and history before any match.
- **Lookup failures to handle:** `500 Product extraction failed` (Best Buy bundle page, Sweetwater Player Strat) and `422 URL is not a product page` (REI Garmin). Both go to staff review.
- **Variants are often missing** (`variants: null`) outside a few catalog products.
- **Prices are floats** (`279.00000000000006`). Round to integer cents on the way in.
- **Search offer URLs are affiliate redirects** (`buy.trychannel3.com/…`), not retailer URLs.
- **Price history is per product, not per store.** Points are `{timestamp, price, currency}` with no domain, daily, up to 90 days, and they include outliers ($29 points for a $449 headphone). `current_status` said "typical" throughout. The glitch check needs its own outlier handling and can't use `min_price` directly; per-store "approved store dropped its price" has to come from offers or `price.changed`, not history.
- **SDK differs from its README:** class `Channel3`, snake_case fields, `priceTracking.retrieveHistory`, `products.findSimilar`. Timestamps deserialize to `Date`.
- **Webhooks:** the event catalog is still unpublished; signing is unknown.

## Claude (claude-sonnet-5-5, structured outputs)

- All six pairs were schema-valid and matched expectations, including the refurbished page (caught from the URL) and the mislabelled B&H listing (caught from the description). About 24k input and 5k output tokens in total.
- **`condition_ok` comes back `false` whenever condition is unknown**, which is most real links. For Phase 3, make it a three-way value (`new` / `not_new` / `unknown`) and let policy decide what `unknown` means.
- Pass the offer at the linked store separately (`linked_offer`): a lookup returns the canonical product with every store's offers.

## PayPal (sandbox, Server SDK 2.5)

- Create → buyer approval → capture → partial refund works. The capture ends `PARTIALLY_REFUNDED`.
- Webhook signatures verify with `POST /v1/notifications/verify-webhook-signature` (not in the SDK) when the raw body is passed through unchanged. `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED` and `PAYMENT.CAPTURE.REFUNDED` all arrived within a minute or two.
- Cloudflare quick tunnels are blocked on the dev network; ngrok works.
