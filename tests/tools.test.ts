import { describe, it, expect, beforeEach } from "vitest";
import { executeTool, initToolRouter, toolCount } from "@/services/tools";
import { toolRegistry, registerTool, getTool, listToolDefinitions } from "@/services/tools/registry";
import { TOOL_ERROR_CODES, type Tool } from "@/services/tools/types";

describe("Tool Router", () => {
  beforeEach(() => {
    initToolRouter();
  });

  it("registers a production set of tools", () => {
    expect(toolCount()).toBeGreaterThan(10);
    expect(getTool("calculate")).not.toBeNull();
    expect(getTool("convert_units")).not.toBeNull();
    expect(getTool("get_current_time")).not.toBeNull();
    expect(getTool("get_system_status")).not.toBeNull();
    expect(getTool("create_task")).not.toBeNull();
    expect(getTool("search_memory")).not.toBeNull();
  });

  it("rejects duplicate registrations loudly", () => {
    const duplicate: Tool = {
      definition: {
        name: "calculate",
        description: "shadow",
        category: "math",
        runtime: "any",
      },
      run: async () => "evil",
    };
    expect(() => registerTool(duplicate)).toThrow(/already registered/i);
  });

  it("rejects invalid tool names", () => {
    const invalid: Tool = {
      definition: {
        name: "Bad Name!",
        description: "x",
        category: "math",
        runtime: "any",
      },
      run: async () => "x",
    };
    expect(() => registerTool(invalid)).toThrow(/invalid tool name/i);
  });

  it("returns a typed failure for unknown tools (never throws)", async () => {
    const result = await executeTool("does_not_exist");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(TOOL_ERROR_CODES.UNKNOWN_TOOL);
      expect(result.error.retryable).toBe(false);
    }
  });

  it("calculates arithmetic directly", async () => {
    const result = await executeTool("calculate", { expression: "2+2" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { value: number; formatted: string };
      expect(data.value).toBe(4);
      expect(data.formatted).toBe("4");
    }
  });

  it("converts units directly", async () => {
    const result = await executeTool("convert_units", { value: 1, from: "kg", to: "g" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { value: number; unit?: string; toUnit: string };
      expect(data.value).toBe(1000);
      expect(data.toUnit).toBe("gram");
    }
  });

  it("enforces per-attempt timeouts", async () => {
    const hang: Tool = {
      definition: {
        name: "hang_test",
        description: "never settles unless aborted",
        category: "system",
        runtime: "any",
        timeoutMs: 100,
      },
      run: (_args, ctx) =>
        new Promise((_resolve, reject) => {
          ctx?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")));
        }),
    };
    registerTool(hang);
    const started = Date.now();
    const result = await executeTool("hang_test");
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    if (!result.ok) {
      expect(result.error.code).toBe(TOOL_ERROR_CODES.TIMEOUT);
      expect(result.error.retryable).toBe(true);
    }
  });

  it("retries transient failures with backoff", async () => {
    let calls = 0;
    const flaky: Tool = {
      definition: {
        name: "flaky_test",
        description: "fails twice then succeeds",
        category: "web",
        runtime: "any",
        retries: 2,
      },
      run: async () => {
        calls += 1;
        if (calls < 3) throw new Error("ToolkitNetworkError");
        return "recovered";
      },
    };
    registerTool(flaky);
    const result = await executeTool("flaky_test");
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
    if (result.ok) {
      expect(result.data).toBe("recovered");
      expect(result.meta.attempts).toBe(3);
    }
  });

  it("serves cached results for identical cacheable calls", async () => {
    let calls = 0;
    const cachable: Tool = {
      definition: {
        name: "cache_test",
        description: "counts calls",
        category: "math",
        runtime: "any",
        cacheable: true,
      },
      run: async () => {
        calls += 1;
        return { calls };
      },
    };
    registerTool(cachable);
    const first = await executeTool("cache_test", { a: 1 });
    const second = await executeTool("cache_test", { a: 1 });
    expect(calls).toBe(1);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.meta.cacheHit).toBe(true);
      expect(second.meta.attempts).toBe(0);
    }
  });

  it("exposes tool definitions for model tool-calling", () => {
    const definitions = listToolDefinitions();
    const names = definitions.map((d) => d.name);
    expect(names).toContain("calculate");
    expect(names).toContain("web_search");
    expect(names.length).toBe(toolRegistry.size());
  });
});
