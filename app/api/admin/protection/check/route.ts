import { runPriceCheck } from "@/lib/price-protection";

// Fallback price check over every active protection (run daily by cron, or from the console).
export async function POST() {
  try {
    return Response.json({ results: await runPriceCheck() });
  } catch (err) {
    console.error(JSON.stringify({ msg: "price check failed", error: String(err) }));
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
