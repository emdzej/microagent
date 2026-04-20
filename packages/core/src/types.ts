// ── Core types for microagent ──

/** A single message in a conversation */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

/** A tool call requested by the model */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Result of executing a tool */
export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

/** Streaming delta from provider */
export interface StreamDelta {
  type: "text" | "tool_call_start" | "tool_call_delta" | "tool_call_end" | "done";
  text?: string;
  toolCall?: Partial<ToolCall>;
}

/** Token usage from a single request */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Tool definition (JSON Schema based) */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A tool plugin that can be registered */
export interface ToolPlugin {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<string>;
}

/** Provider configuration */
export interface ProviderConfig {
  type: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

/** Model metadata returned by provider */
export interface ModelInfo {
  id: string;
  name?: string;
  created?: number;
}

/** LLM Provider interface */
export interface LLMProvider {
  readonly name: string;
  chat(
    messages: Message[],
    tools?: ToolDefinition[],
    onDelta?: (delta: StreamDelta) => void
  ): Promise<{ message: Message; usage: TokenUsage }>;
  listModels(): Promise<ModelInfo[]>;
}

/** MCP server config */
export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
}

/** Full application config */
export interface MicroagentConfig {
  provider: ProviderConfig;
  systemPrompt?: string;
  mcpServers?: McpServerConfig[];
}
