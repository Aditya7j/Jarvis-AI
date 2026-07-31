import { aiService } from "@/lib/ai";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  try {
    const health = await aiService.healthCheck({ force: true });
    return Response.json(health);
  } catch (error) {
    return Response.json(
      { error: { code: "PROVIDER_ERROR", message: "Connection test failed." } },
      { status: 500 }
    );
  }
}
