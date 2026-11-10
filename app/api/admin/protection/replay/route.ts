import { z } from "zod";
import { replaySimulatedDrop } from "@/lib/price-protection";

// Demo: re-inject the recorded Channel3 price.changed payload as a SIMULATED drop for one protection.
export async function POST(req: Request) {
  const body = z.object({ protectionId: z.uuid() }).safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "protectionId required" }, { status: 400 });
  try {
    return Response.json(await replaySimulatedDrop(body.data.protectionId));
  } catch (err) {
    console.error(JSON.stringify({ msg: "replay failed", error: String(err) }));
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
