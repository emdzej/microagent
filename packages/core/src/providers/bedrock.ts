import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import type {
  ChatOptions,
  ChatResult,
  ContentPart,
  EffortLevel,
  LLMProvider,
  Message,
  ModelInfo,
  ProviderStopReason,
  StreamDelta,
  SystemBlock,
  ThinkingConfig,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from "../types.js";

/**
 * Request parameter types, derived from the installed client rather than
 * imported. The SDK reorganises its exported param types between versions;
 * deriving them keeps this file compiling across those moves.
 */
type MessagesCreateParams = Parameters<AnthropicBedrockMantle["messages"]["create"]>[0];
type MessagesStreamParams = Parameters<AnthropicBedrockMantle["messages"]["stream"]>[0];

export interface BedrockProviderOptions {
  /** Display name. Defaults to `bedrock`. */
  name?: string;
  model: string;
  /** AWS region. Falls back to AWS_REGION / AWS_DEFAULT_REGION. */
  region?: string;
  /** Default output cap. Anthropic requires one on every request. */
  maxTokens?: number;
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
}

/**
 * Anthropic models on Amazon Bedrock.
 *
 * Not reachable through `OpenAICompatibleProvider` with a `baseUrl`: Bedrock
 * authenticates with SigV4, which means a signing client rather than a bearer
 * token. Credentials come from the ambient AWS chain, so IRSA works with no
 * static keys anywhere in the config.
 */
export class BedrockProvider implements LLMProvider {
  readonly name: string;
  private _model: string;
  private client: AnthropicBedrockMantle;
  private readonly defaultMaxTokens: number;
  private readonly defaultThinking?: ThinkingConfig;
  private readonly defaultEffort?: EffortLevel;

  constructor(opts: BedrockProviderOptions) {
    this.name = opts.name ?? "bedrock";
    this._model = normalizeModelId(opts.model);
    // Anthropic requires `max_tokens` on every request, so there has to be a
    // default rather than an optional passthrough.
    this.defaultMaxTokens = opts.maxTokens ?? 8192;
    this.defaultThinking = opts.thinking;
    this.defaultEffort = opts.effort;

    const region = opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    if (!region) {
      throw new Error(
        "bedrock provider requires a region — set `region` in the provider config or AWS_REGION"
      );
    }

    this.client = new AnthropicBedrockMantle({ awsRegion: region });
  }

  get currentModel(): string {
    return this._model;
  }

  setModel(model: string): void {
    this._model = normalizeModelId(model);
  }

  async chat(messages: Message[], options: ChatOptions = {}): Promise<ChatResult> {
    const { tools, onDelta, signal, maxTokens, system, cacheBreakpoints, responseFormat } = options;

    const params: Record<string, unknown> = {
      model: this._model,
      max_tokens: maxTokens ?? this.defaultMaxTokens,
      messages: toAnthropicMessages(messages, this.name, cacheBreakpoints?.messages),
    };

    const systemBlocks = toSystemBlocks(system, cacheBreakpoints?.system);
    if (systemBlocks) params.system = systemBlocks;

    if (tools?.length) {
      params.tools = toAnthropicTools(tools, cacheBreakpoints?.tools);
    }

    const thinking = options.thinking ?? this.defaultThinking;
    const effort = options.effort ?? this.defaultEffort;
    if (thinking) params.thinking = { type: thinking.type, ...(thinking.display ? { display: thinking.display } : {}) };
    if (effort) params.output_config = { effort };

    if (responseFormat) {
      params.output_config = {
        ...(params.output_config as Record<string, unknown> | undefined),
        format: {
          type: "json_schema",
          schema: responseFormat.schema,
          ...(responseFormat.name ? { name: responseFormat.name } : {}),
        },
      };
    }

    // The params object is assembled untyped and cast on the way out. The
    // request shape here moves faster than the pinned SDK's types — adaptive
    // thinking, `output_config.effort` and structured outputs have each landed
    // that way — and a type error on a field the service accepts is a worse
    // failure than no compile-time check on this one call.
    const request = params as unknown as MessagesCreateParams;

    if (onDelta) {
      return this.streamChat(request, onDelta, signal);
    }

    const response = await this.client.messages.create(request, { signal });
    return this.parseResponse(response as unknown as AnthropicResponse);
  }

  private async streamChat(
    request: MessagesCreateParams,
    onDelta: (delta: StreamDelta) => void,
    signal?: AbortSignal
  ): Promise<ChatResult> {
    const stream = this.client.messages.stream(request as unknown as MessagesStreamParams, {
      signal,
    });

    stream.on("text", (text: string) => onDelta({ type: "text", text }));

    // Thinking deltas are surfaced separately so a UI can render reasoning
    // without it being mistaken for the answer.
    stream.on("thinking", (thinking: string) => onDelta({ type: "thinking", text: thinking }));

    const final = (await stream.finalMessage()) as unknown as AnthropicResponse;
    const result = this.parseResponse(final);

    for (const call of result.message.toolCalls ?? []) {
      onDelta({ type: "tool_call_end", toolCall: call });
    }
    onDelta({ type: "done" });

    return result;
  }

  private parseResponse(response: AnthropicResponse): ChatResult {
    const parts: ContentPart[] = [];
    const toolCalls: ToolCall[] = [];
    let text = "";

    for (const block of response.content ?? []) {
      switch (block.type) {
        case "text":
          text += block.text ?? "";
          parts.push({ type: "text", text: block.text ?? "" });
          break;
        case "tool_use":
          toolCalls.push({
            id: block.id ?? "",
            name: block.name ?? "",
            arguments: (block.input as Record<string, unknown>) ?? {},
          });
          // The tool_use block is kept verbatim as well. On a later turn the
          // assistant message has to carry it back alongside its thinking, and
          // reconstructing one from `toolCalls` would not survive signature
          // checks.
          parts.push({ type: "provider_native", provider: this.name, block });
          break;
        default:
          // thinking, redacted_thinking, and anything the service adds later.
          // Thinking blocks in particular must be echoed back unchanged on
          // subsequent turns of the same conversation — editing or dropping one
          // breaks the turn — and core has no representation for them, so they
          // travel opaquely.
          parts.push({ type: "provider_native", provider: this.name, block });
      }
    }

    return {
      message: {
        role: "assistant",
        // Keeping the parts array (rather than just `text`) is what makes
        // multi-turn-with-thinking possible at all.
        content: parts.length ? parts : text,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      },
      usage: toUsage(response.usage),
      stopReason: mapStopReason(response.stop_reason),
    };
  }

  /**
   * Bedrock exposes no model listing through this client, so this is a curated
   * set rather than a live query. Better than an empty picker, and honest about
   * what it is.
   */
  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: "anthropic.claude-opus-5", name: "Claude Opus 5" },
      { id: "anthropic.claude-opus-4-8", name: "Claude Opus 4.8" },
      { id: "anthropic.claude-opus-4-7", name: "Claude Opus 4.7" },
      { id: "anthropic.claude-sonnet-5", name: "Claude Sonnet 5" },
      { id: "anthropic.claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { id: "anthropic.claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ];
  }
}

