import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { consoleOverview } from "@/lib/console";
import { formatCents } from "@/lib/money";
import { DatabaseError } from "../_components/database-error";
import { ArrowRightIcon } from "../_components/icons";
import { AgentBadge, DecisionPill } from "../_components/match-badges";

export const metadata = { title: "Merchant console" };

const dt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

export default function ConsoleOverview() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pt-10 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted">Merchant console</p>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Overview</h1>
        </div>
        <Link
          href="/admin/protection"
          className="flex items-center gap-1.5 rounded-xl border border-line px-3 py-2 text-sm font-medium hover:bg-surface-2"
        >
          Price protection console
          <ArrowRightIcon className="size-4" />
        </Link>
      </header>
      <Suspense fallback={<div className="h-96 animate-pulse rounded-3xl bg-surface-2" />}>
        <Overview />
      </Suspense>
    </main>
  );
}

async function Overview() {
  await connection();
  let data;
  try {
    data = await consoleOverview();
  } catch (err) {
    return <DatabaseError error={err} />;
  }
  const d = data;

  return (
    <>
      <section className="grid gap-4 md:grid-cols-3">
        <Tile label="Sales covered by protection" value={formatCents(d.coveredCents)} note={`${d.coveredOrders} order${d.coveredOrders === 1 ? "" : "s"}`} />
        <Tile
          label="Refunds paid"
          value={formatCents(d.refundedCents)}
          note={`${d.refunds} PayPal partial refund${d.refunds === 1 ? "" : "s"}${d.pendingRefunds ? ` · ${d.pendingRefunds} awaiting approval` : ""}`}
        />
        <Tile label="Net kept" value={formatCents(d.netCents)} note="Covered sales minus refunds paid" emphasis />
      </section>

      <section className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Tile label="Matched" value={String(d.matched)} small />
        <Tile label="Declined" value={String(d.declined)} small />
        <Tile label="Needs review" value={String(d.review)} small />
        <Tile label="Value matches" value={String(d.valueTaken)} note={`${d.valueOffered} offered`} small />
        <Tile label="Active protections" value={String(d.activeProtections)} small href="/admin/protection" />
      </section>

      <section className="rounded-3xl border border-line bg-surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xs font-medium uppercase tracking-[0.16em] text-muted">Recent decisions</h2>
            <p className="mt-1 text-sm text-muted">
              Price-match requests from shoppers and their AI agents ({d.agentRequests} via agent). Open one for the evidence behind it.
            </p>
          </div>
        </div>
        <div className="mt-4">
          {d.recent.length === 0 ? (
            <p className="text-sm text-muted">No price-match requests yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {d.recent.map(({ match, product, order }) => (
                <li key={match.id}>
                  <Link href={`/matches/${match.id}`} className="-mx-2 flex flex-wrap items-center justify-between gap-3 rounded-xl px-2 py-3 text-sm hover:bg-surface-2">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        <DecisionPill decision={match.decision} />
                        <span className="truncate">{product.title}</span>
                        {match.source === "agent" && <AgentBadge name={match.agentName} />}
                      </p>
                      <p className="text-muted">
                        {match.competitorDomain ?? "unknown store"}
                        {match.competitorPriceCents != null && ` at ${formatCents(match.competitorPriceCents, product.currency)}`}
                        {match.matchedPriceCents != null && ` · matched ${formatCents(match.matchedPriceCents, product.currency)}`}
                        {order && ` · order ${order.status.replace("_", " ")}`} · {dt.format(match.createdAt)}
                      </p>
                    </div>
                    <span className="flex items-center gap-1 text-muted">
                      Evidence <ArrowRightIcon className="size-4" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}

function Tile({ label, value, note, emphasis, small, href }: { label: string; value: string; note?: string; emphasis?: boolean; small?: boolean; href?: string }) {
  const body = (
    <>
      <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted">{label}</p>
      <p className={`font-display font-semibold tracking-tight ${small ? "text-2xl" : "text-3xl"} ${emphasis ? "text-accent" : ""}`}>{value}</p>
      {note && <p className="text-sm text-muted">{note}</p>}
    </>
  );
  const cls = `flex flex-col gap-1 rounded-3xl border border-line p-5 ${emphasis ? "bg-accent-soft" : "bg-surface"}`;
  return href ? (
    <Link href={href} className={`${cls} hover:bg-surface-2`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
