import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getEnv } from "@/lib/env";
import { demoCasesFor } from "@/lib/match/demo-cases";
import { formatCents } from "@/lib/money";
import { getActivePolicy, getProductBySlug, productDetails, productImages, productVariantOptions } from "@/lib/shop";
import { DatabaseError } from "../../_components/database-error";
import { FoundItCheaper } from "../../_components/found-it-cheaper";
import { Gallery } from "../../_components/gallery";
import { ArrowLeftIcon, CheckIcon, LockIcon, ShieldIcon, StarIcon, StoreIcon } from "../../_components/icons";

export default function ProductPage({ params }: PageProps<"/products/[slug]">) {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pt-6 sm:px-6 sm:pt-8">
      <Link href="/" className="flex w-fit items-center gap-1.5 text-sm text-muted transition hover:text-foreground">
        <ArrowLeftIcon className="size-4" />
        All products
      </Link>
      <Suspense fallback={<ProductSkeleton />}>
        <ProductDetail params={params} />
      </Suspense>
    </main>
  );
}

async function ProductDetail({ params }: Pick<PageProps<"/products/[slug]">, "params">) {
  const { slug } = await params;
  await connection();
  let data;
  try {
    const [product, policy] = await Promise.all([getProductBySlug(slug), getActivePolicy()]);
    data = { product, policy };
  } catch (err) {
    return <DatabaseError error={err} />;
  }
  const { product, policy } = data;
  if (!product) notFound();

  const env = getEnv();
  const details = productDetails(product);
  const options = productVariantOptions(product);

  return (
    <div className="flex flex-col gap-16">
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-14">
        <Gallery images={productImages(product)} title={product.title} />

        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted">{product.brand}</p>
            <h1 className="font-display text-3xl font-semibold leading-tight tracking-tight text-balance sm:text-4xl">
              {product.title}
            </h1>
            {details.rating && (
              <p className="flex items-center gap-2 text-sm text-muted">
                <span className="flex text-amber" aria-hidden>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <StarIcon key={n} className="size-4" filled={details.rating!.value >= n - 0.25} />
                  ))}
                </span>
                {details.rating.value.toFixed(1)} · {details.rating.count.toLocaleString("en-US")} reviews
              </p>
            )}
          </div>

          <div className="flex items-baseline gap-3">
            <span className="text-3xl font-semibold tabular-nums">{formatCents(product.shopPriceCents, product.currency)}</span>
            {product.category && <span className="text-sm text-muted">{product.category}</span>}
          </div>

          {options.length > 0 && (
            <dl className="flex flex-col gap-3">
              {options.map((option) => (
                <div key={option.name} className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <dt className="w-16 text-sm text-muted">{option.name}</dt>
                  <dd className="flex items-center gap-1.5 rounded-full border border-accent bg-accent-soft px-3 py-1.5 text-sm font-medium text-accent">
                    <CheckIcon className="size-3.5" />
                    {option.label}
                  </dd>
                  {option.otherCount > 0 && (
                    <dd className="text-xs text-muted">
                      {option.otherCount} other {option.otherCount === 1 ? "option" : "options"} not stocked here
                    </dd>
                  )}
                </div>
              ))}
            </dl>
          )}

          <div className="flex flex-col gap-3">
            <Link
              href={`/checkout/${product.slug}`}
              className="flex h-12 items-center justify-center gap-2 rounded-xl bg-accent px-6 font-medium text-accent-ink shadow-sm transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <LockIcon className="size-4" />
              Buy now · {formatCents(product.shopPriceCents, product.currency)}
            </Link>
            <ul className="grid gap-2 text-sm text-muted sm:grid-cols-2">
              <li className="flex items-center gap-2">
                <StoreIcon className="size-4 shrink-0" />
                Free pickup in store
              </li>
              {policy && (
                <li className="flex items-center gap-2">
                  <ShieldIcon className="size-4 shrink-0 text-amber" />
                  {policy.protectionDays}-day price protection
                </li>
              )}
            </ul>
          </div>

          <FoundItCheaper
            productId={product.id}
            productSlug={product.slug}
            currency={product.currency}
            approvedDomains={policy?.approvedDomains ?? []}
            protectionDays={policy?.protectionDays ?? null}
            payment={env.DEMO_MODE || !env.PAYPAL_CLIENT_ID ? { mode: "demo" } : { mode: "live", clientId: env.PAYPAL_CLIENT_ID }}
            demoLinks={demoCasesFor(product.channel3ProductId, env.DEMO_MODE)}
          />
        </div>
      </div>

      {(details.description || details.keyFeatures.length > 0) && (
        <section className="grid grid-cols-1 gap-8 border-t border-line pt-10 lg:grid-cols-2 lg:gap-14">
          {details.description && (
            <div className="flex flex-col gap-3">
              <h2 className="font-display text-xl font-semibold">About this item</h2>
              <p className="leading-relaxed text-muted text-pretty">{details.description}</p>
              {details.materials.length > 0 && (
                <p className="text-sm text-muted">
                  <span className="font-medium text-foreground">Materials:</span> {details.materials.join(", ")}
                </p>
              )}
            </div>
          )}
          {details.keyFeatures.length > 0 && (
            <div className="flex flex-col gap-3">
              <h2 className="font-display text-xl font-semibold">Highlights</h2>
              <ul className="flex flex-col gap-2.5">
                {details.keyFeatures.map((f) => (
                  <li key={f} className="flex gap-3 text-sm leading-relaxed">
                    <CheckIcon className="mt-0.5 size-4 shrink-0 text-accent" />
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function ProductSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-14">
      <div className="aspect-square animate-pulse rounded-3xl bg-surface-2" />
      <div className="flex flex-col gap-4">
        <div className="h-3 w-24 animate-pulse rounded bg-surface-2" />
        <div className="h-10 w-4/5 animate-pulse rounded bg-surface-2" />
        <div className="h-8 w-32 animate-pulse rounded bg-surface-2" />
        <div className="h-12 w-full animate-pulse rounded-xl bg-surface-2" />
        <div className="h-48 w-full animate-pulse rounded-2xl bg-surface-2" />
      </div>
    </div>
  );
}
