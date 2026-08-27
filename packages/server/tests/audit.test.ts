import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "../src/index.js";
import { allowAuthenticated } from "../src/auth.js";
import type { Verifier } from "../src/auth.js";
import { MemoryAuditSink } from "@microagent/core";
import type {
  Agent,
  AuditRedactor,
  ChatOptions,
  ChatResult,
  LLMProvider,
  Message,
  MicroagentConfig,
  ModelInfo,
  Principal,
} from "@microagent/core";

/** Requests a tool on the first call, then answers. */
class ToolyProvider implements LLMProvider {
  readonly name = "tooly";
  currentModel = "tooly-model";
  private calls = 0;

  setModel(model: string): void {
    this.currentModel = model;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  async chat(_messages: Message[], _options: ChatOptions = {}): Promise<ChatResult> {
    this.calls++;
    const usage = { promptTokens: 4, completionTokens: 2, totalTokens: 6 };
    if (this.calls === 1) {
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_1", name: "lookup", arguments: { user: "alice", apiKey: "sk-live-abc" } },
          ],
        },
        usage,
        stopReason: "tool_use",
      };
    }
    return {
      message: { role: "assistant", content: "Found the record." },
      usage,
      stopReason: "end_turn",
    };
  }
}

function fakeVerifier(): Verifier {
  return {
    issuer: "https://idp.example.test",
    audience: "microagent",
    endpoints: {},
    scopes: [],
    async authenticate(header: string | undefined): Promise<Principal> {
      const subject = header?.replace(/^Bearer\s+/i, "");
      if (!subject) throw Object.assign(new Error("missing Authorization header"), { status: 401 });
      return { subject, groups: [], scopes: [], claims: {} };
    },
  } as unknown as Verifier;
}

let app: FastifyInstance;
let agent: Agent;

async function boot(config: MicroagentConfig = {}, auditRedactor?: AuditRedactor) {
  const sink = new MemoryAuditSink();
  const result = await createServer({
    logger: false,
    verifier: fakeVerifier(),
    authorize: allowAuthenticated,
    auditSink: sink,
    auditRedactor,
    config: {
      provider: { type: "ollama", model: "unused" },
      systemPrompt: "You are an assistant.",
      ...config,
    },
  });
  app = result.app;
  agent = result.agent;
  (agent as unknown as { _provider: LLMProvider })._provider = new ToolyProvider();
  agent.tools.register({
    definition: { name: "lookup", description: "look up a user", inputSchema: { type: "object" } },
    async execute() {
      return "alice: active, email alice@example.test";
    },
  });
  return sink;
}

const alice = { authorization: "Bearer alice" };

afterEach(async () => {
  await app.close();
  await agent.shutdown();
});

describe("audit over HTTP", () => {
  it("records the turn and each tool call for a /chat request", async () => {
    const sink = await boot();

    await app.inject({
      method: "POST",
      url: "/chat",
      headers: alice,
      payload: { message: "look up alice" },
    });

    expect(sink.toolCalls).toHaveLength(1);
    expect(sink.toolCalls[0].call.name).toBe("lookup");
    expect(sink.turns).toHaveLength(1);
    expect(sink.turns[0].principal?.subject).toBe("alice");
    expect(sink.turns[0].stopReason).toBe("end_turn");
  });

  it("attributes records to the calling principal", async () => {
    const sink = await boot();

    await app.inject({
      method: "POST",
      url: "/chat",
      headers: alice,
      payload: { message: "one" },
    });
    await app.inject({
      method: "POST",
      url: "/chat",
      headers: { authorization: "Bearer bob" },
      payload: { message: "two" },
    });

    const subjects = sink.turns.map((t) => t.principal?.subject);
    expect(subjects).toEqual(["alice", "bob"]);
    // Different callers, therefore different sessions.
    expect(new Set(sink.turns.map((t) => t.sessionId)).size).toBe(2);
  });

  it("records no prompt or tool content at the default level", async () => {
    const sink = await boot();

    await app.inject({
      method: "POST",
      url: "/chat",
      headers: alice,
      payload: { message: "look up alice" },
    });

    expect(sink.turns[0].prompt).toBeUndefined();
    const serialised = JSON.stringify(sink.records);
    expect(serialised).not.toContain("sk-live-abc");
    expect(serialised).not.toContain("alice@example.test");
  });

  it("records prompts and results when the config asks for them", async () => {
    const sink = await boot({ audit: { level: "full" } });

    await app.inject({
      method: "POST",
      url: "/chat",
      headers: alice,
      payload: { message: "look up alice" },
    });

    const turn = sink.turns[0];
    expect(turn.prompt?.system).toBe("You are an assistant.");
    expect(turn.prompt?.input).toBe("look up alice");
    expect(turn.prompt?.tools).toEqual(["lookup"]);
    expect(turn.prompt?.messages?.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(turn.response).toBe("Found the record.");
    expect(turn.toolCalls[0].result).toBe("alice: active, email alice@example.test");
  });

  it("applies the injected redactor to prompt and tool content", async () => {
    const redactor: AuditRedactor = (value) =>
      value.replace(/sk-[\w-]+/g, "[key]").replace(/[\w.]+@[\w.]+/g, "[email]");
    const sink = await boot({ audit: { level: "full" } }, redactor);

    await app.inject({
      method: "POST",
      url: "/chat",
      headers: alice,
      payload: { message: "look up alice@example.test" },
    });

    const turn = sink.turns[0];
    expect(turn.prompt?.input).toBe("look up [email]");
    expect(turn.toolCalls[0].arguments?.apiKey).toBe("[key]");
    expect(turn.toolCalls[0].result).toContain("[email]");

    const serialised = JSON.stringify(sink.records);
    expect(serialised).not.toContain("sk-live-abc");
    expect(serialised).not.toContain("alice@example.test");
  });

  it("honours the configured field cap", async () => {
    const sink = await boot({ audit: { level: "io", maxFieldChars: 10 } });

    await app.inject({
      method: "POST",
      url: "/chat",
      headers: alice,
      payload: { message: "a very long question that exceeds the configured cap" },
    });

    expect(sink.turns[0].prompt?.input).toContain("[truncated");
  });

  /** `audit.enabled: false` has to mean nothing is written at all. */
  it("writes nothing when auditing is disabled", async () => {
    const sink = await boot({ audit: { enabled: false, level: "full" } });

    await app.inject({
      method: "POST",
      url: "/chat",
      headers: alice,
      payload: { message: "look up alice" },
    });

    expect(sink.records).toHaveLength(0);
  });

  it("records session-route turns against the addressed session", async () => {
    const sink = await boot();

    const created = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: alice,
      payload: {},
    });
    const id = created.json().id;

    await app.inject({
      method: "POST",
      url: `/sessions/${id}/messages`,
      headers: alice,
      payload: { message: "look up alice" },
    });

    expect(sink.turns[0].sessionId).toBe(id);
  });

  /**
   * The correlation id returned to the caller is the one in the trail, so a
   * complaint about a specific response can be traced to the tool calls that
   * produced it.
   */
  it("returns a correlation id that matches the recorded one", async () => {
    const sink = await boot();

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: alice,
      payload: { message: "look up alice" },
    });

    const returned = res.json().correlationId;
    expect(returned).toBeTruthy();
    expect(sink.turns[0].correlationId).toBe(returned);
    expect(sink.toolCalls[0].correlationId).toBe(returned);
  });
});
