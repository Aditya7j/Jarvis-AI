import type { FastifyPluginAsync } from "fastify";
import { aiLogger } from "../../src/lib/ai";
import { transcribeAudio } from "../../src/lib/ai/whisper";

export const sttRoutes: FastifyPluginAsync = async (fastify) => {
  const log = aiLogger.child("stt");

  fastify.addContentTypeParser(
    ["audio/webm", "audio/ogg", "audio/mpeg", "application/octet-stream"],
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );

  fastify.post("/transcribe", async (request, reply) => {
    const audio = request.body as Buffer;
    if (!Buffer.isBuffer(audio) || audio.length === 0) {
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "No audio provided." },
      });
    }

    const mimeType =
      (request.headers["content-type"] as string) || "audio/webm";

    try {
      const result = await transcribeAudio(audio, mimeType);
      if (!result) {
        return reply.code(400).send({
          error: {
            code: "INVALID_REQUEST",
            message:
              "Speech-to-text is unavailable. Install Whisper locally (WHISPER_COMMAND), run a Whisper server (WHISPER_SERVER_URL), or set DEEPGRAM_API_KEY in .env.",
          },
        });
      }
      log.info("Transcription completed", {
        engine: result.engine,
        audioBytes: audio.length,
        latencyMs: result.latencyMs,
        transcriptChars: result.transcript.length,
      });
      return { transcript: result.transcript, engine: result.engine, timestamp: Date.now() };
    } catch (error) {
      log.warn("Transcription failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return reply.code(502).send({
        error: {
          code: "PROVIDER_ERROR",
          message: "Speech-to-text failed unexpectedly.",
        },
      });
    }
  });
};
