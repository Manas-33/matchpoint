"use client";

// "Found it cheaper?" box: the customer pastes a competitor link, the match engine checks it (with live
// progress over NDJSON), and the box shows the decision. A match pays the matched price through the same
// PayPal checkout as a normal purchase; the server prices it from the saved match request.
import Image from "next/image";
import Link from "next/link";
import { useRef, useState } from "react";
import type { MatchResult, MatchStep } from "@/lib/match/engine";
import type { Check } from "@/lib/match/rules";
import { formatCents } from "@/lib/money";
import { ArrowRightIcon, CheckIcon, LinkIcon, ShieldIcon, TagIcon } from "./icons";
import { PayPalCheckout } from "./paypal-checkout";

const STEPS: { step: MatchStep; label: string }[] = [
  { step: "lookup", label: "Look up the listing" },
  { step: "compare", label: "Compare the product" },
  { step: "history", label: "Check price history" },
  { step: "rules", label: "Apply shop rules" },
];

type StepState = Partial<Record<MatchStep, "running" | "done">>;
type State =
  | { kind: "idle" }
  | { kind: "checking"; steps: StepState }
  | { kind: "result"; result: MatchResult }
  | { kind: "error"; message: string };

type Payment = { mode: "live"; clientId: string } | { mode: "demo" };

type Props = {
  productId: string;
  productSlug: string;
  currency: string;
  approvedDomains: string[];
  protectionDays: number | null;
  payment: Payment;
  demoLinks: { label: string; url: string }[];
};

