import { aiService } from "@/lib/ai";
import { jsonError } from "@/lib/api-helpers";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const result = await aiService.listModels();
    return Response.json(result);
  } catch (error) {
    return jsonError(error, 502);
  }
}
