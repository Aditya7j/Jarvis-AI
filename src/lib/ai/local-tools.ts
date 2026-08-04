import { execFile } from "child_process";
import { promisify } from "util";
import { aiLogger } from "./logger";
import type { EnvConfig, SttMode, TtsMode } from "./config";

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 30_000;

type ToolKind = "whisper" | "piper";
type ToolStatus =
  | { kind: ToolKind; available: boolean; engine: string; checkedAt: number }
  | undefined;

const toolCache = new Map<ToolKind, ToolStatus>();

function cached(kind: ToolKind): ToolStatus {
  return toolCache.get(kind);
}

function cache(kind: ToolKind, available: boolean, engine: string): void {
  toolCache.set(kind, { kind, available, engine, checkedAt: Date.now() });
}

async function commandExists(command: string): Promise<boolean> {
  const isWin = process.platform === "win32";
  const probe = isWin ? "where" : "which";
  try {
    await execFileAsync(probe, [command], { timeout: 4_000 });
    return true;
  } catch {
    return false;
  }
}

export async function detectWhisper(
  config: EnvConfig
): Promise<{ available: boolean; engine: string }> {
  if (!config.whisperEnabled) {
    return { available: false, engine: "disabled" };
  }
  const entry = cached("whisper");
  if (entry && Date.now() - entry.checkedAt < CACHE_TTL_MS) {
    return { available: entry.available, engine: entry.engine };
  }
  if (config.whisperServerUrl) {
    cache("whisper", true, "server");
    aiLogger.info("Whisper detected via HTTP server", {
      url: config.whisperServerUrl,
    });
    return { available: true, engine: "server" };
  }
  const exists = await commandExists(config.whisperCommand);
  cache("whisper", exists, "cli");
  aiLogger.info(`Whisper CLI ${exists ? "detected" : "not found"}`, {
    command: config.whisperCommand,
  });
  return { available: exists, engine: exists ? "cli" : "none" };
}

export async function detectPiper(
  config: EnvConfig
): Promise<{ available: boolean; engine: string }> {
  if (!config.piperEnabled) {
    return { available: false, engine: "disabled" };
  }
  const entry = cached("piper");
  if (entry && Date.now() - entry.checkedAt < CACHE_TTL_MS) {
    return { available: entry.available, engine: entry.engine };
  }
  if (config.piperServerUrl) {
    cache("piper", true, "server");
    aiLogger.info("Piper detected via HTTP server", {
      url: config.piperServerUrl,
    });
    return { available: true, engine: "server" };
  }
  const exists = await commandExists(config.piperCommand);
  cache("piper", exists, "cli");
  aiLogger.info(`Piper CLI ${exists ? "detected" : "not found"}`, {
    command: config.piperCommand,
  });
  return { available: exists, engine: exists ? "cli" : "none" };
}

export function resolveSttEngine(
  config: EnvConfig,
  whisper: { available: boolean }
): { engine: "whisper" | "deepgram" | "browser" | "none"; enabled: boolean; mode: SttMode } {
  switch (config.sttMode) {
    case "browser":
      return { engine: "browser", enabled: true, mode: "browser" };
    case "whisper":
      return {
        engine: whisper.available ? "whisper" : "none",
        enabled: whisper.available,
        mode: "whisper",
      };
    case "deepgram":
      return {
        engine: config.deepgramApiKey ? "deepgram" : "none",
        enabled: Boolean(config.deepgramApiKey),
        mode: "deepgram",
      };
    case "auto":
    default:
      if (whisper.available)
        return { engine: "whisper", enabled: true, mode: "auto" };
      if (config.deepgramApiKey)
        return { engine: "deepgram", enabled: true, mode: "auto" };
      return { engine: "browser", enabled: true, mode: "auto" };
  }
}

export function resolveTtsEngine(
  config: EnvConfig,
  piper: { available: boolean }
): { engine: "piper" | "browser" | "none"; enabled: boolean; mode: TtsMode } {
  if (config.ttsMode === "browser") {
    return { engine: "browser", enabled: true, mode: "browser" };
  }
  if (config.ttsMode === "piper") {
    return {
      engine: piper.available ? "piper" : "none",
      enabled: piper.available,
      mode: "piper",
    };
  }
  // auto: prefer Piper when present, else browser speech synthesis
  return {
    engine: piper.available ? "piper" : "browser",
    enabled: true,
    mode: "auto",
  };
}

export function toolError(
  tool: ToolKind,
  message: string
): Error {
  aiLogger.warn(`[${tool}] ${message}`);
  return new Error(message);
}
