import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getEnv } from "../env";
import * as schema from "./schema";

export { schema };

function connect() {
  const client = postgres(getEnv().DATABASE_URL, { max: 10, onnotice: () => {} });
  return { client, db: drizzle({ client, schema }) };
}

type Connection = ReturnType<typeof connect>;

// One pool per process. Kept on globalThis so dev-server hot reloads don't open a new pool each time.
const globalForDb = globalThis as unknown as { matchpointDb?: Connection };

export function getDb() {
  globalForDb.matchpointDb ??= connect();
  return globalForDb.matchpointDb.db;
}

export type Db = ReturnType<typeof getDb>;

// For scripts: let the process exit once work is done.
export async function closeDb() {
  await globalForDb.matchpointDb?.client.end();
  globalForDb.matchpointDb = undefined;
}
