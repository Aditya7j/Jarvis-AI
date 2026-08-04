import { execFile } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { loadEnvConfig } from "./config";
import { aiLogger } from "./logger";
import { detectPiper } from "./local-tools";

const execFileAsync = promisify(execFile);

const log = aiLogger.child("piper");

export type TtsEngine = "piper" | "none";

export interface SpeakResult {
  audio: Buffer;
  mimeType: string;
  engine: TtsEngine;
  latencyMs: number;
}

async function speakViaServer(
  config: ReturnType<typeof loadEnvConfig>,
  text: string
): Promise<Buffer | null> {
  const url = config.piperServerUrl!.replace(/\/+$/, "");
  try {
    const res = await fetch(`${url}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    if (!res.ok) {
      log.warn(`Piper server responded ${res.status}`, { url });
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (error) {
    log.warn("Piper server request failed", {
      url,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function speakViaCli(
  config: ReturnType<typeof loadEnvConfig>,
  text: string
): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-piper-"));
  const outPath = join(dir, "output.wav");
  try {
    const inputPath = join(dir, "input.txt");
    await writeFile(inputPath, text, "utf8");
    const args = [
      "--model",
      config.piperVoice,
      "--output_file",
      outPath,
      inputPath,
    ];
    log.info("Running Piper CLI", {
      command: config.piperCommand,
      voice: config.piperVoice,
      chars: text.length,
    });
    await execFileAsync(config.piperCommand, args, {
      timeout: config.requestTimeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    const audio = await readFile(outPath);
    if (audio.length === 0) return null;
    return audio;
  } catch (error) {
    log.warn("Piper CLI failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function synthesizeSpeech(
  text: string
): Promise<SpeakResult | null> {
  const config = loadEnvConfig();
  const startedAt = Date.now();
  const clean = text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return null;

  const piper = await detectPiper(config);
  if (piper.available) {
    const audio =
      piper.engine === "server"
        ? await speakViaServer(config, clean)
        : await speakViaCli(config, clean);
    if (audio && audio.length > 0) {
      return {
        audio,
        mimeType: "audio/wav",
        engine: "piper",
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  return null;
}
