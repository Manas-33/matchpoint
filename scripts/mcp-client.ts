// End-to-end check of the shopper-agent MCP endpoint, as an agent would use it:
//   npm run mcp:try -- [url] [competitor link]
// Lists the tools and products, asks for a price match on the Bose headphones with the recorded Best Buy
// link, then reads the match status. Uses MCP_API_KEY (or mp_demo_key, which demo mode accepts).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import "./load-env";

const url = process.argv[2] ?? `${process.env.APP_URL ?? "http://localhost:3000"}/api/mcp`;
const competitorUrl =
  process.argv[3] ?? "https://www.bestbuy.com/product/bose-quietcomfort-ultra-headphones-2nd-gen-black/J7C5V6W7LP";
const key = process.env.MCP_API_KEY ?? process.env.MCP_API_KEYS?.split(",")[0]?.split(":").pop() ?? "mp_demo_key";

type ToolResult = { content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

const client = new Client({ name: "matchpoint-mcp-check", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
console.log(`Connected to ${url} (${client.getServerVersion()?.name})`);

const { tools } = await client.listTools();
console.log(`Tools: ${tools.map((t) => t.name).join(", ")}\n`);

const list = (await client.callTool({ name: "list_products", arguments: { query: "bose" } })) as ToolResult;
const product = (list.structuredContent?.products as { product_id: string; title: string; price: string }[])[0];
console.log(`list_products("bose") -> ${product.title}, ${product.price}, ${product.product_id}\n`);

const match = (await client.callTool({
  name: "request_price_match",
  arguments: { product: product.product_id, competitor_url: competitorUrl, buyer_email: "buyer@example.com" },
}, undefined, { timeout: 150_000 })) as ToolResult;
console.log(`request_price_match ->\n${text(match)}\n`);
const matchId = match.structuredContent?.match_id as string | undefined;

if (matchId) {
  const status = (await client.callTool({ name: "get_match_status", arguments: { match_id: matchId } })) as ToolResult;
  console.log(`get_match_status ->\n${text(status)}`);
}
await client.close();
