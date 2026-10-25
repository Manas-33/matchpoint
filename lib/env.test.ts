import { describe, expect, it } from "vitest";
import { DEFAULT_ANTHROPIC_MODEL, parseEnv } from "./env";

const DATABASE_URL = "postgres://u:p@localhost:5433/db";
const LIVE = {
  DATABASE_URL,
  PAYPAL_CLIENT_ID: "id",
  PAYPAL_CLIENT_SECRET: "secret",
  CHANNEL3_API_KEY: "c3",
  ANTHROPIC_API_KEY: "sk",
};

describe("parseEnv", () => {
  it("accepts demo mode with only a database URL", () => {
    const env = parseEnv({ DEMO_MODE: "true", DATABASE_URL });
    expect(env.DEMO_MODE).toBe(true);
    expect(env.ANTHROPIC_MODEL).toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  it("defaults to live mode and requires the service keys", () => {
    expect(() => parseEnv({ DATABASE_URL })).toThrow(/PAYPAL_CLIENT_ID[\s\S]*required in live mode/);
    expect(parseEnv(LIVE).DEMO_MODE).toBe(false);
  });

  it("treats empty values as unset", () => {
    expect(() => parseEnv({ ...LIVE, ANTHROPIC_API_KEY: "" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(parseEnv({ ...LIVE, ANTHROPIC_MODEL: "" }).ANTHROPIC_MODEL).toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  it("rejects a non-Postgres database URL", () => {
    expect(() => parseEnv({ DEMO_MODE: "1", DATABASE_URL: "mysql://localhost/db" })).toThrow(/DATABASE_URL/);
  });

  it("rejects an unreadable DEMO_MODE", () => {
    expect(() => parseEnv({ DEMO_MODE: "maybe", DATABASE_URL })).toThrow(/DEMO_MODE/);
  });
});
