import type {
  ChatOptions,
  ChatResult,
  ContentPart,
  LLMProvider,
  Message,
  ModelInfo,
  ProviderStopReason,
  StreamDelta,
  SystemBlock,
  TokenUsage,
} from "../types.js";

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
  /** Default output cap, when a call does not specify one. */
  maxTokens?: number;
}

/**
 * Unified provider for any OpenAI-compatible chat completions API.
 * Works with: OpenAI, GitHub Copilot, Ollama (/v1), Azure OpenAI,
 * Together, Groq, LM Studio, vLLM, etc.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private _model: string;
  private baseUrl: string;
  private baseHeaders: Record<string, string>;
  private getApiKey?: () => Promise<string>;
  private defaultMaxTokens?: number;

  constructor(opts: OpenAIProviderOptions) {
    this.name = opts.name;
    this._model = opts.model;
    this.defaultMaxTokens = opts.maxTokens;
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

  get currentModel(): string {
    return this._model;
  }

  setModel(model: string): void {
    this._model = model;
  }

  private async resolveHeaders(): Promise<Record<string, string>> {
    if (!this.getApiKey) return this.baseHeaders;
    const key = await this.getApiKey();
    return { ...this.baseHeaders, Authorization: `Bearer ${key}` };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const headers = await this.resolveHeaders();
    const res = await fetch(`${this.baseUrl}/models`, { headers, signal });
    if (!res.ok) {
      throw new Error(`${this.name} models error: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { data?: Array<{ id: string; created?: number }> };
    const models = data.data ?? [];
    return models
      .map((m) => ({ id: m.id, created: m.created }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * One chat completion.
   *
   * `cacheBreakpoints`, `thinking` and `effort` are accepted and ignored: this
   * API has no equivalent, and silently ignoring a hint is the right behaviour
   * for a portable option — the alternative is every caller branching on
   * provider type before it can set one.
   */
  async chat(messages: Message[], options: ChatOptions = {}): Promise<ChatResult> {
    const { tools, onDelta, signal, maxTokens, system, responseFormat } = options;

    const body: Record<string, unknown> = {
      model: this._model,
      messages: this.toOpenAIMessages(messages, system),
      stream: !!onDelta,
    };

    const cap = maxTokens ?? this.defaultMaxTokens;
    if (cap !== undefined) body.max_tokens = cap;

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

    if (responseFormat) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: responseFormat.name ?? "response",
          schema: responseFormat.schema,
          strict: true,
        },
      };
    }

    const headers = await this.resolveHeaders();
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // Reaching the transport is the point: a cancel that only stops the loop
      // between rounds leaves this request running to completion.
      signal,
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

  private toOpenAIMessages(messages: Message[], system?: string | SystemBlock[]): unknown[] {
    const out: unknown[] = [];

    // This API takes the system prompt as a message, so the top-level `system`
    // option is folded back in here. Core keeps it separate because other
    // providers take it as a request parameter and attach cache breakpoints to
    // it — the block boundary has to survive that far.
    const systemText = systemToText(system);
    if (systemText) out.push({ role: "system", content: systemText });

    for (const m of messages) {
      if (m.role === "tool") {
        out.push({
          role: "tool",
          content: typeof m.content === "string" ? m.content : "",
          tool_call_id: m.toolCallId,
        });
        continue;
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        out.push({
          role: "assistant",
          content: (typeof m.content === "string" ? m.content : "") || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        });
        continue;
      }
      out.push({ role: m.role, content: this.toOpenAIContent(m.content) });
    }

    return out;
  }

  /**
   * Strip provider-native blocks that did not come from this provider.
   *
   * An opaque block is meaningful only to the provider that produced it —
   * replaying an Anthropic thinking block here would at best be ignored and at
   * worst rejected, so it is dropped rather than forwarded.
   */
  private toOpenAIContent(content: string | ContentPart[]): unknown {
    if (typeof content === "string") return content;
    const kept = content.filter((p) => p.type !== "provider_native" || p.provider === this.name);
    if (kept.length === content.length) return content;
    return kept;
  }

  // ── SSE streaming ───────────────────────────────────────────────

  private async handleSSE(
    body: ReadableStream<Uint8Array>,
    onDelta: (delta: StreamDelta) => void
  ): Promise<ChatResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let finishReason: string | undefined;
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

        if (chunk.choices?.[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
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

              // Accumulate into the existing entry rather than replacing it.
              // Creating a fresh entry whenever a chunk carries an `id` throws
              // away any arguments already buffered for this index — harmless
              // when the id arrives in the first chunk, but silently corrupting
              // for providers that send arguments first, or that repeat the id.
              let existing = toolCallsMap.get(idx);
              if (!existing) {
                existing = { id: "", name: "", argsJson: "" };
                toolCallsMap.set(idx, existing);
              }

              if (tc.id && !existing.id) {
                existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                onDelta({
                  type: "tool_call_start",
                  toolCall: { id: existing.id, name: existing.name },
                });
              }

              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments) existing.argsJson += tc.function.arguments;
            }
          }
        }

        if (chunk.usage) {
          usage = toUsage(chunk.usage);
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
      stopReason: mapFinishReason(finishReason),
    };
  }

  // ── Non-streaming response ──────────────────────────────────────

  private parseResponse(data: OpenAIChatResponse): ChatResult {
    const choice = data.choices[0];
    const toolCalls = choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: parseArguments(tc.function.arguments),
    }));

    return {
      message: {
        role: "assistant",
        content: choice.message.content ?? "",
        toolCalls: toolCalls?.length ? toolCalls : undefined,
      },
      usage: data.usage
        ? toUsage(data.usage)
        : { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stopReason: mapFinishReason(choice.finish_reason),
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function systemToText(system?: string | SystemBlock[]): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  const text = system.map((b) => b.text).join("\n\n");
  return text || undefined;
}

/**
 * Tolerate malformed tool arguments.
 *
 * A model that emits invalid JSON here would otherwise throw inside response
 * parsing and take down the whole turn, losing the rest of the response with
 * it. An empty argument object reaches the tool, which reports a usable error.
 */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toUsage(usage: OpenAIUsage): TokenUsage {
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    // This API reports cache reads but not writes, so the write figure stays
    // absent rather than being reported as a confident zero.
    cacheWriteTokens: undefined,
  };
}

/** Map OpenAI's `finish_reason` onto the normalised set. */
function mapFinishReason(reason?: string): ProviderStopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return "unknown";
  }
}

// ── Response types ──────────────────────────────────────────────

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenAIChatResponse {
  choices: Array<{
    finish_reason?: string;
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
  usage?: OpenAIUsage;
}

interface OpenAIStreamChunk {
  choices?: Array<{
    finish_reason?: string;
    delta: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: OpenAIUsage;
}
