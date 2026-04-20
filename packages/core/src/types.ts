// ── Core types for microagent ──

/** Content part for multimodal messages */
export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image_url";
  image_url: { url: string }; // data:image/...;base64,... or https://...
}

export type ContentPart = TextPart | ImagePart;

/** A single message in a conversation */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

/** Extract text content from a message (handles both string and ContentPart[]) */
export function getTextContent(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
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
  /** Provider type: ollama | github-copilot | openai | custom */
  type: string;
  /** Default model for this provider */
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /** Optional display name (defaults to `type`) */
  name?: string;
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
  /** Currently active model identifier */
  readonly currentModel: string;
  /** Switch the active model at runtime */
  setModel(model: string): void;
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

/** Model info with provider context */
export interface ProviderModelInfo extends ModelInfo {
  provider: string;
}

/** Full application config */
export interface MicroagentConfig {
  /** @deprecated Use `providers` array instead. Kept for backward compatibility. */
  provider?: ProviderConfig;
  /** Multiple provider configurations */
  providers?: ProviderConfig[];
  /** Name/type of the active provider (defaults to first in array) */
  activeProvider?: string;
  systemPrompt?: string;
  mcpServers?: McpServerConfig[];
}

/** Normalize config: ensure `providers` array is populated from legacy `provider` field */
export function resolveProviders(config: MicroagentConfig): ProviderConfig[] {
  if (config.providers?.length) return config.providers;
  if (config.provider) return [config.provider];
  return [];
}

/** Get the active provider config */
export function resolveActiveProvider(config: MicroagentConfig): ProviderConfig {
  const providers = resolveProviders(config);
  if (!providers.length) throw new Error("No providers configured");
  if (config.activeProvider) {
    const found = providers.find(
      (p) => (p.name ?? p.type) === config.activeProvider || p.type === config.activeProvider
    );
    if (found) return found;
  }
  return providers[0];
}
