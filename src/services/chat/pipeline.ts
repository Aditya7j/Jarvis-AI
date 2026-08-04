/**
 * Chat Pipeline — the orchestration core of JARVIS.
 *
 *   Context Engine → Intent Planner → Tool Router → Memory Engine →
 *   Reasoning Engine → Natural Response
 *
 * The reasoning model is the LAST component. Every factual request is answered
 * from verified tool output (directly formatted, or naturalized under a
 * strict "only source of truth" system block). Chain of thought is stripped
 * in-flight. No component throws: failures degrade to typed events.
 */

import { aiLogger } from "@/lib/ai/logger";
import {
  BATTERY_DENIED_REPLY,
  GEOLOCATION_DENIED_REPLY,
  WEATHER_FAILED_REPLY,
  WEATHER_NO_LOCATION_REPLY,
  buildVerifiedFactContext,
} from "@/lib/ai/intent-router";
import { buildNoCameraSystemContext } from "@/lib/ai/prompts";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import { getWeather } from "@/lib/ai/system-tools";
import type { AIMessageInput } from "@/lib/ai/types";
import { parseConversionRequest } from "@/lib/toolkit/convert";
import { parseCurrencyRequest } from "@/lib/toolkit/web";
import { getContextEngine } from "@/services/context/context-engine";
import {
  classifyPlanIntent,
  planRoute,
  type PlanIntent,
} from "@/services/planner";
import {
  detectMemoryRecall,
  detectMemoryStore,
  detectTaskCreate,
  detectTaskList,
} from "@/services/planner/intents";
import type { VerifiedFact } from "@/services/planner/types";
import { CoTFilter } from "@/services/reasoning";
import { executeTool, type ToolResult } from "@/services/tools";

const log = aiLogger.child("pipeline");

export interface PipelineModel {
  streamText: (opts: {
    messages: AIMessageInput[];
    signal?: AbortSignal;
  }) => AsyncIterable<string>;
}

export type PipelineEvent =
  | { kind: "status"; phase: string }
  | {
      kind: "tool";
      intent: PlanIntent;
      tool: string;
      latencyMs: number;
      ok: boolean;
      fallbackReason?: string;
    }
  | { kind: "token"; text: string }
  | { kind: "fact"; tool: string; subject: string }
  | { kind: "done" };

export interface PipelineOptions {
  signal?: AbortSignal;
  /** Client-gated verified facts reported by the browser. */
  clientTools?: {
    systemClock?: unknown;
    geolocation?: { granted: boolean; latitude?: number; longitude?: number; accuracyM?: number };
    battery?: { granted: boolean; level?: number; levelPercent?: number; charging?: boolean };
  };
  /** Include a compact awareness snapshot in the system context. */
  includeAwareness?: boolean;
  /** Query long-term memory for relevant context. Defaults true. */
  includeMemory?: boolean;
}

function awarenessBlock(): string | null {
  try {
    const engine = getContextEngine();
    if (!engine.isRunning()) return null;
    const snapshot = engine.getAwareness();
    if (!snapshot.server && !snapshot.client) return null;
    return `Live environment snapshot (verified at ${new Date(snapshot.collectedAt).toISOString()}):\n${JSON.stringify(snapshot, null, 2)}`;
  } catch {
    return null;
  }
}

type MemoryLike = {
  listEntries: (filter: unknown) => Promise<Array<{ id: string; category: string; content: string }>>;
};

async function memoryContextBlock(prompt: string): Promise<string | null> {
  let memoryService: MemoryLike;
  try {
    const mod = await import("@/lib/memory");
    memoryService = mod.memoryService as MemoryLike;
  } catch {
    return null;
  }
  try {
    const entries = await memoryService.listEntries({
      status: "approved",
      search: prompt.slice(0, 120),
      limit: 3,
    });
    if (!entries || entries.length === 0) return null;
    return `Relevant long-term memories about this user:\n${entries
      .map((entry) => `- [${entry.category}] ${entry.content}`)
      .join("\n")}`;
  } catch {
    return null;
  }
}

function withSystemContext(
  messages: AIMessageInput[],
  blocks: Array<string | null>
): AIMessageInput[] {
  const existing = blocks.filter((b): b is string => Boolean(b && b.trim()));
  if (existing.length === 0) return messages;
  return [{ role: "system", content: existing.join("\n\n") }, ...messages];
}

