import { z } from "zod";
import { approveRefund, rejectRefund } from "@/lib/price-protection";

// The owner approves or rejects a refund queued over the auto-refund cap.
export async function POST(_req: Request, { params }: RouteContext<"/api/admin/refunds/[id]/[action]">) {
  const { id, action } = await params;
  if (!z.uuid().safeParse(id).success || (action !== "approve" && action !== "reject")) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const result = action === "approve" ? await approveRefund(id) : await rejectRefund(id);
  return Response.json(result, { status: result.error ? 409 : 200 });
}
