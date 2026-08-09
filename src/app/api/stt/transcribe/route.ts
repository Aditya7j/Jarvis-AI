import { transcribeAudio } from "@/lib/ai/whisper";
import { aiLogger } from "@/lib/ai/logger";
import { tooLarge } from "@/lib/api-helpers";

export const runtime = "nodejs";

const log = aiLogger.child("stt-api");
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  const mimeType = request.headers.get("content-type") || "audio/webm";
  const audio = Buffer.from(await request.arrayBuffer());

  if (audio.length === 0) {
    return Response.json(
      { error: { code: "INVALID_REQUEST", message: "No audio provided." } },
      { status: 400 }
    );
  }

  if (audio.length > MAX_AUDIO_BYTES) {
    return tooLarge("Audio clip is too large (max 30 MB).");
  }

  const result = await transcribeAudio(audio, mimeType);
  if (!result) {
    log.warn("No STT engine produced a transcript", { mimeType, bytes: audio.length });
    return Response.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message:
            "Speech-to-text is unavailable. Install Whisper locally (WHISPER_COMMAND), run a Whisper server (WHISPER_SERVER_URL), or set DEEPGRAM_API_KEY in .env. Chrome/Edge also provide built-in voice input.",
        },
      },
      { status: 400 }
    );
  }

  log.info("Transcription completed", {
    engine: result.engine,
    bytes: audio.length,
    latencyMs: result.latencyMs,
    transcriptChars: result.transcript.length,
  });
  return Response.json({
    transcript: result.transcript,
    engine: result.engine,
    timestamp: Date.now(),
  });
}
