import type { ToolPlugin } from "@microagent/core";
import { execSync } from "node:child_process";

export const bashTool: ToolPlugin = {
  definition: {
    name: "bash",
    description: "Execute a bash command and return stdout/stderr",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        cwd: { type: "string", description: "Working directory (optional)" },
      },
      required: ["command"],
    },
  },
  async execute(args) {
    try {
      const result = execSync(String(args.command), {
        cwd: args.cwd ? String(args.cwd) : process.cwd(),
        encoding: "utf-8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      return result;
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      return `EXIT ERROR\nstdout: ${e.stdout ?? ""}\nstderr: ${e.stderr ?? ""}\n${e.message}`;
    }
  },
};