export function FoundItCheaper(props: Props) {
  const { approvedDomains, demoLinks } = props;
  const [url, setUrl] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const input = useRef<HTMLInputElement>(null);
  const examples = approvedDomains.slice(0, 3).join(", ");
  const busy = state.kind === "checking";

  async function check(link: string) {
    setState({ kind: "checking", steps: {} });
    try {
      const res = await fetch("/api/match?stream=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: props.productId, competitorUrl: link }),
      });
      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.message ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const steps: StepState = {};
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          const event = JSON.parse(line);
          if (event.type === "step") {
            steps[event.step as MatchStep] = event.status;
            setState({ kind: "checking", steps: { ...steps } });
          } else if (event.type === "result") {
            setState({ kind: "result", result: event.result });
            return;
          } else if (event.type === "error") {
            throw new Error(event.message);
          }
        }
        if (done) throw new Error("The check stopped before it finished. Please try again.");
      }
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : "Something went wrong" });
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const link = url.trim();
    if (!/^https?:\/\/\S+\.\S+/.test(link)) {
      setState({ kind: "error", message: "Paste the full product link, starting with https://" });
      input.current?.focus();
      return;
    }
    void check(link);
  }

  function reset() {
    setState({ kind: "idle" });
    setUrl("");
    requestAnimationFrame(() => input.current?.focus());
  }

  return (
    <section aria-labelledby="match-heading" className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <TagIcon className="size-[18px]" />
        </span>
        <h2 id="match-heading" className="font-display text-lg font-semibold whitespace-nowrap">
          Found it cheaper?
        </h2>
      </div>

      {state.kind !== "result" && (
        <>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Paste the link from a major retailer{examples ? ` such as ${examples}` : ""}. We check it&apos;s the same item,
            in stock and new, then match the price at checkout.
          </p>
          <form onSubmit={submit} className="mt-4 flex flex-col gap-2 sm:flex-row">
            <label className="relative flex-1">
              <span className="sr-only">Competitor product link</span>
              <LinkIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
              <input
                ref={input}
                type="url"
                inputMode="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={busy}
                placeholder="https://www.retailer.com/product/…"
                className="h-11 w-full rounded-xl border border-line bg-background pr-3 pl-9 text-sm placeholder:text-muted/70 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-70"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="h-11 rounded-xl bg-accent px-5 text-sm font-medium text-accent-ink transition hover:brightness-110 disabled:opacity-60"
            >
              {busy ? "Checking…" : "Check price"}
            </button>
          </form>
          {demoLinks.length > 0 && state.kind !== "checking" && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted">Try:</span>
              {demoLinks.map((d) => (
                <button
                  key={d.url}
                  type="button"
                  onClick={() => {
                    setUrl(d.url);
                    void check(d.url);
                  }}
                  className="rounded-full border border-line px-2.5 py-1 text-muted transition hover:border-accent hover:text-accent"
                >
                  {d.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {state.kind === "checking" && <Progress steps={state.steps} />}
      {state.kind === "error" && (
        <p role="alert" className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.message}
        </p>
      )}
      {state.kind === "result" && <Decision result={state.result} props={props} onReset={reset} />}

      {state.kind === "idle" && approvedDomains.length > 0 && (
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

function Progress({ steps }: { steps: StepState }) {
  // The first step not yet done is the one in progress.
  const current = STEPS.find((s) => steps[s.step] !== "done")?.step;
  return (
    <ol className="mt-5 flex flex-col gap-2.5" aria-live="polite">
      {STEPS.map(({ step, label }, i) => {
        const done = steps[step] === "done";
        const active = step === current;
        return (
          <li key={step} className={`flex items-center gap-3 text-sm ${done || active ? "" : "text-muted"}`}>
            <span
              className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-xs ${
                done ? "border-accent bg-accent text-accent-ink" : active ? "border-accent text-accent" : "border-line"
              }`}
            >
              {done ? <CheckIcon className="size-3.5" /> : active ? <span className="size-2 animate-pulse rounded-full bg-accent" /> : i + 1}
            </span>
            {label}
            {active && <span className="text-muted">…</span>}
          </li>
        );
      })}
    </ol>
  );
}

function Decision({ result, props, onReset }: { result: MatchResult; props: Props; onReset: () => void }) {
  const fmt = (c: number) => formatCents(c, result.currency);
  const failing = result.checks.filter((c) => c.status === "fail" || c.status === "review");

  if (result.decision === "match" && result.matchedPriceCents != null) {
    return <Matched result={result} props={props} onReset={onReset} />;
  }

  if (result.decision === "decline") {
    return (
      <div className="mt-4 flex flex-col gap-4">
        <div className="rounded-xl bg-danger-soft p-4">
          <p className="text-sm font-medium text-danger">We can&apos;t match this one</p>
          <p className="mt-1 leading-relaxed">{result.headline}</p>
          {result.customerMessage && <p className="mt-2 text-sm leading-relaxed text-muted">{result.customerMessage}</p>}
        </div>
        {result.decidedBy === "history" && result.history && result.competitorPriceCents != null && (
          <Sparkline history={result.history} competitorCents={result.competitorPriceCents} fmt={fmt} />
        )}
        <Evidence checks={failing.length ? failing : result.checks} result={result} />
        {result.alternatives.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Instead</p>
            {result.alternatives.map((a) => (
              <Link
                key={a.slug}
                href={`/products/${a.slug}`}
                className="flex items-center gap-3 rounded-xl border border-line p-3 transition hover:border-accent"
              >
                <div className="product-frame relative size-12 shrink-0 overflow-hidden rounded-lg border border-line">
                  {a.imageUrl && <Image src={a.imageUrl} alt="" fill sizes="48px" className="object-contain p-1" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{a.title}</p>
                  <p className="text-xs text-muted">
                    {a.isThisProduct ? "Brand new from us" : "In stock here"}
                    {props.protectionDays != null ? `, with ${props.protectionDays}-day price protection` : ""}
                  </p>
                </div>
                <span className="text-sm font-medium tabular-nums">{fmt(a.priceCents)}</span>
                <ArrowRightIcon className="size-4 shrink-0 text-muted" />
              </Link>
            ))}
          </div>
        )}
        <Footer result={result} onReset={onReset} />
      </div>
    );
  }

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="rounded-xl bg-amber-soft p-4">
        <p className="text-sm font-medium text-amber">Sent for staff review</p>
        <p className="mt-1 leading-relaxed">{result.headline}</p>
        <p className="mt-2 text-sm text-muted">
          Reference {result.matchRequestId.slice(0, 8).toUpperCase()}. You can still buy at our price now; the price
          protection covers you if it drops.
        </p>
      </div>
      <Evidence checks={failing.length ? failing : result.checks} result={result} />
      <Footer result={result} onReset={onReset} />
    </div>
  );
}

function Matched({ result, props, onReset }: { result: MatchResult; props: Props; onReset: () => void }) {
  const fmt = (c: number) => formatCents(c, result.currency);
  const store = result.competitorDomain ?? "that store";
  const offer = result.valueOffer;
  // The agent offers the value match first; the cash match is always one click away.
  const [choice, setChoice] = useState<"value" | "match">(offer ? "value" : "match");
  const matched = fmt(result.matchedPriceCents!);
  const payCents = choice === "value" ? result.shopPriceCents : result.matchedPriceCents!;
  const pay = fmt(payCents);

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="rounded-xl bg-accent-soft p-4">
        <p className="text-sm font-medium text-accent">Price matched to {store}</p>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-3xl font-semibold tabular-nums">{matched}</span>
          <span className="text-muted tabular-nums line-through">{fmt(result.shopPriceCents)}</span>
          {result.savingsCents != null && result.savingsCents > 0 && (
            <span className="rounded-full bg-accent px-2.5 py-0.5 text-xs font-medium text-accent-ink">
              You save {fmt(result.savingsCents)}
            </span>
          )}
        </div>
        {result.customerMessage && <p className="mt-2 text-sm leading-relaxed">{result.customerMessage}</p>}
      </div>
      <Evidence checks={result.checks} result={result} />

      {offer && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">Or get more for your money</legend>
          <Option
            selected={choice === "value"}
            onSelect={() => setChoice("value")}
            title={`${offer.kind === "store_credit" ? `${fmt(offer.customerValueCents)} store credit` : offer.title}, worth ${fmt(offer.customerValueCents)}`}
            detail={`${offer.description} You pay our price, ${fmt(result.shopPriceCents)}.`}
            badge={`${fmt(offer.customerValueCents)} value`}
          />
          <Option
            selected={choice === "match"}
            onSelect={() => setChoice("match")}
            title={`Price match: ${matched}`}
            detail={`${fmt(result.savingsCents ?? 0)} off, matching ${store}.`}
            badge={`${fmt(result.savingsCents ?? 0)} off`}
          />
        </fieldset>
      )}

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">
          Pay {pay} with PayPal{choice === "value" && offer ? ` and get ${offer.kind === "store_credit" ? `${fmt(offer.customerValueCents)} store credit` : offer.title.toLowerCase()}` : ""}
        </p>
        {/* Keyed by the choice so the PayPal button is set up again for the new amount. */}
        {props.payment.mode === "live" ? (
          <PayPalCheckout
            key={choice}
            mode="live"
            clientId={props.payment.clientId}
            productSlug={props.productSlug}
            currency={props.currency}
            matchRequestId={result.matchRequestId}
            matchOption={choice}
          />
        ) : (
          <PayPalCheckout
            key={choice}
            mode="demo"
            productSlug={props.productSlug}
            currency={props.currency}
            matchRequestId={result.matchRequestId}
            matchOption={choice}
            label={`Pay ${pay} with PayPal`}
          />
        )}
        {props.protectionDays != null && (
          <p className="flex items-center gap-2 text-xs text-muted">
            <ShieldIcon className="size-3.5 shrink-0 text-amber" />
            Still covered by our {props.protectionDays}-day price protection at {pay}.
          </p>
        )}
      </div>
      <Footer result={result} onReset={onReset} />
    </div>
  );
}

function Option({
  selected,
  onSelect,
  title,
  detail,
  badge,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  detail: string;
  badge: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${
        selected ? "border-accent bg-accent-soft/50" : "border-line hover:border-accent/60"
      }`}
    >
      <input type="radio" name="match-option" checked={selected} onChange={onSelect} className="mt-1 accent-[var(--accent)]" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs leading-relaxed text-muted">{detail}</span>
      </span>
      <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium tabular-nums">{badge}</span>
    </label>
  );
}

const STATUS_STYLE: Record<Check["status"], string> = {
  pass: "bg-accent text-accent-ink",
  fail: "bg-danger text-white",
  review: "bg-amber text-white",
  skip: "bg-surface-2 text-muted",
};

function Evidence({ checks, result }: { checks: Check[]; result: MatchResult }) {
  return (
    <details className="group text-sm" open={result.decision !== "match"}>
      <summary className="cursor-pointer list-none text-muted transition hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span className="underline decoration-line underline-offset-4">
          {result.decision === "match" ? `Why it matched (${result.checks.length} checks)` : "What we checked"}
        </span>
      </summary>
      <ul className="mt-3 flex flex-col gap-2.5">
        {checks.map((c) => (
          <li key={c.code} className="flex gap-2.5">
            <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${STATUS_STYLE[c.status]}`}>
              {c.status === "pass" ? <CheckIcon className="size-2.5" /> : c.status === "fail" ? "✕" : c.status === "review" ? "?" : "–"}
            </span>
            <span className="leading-snug">
              <span className="font-medium">{c.label}.</span> {c.message}
              {c.source && <span className="ml-1 font-mono text-[11px] text-muted">[{c.source}]</span>}
            </span>
          </li>
        ))}
      </ul>
      {result.modelReasons.length > 0 && (
        <div className="mt-3 rounded-xl border border-line p-3">
          <p className="text-xs font-medium uppercase tracking-wider text-muted">Product comparison</p>
          <ul className="mt-2 flex flex-col gap-1.5 text-xs leading-relaxed text-muted">
            {result.modelReasons.map((r, i) => (
              <li key={i}>
                <span className="font-mono text-foreground">
                  {r.listing}.{r.field}
                </span>{" "}
                {r.observation}
              </li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}

function Sparkline({
  history,
  competitorCents,
  fmt,
}: {
  history: NonNullable<MatchResult["history"]>;
  competitorCents: number;
  fmt: (c: number) => string;
}) {
  const values = history.series.map((p) => p.cents);
  const max = Math.max(...values, history.typicalCents);
  const min = Math.min(...values, competitorCents);
  const w = 280;
  const h = 56;
  const x = (i: number) => (i / Math.max(values.length - 1, 1)) * w;
  const y = (c: number) => h - 4 - ((c - min) / Math.max(max - min, 1)) * (h - 8);
  return (
    <figure className="rounded-xl border border-line p-3">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-14 w-full" preserveAspectRatio="none" role="img" aria-label="Price over the last 30 days">
        <line x1="0" x2={w} y1={y(history.typicalCents)} y2={y(history.typicalCents)} className="stroke-line" strokeDasharray="4 3" />
        <polyline
          fill="none"
          className="stroke-accent"
          strokeWidth="1.5"
          points={values.map((c, i) => `${x(i)},${y(c)}`).join(" ")}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption className="mt-1 flex justify-between text-xs text-muted">
        <span>Last {history.windowDays} days</span>
        <span>
          Typical {fmt(history.typicalCents)} · this link {fmt(competitorCents)}
        </span>
      </figcaption>
    </figure>
  );
}

function Footer({ result, onReset }: { result: MatchResult; onReset: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-xs text-muted">
      <span>
        Decision {result.matchRequestId.slice(0, 8).toUpperCase()} · policy v{result.policyVersion}
        {result.mode === "demo" ? " · demo data" : ""}
      </span>
      <button type="button" onClick={onReset} className="underline underline-offset-4 hover:text-foreground">
        Check another link
      </button>
    </div>
  );
}
