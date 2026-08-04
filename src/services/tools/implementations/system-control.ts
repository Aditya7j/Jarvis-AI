/**
 * Desktop control tools — safe, permission-gated system operations. Fail
 * gracefully on unsupported platforms.
 */

import { canControlDesktop, openApp, openFolder } from "@/services/system";
import { stringArg } from "../args";
import type { Tool } from "../types";

export const launchApp: Tool = {
  definition: {
    name: "open_app",
    description:
      "Launch a desktop application on this computer (e.g. 'VS Code', 'Chrome', 'Notepad').",
    category: "system",
    runtime: "node",
    parameters: [
      { name: "name", type: "string", description: "Name of the app to launch.", required: true },
    ],
    timeoutMs: 15_000,
  },
  run: async (args) => {
    if (!canControlDesktop()) {
      throw new Error("Desktop control is unavailable in this environment.");
    }
    const name = stringArg(args, "name");
    if (!name) throw new Error("The 'name' argument is required.");
    return openApp(name);
  },
};

export const openFolderTool: Tool = {
  definition: {
    name: "open_folder",
    description: "Open a folder inside the workspace in the OS file manager.",
    category: "system",
    runtime: "node",
    parameters: [
      { name: "path", type: "string", description: "Path relative to the workspace.", required: true },
    ],
    timeoutMs: 15_000,
  },
  run: async (args) => {
    if (!canControlDesktop()) {
      throw new Error("Desktop control is unavailable in this environment.");
    }
    const path = stringArg(args, "path");
    if (!path) throw new Error("The 'path' argument is required.");
    return openFolder(path);
  },
};

export const systemControlTools: Tool[] = [launchApp, openFolderTool];
