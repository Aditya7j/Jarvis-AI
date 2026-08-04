import { aiService } from "./src/lib/ai";
import {
  attemptStarted,
  attemptEnded,
  getMetricsSnapshot,
  recentMetrics,
} from "./src/lib/metrics/metrics";

async function main(): Promise<void> {
  attemptStarted({
    id: "manual-1",
    kind: "text",
    provider: "ollama",
    model: "manual-model",
    startedAt: Date.now() - 500,
  });
  attemptEnded({
    id: "manual-1",
    status: "ok",
    durationMs: 500,
    chars: 12,
  });

  const health = await aiService.healthCheck({ force: true });
  console.log("health.status =", health.status);

  const snap = getMetricsSnapshot();
  console.log("total =", snap.total);
  console.log("byModel =", JSON.stringify(snap.byModel, null, 2));
  console.log("byProvider =", JSON.stringify(snap.byProvider, null, 2));
  console.log("running =", snap.running.length);
  console.log("recent =", recentMetrics().length);
  console.log("insights =", JSON.stringify(snap.insights, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
