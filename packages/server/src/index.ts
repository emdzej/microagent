import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import type { Agent, StreamDelta, ToolResult, MicroagentConfig } from "@microagent/core";
import { Agent as AgentClass } from "@microagent/core";

export interface ServerOptions {
  host?: string;
  port?: number;
  /** Provide an existing agent, or pass config to create one */
  agent?: Agent;
  config?: MicroagentConfig;
  /** Path to static files directory (built web UI) */
  staticDir?: string;
}

export async function createServer(opts: ServerOptions) {
  const agent = opts.agent ?? new AgentClass(opts.config!);

  const app = Fastify({ logger: true });
  await app.register(cors);

  // ── Serve static web UI if configured ──────────────────────────
  if (opts.staticDir) {
    await app.register(fastifyStatic, {
      root: opts.staticDir,
      prefix: "/",
      wildcard: false,
    });
    // SPA fallback — serve index.html for unmatched routes
    app.setNotFoundHandler(async (_req, reply) => {
      return reply.sendFile("index.html");
    });
  }

  // ── Health ──────────────────────────────────────────────────────
  app.get("/health", async () => ({
    status: "ok",
    provider: agent.provider.name,
    tools: agent.tools.list().length,
    uptime: process.uptime(),
  }));

  // ── List tools ─────────────────────────────────────────────────
  app.get("/tools", async () => ({
    tools: agent.tools.getDefinitions(),
  }));

  // ── Stats ──────────────────────────────────────────────────────
  app.get("/stats", async () => agent.stats.summary);

  // ── List available models ──────────────────────────────────────
  app.get("/models", async () => {
    const models = await agent.provider.listModels();
    return { models };
  });

  // ── Chat (non-streaming) ───────────────────────────────────────
  app.post<{ Body: { message: string } }>("/chat", {
    schema: {
      body: {
        type: "object",
        required: ["message"],
        properties: { message: { type: "string" } },
      },
    },
  }, async (request) => {
    const { message } = request.body;
    const toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string; isError?: boolean }> = [];

    const response = await agent.run(message, {
      onToolCall(name, args) {
        toolCalls.push({ name, args, result: "" });
      },
      onToolResult(name, result: ToolResult) {
        const last = [...toolCalls].reverse().find((t) => t.name === name);
        if (last) {
          last.result = result.content;
          last.isError = result.isError;
        }
      },
    });

    return {
      response,
      toolCalls,
      stats: agent.stats.summary,
    };
  });

  // ── Chat SSE (streaming) ───────────────────────────────────────
  app.post<{ Body: { message: string } }>("/chat/stream", {
    schema: {
      body: {
        type: "object",
        required: ["message"],
        properties: { message: { type: "string" } },
      },
    },
  }, async (request, reply) => {
    const { message } = request.body;

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const response = await agent.run(message, {
        onDelta(delta: StreamDelta) {
          send("delta", delta);
        },
        onToolCall(name: string, args: Record<string, unknown>) {
          send("tool_call", { name, args });
        },
        onToolResult(name: string, result: ToolResult) {
          send("tool_result", { name, content: result.content, isError: result.isError });
        },
      });

      send("complete", { response, stats: agent.stats.summary });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      send("error", { error: msg });
    }

    reply.raw.end();
  });

  return { app, agent };
}

export async function startServer(opts: ServerOptions): Promise<void> {
  const { app, agent } = await createServer(opts);
  await agent.init(opts.config?.mcpServers);

  const host = opts.host ?? "0.0.0.0";
  const port = opts.port ?? 3100;

  await app.listen({ host, port });
  console.log(`microagent server listening on http://${host}:${port}`);

  const shutdown = async () => {
    await app.close();
    await agent.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
