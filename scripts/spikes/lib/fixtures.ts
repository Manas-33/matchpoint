import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = "fixtures";
const SECRET_KEYS =
  /^(authorization|access_token|refresh_token|id_token|client_secret|x-api-key|api_key|cookie|set-cookie|paypal-auth-assertion|webhook-secret)$/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "[redacted]" : redact(v)]),
    );
  }
  return value;
}

export function saveFixture(path: string, data: unknown): string {
  const file = join(ROOT, path.endsWith(".json") ? path : `${path}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(redact(data), null, 2) + "\n");
  console.log(`  saved ${file}`);
  return file;
}

export function loadFixture<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8")) as T;
}

export function listFixtures(dir: string): string[] {
  const full = join(ROOT, dir);
  return existsSync(full) ? readdirSync(full).filter((f) => f.endsWith(".json")).sort() : [];
}

export const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