// ── Model ids ───────────────────────────────────────────────────

/**
 * Bedrock model ids carry an `anthropic.` prefix.
 *
 * Only a bare `claude-*` id is prefixed. Cross-region inference profiles
 * (`us.anthropic.…`) and any already-qualified id are left exactly as written —
 * guessing at those would break a deployment that had it right.
 */
export function normalizeModelId(model: string): string {
  if (!model) return model;
  if (model.startsWith("claude-")) return `anthropic.${model}`;
  return model;
}

// ── Request conversion ──────────────────────────────────────────

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  [key: string]: unknown;
}

interface AnthropicResponse {
  content?: AnthropicBlock[];
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

const CACHE_CONTROL = { cache_control: { type: "ephemeral" as const } };

/**
 * Build the top-level `system` parameter.
 *
 * Anthropic takes `system` as a request parameter rather than a message, and
 * cache breakpoints attach to system blocks — which is the whole reason core
 * carries the system prompt separately from `messages`.
 */
function toSystemBlocks(
  system: string | SystemBlock[] | undefined,
  cacheLast?: boolean
): unknown[] | undefined {
  if (!system) return undefined;
  const blocks = typeof system === "string" ? [{ text: system }] : system;
  if (!blocks.length) return undefined;

  return blocks.map((block, i) => {
    const isLast = i === blocks.length - 1;
    const wantsCache = block.cache || (cacheLast && isLast);
    return { type: "text", text: block.text, ...(wantsCache ? CACHE_CONTROL : {}) };
  });
}

function toAnthropicTools(tools: ToolDefinition[], cacheLast?: boolean): unknown[] {
  return tools.map((tool, i) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    // On the last tool this caches the entire tool list, which renders ahead of
    // system and messages. Bedrock does no automatic caching, so without a
    // breakpoint placed by hand the tool list is re-billed on every turn.
    ...(cacheLast && i === tools.length - 1 ? CACHE_CONTROL : {}),
  }));
}

