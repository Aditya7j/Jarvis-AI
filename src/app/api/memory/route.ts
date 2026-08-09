import { invalidRequest, jsonError, tooLarge } from "@/lib/api-helpers";
import { memoryService } from "@/lib/memory";
import { isMemoryCategory } from "@/lib/memory/sanitize";
import type { MemoryEntryInput } from "@/lib/memory/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CONTENT_CHARS = 8_000;
const MAX_NOTE_CHARS = 500;

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? "all";
    const category = url.searchParams.get("category") ?? "all";
    const search = url.searchParams.get("search") ?? "";
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;

    const entries = await memoryService.listEntries({
      status: status === "all" ? "all" : (status as never),
      category: category === "all" ? "all" : (category as never),
      search,
      limit,
    });
    return Response.json({ entries });
  } catch (error) {
    return jsonError(error, 500);
  }
}

export async function POST(request: Request): Promise<Response> {
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
  if (typeof record.content !== "string" || !record.content.trim()) {
    return invalidRequest("Memory content is required.");
  }
  if (record.content.length > MAX_CONTENT_CHARS) {
    return tooLarge(
      `Memory content is limited to ${MAX_CONTENT_CHARS} characters.`
    );
  }
  if (
    typeof record.note === "string" &&
    record.note.length > MAX_NOTE_CHARS
  ) {
    return tooLarge(`Memory notes are limited to ${MAX_NOTE_CHARS} characters.`);
  }
  const input: MemoryEntryInput = {
    content: record.content,
    category: isMemoryCategory(record.category) ? record.category : undefined,
    note: typeof record.note === "string" ? record.note : undefined,
  };
  try {
    const entry = await memoryService.createEntry(input, "manual");
    return Response.json({ entry }, { status: 201 });
  } catch (error) {
    return jsonError(error, 400);
  }
}
