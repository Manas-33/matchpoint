import { formatCents } from "@/lib/money";

type Point = { at: string; priceCents: number };

// Channel3's daily price history as a line, with the price paid as a dashed reference line and the
// price that triggered the refund as the final dot (amber when simulated).
export function PriceSparkline({
  history,
  paidCents,
  dropCents,
  dropAt,
  simulated,
}: {
  history: Point[];
  paidCents: number;
  dropCents: number;
  dropAt: Date;
  simulated: boolean;
}) {
  const W = 600;
  const H = 140;
  const pad = { l: 8, r: 8, t: 16, b: 16 };
  const points = [...history.map((p) => ({ t: new Date(p.at).getTime(), v: p.priceCents }))];
  const dropT = dropAt.getTime();
  const allT = [...points.map((p) => p.t), dropT];
  const allV = [...points.map((p) => p.v), paidCents, dropCents];
  const t0 = Math.min(...allT);
  const t1 = Math.max(...allT);
  const vMin = Math.min(...allV);
  const vMax = Math.max(...allV);
  const span = vMax - vMin || 1;
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - vMin) / span) * (H - pad.t - pad.b);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const last = points.at(-1);

  return (
    <figure className="flex flex-col gap-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-36 w-full" role="img" aria-label="Price history">
        <line x1={pad.l} x2={W - pad.r} y1={y(paidCents)} y2={y(paidCents)} className="stroke-muted" strokeDasharray="4 4" strokeWidth={1} />
        <text x={W - pad.r} y={y(paidCents) - 5} textAnchor="end" className="fill-muted text-[11px]">
          You paid {formatCents(paidCents)}
        </text>
        {line && <path d={line} fill="none" className="stroke-accent" strokeWidth={2} strokeLinejoin="round" />}
        {last && (
          <line
            x1={x(last.t)}
            y1={y(last.v)}
            x2={x(dropT)}
            y2={y(dropCents)}
            className={simulated ? "stroke-amber" : "stroke-accent"}
            strokeDasharray={simulated ? "3 3" : undefined}
            strokeWidth={2}
          />
        )}
        <circle cx={x(dropT)} cy={y(dropCents)} r={5} className={simulated ? "fill-amber" : "fill-accent"} />
      </svg>
      <figcaption className="flex flex-wrap justify-between gap-2 text-xs text-muted">
        <span>
          {history.length > 0
            ? `Channel3 price history, ${history.length} days (low ${formatCents(Math.min(...history.map((h) => h.priceCents)))}, high ${formatCents(
                Math.max(...history.map((h) => h.priceCents)),
              )})`
            : "No Channel3 price history available"}
        </span>
        <span className={simulated ? "font-medium text-amber" : ""}>
          ● {formatCents(dropCents)} {simulated ? "simulated drop" : "price that triggered the refund"}
        </span>
      </figcaption>
    </figure>
  );
}
