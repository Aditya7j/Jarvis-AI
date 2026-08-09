/**
 * Agent execution policy — the security gate for model-driven tool calls.
 *
 * Two channels can invoke tools with a name chosen by the model or by stored
 * task data, instead of the deterministic planner:
 *   1. runToolLoop (agent orchestration) — hands the LLM's tool calls straight
 *      to the registry.
 *   2. create_task.actionType — a scheduled task runs a named tool later.
 *
 * Both channels are restricted to this allow-list of read-only, side-effect
 * free, non-filesystem tools so a manipulated model or a tampered task can
 * never reach files, memory, tasks or system control. The planner's own
 * deterministic execution path is NOT gated here — it always uses the exact
 * tool for the classified intent.
 */

export const AGENT_TOOL_ALLOW_LIST: ReadonlySet<string> = new Set([
  "web_search",
  "get_news",
  "convert_units",
  "convert_currency",
  "calculate",
  "get_current_time",
  "get_weekday_for_date",
  "get_weather",
  "maps_link",
  "get_system_status",
]);

export function isAgentToolAllowed(name: string): boolean {
  return AGENT_TOOL_ALLOW_LIST.has(name);
}

export function agentToolBlockMessage(name: string): string {
  return `Tool "${name}" is not on the agent allow-list and cannot be invoked by the model or by a task action.`;
}

/** File/directory basenames that hold credentials, keys or secrets. */
const SENSITIVE_BASENAMES: ReadonlySet<string> = new Set([
  ".git",
  ".ssh",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".gemrc",
  ".curlrc",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "credentials",
  "service_account.json",
]);

/** Private-key / certificate-material extensions. */
const SENSITIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".p8",
  ".jks",
  ".keystore",
]);

/**
 * True when the resolved path touches a sensitive file or directory (env
 * files with live API keys, credential stores, private keys). Accepts both
 * platform separators so tests are stable across OSes.
 */
export function isSensitivePath(target: string): boolean {
  const normalized = target.replace(/[\\/]+/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  for (const segment of segments) {
    if (segment.startsWith(".env")) return true;
    if (SENSITIVE_BASENAMES.has(segment)) return true;
  }
  const basename = segments[segments.length - 1];
  const dot = basename.lastIndexOf(".");
  const ext = dot >= 0 ? basename.slice(dot).toLowerCase() : "";
  return SENSITIVE_EXTENSIONS.has(ext);
}

export function sensitivePathBlockMessage(input: string): string {
  return `Path "${input}" is blocked — it resolves to a sensitive file (env/credentials/key material).`;
}
