import type { ToolPlugin } from "@microagent/core";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const fileReadTool: ToolPlugin = {
  definition: {
    name: "file_read",
    description: "Read the contents of a file at the given path",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative file path" },
      },
      required: ["path"],
    },
  },
  async execute(args) {
    const filePath = resolve(String(args.path));
    return await readFile(filePath, "utf-8");
  },
};
