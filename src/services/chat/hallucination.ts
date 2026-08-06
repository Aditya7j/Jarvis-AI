/**
 * Hallucination Monitor — measures how often the reasoning model produced
 * output that was NOT backed by verified tool data.
 *
 * Definition of a hallucination event (structural, enforceable):
 *   The reasoning model was invoked for a tool-backed request (its class has
 *   a required tool or client-gated fact) while ZERO verified facts had been
 *   gathered. In that situation every token the model emitted is unsupported.
 *
 * The pipeline is designed so this is structurally impossible: direct classes
 * never call the model, naturalize classes only call the model AFTER a tool
 * succeeds, and tool failure returns an explicit "could not verify" reply.
 * This monitor makes that guarantee measurable and testable.
 */

import type { PlanClass } from "@/services/planner";

export type ResponseSource = "tool" | "memory" | "vision" | "reasoning" | "hybrid";

export interface ToolTrace {
  name: string;
  /** true = ok, false = failed, null = not executed. */
  ok: boolean | null;
}

export interface HallucinationRecord {
  requestId: string;
  prompt: string;
  cls: PlanClass;
  route: "direct" | "naturalize" | "llm";
  tools: ToolTrace[];
  verifiedFactCount: number;
  llmInvoked: boolean;
  source: ResponseSource;
  /** True when the LLM spoke for a tool-backed request with no verified facts. */
  hallucination: boolean;
  reason?: string;
}

export interface HallucinationInstance {
  requestId: string;
  prompt: string;
  cls: PlanClass;
  source: ResponseSource;
  reason: string;
}

export interface HallucinationReport {
  totalRequests: number;
  llmInvocations: number;
  hallucinationCount: number;
  /** 0-1 fraction of all requests where the LLM emitted unsupported output. */
  hallucinationRate: number;
  /** Every place the LLM generated unsupported information. */
  instances: HallucinationInstance[];
}

const MAX_RECORDS = 1_000;

export function isHallucination(args: {
  llmInvoked: boolean;
  toolBacked: boolean;
  verifiedFactCount: number;
}): boolean {
  return args.llmInvoked && args.toolBacked && args.verifiedFactCount === 0;
}

class HallucinationMonitor {
  private records: HallucinationRecord[] = [];

  record(entry: HallucinationRecord): void {
    this.records.push(entry);
    if (this.records.length > MAX_RECORDS) {
      this.records.splice(0, this.records.length - MAX_RECORDS);
    }
  }

  clear(): void {
    this.records = [];
  }

  count(): number {
    return this.records.length;
  }

  getReport(): HallucinationReport {
    const totalRequests = this.records.length;
    const llmInvocations = this.records.filter((r) => r.llmInvoked).length;
    const hallucinations = this.records.filter((r) => r.hallucination);
    return {
      totalRequests,
      llmInvocations,
      hallucinationCount: hallucinations.length,
      hallucinationRate:
        totalRequests === 0 ? 0 : hallucinations.length / totalRequests,
      instances: hallucinations.map((r) => ({
        requestId: r.requestId,
        prompt: r.prompt,
        cls: r.cls,
        source: r.source,
        reason:
          r.reason ??
          "LLM invoked for a tool-backed request without any verified facts",
      })),
    };
  }
}

export const hallucinationMonitor = new HallucinationMonitor();
