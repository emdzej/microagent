import type {
  ToolPlugin,
  ToolDefinition,
  ToolResult,
  ToolCall,
  ToolExecutionContext,
} from "./types.js";

/** What to do when a name is already taken. */
export type ConflictPolicy =
  /** Throw. The default — a collision is a configuration bug, not a preference. */
  | "error"
  /** Overwrite the existing entry. Only for callers that mean it. */
  | "replace"
  /** Keep the existing entry and drop the new one. */
  | "skip";

export interface RegisterOptions {
  /** Default `"error"`. */
  onConflict?: ConflictPolicy;
  /** Recorded for diagnostics — which MCP server or plugin set supplied this. */
  source?: string;
}

export class ToolCollisionError extends Error {
  constructor(
    readonly toolName: string,
    readonly existingSource: string | undefined,
    readonly incomingSource: string | undefined
  ) {
    const where = [existingSource, incomingSource].filter(Boolean).join(" and ");
    super(
      `Tool name "${toolName}" is already registered${where ? ` (from ${where})` : ""}. ` +
        `Rename one of them, or namespace the tools by server.`
    );
    this.name = "ToolCollisionError";
  }
}

interface Entry {
  plugin: ToolPlugin;
  source?: string;
  /**
   * Whether the tool can currently run. An MCP server that dies leaves its
   * tools registered but unavailable, so the model sees a clear "unavailable"
   * result instead of a silently shorter tool list.
   */
  available: boolean;
  unavailableReason?: string;
}

/** Default per-tool timeout. One hung server should not hang a run forever. */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

/** Central registry for all tools (built-in + MCP) */
export class ToolRegistry {
  private tools = new Map<string, Entry>();

  /**
   * Register a tool.
   *
   * Rejects a duplicate name by default. The previous behaviour was a silent
   * `Map.set`, which meant two tool sets exposing the same name would leave the
   * second quietly shadowing the first — the model then calls a tool belonging
   * to a different server, with no error and no warning to explain the result.
   *
   * @throws {ToolCollisionError} when the name is taken and `onConflict` is
   * `"error"`.
   */
  register(plugin: ToolPlugin, options: RegisterOptions = {}): void {
    const name = plugin.definition.name;
    const existing = this.tools.get(name);

    if (existing) {
      const policy = options.onConflict ?? "error";
      if (policy === "error") {
        throw new ToolCollisionError(name, existing.source, options.source);
      }
      if (policy === "skip") return;
    }

    this.tools.set(name, { plugin, source: options.source, available: true });
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): ToolPlugin | undefined {
    return this.tools.get(name)?.plugin;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Which tool set a name came from, for audit and error messages. */
  sourceOf(name: string): string | undefined {
    return this.tools.get(name)?.source;
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.plugin.definition);
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Mark a tool as usable or not.
   *
   * Keeping an unavailable tool in the list is deliberate. If a dead MCP
   * server's tools simply vanished, the model would see a shorter tool list and
   * quietly work around the gap — producing an answer that looks complete but
   * silently omits whatever that server was for. A failing call with a clear
   * reason lets it say so instead.
   */
  setAvailability(name: string, available: boolean, reason?: string): void {
    const entry = this.tools.get(name);
    if (!entry) return;
    entry.available = available;
    entry.unavailableReason = available ? undefined : reason;
  }

  /** Mark every tool from a source available or not, e.g. on MCP reconnect. */
  setSourceAvailability(source: string, available: boolean, reason?: string): number {
    let count = 0;
    for (const entry of this.tools.values()) {
      if (entry.source === source) {
        entry.available = available;
        entry.unavailableReason = available ? undefined : reason;
        count++;
      }
    }
    return count;
  }

  isAvailable(name: string): boolean {
    return this.tools.get(name)?.available ?? false;
  }

  /**
   * Execute a tool call.
   *
   * Never throws: a tool failure is a result the model can react to, so every
   * failure mode — unknown tool, unavailable tool, timeout, cancellation, a
   * throwing implementation — comes back as an `isError` result.
   */
  async execute(
    call: ToolCall,
    ctx: ToolExecutionContext & { timeoutMs?: number } = {}
  ): Promise<ToolResult> {
    const entry = this.tools.get(call.name);
    if (!entry) {
      return {
        toolCallId: call.id,
        content: `Unknown tool: ${call.name}. Available tools: ${this.list().join(", ") || "none"}`,
        isError: true,
      };
    }

    if (!entry.available) {
      return {
        toolCallId: call.id,
        content:
          `Tool "${call.name}" is currently unavailable` +
          (entry.unavailableReason ? `: ${entry.unavailableReason}` : "") +
          ". Do not retry it; tell the user this capability is offline if it matters to the answer.",
        isError: true,
      };
    }

    const timeoutMs = ctx.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    // A cancel that only stops the loop between rounds still waits out a hung
    // tool call, so the run's signal has to reach the tool itself.
    const onOuterAbort = () => controller.abort();
    if (ctx.signal) {
      if (ctx.signal.aborted) controller.abort();
      else ctx.signal.addEventListener("abort", onOuterAbort, { once: true });
    }

    try {
      const content = await entry.plugin.execute(call.arguments, {
        signal: controller.signal,
        correlationId: ctx.correlationId,
        sessionId: ctx.sessionId,
        toolCallId: call.id,
      });
      return { toolCallId: call.id, content };
    } catch (err) {
      if (timedOut) {
        return {
          toolCallId: call.id,
          content: `Tool "${call.name}" timed out after ${timeoutMs}ms`,
          isError: true,
        };
      }
      if (ctx.signal?.aborted) {
        return { toolCallId: call.id, content: `Tool "${call.name}" was cancelled`, isError: true };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { toolCallId: call.id, content: `Tool error: ${msg}`, isError: true };
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onOuterAbort);
    }
  }
}
