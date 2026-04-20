import type { ToolPlugin } from "@microagent/core";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

export const fileWriteTool: ToolPlugin = {
  definition: {
    name: "file_write",
    description: "Write content to a file (creates directories as needed)",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write to" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  async execute(args) {
    const filePath = resolve(String(args.path));
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, String(args.content), "utf-8");
    return `Wrote ${String(args.content).length} bytes to ${filePath}`;
  },
};
