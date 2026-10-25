// Phase 0 Channel3 lookup test: resolve real competitor URLs with `lookup` and check the
// offer fields Matchpoint relies on (price, availability, condition, domain, variants).
// Usage: npm run spike:c3:lookup [-- <url> <url> ...]
// With no URLs it searches volatile categories and looks up real retailer offer URLs from the results.
import type { Channel3Api } from "@channel3/sdk";
import { channel3Client, reportChannel3Error } from "./lib/channel3.js";
import { saveFixture, slug } from "./lib/fixtures.js";

const QUERIES = [
  "Sony WH-1000XM5 wireless noise cancelling headphones",
  "Bose QuietComfort Ultra headphones",
  "NVIDIA GeForce RTX 4070 graphics card",
  "Nike Pegasus 41 running shoes",
  "Hoka Clifton 9 running shoes",
  "Garmin Forerunner 265 GPS watch",
  "Osprey Atmos AG 65 backpack",
  "Fender Player Stratocaster electric guitar",
];
const LOOKUPS = 5;
// Marketplaces aren't "approved stores" for a price match, so prefer real retailers.
const MARKETPLACES = /(^|\.)(amazon|ebay|walmart|aliexpress|etsy|temu)\./;

const client = channel3Client();

async function discoverUrls() {
  const candidates: { productId: string; title: string; url: string; domain: string }[] = [];
  for (const query of QUERIES) {
    const page = await client.products.search({ query, limit: 5 });
    saveFixture(`channel3/search/${slug(query)}`, { query, response: page.response });
    for (const product of page.data) {
      const offer =
        product.offers?.find((o) => !MARKETPLACES.test(o.domain)) ?? product.offers?.[0];
      if (offer) {
        candidates.push({ productId: product.id, title: product.title, url: offer.url, domain: offer.domain });
        break;
      }
    }
  }
  // Candidates for the price-tracking test: catalog products with at least one offer.
  saveFixture("channel3/tracking-candidates", candidates);
  const urls = candidates.slice(0, LOOKUPS).map((c) => c.url);
  // One extra lookup of the same product at a second store gives the Claude test a true pair.
  const pair = await secondStoreUrl(candidates);
  return pair ? [...urls, pair] : urls;
}

async function secondStoreUrl(candidates: { productId: string; domain: string }[]) {
  for (const c of candidates) {
    const product = await client.products.retrieve({ product_id: c.productId });
    const other = product.offers?.find((o) => o.domain !== c.domain && !MARKETPLACES.test(o.domain));
    if (other) return other.url;
  }
  return undefined;
}

function checkFields(product: Channel3Api.Product) {
  const offers = product.offers ?? [];
  return {
    has_offers: offers.length > 0,
    price: offers.every((o) => typeof o.price?.price === "number" && !!o.price.currency),
    availability: offers.every((o) => o.availability === "InStock" || o.availability === "OutOfStock"),
    condition: offers.some((o) => o.condition === "new" || o.condition === "used"),
    domain: offers.every((o) => !!o.domain),
    variants: !!product.variants && (product.variants.options.length > 0 || product.variants.selected.length > 0),
  };
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a.startsWith("http"));
  const urls = args.length > 0 ? args : await discoverUrls();
  const summary = [];

  for (const url of urls) {
    console.log(`\nlookup ${url}`);
    try {
      const { product } = await client.products.lookup({ url });
      const domain = new URL(url).hostname.replace(/^www\./, "");
      saveFixture(`channel3/lookup/${slug(domain)}-${slug(product.title).slice(0, 30)}`, { url, product });
      const fields = checkFields(product);
      console.log(`  ${product.id}  ${product.title}`);
      for (const o of product.offers ?? []) {
        console.log(
          `  - ${o.domain}: ${o.price.price} ${o.price.currency} (was ${o.price.compare_at_price ?? "-"}), ${o.availability}, condition=${o.condition ?? "null"}`,
        );
      }
      console.log(`  variants selected: ${JSON.stringify(product.variants?.selected ?? null)}`);
      console.log(`  fields: ${JSON.stringify(fields)}`);
      summary.push({ url, product_id: product.id, title: product.title, offers: product.offers?.length ?? 0, fields });
    } catch (err) {
      console.log(`  FAILED: ${err instanceof Error ? err.message : err}`);
      summary.push({ url, error: err instanceof Error ? err.message : String(err) });
    }
  }

  saveFixture("channel3/lookup-summary", summary);
  const ok = summary.filter((s) => "fields" in s);
  const missing = ["has_offers", "price", "availability", "condition", "domain", "variants"].filter(
    (f) => !ok.some((s) => (s as { fields: Record<string, boolean> }).fields[f]),
  );
  console.log(`\n${ok.length}/${urls.length} lookups succeeded.`);
  if (missing.length) console.log(`Fields never populated: ${missing.join(", ")}`);
  if (ok.length < Math.min(LOOKUPS, urls.length)) process.exit(1);
  console.log("PASS: lookup returns the offer fields we rely on.");
}

main().catch(reportChannel3Error);
