import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import { conversationRoutes } from "./routes/conversation";
import { visionRoutes } from "./routes/vision";
import { memoryRoutes } from "./routes/memory";
import { sttRoutes } from "./routes/stt";
import { aiService, APP_VERSION } from "../src/lib/ai";

const server = Fastify({
  logger: {
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss" },
    },
  },
});

async function main() {
  await server.register(cors, { origin: true });
  await server.register(fastifyWebsocket);

  await server.register(conversationRoutes, { prefix: "/api/conversation" });
  await server.register(visionRoutes, { prefix: "/api/vision" });
  await server.register(memoryRoutes, { prefix: "/api/memory" });
  await server.register(sttRoutes, { prefix: "/api/stt" });

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
