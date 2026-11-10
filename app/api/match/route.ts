import { z } from "zod";
import { MatchError, runMatch, type MatchStep } from "@/lib/match/engine";

const body = z.object({
  productId: z.uuid(),
  competitorUrl: z.url({ protocol: /^https?$/ }).max(2000),
});

// The engine can wait on Channel3 and Claude for a while.
export const maxDuration = 120;

function errorResponse(err: unknown) {
  if (err instanceof MatchError) return Response.json({ error: err.code, message: err.message }, { status: err.httpStatus });
  console.error(err);
  return Response.json({ error: "INTERNAL", message: "Something went wrong checking that link. Please try again." }, { status: 500 });
}

// POST /api/match {productId, competitorUrl} -> the decision (match / decline / review) with its evidence.
// With ?stream=1 the response is NDJSON: {type:"step",step,status} lines as the engine works, then
// {type:"result",result} or {type:"error",message}.
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "BAD_REQUEST", message: "Paste a full product link, starting with https://" }, { status: 400 });
  }

  if (new URL(req.url).searchParams.get("stream") !== "1") {
    try {
      return Response.json(await runMatch(parsed.data));
    } catch (err) {
      return errorResponse(err);
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (line: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      try {
        const result = await runMatch(parsed.data, (step: MatchStep, status) => send({ type: "step", step, status }));
        send({ type: "result", result });
      } catch (err) {
        const message =
          err instanceof MatchError ? err.message : "Something went wrong checking that link. Please try again.";
        if (!(err instanceof MatchError)) console.error(err);
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
