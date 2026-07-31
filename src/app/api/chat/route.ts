import { aiService, toErrorPayload } from "@/lib/ai";
import { invalidRequest, jsonError } from "@/lib/api-helpers";
import { isAbortError } from "@/lib/ai/errors";
import { aiLogger } from "@/lib/ai/logger";
import { DEFAULT_SYSTEM_PROMPT, VISION_CONTEXT_PROMPT } from "@/lib/ai/prompts";
import type { AIMessageInput, VisionImage } from "@/lib/ai/types";

export const runtime = "nodejs";

interface ChatMessageBody {
  role?: string;
  content?: string;
}

interface VisionFrameBody {
  image?: string;
  mimeType?: string;
  source?: "webcam" | "screen";
}

interface ChatRequestBody {
  messages?: ChatMessageBody[];
  model?: string;
  stream?: boolean;
  vision?: { image?: string; mimeType?: string; frames?: VisionFrameBody[] };
}

interface NormalizedFrame {
  image: string;
  mimeType: string;
  source?: "webcam" | "screen";
}

const VISION_SYSTEM_TEMPLATE = (description: string) =>
  `Vision context (what you currently see):\n${description}\n\nYou have access to live vision. Use what you observe to answer the user's question when it is about the environment, the current screen, or anything visual. If the user asks about something visual, reference what you see instead of saying you cannot see them.`;

function stripDataUrlPrefix(image: string): string {
  if (image.startsWith("data:")) {
    const comma = image.indexOf(",");
    if (comma >= 0) return image.slice(comma + 1);
  }
  return image;
}

function normalizeFrames(
  vision?: ChatRequestBody["vision"]
): NormalizedFrame[] {
  const frames: NormalizedFrame[] = [];
  if (vision?.frames?.length) {
    for (const frame of vision.frames.slice(0, 2)) {
      const image = frame.image ? stripDataUrlPrefix(frame.image) : null;
      if (image) {
        frames.push({
          image,
          mimeType: frame.mimeType || "image/jpeg",
          source: frame.source,
        });
      }
    }
  }
  if (frames.length === 0 && vision?.image) {
    const image = stripDataUrlPrefix(vision.image);
    if (image) {
      frames.push({ image, mimeType: vision.mimeType || "image/jpeg" });
    }
  }
  return frames;
}

function withDefaultSystem(messages: AIMessageInput[]): AIMessageInput[] {
  if (messages.some((m) => m.role === "system")) return messages;
  return [{ role: "system", content: DEFAULT_SYSTEM_PROMPT }, ...messages];
}

function injectVisionContext(
  messages: AIMessageInput[],
  description: string
): AIMessageInput[] {
  const system = VISION_SYSTEM_TEMPLATE(description);
  const index = messages.findIndex((m) => m.role === "system");
  if (index >= 0) {
    const copy = messages.slice();
    copy[index] = {
      ...copy[index],
      content: `${copy[index].content}\n\n${system}`,
    };
    return copy;
  }
  return [
    { role: "system", content: `${DEFAULT_SYSTEM_PROMPT}\n\n${system}` },
    ...messages,
  ];
}

