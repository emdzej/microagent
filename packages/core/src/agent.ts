import type { LLMProvider, Message, StreamDelta, MicroagentConfig, ToolResult, ContentPart } from "./types.js";
import { getTextContent } from "./types.js";
import { ToolRegistry } from "./tool-registry.js";
import { McpManager } from "./mcp.js";
import { UsageStats } from "./stats.js";
import { createProvider } from "./providers/factory.js";

export interface AgentEvents {
  onDelta?: (delta: StreamDelta) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: ToolResult) => void;
  onError?: (error: Error) => void;
}

/** The core agent loop — sends messages, executes tools, loops until done */
export class Agent {
  readonly provider: LLMProvider;
  readonly tools: ToolRegistry;
  readonly mcp: McpManager;
  readonly stats: UsageStats;
  private messages: Message[] = [];
  private maxToolRounds = 20;

  constructor(config: MicroagentConfig) {
    this.tools = new ToolRegistry();
    this.mcp = new McpManager();
    this.stats = new UsageStats();

    this.provider = createProvider(config.provider);

    if (config.systemPrompt) {
      this.messages.push({ role: "system", content: config.systemPrompt });
    }
  }

  /** Initialize MCP servers and register their tools */
  async init(mcpServers?: MicroagentConfig["mcpServers"]): Promise<void> {
    if (!mcpServers?.length) return;
    for (const server of mcpServers) {
      try {
        const plugins = await this.mcp.connect(server);
        for (const plugin of plugins) {
          this.tools.register(plugin);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to connect MCP server "${server.name}": ${msg}`);
      }
    }
  }

  /** Run one user turn — may loop multiple times for tool calls */
  async run(userMessage: string, events: AgentEvents = {}, images?: string[]): Promise<string> {
    const content: string | ContentPart[] = images?.length
      ? [
          { type: "text", text: userMessage } as const,
          ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
        ]
      : userMessage;

    this.messages.push({ role: "user", content });

    let rounds = 0;
    while (rounds < this.maxToolRounds) {
      rounds++;

      const toolDefs = this.tools.getDefinitions();
      const { message, usage } = await this.provider.chat(
        this.messages,
        toolDefs.length ? toolDefs : undefined,
        events.onDelta
      );

      this.stats.record(usage);
      this.messages.push(message);

      // No tool calls — we're done
      if (!message.toolCalls?.length) {
        return getTextContent(message);
      }

      // Execute all tool calls
      for (const tc of message.toolCalls) {
        this.stats.recordToolCall();
        events.onToolCall?.(tc.name, tc.arguments);

        const result = await this.tools.execute(tc);
        events.onToolResult?.(tc.name, result);

        this.messages.push({
          role: "tool",
          content: result.content,
          toolCallId: tc.id,
        });
      }
    }

    return "[max tool rounds reached]";
  }

  getMessages(): readonly Message[] {
    return this.messages;
  }

  /** Switch the active model at runtime */
  setModel(model: string): void {
    this.provider.setModel(model);
  }

  async shutdown(): Promise<void> {
    await this.mcp.disconnectAll();
  }
}
