import { aiService, toErrorPayload } from "@/lib/ai";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const result = await aiService.listModels();
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: toErrorPayload(error) }, { status: 502 });
  }
}
