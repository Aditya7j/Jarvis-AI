import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import { conversationRoutes } from "./routes/conversation";
import { visionRoutes } from "./routes/vision";
import { sttRoutes } from "./routes/stt";
import { ttsRoutes } from "./routes/tts";
import { assistantRoutes } from "./routes/assistant";
import { aiService, APP_VERSION } from "../src/lib/ai";
import { initToolRouter } from "../src/services/tools";
import { startTaskAutomation } from "../src/services/tasks";

const server = Fastify({
  logger: {
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss" },
    },
  },
});

async function main() {
  initToolRouter();
  startTaskAutomation();

  await server.register(cors, { origin: true });
  await server.register(fastifyWebsocket);

  await server.register(conversationRoutes, { prefix: "/api/conversation" });
  await server.register(assistantRoutes, { prefix: "/api/assistant" });
  await server.register(visionRoutes, { prefix: "/api/vision" });
  await server.register(sttRoutes, { prefix: "/api/stt" });
  await server.register(ttsRoutes, { prefix: "/api/tts" });

  server.get("/health", async () => {
    const health = await aiService.healthCheck();
    return { ...health, version: APP_VERSION };
  });

  try {
    await server.listen({
      port: Number(process.env.PORT) || 3001,
      host: "0.0.0.0",
    });
    console.log(`🚀 JARVIS AI Server running on port ${server.addresses()[0].port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
