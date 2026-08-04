/**
 * Time tools — the verified system clock. The reasoning model never computes
 * the time itself; this tool is the only source of truth.
 */

import { getSystemClock } from "@/lib/ai/system-tools";
import type { Tool } from "../types";

export const getCurrentTime: Tool = {
  definition: {
    name: "get_current_time",
    description: "Get the current date, time and timezone of this machine.",
    category: "time",
    runtime: "any",
    cacheable: true,
    cacheTtlMs: 1_000,
    timeoutMs: 2_000,
  },
  run: async () => getSystemClock(),
};

export const timeTools: Tool[] = [getCurrentTime];
