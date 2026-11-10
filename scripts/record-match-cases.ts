// Record the scripted "Found it cheaper?" demo cases (lib/match/demo-cases.ts) so demo mode replays them:
// the Channel3 lookup, price history and `similar` responses, and Claude's same-product judgment.
//
//   npm run match:record      live Channel3 + Claude; writes fixtures/channel3/{lookup,history,similar}
//                             and fixtures/claude/match-*.json
//
// Real cases are recorded as returned. The constructed case (a one-day low) starts from the real lookup
// of its URL and then replaces the price, the product ID and the price history by hand; every file it
// writes says so in a top-level "_constructed" field.
import "./load-env";
import { createHash } from "node:crypto";
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getChannel3, normalizeUrl, type Product } from "@/lib/channel3";
import { getClaude } from "@/lib/claude";
import { getEnv } from "@/lib/env";
import { FIXTURES_DIR, loadFixture, saveFixture, slug } from "@/lib/fixtures";
import { DEMO_CASES, type DemoCase } from "@/lib/match/demo-cases";

if (getEnv().DEMO_MODE) throw new Error("Run this in live mode: it records live responses.");

const c3 = getChannel3();
const claude = getClaude();

// The glitch case: Crutchfield's real listing, at a price that (in the constructed history) lasted one day.
const GLITCH_PRICE = 329.99;
const GLITCH_PRODUCT_ID = "XglitcH";
const CONSTRUCTED_NOTE =
  "CONSTRUCTED for the demo, not a recorded API response: a one-day pricing glitch. Based on the real Channel3 lookup of this URL; the offer price, canonical product ID and price history were set by hand.";

const lookupPath = (url: string, title: string) => {
  const domain = new URL(url).hostname.replace(/^www\./, "");
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 6);
  return `channel3/lookup/${slug(domain)}-${slug(title).slice(0, 30)}-${hash}`;
};

// Remove earlier recordings of this URL (titles can change between lookups, and so would the file name).
function removeLookupsOf(url: string) {
  const dir = join(FIXTURES_DIR, "channel3/lookup");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const fx = loadFixture<{ url: string }>(`channel3/lookup/${f}`);
    if (normalizeUrl(fx.url) === normalizeUrl(url)) unlinkSync(join(dir, f));
  }
}

// 90 days, mostly $449 with short $429/$399 promotions, and the glitch price on the last day only.
function constructedHistory() {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const history = Array.from({ length: 90 }, (_, i) => {
    const day = 89 - i;
    const timestamp = new Date(today.getTime() - day * 86_400_000).toISOString();
    const price = day === 0 ? GLITCH_PRICE : day % 17 < 3 ? 399 : day % 11 < 2 ? 429 : 449;
    return { timestamp, price, currency: "USD" };
  });
  const prices = history.map((h) => h.price);
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  return {
    _constructed: CONSTRUCTED_NOTE,
    canonical_product_id: GLITCH_PRODUCT_ID,
    product_title: "Bose QuietComfort Ultra Wireless Noise-Canceling Headphones (2nd Gen)",
    history,
    statistics: {
      mean: Math.round(mean * 100) / 100,
      std_dev: null,
      min_price: Math.min(...prices),
      max_price: Math.max(...prices),
      current_price: GLITCH_PRICE,
      current_status: "low",
      currency: "USD",
    },
  };
}

async function record(shopId: string, demo: DemoCase) {
  console.log(`\n${shopId} · ${demo.label}: ${demo.url}`);
  const shop = loadFixture<{ url: string; product: Product }>(`channel3/catalog/${shopId}`);
  let product = await c3.lookup(demo.url);
  console.log(`  lookup: ${product.id} ${product.title}`);
  removeLookupsOf(demo.url);

  if (demo.constructed) {
    const realId = product.id;
    product = {
      ...product,
      id: GLITCH_PRODUCT_ID,
      // Only the linked store's offer changes; the other stores keep their real prices.
      offers: (product.offers ?? []).map((o) =>
        o.domain === "crutchfield.com" ? { ...o, price: { ...o.price, price: GLITCH_PRICE } } : o,
      ),
    };
    const real = await c3.findSimilar(realId, 20).catch(() => []);
    saveFixture(`channel3/similar/${GLITCH_PRODUCT_ID}`, {
      _constructed: `CONSTRUCTED: the real Channel3 \`similar\` response for the Crutchfield listing's real product (${realId}), filed under the constructed product ID.`,
      products: real,
    });
    saveFixture(`channel3/history/${GLITCH_PRODUCT_ID}`, constructedHistory());
    saveFixture(`${lookupPath(demo.url, product.title)}-constructed`, { _constructed: CONSTRUCTED_NOTE, url: demo.url, product });
  } else {
    saveFixture(lookupPath(demo.url, product.title), { url: demo.url, product });
    for (const id of new Set([product.id, shopId])) {
      try {
        saveFixture(`channel3/history/${id}`, await c3.priceHistory(id));
        console.log(`  history: ${id}`);
      } catch (err) {
        console.log(`  history ${id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    const similar = await c3.findSimilar(product.id, 20).catch(() => []);
    saveFixture(`channel3/similar/${product.id}`, { products: similar });
    console.log(`  similar: ${similar.length}`);
  }

  const judgment = await claude.judgeSameProduct(shop, { url: demo.url, product });
  if (judgment.outcome !== "ok") throw new Error(`Claude gave no judgment: ${judgment.reason}`);
  const d = judgment.decision;
  console.log(
    `  claude: same=${d.same_product} variant=${d.variant_match} condition=${d.condition} bundle=${d.bundle_or_accessory} year=${d.model_year_mismatch} conf=${d.confidence}`,
  );
  const competitorFile = `${lookupPath(demo.url, product.title)}${demo.constructed ? "-constructed" : ""}.json`;
  saveFixture(`claude/match-${slug(demo.label)}`, {
    ...(demo.constructed ? { _constructed: "Real Claude judgment of the CONSTRUCTED competitor listing above." } : {}),
    model: judgment.model,
    shop_fixture: `fixtures/channel3/catalog/${shopId}.json`,
    competitor_fixture: `fixtures/${competitorFile}`,
    outcome: judgment.outcome,
    decision: d,
    usage: judgment.usage,
  });
}

for (const [shopId, cases] of Object.entries(DEMO_CASES)) {
  for (const demo of cases) await record(shopId, demo);
}
console.log("\nDone. Check `git status fixtures/`.");
