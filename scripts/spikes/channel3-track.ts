// Phase 0 Channel3 price-tracking test: start tracking volatile catalog products,
// list subscriptions, and read price history (with low/typical/high status).
// Usage: npm run spike:c3:track [-- <canonical_product_id> ...]
// With no IDs it uses fixtures/channel3/tracking-candidates.json from the lookup test.
import { channel3Client, reportChannel3Error } from "./lib/channel3.js";
import { loadFixture, saveFixture } from "./lib/fixtures.js";

const MAX_TRACKED = 10;
const client = channel3Client();

function productIds(): string[] {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (args.length > 0) return args;
  try {
    const candidates = loadFixture<{ productId: string }[]>("channel3/tracking-candidates.json");
    return [...new Set(candidates.map((c) => c.productId))].slice(0, MAX_TRACKED);
  } catch {
    console.error("No product IDs. Run `npm run spike:c3:lookup` first or pass IDs as arguments.");
    process.exit(2);
  }
}

async function main() {
  const ids = productIds();
  const started = [];
  for (const id of ids) {
    try {
      const sub = await client.priceTracking.start({ canonical_product_id: id });
      console.log(`tracking ${id}: ${sub.subscription_status}`);
      started.push(sub);
    } catch (err) {
      console.log(`tracking ${id}: FAILED ${err instanceof Error ? err.message : err}`);
      started.push({ canonical_product_id: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  saveFixture("channel3/tracking/start", started);

  const subs = [];
  for await (const sub of await client.priceTracking.listSubscriptions()) subs.push(sub);
  saveFixture("channel3/tracking/subscriptions", subs);
  console.log(`\n${subs.length} active subscriptions.`);

  let withHistory = 0;
  for (const id of ids) {
    try {
      const history = await client.priceTracking.retrieveHistory({ canonical_product_id: id });
      saveFixture(`channel3/history/${id}`, history);
      const s = history.statistics;
      const points = history.history?.length ?? 0;
      if (points > 0) withHistory++;
      console.log(
        `history ${id}: ${points} points` +
          (s ? `, current ${s.current_price} ${s.currency} is ${s.current_status} (mean ${s.mean.toFixed(2)}, min ${s.min_price}, max ${s.max_price})` : ", no statistics yet"),
      );
    } catch (err) {
      console.log(`history ${id}: FAILED ${err instanceof Error ? err.message : err}`);
    }
  }

  const ok = started.filter((s) => !("error" in s)).length;
  console.log(`\n${ok}/${ids.length} tracked, ${withHistory}/${ids.length} with history.`);
  if (ok < Math.min(5, ids.length)) process.exit(1);
  console.log("PASS: tracking started and price history read. Wait for price.changed on the webhook receiver.");
}

main().catch(reportChannel3Error);
