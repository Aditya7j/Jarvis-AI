import { aiService } from "@/lib/ai";
import { invalidRequest, tooLarge } from "@/lib/api-helpers";
import type { ProviderName } from "@/lib/ai";

export const runtime = "nodejs";

const RUNTIME_KEY_PROVIDERS: ProviderName[] = ["gemini", "openai", "anthropic"];
const MAX_API_KEY_CHARS = 600;

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
    return invalidRequest("Invalid JSON request body.");
  }

  if (!isRuntimeProvider(body.provider)) {
    return invalidRequest("Unknown provider.");
  }

  const apiKey =
    typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) {
    return invalidRequest("API key cannot be empty.");
  }
  if (apiKey.length > MAX_API_KEY_CHARS) {
    return tooLarge(`API keys are limited to ${MAX_API_KEY_CHARS} characters.`);
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
    return invalidRequest("Invalid JSON request body.");
  }

  if (!isRuntimeProvider(body.provider)) {
    return invalidRequest("Unknown provider.");
  }

  aiService.clearProvider(body.provider);
  const health = await aiService.healthCheck({ force: true });
  return Response.json({ ok: true, health });
}
