import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getEnv } from "@/lib/env";
import { findAgentKey, parseAgentKeys, presentedKey, RateLimiter } from "@/lib/mcp/auth";
import { createMatchpointMcpServer } from "@/lib/mcp/tools";

// The shopper-agent MCP endpoint, over Streamable HTTP. Stateless: every request gets a fresh server
// and transport, and replies are plain JSON (no SSE stream), so it works behind any proxy.
// Auth: `Authorization: Bearer <key>` or `X-API-Key: <key>`, keys from MCP_API_KEYS.

// A price match waits on Channel3 and Claude.
export const maxDuration = 120;

// 60 requests a minute per key; one price match is a handful (initialize, list, call).
const limiter = ((globalThis as { matchpointMcpLimiter?: RateLimiter }).matchpointMcpLimiter ??= new RateLimiter(60, 60_000));

const rpcError = (status: number, message: string, headers: Record<string, string> = {}) =>
  Response.json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }, { status, headers });

async function handle(req: Request): Promise<Response> {
  const env = getEnv();
  const keys = parseAgentKeys(env.MCP_API_KEYS, env.DEMO_MODE);
  if (!keys.length) return rpcError(503, "The agent endpoint is off: set MCP_API_KEYS.");
  const agent = findAgentKey(keys, presentedKey(req.headers));
  if (!agent) return rpcError(401, "Missing or unknown API key (Authorization: Bearer <key>).", { "WWW-Authenticate": "Bearer" });
  const retryAfter = limiter.take(agent.key);
  if (retryAfter) return rpcError(429, `Rate limit: ${limiter.limit} requests a minute. Retry in ${retryAfter}s.`, { "Retry-After": String(retryAfter) });

  const server = createMatchpointMcpServer(agent.name);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // With JSON responses the reply is complete once handleRequest returns.
    void server.close();
  }
}

// No server-initiated stream and no sessions: clients that try to open one get 405, as the spec allows.
const methodNotAllowed = () =>
  Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: POST JSON-RPC requests to this endpoint." }, id: null }, { status: 405, headers: { Allow: "POST" } });

export { handle as POST, methodNotAllowed as GET, methodNotAllowed as DELETE };
