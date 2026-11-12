// API keys and rate limiting for the shopper-agent MCP endpoint (/api/mcp).
import { createHash, timingSafeEqual } from "node:crypto";

export type AgentKey = { name: string; key: string };

// The key demo mode accepts when MCP_API_KEYS is unset, so a judge can connect an agent with no setup.
export const DEMO_MCP_KEY = "mp_demo_key";

// MCP_API_KEYS is a comma-separated list of `name:key` (or bare `key`, named "agent"). The name is
// recorded on every match request the key makes and shown in the console.
export function parseAgentKeys(raw: string | undefined, demoMode: boolean): AgentKey[] {
  const keys = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.indexOf(":");
      return i > 0 ? { name: entry.slice(0, i).trim(), key: entry.slice(i + 1).trim() } : { name: "agent", key: entry };
    })
    .filter((k) => k.key.length > 0);
  if (!keys.length && demoMode) return [{ name: "demo-agent", key: DEMO_MCP_KEY }];
  return keys;
}

// The key from `Authorization: Bearer <key>` or `X-API-Key: <key>`.
export function presentedKey(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim() || null;
  return headers.get("x-api-key")?.trim() || null;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

// Compares hashes so the comparison takes the same time whatever the key's length or content.
export function findAgentKey(keys: AgentKey[], presented: string | null): AgentKey | null {
  if (!presented) return null;
  const p = digest(presented);
  let found: AgentKey | null = null;
  for (const k of keys) if (timingSafeEqual(digest(k.key), p)) found = k;
  return found;
}

// Fixed-window limit per key, in memory (one app instance is enough for the demo).
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private now: () => number = Date.now,
  ) {}

  // Returns 0 when the request may go ahead, else the seconds until the window resets.
  take(key: string): number {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      return 0;
    }
    if (w.count >= this.limit) return Math.ceil((w.start + this.windowMs - t) / 1000);
    w.count++;
    return 0;
  }
}
