import type { ToolPlugin, ToolDefinition, ToolResult, ToolCall } from "./types.js";

/** Central registry for all tools (built-in + MCP) */
export class ToolRegistry {
  private tools = new Map<string, ToolPlugin>();

  register(plugin: ToolPlugin): void {
    this.tools.set(plugin.definition.name, plugin);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): ToolPlugin | undefined {
    return this.tools.get(name);
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const plugin = this.tools.get(call.name);
    if (!plugin) {
      return { toolCallId: call.id, content: `Unknown tool: ${call.name}`, isError: true };
    }
    try {
      const content = await plugin.execute(call.arguments);
      return { toolCallId: call.id, content };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { toolCallId: call.id, content: `Tool error: ${msg}`, isError: true };
    }
  }
}
