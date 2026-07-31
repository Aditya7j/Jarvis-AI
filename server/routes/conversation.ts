import type { FastifyPluginAsync } from "fastify";
import { aiService, toErrorPayload } from "../../src/lib/ai";

export const conversationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/message", async (request, reply) => {
    const { message, conversationId } = request.body as {
      message?: string;
      conversationId?: string;
    };

    if (!message || !message.trim()) {
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "No message provided." },
      });
    }

    try {
      const content = await aiService.generateText({
        messages: [{ role: "user", content: message }],
      });
      return {
        id: crypto.randomUUID(),
        role: "assistant",
        content,
        conversationId: conversationId || crypto.randomUUID(),
      };
    } catch (error) {
      return reply.code(502).send({ error: toErrorPayload(error) });
    }
  });

  fastify.get("/:id", async (request) => {
    const { id } = request.params as { id: string };
    return {
      id,
      messages: [],
      createdAt: Date.now(),
    };
  });

  fastify.get("/ws", { websocket: true }, (socket) => {
    socket.on("message", async (data) => {
      let parsed: { message?: string };
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        socket.send(
          JSON.stringify({
            type: "error",
            error: { code: "INVALID_REQUEST", message: "Invalid JSON payload." },
          })
        );
        return;
      }

      if (!parsed.message?.trim()) {
        socket.send(
          JSON.stringify({
            type: "error",
            error: { code: "INVALID_REQUEST", message: "No message provided." },
          })
        );
        return;
      }

      try {
        const controller = new AbortController();
        const onClose = () => controller.abort();
        socket.once("close", onClose);
        try {
          for await (const token of aiService.streamText({
            messages: [{ role: "user", content: parsed.message }],
            signal: controller.signal,
          })) {
            if (socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({ type: "token", content: token }));
            }
          }
        } finally {
          socket.off("close", onClose);
        }
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: "done" }));
        }
      } catch (error) {
        if (socket.readyState === socket.OPEN) {
          socket.send(
            JSON.stringify({ type: "error", error: toErrorPayload(error) })
          );
        }
      }
    });
  });
};