function toSSE(
  stream: AsyncGenerator<string>,
  signal?: AbortSignal,
  requestId?: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const startedAt = Date.now();
  let firstTokenAt: number | null = null;
  let chars = 0;
  const log = aiLogger.child("chat");
  const aborted = () => {
    stream.return(undefined).catch(() => {});
  };
  signal?.addEventListener("abort", aborted, { once: true });
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const token of stream) {
          if (signal?.aborted) break;
          if (firstTokenAt === null) {
            firstTokenAt = Date.now();
            log.info("Streaming started", {
              requestId,
              ttftMs: firstTokenAt - startedAt,
            });
          }
          chars += token.length;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ token })}\n\n`)
          );
        }
        if (!signal?.aborted) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`)
          );
          log.info("Streaming finished", {
            requestId,
            chars,
            ttftMs: firstTokenAt !== null ? firstTokenAt - startedAt : null,
            totalMs: Date.now() - startedAt,
          });
        } else {
          log.info("Streaming aborted", {
            requestId,
            chars,
            totalMs: Date.now() - startedAt,
          });
        }
      } catch (error) {
        const payload = toErrorPayload(error);
        log.warn("Streaming error", {
          requestId,
          code: payload.code,
          message: payload.message,
          totalMs: Date.now() - startedAt,
        });
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: payload })}\n\n`
          )
        );
      } finally {
        signal?.removeEventListener("abort", aborted);
        controller.close();
      }
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return invalidRequest("Invalid JSON request body.");
  }

  const messages = (body.messages ?? [])
    .map((m) => ({
      role: (m.role === "system" ? "system" : m.role === "assistant" ? "assistant" : "user") as
        | "system"
        | "user"
        | "assistant",
      content: m.content ?? "",
    }))
    .filter((m) => m.content.length > 0);

  if (messages.length === 0) {
    return invalidRequest("No message content provided.");
  }

  const options = { messages, model: body.model };
  const log = aiLogger.child("chat");
  const requestId = crypto.randomUUID();
  const frames = normalizeFrames(body.vision);
  const visionImages: VisionImage[] = frames.map((frame) => ({
    data: frame.image,
    mimeType: frame.mimeType,
    source: frame.source,
  }));
  const useVision = frames.length > 0;

  log.info("Chat request started", {
    requestId,
    messages: messages.length,
    stream: body.stream !== false,
    model: body.model ?? "auto",
    vision: useVision,
    frames: frames.length,
  });

  async function describeLatestFrame(
    frame: NormalizedFrame
  ): Promise<string | null> {
    const startedAt = Date.now();
    try {
      const description = await aiService.generateVision(
        {
          imageBase64: frame.image,
          mimeType: frame.mimeType,
          prompt: VISION_CONTEXT_PROMPT,
        },
        { trackFailures: false }
      );
      log.info("Vision context generated", {
        requestId,
        chars: description.length,
        latencyMs: Date.now() - startedAt,
      });
      return description;
    } catch (error) {
      const payload = toErrorPayload(error);
      log.warn("Vision context unavailable — continuing without it", {
        requestId,
        code: payload.code,
        message: payload.message,
        latencyMs: Date.now() - startedAt,
      });
      return null;
    }
  }

  async function* createVisionStream(): AsyncGenerator<string> {
    if (useVision) {
      try {
        yield* aiService.streamVisionChat({
          messages: withDefaultSystem(messages),
          images: visionImages,
          model: body.model,
          signal: request.signal,
        });
        return;
      } catch (error) {
        if (isAbortError(error)) throw error;
        const payload = toErrorPayload(error);
        log.warn("Vision chat stream unavailable — falling back", {
          requestId,
          code: payload.code,
          message: payload.message,
        });
      }
    }
    const description = useVision
      ? await describeLatestFrame(frames[0])
      : null;
    const finalMessages = description
      ? injectVisionContext(messages, description)
      : messages;
    yield* aiService.streamText({ ...options, signal: request.signal, messages: finalMessages });
  }

  if (body.stream === false) {
    try {
      const startedAt = Date.now();
      let text: string | null = null;
      if (useVision) {
        try {
          text = await aiService.generateVisionChat({
            messages: withDefaultSystem(messages),
            images: visionImages,
            model: body.model,
            signal: request.signal,
          });
          log.info("Vision chat request finished", {
            requestId,
            chars: text.length,
            latencyMs: Date.now() - startedAt,
          });
        } catch (error) {
          if (isAbortError(error)) throw error;
          const payload = toErrorPayload(error);
          log.warn("Vision chat unavailable — falling back", {
            requestId,
            code: payload.code,
            message: payload.message,
          });
        }
      }
      if (text === null) {
        const description = useVision
          ? await describeLatestFrame(frames[0])
          : null;
        const finalMessages = description
          ? injectVisionContext(messages, description)
          : messages;
        text = await aiService.generateText({
          ...options,
          signal: request.signal,
          messages: finalMessages,
        });
      }
      log.info("Chat request finished", {
        requestId,
        chars: text.length,
        latencyMs: Date.now() - startedAt,
      });
      return Response.json({ text });
    } catch (error) {
      return jsonError(error, 502);
    }
  }

  return new Response(
    toSSE(createVisionStream(), request.signal, requestId),
    {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    }
  );
}
