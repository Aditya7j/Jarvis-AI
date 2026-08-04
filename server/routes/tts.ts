import type { FastifyPluginAsync } from "fastify";
import { aiLogger, loadEnvConfig } from "../../src/lib/ai";
import { detectPiper } from "../../src/lib/ai/local-tools";
import { synthesizeSpeech } from "../../src/lib/ai/piper";

export const ttsRoutes: FastifyPluginAsync = async (fastify) => {
  const log = aiLogger.child("tts");

  fastify.get("/status", async () => {
    const config = loadEnvConfig();
    const piper = await detectPiper(config);
    return {
      piper: {
        available: piper.available,
        engine: piper.engine,
        voice: config.piperVoice,
        mode: config.ttsMode,
      },
      timestamp: Date.now(),
    };
  });

  fastify.post("/speak", async (request, reply) => {
    const { text } = (request.body ?? {}) as { text?: string };
    const clean = (text ?? "").trim();
    if (!clean) {
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "No text provided." },
      });
    }

    try {
      const result = await synthesizeSpeech(clean);
      if (!result) {
        return reply.code(501).send({
          error: {
            code: "PROVIDER_ERROR",
            message:
              "Piper is not available. Install it locally (PIPER_COMMAND) or run a Piper server (PIPER_SERVER_URL).",
          },
        });
      }
      log.info("Speech synthesized", {
        chars: clean.length,
        bytes: result.audio.length,
        latencyMs: result.latencyMs,
      });
      return reply
        .header("Content-Type", result.mimeType)
        .header("Cache-Control", "no-store")
        .send(result.audio);
    } catch (error) {
      log.warn("TTS synthesis failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return reply.code(502).send({
        error: {
          code: "PROVIDER_ERROR",
          message: "Speech synthesis failed unexpectedly.",
        },
      });
    }
  });
};
