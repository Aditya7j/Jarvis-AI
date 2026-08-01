import { jsonError } from "@/lib/api-helpers";
import { memoryService } from "@/lib/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const context = await memoryService.buildContext();
    return Response.json({ enabled: context !== null, context });
  } catch (error) {
    return jsonError(error, 500);
  }
}
