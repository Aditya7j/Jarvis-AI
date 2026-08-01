import { invalidRequest, jsonError } from "@/lib/api-helpers";
import { memoryService } from "@/lib/memory";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: { id: string } }
): Promise<Response> {
  const { id } = context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidRequest("Invalid JSON request body.");
  }
  const approved =
    typeof body === "object" &&
    body !== null &&
    (body as Record<string, unknown>).approved === true;
  try {
    const entry = await memoryService.setEntryStatus(
      id,
      approved ? "approved" : "rejected"
    );
    if (!entry) {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "Memory entry not found." } },
        { status: 404 }
      );
    }
    return Response.json({ entry });
  } catch (error) {
    return jsonError(error, 500);
  }
}
