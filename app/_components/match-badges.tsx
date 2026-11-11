const DECISION: Record<string, { label: string; tone: string }> = {
  match: { label: "Matched", tone: "bg-accent-soft text-accent" },
  decline: { label: "Declined", tone: "bg-danger-soft text-danger" },
  review: { label: "Needs review", tone: "bg-amber-soft text-amber" },
};

export function DecisionPill({ decision }: { decision: string }) {
  const d = DECISION[decision] ?? { label: decision, tone: "bg-surface-2 text-muted" };
  return <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${d.tone}`}>{d.label}</span>;
}

// A request a shopper's AI agent made over MCP, named by its API key.
export function AgentBadge({ name }: { name: string | null }) {
  return (
    <span className="shrink-0 rounded-full border border-accent px-2 py-0.5 text-xs font-medium text-accent" title={name ? `API key: ${name}` : undefined}>
      via agent{name && name !== "agent" ? ` · ${name}` : ""}
    </span>
  );
}
