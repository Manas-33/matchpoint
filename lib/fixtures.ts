// Recorded API responses in fixtures/. Demo mode reads them; spikes and the seed script write them.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const FIXTURES_DIR = join(process.cwd(), "fixtures");

const SECRET_KEYS =
  /^(authorization|access_token|refresh_token|id_token|client_secret|x-api-key|api_key|cookie|set-cookie|paypal-auth-assertion|webhook-secret)$/i;

function redact(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "[redacted]" : redact(v)]),
    );
  }
  return value;
}

const withJson = (path: string) => (path.endsWith(".json") ? path : `${path}.json`);

// Returns the path written, relative to the repo root.
export function saveFixture(path: string, data: unknown): string {
  const file = join(FIXTURES_DIR, withJson(path));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(redact(data), null, 2) + "\n");
  return join("fixtures", withJson(path));
}

export function hasFixture(path: string): boolean {
  return existsSync(join(FIXTURES_DIR, withJson(path)));
}

export function loadFixture<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, withJson(path)), "utf8")) as T;
}

export function listFixtures(dir: string): string[] {
  const full = join(FIXTURES_DIR, dir);
  return existsSync(full) ? readdirSync(full).filter((f) => f.endsWith(".json")).sort() : [];
}

export const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

// Thrown when demo mode is asked for something no fixture covers.
export class MissingFixtureError extends Error {
  constructor(what: string) {
    super(`Demo mode: no recorded fixture for ${what}`);
    this.name = "MissingFixtureError";
  }
}
