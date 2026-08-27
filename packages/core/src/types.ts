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

/**
 * A provider-native block carried verbatim.
 *
 * Some providers require blocks to be echoed back unchanged on later turns of
 * the same conversation — Anthropic thinking blocks are the motivating case:
 * editing or dropping one breaks the turn. Core has no representation for such
 * blocks and no business inventing one, so it stores them opaquely.
 *
 * The contract is deliberately strict: **core never reads, inspects, or rewrites
 * `block`.** It stores the part and hands it back to the same provider, in
 * order. `provider` exists so a block is never replayed to a provider that did
 * not produce it — that would at best be ignored and at worst rejected.
 */
export interface OpaquePart {
  type: "provider_native";
  /** Name of the provider that produced this block. */
  provider: string;
  /** Verbatim provider payload. Never inspected or mutated by core. */
  block: unknown;
}

export type ContentPart = TextPart | ImagePart | OpaquePart;

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
  type: "text" | "thinking" | "tool_call_start" | "tool_call_delta" | "tool_call_end" | "done";
  text?: string;
  toolCall?: Partial<ToolCall>;
}

/** Token usage from a single request */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Tokens served from the provider's prompt cache.
   *
   * Worth reporting even though it looks like an accounting detail:
   * `cacheReadTokens` staying at 0 across repeated runs is the only signal that
   * something volatile has leaked into the prompt prefix. That regression shows
   * up as a cost increase with no functional symptom, so it has to be
   * observable.
   */
  cacheReadTokens?: number;
  /** Tokens written to the provider's prompt cache (billed at a premium). */
  cacheWriteTokens?: number;
}

/** Add two usage records together, treating missing cache fields as zero. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  };
}

export function emptyUsage(): TokenUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
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
  execute(args: Record<string, unknown>, ctx?: ToolExecutionContext): Promise<string>;
}

/** Context handed to a tool at execution time. */
export interface ToolExecutionContext {
  /** Cancelled when the run is cancelled, times out, or exceeds its deadline. */
  signal?: AbortSignal;
  /** Correlation id for the turn that requested this call. */
  correlationId?: string;
  sessionId?: string;
  /** The tool call's id, for logs that need to tie back to the model's request. */
  toolCallId?: string;
}

// ── Run outcome ────────────────────────────────────────────────────────────

/**
 * Why a run stopped.
 *
 * Distinguishing these is not cosmetic: `end_turn` is an answer, while
 * `max_tool_rounds`, `budget_exhausted`, `deadline_exceeded` and `max_tokens`
 * are truncations that happen to carry plausible-looking text. A caller that
 * cannot tell them apart will publish a partial answer as a complete one.
 */
export type StopReason =
  | "end_turn"
  | "max_tool_rounds"
  | "budget_exhausted"
  | "deadline_exceeded"
  | "cancelled"
  | "refusal"
  | "max_tokens"
  | "error";

/** A tool call as it actually happened, for the run's record. */
export interface RunToolCall {
  id: string;
  name: string;
  isError: boolean;
  /** Set when a policy denied the call; the call never executed. */
  denied?: boolean;
  durationMs?: number;
}

export interface RunResult {
  text: string;
  stopReason: StopReason;
  usage: TokenUsage;
  rounds: number;
  toolCalls: RunToolCall[];
  /** Present when `stopReason` is `error`, and sometimes alongside others. */
  error?: Error;
  /** Correlation id for this run, threaded into audit records and tool calls. */
  correlationId: string;
  /**
   * Result of validating the final text against `responseFormat`, when one was
   * requested. A validation failure is a signal to count and alert on, not an
   * exception — so it lands here rather than being thrown.
   */
  structured?: StructuredOutcome;
}

/** Outcome of validating a response against a requested schema. */
export type StructuredOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: string; raw: string };

/** Per-run limits and cancellation. */
export interface RunOptions {
  signal?: AbortSignal;
  /** Default 20. */
  maxToolRounds?: number;
  /** Cumulative token ceiling across the run; checked before each provider call. */
  tokenBudget?: number;
  /** Wall-clock ceiling for the whole run, in milliseconds. */
  deadlineMs?: number;
  /** Per tool call timeout, in milliseconds. */
  toolTimeoutMs?: number;
  /** Per-call output cap, passed through to the provider. */
  maxTokens?: number;
  /** Constrain and validate the final response against a schema. */
  responseFormat?: ResponseFormat;
  /** Images to attach to the user message. */
  images?: string[];
  /** Correlation id; generated when omitted. */
  correlationId?: string;
}

