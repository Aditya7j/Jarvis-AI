import { aiService, AIError, toErrorPayload } from "@/lib/ai";
import type { ProviderName } from "@/lib/ai";

export const runtime = "nodejs";

const RUNTIME_KEY_PROVIDERS: ProviderName[] = ["gemini", "openai", "anthropic"];

function isRuntimeProvider(value: unknown): value is ProviderName {
  return (
    typeof value === "string" &&
    (RUNTIME_KEY_PROVIDERS as string[]).includes(value)
  );
}

export async function POST(request: Request): Promise<Response> {
  let body: { provider?: unknown; apiKey?: unknown };
  try {
    body = (await request.json()) as { provider?: unknown; apiKey?: unknown };
  } catch {
    return Response.json(
      {
        error: toErrorPayload(
          new AIError("Invalid JSON request body.", "INVALID_REQUEST")
        ),
      },
      { status: 400 }
    );
  }

  if (!isRuntimeProvider(body.provider)) {
    return Response.json(
      {
        error: toErrorPayload(
          new AIError("Unknown provider.", "INVALID_REQUEST")
        ),
      },
      { status: 400 }
    );
  }

  const apiKey =
    typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) {
    return Response.json(
      {
        error: toErrorPayload(
          new AIError("API key cannot be empty.", "INVALID_REQUEST")
        ),
      },
      { status: 400 }
    );
  }

  aiService.configureProvider(body.provider, apiKey);
  const health = await aiService.healthCheck({ force: true });
  return Response.json({ ok: true, health });
}

export async function DELETE(request: Request): Promise<Response> {
  let body: { provider?: unknown };
  try {
    body = (await request.json()) as { provider?: unknown };
  } catch {
    return Response.json(
      {
        error: toErrorPayload(
          new AIError("Invalid JSON request body.", "INVALID_REQUEST")
        ),
      },
      { status: 400 }
    );
  }

  if (!isRuntimeProvider(body.provider)) {
    return Response.json(
      {
        error: toErrorPayload(
          new AIError("Unknown provider.", "INVALID_REQUEST")
        ),
      },
      { status: 400 }
    );
  }

  aiService.clearProvider(body.provider);
  const health = await aiService.healthCheck({ force: true });
  return Response.json({ ok: true, health });
}