function injectVerifiedFacts(
  messages: AIMessageInput[],
  facts: VerifiedFact[]
): AIMessageInput[] {
  const blocks = facts.map((fact) =>
    buildVerifiedFactContext(fact.label, fact.subject, fact.fact)
  );
  if (blocks.length === 0) return messages;
  const index = messages.findIndex((m) => m.role === "system");
  if (index >= 0) {
    const copy = messages.slice();
    copy[index] = {
      ...copy[index],
      content: `${copy[index].content}\n\n${blocks.join("\n\n")}`,
    };
    return copy;
  }
  return [
    { role: "system", content: `${DEFAULT_SYSTEM_PROMPT}\n\n${blocks.join("\n\n")}` },
    ...messages,
  ];
}

function stripPrefix(text: string, prefixes: RegExp[]): string {
  let result = text.trim();
  for (const pattern of prefixes) {
    result = result.replace(pattern, "");
  }
  return result.trim().replace(/[?]$/, "").trim();
}

const MAPS_PREFIXES = [
  /^(?:directions|route|navigate)\s+to\s+/i,
  /^map\s+of\s+/i,
  /^how\s+do\s+i\s+get\s+to\s+/i,
  /^where\s+is\s+the\s+(?:nearest|closest|best)\s+/i,
];

const MEMORY_STORE_PREFIXES = [
  /^\s*(?:remember|note\s+down|note\s+that|don'?t\s+forget|do\s+not\s+forget|store\s+in\s+memory)\s+(?:that|this|to|the)?\s*/i,
];

const MEMORY_RECALL_PREFIXES = [
  /^\s*(?:what\s+do\s+you\s+remember|search\s+(?:your\s+)?memory\s+for|recall|what\s+do\s+you\s+know\s+about)\s+/i,
];

const TASK_CREATE_PREFIXES = [
  /^\s*(?:remind\s+me\s+to|remind\s+us\s+to)\s+/i,
  /^\s*(?:create|add|make|schedule|set)\s+(?:a|an|the)?\s*(?:task|reminder|todo|to-do|alarm|event)\s+(?:to|that|for|:)?\s*/i,
];

function extractScheduleMinutes(text: string): number | null {
  const inMatch = text.match(/\bin\s+(\d+)\s*(minute|minutes|min|hour|hours|hr|hrs|day|days)\b/i);
  if (inMatch) {
    const n = Number(inMatch[1]);
    const unit = inMatch[2].toLowerCase();
    if (unit.startsWith("min")) return n;
    if (unit.startsWith("hour") || unit === "hr" || unit === "hrs") return n * 60;
    if (unit.startsWith("day")) return n * 1440;
  }
  if (/\btomorrow\b/i.test(text)) return 24 * 60;
  return null;
}

function directAnswer(intent: PlanIntent, data: unknown): string | null {
  if (intent === "calculator") {
    const d = data as { expression?: string; formatted?: string };
    if (typeof d.formatted === "string") return `${d.expression ?? "That"} = ${d.formatted}`;
    return null;
  }
  if (intent === "unit-conversion") {
    const d = data as { formatted?: string };
    if (typeof d.formatted === "string") return d.formatted;
    return null;
  }
  if (intent === "currency") {
    const d = data as { amount?: number; from?: string; formatted?: string; rate?: number; to?: string; source?: string };
    if (typeof d.formatted === "string") {
      const rate = typeof d.rate === "number" ? ` (rate: 1 ${d.from} = ${d.rate} ${d.to})` : "";
      return `${d.formatted}${rate}${d.source ? ` — ${d.source}` : ""}`;
    }
    return null;
  }
  return null;
}

async function executeSteps(
  tools: string[],
  argFor: (tool: string) => Record<string, unknown>
): Promise<{ facts: VerifiedFact[]; results: ToolResult[] }> {
  const facts: VerifiedFact[] = [];
  const results: ToolResult[] = [];
  for (const tool of tools) {
    const result = await executeTool(tool, argFor(tool) ?? {});
    results.push(result);
    if (result.ok) {
      facts.push({
        tool,
        label: tool
          .split("_")
          .map((w) => (w[0]?.toUpperCase() ?? "") + w.slice(1))
          .join(" "),
        subject: "the requested fact",
        fact: result.data,
        executedAt: Date.now(),
      });
    }
  }
  return { facts, results };
}

function toolEvent(
  intent: PlanIntent,
  tool: string,
  startedAt: number,
  ok: boolean,
  fallbackReason?: string
): PipelineEvent {
  return { kind: "tool", intent, tool, latencyMs: Date.now() - startedAt, ok, fallbackReason };
}

async function* streamThrough(
  model: PipelineModel,
  messages: AIMessageInput[],
  filter: CoTFilter,
  signal?: AbortSignal
): AsyncGenerator<PipelineEvent> {
  for await (const token of model.streamText({ messages, signal })) {
    const clean = filter.push(token);
    if (clean) yield { kind: "token", text: clean };
  }
  const tail = filter.flush();
  if (tail) yield { kind: "token", text: tail };
}

/**
 * Run the full OS pipeline. Yields events; never throws.
 */
export async function* runPipeline(
  prompt: string,
  messages: AIMessageInput[],
  model: PipelineModel,
  options: PipelineOptions = {}
): AsyncGenerator<PipelineEvent> {
  if (!prompt.trim()) {
    yield { kind: "token", text: "I didn't catch what you asked." };
    yield { kind: "done" };
    return;
  }

  const route = planRoute(prompt, { clientTools: options.clientTools });
  const { intent, label } = route.step;
  const startedAt = Date.now();
  const signal = options.signal;

  log.info("[plan]", { intent, label, kind: route.kind });

  // ---------- Direct intents: format verified tool output, no LLM ----------
  if (route.kind === "direct") {
    yield { kind: "status", phase: "tool" };
    let argFor: (tool: string) => Record<string, unknown> = () => ({});
    if (intent === "calculator") {
      argFor = () => ({ expression: prompt });
    } else if (intent === "unit-conversion") {
      const parsed = parseConversionRequest(prompt);
      argFor = () => (parsed ? { value: parsed.value, from: parsed.from, to: parsed.to } : {});
    } else if (intent === "currency") {
      const parsed = parseCurrencyRequest(prompt);
      argFor = () => (parsed ? { amount: parsed.amount, from: parsed.from, to: parsed.to } : {});
    }
    const { results } = await executeSteps([...route.step.tools], argFor);
    const result = results[0];
    if (result?.ok) {
      const text = directAnswer(intent, result.data);
      if (text) {
        yield toolEvent(intent, route.step.tools[0], startedAt, true);
        yield { kind: "fact", tool: route.step.tools[0], subject: label };
        yield { kind: "token", text };
        yield { kind: "done" };
        return;
      }
    }
    yield toolEvent(intent, route.step.tools[0], startedAt, false, "direct_parse_failed");
    yield { kind: "token", text: "I couldn't work that one out from the tool data." };
    yield { kind: "done" };
    return;
  }

  // ---------- Client-gated intents with denied fallbacks ----------
  if (intent === "geolocation" && !options.clientTools?.geolocation?.granted) {
    yield toolEvent(intent, "browser-geolocation", startedAt, false, "geolocation_permission_denied");
    yield { kind: "token", text: GEOLOCATION_DENIED_REPLY };
    yield { kind: "done" };
    return;
  }
  if (intent === "battery" && !options.clientTools?.battery?.granted) {
    yield toolEvent(intent, "battery-status", startedAt, false, "battery_unavailable");
    yield { kind: "token", text: BATTERY_DENIED_REPLY };
    yield { kind: "done" };
    return;
  }
  if (intent === "weather" && !options.clientTools?.geolocation?.granted) {
    yield toolEvent(intent, "weather-api", startedAt, false, "no_location_data");
    yield { kind: "token", text: WEATHER_NO_LOCATION_REPLY };
    yield { kind: "done" };
    return;
  }

  // ---------- LLM path ----------
  yield { kind: "status", phase: "text" };
  const filter = new CoTFilter();
  const contextBlocks: Array<string | null> = [];
  if (options.includeAwareness !== false) contextBlocks.push(awarenessBlock());
  const base = withSystemContext(messages, contextBlocks);
  let finalMessages = base;
  const facts: VerifiedFact[] = [];

  if (route.kind === "naturalize") {
    yield { kind: "status", phase: "tool" };
    const q = prompt.trim();
    let toolsToRun = [...route.step.tools];
    let argFor: (tool: string) => Record<string, unknown> = () => ({});

    switch (intent) {
      case "system-clock":
        argFor = () => ({});
        break;
      case "system-status":
        argFor = () => ({});
        break;
      case "web-search":
        argFor = () => ({
          query: stripPrefix(q, [/^(?:search\s+(?:the\s+web\s+)?(?:for\s+)?|look\s+it?\s+up|look\s+up|google\s+|find\s+out)\s*/i]) || q,
        });
        break;
      case "news":
        argFor = () => ({ limit: 6 });
        break;
      case "maps":
        argFor = () => ({
          query: stripPrefix(q, MAPS_PREFIXES) || q,
          mode: /directions|route|navigate|get\s+to/i.test(q) ? "directions" : "search",
        });
        break;
      case "memory": {
        if (detectMemoryStore(q)) {
          toolsToRun = ["remember"];
          argFor = () => ({ content: stripPrefix(q, MEMORY_STORE_PREFIXES) || q });
        } else {
          toolsToRun = ["search_memory"];
          argFor = () => ({ query: stripPrefix(q, MEMORY_RECALL_PREFIXES) || q, limit: 5 });
        }
        break;
      }
      case "tasks": {
        if (detectTaskCreate(q)) {
          toolsToRun = ["create_task"];
          argFor = () => {
            const title = stripPrefix(q, TASK_CREATE_PREFIXES) || q;
            const minutes = extractScheduleMinutes(q);
            return { title, ...(minutes ? { inMinutes: minutes } : {}) };
          };
        } else if (detectTaskList(q)) {
          toolsToRun = ["list_tasks"];
          argFor = () => ({ limit: 20 });
        }
        break;
      }
      case "weather": {
        toolsToRun = [];
        const loc = options.clientTools?.geolocation;
        if (loc) {
          try {
            const weather = await getWeather(loc.latitude ?? 0, loc.longitude ?? 0);
            facts.push({
              tool: "weather-api",
              label: "Weather API",
              subject: "the current weather",
              fact: weather,
              executedAt: Date.now(),
            });
          } catch {
            yield toolEvent(intent, "weather-api", startedAt, false, "weather_api_failed");
            yield { kind: "token", text: WEATHER_FAILED_REPLY };
            yield { kind: "done" };
            return;
          }
        }
        break;
      }
      case "vision":
      case "ocr": {
        finalMessages = [{ role: "system", content: buildNoCameraSystemContext() }, ...messages];
        yield { kind: "status", phase: "answering" };
        yield* streamThrough(model, finalMessages, filter, signal);
        yield { kind: "done" };
        return;
      }
      case "geolocation":
      case "battery": {
        toolsToRun = [];
        const clientFact =
          intent === "geolocation" ? options.clientTools?.geolocation : options.clientTools?.battery;
        if (clientFact) {
          facts.push({
            tool: intent,
            label,
            subject:
              intent === "geolocation" ? "your current location" : "your device's battery status",
            fact: clientFact,
            executedAt: Date.now(),
          });
        }
        break;
      }
      default:
        toolsToRun = [];
        break;
    }

    if (toolsToRun.length > 0) {
      const { facts: toolFacts, results } = await executeSteps(toolsToRun, argFor);
      for (const fact of toolFacts) {
        facts.push({ ...fact, label, subject: route.step.subject });
      }
      const anyOk = results.some((r) => r.ok);
      if (!anyOk && results.length > 0) {
        yield toolEvent(intent, toolsToRun[0], startedAt, false, "tool_failed");
        yield { kind: "token", text: "That tool isn't available right now. Please try again in a moment." };
        yield { kind: "done" };
        return;
      }
    }

    if (facts.length > 0) {
      for (const fact of facts) yield { kind: "fact", tool: fact.tool, subject: fact.subject };
      finalMessages = injectVerifiedFacts(base, facts);
    }
  }

  if (options.includeMemory !== false) {
    const memoryBlock = await memoryContextBlock(prompt);
    if (memoryBlock) {
      finalMessages = [{ role: "system", content: memoryBlock }, ...finalMessages];
    }
  }

  log.info("[verified-facts]", { count: facts.length, intent });
  yield { kind: "status", phase: "answering" };
  yield* streamThrough(model, finalMessages, filter, signal);
  yield { kind: "done" };
}

/** Non-streaming convenience wrapper. */
export async function runPipelineText(
  prompt: string,
  messages: AIMessageInput[],
  model: PipelineModel,
  options: PipelineOptions = {}
): Promise<{ text: string; intent: PlanIntent; events: PipelineEvent[] }> {
  let text = "";
  const events: PipelineEvent[] = [];
  for await (const event of runPipeline(prompt, messages, model, options)) {
    events.push(event);
    if (event.kind === "token") text += event.text;
  }
  return { text, intent: classifyPlanIntent(prompt), events };
}
