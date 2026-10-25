import { z } from "zod";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

// Keys the live services need. Demo mode serves recorded fixtures instead, so it needs none of them.
const LIVE_KEYS = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "CHANNEL3_API_KEY", "ANTHROPIC_API_KEY"] as const;

const optional = z.string().optional();

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    // true: Channel3, PayPal and Claude calls are answered from fixtures/, and email is only logged.
    DEMO_MODE: z.stringbool().default(false),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: "must be a postgres:// URL" }),
    APP_URL: z.url().default("http://localhost:3000"),

    PAYPAL_CLIENT_ID: optional,
    PAYPAL_CLIENT_SECRET: optional,
    PAYPAL_WEBHOOK_ID: optional,

    CHANNEL3_API_KEY: optional,
    CHANNEL3_WEBHOOK_SECRET: optional,

    ANTHROPIC_API_KEY: optional,
    ANTHROPIC_MODEL: z.string().default(DEFAULT_ANTHROPIC_MODEL),

    // Without a Resend key, email falls back to logging (always the case in demo mode).
    RESEND_API_KEY: optional,
    EMAIL_FROM: z.string().default("Matchpoint Demo Shop <onboarding@resend.dev>"),
  })
  .superRefine((env, ctx) => {
    if (env.DEMO_MODE) return;
    for (const key of LIVE_KEYS) {
      if (!env[key]) {
        ctx.addIssue({ code: "custom", path: [key], message: "required in live mode (or set DEMO_MODE=true)" });
      }
    }
  });

export type Env = z.infer<typeof schema>;

// `KEY=` in .env arrives as an empty string; treat it as unset so defaults and live-key checks apply.
export function parseEnv(source: Record<string, string | undefined>): Env {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new Error(`Invalid environment (see .env.example):\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

let cached: Env | undefined;

// Parsed on first use rather than at import, so `next build` can import modules without a full .env.
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

export const isDemoMode = () => getEnv().DEMO_MODE;
