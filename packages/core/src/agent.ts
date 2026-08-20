import type { LLMProvider, Message, StreamDelta, MicroagentConfig, ToolResult, ContentPart, ProviderConfig, ProviderModelInfo } from "./types.js";
import { getTextContent, resolveProviders, resolveActiveProvider } from "./types.js";
import { ToolRegistry } from "./tool-registry.js";
import { McpManager } from "./mcp.js";
import { UsageStats } from "./stats.js";
import { createProvider } from "./providers/factory.js";

export interface AgentEvents {
  onDelta?: (delta: StreamDelta) => void;
  /**
   * A tool is about to run. `id` is the tool call's id — use it to pair this
   * call with its `onToolResult`.
   *
   * Pairing on `name` alone is ambiguous when a turn invokes the same tool more
   * than once. It happens to work today only because tool calls are executed
   * strictly sequentially; it breaks as soon as they are not.
   */
  onToolCall?: (name: string, args: Record<string, unknown>, id: string) => void;
  onToolResult?: (name: string, result: ToolResult) => void;
  onError?: (error: Error) => void;
}

/** The core agent loop — sends messages, executes tools, loops until done */
export class Agent {
  private _provider: LLMProvider;
  private _providers: Map<string, LLMProvider> = new Map();
  private _providerConfigs: ProviderConfig[];
  readonly tools: ToolRegistry;
  readonly mcp: McpManager;
  readonly stats: UsageStats;
  private messages: Message[] = [];
  private maxToolRounds = 20;
  /**
   * Tail of the queue of in-flight turns.
   *
   * `messages` is a single array shared by every caller, so two overlapping
   * `run()` calls would interleave their appends: a `tool` message can land
   * without the `assistant` message carrying its `tool_calls`, which most
   * providers then reject with a 400. Node's single thread does not help here —
   * the interleave happens across `await` points, not within them.
   *
   * Turns therefore queue instead of overlapping. This keeps one conversation
   * consistent; it does not give separate callers separate histories, which
   * would need a conversation-per-session redesign.
   */
  private turnQueue: Promise<unknown> = Promise.resolve();

  constructor(config: MicroagentConfig) {
    this.tools = new ToolRegistry();
    this.mcp = new McpManager();
    this.stats = new UsageStats();

    this._providerConfigs = resolveProviders(config);
    const activeConfig = resolveActiveProvider(config);

    // Create all providers eagerly
    for (const pc of this._providerConfigs) {
      const name = pc.name ?? pc.type;
      this._providers.set(name, createProvider(pc));
    }

    this._provider = this._providers.get(activeConfig.name ?? activeConfig.type)!;

    if (config.systemPrompt) {
      this.messages.push({ role: "system", content: config.systemPrompt });
    }
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
      if (!prov) throw new Error(`Unknown provider: ${provName}. Available: ${this.providerNames.join(", ")}`);
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
          this.tools.register(plugin);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to connect MCP server "${server.name}": ${msg}`);
      }
    }
  }

  /**
   * Run one user turn — may loop multiple times for tool calls.
   *
   * Turns are serialised: if one is already running, this waits for it rather
   * than interleaving into the shared message history. See `turnQueue`.
   */
  async run(userMessage: string, events: AgentEvents = {}, images?: string[]): Promise<string> {
    const run = this.turnQueue.then(
      () => this.runTurn(userMessage, events, images),
      // A failed predecessor must not poison the queue for everyone behind it.
      () => this.runTurn(userMessage, events, images)
    );
    // Keep the chain alive past a rejection, so one failed turn does not wedge
    // every later one.
    this.turnQueue = run.catch(() => {});
    return run;
  }

  private async runTurn(
    userMessage: string,
    events: AgentEvents,
    images?: string[]
  ): Promise<string> {
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
      const { message, usage } = await this._provider.chat(
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
        events.onToolCall?.(tc.name, tc.arguments, tc.id);

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

  async shutdown(): Promise<void> {
    await this.mcp.disconnectAll();
  }
}
