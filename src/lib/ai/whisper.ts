import { execFile } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { loadEnvConfig } from "./config";
import { aiLogger } from "./logger";
import { detectWhisper } from "./local-tools";

const execFileAsync = promisify(execFile);

const log = aiLogger.child("whisper");

export type SttEngine = "whisper" | "deepgram" | "none";

export interface TranscribeResult {
  transcript: string;
  engine: SttEngine;
  latencyMs: number;
}

function extensionFor(mimeType: string): string {
  switch (mimeType.split(";")[0].trim().toLowerCase()) {
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/ogg":
      return "ogg";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/webm":
    default:
      return "webm";
  }
}

async function transcribeViaServer(
  config: ReturnType<typeof loadEnvConfig>,
  audio: Buffer,
  mimeType: string
): Promise<string | null> {
  const url = config.whisperServerUrl!.replace(/\/+$/, "");
  try {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(audio)], { type: mimeType || "audio/webm" }),
      `audio.${extensionFor(mimeType)}`
    );
    form.append("model", config.whisperModel);
    const res = await fetch(`${url}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    if (!res.ok) {
      log.warn(`Whisper server responded ${res.status}`, { url });
      return null;
    }
    const body = (await res.json()) as { text?: string } | null;
    return body?.text?.trim() || null;
  } catch (error) {
    log.warn("Whisper server request failed", {
      url,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function transcribeViaCli(
  config: ReturnType<typeof loadEnvConfig>,
  audio: Buffer,
  mimeType: string
): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-whisper-"));
  const ext = extensionFor(mimeType);
  try {
    const inputPath = join(dir, `input.${ext}`);
    await writeFile(inputPath, audio);
    const args = [
      inputPath,
      "--model",
      config.whisperModel,
      "--language",
      "en",
      "--output_format",
      "txt",
      "--output_dir",
      dir,
    ];
    log.info("Running Whisper CLI", {
      command: config.whisperCommand,
      model: config.whisperModel,
    });
    await execFileAsync(config.whisperCommand, args, {
      timeout: config.requestTimeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    const outPath = join(dir, "input.txt");
    const text = (await readFile(outPath, "utf8")).trim();
    return text || null;
  } catch (error) {
    log.warn("Whisper CLI failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function transcribeViaDeepgram(
  audio: Buffer,
  mimeType: string
): Promise<string | null> {
  const apiKey = process.env.DEEPGRAM_API_KEY?.trim();
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.deepgram.com/v1/listen", {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": mimeType,
      },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => null)) as {
      results?: {
        channels?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
      };
    } | null;
    if (!res.ok || !body) return null;
    return body.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || null;
  } catch (error) {
    log.warn("Deepgram transcription failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function transcribeAudio(
  audio: Buffer,
  mimeType: string
): Promise<TranscribeResult | null> {
  const config = loadEnvConfig();
  const startedAt = Date.now();

  const whisper = await detectWhisper(config);
  if (whisper.available) {
    const transcript =
      whisper.engine === "server"
        ? await transcribeViaServer(config, audio, mimeType)
        : await transcribeViaCli(config, audio, mimeType);
    if (transcript) {
      return {
        transcript,
        engine: "whisper",
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  const transcript = await transcribeViaDeepgram(audio, mimeType);
  if (transcript) {
    return {
      transcript,
      engine: "deepgram",
      latencyMs: Date.now() - startedAt,
    };
  }

  return null;
}