// ── Tool policy ────────────────────────────────────────────────────────────

export type PolicyDecision =
  | { action: "allow" }
  | { action: "rewrite"; arguments: Record<string, unknown> }
  | { action: "deny"; reason: string };

export interface PolicyContext {
  sessionId: string;
  round: number;
  correlationId: string;
  principal?: Principal;
}

/**
 * A gate in front of tool execution.
 *
 * A denial is fed back to the model as the tool's result rather than aborting
 * the run — that is why `deny` carries a reason. The model can then adapt
 * ("that namespace is out of scope, try another") instead of stalling against a
 * silent failure.
 */
export interface ToolPolicy {
  check(call: ToolCall, ctx: PolicyContext): Promise<PolicyDecision> | PolicyDecision;
}

// ── Provider interface ─────────────────────────────────────────────────────

/**
 * A block of system prompt.
 *
 * Separate from `Message` because Anthropic takes `system` as a top-level
 * parameter rather than a message, and because cache breakpoints attach to
 * system blocks — which means the block boundary has to be expressible.
 */
export interface SystemBlock {
  text: string;
  /** Mark this block as a cache breakpoint. */
  cache?: boolean;
}

/**
 * Where to place prompt-cache breakpoints.
 *
 * Needed because not every platform caches automatically — on Bedrock in
 * particular, `cache_control` has to be placed by hand on the last stable
 * block or the cost model simply does not hold. Providers without manual
 * breakpoints ignore this.
 */
export interface CacheBreakpoints {
  /** Mark the last system block. */
  system?: boolean;
  /** Mark the last tool definition, caching the whole tool list. */
  tools?: boolean;
  /** Indices into `messages` to mark. Negative indices count from the end. */
  messages?: number[];
}

export type ThinkingMode = "adaptive" | "disabled";

export interface ThinkingConfig {
  type: ThinkingMode;
  /** `summarized` returns readable reasoning; `omitted` (default) does not. */
  display?: "summarized" | "omitted";
}

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ResponseFormat {
  type: "json_schema";
  name?: string;
  schema: Record<string, unknown>;
}

/** Normalised provider stop reason. */
export type ProviderStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "refusal"
  | "pause_turn"
  | "unknown";

export interface ChatOptions {
  tools?: ToolDefinition[];
  onDelta?: (delta: StreamDelta) => void;
  /** Must reach both the HTTP request and any in-flight retry. */
  signal?: AbortSignal;
  /**
   * Output cap for this call. Provider-internal previously; it belongs here
   * because on Anthropic models it bounds thinking *plus* visible output, which
   * makes it a per-call decision rather than a provider-wide constant.
   */
  maxTokens?: number;
  system?: string | SystemBlock[];
  cacheBreakpoints?: CacheBreakpoints;
  responseFormat?: ResponseFormat;
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
}

export interface ChatResult {
  message: Message;
  usage: TokenUsage;
  /** The provider knows why it stopped; core needs it to build a `StopReason`. */
  stopReason?: ProviderStopReason;
}

/** Provider configuration */
export interface ProviderConfig {
  /** Provider type: ollama | github-copilot | openai | bedrock | custom */
  type: string;
  /** Default model for this provider */
  model: string;
  baseUrl?: string;
  /**
   * API key as a literal.
   *
   * @deprecated Prefer `apiKeyEnv` or `apiKeyFile`. A literal in a config file
   * is a secret at rest in a place that gets copied, committed and mounted.
   */
  apiKey?: string;
  /** Name of an environment variable holding the API key. */
  apiKeyEnv?: string;
  /** Path to a file holding the API key (e.g. a mounted Kubernetes secret). */
  apiKeyFile?: string;
  /** Optional display name (defaults to `type`) */
  name?: string;
  /** AWS region — required by the Bedrock provider. */
  region?: string;
  /** Default output cap for this provider's calls. */
  maxTokens?: number;
  /** Default thinking configuration. */
  thinking?: ThinkingConfig;
  /** Default effort level. */
  effort?: EffortLevel;
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
  /**
   * One provider round trip.
   *
   * Takes an options object rather than positional `(tools, onDelta)`: the call
   * needs a cancellation signal, a system prompt, an output cap and cache
   * breakpoints, and threading those positionally does not scale.
   */
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResult>;
  listModels(): Promise<ModelInfo[]>;
}

