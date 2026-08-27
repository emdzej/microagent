import type {
  LLMProvider,
  Message,
  MicroagentConfig,
  Principal,
  ProviderConfig,
  ProviderModelInfo,
  RunOptions,
  RunResult,
  SessionLimits,
  ToolPolicy,
} from "./types.js";
import { resolveProviders, resolveActiveProvider } from "./types.js";
import { ToolRegistry } from "./tool-registry.js";
import { McpManager } from "./mcp.js";
import { UsageStats } from "./stats.js";
import { createProvider } from "./providers/factory.js";
import { Session } from "./session.js";
import type { AgentEvents, SessionOptions } from "./session.js";
import type { AuditOptions, AuditRedactor, AuditSink } from "./audit.js";
import { NullAuditSink } from "./audit.js";

export type { AgentEvents } from "./session.js";

const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

export class SessionCapError extends Error {
  constructor(limit: number) {
    super(`Session cap reached (${limit}). Close an existing session first.`);
    this.name = "SessionCapError";
  }
}

/**
 * Shared resources and a session factory.
 *
 * Providers, the tool registry and MCP connections live here because they are
 * shared and stateless per turn. Conversation state does not: it lives in
 * `Session`, one per caller. See the comment on `Session` for why that split is
 * a correctness requirement rather than a tidiness preference.
 */
export class Agent {
  private _provider: LLMProvider;
  private _providers: Map<string, LLMProvider> = new Map();
  private _providerConfigs: ProviderConfig[];
  readonly tools: ToolRegistry;
  readonly mcp: McpManager;
  readonly stats: UsageStats;

  private sessions = new Map<string, Session>();
  private defaultSession?: Session;
  private sweepTimer?: ReturnType<typeof setInterval>;

  private readonly systemPrompt?: string;
  private readonly limits: Required<Omit<SessionLimits, "sweepIntervalMs">> & {
    sweepIntervalMs: number;
  };
  private policy?: ToolPolicy;
  private audit: AuditSink = new NullAuditSink();
  private auditOptions: AuditOptions;

  constructor(config: MicroagentConfig) {
    this.tools = new ToolRegistry();
    this.mcp = new McpManager();
    this.stats = new UsageStats();
    this.systemPrompt = config.systemPrompt;
    this.auditOptions = {
      level: config.audit?.level,
      maxFieldChars: config.audit?.maxFieldChars,
      perToolCall: config.audit?.perToolCall,
    };

    this.limits = {
      maxSessions: config.sessions?.maxSessions ?? DEFAULT_MAX_SESSIONS,
      ttlMs: config.sessions?.ttlMs ?? DEFAULT_TTL_MS,
      maxTurnsPerSession: config.sessions?.maxTurnsPerSession ?? 100,
      maxMessagesPerSession: config.sessions?.maxMessagesPerSession ?? 2000,
      sweepIntervalMs: config.sessions?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
    };

    this._providerConfigs = resolveProviders(config);
    const activeConfig = resolveActiveProvider(config);

    // Create all providers eagerly
    for (const pc of this._providerConfigs) {
      const name = pc.name ?? pc.type;
      this._providers.set(name, createProvider(pc));
    }

    this._provider = this._providers.get(activeConfig.name ?? activeConfig.type)!;
  }

  /** The currently active provider */
  get provider(): LLMProvider {
    return this._provider;
  }

  /** All configured provider names */
  get providerNames(): string[] {
    return Array.from(this._providers.keys());
  }

  /** Get a provider by name */
  getProvider(name: string): LLMProvider | undefined {
    return this._providers.get(name);
  }

  /** Get all provider configs */
  get providerConfigs(): readonly ProviderConfig[] {
    return this._providerConfigs;
  }

  /** Install a gate in front of every tool call, for every session. */
  setToolPolicy(policy: ToolPolicy | undefined): void {
    this.policy = policy;
  }

