import { invalidRequest, jsonError } from "@/lib/api-helpers";
import { memoryService } from "@/lib/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const privacy = await memoryService.getPrivacy();
    return Response.json({ privacy });
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
  if (typeof body !== "object" || body === null) {
    return invalidRequest("Invalid privacy payload.");
  }
  try {
    const privacy = await memoryService.setPrivacy(
      body as Record<string, unknown>
    );
    return Response.json({ privacy });
  } catch (error) {
    return jsonError(error, 400);
  }
}