/** Reconnection policy for a transport that can drop. */
export interface ReconnectConfig {
  /** Default true. */
  enabled?: boolean;
  /** Default 5. */
  maxAttempts?: number;
  /** Default 500ms. */
  initialDelayMs?: number;
  /** Default 30s. */
  maxDelayMs?: number;
}

/** MCP server config */
export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  /** Headers for the http transport. */
  headers?: Record<string, string>;
  /** Abort a connect attempt that hangs. Default 15s. */
  connectTimeoutMs?: number;
  reconnect?: ReconnectConfig;
}

/** Model info with provider context */
export interface ProviderModelInfo extends ModelInfo {
  provider: string;
}

// ── Identity ───────────────────────────────────────────────────────────────

/**
 * An authenticated caller.
 *
 * Lives in core rather than the server package because sessions are owned by a
 * subject and audit records name one; both are core concerns.
 */
export interface Principal {
  subject: string;
  email?: string;
  groups: string[];
  scopes: string[];
  clientId?: string;
  /** Remaining verified claims, for policies that need more than the above. */
  claims?: Record<string, unknown>;
}

// ── Config ─────────────────────────────────────────────────────────────────

export interface OidcConfig {
  /** Issuer URL. JWKS and endpoints are discovered from it unless overridden. */
  issuer: string;
  /** Expected `aud` claim. */
  audience?: string;
  /** Override the discovered `jwks_uri`. */
  jwksUri?: string;
  /**
   * A shared OAuth `client_id` published to clients via the discovery document.
   * Optional — clients may bring their own.
   */
  clientIdHint?: string;
  /** Scopes this deployment knows about, published via discovery. */
  scopes?: string[];
  /** Scopes every request must carry. */
  requiredScopes?: string[];
  /** Signature algorithm allowlist. Defaults to RS256 and ES256. */
  algorithms?: string[];
  /** Clock skew allowance in seconds. Default 60. */
  clockSkewSec?: number;
  /** Expected `azp` claim, when the IdP sets one. */
  authorizedParty?: string;
}

export interface AuthConfig {
  /**
   * Explicitly disable auth for local development. Defaults to enabled
   * whenever `oidc` is present — so a deployment cannot lose authentication by
   * forgetting a flag, only by asking for it.
   */
  enabled?: boolean;
  oidc?: OidcConfig;
}

export interface SessionLimits {
  /** Default 100. */
  maxSessions?: number;
  /** Idle time before a session is evicted. Default 30 minutes. */
  ttlMs?: number;
  /** Default 100. */
  maxTurnsPerSession?: number;
  /** Default 2000. */
  maxMessagesPerSession?: number;
  /** How often the eviction sweep runs. Default 60s. */
  sweepIntervalMs?: number;
}

/**
 * Audit trail configuration.
 *
 * `level` is the consequential setting. Prompts and tool results are the most
 * sensitive data the agent handles — everything the tools gathered ends up in
 * them — so content capture is off unless asked for.
 */
export interface AuditConfig {
  /** Default true on the server, false in the CLI. */
  enabled?: boolean;
  /**
   * `metadata` (default) records outcomes only; `io` adds the user input, the
   * response, and each tool call's arguments and result; `full` adds the whole
   * message history sent to the model.
   */
  level?: "metadata" | "io" | "full";
  /** Cap on any single recorded text field. Default 8192 characters. */
  maxFieldChars?: number;
  /** Emit a record as each tool call finishes, not just at turn end. Default true. */
  perToolCall?: boolean;
}

/** Per-principal rate and cost limits. */
export interface PrincipalLimits {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  maxSessionsPerPrincipal?: number;
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
  auth?: AuthConfig;
  sessions?: SessionLimits;
  limits?: PrincipalLimits;
  audit?: AuditConfig;
  /**
   * Whether the process may write back to its config file. Defaults to true
   * for the CLI; set false for a container with a read-only root filesystem,
   * where a write is a crash rather than a persisted preference.
   */
  allowConfigWrites?: boolean;
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

/** Is authentication active for this config? */
export function isAuthEnabled(config: MicroagentConfig): boolean {
  if (config.auth?.enabled === false) return false;
  return Boolean(config.auth?.oidc?.issuer);
}
