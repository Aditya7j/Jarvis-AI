import { loadEnvConfig } from "@/lib/ai/config";
import { detectPiper, detectWhisper } from "@/lib/ai/local-tools";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const config = loadEnvConfig();
  const [piper, whisper] = await Promise.all([
    detectPiper(config),
    detectWhisper(config),
  ]);
  return Response.json({
    piper: {
      available: piper.available,
      engine: piper.engine,
      voice: config.piperVoice,
      mode: config.ttsMode,
    },
    whisper: {
      available: whisper.available,
      engine: whisper.engine,
      model: config.whisperModel,
      mode: config.sttMode,
    },
    timestamp: Date.now(),
  });
}
