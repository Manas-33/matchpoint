// Seed the demo shop: about 12 Channel3 catalog products with complete variant data, each with a shop
// price and unit cost; the approved-stores Collection in Channel3; and the default policy.
//
//   npm run seed                live: refresh the chosen products from Channel3 and upsert them
//   npm run seed -- --pick      live: re-check the chosen products, replace any that no longer qualify
//                               (searches Channel3), then seed. Delete fixtures/seed/catalog.json
//                               to choose all of them from scratch.
//   npm run seed -- --record    live: also overwrite the recorded fixtures with fresh responses
//                               (otherwise only missing fixtures are written)
//   npm run seed:demo           demo: seed from fixtures/ only, no API keys or network
//   add --reset to empty every table first
//
// The chosen product IDs live in fixtures/seed/catalog.json, so live and demo seed the same catalog.
import "./load-env";
import { and, desc, notInArray, sql } from "drizzle-orm";
import { getChannel3, type Channel3Service, type Collection, type Product } from "@/lib/channel3";
import { hasCompleteVariants, isFullySelected, newInStockOffers, toProductRow } from "@/lib/catalog";
import { closeDb, getDb, schema } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { hasFixture, loadFixture, saveFixture } from "@/lib/fixtures";
import { dollarsToCents, formatCents } from "@/lib/money";
import { DEFAULT_APPROVED_DOMAINS, DEFAULT_POLICY, lowestMatchPriceCents } from "@/lib/policy";

const args = new Set(process.argv.slice(2));
const PICK = args.has("--pick");
const RECORD = args.has("--record");
const RESET = args.has("--reset");

const TARGET = 12;
const CATALOG_FIXTURE = "seed/catalog";
const COLLECTION_FIXTURE = "channel3/collections/approved-stores";

// Kept when they still qualify: Phase 0 recorded competitor lookups and Claude judgments against them.
const PREFERRED_IDS = ["mgo7x7F", "3FRZAlJ"];

// Branded goods an independent bike, outdoor, music, electronics or kitchen shop would stock.
const QUERIES = [
  "Sony WH-1000XM5 wireless headphones",
  "Fender Player II Stratocaster electric guitar",
  "Patagonia Nano Puff jacket",
  "Hoka Clifton running shoes",
  "Garmin Forerunner GPS running watch",
  "Black Diamond headlamp",
  "Hydro Flask insulated water bottle",
  "Yeti Rambler tumbler",
  "Le Creuset enameled cast iron Dutch oven",
  "Shure SM58 microphone",
  "Audio-Technica ATH-M50x headphones",
  "Giro cycling helmet",
  "Salomon hiking shoes",
  "Arc'teryx jacket",
  "Lodge cast iron skillet",
  "Taylor acoustic guitar",
  "Smartwool merino socks",
  "Garmin Edge bike computer",
  "KitchenAid stand mixer",
  "Brooks Ghost running shoes",
  "Patagonia Better Sweater fleece",
  "The North Face ThermoBall jacket",
  "Merrell Moab hiking shoes",
  "Darn Tough hiking socks",
  "Stanley Quencher tumbler",
  "Osprey Talon daypack",
  "Bell bike helmet",
  "Fjallraven Kanken backpack",
];

type SeedCatalog = {
  picked_at: string;
  criteria: string;
  products: { id: string; title: string; source: string }[];
};

const approvedOffers = (p: Product, domains: string[]) => newInStockOffers(p, domains).length;

function qualifies(p: Product, domains: string[]) {
  return hasCompleteVariants(p) && approvedOffers(p, domains) > 0 && (p.images?.length ?? 0) > 0;
}

