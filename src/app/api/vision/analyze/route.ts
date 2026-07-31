import { aiService, AIError, toErrorPayload } from "@/lib/ai";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  let body: { image?: string; prompt?: string; mimeType?: string };
  try {
    body = (await request.json()) as { image?: string; prompt?: string; mimeType?: string };
  } catch {
    return Response.json(
      {
        error: toErrorPayload(
          new AIError("Invalid JSON request body.", "INVALID_REQUEST")
        ),
      },
      { status: 400 }
    );
  }

  if (!body.image || typeof body.image !== "string") {
    return Response.json(
      {
        error: toErrorPayload(
          new AIError("No image provided.", "INVALID_REQUEST")
        ),
      },
      { status: 400 }
    );
  }

  try {
    const description = await aiService.generateVision({
      imageBase64: body.image,
      prompt: body.prompt,
      mimeType: body.mimeType,
    });
    return Response.json({ description, timestamp: Date.now() });
  } catch (error) {
    return Response.json({ error: toErrorPayload(error) }, { status: 502 });
  }
}
