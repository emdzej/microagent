import { randomUUID } from "node:crypto";
import type {
  AuditOptions,
  AuditPrompt,
  AuditSink,
  AuditToolCall,
} from "./audit.js";
import { AuditContentPolicy, auditPrincipal, auditToolCall } from "./audit.js";
import { parseStructured } from "./structured-output.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { UsageStats } from "./stats.js";
import type {
  CacheBreakpoints,
  ContentPart,
  EffortLevel,
  LLMProvider,
  Message,
  Principal,
  RunOptions,
  RunResult,
  RunToolCall,
  StopReason,
  StreamDelta,
  SystemBlock,
  ThinkingConfig,
  TokenUsage,
  ToolCall,
  ToolPolicy,
  ToolResult,
} from "./types.js";
import { addUsage, emptyUsage, getTextContent } from "./types.js";

export interface AgentEvents {
  onDelta?: (delta: StreamDelta) => void;
  /**
   * A tool is about to run. `id` is the tool call's id — use it to pair this
   * call with its `onToolResult`.
   *
   * Pairing on `name` alone is ambiguous when a turn invokes the same tool more
   * than once. Always pair on `id`.
   */
  onToolCall?: (name: string, args: Record<string, unknown>, id: string) => void;
  onToolResult?: (name: string, result: ToolResult) => void;
  /** A policy rejected a call. The reason is also fed back to the model. */
  onToolDenied?: (name: string, id: string, reason: string) => void;
  onError?: (error: Error) => void;
}

export interface SessionLimitOptions {
  maxTurns?: number;
  maxMessages?: number;
}

export interface SessionOptions {
  /** Supply one to reattach to a known id; otherwise generated. */
  id?: string;
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
  /**
   * The caller this session belongs to. Sessions are owned: a request may only
   * address a session whose principal matches its own.
   */
  principal?: Principal;
  /** Pin this session to a provider. Defaults to the agent's active provider. */
  provider?: LLMProvider;
  policy?: ToolPolicy;
  audit?: AuditSink;
  /** How much of the prompt and tool content the audit trail records. */
  auditOptions?: AuditOptions;
  stats?: UsageStats;
  limits?: SessionLimitOptions;
  /** Applied to every run unless the run overrides them. */
  defaults?: RunOptions;
  cacheBreakpoints?: CacheBreakpoints;
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
}

const DEFAULT_MAX_TOOL_ROUNDS = 20;
const DEFAULT_MAX_TURNS = 100;
const DEFAULT_MAX_MESSAGES = 2000;

/**
 * One conversation.
 *
 * The reason this exists as its own object rather than living on `Agent`: a
 * single shared `messages` array is a data leak the moment more than one caller
 * is served. Caller A's context — and whatever their tools returned — would sit
 * in caller B's prompt. Authenticating the caller does not help, because it
 * authenticates who *starts* a leak, not who receives it.
 *
 * Turns within a session still serialise, because two overlapping turns would
 * interleave their appends into this session's history — a `tool` message can
 * land without the `assistant` message carrying its `tool_calls`, which most
 * providers reject with a 400. But the queue is per-session, so separate
 * sessions run concurrently.
 */
export class Session {
  readonly id: string;
  readonly createdAt = Date.now();
  readonly principal?: Principal;
  readonly metadata: Record<string, unknown>;

  private _lastUsedAt = Date.now();
  private messages: Message[] = [];
  private readonly systemPrompt?: string;
  /** Per-session, not global — this is what lets sessions run in parallel. */
  private queue: Promise<unknown> = Promise.resolve();
  private _usage: TokenUsage = emptyUsage();
  private _turns = 0;
  private _closed = false;

  private readonly maxTurns: number;
  private readonly maxMessages: number;
  private readonly auditPolicy: AuditContentPolicy;

  constructor(
    private readonly provider: LLMProvider,
    private readonly tools: ToolRegistry,
    private readonly opts: SessionOptions = {}
  ) {
    this.id = opts.id ?? randomUUID();
    this.auditPolicy = new AuditContentPolicy(opts.auditOptions);
    this.systemPrompt = opts.systemPrompt;
    this.metadata = opts.metadata ?? {};
    this.principal = opts.principal;
    this.maxTurns = opts.limits?.maxTurns ?? DEFAULT_MAX_TURNS;
    this.maxMessages = opts.limits?.maxMessages ?? DEFAULT_MAX_MESSAGES;
  }

