import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import type {
  Agent,
  AuditRedactor,
  AuditSink,
  MicroagentConfig,
  Principal,
  ResponseFormat,
  RunResult,
  Session,
  StreamDelta,
  ToolPolicy,
  ToolResult,
} from "@microagent/core";
import {
  Agent as AgentClass,
  JsonAuditSink,
  NullAuditSink,
  isAuthEnabled,
  persistModel,
} from "@microagent/core";
import { AuthError, Verifier, allowAuthenticated, scopeAuthorizer } from "./auth.js";
import type { Authorize } from "./auth.js";
import { ROUTE_SCOPES, buildDiscoveryDocument } from "./discovery.js";
import { PrincipalRateLimiter } from "./limits.js";

export { Verifier, AuthError, allowAuthenticated, scopeAuthorizer } from "./auth.js";
export type { Authorize, AuthorizeDecision, AuthorizeRequest, IdpEndpoints } from "./auth.js";
export {
  buildDiscoveryDocument,
  MICROAGENT_SCOPES,
  ALL_MICROAGENT_SCOPES,
  ROUTE_SCOPES,
} from "./discovery.js";
export type { MicroagentDiscoveryDocument } from "./discovery.js";
export { PrincipalRateLimiter } from "./limits.js";

export interface ServerOptions {
  host?: string;
  port?: number;
  /** Provide an existing agent, or pass config to create one */
  agent?: Agent;
  config?: MicroagentConfig;
  /** Resolved config file path for persistence */
  configPath?: string | null;
  /** Path to static files directory (built web UI) */
  staticDir?: string;
  /**
   * Pre-built verifier. Normally left unset — the server builds one from
   * `config.auth.oidc`. Injected by tests against a mock JWKS.
   */
  verifier?: Verifier;
  /**
   * Authorisation policy. Defaults to scope checks per route when auth is on.
   * Replace it to enforce deployment-specific rules (environments, namespaces).
   */
  authorize?: Authorize;
  /** Gate in front of every tool call. */
  toolPolicy?: ToolPolicy;
  /** Where audit records go. Defaults to JSON on stdout. */
  auditSink?: AuditSink;
  /**
   * Scrub prompt and tool text before it is recorded. Only takes effect once
   * `config.audit.level` is above `metadata`.
   */
  auditRedactor?: AuditRedactor;
  /** Request logging. Defaults on. */
  logger?: boolean;
}

/** Routes that must work before a caller has a token. */
const PUBLIC_ROUTES = new Set(["/health", "/.well-known/microagent-config"]);

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

interface RunBody {
  message: string;
  images?: string[];
  maxToolRounds?: number;
  tokenBudget?: number;
  deadlineMs?: number;
  toolTimeoutMs?: number;
  maxTokens?: number;
  responseFormat?: ResponseFormat;
}

const runBodySchema = {
  type: "object",
  required: ["message"],
  properties: {
    message: { type: "string" },
    images: { type: "array", items: { type: "string" } },
    maxToolRounds: { type: "integer", minimum: 1, maximum: 200 },
    tokenBudget: { type: "integer", minimum: 1 },
    deadlineMs: { type: "integer", minimum: 1 },
    toolTimeoutMs: { type: "integer", minimum: 1 },
    maxTokens: { type: "integer", minimum: 1 },
    responseFormat: { type: "object", additionalProperties: true },
  },
} as const;

