import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "../src/index.js";
import { allowAuthenticated } from "../src/auth.js";
import type { Verifier } from "../src/auth.js";
import { NullAuditSink } from "@microagent/core";
import type {
  Agent,
  ChatOptions,
  ChatResult,
  LLMProvider,
  Message,
  ModelInfo,
  Principal,
} from "@microagent/core";

/** Echoes the last user message back, so a leaked history is visible. */
class EchoProvider implements LLMProvider {
  readonly name = "echo";
  currentModel = "echo-model";
  histories: Message[][] = [];

  setModel(model: string): void {
    this.currentModel = model;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  async chat(messages: Message[], _options: ChatOptions = {}): Promise<ChatResult> {
    this.histories.push(structuredClone(messages));
    const seen = messages.filter((m) => m.role === "user").map((m) => String(m.content));
    return {
      message: { role: "assistant", content: `saw:${seen.join("|")}` },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      stopReason: "end_turn",
    };
  }
}

/**
 * A verifier stand-in that maps a bearer token straight to a subject.
 *
 * The cryptographic path is covered in auth.test.ts against a mock JWKS; what
 * matters here is what the routes do once a principal exists.
 */
function fakeVerifier(): Verifier {
  return {
    issuer: "https://idp.example.test",
    audience: "microagent",
    endpoints: {
      authorizationEndpoint: "https://idp.example.test/auth",
      tokenEndpoint: "https://idp.example.test/token",
      deviceAuthorizationEndpoint: "https://idp.example.test/device",
    },
    scopes: ["microagent:session:create"],
    clientIdHint: "microagent-cli",
    async authenticate(header: string | undefined): Promise<Principal> {
      const subject = header?.replace(/^Bearer\s+/i, "");
      if (!subject) {
        const err = new Error("missing Authorization header") as Error & { status: number };
        err.status = 401;
        throw err;
      }
      return { subject, groups: [], scopes: [], claims: {} };
    },
    async verify(token: string): Promise<Principal> {
      return { subject: token, groups: [], scopes: [], claims: {} };
    },
  } as unknown as Verifier;
}

let app: FastifyInstance;
let agent: Agent;
let provider: EchoProvider;

async function boot(options: Parameters<typeof createServer>[0] = {}) {
  provider = new EchoProvider();
  const result = await createServer({
    config: { provider: { type: "ollama", model: "unused" }, systemPrompt: "sys" },
    verifier: fakeVerifier(),
    authorize: allowAuthenticated,
    logger: false,
    auditSink: new NullAuditSink(),
    ...options,
  });
  app = result.app;
  agent = result.agent;
  (agent as unknown as { _provider: LLMProvider })._provider = provider;
  return result;
}

const alice = { authorization: "Bearer alice" };
const bob = { authorization: "Bearer bob" };

beforeEach(async () => {
  await boot();
});

afterEach(async () => {
  await app.close();
  await agent.shutdown();
});

describe("authentication gate", () => {
  it("rejects an unauthenticated API request", async () => {
    const res = await app.inject({ method: "GET", url: "/sessions" });
    expect(res.statusCode).toBe(401);
  });

  it("leaves /health public so a probe works without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().authenticated).toBe(true);
  });
});

