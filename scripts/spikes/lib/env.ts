import "dotenv/config";

// Exits with a clear "blocked" message instead of a stack trace when a key is missing.
export function requireEnv(...names: string[]): Record<string, string> {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    console.error(`BLOCKED: set ${missing.join(", ")} in .env (see .env.example)`);
    process.exit(2);
  }
  return Object.fromEntries(names.map((n) => [n, process.env[n] as string]));
}
