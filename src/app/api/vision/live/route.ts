import { invalidRequest, tooLarge } from "@/lib/api-helpers";
import {
  liveVisionEngine,
  type LiveFrameInput,
} from "@/lib/vision/live-vision-engine";export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IMAGE_CHARS = 8_000_000;

function stripDataUrlPrefix(image: string): string {
  if (image.startsWith("data:")) {
    const comma = image.indexOf(",");
    if (comma >= 0) return image.slice(comma + 1);
  }
  return image;
}

/**
 * POST /api/vision/live
 *  - { action: "start", source } starts the persistent live session,
 *  - { action: "stop" } stops it and cancels any in-flight analysis,
 *  - { image, ... } submits the newest camera frame for background analysis.
 *
 * GET /api/vision/live returns the latest analyzed frame, object detections and
 * engine stats so the client can poll for partial/current results.
 */
export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return invalidRequest("Invalid JSON request body.");
  }

  const action = body.action;
  if (action === "start") {
    const source = body.source === "screen" ? "screen" : "webcam";
    liveVisionEngine.start(source);
    return Response.json({ ok: true, stats: liveVisionEngine.getStats() });
  }
  if (action === "stop") {
    liveVisionEngine.stop();
    return Response.json({ ok: true, stats: liveVisionEngine.getStats() });
  }

  if (typeof body.image !== "string" || !body.image) {
    return invalidRequest("No image provided.");
  }
  if (body.image.length > MAX_IMAGE_CHARS) {
    return tooLarge("Vision frame is too large.");
  }

  const frame: LiveFrameInput = {
    image: stripDataUrlPrefix(body.image),
    mimeType: typeof body.mimeType === "string" ? body.mimeType : "image/jpeg",
    source: body.source === "screen" ? "screen" : "webcam",
    width: typeof body.width === "number" ? body.width : undefined,
    height: typeof body.height === "number" ? body.height : undefined,
    capturedAt: typeof body.capturedAt === "number" ? body.capturedAt : undefined,
    captureMs: typeof body.captureMs === "number" ? body.captureMs : undefined,
    encodeMs: typeof body.encodeMs === "number" ? body.encodeMs : undefined,
  };

  const result = liveVisionEngine.submit(frame);
  return Response.json({
    ok: true,
    result,
    analyzing: liveVisionEngine.isAnalyzing(),
    stats: liveVisionEngine.getStats(),
    vision: liveVisionEngine.getSceneState(),
  });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const source = url.searchParams.get("source") === "screen" ? "screen" : "webcam";
  return Response.json({
    result: liveVisionEngine.getResult(source),
    analyzing: liveVisionEngine.isAnalyzing(),
    stats: liveVisionEngine.getStats(),
    vision: liveVisionEngine.getSceneState(),
  });
}
