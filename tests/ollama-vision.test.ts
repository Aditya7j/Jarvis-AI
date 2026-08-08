import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { OllamaProvider } from "@/lib/ai/providers/ollama";

/**
 * Regression test for the camera-frame latency fix.
 *
 * Before the fix, `generateVision` sent NO `num_predict`, so Ollama defaulted
 * to the model's full context (2048+ tokens) and kept generating for minutes
 * on CPU-only hardware even though the JSON answers are ~100-400 tokens. It
 * also sent full-res frames. These tests pin the request body to a bounded
 * output budget and a downscaled image.
 */

function makeProvider(): { provider: OllamaProvider; fetchImpl: ReturnType<typeof vi.fn> } {
  const fetchImpl = vi.fn(async () =>
    new Response(JSON.stringify({ message: { content: '{"held": "phone"}' } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchImpl);
  const provider = new OllamaProvider({
    baseUrl: "http://localhost:11434",
    model: null,
    gemma3Model: "gemma3:4b",
    timeoutMs: 60_000,
    visionTimeoutMs: 30_000,
    healthTimeoutMs: 10_000,
  });
  return { provider, fetchImpl };
}

async function tinyJpegBase64(): Promise<string> {
  const buffer = await sharp({
    create: {
      width: 1280,
      height: 720,
      channels: 3,
      background: { r: 10, g: 20, b: 30 },
    },
  })
    .jpeg()
    .toBuffer();
  return buffer.toString("base64");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Ollama generateVision", () => {
  it("sends an explicit num_predict matching the caller's maxTokens", async () => {
    const { provider, fetchImpl } = makeProvider();
    await provider.generateVision({
      imageBase64: await tinyJpegBase64(),
      prompt: "look at the hands",
      model: "gemma3:4b",
      maxTokens: 96,
    });

    const body = JSON.parse(
      fetchImpl.mock.calls[0][1].body as string
    ) as {
      model: string;
      options: { num_predict: number };
      messages: { images: string[] }[];
    };
    expect(body.model).toBe("gemma3:4b");
    expect(body.options.num_predict).toBe(96);
    expect(body.messages[0].images).toHaveLength(1);
  });

  it("applies a safe default budget when the caller does not set one", async () => {
    const { provider, fetchImpl } = makeProvider();
    await provider.generateVision({
      imageBase64: await tinyJpegBase64(),
      prompt: "describe",
      model: "gemma3:4b",
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string) as {
      options: { num_predict: number };
    };
    expect(body.options.num_predict).toBe(512);
  });

  it("downscales the frame before sending it to Ollama", async () => {
    const { provider, fetchImpl } = makeProvider();
    const original = await tinyJpegBase64();
    await provider.generateVision({
      imageBase64: original,
      prompt: "describe",
      model: "gemma3:4b",
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string) as {
      messages: { images: string[] }[];
    };
    const sentBase64 = body.messages[0].images[0];
    const sent = await sharp(Buffer.from(sentBase64, "base64")).metadata();
    expect(Math.max(sent.width!, sent.height!)).toBeLessThanOrEqual(512);

    const originalMeta = await sharp(Buffer.from(original, "base64")).metadata();
    expect(sent.width!).toBeLessThan(originalMeta.width!);
  });
});
