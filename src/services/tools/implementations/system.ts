/**
 * System state tools — live, verified OS facts from the JARVIS server.
 * Node-only: each tool degrades to a typed failure in the browser.
 */

import { collectSystemSnapshot } from "@/services/context/system-collector";
import type { Tool } from "../types";

async function snapshot(): Promise<NonNullable<Awaited<ReturnType<typeof collectSystemSnapshot>>>> {
  const data = await collectSystemSnapshot();
  if (!data) throw new Error("System snapshot is unavailable in this environment.");
  return data;
}

export const getSystemStatus: Tool = {
  definition: {
    name: "get_system_status",
    description:
      "Get the live CPU, memory, disk, network and OS status of this computer.",
    category: "system",
    runtime: "node",
    cacheable: true,
    cacheTtlMs: 4_000,
    timeoutMs: 3_000,
  },
  run: async () => {
    const data = await snapshot();
    return {
      cpu: data.cpu,
      memory: data.memory,
      disk: data.disk,
      network: data.network,
      system: {
        platform: data.system.platform,
        arch: data.system.arch,
        osRelease: data.system.osRelease,
        hostname: data.system.hostname,
        uptimeS: data.system.uptimeS,
      },
    };
  },
};

export const getCpu: Tool = {
  definition: {
    name: "get_cpu",
    description: "Get the current CPU load percentage and core count.",
    category: "system",
    runtime: "node",
    cacheable: true,
    cacheTtlMs: 2_000,
    timeoutMs: 3_000,
  },
  run: async () => (await snapshot()).cpu,
};

export const getMemory: Tool = {
  definition: {
    name: "get_memory",
    description: "Get the current memory usage (total, free, used, percent).",
    category: "system",
    runtime: "node",
    cacheable: true,
    cacheTtlMs: 4_000,
    timeoutMs: 3_000,
  },
  run: async () => (await snapshot()).memory,
};

export const getDisk: Tool = {
  definition: {
    name: "get_disk",
    description: "Get the current disk usage for the workspace mount.",
    category: "system",
    runtime: "node",
    cacheable: true,
    cacheTtlMs: 10_000,
    timeoutMs: 3_000,
  },
  run: async () => (await snapshot()).disk,
};

export const getNetwork: Tool = {
  definition: {
    name: "get_network",
    description: "Get the hostname and network interface summary.",
    category: "system",
    runtime: "node",
    cacheable: true,
    cacheTtlMs: 10_000,
    timeoutMs: 3_000,
  },
  run: async () => (await snapshot()).network,
};

export const getUptime: Tool = {
  definition: {
    name: "get_uptime",
    description: "Get how long this machine has been running, in seconds.",
    category: "system",
    runtime: "node",
    cacheable: true,
    cacheTtlMs: 10_000,
    timeoutMs: 3_000,
  },
  run: async () => {
    const data = await snapshot();
    return { uptimeS: data.system.uptimeS, hostname: data.system.hostname };
  },
};

/** Tools exported for registration. */
export const systemTools: Tool[] = [
  getSystemStatus,
  getCpu,
  getMemory,
  getDisk,
  getNetwork,
  getUptime,
];
