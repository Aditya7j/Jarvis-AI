import { aiService } from "@/lib/ai";
import { invalidRequest, jsonError } from "@/lib/api-helpers";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  let body: { image?: string; prompt?: string; mimeType?: string };
  try {
    body = (await request.json()) as { image?: string; prompt?: string; mimeType?: string };
  } catch {
    return invalidRequest("Invalid JSON request body.");
  }

  if (!body.image || typeof body.image !== "string") {
    return invalidRequest("No image provided.");
  }

  try {
    const description = await aiService.generateVision({
      imageBase64: body.image,
      prompt: body.prompt,
      mimeType: body.mimeType,
    });
    return Response.json({ description, timestamp: Date.now() });
  } catch (error) {
    return jsonError(error, 502);
  }
}
