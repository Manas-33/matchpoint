import { count, desc } from "drizzle-orm";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb, schema } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { formatCents } from "@/lib/money";

// Placeholder home page for the scaffold: shows the run mode and what the seed put in the database.
// Phase 2 replaces it with the shop catalog.
export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Matchpoint</h1>
        <p className="text-stone-600 dark:text-stone-400">
          Price match at checkout and price protection after the sale, for independent shops.
        </p>
      </header>
      <Suspense fallback={<p className="text-stone-500">Checking status…</p>}>
        <Status />
      </Suspense>
    </main>
  );
}

async function Status() {
  await connection();
  const env = getEnv();
  const db = getDb();

  let data;
  try {
    const [[{ products }], [policy], catalog] = await Promise.all([
      db.select({ products: count() }).from(schema.products),
      db.select().from(schema.policies).orderBy(desc(schema.policies.version)).limit(1),
      db
        .select({
          slug: schema.products.slug,
          title: schema.products.title,
          shopPriceCents: schema.products.shopPriceCents,
        })
        .from(schema.products)
        .orderBy(schema.products.title),
    ]);
    data = { products, policy, catalog };
  } catch (err) {
    return (
      <section className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
        <p className="font-medium">Database unavailable</p>
        <p className="text-sm">{err instanceof Error ? err.message : String(err)}</p>
        <p className="mt-2 text-sm">
          Run <code>npm run db:up</code>, <code>npm run db:migrate</code> and <code>npm run seed</code>.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Mode" value={env.DEMO_MODE ? "Demo (fixtures)" : "Live (sandbox)"} />
        <Stat label="Products" value={String(data.products)} />
        <Stat label="Policy" value={data.policy ? `v${data.policy.version}` : "none"} />
        <Stat label="Approved stores" value={data.policy ? String(data.policy.approvedDomains.length) : "–"} />
      </dl>
      {data.catalog.length === 0 ? (
        <p className="text-stone-600 dark:text-stone-400">
          No products yet. Run <code>npm run seed</code>.
        </p>
      ) : (
        <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
          {data.catalog.map((p) => (
            <li key={p.slug} className="flex justify-between gap-4 px-4 py-2 text-sm">
              <span>{p.title}</span>
              <span className="tabular-nums">{formatCents(p.shopPriceCents)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
      <dt className="text-xs uppercase tracking-wide text-stone-500">{label}</dt>
      <dd className="mt-1 font-medium">{value}</dd>
    </div>
  );
}
