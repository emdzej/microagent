import type { ToolPlugin } from "@microagent/core";
import { readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

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
    const entries = readdirSync(dirPath);
    return entries
      .map((name) => {
        const stat = statSync(join(dirPath, name));
        return `${stat.isDirectory() ? "d" : "f"} ${name}`;
      })
      .join("\n");
  },
};
