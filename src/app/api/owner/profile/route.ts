import { invalidRequest, jsonError } from "@/lib/api-helpers";
import { memoryService } from "@/lib/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const profile = await memoryService.getProfile();
    return Response.json({ profile });
  } catch (error) {
    return jsonError(error, 500);
  }
}

export async function PUT(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
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
