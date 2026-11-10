// Read side of the storefront: catalog products, the active policy and orders, for pages and routes.
import { asc, desc, eq, or, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { Product, VariantSelection } from "./db/schema";

export type CatalogImage = { url: string; alt: string };
export type VariantOption = { name: string; label: string; otherCount: number };

// The parts of the Channel3 snapshot the product page shows. The snapshot is the product as seeded.
type Snapshot = {
  description?: string | null;
  key_features?: string[] | null;
  materials?: string[] | null;
  ratings?: { value?: number | null; count?: number | null } | null;
  images?: { url: string; cleaned_url?: string | null; alt_text?: string | null; is_main_image?: boolean }[] | null;
};
type SnapshotOption = { name: string; values: { label: string; exists?: boolean | null }[] };

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export const variantLabel = (variant: VariantSelection) => variant.map((v) => v.label).join(" · ");

// Only images on Channel3's CDN (next.config.ts allows that host); a few point at brand asset servers.
export const IMAGE_HOST = "cdn.trychannel3.com";
const onImageHost = (url: string) => {
  try {
    return new URL(url).hostname === IMAGE_HOST;
  } catch {
    return false;
  }
};

export function productImages(product: Product): CatalogImage[] {
  const images = (product.channel3Snapshot as Snapshot).images ?? [];
  const main = images.filter((i) => i.is_main_image);
  const rest = images.filter((i) => !i.is_main_image);
  return [...main, ...rest]
    .map((i) => ({ url: i.cleaned_url ?? i.url, alt: i.alt_text ?? product.title }))
    .filter((i) => onImageHost(i.url));
}

// The variant the shop stocks (e.g. Color: Black) and how many other values Channel3 lists for that
// option. Only the count is shown: Channel3's value lists are noisy ("on", "New color", merged lists).
// Options with no selection (sizes the catalog doesn't pin down) are left out.
export function productVariantOptions(product: Product): VariantOption[] {
  const options = product.variantOptions as SnapshotOption[];
  return product.variant.map(({ name, label }) => {
    const values = new Set(
      (options.find((o) => o.name === name)?.values ?? []).filter((v) => v.exists !== false).map((v) => decode(v.label)),
    );
    values.delete(label);
    return { name, label, otherCount: values.size };
  });
}

export function productDetails(product: Product) {
  const s = product.channel3Snapshot as Snapshot;
  const rating = s.ratings?.value && s.ratings.count ? { value: s.ratings.value, count: s.ratings.count } : null;
  return {
    description: s.description ?? null,
    keyFeatures: (s.key_features ?? []).slice(0, 6),
    materials: s.materials ?? [],
    rating,
  };
}

export async function listProducts() {
  return getDb().select().from(schema.products).orderBy(asc(schema.products.title));
}

export async function getProductBySlug(slug: string) {
  const [product] = await getDb().select().from(schema.products).where(eq(schema.products.slug, slug)).limit(1);
  return product ?? null;
}

export async function getActivePolicy() {
  const [policy] = await getDb().select().from(schema.policies).orderBy(desc(schema.policies.version)).limit(1);
  return policy ?? null;
}

export async function getOrderWithProduct(orderId: string) {
  const [row] = await getDb()
    .select({ order: schema.orders, product: schema.products, match: schema.matchRequests })
    .from(schema.orders)
    .innerJoin(schema.products, eq(schema.orders.productId, schema.products.id))
    .leftJoin(schema.matchRequests, eq(schema.orders.matchRequestId, schema.matchRequests.id))
    .where(eq(schema.orders.id, orderId))
    .limit(1);
  return row ?? null;
}

// Ledger events about this order's capture: the capture itself, and refunds that point back up to it.
// A refund's resource links "up" to the capture it refunds.
export async function getCaptureLedger(captureId: string) {
  const e = schema.ledgerEvents;
  const refundsCapture = sql`exists (
    select 1 from jsonb_array_elements(coalesce(${e.rawPayload} -> 'resource' -> 'links', '[]'::jsonb)) as link
    where link ->> 'rel' = 'up' and link ->> 'href' like ${`%/captures/${captureId}`}
  )`;
  return getDb()
    .select()
    .from(e)
    .where(or(eq(e.resourceId, captureId), refundsCapture))
    .orderBy(asc(e.receivedAt));
}
