import type { FastifyPluginAsync } from "fastify";

export const memoryRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/store", async (request, reply) => {
    const { key, value, namespace } = request.body as {
      key: string;
      value: unknown;
      namespace?: string;
    };

    return {
      stored: true,
      key,
      timestamp: Date.now(),
    };
  });

  fastify.get("/recall/:key", async (request, reply) => {
    const { key } = request.params as { key: string };

    return {
      key,
      value: null,
      found: false,
    };
  });

  fastify.post("/search", async (request, reply) => {
    const { query, limit = 10 } = request.body as {
      query: string;
      limit?: number;
    };

    return {
      results: [],
      query,
      total: 0,
    };
  });
};