  get lastUsedAt(): number {
    return this._lastUsedAt;
  }

  get turns(): number {
    return this._turns;
  }

  get closed(): boolean {
    return this._closed;
  }

  /** Cumulative usage for this session, including cache accounting. */
  get usage(): TokenUsage {
    return { ...this._usage };
  }

  getMessages(): readonly Message[] {
    return this.messages;
  }

  /**
   * The system prompt, exposed separately from `messages`.
   *
   * Not stored as `messages[0]`: some providers take `system` as a top-level
   * parameter rather than a message, and cache breakpoints attach to system
   * blocks — so the boundary has to survive as far as the provider.
   */
  getSystem(): string | SystemBlock[] | undefined {
    if (!this.systemPrompt) return undefined;
    const breakpoints = this.opts.cacheBreakpoints;
    if (breakpoints?.system) {
      return [{ text: this.systemPrompt, cache: true }];
    }
    return this.systemPrompt;
  }

  /**
   * Release the session's history.
   *
   * Sessions accumulate whatever the tools gathered, which is both memory and,
   * often, personal data — so there is an explicit way to drop it rather than
   * waiting for a TTL.
   */
  close(): void {
    this._closed = true;
    this.messages = [];
  }

  /**
   * Run one user turn — may loop for several rounds of tool calls.
   *
   * Never throws for an in-band failure. A cancelled, over-budget, or errored
   * run comes back as a `RunResult` with the matching `stopReason`, because a
   * partial answer that is clearly labelled is more useful to a caller than an
   * exception, and the usage spent getting there still needs reporting.
   */
  async run(input: string, events: AgentEvents = {}, options: RunOptions = {}): Promise<RunResult> {
    const task = () => this.runTurn(input, events, options);
    // A failed predecessor must not poison the queue for everyone behind it.
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  private async runTurn(
    input: string,
    events: AgentEvents,
    options: RunOptions
  ): Promise<RunResult> {
    const merged: RunOptions = { ...this.opts.defaults, ...options };
    const correlationId = merged.correlationId ?? randomUUID();
    const startedAt = Date.now();
    const toolCalls: AuditToolCall[] = [];
    let usage = emptyUsage();
    let rounds = 0;
    let text = "";
    /** Tool names offered to the model, for the prompt record. */
    let offeredTools: string[] = [];

    const finish = (stopReason: StopReason, error?: Error): RunResult => {
      this._usage = addUsage(this._usage, usage);
      this._lastUsedAt = Date.now();

      const structured =
        merged.responseFormat && stopReason === "end_turn"
          ? parseStructured(text, merged.responseFormat)
          : undefined;

      const result: RunResult = {
        text,
        stopReason,
        usage,
        rounds,
        toolCalls: toolCalls.map(stripAuditFields),
        correlationId,
        ...(error ? { error } : {}),
        ...(structured ? { structured } : {}),
      };

      this.opts.audit?.record({
        type: "turn",
        timestamp: new Date(startedAt).toISOString(),
        correlationId,
        sessionId: this.id,
        principal: auditPrincipal(this.principal),
        provider: this.provider.name,
        model: this.provider.currentModel,
        stopReason,
        rounds,
        usage,
        durationMs: Date.now() - startedAt,
        toolCalls,
        ...this.auditContent(input, text, offeredTools, correlationId),
        ...(error ? { error: error.message } : {}),
        ...(structured && !structured.ok ? { schemaError: structured.error } : {}),
      });

      if (error) events.onError?.(error);
      return result;
    };

    if (this._closed) {
      return finish("error", new Error(`Session ${this.id} is closed`));
    }
    if (this._turns >= this.maxTurns) {
      return finish(
        "error",
        new Error(`Session ${this.id} reached its turn cap (${this.maxTurns})`)
      );
    }
    this._turns++;

    const maxToolRounds = merged.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const deadline = merged.deadlineMs ? startedAt + merged.deadlineMs : undefined;

    // One controller fans the run's cancellation out to the provider call and
    // every tool call, and carries the deadline too.
    const controller = new AbortController();
    const abortOuter = () => controller.abort();
    if (merged.signal) {
      if (merged.signal.aborted) controller.abort();
      else merged.signal.addEventListener("abort", abortOuter, { once: true });
    }
    const deadlineTimer = deadline
      ? setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()))
      : undefined;

