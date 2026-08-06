/**
 * Time tools — the verified system clock. The reasoning model never computes
 * the time itself; this tool is the only source of truth.
 */

import { getSystemClock, logTimeService } from "@/lib/time/time-service";
import { validateClockFact } from "../validators";
import type { Tool } from "../types";

export const getCurrentTime: Tool = {
  definition: {
    name: "get_current_time",
    description: "Get the current date, time and timezone of this machine.",
    category: "time",
    runtime: "any",
    cacheable: false,
    timeoutMs: 2_000,
    validate: validateClockFact,
  },
  run: async () => {
    const clock = getSystemClock();
    logTimeService("get_current_time", clock);
    return clock;
  },
};

export const timeTools: Tool[] = [getCurrentTime];
