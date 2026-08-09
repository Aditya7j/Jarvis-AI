import { describe, it, expect } from "vitest";
import {
  AGENT_TOOL_ALLOW_LIST,
  agentToolBlockMessage,
  isAgentToolAllowed,
  isSensitivePath,
  sensitivePathBlockMessage,
} from "@/services/tools/agent-policy";
import { executeTool, initToolRouter } from "@/services/tools";
import { tooLarge } from "@/lib/api-helpers";

describe("Agent tool allow-list", () => {
  it("permits only read-only, side-effect-free tools", () => {
    expect(AGENT_TOOL_ALLOW_LIST.size).toBeGreaterThan(0);
    for (const name of [
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
    ]) {
      expect(isAgentToolAllowed(name), name).toBe(true);
    }
  });

  it("blocks privileged, stateful and unknown tools", () => {
    for (const name of [
      "read_file",
      "search_files",
      "list_files",
      "remember",
      "search_memory",
      "list_memories",
      "get_owner_profile",
      "get_calendar",
      "create_task",
      "run_task",
      "retry_task",
      "cancel_task",
      "delete_task",
      "list_tasks",
      "open_app",
      "open_folder",
      "get_cpu",
      "get_memory",
      "get_disk",
      "get_network",
      "get_uptime",
      "does_not_exist",
    ]) {
      expect(isAgentToolAllowed(name), name).toBe(false);
    }
  });

  it("returns a clear block message naming the tool", () => {
    expect(agentToolBlockMessage("read_file")).toMatch(/read_file/);
  });
});

describe("Sensitive path policy", () => {
  it("blocks env files, dot-directories and key material", () => {
    const blocked = [
      "/repo/.env",
      "/repo/.env.local",
      "/repo/.env.production",
      "/repo/sub/.env",
      "C:\\repo\\.env",
      "/repo/.git/config",
      "/repo/.ssh/id_rsa",
      "/repo/creds/id_ed25519",
      "/repo/certs/server.pem",
      "/repo/certs/server.key",
      "/repo/keys/private.p12",
      "/repo/secrets/credentials",
      "/repo/secrets/service_account.json",
    ];
    for (const path of blocked) {
      expect(isSensitivePath(path), path).toBe(true);
    }
  });

  it("allows ordinary project files and the JARVIS data dir", () => {
    const allowed = [
      "/repo/src/index.ts",
      "/repo/package.json",
      "/repo/.gitignore",
      "/repo/.eslintrc.json",
      "/repo/data/memory/entries.json",
      "/repo/README.md",
    ];
    for (const path of allowed) {
      expect(isSensitivePath(path), path).toBe(false);
    }
  });

  it("returns a clear block message naming the input path", () => {
    expect(sensitivePathBlockMessage(".env")).toMatch(/sensitive/);
  });
});

describe("create_task action gate", () => {
  it("rejects a privileged actionType", async () => {
    initToolRouter();
    const result = await executeTool("create_task", {
      title: "evil",
      actionType: "read_file",
      actionArgs: { path: ".env" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/not allowed/i);
    }
  });
});

describe("Payload-too-large helper", () => {
  it("returns a 413 JSON error", async () => {
    const response = tooLarge("Request payload is too big.");
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error.message).toMatch(/too big/);
  });
});
