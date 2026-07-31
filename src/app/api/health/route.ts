import { aiService } from "@/lib/ai";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const health = await aiService.healthCheck();
    return Response.json(health);
  } catch (error) {
    return Response.json(
      { error: { code: "PROVIDER_ERROR", message: "Health check failed." } },
      { status: 500 }
    );
  }
}