    const cleanup = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      merged.signal?.removeEventListener("abort", abortOuter);
    };

    try {
      this.append({ role: "user", content: buildUserContent(input, merged.images) });

      while (rounds < maxToolRounds) {
        // Every limit is checked *before* the next provider call. Checking
        // after would mean paying for the call that broke the budget, which
        // defeats the purpose of having one.
        if (merged.signal?.aborted) return finish("cancelled");
        if (deadline && Date.now() >= deadline) return finish("deadline_exceeded");
        if (merged.tokenBudget !== undefined && usage.totalTokens >= merged.tokenBudget) {
          return finish("budget_exhausted");
        }

        rounds++;

        const definitions = this.tools.getDefinitions();
        offeredTools = definitions.map((d) => d.name);
        let chatResult;
        try {
          chatResult = await this.provider.chat(this.messages, {
            tools: definitions.length ? definitions : undefined,
            onDelta: events.onDelta,
            signal: controller.signal,
            maxTokens: merged.maxTokens,
            system: this.getSystem(),
            cacheBreakpoints: this.opts.cacheBreakpoints,
            responseFormat: merged.responseFormat,
            thinking: this.opts.thinking,
            effort: this.opts.effort,
          });
        } catch (err) {
          // An abort surfaces from the transport as a throw; classify it by
          // *why* we aborted rather than reporting a generic failure.
          if (controller.signal.aborted) {
            if (merged.signal?.aborted) return finish("cancelled");
            if (deadline && Date.now() >= deadline) return finish("deadline_exceeded");
          }
          const error = err instanceof Error ? err : new Error(String(err));
          return finish("error", error);
        }

        const { message, usage: turnUsage, stopReason: providerStop } = chatResult;
        usage = addUsage(usage, turnUsage);
        this.opts.stats?.record(turnUsage);
        this.append(message);

        const messageText = getTextContent(message);
        if (messageText) text = messageText;

        if (providerStop === "refusal") return finish("refusal");
        if (providerStop === "max_tokens") {
          // Worth its own stop reason: on Anthropic models `max_tokens` covers
          // thinking plus visible output, so a truncated answer looks like a
          // complete one unless the caller is told.
          return finish("max_tokens");
        }

        if (!message.toolCalls?.length) return finish("end_turn");

        for (const call of message.toolCalls) {
          const outcome = await this.runToolCall(call, {
            events,
            correlationId,
            round: rounds,
            signal: controller.signal,
            timeoutMs: merged.toolTimeoutMs,
            startedAt,
          });
          toolCalls.push(outcome.audit);
          this.append({ role: "tool", content: outcome.content, toolCallId: call.id });
        }
      }

      return finish("max_tool_rounds");
    } finally {
      cleanup();
    }
  }

  private async runToolCall(
    call: ToolCall,
    ctx: {
      events: AgentEvents;
      correlationId: string;
      round: number;
      signal: AbortSignal;
      timeoutMs?: number;
      /** Turn start, for the record's timestamp. */
      startedAt: number;
    }
  ): Promise<{ content: string; audit: AuditToolCall }> {
    const startedAt = Date.now();
    let args = call.arguments;

    /**
     * Emit the per-call record now rather than waiting for the turn summary.
     *
     * A turn can run for minutes across many rounds; batching means nothing is
     * observable while it happens, and a crash mid-turn loses every call it had
     * already made — which is precisely the window worth having a trail for.
     */
    const emit = (entry: AuditToolCall) => {
      if (!this.auditPolicy.perToolCall) return;
      this.opts.audit?.record({
        type: "tool_call",
        timestamp: new Date().toISOString(),
        correlationId: ctx.correlationId,
        sessionId: this.id,
        principal: auditPrincipal(this.principal),
        provider: this.provider.name,
        model: this.provider.currentModel,
        round: ctx.round,
        call: entry,
      });
    };

    ctx.events.onToolCall?.(call.name, args, call.id);
    this.opts.stats?.recordToolCall();

    // The gate sits between the notification and execution. Previously
    // `onToolCall` fired and `execute` then ran regardless, so there was no way
    // to reject a call at all.
    if (this.opts.policy) {
      let decision;
      try {
        decision = await this.opts.policy.check(
          { ...call, arguments: args },
          {
            sessionId: this.id,
            round: ctx.round,
            correlationId: ctx.correlationId,
            principal: this.principal,
          }
        );
      } catch (err) {
        // A policy that throws must fail closed. Falling open would turn a bug
        // in the policy into an ungated tool call.
        const msg = err instanceof Error ? err.message : String(err);
        decision = { action: "deny" as const, reason: `policy error: ${msg}` };
      }

      if (decision.action === "deny") {
        const content =
          `Tool call rejected by policy: ${decision.reason}. ` +
          `Adjust your approach or explain to the user why this cannot be done.`;
        ctx.events.onToolDenied?.(call.name, call.id, decision.reason);
        ctx.events.onToolResult?.(call.name, {
          toolCallId: call.id,
          content,
          isError: true,
        });

        const audit = auditToolCall(
          this.auditPolicy,
          { ...call, arguments: args },
          {
            isError: true,
            denied: true,
            denyReason: decision.reason,
            result: content,
            durationMs: Date.now() - startedAt,
            source: this.tools.sourceOf(call.name),
          },
          { sessionId: this.id, correlationId: ctx.correlationId }
        );
        emit(audit);
        return { content, audit };
      }

      if (decision.action === "rewrite") args = decision.arguments;
    }

    const result = await this.tools.execute(
      { ...call, arguments: args },
      {
        signal: ctx.signal,
        correlationId: ctx.correlationId,
        sessionId: this.id,
        timeoutMs: ctx.timeoutMs,
      }
    );
    ctx.events.onToolResult?.(call.name, result);

    const audit = auditToolCall(
      this.auditPolicy,
      { ...call, arguments: args },
      {
        isError: Boolean(result.isError),
        result: result.content,
        durationMs: Date.now() - startedAt,
        source: this.tools.sourceOf(call.name),
      },
      { sessionId: this.id, correlationId: ctx.correlationId }
    );
    emit(audit);

    return { content: result.content, audit };
  }

  /**
   * The prompt and response fields for a turn record, at the configured level.
   *
   * Returns an empty object at `metadata`, so a deployment that has not opted
   * in never has prompt text pass through an audit sink at all.
   */
  private auditContent(
    input: string,
    response: string,
    offeredTools: string[],
    correlationId: string
  ): { prompt?: AuditPrompt; response?: string } {
    if (!this.auditPolicy.recordsContent) return {};

    const ctx = { sessionId: this.id, correlationId };
    const system = this.systemPrompt;

    const prompt: AuditPrompt = {
      ...(system ? { system: this.auditPolicy.text(system, { ...ctx, field: "system" }) } : {}),
      input: this.auditPolicy.text(input, { ...ctx, field: "input" }),
      ...(offeredTools.length ? { tools: offeredTools } : {}),
      ...(this.auditPolicy.recordsMessages
        ? { messages: this.messages.map((m) => this.auditPolicy.message(m, ctx)) }
        : {}),
    };

    return {
      prompt,
      response: this.auditPolicy.text(response, { ...ctx, field: "response" }),
    };
  }

  private append(message: Message): void {
    this.messages.push(message);
    this.trimHistory();
  }

  /**
   * Enforce the message cap.
   *
   * Drops whole turn groups from the front rather than individual messages: a
   * `tool` message separated from the `assistant` message carrying its
   * `tool_calls` is a request most providers reject outright, so trimming has
   * to respect that pairing.
   */
  private trimHistory(): void {
    if (this.messages.length <= this.maxMessages) return;

    while (this.messages.length > this.maxMessages) {
      // Find the start of the second turn group and drop everything before it.
      let next = -1;
      for (let i = 1; i < this.messages.length; i++) {
        if (this.messages[i].role === "user") {
          next = i;
          break;
        }
      }
      if (next <= 0) {
        // No further group boundary — a single oversized group. Keep the tail.
        this.messages = this.messages.slice(this.messages.length - this.maxMessages);
        return;
      }
      this.messages = this.messages.slice(next);
    }
  }
}

function buildUserContent(input: string, images?: string[]): string | ContentPart[] {
  if (!images?.length) return input;
  return [
    { type: "text", text: input } as const,
    ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
  ];
}

function stripAuditFields(entry: AuditToolCall): RunToolCall {
  const { id, name, isError, denied, durationMs } = entry;
  return { id, name, isError, ...(denied ? { denied } : {}), durationMs };
}
