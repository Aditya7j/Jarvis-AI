import {
  recentMetrics,
  subscribe,
  type ModelRequestMetric,
} from "@/lib/metrics/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;

export async function GET(request: Request): Promise<Response> {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (metric: ModelRequestMetric): void => {
        controller.enqueue(
          encoder.encode(`event: metric\ndata: ${JSON.stringify(metric)}\n\n`)
        );
      };

      if (request.signal.aborted) {
        controller.close();
        return;
      }

      for (const metric of recentMetrics()) {
        send(metric);
      }

      const unsubscribe = subscribe(send);
      const onAbort = () => {
        unsubscribe();
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
      };
      request.signal.addEventListener("abort", onAbort, { once: true });

      heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(": ping\n\n"));
      }, HEARTBEAT_MS);
    },
    cancel() {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
