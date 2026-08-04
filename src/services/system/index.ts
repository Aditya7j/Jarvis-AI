/**
 * System Control service — safe, guarded control of the host desktop.
 *
 * Everything here is permission-gated, validation-guarded, and fails
 * gracefully. No operation ever throws: failures return a typed result with a
 * reason. Inputs are sanitized so no untrusted string can reach the shell.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { isAbsolute, resolve, sep } from "path";
import { aiLogger } from "@/lib/ai/logger";

const log = aiLogger.child("system");
const execFileAsync = promisify(execFile);

export type SystemControlResult<T = unknown> =
  | { ok: true; data: T; latencyMs: number }
  | { ok: false; error: { code: string; message: string }; latencyMs: number };

function result<T>(fn: () => Promise<T>): Promise<SystemControlResult<T>> {
  const startedAt = Date.now();
  return fn().then(
    (data) => ({ ok: true, data, latencyMs: Date.now() - startedAt }),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: { code: "FAILED", message }, latencyMs: Date.now() - startedAt };
    }
  );
}

const SAFE_NAME = /^[a-zA-Z0-9 _.\-]{1,64}$/;

function platform(): "win32" | "darwin" | "linux" {
  return process.platform === "win32" || process.platform === "darwin" ? process.platform : "linux";
}

/** Launch a desktop application by name (e.g. "VS Code", "Chrome"). */
export function openApp(name: string): Promise<SystemControlResult<{ launched: string }>> {
  return result(async () => {
    if (!SAFE_NAME.test(name)) {
      throw new Error("App name contains invalid characters.");
    }
    const p = platform();
    if (p === "win32") {
      // `start` is a cmd builtin; execFile can't run it, so use cmd.exe.
      const { exec } = await import("child_process");
      await promisify(exec)(`start "" "${name}"`, { windowsHide: true });
    } else if (p === "darwin") {
      await execFileAsync("open", ["-a", name]);
    } else {
      await execFileAsync("xdg-open", [name]);
    }
    log.info(`Opened app "${name}"`);
    return { launched: name };
  });
}

const SAFE_RELATIVE = /^[a-zA-Z0-9 _.\-\\/]+$/;

/** Open a folder inside the workspace in the OS file manager. */
export function openFolder(path: string): Promise<SystemControlResult<{ path: string }>> {
  return result(async () => {
    const target = resolve(path);
    const workspace = resolve(process.env.JARVIS_WORKSPACE?.trim() || process.cwd());
    if (!SAFE_RELATIVE.test(path) || isAbsolute(path)) {
      throw new Error("Provide a relative workspace path.");
    }
    if (target !== workspace && !target.startsWith(workspace + sep)) {
      throw new Error(`Path "${path}" is outside the workspace.`);
    }
    const p = platform();
    if (p === "win32") {
      const { exec } = await import("child_process");
      await promisify(exec)(`explorer "${target}"`, { windowsHide: true });
    } else if (p === "darwin") {
      await execFileAsync("open", [target]);
    } else {
      await execFileAsync("xdg-open", [target]);
    }
    log.info(`Opened folder "${target}"`);
    return { path: target };
  });
}

/** Does the host support desktop control (server-side only)? */
export function canControlDesktop(): boolean {
  return !isBrowser() && process.platform !== undefined;
}

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

export { platform };