export async function createServer(opts: ServerOptions) {
  const agent = opts.agent ?? new AgentClass(opts.config!);
  const config = opts.config ?? {};

  if (opts.toolPolicy) agent.setToolPolicy(opts.toolPolicy);

  // Auditing defaults on for the server — an HTTP-reachable agent needs a
  // trail — but at `metadata` level, so no prompt or tool text is recorded
  // until a deployment asks for it.
  const auditEnabled = config.audit?.enabled ?? true;
  agent.setAuditSink(
    auditEnabled ? (opts.auditSink ?? new JsonAuditSink()) : new NullAuditSink()
  );
  if (opts.auditRedactor) agent.setAuditRedactor(opts.auditRedactor);

  // Auth is on whenever an issuer is configured. A deployment can only lose
  // authentication by asking for it (`auth.enabled: false`), never by
  // forgetting a flag.
  const authEnabled = isAuthEnabled(config);
  const verifier =
    opts.verifier ??
    (authEnabled && config.auth?.oidc ? await Verifier.create(config.auth.oidc) : undefined);

  if (authEnabled && !verifier) {
    throw new Error("auth is enabled but no OIDC verifier could be built");
  }
  if (!verifier) {
    console.warn(
      "microagent: AUTH DISABLED — every route is open and all callers share one anonymous identity. Do not expose this to an untrusted network."
    );
  }

  const authorize: Authorize =
    opts.authorize ?? (verifier ? scopeAuthorizer(ROUTE_SCOPES) : allowAuthenticated);
  const limiter = new PrincipalRateLimiter(config.limits ?? {});

  const app = Fastify({ logger: opts.logger ?? true });
  await app.register(cors);

  // ── Authentication and authorisation ───────────────────────────
  app.addHook("onRequest", async (request, reply) => {
    const routePath = request.routeOptions?.url ?? request.url;
    if (PUBLIC_ROUTES.has(routePath)) return;
    // The SPA and its assets are served by @fastify/static; gating them behind
    // a bearer token would leave the login UI unreachable.
    if (opts.staticDir && !isApiRoute(routePath)) return;

    if (!verifier) {
      request.principal = anonymousPrincipal();
      return;
    }

    let principal: Principal;
    try {
      principal = await verifier.authenticate(request.headers.authorization);
    } catch (err) {
      const status = err instanceof AuthError ? err.status : 401;
      const message = err instanceof Error ? err.message : "unauthenticated";
      return reply.code(status).send({ error: message });
    }
    request.principal = principal;

    const admitted = limiter.admit(principal.subject);
    if (!admitted.allowed) {
      if (admitted.retryAfterSec) reply.header("Retry-After", String(admitted.retryAfterSec));
      return reply.code(429).send({ error: admitted.reason });
    }

    const decision = await authorize(principal, {
      method: request.method,
      path: routePath,
      sessionId: (request.params as { id?: string } | undefined)?.id,
    });
    if (!decision.allow) {
      return reply.code(403).send({ error: decision.reason });
    }
  });

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

  // ── Health (public) ─────────────────────────────────────────────
  app.get("/health", async () => ({
    status: "ok",
    provider: agent.provider.name,
    tools: agent.tools.list().length,
    sessions: agent.sessionCount,
    mcp: agent.mcp.states(),
    authenticated: Boolean(verifier),
    uptime: process.uptime(),
  }));

  // ── Discovery (public) ──────────────────────────────────────────
  //
  // Lets a client — the CLI in particular — learn which identity provider to
  // authenticate against instead of having the IdP's coordinates baked in.
  app.get("/.well-known/microagent-config", async (_request, reply) => {
    if (!verifier) {
      // 404 rather than an empty document: it is an unambiguous "no token
      // needed here" that a client can map to a sentinel, whereas a 200 with
      // blank fields reads like a misconfigured IdP.
      return reply
        .code(404)
        .type("text/plain; charset=utf-8")
        .send("auth disabled on this deployment");
    }
    reply.header("Cache-Control", "public, max-age=300");
    return buildDiscoveryDocument(verifier);
  });

  // ── List tools ─────────────────────────────────────────────────
  app.get("/tools", async () => ({
    tools: agent.tools.getDefinitions().map((definition) => ({
      ...definition,
      available: agent.tools.isAvailable(definition.name),
      source: agent.tools.sourceOf(definition.name),
    })),
  }));

  // ── Stats ──────────────────────────────────────────────────────
  app.get("/stats", async () => agent.stats.summary);

  // ── List available models (all providers) ───────────────────────
  app.get("/models", async () => {
    const models = await agent.listAllModels();
    return { models, activeProvider: agent.provider.name, activeModel: agent.provider.currentModel };
  });

  // ── Get / set current model ───────────────────────────────────
  app.get("/model", async () => ({
    model: agent.provider.currentModel,
    provider: agent.provider.name,
  }));

  app.post<{ Body: { model: string } }>(
    "/model",
    {
      schema: {
        body: {
          type: "object",
          required: ["model"],
          properties: { model: { type: "string" } },
        },
      },
    },
    async (request) => {
      const { model } = request.body;
      const { provider: provName, model: newModel } = agent.setModel(model);

      // Persist to config file if available. Non-fatal on failure — the model is
      // already switched in memory. `persisted` reports whether the file was
      // actually written, not merely whether a path was configured.
      let persisted = false;
      const configPath = opts.configPath;
      if (configPath) {
        try {
          persisted = persistModel(configPath, provName, newModel);
        } catch {
          persisted = false;
        }
      }

      return { provider: provName, model: newModel, persisted };
    }
  );

  // ── Sessions ───────────────────────────────────────────────────

  app.post<{ Body: { systemPrompt?: string; metadata?: Record<string, unknown> } }>(
    "/sessions",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            systemPrompt: { type: "string" },
            metadata: { type: "object", additionalProperties: true },
          },
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request);

      const perPrincipalCap = config.limits?.maxSessionsPerPrincipal;
      if (perPrincipalCap && agent.countSessionsFor(principal) >= perPrincipalCap) {
        return reply
          .code(429)
          .send({ error: `session cap for this principal reached (${perPrincipalCap})` });
      }

      try {
        const session = agent.createSession({
          principal,
          systemPrompt: request.body?.systemPrompt,
          metadata: request.body?.metadata,
        });
        return reply.code(201).send(describeSession(session));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(503).send({ error: message });
      }
    }
  );

  app.get("/sessions", async (request) => {
    const principal = requirePrincipal(request);
    return { sessions: agent.listSessions(principal).map(describeSession) };
  });

  app.get<{ Params: { id: string } }>("/sessions/:id", async (request, reply) => {
    const session = lookupSession(request, reply);
    if (!session) return reply;
    return describeSession(session);
  });

  app.delete<{ Params: { id: string } }>("/sessions/:id", async (request, reply) => {
    const session = lookupSession(request, reply);
    if (!session) return reply;
    agent.closeSession(session.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: RunBody }>(
    "/sessions/:id/messages",
    { schema: { body: runBodySchema } },
    async (request, reply) => {
      const session = lookupSession(request, reply);
      if (!session) return reply;
      return runNonStreaming(session, request, reply);
    }
  );

  app.post<{ Params: { id: string }; Body: RunBody }>(
    "/sessions/:id/messages/stream",
    { schema: { body: runBodySchema } },
    async (request, reply) => {
      const session = lookupSession(request, reply);
      if (!session) return reply;
      return runStreaming(session, request, reply);
    }
  );

  // ── Chat (compatibility shim) ──────────────────────────────────
  //
  // Kept so the existing CLI and web UI work unchanged. Now backed by an
  // implicit session *per principal* rather than one shared conversation —
  // previously every HTTP caller appended to the same message array, so one
  // caller's context and tool output landed in the next caller's prompt.
  app.post<{ Body: RunBody }>("/chat", { schema: { body: runBodySchema } }, async (request, reply) => {
    const session = implicitSessionFor(requirePrincipal(request));
    return runNonStreaming(session, request, reply);
  });

  app.post<{ Body: RunBody }>(
    "/chat/stream",
    { schema: { body: runBodySchema } },
    async (request, reply) => {
      const session = implicitSessionFor(requirePrincipal(request));
      return runStreaming(session, request, reply);
    }
  );

  // ── Helpers ────────────────────────────────────────────────────

  /**
   * The implicit conversation behind `/chat`, one per caller.
   *
   * Keyed by subject so two callers never share history. Recreated if the
   * previous one was evicted by TTL.
   */
  const implicitSessions = new Map<string, string>();

  function implicitSessionFor(principal: Principal): Session {
    const existingId = implicitSessions.get(principal.subject);
    if (existingId) {
      const existing = agent.getSessionFor(existingId, principal);
      if (existing) return existing;
    }
    const session = agent.createSession({
      principal,
      metadata: { implicit: true, route: "/chat" },
    });
    implicitSessions.set(principal.subject, session.id);
    return session;
  }

  function lookupSession(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Session | undefined {
    const principal = requirePrincipal(request);
    const session = agent.getSessionFor(request.params.id, principal);
    if (!session) {
      // Deliberately the same answer for "does not exist" and "belongs to
      // someone else" — confirming that another subject's id is valid is itself
      // a small leak.
      reply.code(404).send({ error: "session not found" });
      return undefined;
    }
    return session;
  }

  function toRunOptions(body: RunBody, signal: AbortSignal) {
    return {
      signal,
      images: body.images,
      maxToolRounds: body.maxToolRounds,
      tokenBudget: body.tokenBudget,
      deadlineMs: body.deadlineMs,
      toolTimeoutMs: body.toolTimeoutMs,
      maxTokens: body.maxTokens,
      responseFormat: body.responseFormat,
    };
  }

  async function runNonStreaming(
    session: Session,
    request: FastifyRequest<{ Body: RunBody }>,
    reply: FastifyReply
  ) {
    const principal = requirePrincipal(request);
    const budget = limiter.checkTokens(principal.subject);
    if (!budget.allowed) {
      if (budget.retryAfterSec) reply.header("Retry-After", String(budget.retryAfterSec));
      return reply.code(429).send({ error: budget.reason });
    }

    const controller = new AbortController();
    // A client that hangs up should not leave a run burning tokens against a
    // socket nobody is reading.
    request.raw.on("close", () => controller.abort());

    const toolCalls: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
      result: string;
      isError?: boolean;
      denied?: boolean;
    }> = [];

    const result = await session.run(
      request.body.message,
      {
        onToolCall(name, args, id) {
          toolCalls.push({ id, name, args, result: "" });
        },
        onToolResult(_name, toolResult: ToolResult) {
          // Matched on the call id rather than searched backwards by name — a
          // name-based lookup silently breaks the moment a turn invokes the
          // same tool twice or results arrive out of order.
          const call = toolCalls.find((t) => t.id === toolResult.toolCallId);
          if (call) {
            call.result = toolResult.content;
            call.isError = toolResult.isError;
          }
        },
        onToolDenied(_name, id) {
          const call = toolCalls.find((t) => t.id === id);
          if (call) call.denied = true;
        },
      },
      toRunOptions(request.body, controller.signal)
    );

    limiter.recordTokens(principal.subject, result.usage.totalTokens);

    return {
      // `response` retains the old field name so existing clients keep working.
      response: result.text,
      ...describeResult(result),
      toolCalls,
      stats: agent.stats.summary,
    };
  }

  async function runStreaming(
    session: Session,
    request: FastifyRequest<{ Body: RunBody }>,
    reply: FastifyReply
  ) {
    const principal = requirePrincipal(request);
    const budget = limiter.checkTokens(principal.subject);
    if (!budget.allowed) {
      if (budget.retryAfterSec) reply.header("Retry-After", String(budget.retryAfterSec));
      return reply.code(429).send({ error: budget.reason });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const controller = new AbortController();
    request.raw.on("close", () => controller.abort());

    try {
      const result = await session.run(
        request.body.message,
        {
          onDelta(delta: StreamDelta) {
            send("delta", delta);
          },
          // `id` lets a client pair a result with its call — necessary when one
          // turn invokes the same tool more than once.
          onToolCall(name: string, args: Record<string, unknown>, id: string) {
            send("tool_call", { id, name, args });
          },
          onToolResult(name: string, toolResult: ToolResult) {
            send("tool_result", {
              id: toolResult.toolCallId,
              name,
              content: toolResult.content,
              isError: toolResult.isError,
            });
          },
          onToolDenied(name: string, id: string, reason: string) {
            send("tool_denied", { id, name, reason });
          },
        },
        toRunOptions(request.body, controller.signal)
      );

      limiter.recordTokens(principal.subject, result.usage.totalTokens);

      send("complete", {
        response: result.text,
        ...describeResult(result),
        stats: agent.stats.summary,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      send("error", { error: msg });
    }

    reply.raw.end();
  }

  return { app, agent, verifier };
}

function isApiRoute(path: string): boolean {
  return (
    path === "/tools" ||
    path === "/stats" ||
    path === "/models" ||
    path === "/model" ||
    path === "/chat" ||
    path === "/chat/stream" ||
    path === "/sessions" ||
    path.startsWith("/sessions/")
  );
}

function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) {
    // The onRequest hook sets this on every non-public route, so reaching here
    // means a route was added without going through it.
    throw new AuthError(401, "unauthenticated");
  }
  return request.principal;
}

function anonymousPrincipal(): Principal {
  return { subject: "anonymous", groups: [], scopes: [] };
}

function describeSession(session: Session) {
  return {
    id: session.id,
    createdAt: new Date(session.createdAt).toISOString(),
    lastUsedAt: new Date(session.lastUsedAt).toISOString(),
    turns: session.turns,
    messages: session.getMessages().length,
    usage: session.usage,
    metadata: session.metadata,
  };
}

/**
 * The parts of a run a client needs beyond the text.
 *
 * `stopReason` in particular: without it a caller cannot tell a finished answer
 * from one truncated by a round cap, a budget, or `max_tokens`.
 */
function describeResult(result: RunResult) {
  return {
    stopReason: result.stopReason,
    rounds: result.rounds,
    usage: result.usage,
    correlationId: result.correlationId,
    ...(result.structured ? { structured: result.structured } : {}),
    ...(result.error ? { error: result.error.message } : {}),
  };
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
