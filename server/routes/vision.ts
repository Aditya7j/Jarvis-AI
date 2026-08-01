import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { aiService, toErrorPayload } from "../../src/lib/ai";

function invalidImage(reply: FastifyReply, message: string) {
  return reply.code(400).send({
    error: { code: "INVALID_REQUEST", message },
  });
}

export const visionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/analyze", async (request, reply) => {
    const { image, prompt } = request.body as {
      image?: string;
      prompt?: string;
    };

    if (!image || typeof image !== "string") {
      return invalidImage(reply, "No image provided.");
    }

    try {
      const description = await aiService.generateVision({
        imageBase64: image,
        prompt,
      });
      return {
        description,
        timestamp: Date.now(),
      };
    } catch (error) {
      return reply.code(502).send({ error: toErrorPayload(error) });
    }
  });

  fastify.post("/ocr", async (request, reply) => {
    const { image } = request.body as { image?: string };

    if (!image || typeof image !== "string") {
      return invalidImage(reply, "No image provided.");
    }

    try {
      const text = await aiService.generateVision(
        {
          imageBase64: image,
          prompt:
            "Extract all text from this image. Return only the extracted text, preserving layout order.",
        },
        { includeMemory: false }
      );
      return {
        text,
        timestamp: Date.now(),
      };
    } catch (error) {
      return reply.code(502).send({ error: toErrorPayload(error) });
    }
  });
};
