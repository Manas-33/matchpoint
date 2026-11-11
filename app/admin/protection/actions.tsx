"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type Outcome = {
  orderId: string;
  decision: string;
  amountCents: number;
  reasons: { code: string; message: string }[];
  refund?: { id: string; status: string; paypalRefundId: string | null };
  error?: string;
};
type Result = { title: string; duplicate?: boolean; outcomes: Outcome[]; error?: string; note?: string };

const usd = (c: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(c / 100);

async function post(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// Buttons for the console: run the fallback price check, replay a simulated drop, approve or reject.
export function ConsoleButton({
  kind,
  protectionId,
  refundId,
  label,
  tone = "default",
}: {
  kind: "check" | "replay" | "approve" | "reject";
  protectionId?: string;
  refundId?: string;
  label: string;
  tone?: "default" | "amber" | "quiet";
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Result | null>(null);

  function run() {
    startTransition(async () => {
      let r: Result;
      try {
        if (kind === "check") {
          const json = await post("/api/admin/protection/check");
          r = json.error
            ? { title: "Price check failed", outcomes: [], error: json.error }
            : {
                title: "Price check",
                outcomes: json.results.flatMap((x: { outcomes: Outcome[] }) => x.outcomes),
                note: json.results
                  .map(
                    (x: { channel3ProductId: string; checked: { domain: string; priceCents: number } | null; duplicate?: boolean; error?: string }) =>
                      `${x.channel3ProductId}: ${x.error ?? (x.checked ? `lowest approved in-stock offer ${usd(x.checked.priceCents)} at ${x.checked.domain}${x.duplicate ? " (already recorded today)" : ""}` : "no approved in-stock offer")}`,
                  )
                  .join(" · "),
              };
        } else if (kind === "replay") {
          const json = await post("/api/admin/protection/replay", { protectionId });
          r = json.error
            ? { title: "Replay failed", outcomes: [], error: json.error }
            : { title: "Replayed simulated drop", duplicate: json.duplicate, outcomes: json.outcomes };
        } else {
          const json = await post(`/api/admin/refunds/${refundId}/${kind}`);
          r = { title: kind === "approve" ? "Approved" : "Rejected", outcomes: [], error: json.error };
        }
      } catch (err) {
        r = { title: "Request failed", outcomes: [], error: String(err) };
      }
      setResult(r);
      router.refresh();
    });
  }

  const styles = {
    default: "bg-accent text-accent-ink",
    amber: "bg-amber text-background",
    quiet: "border border-line bg-surface text-foreground",
  }[tone];

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className={`rounded-xl px-4 py-2 text-sm font-medium transition hover:brightness-95 disabled:opacity-60 ${styles}`}
      >
        {pending ? "Working…" : label}
      </button>
      {result && <ResultCard result={result} />}
    </div>
  );
}

function ResultCard({ result }: { result: Result }) {
  return (
    <div className="w-full rounded-xl border border-line bg-surface-2 p-3 text-sm">
      <p className="font-medium">
        {result.title}
        {result.duplicate ? " · same event as before, nothing new" : ""}
      </p>
      {result.error && <p className="mt-1 text-danger">{result.error}</p>}
      {result.note && <p className="mt-1 text-muted">{result.note}</p>}
      {result.outcomes.length === 0 && !result.error && !result.note && <p className="mt-1 text-muted">No active protections affected.</p>}
      <ul className="mt-2 flex flex-col gap-2">
        {result.outcomes.map((o) => (
          <li key={o.orderId}>
            <span className="font-medium">
              Order {o.orderId.slice(0, 8).toUpperCase()}: {o.decision}
              {o.amountCents > 0 ? ` ${usd(o.amountCents)}` : ""}
            </span>
            {o.refund?.paypalRefundId && <span className="text-muted"> · PayPal refund {o.refund.paypalRefundId}</span>}
            {o.error && <span className="text-danger"> · {o.error}</span>}
            <span className="block text-muted">{o.reasons.at(-1)?.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
