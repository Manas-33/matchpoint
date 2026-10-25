// Phase 0 Channel3 lookup test: resolve real competitor URLs with `lookup` and check the
// offer fields Matchpoint relies on (price, availability, condition, domain, variants).
// Usage: npm run spike:c3:lookup [-- <url> <url> ...]
// With no URLs it looks up COMPETITOR_URLS. It also searches volatile categories once to pick
// catalog products for the price-tracking test (skipped when that fixture already exists).
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { Channel3Api } from "@channel3/sdk";
import { channel3Client, reportChannel3Error } from "./lib/channel3.js";
import { saveFixture, slug } from "./lib/fixtures.js";

// Real retailer product pages, as a customer would paste them. Several are deliberate
// hard cases for the match engine: a bundle, a refurbished unit and a newer model generation.
const COMPETITOR_URLS = [
  "https://www.bestbuy.com/site/sony-wh-1000xm5-wireless-noise-canceling-headphones-black/6505727.p",
  "https://www.bestbuy.com/product/sony-wh-1000xm5-wireless-over-ear-headphones-black-with-bluetooth-speaker/JJG2F3TP9K",
  "https://www.bhphotovideo.com/c/product/1919545-REG/bose_890101_0100_quietcomfort_ultra_wireless_noise.html",
  "https://www.bose.com/p/refurbished/bose-quietcomfort-ultra-headphones-2nd-gen/QCUH2-HEADPHONEARN-FR.html",
  "https://www.rei.com/product/201302/osprey-atmos-ag-65-pack-mens",
  "https://www.rei.com/product/225589/garmin-forerunner-265",
  "https://www.sweetwater.com/store/detail/StratPMBLK--fender-player-series-stratocaster-black-with-maple-fingerboard",
  "https://www.sweetwater.com/store/detail/StratP2MBK--fender-player-ii-stratocaster-electric-guitar-black-with-maple-fingerboard",
];
const MIN_OK = 5;

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
// Marketplaces aren't "approved stores" for a price match, so prefer real retailers.
const MARKETPLACES = /(^|\.)(amazon|ebay|walmart|aliexpress|etsy|temu)\./;

const client = channel3Client();

async function findTrackingCandidates() {
  if (existsSync("fixtures/channel3/tracking-candidates.json")) return;
  const candidates: { productId: string; title: string; domain: string }[] = [];
  for (const query of QUERIES) {
    const page = await client.products.search({ query, limit: 5 });
    saveFixture(`channel3/search/${slug(query)}`, { query, response: page.response });
    const product = page.data.find((p) => p.offers?.some((o) => !MARKETPLACES.test(o.domain)));
    if (product) candidates.push({ productId: product.id, title: product.title, domain: product.offers![0].domain });
  }
  saveFixture("channel3/tracking-candidates", candidates);
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
  await findTrackingCandidates();
  const args = process.argv.slice(2).filter((a) => a.startsWith("http"));
  const urls = args.length > 0 ? args : COMPETITOR_URLS;
  const summary = [];

  for (const url of urls) {
    console.log(`\nlookup ${url}`);
    try {
      const { product } = await client.products.lookup({ url, realtime_fetch: true });
      const domain = new URL(url).hostname.replace(/^www\./, "");
      const hash = createHash("sha1").update(url).digest("hex").slice(0, 6);
      saveFixture(`channel3/lookup/${slug(domain)}-${slug(product.title).slice(0, 30)}-${hash}`, { url, product });
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
  if (ok.length < Math.min(MIN_OK, urls.length)) process.exit(1);
  console.log("PASS: lookup returns the offer fields we rely on.");
}

main().catch(reportChannel3Error);
