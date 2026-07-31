import { AIError, toErrorPayload } from "./ai/errors";

export function invalidRequest(message: string): Response {
  return jsonError(new AIError(message, "INVALID_REQUEST"), 400);
}

export function jsonError(error: unknown, status = 500): Response {
  return Response.json({ error: toErrorPayload(error) }, { status });
}
