import { count, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb, schema } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { lowestMatchPriceCents } from "@/lib/policy";
import { policyToFields } from "@/lib/policy-admin";
import { DatabaseError } from "../../_components/database-error";
import { PolicyForm } from "./policy-form";

export const metadata = { title: "Price-match policy" };

const dt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

export default function PolicyPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pt-10 sm:px-6">
      <header className="flex flex-col gap-1">
        <Link href="/admin" className="w-fit text-xs font-medium uppercase tracking-[0.16em] text-muted hover:text-foreground">
          Merchant console
        </Link>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Price-match policy</h1>
        <p className="max-w-2xl text-sm text-muted">
          The rules the agent negotiates within. Each save is a new version; every decision records the version it used.
        </p>
      </header>
      <Suspense fallback={<div className="h-96 animate-pulse rounded-3xl bg-surface-2" />}>
        <Policy />
      </Suspense>
    </main>
  );
}

async function Policy() {
  await connection();
  let data;
  try {
    const db = getDb();
    const [versions, usage, products] = await Promise.all([
      db.select().from(schema.policies).orderBy(desc(schema.policies.version)),
      db.select({ policyId: schema.matchRequests.policyId, n: count() }).from(schema.matchRequests).groupBy(schema.matchRequests.policyId),
      db.select().from(schema.products).where(eq(schema.products.channel3ProductId, "mgo7x7F")).limit(1),
    ]);
    data = { versions, usage, example: products[0] ?? null };
  } catch (err) {
    return <DatabaseError error={err} />;
  }
  const { versions, usage, example } = data;
  const current = versions[0];
  if (!current) return <p className="text-sm text-muted">No policy yet: run `npm run seed:demo` (or `npm run seed`).</p>;

  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr] lg:items-start">
      <section className="rounded-3xl border border-line bg-surface p-6">
        <h2 className="text-xs font-medium uppercase tracking-[0.16em] text-muted">Version {current.version} · in force</h2>
        {example && (
          <p className="mt-1 text-sm text-muted">
            Example: on the {example.title} ({formatCents(example.shopPriceCents)}), the lowest price we&apos;ll match today is{" "}
            <span className="font-medium text-foreground">{formatCents(lowestMatchPriceCents(example.shopPriceCents, example.unitCostCents, current))}</span>.
          </p>
        )}
        <div className="mt-5">
          <PolicyForm fields={policyToFields(current)} version={current.version} />
        </div>
      </section>

      <section className="rounded-3xl border border-line bg-surface p-6">
        <h2 className="text-xs font-medium uppercase tracking-[0.16em] text-muted">Version history</h2>
        <ul className="mt-4 flex flex-col divide-y divide-line text-sm">
          {versions.map((p) => (
            <li key={p.id} className="flex flex-col gap-0.5 py-3">
              <p className="font-medium">
                v{p.version} {p === current && <span className="ml-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent">in force</span>}
              </p>
              <p className="text-muted">
                Margin floor {p.marginFloorBps / 100}% · max discount {p.maxDiscountBps / 100}% · {p.protectionDays}-day window · refunds to{" "}
                {formatCents(p.autoRefundCapCents)} automatic · {p.approvedDomains.length} stores
              </p>
              <p className="text-muted">
                {p.createdBy} · {dt.format(p.createdAt)} · {usage.find((u) => u.policyId === p.id)?.n ?? 0} decisions
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
