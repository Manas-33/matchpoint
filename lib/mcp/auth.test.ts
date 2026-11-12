import { describe, expect, it } from "vitest";
import { DEMO_MCP_KEY, findAgentKey, parseAgentKeys, presentedKey, RateLimiter } from "./auth";

describe("parseAgentKeys", () => {
  it("reads name:key pairs and bare keys", () => {
    expect(parseAgentKeys(" claude-desktop:k1 , k2,,", false)).toEqual([
      { name: "claude-desktop", key: "k1" },
      { name: "agent", key: "k2" },
    ]);
  });
  it("falls back to the demo key only in demo mode", () => {
    expect(parseAgentKeys(undefined, true)).toEqual([{ name: "demo-agent", key: DEMO_MCP_KEY }]);
    expect(parseAgentKeys("", false)).toEqual([]);
    expect(parseAgentKeys("mine:abc", true)).toEqual([{ name: "mine", key: "abc" }]);
  });
});

describe("presentedKey / findAgentKey", () => {
  const keys = parseAgentKeys("a:alpha,b:beta", false);
  it("accepts a bearer token or X-API-Key", () => {
    expect(presentedKey(new Headers({ Authorization: "Bearer beta" }))).toBe("beta");
    expect(presentedKey(new Headers({ "X-API-Key": "alpha" }))).toBe("alpha");
    expect(presentedKey(new Headers())).toBeNull();
  });
  it("finds the matching key and nothing else", () => {
    expect(findAgentKey(keys, "beta")?.name).toBe("b");
    expect(findAgentKey(keys, "bet")).toBeNull();
    expect(findAgentKey(keys, null)).toBeNull();
  });
});

describe("RateLimiter", () => {
  it("allows `limit` requests per window, then reports the wait", () => {
    let now = 0;
    const limiter = new RateLimiter(2, 60_000, () => now);
    expect(limiter.take("k")).toBe(0);
    expect(limiter.take("k")).toBe(0);
    expect(limiter.take("k")).toBe(60);
    expect(limiter.take("other")).toBe(0);
    now = 59_000;
    expect(limiter.take("k")).toBe(1);
    now = 60_000;
    expect(limiter.take("k")).toBe(0);
  });
});
