import type { BatteryResult, GeolocationResult } from "./system-tools";

/**
 * Browser-only system tools. These APIs only exist in the browser, so they run
 * client-side and their verified output is attached to the chat request. The
 * server turns a granted result into an LLM-naturalized answer, and a denied or
 * unavailable result into a canned fallback — never an LLM guess.
 */

const GEOLOCATION_TIMEOUT_MS = 8_000;

function geolocationErrorReason(code: number): string {
  switch (code) {
    case 1:
      return "geolocation_permission_denied";
    case 2:
      return "geolocation_position_unavailable";
    case 3:
      return "geolocation_timeout";
    default:
      return "geolocation_error";
  }
}

/** Ask the browser for the current position (may prompt for permission). */
export function requestGeolocation(
  timeoutMs = GEOLOCATION_TIMEOUT_MS
): Promise<GeolocationResult> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve({ granted: false, reason: "geolocation_unavailable" });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          granted: true,
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyM: position.coords.accuracy,
        });
      },
      (error) => {
        resolve({ granted: false, reason: geolocationErrorReason(error.code) });
      },
      { timeout: timeoutMs, maximumAge: 60_000 }
    );
  });
}

interface BatteryManagerLike {
  level: number;
  charging: boolean;
  chargingTime: number;
  dischargingTime: number;
}

/** Battery Status API (Chrome/Edge/Opera). Unavailable elsewhere → denied. */
export async function getBatteryInfo(): Promise<BatteryResult> {
  if (typeof navigator === "undefined") {
    return { granted: false, reason: "battery_unavailable" };
  }
  const nav = navigator as Navigator & {
    getBattery?: () => Promise<BatteryManagerLike>;
  };
  if (typeof nav.getBattery !== "function") {
    return { granted: false, reason: "battery_unavailable" };
  }
  try {
    const battery = await nav.getBattery();
    return {
      granted: true,
      level: battery.level,
      levelPercent: Math.round(battery.level * 100),
      charging: battery.charging,
      chargingTimeS: Number.isFinite(battery.chargingTime)
        ? battery.chargingTime
        : null,
      dischargingTimeS: Number.isFinite(battery.dischargingTime)
        ? battery.dischargingTime
        : null,
    };
  } catch {
    return { granted: false, reason: "battery_unavailable" };
  }
}
