import { invalidRequest, jsonError, tooLarge } from "@/lib/api-helpers";
import { memoryService } from "@/lib/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PROFILE_BODY_CHARS = 8_000;

export async function GET(): Promise<Response> {
  try {
    const profile = await memoryService.getProfile();
    return Response.json({ profile });
  } catch (error) {
    return jsonError(error, 500);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const raw = await request.text();
  if (raw.length > MAX_PROFILE_BODY_CHARS) {
    return tooLarge(`Profile payload is limited to ${MAX_PROFILE_BODY_CHARS} characters.`);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return invalidRequest("Invalid JSON request body.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return invalidRequest("Invalid profile payload.");
  }
  try {
    const profile = await memoryService.updateProfile(
      body as Record<string, unknown>
    );
    return Response.json({ profile });
  } catch (error) {
    return jsonError(error, 400);
  }
}
