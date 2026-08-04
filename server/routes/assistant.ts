import type { FastifyPluginAsync } from "fastify";
import { aiLogger, aiService, toErrorPayload } from "../../src/lib/ai";
import {
  runPipeline,
  runPipelineText,
  type PipelineEvent,
} from "../../src/services/chat";
import type { PipelineOptions } from "../../src/services/chat";

const log = aiLogger.child("assistant");

interface AssistantBody {
  message?: string;
  conversationId?: string;
  clientTools?: PipelineOptions["clientTools"];
  includeAwareness?: boolean;
  includeMemory?: boolean;
}

function invalidRequest(message: string) {
  return {
    error: { code: "INVALID_REQUEST", message },
  };
}

export const assistantRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/message", async (request, reply) => {
    const body = (request.body ?? {}) as AssistantBody;
    const message = body.message;
    if (!message || !message.trim()) {
      return reply.code(400).send(invalidRequest("No message provided."));
    }

    const startedAt = Date.now();
    try {
      const model = {
        streamText: (opts: { messages: Parameters<typeof aiService.streamText>[0]["messages"]; signal?: AbortSignal }) =>
          aiService.streamText({ ...opts }),
      };
      const result = await runPipelineText(
        message,
        [{ role: "user", content: message }],
        model,
        {
          clientTools: body.clientTools,
          includeAwareness: body.includeAwareness,
          includeMemory: body.includeMemory,
        }
      );
      log.info("[assistant:message]", {
        intent: result.intent,
        latencyMs: Date.now() - startedAt,
        chars: result.text.length,
      });
      return {
        id: crypto.randomUUID(),
        role: "assistant",
        content: result.text,
        intent: result.intent,
        conversationId: body.conversationId || crypto.randomUUID(),
      };
    } catch (error) {
      return reply.code(502).send({ error: toErrorPayload(error) });
    }
  });

  fastify.get("/ws", { websocket: true }, (socket) => {
    socket.on("message", async (data) => {
      let parsed: AssistantBody;
      try {
        parsed = JSON.parse(data.toString()) as AssistantBody;
      } catch {
        socket.send(JSON.stringify(invalidRequest("Invalid JSON payload.")));
        return;
      }
      if (!parsed.message?.trim()) {
        socket.send(JSON.stringify(invalidRequest("No message provided.")));
        return;
      }

      const controller = new AbortController();
      const onClose = () => controller.abort();
      socket.once("close", onClose);
      const model = {
        streamText: (opts: { messages: Parameters<typeof aiService.streamText>[0]["messages"]; signal?: AbortSignal }) =>
          aiService.streamText({ ...opts, signal: controller.signal }),
      };

      try {
        for await (const event of runPipeline(
          parsed.message,
          [{ role: "user", content: parsed.message }],
          model,
          { clientTools: parsed.clientTools, includeAwareness: parsed.includeAwareness }
        )) {
          if (socket.readyState !== socket.OPEN) break;
          switch (event.kind) {
            case "token":
              socket.send(JSON.stringify({ type: "token", content: event.text }));
              break;
            case "status":
              socket.send(JSON.stringify({ type: "status", phase: event.phase }));
              break;
            case "tool":
              socket.send(JSON.stringify({ type: "tool", routing: event }));
              break;
            case "fact":
              socket.send(JSON.stringify({ type: "fact", tool: event.tool, subject: event.subject }));
              break;
            case "done":
              socket.send(JSON.stringify({ type: "done" }));
              break;
          }
        }
      } catch (error) {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: "error", error: toErrorPayload(error) }));
        }
      } finally {
        socket.off("close", onClose);
      }
    });
  });
};

export type { PipelineEvent };
