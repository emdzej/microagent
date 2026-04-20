import type { LLMProvider, Message, ToolDefinition, StreamDelta, TokenUsage, ModelInfo } from "../types.js";

/** Configuration for any OpenAI-compatible endpoint */
export interface OpenAIProviderOptions {
  /** Display name for this provider */
  name: string;
  /** Model identifier */
  model: string;
  /** Base URL (without /chat/completions) */
  baseUrl: string;
  /** Static API key — sent as `Authorization: Bearer <apiKey>` */
  apiKey?: string;
  /** Dynamic token resolver — called before each request (e.g. for Copilot session refresh) */
  getApiKey?: () => Promise<string>;
  /** Extra headers to send with every request */
  headers?: Record<string, string>;
}

/**
 * Unified provider for any OpenAI-compatible chat completions API.
 * Works with: OpenAI, GitHub Copilot, Ollama (/v1), Azure OpenAI,
 * Together, Groq, LM Studio, vLLM, etc.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private model: string;
  private baseUrl: string;
  private baseHeaders: Record<string, string>;
  private getApiKey?: () => Promise<string>;

  constructor(opts: OpenAIProviderOptions) {
    this.name = opts.name;
    this.model = opts.model;
    // Normalize: strip trailing slash
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.baseHeaders = {
      "Content-Type": "application/json",
      ...opts.headers,
    };
    if (opts.apiKey) {
      this.baseHeaders["Authorization"] = `Bearer ${opts.apiKey}`;
    }
    this.getApiKey = opts.getApiKey;
  }

  private async resolveHeaders(): Promise<Record<string, string>> {
    if (!this.getApiKey) return this.baseHeaders;
    const key = await this.getApiKey();
    return { ...this.baseHeaders, Authorization: `Bearer ${key}` };
  }

  async listModels(): Promise<ModelInfo[]> {
    const headers = await this.resolveHeaders();
    const res = await fetch(`${this.baseUrl}/models`, { headers });
    if (!res.ok) {
      throw new Error(`${this.name} models error: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { data?: Array<{ id: string; created?: number }> };
    const models = data.data ?? [];
    return models
      .map((m) => ({ id: m.id, created: m.created }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async chat(
    messages: Message[],
    tools?: ToolDefinition[],
    onDelta?: (delta: StreamDelta) => void
  ): Promise<{ message: Message; usage: TokenUsage }> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.toOpenAIMessages(messages),
      stream: !!onDelta,
    };

    // Request usage in stream mode (OpenAI extension, supported by most)
    if (onDelta) {
      body.stream_options = { include_usage: true };
    }

    if (tools?.length) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }

    const headers = await this.resolveHeaders();
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`${this.name} error: ${res.status} ${await res.text()}`);
    }

    if (onDelta && res.body) {
      return this.handleSSE(res.body, onDelta);
    }

    const data = (await res.json()) as OpenAIChatResponse;
    return this.parseResponse(data);
  }

  // ── Message conversion ──────────────────────────────────────────

  private toOpenAIMessages(messages: Message[]): unknown[] {
    return messages.map((m) => {
      if (m.role === "tool") {
        return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        return {
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        };
      }
      return { role: m.role, content: m.content };
    });
  }

  // ── SSE streaming ───────────────────────────────────────────────

  private async handleSSE(
    body: ReadableStream<Uint8Array>,
    onDelta: (delta: StreamDelta) => void
  ): Promise<{ message: Message; usage: TokenUsage }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const toolCallsMap = new Map<number, { id: string; name: string; argsJson: string }>();

    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;

        let chunk: OpenAIStreamChunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }

        const delta = chunk.choices?.[0]?.delta;
        if (delta) {
          if (delta.content) {
            fullContent += delta.content;
            onDelta({ type: "text", text: delta.content });
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (tc.id) {
                toolCallsMap.set(idx, { id: tc.id, name: tc.function?.name ?? "", argsJson: "" });
                onDelta({ type: "tool_call_start", toolCall: { id: tc.id, name: tc.function?.name } });
              }
              const existing = toolCallsMap.get(idx);
              if (existing && tc.function?.arguments) {
                existing.argsJson += tc.function.arguments;
                if (tc.function.name) existing.name = tc.function.name;
              }
            }
          }
        }

        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          };
        }
      }
    }

    const toolCalls = Array.from(toolCallsMap.values()).map((tc) => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.argsJson); } catch { /* empty */ }
      onDelta({ type: "tool_call_end", toolCall: { id: tc.id, name: tc.name, arguments: args } });
      return { id: tc.id, name: tc.name, arguments: args };
    });

    onDelta({ type: "done" });

    return {
      message: {
        role: "assistant",
        content: fullContent,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      },
      usage,
    };
  }

  // ── Non-streaming response ──────────────────────────────────────

  private parseResponse(data: OpenAIChatResponse): { message: Message; usage: TokenUsage } {
    const choice = data.choices[0];
    const toolCalls = choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    return {
      message: {
        role: "assistant",
        content: choice.message.content ?? "",
        toolCalls: toolCalls?.length ? toolCalls : undefined,
      },
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
    };
  }
}

// ── Response types ──────────────────────────────────────────────

interface OpenAIChatResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}
