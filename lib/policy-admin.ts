// The owner's policy page (PLAN.md Phase 5): read the form, then save it as a new policy version.
// Policies are append-only, so every decision keeps pointing at the version it was made under, and
// the match engine and price protection pick up the newest version on their next decision.
import { desc } from "drizzle-orm";
import { z } from "zod";
import type { Channel3Service } from "./channel3";
import { schema, type Db } from "./db";
import type { Policy } from "./db/schema";

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// "https://www.REI.com/product/123" -> "rei.com". Returns null for anything that isn't a hostname.
export function normalizeDomain(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  let host = s;
  try {
    host = new URL(s.includes("://") ? s : `https://${s}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "");
  return HOST.test(host) ? host : null;
}

// Form fields arrive as strings: percentages ("15", "12.5"), dollars ("50", "1.00") and whole days.
const percent = (label: string, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, `${label}: enter a number like 15 or 12.5`)
    .transform((s) => Math.round(Number(s) * 100))
    .refine((bps) => bps >= 0 && bps <= max * 100, `${label}: must be between 0 and ${max}%`);
const dollars = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, `${label}: enter an amount like 50 or 1.00`)
    .transform((s) => Math.round(Number(s) * 100))
    .refine((c) => c <= 1_000_000, `${label}: must be $10,000 or less`);

export const PolicyForm = z.object({
  approvedDomains: z.string().transform((s, ctx) => {
    const parts = s.split(/[\s,]+/).filter(Boolean);
    const bad = parts.filter((p) => !normalizeDomain(p));
    if (bad.length) ctx.addIssue({ code: "custom", message: `Approved stores: not a store domain: ${bad.slice(0, 3).join(", ")}` });
    const domains = [...new Set(parts.map(normalizeDomain).filter((d): d is string => !!d))];
    if (!domains.length) ctx.addIssue({ code: "custom", message: "Approved stores: list at least one store" });
    return domains;
  }),
  marginFloorBps: percent("Margin floor", 95),
  maxDiscountBps: percent("Maximum discount", 90),
  protectionDays: z
    .string()
    .trim()
    .regex(/^\d+$/, "Protection window: enter a whole number of days")
    .transform(Number)
    .refine((d) => d <= 365, "Protection window: 365 days at most"),
  autoRefundCapCents: dollars("Automatic refunds up to"),
  minRefundCents: dollars("Ignore drops under"),
  glitchAction: z.enum(["decline", "match_typical"]),
  unknownConditionAction: z.enum(["allow", "review", "decline"]),
});

export type PolicySettings = z.output<typeof PolicyForm>;
export type PolicyFormFields = z.input<typeof PolicyForm>;

export type ParsedPolicy = { ok: true; value: PolicySettings } | { ok: false; errors: string[] };

export function parsePolicyForm(fields: Record<string, unknown>): ParsedPolicy {
  const r = PolicyForm.safeParse(fields);
  return r.success ? { ok: true, value: r.data } : { ok: false, errors: r.error.issues.map((i) => i.message) };
}

// The form's starting values: the current policy, in the units the owner types.
export function policyToFields(p: Policy): PolicyFormFields {
  const pct = (bps: number) => String(bps / 100);
  const usd = (c: number) => (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));
  return {
    approvedDomains: p.approvedDomains.join("\n"),
    marginFloorBps: pct(p.marginFloorBps),
    maxDiscountBps: pct(p.maxDiscountBps),
    protectionDays: String(p.protectionDays),
    autoRefundCapCents: usd(p.autoRefundCapCents),
    minRefundCents: usd(p.minRefundCents),
    glitchAction: p.glitchAction,
    unknownConditionAction: p.unknownConditionAction,
  };
}

const SETTINGS: (keyof PolicySettings)[] = [
  "marginFloorBps",
  "maxDiscountBps",
  "protectionDays",
  "autoRefundCapCents",
  "minRefundCents",
  "glitchAction",
  "unknownConditionAction",
];

const sameStores = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

// What the new version changes, in words, for the confirmation and the log.
export function describeChanges(from: Policy, to: PolicySettings): string[] {
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  const label: Record<string, [string, (v: never) => string]> = {
    marginFloorBps: ["Margin floor", (v: number) => `${v / 100}%`],
    maxDiscountBps: ["Maximum discount", (v: number) => `${v / 100}%`],
    protectionDays: ["Protection window", (v: number) => `${v} days`],
    autoRefundCapCents: ["Automatic refunds up to", usd],
    minRefundCents: ["Ignore drops under", usd],
    glitchAction: ["One-day low prices", (v: string) => (v === "decline" ? "decline" : "match the typical price")],
    unknownConditionAction: ["Condition not stated", (v: string) => v],
  };
  const changes = SETTINGS.filter((k) => from[k] !== to[k]).map((k) => {
    const [name, fmt] = label[k];
    return `${name}: ${fmt(from[k] as never)} → ${fmt(to[k] as never)}`;
  });
  if (!sameStores(from.approvedDomains, to.approvedDomains)) {
    const added = to.approvedDomains.filter((d) => !from.approvedDomains.includes(d));
    const removed = from.approvedDomains.filter((d) => !to.approvedDomains.includes(d));
    changes.push(
      "Approved stores: " +
      [added.length ? `added ${added.join(", ")}` : "", removed.length ? `removed ${removed.join(", ")}` : ""].filter(Boolean).join("; "),
    );
  }
  return changes;
}

export class PolicySaveError extends Error {}

// Saves the settings as the next policy version. A change to the approved stores also updates the
// shop's Channel3 Collection (live mode), so search and tracking follow the same list.
export async function savePolicyVersion(
  settings: PolicySettings,
  { db, channel3, createdBy = "owner" }: { db: Db; channel3: Pick<Channel3Service, "mode" | "upsertApprovedStores">; createdBy?: string },
): Promise<{ policy: Policy; changes: string[] }> {
  const [current] = await db.select().from(schema.policies).orderBy(desc(schema.policies.version)).limit(1);
  if (!current) throw new PolicySaveError("There's no policy yet: run the seed first.");
  const changes = describeChanges(current, settings);
  if (!changes.length) throw new PolicySaveError(`Nothing changed: version ${current.version} stays in force.`);

  let collectionId = current.channel3CollectionId;
  if (channel3.mode === "live" && !sameStores(current.approvedDomains, settings.approvedDomains)) {
    try {
      collectionId = (await channel3.upsertApprovedStores(settings.approvedDomains)).collection_id;
    } catch (err) {
      throw new PolicySaveError(`Couldn't update the approved stores in Channel3, so nothing was saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const [policy] = await db
    .insert(schema.policies)
    .values({ ...settings, version: current.version + 1, channel3CollectionId: collectionId, createdBy })
    .returning();
  console.log(JSON.stringify({ msg: "policy saved", version: policy.version, createdBy, changes }));
  return { policy, changes };
}
