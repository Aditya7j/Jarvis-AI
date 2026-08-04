import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { aiService, aiLogger, toErrorPayload } from "../../src/lib/ai";
import {
  BATTERY_DENIED_REPLY,
  GEOLOCATION_DENIED_REPLY,
  WEATHER_NO_LOCATION_REPLY,
  buildVerifiedFactContext,
  classifyToolIntent,
  toolLabelFor,
} from "../../src/lib/ai/intent-router";
import { getSystemClock } from "../../src/lib/ai/system-tools";
import { buildNoCameraSystemContext } from "../../src/lib/ai/prompts";
import type { AIMessageInput } from "../../src/lib/ai/types";

const log = aiLogger.child("conversation");

function invalidRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({
    error: { code: "INVALID_REQUEST", message },
  });
}

type FastifyToolRoute =
  | { kind: "direct"; text: string; intent: string; tool: string }
  | { kind: "llm"; messages: AIMessageInput[]; intent: string; tool: string };

/**
 * Intent Router for the Fastify entry points. Browser-only tools cannot run
 * here, so location/battery/weather fall back to a canned reply (never an LLM
 * guess) and the system clock is served from the server's own Date/Intl.
 */
function resolveToolRoute(message: string): FastifyToolRoute {
  const intent = classifyToolIntent(message);
  const tool = toolLabelFor(intent);

  if (intent === "llm") {
    return {
      kind: "llm",
      messages: [{ role: "user", content: message }],
      intent,
      tool,
    };
  }

  if (intent === "vision" || intent === "ocr") {
    return {
      kind: "llm",
      messages: [
        { role: "system", content: buildNoCameraSystemContext() },
        { role: "user", content: message },
      ],
      intent,
      tool,
    };
  }

  switch (intent) {
    case "system-clock":
      return {
        kind: "llm",
        messages: [
          {
            role: "system",
            content: buildVerifiedFactContext(
              tool,
              "the current time, date and timezone",
              getSystemClock()
            ),
          },
          { role: "user", content: message },
        ],
        intent,
        tool,
      };
    case "geolocation":
      return { kind: "direct", text: GEOLOCATION_DENIED_REPLY, intent, tool };
    case "battery":
      return { kind: "direct", text: BATTERY_DENIED_REPLY, intent, tool };
    case "weather":
      return { kind: "direct", text: WEATHER_NO_LOCATION_REPLY, intent, tool };
    default:
      return {
        kind: "llm",
        messages: [{ role: "user", content: message }],
        intent,
        tool,
      };
  }
}

export const conversationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/message", async (request, reply) => {
    const { message, conversationId } = request.body as {
      message?: string;
      conversationId?: string;
    };

    if (!message || !message.trim()) {
      return invalidRequest(reply, "No message provided.");
    }

    try {
      const route = resolveToolRoute(message);
      log.info("[tool-routing]", {
        intent: route.intent,
        tool: route.tool,
      });
      if (route.kind === "direct") {
        return {
          id: crypto.randomUUID(),
          role: "assistant",
          content: route.text,
          conversationId: conversationId || crypto.randomUUID(),
        };
      }
      const content = await aiService.generateText({
        messages: route.messages,
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
        const route = resolveToolRoute(parsed.message);
        log.info("[tool-routing]", {
          intent: route.intent,
          tool: route.tool,
        });
        if (route.kind === "direct") {
          socket.send(JSON.stringify({ type: "token", content: route.text }));
          socket.send(JSON.stringify({ type: "done" }));
          return;
        }

        const controller = new AbortController();
        const onClose = () => controller.abort();
        socket.once("close", onClose);
        try {
          for await (const token of aiService.streamText({
            messages: route.messages,
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
