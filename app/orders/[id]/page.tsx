import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";
import type { schema } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { getActivePolicy, getCaptureLedger, getOrderWithProduct, productImages, variantLabel } from "@/lib/shop";
import { AutoRefresh } from "../../_components/auto-refresh";
import { DatabaseError } from "../../_components/database-error";
import { CheckIcon, ShieldIcon } from "../../_components/icons";

type LedgerEvent = typeof schema.ledgerEvents.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;
const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
const dateTimeFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

export default function OrderPage({ params }: PageProps<"/orders/[id]">) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-10 sm:px-6 sm:pt-14">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-3xl bg-surface-2" />}>
        <Order params={params} />
      </Suspense>
    </main>
  );
}

async function Order({ params }: Pick<PageProps<"/orders/[id]">, "params">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  await connection();

  let data;
  try {
    const [row, policy] = await Promise.all([getOrderWithProduct(id), getActivePolicy()]);
    const ledger = row?.order.paypalCaptureId ? await getCaptureLedger(row.order.paypalCaptureId) : [];
    data = { row, policy, ledger };
  } catch (err) {
    return <DatabaseError error={err} />;
  }
  if (!data.row) notFound();
  const { order, product } = data.row;
  const { policy, ledger } = data;

  const paid = order.status === "completed" || order.status === "partially_refunded" || order.status === "refunded";
  const price = formatCents(order.pricePaidCents, order.currency);
  const image = productImages(product)[0];
  const protectedUntil = order.capturedAt && policy ? new Date(order.capturedAt.getTime() + policy.protectionDays * DAY_MS) : null;
  const captureVerified = ledger.some((e) => e.eventType === "PAYMENT.CAPTURE.COMPLETED" && e.verified);

  if (!paid) {
    return (
      <section className="rounded-3xl border border-line bg-surface p-8 text-center">
        <h1 className="font-display text-2xl font-semibold">
          {order.status === "approved" ? "Your payment is processing" : "This order isn't paid yet"}
        </h1>
        <p className="mt-2 text-muted">
          {order.status === "approved"
            ? "PayPal is still confirming the payment. This page updates on its own."
            : "The PayPal payment wasn't completed, so you haven't been charged."}
        </p>
        <Link href={`/products/${product.slug}`} className="mt-6 inline-flex rounded-xl bg-accent px-5 py-2.5 font-medium text-accent-ink">
          Back to {product.title}
        </Link>
        {order.status === "approved" && <AutoRefresh />}
      </section>
    );
  }

  return (
    <>
      <header className="flex flex-col items-center gap-4 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-accent text-accent-ink">
          <CheckIcon className="size-7" />
        </span>
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Thanks, you&apos;re all paid</h1>
          <p className="mt-2 text-muted">
            {price} paid with PayPal{order.buyerEmail ? ` by ${order.buyerEmail}` : ""}. Your item is ready for pickup.
          </p>
        </div>
      </header>

      <section className="rounded-3xl border border-line bg-surface p-6">
        <div className="flex gap-4">
          <div className="product-frame relative size-20 shrink-0 overflow-hidden rounded-2xl border border-line">
            {image && <Image src={image.url} alt={image.alt} fill sizes="80px" className="object-contain p-2" />}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="font-medium leading-snug">{product.title}</p>
            <p className="text-sm text-muted">{variantLabel(product.variant)}</p>
          </div>
          <p className="font-semibold tabular-nums">{price}</p>
        </div>
        <dl className="mt-6 grid gap-x-6 gap-y-3 border-t border-line pt-5 text-sm sm:grid-cols-2">
          <Detail label="Order" value={order.id.slice(0, 8).toUpperCase()} mono />
          {order.capturedAt && <Detail label="Paid" value={dateTimeFormat.format(order.capturedAt)} />}
          <Detail label="PayPal order ID" value={order.paypalOrderId} mono />
          {order.paypalCaptureId && <Detail label="PayPal capture ID" value={order.paypalCaptureId} mono />}
        </dl>
      </section>

      {protectedUntil && policy && (
        <section className="flex gap-4 rounded-3xl bg-amber-soft p-6">
          <ShieldIcon className="size-6 shrink-0 text-amber" />
          <div>
            <h2 className="font-medium">Price protection until {dateFormat.format(protectedUntil)}</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              If one of our {policy.approvedDomains.length} approved retailers sells this item for less than {price}{" "}
              before then, we refund the difference to your PayPal. Refunds up to{" "}
              {formatCents(policy.autoRefundCapCents)} are automatic; above that, the owner signs off.
            </p>
          </div>
        </section>
      )}

      <section aria-labelledby="ledger-heading" className="rounded-3xl border border-line bg-surface p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 id="ledger-heading" className="text-xs font-medium uppercase tracking-[0.16em] text-muted">
            PayPal events
          </h2>
          {captureVerified && (
            <span className="flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent">
              <CheckIcon className="size-3.5" />
              Capture verified
            </span>
          )}
        </div>
        {ledger.length === 0 ? (
          <p className="mt-4 flex items-center gap-2 text-sm text-muted">
            <span className="size-2 animate-pulse rounded-full bg-amber" />
            Waiting for PayPal&apos;s webhook to confirm the capture…
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-line">
            {ledger.map((e) => (
              <LedgerRow key={e.id} event={e} />
            ))}
          </ul>
        )}
        {!captureVerified && <AutoRefresh />}
      </section>
    </>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={mono ? "font-mono text-[13px] break-all" : ""}>{value}</dd>
    </div>
  );
}

function LedgerRow({ event }: { event: LedgerEvent }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-[13px]">{event.eventType}</span>
        <span className="text-xs text-muted">
          {event.paypalEventId} · {dateTimeFormat.format(event.receivedAt)}
        </span>
      </div>
      {event.verified ? (
        <span className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent">Signature verified</span>
      ) : (
        <span className="rounded-full bg-danger-soft px-2.5 py-1 text-xs font-medium text-danger">Unverified</span>
      )}
    </li>
  );
}
