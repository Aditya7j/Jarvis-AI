/**
 * API authentication gate.
 *
 * When JARVIS_API_TOKEN is set (env var), every /api/* request must present it
 * as `Authorization: Bearer <token>` (or `?token=<token>` for EventSource, which
 * cannot set headers). When the env var is unset, the API stays open — this is
 * a single-user localhost app, and the gate is opt-in hardening for deployments
 * that expose the server beyond localhost.
 *
 * Note: Next.js inlines `process.env.*` at build time for middleware (Edge
 * runtime), so JARVIS_API_TOKEN must be present when `next build` runs and when
 * `next start` serves the bundle. `next dev` reads it live.
 */

import { NextResponse, type NextRequest } from "next/server";

const BEARER_PREFIX = "Bearer ";

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function suppliedToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (header && header.startsWith(BEARER_PREFIX)) {
    return header.slice(BEARER_PREFIX.length).trim();
  }
  const query = request.nextUrl.searchParams.get("token");
  return query ? query.trim() : null;
}

export function middleware(request: NextRequest): NextResponse {
  const expected = process.env.JARVIS_API_TOKEN?.trim();
  if (!expected) return NextResponse.next();

  const supplied = suppliedToken(request);
  if (supplied && timingSafeEqualString(supplied, expected)) {
    return NextResponse.next();
  }

  return NextResponse.json(
    {
      error: {
        code: "UNAUTHORIZED",
        message: "Missing or invalid JARVIS_API_TOKEN.",
      },
    },
    {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    }
  );
}

export const config = {
  matcher: ["/api/:path*"],
};
