"use server";

import { revalidatePath } from "next/cache";
import { getChannel3 } from "@/lib/channel3";
import { getDb } from "@/lib/db";
import { parsePolicyForm, PolicySaveError, savePolicyVersion } from "@/lib/policy-admin";

export type SaveState = { status: "idle" } | { status: "saved"; version: number; changes: string[] } | { status: "error"; errors: string[] };

const FIELDS = ["approvedDomains", "marginFloorBps", "maxDiscountBps", "protectionDays", "autoRefundCapCents", "minRefundCents", "glitchAction", "unknownConditionAction"];

// The policy form's submit: validate, save as the next version, refresh the console pages.
export async function savePolicy(_prev: SaveState, form: FormData): Promise<SaveState> {
  const parsed = parsePolicyForm(Object.fromEntries(FIELDS.map((f) => [f, String(form.get(f) ?? "")])));
  if (!parsed.ok) return { status: "error", errors: parsed.errors };
  try {
    const { policy, changes } = await savePolicyVersion(parsed.value, { db: getDb(), channel3: getChannel3() });
    revalidatePath("/admin", "layout");
    return { status: "saved", version: policy.version, changes };
  } catch (err) {
    if (err instanceof PolicySaveError) return { status: "error", errors: [err.message] };
    console.error(err);
    return { status: "error", errors: ["Something went wrong saving the policy. Please try again."] };
  }
}
