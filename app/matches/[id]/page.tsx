import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import type { JudgmentResult } from "@/lib/claude";
import { getDb, schema } from "@/lib/db";
import type { Check } from "@/lib/match/rules";
import { savedValueOffer, VALUE_OFFER_CODE } from "@/lib/match/value-offer";
import { formatCents } from "@/lib/money";
import { DatabaseError } from "../../_components/database-error";
import { ArrowLeftIcon } from "../../_components/icons";
import { AgentBadge, DecisionPill } from "../../_components/match-badges";

export const metadata = { title: "Price-match evidence" };

const dt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function MatchEvidencePage({ params }: PageProps<"/matches/[id]">) {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 pt-10 sm:px-6">
      <Link href="/admin" className="flex w-fit items-center gap-1.5 text-sm text-muted transition hover:text-foreground">
        <ArrowLeftIcon className="size-4" />
        Console overview
      </Link>
      <Suspense fallback={<div className="h-96 animate-pulse rounded-3xl bg-surface-2" />}>
        <Evidence params={params} />
      </Suspense>
    </main>
  );
}

const STATUS: Record<string, { mark: string; tone: string }> = {
  pass: { mark: "✓", tone: "text-accent" },
  fail: { mark: "✕", tone: "text-danger" },
  review: { mark: "?", tone: "text-amber" },
  skip: { mark: "–", tone: "text-muted" },
};

async function Evidence({ params }: Pick<PageProps<"/matches/[id]">, "params">) {
  const { id } = await params;
  await connection();
  if (!UUID.test(id)) notFound();
  let data;
  try {
    const db = getDb();
    const [row] = await db
      .select({ match: schema.matchRequests, product: schema.products, policy: schema.policies })
      .from(schema.matchRequests)
      .innerJoin(schema.products, eq(schema.matchRequests.productId, schema.products.id))
      .innerJoin(schema.policies, eq(schema.matchRequests.policyId, schema.policies.id))
      .where(eq(schema.matchRequests.id, id))
      .limit(1);
    const orders = row
      ? await db.select().from(schema.orders).where(eq(schema.orders.matchRequestId, id)).orderBy(desc(schema.orders.createdAt))
      : [];
    data = { row, orders };
  } catch (err) {
    return <DatabaseError error={err} />;
  }
  if (!data.row) notFound();
  const { match, product, policy } = data.row;
  const cur = product.currency;
  const checks = (match.reasons as Check[]).filter((r) => r.code !== VALUE_OFFER_CODE);
  const valueOffer = savedValueOffer(match.reasons);
  const judgment = match.modelOutput as JudgmentResult | null;
  const history = match.historyStats as { typicalCents?: number; daysAtOrBelow?: number; windowDays?: number; currentStatus?: string | null } | null;

  return (
    <>
      <header className="flex flex-col gap-2">
        <p className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted">
          Price-match evidence · {dt.format(match.createdAt)}
        </p>
        <h1 className="font-display text-3xl font-semibold tracking-tight">{product.title}</h1>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <DecisionPill decision={match.decision} />
          {match.source === "agent" ? <AgentBadge name={match.agentName} /> : <span>from the product page</span>}
          <span>· policy v{policy.version}</span>
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <Fact label="Our price" value={formatCents(product.shopPriceCents, cur)} />
        <Fact label={`At ${match.competitorDomain ?? "competitor"}`} value={match.competitorPriceCents != null ? formatCents(match.competitorPriceCents, cur) : "unknown"} />
        <Fact label="Matched price" value={match.matchedPriceCents != null ? formatCents(match.matchedPriceCents, cur) : "not matched"} />
      </section>

      <Card title="Competitor listing">
        <a href={match.competitorUrl} target="_blank" rel="noreferrer" className="break-all text-sm text-accent hover:underline">
          {match.competitorUrl}
        </a>
      </Card>

      <Card title="Checks">
        <ul className="flex flex-col divide-y divide-line text-sm">
          {checks.map((c, i) => {
            const s = STATUS[c.status] ?? STATUS.skip;
            return (
              <li key={`${c.code}-${i}`} className="grid grid-cols-[1.5rem_1fr] gap-2 py-2.5">
                <span className={`font-semibold ${s.tone}`}>{s.mark}</span>
                <div>
                  <p className="font-medium">{c.label ?? c.code}</p>
                  <p className="text-muted">{c.message}</p>
                  {c.source && <p className="font-mono text-xs text-muted">evidence: {c.source}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      {judgment?.outcome === "ok" && (
        <Card title={`Same-product judgment (${match.model ?? "Claude"})`}>
          <p className="text-sm">
            Confidence {judgment.decision.confidence.toFixed(2)} · condition {judgment.decision.condition}
          </p>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {judgment.decision.reasons.map((r, i) => (
              <li key={i}>
                <span className="font-mono text-xs text-muted">
                  {r.listing}.{r.field}
                </span>
                <p>{r.observation}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {history?.typicalCents != null && (
        <Card title="Price history (Channel3)">
          <p className="text-sm">
            Typical price {formatCents(history.typicalCents, cur)} over {history.windowDays} days · seen at or below this price on{" "}
            {history.daysAtOrBelow} day{history.daysAtOrBelow === 1 ? "" : "s"} · current status {history.currentStatus ?? "unknown"}
          </p>
        </Card>
      )}

      {valueOffer && (
        <Card title="Value match offered">
          <p className="text-sm">
            {valueOffer.title} worth {formatCents(valueOffer.customerValueCents, cur)} (costs the shop {formatCents(valueOffer.shopCostCents, cur)}) instead of{" "}
            {formatCents(valueOffer.insteadOfCents, cur)} off in cash.
          </p>
        </Card>
      )}

      <Card title="Orders">
        {data.orders.length === 0 ? (
          <p className="text-sm text-muted">No order on this match.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {data.orders.map((o) => (
              <li key={o.id}>
                <Link href={`/orders/${o.id}`} className="font-mono hover:underline">
                  {o.id.slice(0, 8).toUpperCase()}
                </Link>{" "}
                · {formatCents(o.pricePaidCents, o.currency)} · {o.status.replace("_", " ")} · PayPal <span className="font-mono">{o.paypalOrderId}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-3xl border border-line bg-surface p-5">
      <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted">{label}</p>
      <p className="font-display text-2xl font-semibold tracking-tight">{value}</p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-3xl border border-line bg-surface p-6">
      <h2 className="text-xs font-medium uppercase tracking-[0.16em] text-muted">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}
