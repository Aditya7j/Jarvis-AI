/**
 * Context Engine types — the shared vocabulary for JARVIS's live awareness.
 *
 * The engine keeps a continuously-updated snapshot of the environment:
 *   - server-side facts collected from the OS (CPU, memory, disk, network, uptime)
 *   - client-side telemetry reported by the browser (battery, network, clipboard,
 *     screen, timezone, location)
 *   - the verified system clock
 *   - a brief summary of the current visual scene (when vision is active)
 */

export interface CpuInfo {
  /** Instantaneous CPU usage 0-100, sampled between polls. */
  loadPercent: number;
  cores: number;
  model: string | null;
}

export interface MemoryInfo {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

export interface DiskInfo {
  totalBytes: number | null;
  freeBytes: number | null;
  usedPercent: number | null;
  mount: string;
}

export interface NetworkInfo {
  hostname: string;
  interfaces: number;
  ipv4: string | null;
}

export interface SystemInfo {
  platform: string;
  arch: string;
  osRelease: string;
  hostname: string;
  uptimeS: number;
  loadAvg: number[];
}

export interface SystemSnapshot {
  collectedAt: number;
  cpu: CpuInfo;
  memory: MemoryInfo;
  disk: DiskInfo;
  network: NetworkInfo;
  system: SystemInfo;
}

export interface ClientNetworkInfo {
  online: boolean;
  effectiveType: string | null;
  downlinkMbps: number | null;
  rttMs: number | null;
}

export interface ClientScreenInfo {
  width: number;
  height: number;
  dpr: number;
}

export interface ClientTelemetry {
  reportedAt: number;
  battery: {
    levelPercent: number | null;
    charging: boolean | null;
  } | null;
  network: ClientNetworkInfo | null;
  clipboard: string | null;
  screen: ClientScreenInfo | null;
  timezone: string | null;
  location: { latitude: number; longitude: number; accuracyM: number } | null;
  pageVisible: boolean | null;
  /** Best-effort hint about the active app/window the user is working in. */
  activeAppHint: string | null;
}

export interface VisionSceneBrief {
  visibleObjects: string[];
  peopleCount: number;
  heldObject: string | null;
  capturedAt: number | null;
}

export interface AwarenessSnapshot {
  collectedAt: number;
  server: SystemSnapshot | null;
  client: ClientTelemetry | null;
  time: {
    iso: string;
    unixMs: number;
    timezone: string;
    formatted: string;
  };
  vision: VisionSceneBrief | null;
}

export interface ProactiveSuggestion {
  id: string;
  severity: "info" | "warning" | "critical" | "suggestion";
  title: string;
  detail: string;
  category: "system" | "battery" | "network" | "productivity" | "tasks" | "vision";
  createdAt: number;
}