  /** Where audit records go. Defaults to discarding them. */
  setAuditSink(sink: AuditSink, options?: AuditOptions): void {
    this.audit = sink;
    if (options) this.auditOptions = { ...this.auditOptions, ...options };
  }

  /**
   * Scrub text before it reaches the audit sink.
   *
   * Separate from `setAuditSink` because it is the piece a deployment is most
   * likely to supply on its own: what counts as a secret — which token formats,
   * which customer identifiers — is domain knowledge, and only matters once
   * `audit.level` is above `metadata`.
   */
  setAuditRedactor(redact: AuditRedactor | undefined): void {
    this.auditOptions = { ...this.auditOptions, redact };
  }

  /**
   * Switch model. Supports:
   * - "provider/model" — switch provider and model
   * - "model" — switch model on current provider, or find provider that has it
   */
  setModel(modelSpec: string): { provider: string; model: string } {
    if (modelSpec.includes("/")) {
      const [provName, ...rest] = modelSpec.split("/");
      const model = rest.join("/");
      const prov = this._providers.get(provName);
      if (!prov)
        throw new Error(
          `Unknown provider: ${provName}. Available: ${this.providerNames.join(", ")}`
        );
      this._provider = prov;
      prov.setModel(model);
      return { provider: provName, model };
    }
    // Just a model name — set on current provider
    this._provider.setModel(modelSpec);
    return { provider: this._provider.name, model: modelSpec };
  }

  /** List models from ALL configured providers */
  async listAllModels(): Promise<ProviderModelInfo[]> {
    const results: ProviderModelInfo[] = [];
    const entries = Array.from(this._providers.entries());
    const settled = await Promise.allSettled(
      entries.map(async ([name, prov]) => {
        const models = await prov.listModels();
        return models.map((m) => ({ ...m, provider: name }));
      })
    );
    for (const result of settled) {
      if (result.status === "fulfilled") {
        results.push(...result.value);
      }
    }
    return results;
  }

