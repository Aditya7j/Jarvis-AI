/**
 * Filesystem tools — safe, guarded access to the workspace and JARVIS data
 * directories. Every path is resolved and confined to allowed roots so the
 * tool layer can never reach outside its sandbox.
 */

import { promises as fs } from "fs";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { stringArg } from "../args";
import type { Tool } from "../types";

/** Roots the filesystem tools are allowed to touch. */
export function allowedRoots(): string[] {
  const workspace = process.env.JARVIS_WORKSPACE?.trim() || process.cwd();
  const data = process.env.JARVIS_DATA_DIR?.trim() || join(process.cwd(), "data");
  return [resolve(workspace), resolve(data)].filter(Boolean);
}

function safeResolve(input: string): string {
  const target = resolve(input);
  const roots = allowedRoots();
  for (const root of roots) {
    if (target === root || target.startsWith(root + sep)) return target;
  }
  const displayRoots = roots.map((r) => relative(process.cwd(), r) || ".");
  throw new Error(
    `Path "${input}" is outside the allowed workspace (${displayRoots.join(", ")}).`
  );
}

function toEntry(target: string, parent: string) {
  return { path: target, relativePath: relative(parent, target) };
}

export const listFiles: Tool = {
  definition: {
    name: "list_files",
    description: "List files and directories inside the JARVIS workspace.",
    category: "files",
    runtime: "node",
    parameters: [
      { name: "path", type: "string", description: "Relative path inside the workspace (default '.')." },
      { name: "limit", type: "number", description: "Maximum entries (default 50)." },
    ],
    cacheable: true,
    cacheTtlMs: 10_000,
    timeoutMs: 5_000,
  },
  run: async (args) => {
    const raw = stringArg(args, "path") ?? ".";
    if (isAbsolute(raw)) throw new Error("Provide a path relative to the workspace.");
    const dir = safeResolve(join(process.cwd(), raw));
    const maxEntries = Math.max(1, Math.min(500, Number(args.limit) || 50));
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const items = entries.slice(0, maxEntries).map((entry) => {
      const full = join(dir, entry.name);
      return { name: entry.name, type: entry.isDirectory() ? "directory" : "file" };
    });
    return { path: raw, count: items.length, items, absolutePath: dir };
  },
};

export const searchFiles: Tool = {
  definition: {
    name: "search_files",
    description: "Find files by name pattern (glob) inside the JARVIS workspace.",
    category: "files",
    runtime: "node",
    parameters: [
      { name: "pattern", type: "string", description: "File name substring to match.", required: true },
      { name: "limit", type: "number", description: "Maximum results (default 20)." },
    ],
    cacheable: true,
    cacheTtlMs: 10_000,
    timeoutMs: 8_000,
  },
  run: async (args) => {
    const needle = stringArg(args, "pattern");
    if (!needle) throw new Error("The 'pattern' argument is required.");
    const maxResults = Math.max(1, Math.min(100, Number(args.limit) || 20));
    const roots = allowedRoots();
    const matches: Array<{ path: string; relativePath: string }> = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (matches.length >= maxResults || depth > 6) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (matches.length >= maxResults) return;
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const full = join(dir, entry.name);
        if (entry.name.toLowerCase().includes(needle.toLowerCase())) {
          matches.push(toEntry(full, roots[0]));
          continue;
        }
        if (entry.isDirectory()) await walk(full, depth + 1);
      }
    };

    for (const root of roots) await walk(root, 0);
    return { pattern: needle, count: matches.length, matches };
  },
};

export const readFile: Tool = {
  definition: {
    name: "read_file",
    description: "Read the beginning of a text file inside the workspace.",
    category: "files",
    runtime: "node",
    parameters: [
      { name: "path", type: "string", description: "Path relative to the workspace.", required: true },
      { name: "lines", type: "number", description: "Maximum lines (default 100)." },
    ],
    cacheable: true,
    cacheTtlMs: 5_000,
    timeoutMs: 5_000,
  },
  run: async (args) => {
    const raw = stringArg(args, "path");
    if (!raw) throw new Error("The 'path' argument is required.");
    if (isAbsolute(raw)) throw new Error("Provide a path relative to the workspace.");
    const target = safeResolve(join(process.cwd(), raw));
    const maxLines = Math.max(1, Math.min(500, Number(args.lines) || 100));
    const content = await fs.readFile(target, "utf8");
    const lines = content.split("\n").slice(0, maxLines);
    return {
      path: raw,
      absolutePath: target,
      truncated: content.split("\n").length > maxLines,
      lines,
    };
  },
};

export const fileTools: Tool[] = [listFiles, searchFiles, readFile];
