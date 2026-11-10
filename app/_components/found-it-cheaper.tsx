import { LinkIcon, TagIcon } from "./icons";

// "Found it cheaper?" box. A placeholder until the match engine (PLAN.md Phase 3) is wired up.
export function FoundItCheaper({ approvedDomains }: { approvedDomains: string[] }) {
  const examples = approvedDomains.slice(0, 3).join(", ");
  return (
    <section aria-labelledby="match-heading" className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
            <TagIcon className="size-[18px]" />
          </span>
          <h2 id="match-heading" className="font-display text-lg font-semibold whitespace-nowrap">
            Found it cheaper?
          </h2>
        </div>
        <span className="shrink-0 rounded-full bg-surface-2 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider whitespace-nowrap text-muted">
          Coming soon
        </span>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        Paste the link from a major retailer{examples ? ` such as ${examples}` : ""}. We check it&apos;s the same item, in
        stock and new, then match the price at checkout.
      </p>
      <form className="mt-4 flex flex-col gap-2 sm:flex-row">
        <label className="relative flex-1">
          <span className="sr-only">Competitor product link</span>
          <LinkIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <input
            type="url"
            disabled
            placeholder="https://www.retailer.com/product/…"
            className="h-11 w-full cursor-not-allowed rounded-xl border border-line bg-background pr-3 pl-9 text-sm placeholder:text-muted/70 disabled:opacity-70"
          />
        </label>
        <button
          type="submit"
          disabled
          className="h-11 cursor-not-allowed rounded-xl border border-line bg-surface-2 px-5 text-sm font-medium text-muted"
        >
          Check price
        </button>
      </form>
      {approvedDomains.length > 0 && (
        <details className="group mt-4 text-sm">
          <summary className="cursor-pointer list-none text-muted transition hover:text-foreground [&::-webkit-details-marker]:hidden">
            <span className="underline decoration-line underline-offset-4">Which stores do we match?</span>
          </summary>
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {approvedDomains.map((d) => (
              <li key={d} className="rounded-full border border-line px-2.5 py-1 text-xs text-muted">
                {d}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
