"use client";

import { useActionState } from "react";
import type { PolicyFormFields } from "@/lib/policy-admin";
import { savePolicy, type SaveState } from "./actions";

const input = "w-full rounded-xl border border-line bg-background px-3 py-2 text-sm outline-none focus:border-accent";

export function PolicyForm({ fields, version }: { fields: PolicyFormFields; version: number }) {
  const [state, action, pending] = useActionState<SaveState, FormData>(savePolicy, { status: "idle" });

  return (
    // Keyed by version so the fields reset to the saved values after each save.
    <form key={version} action={action} className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Margin floor" hint="A matched price keeps at least this gross margin over unit cost." suffix="%">
          <input name="marginFloorBps" defaultValue={fields.marginFloorBps} inputMode="decimal" className={input} />
        </Field>
        <Field label="Maximum discount" hint="Match at most this far below our price." suffix="%">
          <input name="maxDiscountBps" defaultValue={fields.maxDiscountBps} inputMode="decimal" className={input} />
        </Field>
        <Field label="Protection window" hint="Days after payment that price drops are refunded." suffix="days">
          <input name="protectionDays" defaultValue={fields.protectionDays} inputMode="numeric" className={input} />
        </Field>
        <Field label="Automatic refunds up to" hint="Larger refunds wait for your approval." prefix="$">
          <input name="autoRefundCapCents" defaultValue={fields.autoRefundCapCents} inputMode="decimal" className={input} />
        </Field>
        <Field label="Ignore drops under" hint="Smaller price drops aren't refunded." prefix="$">
          <input name="minRefundCents" defaultValue={fields.minRefundCents} inputMode="decimal" className={input} />
        </Field>
        <Field label="One-day low prices" hint="A price seen on one day well below the 30-day typical price.">
          <select name="glitchAction" defaultValue={fields.glitchAction} className={input}>
            <option value="decline">Decline as a pricing glitch</option>
            <option value="match_typical">Match the typical price instead</option>
          </select>
        </Field>
        <Field label="Condition not stated" hint="When no listing says whether it's new.">
          <select name="unknownConditionAction" defaultValue={fields.unknownConditionAction} className={input}>
            <option value="review">Send to review</option>
            <option value="allow">Treat as new</option>
            <option value="decline">Decline</option>
          </select>
        </Field>
      </div>
      <Field label="Approved stores" hint="One domain per line. Only these stores are matched and protected against; in live mode the Channel3 Collection is updated too.">
        <textarea name="approvedDomains" defaultValue={fields.approvedDomains} rows={6} className={`${input} font-mono`} />
      </Field>

      {state.status === "error" && (
        <ul className="rounded-2xl bg-danger-soft px-4 py-3 text-sm text-danger">
          {state.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {state.status === "saved" && (
        <div className="rounded-2xl bg-accent-soft px-4 py-3 text-sm text-accent">
          <p className="font-medium">Saved as policy version {state.version}. The next decision uses it.</p>
          <ul className="mt-1 list-disc pl-5">
            {state.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink transition hover:brightness-110 disabled:opacity-60"
        >
          {pending ? "Saving…" : `Save as version ${version + 1}`}
        </button>
      </div>
    </form>
  );
}

function Field({ label, hint, prefix, suffix, children }: { label: string; hint: string; prefix?: string; suffix?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <span className="flex items-center gap-2">
        {prefix && <span className="text-sm text-muted">{prefix}</span>}
        {children}
        {suffix && <span className="text-sm text-muted">{suffix}</span>}
      </span>
      <span className="text-xs text-muted">{hint}</span>
    </label>
  );
}
