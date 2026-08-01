import { jsonError } from "@/lib/api-helpers";
import { memoryService } from "@/lib/memory";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  try {
    await memoryService.clearAll();
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error, 500);
  }
}