  /** Initialize MCP servers and register their tools */
  async init(mcpServers?: MicroagentConfig["mcpServers"]): Promise<void> {
    if (!mcpServers?.length) return;
    for (const server of mcpServers) {
      try {
        const plugins = await this.mcp.connect(server);
        for (const plugin of plugins) {
          // Namespaced by server in `McpManager`, and a residual collision
          // (two servers configured under the same name, or a clash with a
          // built-in) now raises rather than silently shadowing.
          this.tools.register(plugin, { source: server.name, onConflict: "error" });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to connect MCP server "${server.name}": ${msg}`);
      }
    }

    // A server that dies later leaves its tools registered but unavailable, so
    // the model is told the capability is offline instead of silently seeing a
    // shorter tool list and working around the gap.
    this.mcp.onStateChange((name, state, reason) => {
      this.tools.setSourceAvailability(name, state === "connected", reason);
    });
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  /**
   * Create a conversation.
   *
   * @throws {SessionCapError} when the session cap is reached. Evicting an
   * arbitrary live session to make room would drop someone else's work, so the
   * caller is told instead.
   */
  createSession(options: SessionOptions = {}): Session {
    this.sweep();

    if (this.sessions.size >= this.limits.maxSessions) {
      throw new SessionCapError(this.limits.maxSessions);
    }

    // `...options` first, then the resolved values. The other order looks
    // equivalent but is not: a caller that passes an explicitly-undefined key —
    // `{ systemPrompt: request.body?.systemPrompt }` is the common shape —
    // would overwrite the resolved default with undefined.
    const session = new Session(options.provider ?? this._provider, this.tools, {
      ...options,
      systemPrompt: options.systemPrompt ?? this.systemPrompt,
      policy: options.policy ?? this.policy,
      audit: options.audit ?? this.audit,
      auditOptions: { ...this.auditOptions, ...options.auditOptions },
      stats: options.stats ?? this.stats,
      limits: {
        maxTurns: options.limits?.maxTurns ?? this.limits.maxTurnsPerSession,
        maxMessages: options.limits?.maxMessages ?? this.limits.maxMessagesPerSession,
      },
    });

    this.sessions.set(session.id, session);
    this.startSweeping();
    return session;
  }

  getSession(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (this.isExpired(session)) {
      this.closeSession(id);
      return undefined;
    }
    return session;
  }

  /**
   * Look a session up on behalf of a caller.
   *
   * Returns `undefined` for a session owned by someone else, deliberately not
   * distinguishing "not yours" from "does not exist" — telling a caller that
   * some other subject's session id is valid is itself a small leak.
   */
  getSessionFor(id: string, principal?: Principal): Session | undefined {
    const session = this.getSession(id);
    if (!session) return undefined;
    const owner = session.principal?.subject;
    if (owner !== principal?.subject) return undefined;
    return session;
  }

  closeSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.close();
    this.sessions.delete(id);
    if (this.defaultSession?.id === id) this.defaultSession = undefined;
  }

  listSessions(principal?: Principal): Session[] {
    this.sweep();
    const all = Array.from(this.sessions.values());
    if (!principal) return all;
    return all.filter((s) => s.principal?.subject === principal.subject);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  countSessionsFor(principal: Principal): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.principal?.subject === principal.subject) count++;
    }
    return count;
  }

  private isExpired(session: Session): boolean {
    if (this.limits.ttlMs <= 0) return false;
    return Date.now() - session.lastUsedAt > this.limits.ttlMs;
  }

  /** Drop idle sessions. Called opportunistically and on a timer. */
  sweep(): number {
    let evicted = 0;
    for (const [id, session] of this.sessions) {
      if (this.isExpired(session)) {
        session.close();
        this.sessions.delete(id);
        if (this.defaultSession?.id === id) this.defaultSession = undefined;
        evicted++;
      }
    }
    return evicted;
  }

  private startSweeping(): void {
    if (this.sweepTimer || this.limits.sweepIntervalMs <= 0) return;
    this.sweepTimer = setInterval(() => this.sweep(), this.limits.sweepIntervalMs);
    // Unreferenced so a short-lived CLI process is not held open by the timer.
    this.sweepTimer.unref?.();
  }

  // ── Legacy single-conversation API ───────────────────────────────────────

  /**
   * The implicit conversation behind `run()`.
   *
   * Exists so the CLI, which really does have exactly one conversation, keeps
   * working unchanged. Server callers should create their own session.
   */
  private ensureDefaultSession(): Session {
    if (!this.defaultSession || this.defaultSession.closed) {
      this.defaultSession = this.createSession({ metadata: { implicit: true } });
    }
    return this.defaultSession;
  }

  /**
   * Run one user turn against the implicit default session.
   *
   * Kept returning `Promise<string>`, and still rejecting when the provider
   * fails, so existing callers are unaffected. Use `runDetailed` or a session
   * directly when you need the stop reason — a caller that only gets a string
   * cannot tell a finished answer from a truncated one.
   */
  async run(
    userMessage: string,
    events: AgentEvents = {},
    images?: string[]
  ): Promise<string> {
    const result = await this.runDetailed(userMessage, events, { images });
    if (result.stopReason === "error" && result.error) throw result.error;
    if (result.stopReason === "max_tool_rounds" && !result.text) {
      return "[max tool rounds reached]";
    }
    return result.text;
  }

  /** As `run`, but with the typed outcome. */
  async runDetailed(
    userMessage: string,
    events: AgentEvents = {},
    options: RunOptions = {}
  ): Promise<RunResult> {
    return this.ensureDefaultSession().run(userMessage, events, options);
  }

  getMessages(): readonly Message[] {
    return this.defaultSession?.getMessages() ?? [];
  }

  async shutdown(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.defaultSession = undefined;
    await this.mcp.disconnectAll();
  }
}
