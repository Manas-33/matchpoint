export function DatabaseError({ error }: { error: unknown }) {
  return (
    <section className="rounded-2xl border border-danger/30 bg-danger-soft p-5 text-danger">
      <p className="font-medium">Database unavailable</p>
      <p className="mt-1 text-sm">{error instanceof Error ? error.message : String(error)}</p>
      <p className="mt-2 text-sm">
        Run <code className="font-mono">npm run db:up</code>, <code className="font-mono">npm run db:migrate</code> and{" "}
        <code className="font-mono">npm run seed</code>.
      </p>
    </section>
  );
}
