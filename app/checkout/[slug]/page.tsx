import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getEnv } from "@/lib/env";
import { formatCents } from "@/lib/money";
import { getActivePolicy, getProductBySlug, productImages, variantLabel } from "@/lib/shop";
import { DatabaseError } from "../../_components/database-error";
import { ArrowLeftIcon, ShieldIcon } from "../../_components/icons";
import { PayPalCheckout } from "../../_components/paypal-checkout";

export default function CheckoutPage({ params }: PageProps<"/checkout/[slug]">) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pt-6 sm:px-6 sm:pt-8">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-3xl bg-surface-2" />}>
        <Checkout params={params} />
      </Suspense>
    </main>
  );
}

async function Checkout({ params }: Pick<PageProps<"/checkout/[slug]">, "params">) {
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
  const image = productImages(product)[0];
  const price = formatCents(product.shopPriceCents, product.currency);

  return (
    <>
      <Link
        href={`/products/${product.slug}`}
        className="flex w-fit items-center gap-1.5 text-sm text-muted transition hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        Back to product
      </Link>
      <h1 className="font-display text-3xl font-semibold tracking-tight">Checkout</h1>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.1fr_1fr] lg:items-start">
        <section aria-labelledby="summary-heading" className="rounded-3xl border border-line bg-surface p-6">
          <h2 id="summary-heading" className="text-xs font-medium uppercase tracking-[0.16em] text-muted">
            Your order
          </h2>
          <div className="mt-5 flex gap-4">
            <div className="product-frame relative size-24 shrink-0 overflow-hidden rounded-2xl border border-line">
              {image && <Image src={image.url} alt={image.alt} fill sizes="96px" className="object-contain p-2" />}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">{product.brand}</p>
              <p className="font-medium leading-snug">{product.title}</p>
              <p className="text-sm text-muted">{variantLabel(product.variant)} · Qty 1</p>
            </div>
            <p className="font-medium tabular-nums">{price}</p>
          </div>
          <dl className="mt-6 flex flex-col gap-2 border-t border-line pt-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">Subtotal</dt>
              <dd className="tabular-nums">{price}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Pickup in store</dt>
              <dd>Free</dd>
            </div>
            <div className="mt-2 flex justify-between border-t border-line pt-3 text-base font-semibold">
              <dt>Total</dt>
              <dd className="tabular-nums">{price}</dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="pay-heading" className="flex flex-col gap-5 rounded-3xl border border-line bg-surface p-6">
          <div>
            <h2 id="pay-heading" className="font-display text-xl font-semibold">
              Pay {price}
            </h2>
            <p className="mt-1 text-sm text-muted">
              You&apos;ll approve the payment with PayPal. We only charge once you confirm.
            </p>
          </div>
          {env.DEMO_MODE || !env.PAYPAL_CLIENT_ID ? (
            <PayPalCheckout mode="demo" productSlug={product.slug} currency={product.currency} />
          ) : (
            <PayPalCheckout mode="live" clientId={env.PAYPAL_CLIENT_ID} productSlug={product.slug} currency={product.currency} />
          )}
          {policy && (
            <div className="flex gap-3 rounded-2xl bg-amber-soft p-4 text-sm">
              <ShieldIcon className="mt-0.5 size-5 shrink-0 text-amber" />
              <p className="leading-relaxed">
                <span className="font-medium">Protected for {policy.protectionDays} days.</span>{" "}
                <span className="text-muted">
                  If an approved retailer drops the price below {price}, we refund the difference to your PayPal
                  automatically.
                </span>
              </p>
            </div>
          )}
          <p className="text-xs text-muted">
            {env.DEMO_MODE
              ? "Demo mode: no real PayPal checkout. The payment is simulated from recorded responses."
              : "PayPal sandbox: sign in with a sandbox personal account. No real money moves."}
          </p>
        </section>
      </div>
    </>
  );
}
