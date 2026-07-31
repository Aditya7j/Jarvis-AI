import { AIError } from "./errors";

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const external = init.signal;
  if (external) {
    if (external.aborted) {
      clearTimeout(timer);
      throw new AIError("Request aborted by caller.", "REQUEST_ABORTED");
    }
    external.addEventListener("abort", () => controller.abort());
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      if (external?.aborted) {
        throw new AIError("Request aborted by caller.", "REQUEST_ABORTED");
      }
      throw new AIError(
        `Connection timed out after ${timeoutMs}ms`,
        "CONNECTION_TIMEOUT"
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new AIError(
          `${label} connection timed out after ${timeoutMs}ms`,
          "CONNECTION_TIMEOUT"
        )
      );
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
