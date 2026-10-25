// Channel3: product lookup and search, price history and tracking, approved-store Collections, and
// price.changed webhook verification. Demo mode answers from the recorded responses in fixtures/channel3/.
// SDK notes (scripts/spikes/FINDINGS.md): class `Channel3`, snake_case fields, prices are floats, and
// timestamps deserialize to Date.
import { createHmac, timingSafeEqual } from "node:crypto";
import { Channel3, Channel3Error, type Channel3Api } from "@channel3/sdk";
import { z } from "zod";
import { getEnv } from "./env";
import { MissingFixtureError, hasFixture, listFixtures, loadFixture, slug } from "./fixtures";

export type Product = Channel3Api.Product;
export type PriceHistory = Channel3Api.PriceHistoryResponse;
export type Subscription = Channel3Api.SubscriptionResponse;
export type Collection = Channel3Api.CollectionResponse;

export const APPROVED_STORES_COLLECTION = "Matchpoint approved stores";

export interface Channel3Service {
  readonly mode: "live" | "demo";
  // Resolve a competitor URL to a canonical product with every store's offers.
  lookup(url: string): Promise<Product>;
  retrieve(productId: string): Promise<Product>;
  search(query: string, options?: { limit?: number; filters?: Channel3Api.SearchFilters }): Promise<Product[]>;
  findSimilar(productId: string, limit?: number): Promise<Product[]>;
  priceHistory(productId: string): Promise<PriceHistory>;
  startTracking(productId: string): Promise<Subscription>;
  // Create the approved-stores Collection, or replace its stores if it already exists.
  upsertApprovedStores(domains: string[]): Promise<Collection>;
}

// Why a call failed, in the terms the match engine cares about.
export type Channel3FailureKind = "not_product_page" | "extraction_failed" | "not_found" | "rate_limited" | "other";

export class Channel3RequestError extends Error {
  constructor(
    readonly kind: Channel3FailureKind,
    readonly statusCode: number | undefined,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "Channel3RequestError";
  }
}

// Observed in Phase 0: 422 "URL is not a product page", 500 "Product extraction failed".
function toRequestError(err: unknown): never {
  if (!(err instanceof Channel3Error)) throw err;
  const status = err.statusCode;
  const kind: Channel3FailureKind =
    status === 422
      ? "not_product_page"
      : status === 500
        ? "extraction_failed"
        : status === 404
          ? "not_found"
          : status === 429
            ? "rate_limited"
            : "other";
  throw new Channel3RequestError(kind, status, `Channel3 ${status ?? "error"}: ${err.message}`, { cause: err });
}

function liveChannel3(apiKey: string): Channel3Service {
  const client = new Channel3({ apiKey, country: "US", currency: "USD", timeoutInSeconds: 60, maxRetries: 2 });
  const call = <T>(promise: Promise<T>) => promise.catch(toRequestError);

  async function findCollection(name: string) {
    for await (const c of await call(client.collections.list())) {
      if (c.name === name) return c;
    }
    return undefined;
  }

  return {
    mode: "live",
    lookup: async (url) => (await call(client.products.lookup({ url }))).product,
    retrieve: (productId) => call(client.products.retrieve({ product_id: productId })),
    search: async (query, options = {}) =>
      (await call(client.products.search({ query, limit: options.limit ?? 20, filters: options.filters }))).data,
    findSimilar: async (productId, limit = 10) =>
      (await call(client.products.findSimilar({ product_id: productId, limit }))).data,
    priceHistory: (productId) => call(client.priceTracking.retrieveHistory({ canonical_product_id: productId })),
    startTracking: (productId) => call(client.priceTracking.start({ canonical_product_id: productId })),
    async upsertApprovedStores(domains) {
      const clauses = [{ website_ids: domains }];
      const description = "Stores the shop will price-match and price-protect against.";
      const existing = await findCollection(APPROVED_STORES_COLLECTION);
      if (!existing) {
        return call(client.collections.create({ name: APPROVED_STORES_COLLECTION, description, clauses }));
      }
      return call(
        client.collections.update({
          collection_id: existing.collection_id,
          description,
          remove_clause_ids: existing.clauses.map((c) => c.clause_id),
          add_clauses: clauses,
        }),
      );
    },
  };
}

// Fixtures store dates as ISO strings; the SDK returns Date objects for these fields.
const DATE_KEYS = new Set(["timestamp", "created_at", "updated_at"]);
function reviveDates<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (key, v) =>
    DATE_KEYS.has(key) && typeof v === "string" ? new Date(v) : v,
  ) as T;
}

// Lookups are keyed on the URL without scheme, "www.", query string, fragment or trailing slash.
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url.trim();
  }
}

type LookupFixture = { url: string; product: Product };
type SearchFixture = { query: string; response: { products: Product[] } };