// Choose the catalog from live Channel3 data: one product per query, preferring products whose every
// variant option is selected and that more approved stores sell. Earlier picks that still qualify are
// kept, and the queries that found them aren't searched again.
async function pickCatalog(c3: Channel3Service, domains: string[], previous?: SeedCatalog): Promise<SeedCatalog> {
  const picked = new Map<string, { title: string; source: string }>();
  const start = previous?.products ?? PREFERRED_IDS.map((id) => ({ id, source: "preferred" }));
  for (const { id, source } of start) {
    const p = await c3.retrieve(id).catch(() => undefined);
    if (p && qualifies(p, domains)) picked.set(p.id, { title: p.title, source });
    console.log(`  ${picked.has(id) ? "+" : "-"} ${id} (${previous ? "kept" : source}) ${p?.title ?? "not found"}`);
  }
  const searched = new Set([...picked.values()].map((v) => v.source));
  for (const query of QUERIES) {
    if (picked.size >= TARGET) break;
    if (searched.has(query)) continue;
    const results = await c3.search(query, { limit: 10, filters: { website_ids: domains } });
    const candidates = results
      .filter((p) => qualifies(p, domains) && !picked.has(p.id))
      .sort(
        (a, b) =>
          Number(isFullySelected(b)) - Number(isFullySelected(a)) ||
          approvedOffers(b, domains) - approvedOffers(a, domains),
      );
    // Search hits can carry offers that the product itself doesn't, so check what retrieve returns.
    let best: Product | undefined;
    for (const candidate of candidates.slice(0, 3)) {
      const p = await c3.retrieve(candidate.id).catch(() => undefined);
      if (p && qualifies(p, domains)) {
        best = p;
        break;
      }
    }
    if (best) picked.set(best.id, { title: best.title, source: query });
    console.log(
      `  ${best ? "+" : "-"} "${query}": ${best ? `${best.id} ${best.title}` : `none of ${results.length} qualify (${candidates.length} on search data)`}`,
    );
  }
  return {
    picked_at: new Date().toISOString(),
    criteria:
      "Channel3 search filtered to approved stores; complete variant data (every option has values, selected variant named); in stock and not used at an approved store; has an image.",
    products: [...picked].map(([id, v]) => ({ id, ...v })),
  };
}

async function loadProducts(c3: Channel3Service, catalog: SeedCatalog, live: boolean): Promise<Product[]> {
  const products: Product[] = [];
  for (const { id } of catalog.products) {
    const path = `channel3/catalog/${id}`;
    try {
      const product = await c3.retrieve(id);
      if (live && (RECORD || !hasFixture(path))) saveFixture(path, { url: `channel3:${id}`, product });
      products.push(product);
    } catch (err) {
      if (!live || !hasFixture(path)) throw err;
      console.warn(`  ! ${id}: live retrieve failed (${(err as Error).message}); using the recorded fixture`);
      products.push(loadFixture<{ product: Product }>(path).product);
    }
  }
  return products;
}