describe("discovery document", () => {
  it("tells a client which IdP to authenticate against", async () => {
    const res = await app.inject({ method: "GET", url: "/.well-known/microagent-config" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toContain("max-age=300");

    const body = res.json();
    expect(body.issuer).toBe("https://idp.example.test");
    expect(body.audience).toBe("microagent");
    expect(body.token_endpoint).toBe("https://idp.example.test/token");
    expect(body.device_authorization_endpoint).toBe("https://idp.example.test/device");
    expect(body.client_id_hint).toBe("microagent-cli");
    expect(body.scopes).toContain("microagent:session:create");
  });

  it("is public — a client has to read it before it has a token", async () => {
    const res = await app.inject({ method: "GET", url: "/.well-known/microagent-config" });
    expect(res.statusCode).toBe(200);
  });

  /**
   * 404 rather than an empty document: an unambiguous "no token needed here"
   * that a client can map to a sentinel, where a 200 with blank fields reads
   * like a misconfigured IdP.
   */
  it("returns 404 when auth is disabled", async () => {
    await app.close();
    await agent.shutdown();
    await boot({ verifier: undefined, config: { provider: { type: "ollama", model: "u" } } });

    const res = await app.inject({ method: "GET", url: "/.well-known/microagent-config" });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("auth disabled");
  });
});

describe("session routes", () => {
  it("creates a session owned by the caller", async () => {
    const res = await app.inject({ method: "POST", url: "/sessions", headers: alice, payload: {} });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.turns).toBe(0);
  });

  it("lists only the caller's own sessions", async () => {
    await app.inject({ method: "POST", url: "/sessions", headers: alice, payload: {} });
    await app.inject({ method: "POST", url: "/sessions", headers: bob, payload: {} });

    const mine = await app.inject({ method: "GET", url: "/sessions", headers: alice });
    expect(mine.json().sessions).toHaveLength(1);
  });

  /**
   * The data-leak fix, at the HTTP boundary. Answering 404 rather than 403 is
   * deliberate — confirming that another subject's session id is valid is
   * itself a small leak.
   */
  it("hides another caller's session behind a 404", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: alice,
      payload: {},
    });
    const id = created.json().id;

    expect((await app.inject({ method: "GET", url: `/sessions/${id}`, headers: alice })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/sessions/${id}`, headers: bob })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/sessions/${id}/messages`,
          headers: bob,
          payload: { message: "steal" },
        })
      ).statusCode
    ).toBe(404);
    expect(
      (await app.inject({ method: "DELETE", url: `/sessions/${id}`, headers: bob })).statusCode
    ).toBe(404);
  });

  it("keeps history inside its own session", async () => {
    const first = (
      await app.inject({ method: "POST", url: "/sessions", headers: alice, payload: {} })
    ).json().id;
    const second = (
      await app.inject({ method: "POST", url: "/sessions", headers: alice, payload: {} })
    ).json().id;

    await app.inject({
      method: "POST",
      url: `/sessions/${first}/messages`,
      headers: alice,
      payload: { message: "secret-in-first" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${second}/messages`,
      headers: alice,
      payload: { message: "in-second" },
    });

    expect(res.json().response).toBe("saw:in-second");
  });

  it("returns the stop reason and usage alongside the text", async () => {
    const id = (
      await app.inject({ method: "POST", url: "/sessions", headers: alice, payload: {} })
    ).json().id;

    const res = await app.inject({
      method: "POST",
      url: `/sessions/${id}/messages`,
      headers: alice,
      payload: { message: "hi" },
    });

    const body = res.json();
    expect(body.stopReason).toBe("end_turn");
    expect(body.rounds).toBe(1);
    expect(body.usage.totalTokens).toBe(2);
    expect(body.correlationId).toBeTruthy();
  });

  it("closes a session on DELETE", async () => {
    const id = (
      await app.inject({ method: "POST", url: "/sessions", headers: alice, payload: {} })
    ).json().id;

    expect(
      (await app.inject({ method: "DELETE", url: `/sessions/${id}`, headers: alice })).statusCode
    ).toBe(204);
    expect(
      (await app.inject({ method: "GET", url: `/sessions/${id}`, headers: alice })).statusCode
    ).toBe(404);
  });

  it("rejects a message with no body", async () => {
    const id = (
      await app.inject({ method: "POST", url: "/sessions", headers: alice, payload: {} })
    ).json().id;
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${id}/messages`,
      headers: alice,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("/chat compatibility shim", () => {
  it("still answers with a `response` field", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: alice,
      payload: { message: "hello" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().response).toBe("saw:hello");
  });

  it("keeps one implicit conversation per caller across requests", async () => {
    await app.inject({ method: "POST", url: "/chat", headers: alice, payload: { message: "one" } });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: alice,
      payload: { message: "two" },
    });
    // Same session, so the earlier turn is still in context.
    expect(res.json().response).toBe("saw:one|two");
  });

  /**
   * The regression this route used to have: every HTTP caller appended to one
   * shared array, so Bob's prompt contained Alice's messages and whatever her
   * tools returned.
   */
  it("does not leak one caller's history into another's prompt", async () => {
    await app.inject({
      method: "POST",
      url: "/chat",
      headers: alice,
      payload: { message: "alice-secret" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: bob,
      payload: { message: "bob-question" },
    });

    expect(res.json().response).toBe("saw:bob-question");
    const bobHistory = JSON.stringify(provider.histories.at(-1));
    expect(bobHistory).not.toContain("alice-secret");
  });
});

describe("per-principal limits", () => {
  it("caps sessions per principal", async () => {
    await app.close();
    await agent.shutdown();
    await boot({
      config: {
        provider: { type: "ollama", model: "unused" },
        limits: { maxSessionsPerPrincipal: 1 },
      },
    });

    expect(
      (await app.inject({ method: "POST", url: "/sessions", headers: alice, payload: {} }))
        .statusCode
    ).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: alice,
      payload: {},
    });
    expect(second.statusCode).toBe(429);

    // Another caller is unaffected — the point of a per-principal limit.
    expect(
      (await app.inject({ method: "POST", url: "/sessions", headers: bob, payload: {} })).statusCode
    ).toBe(201);
  });

  it("rate limits requests per principal", async () => {
    await app.close();
    await agent.shutdown();
    await boot({
      config: {
        provider: { type: "ollama", model: "unused" },
        limits: { requestsPerMinute: 2 },
      },
    });

    await app.inject({ method: "GET", url: "/sessions", headers: alice });
    await app.inject({ method: "GET", url: "/sessions", headers: alice });
    const third = await app.inject({ method: "GET", url: "/sessions", headers: alice });

    expect(third.statusCode).toBe(429);
    expect(third.headers["retry-after"]).toBeDefined();

    // A different subject has its own bucket.
    expect((await app.inject({ method: "GET", url: "/sessions", headers: bob })).statusCode).toBe(
      200
    );
  });
});

describe("authorisation hook", () => {
  it("is consulted per route and can deny", async () => {
    await app.close();
    await agent.shutdown();
    await boot({
      authorize: (_principal, request) =>
        request.path === "/sessions" && request.method === "POST"
          ? { allow: false, reason: "session creation is disabled here" }
          : { allow: true },
    });

    const res = await app.inject({ method: "POST", url: "/sessions", headers: alice, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("session creation is disabled here");

    expect((await app.inject({ method: "GET", url: "/sessions", headers: alice })).statusCode).toBe(
      200
    );
  });
});

describe("auth-disabled mode", () => {
  it("serves every route under one anonymous identity", async () => {
    await app.close();
    await agent.shutdown();
    await boot({ verifier: undefined, config: { provider: { type: "ollama", model: "u" } } });

    expect((await app.inject({ method: "GET", url: "/sessions" })).statusCode).toBe(200);
    const created = await app.inject({ method: "POST", url: "/sessions", payload: {} });
    expect(created.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/health" })).json().authenticated).toBe(false);
  });
});