function demoChannel3(): Channel3Service {
  let lookups: Map<string, Product> | undefined;
  const searchFixtures = () => listFixtures("channel3/search").map((f) => loadFixture<SearchFixture>(`channel3/search/${f}`));

  function retrieve(productId: string): Product {
    if (hasFixture(`channel3/catalog/${productId}`)) {
      return loadFixture<LookupFixture>(`channel3/catalog/${productId}`).product;
    }
    for (const s of searchFixtures()) {
      const hit = s.response.products.find((p) => p.id === productId);
      if (hit) return hit;
    }
    throw new MissingFixtureError(`Channel3 product ${productId}`);
  }

  return {
    mode: "demo",
    async lookup(url) {
      lookups ??= new Map(
        listFixtures("channel3/lookup").map((f) => {
          const fx = loadFixture<LookupFixture>(`channel3/lookup/${f}`);
          return [normalizeUrl(fx.url), fx.product];
        }),
      );
      const product = lookups.get(normalizeUrl(url));
      if (!product) throw new MissingFixtureError(`Channel3 lookup of ${url}`);
      return product;
    },
    retrieve: async (productId) => retrieve(productId),
    async search(query, options = {}) {
      const path = `channel3/search/${slug(query)}`;
      if (!hasFixture(path)) throw new MissingFixtureError(`Channel3 search "${query}"`);
      return loadFixture<SearchFixture>(path).response.products.slice(0, options.limit ?? 20);
    },
    // No recorded `similar` responses yet: answer with the other results of the search that found the product.
    async findSimilar(productId, limit = 10) {
      const s = searchFixtures().find((fx) => fx.response.products.some((p) => p.id === productId));
      if (!s) throw new MissingFixtureError(`Channel3 similar products for ${productId}`);
      return s.response.products.filter((p) => p.id !== productId).slice(0, limit);
    },
    async priceHistory(productId) {
      const path = `channel3/history/${productId}`;
      if (!hasFixture(path)) throw new MissingFixtureError(`Channel3 price history for ${productId}`);
      return reviveDates(loadFixture<PriceHistory>(path));
    },
    async startTracking(productId) {
      const recorded = hasFixture("channel3/tracking/start")
        ? loadFixture<Subscription[]>("channel3/tracking/start").find((s) => s.canonical_product_id === productId)
        : undefined;
      return reviveDates(
        recorded ?? { canonical_product_id: productId, subscription_status: "active", created_at: new Date() },
      );
    },
    async upsertApprovedStores() {
      const path = "channel3/collections/approved-stores";
      if (!hasFixture(path)) throw new MissingFixtureError("the approved-stores Collection (run `npm run seed` live once)");
      return reviveDates(loadFixture<Collection>(path));
    },
  };
}

let service: Channel3Service | undefined;

export function getChannel3(): Channel3Service {
  if (!service) {
    const env = getEnv();
    service = env.DEMO_MODE ? demoChannel3() : liveChannel3(env.CHANNEL3_API_KEY!);
  }
  return service;
}

// price.changed is flat, not wrapped in `data` (Phase 0 finding). Kept loose until a real event is recorded.
export const PriceChangedEvent = z
  .object({
    type: z.literal("price.changed"),
    canonical_product_id: z.string(),
    domain: z.string(),
    old_price: z.number().nullish(),
    new_price: z.number(),
    currency: z.string().default("USD"),
    buy_url: z.string().nullish(),
    timestamp: z.string().nullish(),
  })
  .loose();
export type PriceChangedEvent = z.infer<typeof PriceChangedEvent>;

export type WebhookVerification =
  | { verified: true }
  | { verified: false; reason: string }
  // The delivery carried no signature headers, so there was nothing to check.
  | { verified: null; reason: string };

const header = (headers: Headers, ...names: string[]) =>
  names.map((n) => headers.get(n)).find((v) => v != null) ?? undefined;

// Channel3 signs webhooks Svix-style: HMAC-SHA256 over `${id}.${timestamp}.${rawBody}` with the
// base64 secret after `whsec_`. Pass the raw body exactly as received.
export function verifyChannel3Webhook(
  headers: Headers,
  rawBody: string,
  secret: string | undefined,
  { toleranceSeconds = 300, now = Date.now() }: { toleranceSeconds?: number | null; now?: number } = {},
): WebhookVerification {
  const id = header(headers, "svix-id", "webhook-id");
  const ts = header(headers, "svix-timestamp", "webhook-timestamp");
  const sigs = header(headers, "svix-signature", "webhook-signature");
  if (!id || !ts || !sigs) return { verified: null, reason: "no signature headers" };
  if (!secret) return { verified: false, reason: "CHANNEL3_WEBHOOK_SECRET not set" };
  if (toleranceSeconds != null && Math.abs(now / 1000 - Number(ts)) > toleranceSeconds) {
    return { verified: false, reason: "timestamp outside tolerance" };
  }
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest();
  const match = sigs.split(" ").some((s) => {
    const given = Buffer.from(s.split(",")[1] ?? "", "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return match ? { verified: true } : { verified: false, reason: "signature mismatch" };
}
