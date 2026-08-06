/**
 * Weather tool — current conditions from a live, keyless source (Open-Meteo)
 * for a verified location. The reasoning model never guesses weather; this
 * tool is the only source of truth. Network failures surface as typed errors
 * that the executor retries once, then degrades to an explicit unavailability
 * reply.
 */

import { getWeather } from "@/lib/ai/system-tools";
import { numberArg } from "../args";
import { validateWeatherFact } from "../validators";
import type { Tool } from "../types";

export const getWeatherTool: Tool = {
  definition: {
    name: "get_weather",
    description:
      "Get current weather conditions (temperature, humidity, wind, condition) for a verified latitude/longitude.",
    category: "weather",
    runtime: "node",
    parameters: [
      { name: "latitude", type: "number", description: "Latitude of the location.", required: true },
      { name: "longitude", type: "number", description: "Longitude of the location.", required: true },
    ],
    cacheable: false,
    timeoutMs: 8_000,
    retries: 1,
    validate: validateWeatherFact,
  },
  run: async (args, ctx) => {
    const latitude = numberArg(args, "latitude", NaN);
    const longitude = numberArg(args, "longitude", NaN);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error("Both 'latitude' and 'longitude' arguments are required.");
    }
    return getWeather(latitude, longitude, 8_000, ctx?.signal);
  },
};

export const weatherTools: Tool[] = [getWeatherTool];
