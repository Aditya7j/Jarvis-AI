import type { FastifyPluginAsync } from "fastify";
import { aiLogger, AIError, toErrorPayload } from "../../src/lib/ai";

export const sttRoutes: FastifyPluginAsync = async (fastify) => {
  const log = aiLogger.child("stt");

  fastify.addContentTypeParser(
    ["audio/webm", "audio/ogg", "audio/mpeg", "application/octet-stream"],
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );

  fastify.post("/transcribe", async (request, reply) => {
    const apiKey = process.env.DEEPGRAM_API_KEY?.trim();
    if (!apiKey) {
      return reply.code(400).send({
        error: {
          code: "INVALID_REQUEST",
          message:
            "Deepgram is not configured. Set DEEPGRAM_API_KEY in .env to enable speech-to-text in browsers without built-in voice input.",
        },
      });
    }

    const audio = request.body as Buffer;
    if (!Buffer.isBuffer(audio) || audio.length === 0) {
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "No audio provided." },
      });
    }

    const mimeType =
      (request.headers["content-type"] as string) || "audio/webm";

    try {
      const startedAt = Date.now();
      const res = await fetch("https://api.deepgram.com/v1/listen", {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": mimeType,
        },
        body: audio,
      });
      const body = (await res.json().catch(() => null)) as {
        results?: {
          channels?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
        };
        err_msg?: string;
      } | null;

      if (!res.ok || !body) {
        const detail = body?.err_msg ? ` — ${body.err_msg}` : "";
        throw new AIError(
          `Deepgram transcription failed (${res.status})${detail}.`,
          res.status === 401 ? "AUTH_FAILED" : "CONNECTION_FAILED",
          "unknown",
          res.status
        );
      }

      const transcript =
        body.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
      log.info("Transcription completed", {
        audioBytes: audio.length,
        latencyMs: Date.now() - startedAt,
        transcriptChars: transcript.length,
      });
      return { transcript, timestamp: Date.now() };
    } catch (error) {
      const mapped = toErrorPayload(error);
      log.warn("Transcription failed", {
        code: mapped.code,
        message: mapped.message,
      });
      return reply.code(502).send({ error: mapped });
    }
  });
};
