import type { ToolRegistry } from "@microagent/core";
import { fileReadTool } from "./file-read.js";
import { fileWriteTool } from "./file-write.js";
import { bashTool } from "./bash.js";
import { listDirTool } from "./list-dir.js";

export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.register(fileReadTool);
  registry.register(fileWriteTool);
  registry.register(bashTool);
  registry.register(listDirTool);
}
