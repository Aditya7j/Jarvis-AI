/**
 * System tools: deterministic, verifiable facts served by the intent router.
 * These run BEFORE the LLM so the model never has to guess time, date,
 * location, battery or weather. The tool output is the ONLY source of truth
 * and the LLM merely naturalizes it.
 *
 * The system clock lives in ONE place — the TimeService. This module only
 * re-exports it so existing imports keep working.
 */

import { getSystemClock } from "@/lib/time/time-service";

export type {
  SystemClockFact,
  DayPart,
} from "@/lib/time/time-service";
export {
  getSystemClock,
  getTimezone,
  getGreeting,
  getDayPart,
  getDayStart,
  getDayEnd,
  formatClockTime,
  formatClockDate,
  formatTimestampTime,
  logTimeService,
} from "@/lib/time/time-service";

export interface GeolocationFact {
  latitude: number;
  longitude: number;
  accuracyM: number;
}

export interface ToolDenied {
  granted: false;
  reason: string;
}

export type GeolocationResult = ({ granted: true } & GeolocationFact) | ToolDenied;

export interface BatteryFact {
  level: number;
  levelPercent: number;
  charging: boolean;
  chargingTimeS: number | null;
  dischargingTimeS: number | null;
}

export type BatteryResult = ({ granted: true } & BatteryFact) | ToolDenied;

export interface WeatherFact {
  temperatureC: number | null;
  feelsLikeC: number | null;
  humidity: number | null;
  windSpeedKmh: number | null;
  condition: string;
  location: { latitude: number; longitude: number };
  observedAt: string;
  source: string;
}

const WEATHER_API_URL = "https://api.open-meteo.com/v1/forecast";

/** WMO weather code → human label. */
const WMO_CONDITIONS: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light rain showers",
  81: "Rain showers",
  82: "Violent rain showers",
  85: "Light snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

/**
 * Current conditions from the Weather API for a verified location. Throws on
 * network/API failure — callers turn that into a logged fallback, never an
 * LLM guess.
 */
export async function getWeather(
  latitude: number,
  longitude: number,
  timeoutMs = 8_000,
  signal?: AbortSignal
): Promise<WeatherFact> {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current:
      "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
    timezone: "auto",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const res = await fetch(`${WEATHER_API_URL}?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Weather API responded with status ${res.status}`);
    }
    const data = (await res.json()) as {
      current?: {
        time?: string;
        temperature_2m?: number;
        apparent_temperature?: number;
        relative_humidity_2m?: number;
        weather_code?: number;
        wind_speed_10m?: number;
      };
    };
    const current = data.current ?? {};
    return {
      temperatureC:
        typeof current.temperature_2m === "number"
          ? current.temperature_2m
          : null,
      feelsLikeC:
        typeof current.apparent_temperature === "number"
          ? current.apparent_temperature
          : null,
      humidity:
        typeof current.relative_humidity_2m === "number"
          ? current.relative_humidity_2m
          : null,
      windSpeedKmh:
        typeof current.wind_speed_10m === "number"
          ? current.wind_speed_10m
          : null,
      condition: WMO_CONDITIONS[current.weather_code ?? -1] ?? "Unknown",
      location: { latitude, longitude },
      observedAt: current.time ?? getSystemClock().iso,
      source: "Open-Meteo",
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}
