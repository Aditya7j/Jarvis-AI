import { invalidRequest, jsonError } from "@/lib/api-helpers";
import { memoryService } from "@/lib/memory";
import { isMemoryCategory } from "@/lib/memory/sanitize";
import type { MemoryEntryPatch } from "@/lib/memory/types";

export const runtime = "nodejs";

export async function PATCH(
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
  if (typeof body !== "object" || body === null) {
    return invalidRequest("Invalid memory entry payload.");
  }
  const record = body as Record<string, unknown>;
  const patch: MemoryEntryPatch = {};
  if (record.content !== undefined) {
    if (typeof record.content !== "string" || !record.content.trim()) {
      return invalidRequest("Memory content cannot be empty.");
    }
    patch.content = record.content;
  }
  if (record.category !== undefined) {
    if (!isMemoryCategory(record.category)) {
      return invalidRequest("Invalid memory category.");
    }
    patch.category = record.category;
  }
  if (record.note !== undefined) {
    patch.note = typeof record.note === "string" ? record.note : "";
  }
  try {
    const entry = await memoryService.updateEntry(id, patch);
    if (!entry) {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "Memory entry not found." } },
        { status: 404 }
      );
    }
    return Response.json({ entry });
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: { id: string } }
): Promise<Response> {
  const { id } = context.params;
  try {
    const deleted = await memoryService.deleteEntry(id);
    if (!deleted) {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "Memory entry not found." } },
        { status: 404 }
      );
    }
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error, 500);
  }
}