/**
 * Convert core messages to Anthropic's shape.
 *
 * Two things this has to get right:
 *
 * 1. Tool results are `user` messages carrying `tool_result` blocks, and *all*
 *    results for one assistant turn belong in a **single** user message.
 *    Splitting them across messages trains the model to stop making parallel
 *    calls, so consecutive `tool` messages are merged here.
 * 2. Provider-native blocks from this provider are replayed verbatim, and ones
 *    from any other provider are dropped — a foreign opaque block is
 *    meaningless here and would be rejected.
 */
function toAnthropicMessages(
  messages: Message[],
  providerName: string,
  cacheIndices?: number[]
): unknown[] {
  const out: Array<{ role: string; content: unknown[] }> = [];
  const marked = new Set(
    (cacheIndices ?? []).map((i) => (i < 0 ? messages.length + i : i))
  );

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    if (message.role === "system") continue; // carried by the `system` parameter

    if (message.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: typeof message.content === "string" ? message.content : "",
      };
      const last = out[out.length - 1];
      // Merge into the open user turn when the previous message was also a
      // tool result, so parallel calls come back together.
      if (last && last.role === "user" && messages[i - 1]?.role === "tool") {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }

    const content = toAnthropicContent(message, providerName);
    if (!content.length) continue;

    if (marked.has(i)) {
      const tail = content[content.length - 1];
      if (typeof tail === "object" && tail !== null) {
        content[content.length - 1] = { ...(tail as object), ...CACHE_CONTROL };
      }
    }

    out.push({ role: message.role === "assistant" ? "assistant" : "user", content });
  }

  return out;
}

function toAnthropicContent(message: Message, providerName: string): unknown[] {
  const blocks: unknown[] = [];

  if (typeof message.content === "string") {
    if (message.content) blocks.push({ type: "text", text: message.content });
  } else {
    for (const part of message.content) {
      switch (part.type) {
        case "text":
          if (part.text) blocks.push({ type: "text", text: part.text });
          break;
        case "image_url":
          blocks.push(toImageBlock(part.image_url.url));
          break;
        case "provider_native":
          // Never replayed to a provider that did not produce it.
          if (part.provider === providerName) blocks.push(part.block);
          break;
      }
    }
  }

  // A tool_use block round-trips through `provider_native` when this provider
  // produced it. Only synthesise one when it did not — i.e. when the history
  // was built against a different provider.
  const alreadyPresent =
    Array.isArray(message.content) &&
    message.content.some(
      (p) =>
        p.type === "provider_native" &&
        p.provider === providerName &&
        isToolUseBlock(p.block)
    );

  if (message.toolCalls?.length && !alreadyPresent) {
    for (const call of message.toolCalls) {
      blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
    }
  }

  return blocks;
}

function isToolUseBlock(block: unknown): boolean {
  return typeof block === "object" && block !== null && (block as { type?: string }).type === "tool_use";
}

/**
 * Turn an OpenAI-shaped image reference into an Anthropic image block.
 *
 * `image_url` is the OpenAI wire format; Anthropic wants a `source` object with
 * base64 data. Translating at the provider boundary is the right place for it —
 * core's type should not pretend one wire format is universal, but it also
 * should not carry two.
 */
function toImageBlock(url: string): unknown {
  const dataUri = /^data:([^;]+);base64,(.*)$/.exec(url);
  if (dataUri) {
    return {
      type: "image",
      source: { type: "base64", media_type: dataUri[1], data: dataUri[2] },
    };
  }
  return { type: "image", source: { type: "url", url } };
}

// ── Response conversion ─────────────────────────────────────────

function toUsage(usage: AnthropicResponse["usage"]): TokenUsage {
  const prompt = usage?.input_tokens ?? 0;
  const completion = usage?.output_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    // Cached and cache-written tokens are billed but reported outside
    // `input_tokens`, so a total that ignores them understates the request.
    totalTokens: prompt + completion + cacheRead + cacheWrite,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

function mapStopReason(reason?: string | null): ProviderStopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "refusal":
      return "refusal";
    case "pause_turn":
      return "pause_turn";
    default:
      return "unknown";
  }
}
