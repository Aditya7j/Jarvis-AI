/**
 * Personal tools — verified owner-profile and calendar facts.
 *
 * Both are read-only views over existing stores (memory engine / task engine).
 * The reasoning model never guesses the owner's profile or schedule; it only
 * summarizes what these tools verify.
 */

import { memoryService } from "@/lib/memory";
import { taskEngine } from "@/services/tasks";
import {
  getDayEnd,
  getDayStart,
  getSystemClock,
  logTimeService,
} from "@/lib/time/time-service";
import {
  validateCalendarResult,
  validateProfileResult,
} from "../validators";
import type { Tool } from "../types";

export const getOwnerProfile: Tool = {
  definition: {
    name: "get_owner_profile",
    description: "Get the stored owner profile (name, occupation, skills, interests, goals, etc.).",
    category: "profile",
    runtime: "node",
    cacheable: true,
    cacheTtlMs: 30_000,
    timeoutMs: 5_000,
    validate: validateProfileResult,
  },
  run: async () => {
    const profile = await memoryService.getProfile();
    return {
      id: profile.id,
      name: profile.name,
      nickname: profile.nickname,
      email: profile.email,
      occupation: profile.occupation,
      skills: profile.skills,
      interests: profile.interests,
      goals: profile.goals,
      dailyRoutine: profile.dailyRoutine,
      preferences: profile.preferences,
      location: profile.location,
      timezone: profile.timezone,
      birthday: profile.birthday,
      customNotes: profile.customNotes,
    };
  },
};

export const getCalendar: Tool = {
  definition: {
    name: "get_calendar",
    description: "Get what is scheduled on the calendar today (tasks/events scheduled for the current day).",
    category: "calendar",
    runtime: "node",
    cacheable: true,
    cacheTtlMs: 5_000,
    timeoutMs: 5_000,
    validate: validateCalendarResult,
  },
  run: async () => {
    const clock = getSystemClock();
    logTimeService("get_calendar", clock);
    const now = new Date(clock.unixMs);
    const startOfDay = getDayStart(now);
    const endOfDay = getDayEnd(now);
    const tasks = await taskEngine.listTasks({ status: "all", limit: 100 });
    const items = tasks
      .filter(
        (task) =>
          (task.scheduledAt !== null &&
            task.scheduledAt >= startOfDay &&
            task.scheduledAt <= endOfDay) ||
          (task.nextRunAt !== null &&
            task.nextRunAt >= startOfDay &&
            task.nextRunAt <= endOfDay)
      )
      .sort(
        (a, b) =>
          (a.scheduledAt ?? a.nextRunAt ?? 0) - (b.scheduledAt ?? b.nextRunAt ?? 0)
      )
      .map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        at: task.scheduledAt ?? task.nextRunAt,
        description: task.description,
      }));
    return { count: items.length, date: now.toISOString(), items };
  },
};

export const personalTools: Tool[] = [getOwnerProfile, getCalendar];