async function main() {
  const env = getEnv();
  const live = !env.DEMO_MODE;
  const c3 = getChannel3();
  const db = getDb();
  console.log(`Seeding in ${live ? "LIVE" : "DEMO"} mode${RESET ? " (reset)" : ""}`);

  if (RESET) {
    await db.execute(
      sql`truncate refunds, protections, ledger_events, price_events, orders, match_requests, products, policies`,
    );
    console.log("Emptied all tables.");
  }

  const [latestPolicy] = await db.select().from(schema.policies).orderBy(desc(schema.policies.version)).limit(1);
  const domains = latestPolicy?.approvedDomains ?? DEFAULT_APPROVED_DOMAINS;

  // 1. Catalog
  let catalog: SeedCatalog;
  if (live && (PICK || !hasFixture(CATALOG_FIXTURE))) {
    console.log("Choosing products from Channel3:");
    const previous = hasFixture(CATALOG_FIXTURE) ? loadFixture<SeedCatalog>(CATALOG_FIXTURE) : undefined;
    catalog = await pickCatalog(c3, domains, previous);
    saveFixture(CATALOG_FIXTURE, catalog);
  } else if (hasFixture(CATALOG_FIXTURE)) {
    catalog = loadFixture<SeedCatalog>(CATALOG_FIXTURE);
  } else {
    throw new Error("No fixtures/seed/catalog.json yet: run `npm run seed -- --pick` in live mode first.");
  }
  const products = await loadProducts(c3, catalog, live);
  const pricingPolicy = {
    approvedDomains: domains,
    marginFloorBps: latestPolicy?.marginFloorBps ?? DEFAULT_POLICY.marginFloorBps,
    maxDiscountBps: latestPolicy?.maxDiscountBps ?? DEFAULT_POLICY.maxDiscountBps,
  };
  const rows = products.map((p) => toProductRow(p, pricingPolicy));

  // 2. Approved-stores Collection
  let collection: Collection | undefined;
  try {
    collection = await c3.upsertApprovedStores(domains);
    if (live && (RECORD || !hasFixture(COLLECTION_FIXTURE))) saveFixture(COLLECTION_FIXTURE, collection);
  } catch (err) {
    console.warn(`  ! Approved-stores Collection not created: ${(err as Error).message}`);
  }

  // 3. Database: products, then the policy (only created if missing; owner edits are never overwritten)
  const removed = await db.transaction(async (tx) => {
    for (const row of rows) {
      const { channel3ProductId, ...set } = row;
      await tx.insert(schema.products).values(row).onConflictDoUpdate({ target: schema.products.channel3ProductId, set });
    }
    // Products that left the catalog, unless an order, match request or price event points at them.
    const { products: p, orders, matchRequests, priceEvents } = schema;
    const gone = await tx
      .delete(p)
      .where(
        and(
          notInArray(p.channel3ProductId, rows.map((r) => r.channel3ProductId)),
          sql`not exists (select 1 from ${orders} where ${orders.productId} = ${p.id})`,
          sql`not exists (select 1 from ${matchRequests} where ${matchRequests.productId} = ${p.id})`,
          sql`not exists (select 1 from ${priceEvents} where ${priceEvents.productId} = ${p.id})`,
        ),
      )
      .returning({ title: p.title });
    const collectionId = collection?.collection_id ?? latestPolicy?.channel3CollectionId ?? null;
    if (!latestPolicy) {
      await tx.insert(schema.policies).values({
        ...DEFAULT_POLICY,
        version: 1,
        channel3CollectionId: collectionId,
        createdBy: "seed",
      });
    } else if (collectionId && latestPolicy.channel3CollectionId !== collectionId) {
      const { id, createdAt, ...settings } = latestPolicy;
      await tx.insert(schema.policies).values({
        ...settings,
        version: latestPolicy.version + 1,
        channel3CollectionId: collectionId,
        createdBy: "seed",
      });
    }
    return gone;
  });

  // Summary
  for (const r of removed) console.log(`Removed from the catalog: ${r.title}`);
  const [policy] = await db.select().from(schema.policies).orderBy(desc(schema.policies.version)).limit(1);
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.products);
  console.log(`\nProducts (${rows.length} seeded, ${count} in the database):`);
  console.log(`  ${"shop".padStart(10)}  ${"cost".padStart(9)}  ${"match >=".padStart(9)}`);
  for (const [i, r] of rows.entries()) {
    const variant = r.variant?.map((v) => `${v.name}: ${v.label}`).join(", ") || "-";
    const stores = newInStockOffers(products[i], policy.approvedDomains)
      .map((o) => `${o.domain} ${formatCents(dollarsToCents(o.price.price))}`)
      .join(", ");
    const floor = lowestMatchPriceCents(r.shopPriceCents, r.unitCostCents, policy);
    console.log(
      `  ${formatCents(r.shopPriceCents).padStart(10)}  ${formatCents(r.unitCostCents).padStart(9)}  ${formatCents(floor).padStart(9)}  ${r.title.slice(0, 45).padEnd(45)}  [${variant}]  approved: ${stores}`,
    );
  }
  console.log(
    `\nPolicy v${policy.version}: ${policy.approvedDomains.length} approved stores, margin floor ${policy.marginFloorBps / 100}%, ` +
      `max discount ${policy.maxDiscountBps / 100}%, ${policy.protectionDays}-day protection, ` +
      `auto-refund up to ${formatCents(policy.autoRefundCapCents)}`,
  );
  console.log(`Channel3 Collection: ${policy.channel3CollectionId ?? "none"}${collection ? ` ("${collection.name}")` : ""}`);
}

main()
  .catch((err) => {
    if (err?.cause?.code === "42P01" || err?.code === "42P01") {
      console.error("Tables missing: run `npm run db:migrate` first.");
    } else if (err?.code === "ECONNREFUSED" || err?.cause?.code === "ECONNREFUSED") {
      console.error("Can't reach Postgres: run `npm run db:up` (or check DATABASE_URL).");
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  })
  .finally(closeDb);
