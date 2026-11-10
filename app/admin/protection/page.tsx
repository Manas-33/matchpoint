import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb, schema } from "@/lib/db";
import { desc, eq, inArray } from "drizzle-orm";
import { formatCents } from "@/lib/money";
import { isSimulated } from "@/lib/protection";
import { getActivePolicy } from "@/lib/shop";
import { DatabaseError } from "../../_components/database-error";
import { ConsoleButton } from "./actions";

export const metadata = { title: "Price protection console" };

const dt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

export default function ProtectionConsole() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pt-10 sm:px-6">
      <header className="flex flex-col gap-1">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted">Merchant console</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Price protection</h1>
      </header>
      <Suspense fallback={<div className="h-96 animate-pulse rounded-3xl bg-surface-2" />}>
        <Console />
      </Suspense>
    </main>
  );
}

async function Console() {
  await connection();
  let data;
  try {
    const db = getDb();
    const [policy, protections, events, refunds] = await Promise.all([
      getActivePolicy(),
      db
        .select({ protection: schema.protections, order: schema.orders, product: schema.products })
        .from(schema.protections)
        .innerJoin(schema.orders, eq(schema.protections.orderId, schema.orders.id))
        .innerJoin(schema.products, eq(schema.orders.productId, schema.products.id))
        .orderBy(desc(schema.protections.createdAt)),
      db.select().from(schema.priceEvents).orderBy(desc(schema.priceEvents.receivedAt)).limit(20),
      db
        .select({ refund: schema.refunds, event: schema.priceEvents })
        .from(schema.refunds)
        .innerJoin(schema.priceEvents, eq(schema.refunds.priceEventId, schema.priceEvents.id))
        .orderBy(desc(schema.refunds.createdAt)),
    ]);
    const refundIds = refunds.map((r) => r.refund.paypalRefundId).filter((x): x is string => !!x);
    const ledger = refundIds.length
      ? await db.select().from(schema.ledgerEvents).where(inArray(schema.ledgerEvents.resourceId, refundIds))
      : [];
    data = { policy, protections, events, refunds, ledger };
  } catch (err) {
    return <DatabaseError error={err} />;
  }
  const { policy, protections, events, refunds, ledger } = data;
  const refundedBy = (protectionId: string) =>
    refunds.filter((r) => r.refund.protectionId === protectionId && r.refund.status === "completed").reduce((s, r) => s + r.refund.amountCents, 0);

  return (
    <>
      {policy && (
        <p className="text-sm text-muted">
          Policy v{policy.version}: {policy.protectionDays}-day window, {policy.approvedDomains.length} approved stores, refunds up to{" "}
          {formatCents(policy.autoRefundCapCents)} automatic, ignored under {formatCents(policy.minRefundCents)}.
        </p>
      )}

      <Section
        title="Protected orders"
        action={<ConsoleButton kind="check" label="Run price check now" tone="quiet" />}
        hint="The price check reads Channel3 price history and current offers for every active protection (the fallback for a missed webhook)."
      >
        {protections.length === 0 ? (
          <Empty>No protected orders yet. Orders are enrolled when PayPal captures the payment.</Empty>
        ) : (
          <div className="flex flex-col divide-y divide-line">
            {protections.map(({ protection, order, product }) => (
              <div key={protection.id} className="grid gap-4 py-4 md:grid-cols-[1fr_auto]">
                <div className="flex flex-col gap-1 text-sm">
                  <p className="font-medium">{product.title}</p>
                  <p className="text-muted">
                    <Link href={`/orders/${order.id}`} className="font-mono hover:underline">
                      {order.id.slice(0, 8).toUpperCase()}
                    </Link>{" "}
                    · paid {formatCents(order.pricePaidCents)} · capture <span className="font-mono">{order.paypalCaptureId}</span>
                  </p>
                  <p className="text-muted">
                    <StatusPill status={protection.status} /> until {dt.format(protection.windowEndsAt)} · Channel3{" "}
                    <span className="font-mono">{protection.channel3ProductId}</span> · refunded {formatCents(refundedBy(protection.id))}
                  </p>
                </div>
                {protection.status === "active" && (
                  <div className="md:max-w-sm">
                    <ConsoleButton kind="replay" protectionId={protection.id} label="Replay recorded drop (simulated)" tone="amber" />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Refunds">
        {refunds.length === 0 ? (
          <Empty>No refunds yet.</Empty>
        ) : (
          <div className="flex flex-col divide-y divide-line">
            {refunds.map(({ refund, event }) => {
              const verified = ledger.some((l) => l.resourceId === refund.paypalRefundId && l.eventType === "PAYMENT.CAPTURE.REFUNDED" && l.verified);
              return (
                <div key={refund.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <div className="flex flex-col gap-0.5">
                    <p className="font-medium">
                      {formatCents(refund.amountCents)} · {refund.status.replace("_", " ")}
                      {refund.approvedBy ? ` (${refund.approvedBy})` : ""}
                      {isSimulated(event) && <SimBadge />}
                    </p>
                    <p className="text-muted">
                      {event.source} event · {event.domain} at {formatCents(event.newPriceCents)} · {dt.format(refund.createdAt)}
                      {refund.paypalRefundId && (
                        <>
                          {" "}
                          · PayPal <span className="font-mono">{refund.paypalRefundId}</span>
                        </>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {refund.paypalRefundId &&
                      (verified ? (
                        <span className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent">Webhook verified</span>
                      ) : (
                        <span className="rounded-full bg-surface-2 px-2.5 py-1 text-xs text-muted">Awaiting webhook</span>
                      ))}
                    {refund.status === "pending_approval" ? (
                      <>
                        <ConsoleButton kind="approve" refundId={refund.id} label="Approve" />
                        <ConsoleButton kind="reject" refundId={refund.id} label="Reject" tone="quiet" />
                      </>
                    ) : (
                      <Link href={`/evidence/${refund.id}`} className="rounded-xl border border-line px-3 py-1.5 font-medium hover:bg-surface-2">
                        Evidence
                      </Link>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Price events" hint="Channel3 price.changed webhooks, fallback polls and demo replays, newest first.">
        {events.length === 0 ? (
          <Empty>No price events yet.</Empty>
        ) : (
          <div className="flex flex-col divide-y divide-line">
            {events.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <p>
                  <SourcePill source={e.source} />
                  {isSimulated(e) && <SimBadge />} <span className="font-mono">{e.channel3ProductId}</span> · {e.domain ?? "?"}{" "}
                  {e.oldPriceCents != null && <span className="text-muted line-through">{formatCents(e.oldPriceCents)}</span>}{" "}
                  <span className="font-medium">{formatCents(e.newPriceCents)}</span>
                </p>
                <p className="text-muted">
                  {e.verified === true ? "signature verified · " : e.verified === false ? "unverified · " : ""}
                  {dt.format(e.receivedAt)}
                </p>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

function Section({ title, hint, action, children }: { title: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-3xl border border-line bg-surface p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xs font-medium uppercase tracking-[0.16em] text-muted">{title}</h2>
          {hint && <p className="mt-1 max-w-2xl text-sm text-muted">{hint}</p>}
        </div>
        {action && <div className="md:max-w-md">{action}</div>}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-muted">{children}</p>;

function SourcePill({ source }: { source: string }) {
  const tone = source === "webhook" ? "bg-accent-soft text-accent" : source === "replay" ? "bg-amber-soft text-amber" : "bg-surface-2 text-muted";
  return <span className={`mr-1 rounded-full px-2 py-0.5 text-xs font-medium uppercase ${tone}`}>{source}</span>;
}

function SimBadge() {
  return <span className="ml-1 rounded-full border border-amber px-2 py-0.5 text-xs font-medium text-amber">Simulated drop</span>;
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${status === "active" ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted"}`}>
      {status}
    </span>
  );
}
