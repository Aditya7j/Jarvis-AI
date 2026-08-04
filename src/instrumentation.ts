export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startTaskAutomation } = await import("@/services/tasks");
  startTaskAutomation();
}
