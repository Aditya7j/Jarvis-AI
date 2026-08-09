import { AIError, toErrorPayload } from "./ai/errors";

export function invalidRequest(message: string): Response {
  return jsonError(new AIError(message, "INVALID_REQUEST"), 400);
}

/** Request body exceeded the configured size limit (413 Payload Too Large). */
export function tooLarge(message: string): Response {
  return jsonError(new AIError(message, "INVALID_REQUEST"), 413);
}

export function jsonError(error: unknown, status = 500): Response {
  return Response.json({ error: toErrorPayload(error) }, { status });
}
