import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig, ToolPlugin } from "./types.js";

export type McpState = "connecting" | "connected" | "disconnected" | "failed";

export type McpStateListener = (server: string, state: McpState, reason?: string) => void;

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

interface ServerEntry {
  config: McpServerConfig;
  client?: Client;
  state: McpState;
  reason?: string;
  attempts: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  /** Set once `disconnectAll` has run, so a pending retry does not resurrect it. */
  shuttingDown: boolean;
}

/** Manages connections to MCP servers and exposes their tools as plugins */
export class McpManager {
  private servers = new Map<string, ServerEntry>();
  private listeners: McpStateListener[] = [];

  /**
   * Observe connection state.
   *
   * The agent uses this to flip a server's tools between available and
   * unavailable, so a dropped connection is visible to the model rather than
   * silently shrinking the tool list.
   */
  onStateChange(listener: McpStateListener): void {
    this.listeners.push(listener);
  }

  state(server: string): McpState | undefined {
    return this.servers.get(server)?.state;
  }

  /** Every server's current state, for a health endpoint. */
  states(): Record<string, { state: McpState; reason?: string }> {
    const out: Record<string, { state: McpState; reason?: string }> = {};
    for (const [name, entry] of this.servers) {
      out[name] = { state: entry.state, ...(entry.reason ? { reason: entry.reason } : {}) };
    }
    return out;
  }

  async connect(config: McpServerConfig): Promise<ToolPlugin[]> {
    if (config.transport === "stdio" && process.env.MICROAGENT_DISALLOW_STDIO_MCP === "true") {
      // `StdioClientTransport` spawns a child process. In a hardened pod with a
      // read-only root filesystem and dropped capabilities that is the wrong
      // shape; HTTP to a sidecar fits better, so a deployment can forbid it.
      throw new Error(
        `MCP server "${config.name}": stdio transport is disallowed here (MICROAGENT_DISALLOW_STDIO_MCP). Use the http transport.`
      );
    }

    const entry: ServerEntry = this.servers.get(config.name) ?? {
      config,
      state: "connecting",
      attempts: 0,
      shuttingDown: false,
    };
    entry.config = config;
    entry.shuttingDown = false;
    this.servers.set(config.name, entry);

    const client = await this.open(entry);

    const { tools } = await this.withTimeout(
      client.listTools(),
      config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      `MCP server "${config.name}": listing tools timed out`
    );

    return tools.map((tool): ToolPlugin => ({
      definition: {
        name: `${config.name}__${tool.name}`,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema as Record<string, unknown>,
      },
      execute: async (args) => {
        // Resolved at call time, not captured: after a reconnect the entry
        // holds a different `Client`, and a captured one would be a dead
        // handle that fails every call until the process restarts.
        const current = this.servers.get(config.name);
        if (!current?.client || current.state !== "connected") {
          throw new Error(
            `MCP server "${config.name}" is ${current?.state ?? "unknown"}` +
              (current?.reason ? `: ${current.reason}` : "")
          );
        }

        const result = await current.client.callTool({ name: tool.name, arguments: args });
        const text = (result.content as Array<{ text?: string }> | undefined)
          ?.map((c) => c.text ?? "")
          .join("\n") ?? "";
        if (result.isError) throw new Error(text);
        return text;
      },
    }));
  }

  private async open(entry: ServerEntry): Promise<Client> {
    const config = entry.config;
    const timeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.setState(entry, "connecting");

    const client = new Client({ name: "microagent", version: "0.1.0" });

    let transport;
    if (config.transport === "stdio") {
      if (!config.command) throw new Error(`MCP server "${config.name}": stdio requires command`);
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
      });
    } else {
      if (!config.url) throw new Error(`MCP server "${config.name}": http requires url`);
      transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
    }

    // A hanging stdio server would otherwise block startup indefinitely — the
    // SDK's connect has no timeout of its own.
    await this.withTimeout(
      client.connect(transport),
      timeoutMs,
      `MCP server "${config.name}": connect timed out after ${timeoutMs}ms`
    );

    client.onclose = () => {
      const current = this.servers.get(config.name);
      if (!current || current.shuttingDown) return;
      this.setState(current, "disconnected", "connection closed");
      this.scheduleReconnect(current);
    };

    entry.client = client;
    entry.attempts = 0;
    this.setState(entry, "connected");
    return client;
  }

  /**
   * Reconnect with exponential backoff.
   *
   * Without this a server that dies is gone for the process lifetime. Backoff
   * rather than a tight retry so a server that is down for maintenance is not
   * hammered, and a bounded attempt count so a permanently dead server settles
   * into `failed` instead of retrying forever.
   */
  private scheduleReconnect(entry: ServerEntry): void {
    const policy = entry.config.reconnect ?? {};
    if (policy.enabled === false) {
      this.setState(entry, "failed", "reconnection disabled");
      return;
    }

    const maxAttempts = policy.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (entry.attempts >= maxAttempts) {
      this.setState(entry, "failed", `gave up after ${maxAttempts} reconnect attempts`);
      return;
    }

    const initial = policy.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    const max = policy.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    const delay = Math.min(max, initial * 2 ** entry.attempts);
    entry.attempts++;

    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = undefined;
      if (entry.shuttingDown) return;
      void this.open(entry).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.setState(entry, "disconnected", msg);
        this.scheduleReconnect(entry);
      });
    }, delay);
    entry.retryTimer.unref?.();
  }

  private setState(entry: ServerEntry, state: McpState, reason?: string): void {
    entry.state = state;
    entry.reason = reason;
    for (const listener of this.listeners) {
      try {
        listener(entry.config.name, state, reason);
      } catch {
        // A misbehaving listener must not break connection handling.
      }
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async disconnectAll(): Promise<void> {
    for (const entry of this.servers.values()) {
      entry.shuttingDown = true;
      if (entry.retryTimer) {
        clearTimeout(entry.retryTimer);
        entry.retryTimer = undefined;
      }
      if (entry.client) {
        entry.client.onclose = undefined;
        await entry.client.close().catch(() => {});
      }
    }
    this.servers.clear();
    this.listeners = [];
  }
}
