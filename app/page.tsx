import { connection } from "next/server";
import { Suspense } from "react";
import { formatCents } from "@/lib/money";
import { getActivePolicy, listProducts } from "@/lib/shop";
import { SHOP } from "@/lib/shop-info";
import { DatabaseError } from "./_components/database-error";
import { ShieldIcon, TagIcon } from "./_components/icons";
import { ProductCard, ProductCardSkeleton } from "./_components/product-card";

export default function CatalogPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-16 px-4 pt-12 sm:px-6 sm:pt-16">
      <section className="grid grid-cols-1 gap-10 lg:grid-cols-[1.15fr_1fr] lg:items-center">
        <div className="flex flex-col gap-5">
          <p className="text-sm font-medium uppercase tracking-[0.16em] text-accent">{SHOP.tagline}</p>
          <h1 className="font-display text-4xl font-semibold leading-[1.08] tracking-tight text-balance sm:text-5xl lg:text-6xl">
            Local service. Big-store prices, guaranteed.
          </h1>
          <p className="max-w-xl text-lg leading-relaxed text-muted text-pretty">
            Seen it cheaper at a major retailer? Show us the link and we&apos;ll match it at checkout. And if the price
            drops after you buy, we refund the difference to your PayPal, automatically.
          </p>
        </div>
        <Suspense fallback={<div className="h-64 animate-pulse rounded-3xl bg-surface-2" />}>
          <PromiseCard />
        </Suspense>
      </section>

      <section className="flex flex-col gap-6" aria-labelledby="catalog-heading">
        <div className="flex items-end justify-between gap-4 border-b border-line pb-4">
          <h2 id="catalog-heading" className="font-display text-2xl font-semibold tracking-tight">
            In the shop
          </h2>
          <p className="text-sm text-muted">Every item is verified against Channel3 product data</p>
        </div>
        <Suspense fallback={<CatalogSkeleton />}>
          <Catalog />
        </Suspense>
      </section>
    </main>
  );
}

async function PromiseCard() {
  await connection();
  const policy = await getActivePolicy().catch(() => null);
  const days = policy?.protectionDays ?? 14;
  const stores = policy?.approvedDomains.length ?? 0;
  return (
    <div id="promise" className="scroll-mt-24 rounded-3xl border border-line bg-surface p-6 shadow-[0_1px_0_rgba(31,29,24,0.04)] sm:p-8">
      <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted">Our price promise</p>
      <ul className="mt-5 flex flex-col gap-6">
        <li className="flex gap-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
            <TagIcon className="size-5" />
          </span>
          <div>
            <p className="font-medium">We match {stores ? `${stores} major retailers` : "major retailers"}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              Paste a competitor&apos;s link. We check it&apos;s the same model, colour and condition, in stock, and sold by
              the retailer itself, not a marketplace seller.
            </p>
          </div>
        </li>
        <li className="flex gap-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-soft text-amber">
            <ShieldIcon className="size-5" />
          </span>
          <div>
            <p className="font-medium">{days}-day price protection</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              If one of those retailers drops the price within {days} days, the difference goes back to your PayPal
              {policy ? `, up to ${formatCents(policy.autoRefundCapCents)} with no questions asked` : ""}.
            </p>
          </div>
        </li>
      </ul>
      <p className="mt-6 border-t border-line pt-4 text-xs text-muted">
        Prices checked with Channel3. Payments and refunds through PayPal.
      </p>
    </div>
  );
}

async function Catalog() {
  await connection();
  let data;
  try {
    const [products, policy] = await Promise.all([listProducts(), getActivePolicy()]);
    data = { products, policy };
  } catch (err) {
    return <DatabaseError error={err} />;
  }
  if (data.products.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-line p-10 text-center text-muted">
        The shelves are empty. Run <code className="font-mono text-foreground">npm run seed</code> to stock the shop.
      </p>
    );
  }
  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-6 lg:grid-cols-4">
      {data.products.map((p) => (
        <li key={p.id} className="flex">
          <ProductCard product={p} protectionDays={data.policy?.protectionDays ?? null} />
        </li>
      ))}
    </ul>
  );
}

function CatalogSkeleton() {
  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-6 lg:grid-cols-4">
      {Array.from({ length: 8 }, (_, i) => (
        <li key={i}>
          <ProductCardSkeleton />
        </li>
      ))}
    </ul>
  );
}
