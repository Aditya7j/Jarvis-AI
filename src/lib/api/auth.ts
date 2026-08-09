/**
 * Client-side API token plumbing. The token lives only in localStorage
 * (settable from Settings) and is attached to every /api/* request so the UI
 * keeps working when the server runs with JARVIS_API_TOKEN set.
 */

const STORAGE_KEY = "jarvis.apiToken";

export function getApiToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setApiToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    const trimmed = token.trim();
    if (trimmed) window.localStorage.setItem(STORAGE_KEY, trimmed);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable (privacy mode) — the token simply won't persist.
  }
}

export function clearApiToken(): void {
  setApiToken("");
}

/** Merge the bearer token into a RequestInit, preserving existing headers. */
export function withAuthHeaders(init: RequestInit = {}): RequestInit {
  const token = getApiToken();
  if (!token) return init;
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return { ...init, headers };
}

/** Query-string token for EventSource URLs (which cannot send headers). */
export function authQueryString(): string {
  const token = getApiToken();
  return token ? `?token=${encodeURIComponent(token)}` : "";
}
