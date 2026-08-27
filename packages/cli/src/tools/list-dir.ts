import type { ToolPlugin } from "@microagent/core";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

export const listDirTool: ToolPlugin = {
  definition: {
    name: "list_directory",
    description: "List files and directories at a given path",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path" },
      },
      required: ["path"],
    },
  },
  async execute(args) {
    const dirPath = resolve(String(args.path));

    // Async, and `withFileTypes` rather than a `statSync` per entry: the old
    // version blocked the event loop for one syscall per file, which on a large
    // or network-mounted directory stalled every other session in the process.
    const entries = await readdir(dirPath, { withFileTypes: true });

    return entries
      .map((entry) => `${entry.isDirectory() ? "d" : "f"} ${entry.name}`)
      .join("\n");
  },
};
