import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";
import { explanation, loadEvidence, shopRule } from "@/lib/evidence";
import { formatCents } from "@/lib/money";
import { defaultDeps } from "@/lib/price-protection";
import { productImages, variantLabel } from "@/lib/shop";
import { SHOP } from "@/lib/shop-info";
import { DatabaseError } from "../../_components/database-error";
import { CheckIcon, ShieldIcon } from "../../_components/icons";
import { PriceSparkline } from "../../_components/price-sparkline";

export const metadata = { title: "Price protection refund" };

const dateTimeFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export default function EvidencePage({ params }: PageProps<"/evidence/[refundId]">) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-10 sm:px-6 sm:pt-14">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-3xl bg-surface-2" />}>
        <Evidence params={params} />
      </Suspense>
    </main>
  );
}

async function Evidence({ params }: Pick<PageProps<"/evidence/[refundId]">, "params">) {
  const { refundId } = await params;
  if (!z.uuid().safeParse(refundId).success) notFound();
  await connection();

  let e;
  try {
    e = await loadEvidence(refundId, defaultDeps());
  } catch (err) {
    return <DatabaseError error={err} />;
  }
  if (!e) notFound();

  const image = productImages(e.product)[0];
  const refundVerified = e.ledger.some((l) => l.eventType === "PAYMENT.CAPTURE.REFUNDED" && l.verified);
  const amount = formatCents(e.refund.amountCents, e.refund.currency);
  const issued = e.refund.status === "completed";

  return (
    <>
      {e.simulated && (
        <p className="rounded-2xl border border-amber bg-amber-soft px-4 py-3 text-sm font-medium text-amber">
          Simulated price drop (demo replay). The {formatCents(e.event.newPriceCents)} price at {e.event.domain} was not observed at the
          store; it was injected from a recorded Channel3 payload. The PayPal refund itself is real (sandbox).
        </p>
      )}

      <header className="flex flex-col items-center gap-4 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-amber-soft text-amber">
          <ShieldIcon className="size-7" />
        </span>
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted">Price protection</p>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">
            {issued ? `We refunded you ${amount}` : e.refund.status === "pending_approval" ? `${amount} refund awaiting approval` : `${amount} refund ${e.refund.status}`}
          </h1>
          <p className="mx-auto mt-3 max-w-xl leading-relaxed text-muted">{explanation(e)}</p>
        </div>
      </header>

      <section className="rounded-3xl border border-line bg-surface p-6">
        <div className="flex gap-4">
          <div className="product-frame relative size-16 shrink-0 overflow-hidden rounded-2xl border border-line">
            {image && <Image src={image.url} alt={image.alt} fill sizes="64px" className="object-contain p-2" />}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="font-medium leading-snug">{e.product.title}</p>
            <p className="text-sm text-muted">{variantLabel(e.product.variant)}</p>
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <PriceBox label="You paid" price={formatCents(e.order.pricePaidCents, e.order.currency)} store={SHOP.name} when={e.order.capturedAt ?? e.order.createdAt} />
          <PriceBox
            label={e.simulated ? "Lower price (simulated)" : "Lower price"}
            price={formatCents(e.event.newPriceCents, e.event.currency)}
            store={e.event.domain ?? "unknown store"}
            when={e.observedAt}
            highlight
            simulated={e.simulated}
          />
        </div>

        <div className="mt-6 border-t border-line pt-5">
          <PriceSparkline
            history={e.history}
            paidCents={e.order.pricePaidCents}
            dropCents={e.event.newPriceCents}
            dropAt={e.observedAt}
            simulated={e.simulated}
          />
        </div>
      </section>

      <section className="rounded-3xl border border-line bg-surface p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xs font-medium uppercase tracking-[0.16em] text-muted">PayPal refund</h2>
          {refundVerified ? (
            <span className="flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent">
              <CheckIcon className="size-3.5" />
              Refund webhook verified
            </span>
          ) : (
            <span className="rounded-full bg-surface-2 px-2.5 py-1 text-xs text-muted">Waiting for PayPal webhook</span>
          )}
        </div>
        <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Detail label="Amount" value={amount} />
          <Detail label="Status" value={`${e.refund.status}${e.refund.approvedBy ? ` (${e.refund.approvedBy === "auto" ? "automatic" : "owner approved"})` : ""}`} />
          <Detail label="PayPal refund ID" value={e.refund.paypalRefundId ?? "not issued"} mono />
          <Detail label="Refunded capture" value={e.order.paypalCaptureId ?? ""} mono />
          <Detail label="Price event" value={`${e.event.source}${e.simulated ? " · simulated" : ""} · ${dateTimeFormat.format(e.event.receivedAt)} UTC`} />
          <Detail label="Order" value={e.order.id.slice(0, 8).toUpperCase()} mono />
        </dl>
      </section>

      <section className="rounded-3xl bg-amber-soft p-6">
        <h2 className="font-medium">The rule that applied</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">{shopRule(e)}</p>
        <ul className="mt-4 flex flex-col gap-2 text-sm">
          {e.refund.decisionReasons.map((r) => (
            <li key={r.code} className="flex gap-2">
              <CheckIcon className={`mt-0.5 size-4 shrink-0 ${r.code === "simulated_drop" ? "text-amber" : "text-accent"}`} />
              <span>{r.message}</span>
            </li>
          ))}
        </ul>
      </section>

      <Link href={`/orders/${e.order.id}`} className="self-center text-sm text-muted underline-offset-4 hover:underline">
        View the order
      </Link>
    </>
  );
}

function PriceBox({
  label,
  price,
  store,
  when,
  highlight,
  simulated,
}: {
  label: string;
  price: string;
  store: string;
  when: Date;
  highlight?: boolean;
  simulated?: boolean;
}) {
  return (
    <div className={`rounded-2xl border p-4 ${highlight ? (simulated ? "border-amber bg-amber-soft" : "border-accent bg-accent-soft") : "border-line bg-surface-2"}`}>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{price}</p>
      <p className="mt-1 text-sm">{store}</p>
      <p className="text-xs text-muted">{dateTimeFormat.format(when)} UTC</p>
    </div>
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
