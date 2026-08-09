import { synthesizeSpeech } from "@/lib/ai/piper";
import { aiLogger } from "@/lib/ai/logger";
import { tooLarge } from "@/lib/api-helpers";

export const runtime = "nodejs";

const log = aiLogger.child("tts-api");
const MAX_TEXT_CHARS = 2_000;

export async function POST(request: Request): Promise<Response> {
  let text: string;
  try {
    const body = (await request.json()) as { text?: string };
    text = (body.text ?? "").trim();
  } catch {
    return Response.json(
      { error: { code: "INVALID_REQUEST", message: "Invalid JSON request body." } },
      { status: 400 }
    );
  }

  if (!text) {
    return Response.json(
      { error: { code: "INVALID_REQUEST", message: "No text provided." } },
      { status: 400 }
    );
  }

  if (text.length > MAX_TEXT_CHARS) {
    return tooLarge(`Speech text is limited to ${MAX_TEXT_CHARS} characters.`);
  }

  const result = await synthesizeSpeech(text);
  if (!result) {
    log.warn("Piper unavailable — client should fall back to browser speech");
    return Response.json(
      {
        error: {
          code: "PROVIDER_ERROR",
          message:
            "Piper is not available. Install it locally (PIPER_COMMAND), run a Piper server (PIPER_SERVER_URL), or use the browser's built-in voice.",
        },
      },
      { status: 501 }
    );
  }

  log.info("Speech synthesized", {
    engine: result.engine,
    chars: text.length,
    bytes: result.audio.length,
    latencyMs: result.latencyMs,
  });
  return new Response(new Uint8Array(result.audio), {
    headers: {
      "Content-Type": result.mimeType,
      "Cache-Control": "no-store",
    },
  });
}
