import { describe, it, expect } from "vitest";
import { Agent } from "../src/agent.js";
import { MemoryAuditSink } from "../src/audit.js";
import type {
  ChatOptions,
  ChatResult,
  LLMProvider,
  Message,
  ModelInfo,
  MicroagentConfig,
  ProviderStopReason,
  ToolPlugin,
} from "../src/types.js";

/** A provider driven by a callback, so each test scripts its own behaviour. */
class FakeProvider implements LLMProvider {
  readonly name = "fake";
  currentModel = "fake-model";
  calls = 0;
  lastOptions?: ChatOptions;
  seenHistories: Message[][] = [];

  constructor(
    private readonly respond: (
      messages: Message[],
      options: ChatOptions,
      call: number
    ) => Promise<ChatResult> | ChatResult
  ) {}

  setModel(model: string): void {
    this.currentModel = model;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  async chat(messages: Message[], options: ChatOptions = {}): Promise<ChatResult> {
    this.calls++;
    this.lastOptions = options;
    this.seenHistories.push(structuredClone(messages));
    return this.respond(messages, options, this.calls);
  }
}

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

function reply(content: string, stopReason: ProviderStopReason = "end_turn"): ChatResult {
  return { message: { role: "assistant", content }, usage, stopReason };
}

function toolReply(id: string, name: string, args: Record<string, unknown> = {}): ChatResult {
  return {
    message: { role: "assistant", content: "", toolCalls: [{ id, name, arguments: args }] },
    usage,
    stopReason: "tool_use",
  };
}

function echoTool(name = "echo"): ToolPlugin {
  return {
    definition: { name, description: "echo", inputSchema: { type: "object" } },
    async execute(args) {
      return `echo:${JSON.stringify(args)}`;
    },
  };
}

function agentWith(provider: LLMProvider, config: MicroagentConfig = {}) {
  const agent = new Agent({
    provider: { type: "ollama", model: "unused" },
    systemPrompt: "sys",
    ...config,
  });
  (agent as unknown as { _provider: LLMProvider })._provider = provider;
  return agent;
}

describe("session isolation", () => {
  /**
   * The reason `Session` exists. With one shared history, the second caller's
   * prompt contained the first caller's messages — and whatever their tools
   * returned.
   */
  it("keeps each session's history to itself", async () => {
    const provider = new FakeProvider(() => reply("ok"));
    const agent = agentWith(provider);

    const a = agent.createSession();
    const b = agent.createSession();

    await a.run("alice secret");
    await b.run("bob question");

    const bobHistory = provider.seenHistories.at(-1)!;
    const text = JSON.stringify(bobHistory);
    expect(text).toContain("bob question");
    expect(text).not.toContain("alice secret");

    expect(a.getMessages()).toHaveLength(2);
    expect(b.getMessages()).toHaveLength(2);
  });

  it("runs separate sessions concurrently rather than serialising them", async () => {
    const order: string[] = [];
    const provider = new FakeProvider(async (messages) => {
      const label = String(messages.at(-1)?.content);
      order.push(`start:${label}`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`end:${label}`);
      return reply("ok");
    });
    const agent = agentWith(provider);

    const a = agent.createSession();
    const b = agent.createSession();
    await Promise.all([a.run("one"), b.run("two")]);

    // Overlapping, not sequential: the second start precedes the first end.
    // A global queue would produce start,end,start,end.
    expect(order.slice(0, 2)).toEqual(["start:one", "start:two"]);
  });

  it("still serialises turns within one session", async () => {
    const provider = new FakeProvider(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return reply("ok");
    });
    const agent = agentWith(provider);
    const session = agent.createSession();

    await Promise.all([session.run("first"), session.run("second")]);

    const messages = session.getMessages();
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      "first",
      "second",
    ]);
  });

  it("carries the system prompt as a provider parameter, not message zero", async () => {
    const provider = new FakeProvider(() => reply("ok"));
    const agent = agentWith(provider);
    await agent.createSession().run("hi");

    expect(provider.lastOptions?.system).toBe("sys");
    expect(provider.seenHistories[0][0].role).toBe("user");
  });

  /**
   * Regression: `createSession({ systemPrompt: body?.systemPrompt })` is the
   * natural way to write the HTTP handler, and it passes the key with an
   * undefined value. That must still fall back to the configured prompt rather
   * than silently producing a session with none.
   */
  it("falls back to the configured prompt when one is passed as undefined", async () => {
    const provider = new FakeProvider(() => reply("ok"));
    const agent = agentWith(provider);

    await agent.createSession({ systemPrompt: undefined, metadata: undefined }).run("hi");
    expect(provider.lastOptions?.system).toBe("sys");
  });

  it("lets a session override the configured prompt", async () => {
    const provider = new FakeProvider(() => reply("ok"));
    const agent = agentWith(provider);

    await agent.createSession({ systemPrompt: "you are a reviewer" }).run("hi");
    expect(provider.lastOptions?.system).toBe("you are a reviewer");
  });
});

describe("session ownership", () => {
  it("hides a session from a different principal", () => {
    const agent = agentWith(new FakeProvider(() => reply("ok")));
    const alice = { subject: "alice", groups: [], scopes: [] };
    const bob = { subject: "bob", groups: [], scopes: [] };

    const session = agent.createSession({ principal: alice });

    expect(agent.getSessionFor(session.id, alice)?.id).toBe(session.id);
    expect(agent.getSessionFor(session.id, bob)).toBeUndefined();
    expect(agent.listSessions(bob)).toHaveLength(0);
  });
});

describe("stop reasons", () => {
  it("reports end_turn with the model's text", async () => {
    const agent = agentWith(new FakeProvider(() => reply("answer")));
    const result = await agent.createSession().run("q");

    expect(result.stopReason).toBe("end_turn");
    expect(result.text).toBe("answer");
    expect(result.rounds).toBe(1);
  });

  it("reports max_tool_rounds instead of a magic string", async () => {
    const provider = new FakeProvider((_m, _o, call) => toolReply(`call_${call}`, "echo"));
    const agent = agentWith(provider);
    agent.tools.register(echoTool());

    const result = await agent.createSession().run("loop", {}, { maxToolRounds: 3 });

    expect(result.stopReason).toBe("max_tool_rounds");
    expect(result.rounds).toBe(3);
    expect(result.toolCalls).toHaveLength(3);
  });

  it("surfaces a provider refusal", async () => {
    const agent = agentWith(new FakeProvider(() => reply("cannot help", "refusal")));
    const result = await agent.createSession().run("q");
    expect(result.stopReason).toBe("refusal");
  });

  /**
   * On Anthropic models `max_tokens` bounds thinking plus visible output, so a
   * truncated answer looks exactly like a complete one to a caller that only
   * receives a string.
   */
  it("surfaces truncation as max_tokens", async () => {
    const agent = agentWith(new FakeProvider(() => reply("half an ans", "max_tokens")));
    const result = await agent.createSession().run("q");
    expect(result.stopReason).toBe("max_tokens");
    expect(result.text).toBe("half an ans");
  });

  it("returns an error result rather than throwing", async () => {
    const agent = agentWith(
      new FakeProvider(() => {
        throw new Error("provider exploded");
      })
    );
    const result = await agent.createSession().run("q");

    expect(result.stopReason).toBe("error");
    expect(result.error?.message).toBe("provider exploded");
    // The usage spent before the failure still has to be reported.
    expect(result.usage.totalTokens).toBe(0);
  });
});

describe("budgets, deadlines and cancellation", () => {
  it("stops before spending past the token budget", async () => {
    const provider = new FakeProvider((_m, _o, call) => toolReply(`call_${call}`, "echo"));
    const agent = agentWith(provider);
    agent.tools.register(echoTool());

    // Each round reports 15 tokens, so a budget of 20 allows one round and
    // then refuses to start a second.
    const result = await agent
      .createSession()
      .run("go", {}, { tokenBudget: 20, maxToolRounds: 10 });

    expect(result.stopReason).toBe("budget_exhausted");
    expect(provider.calls).toBe(2);
    expect(result.usage.totalTokens).toBe(30);
  });

  it("reports cancellation when the signal aborts", async () => {
    const controller = new AbortController();
    const provider = new FakeProvider(async (_m, options) => {
      // A real transport rejects on abort; mimic that.
      await new Promise((resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        setTimeout(resolve, 500);
      });
      return reply("never");
    });
    const agent = agentWith(provider);

    const pending = agent.createSession().run("go", {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);

    const result = await pending;
    expect(result.stopReason).toBe("cancelled");
  });

  it("reports deadline_exceeded when the wall clock runs out", async () => {
    const provider = new FakeProvider(async (_m, options) => {
      await new Promise((resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        setTimeout(resolve, 500);
      });
      return reply("never");
    });
    const agent = agentWith(provider);

    const result = await agent.createSession().run("go", {}, { deadlineMs: 20 });
    expect(result.stopReason).toBe("deadline_exceeded");
  });

  /**
   * A cancel that only breaks the loop between rounds still waits out a hung
   * tool call, so the signal has to reach the tool itself.
   */
  it("passes the run signal into tool execution", async () => {
    let sawSignal = false;
    const provider = new FakeProvider((_m, _o, call) =>
      call === 1 ? toolReply("call_1", "probe") : reply("done")
    );
    const agent = agentWith(provider);
    agent.tools.register({
      definition: { name: "probe", description: "", inputSchema: { type: "object" } },
      async execute(_args, execCtx) {
        sawSignal = Boolean(execCtx?.signal);
        return "ok";
      },
    });

    await agent.createSession().run("go");
    expect(sawSignal).toBe(true);
  });

  it("times out a hung tool without hanging the run", async () => {
    const provider = new FakeProvider((_m, _o, call) =>
      call === 1 ? toolReply("call_1", "hang") : reply("recovered")
    );
    const agent = agentWith(provider);
    agent.tools.register({
      definition: { name: "hang", description: "", inputSchema: { type: "object" } },
      async execute(_args, execCtx) {
        await new Promise((resolve, reject) => {
          execCtx?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          setTimeout(resolve, 5000);
        });
        return "never";
      },
    });

    const result = await agent.createSession().run("go", {}, { toolTimeoutMs: 20 });

    expect(result.stopReason).toBe("end_turn");
    expect(result.toolCalls[0].isError).toBe(true);
    // The failure is fed back to the model as a result, so it can adapt.
    const toolMessage = provider.seenHistories.at(-1)?.find((m) => m.role === "tool");
    expect(String(toolMessage?.content)).toContain("timed out");
  });
});

describe("tool policy", () => {
  it("denies a call and feeds the reason back to the model", async () => {
    const provider = new FakeProvider((_m, _o, call) =>
      call === 1 ? toolReply("call_1", "echo", { scope: "all-namespaces" }) : reply("adapted")
    );
    const agent = agentWith(provider);
    agent.tools.register(echoTool());

    let executed = false;
    agent.tools.register({
      definition: { name: "danger", description: "", inputSchema: { type: "object" } },
      async execute() {
        executed = true;
        return "ran";
      },
    });

    agent.setToolPolicy({
      check: (call) =>
        call.arguments.scope === "all-namespaces"
          ? { action: "deny", reason: "cluster-wide queries are out of scope" }
          : { action: "allow" },
    });

    const denials: string[] = [];
    const result = await agent
      .createSession()
      .run("go", { onToolDenied: (_n, _i, reason) => denials.push(reason) });

    expect(executed).toBe(false);
    expect(denials).toEqual(["cluster-wide queries are out of scope"]);
    expect(result.toolCalls[0].denied).toBe(true);

    // The model sees the reason as the tool's result and gets another round to
    // adapt, rather than stalling on a silent failure.
    const toolMessage = provider.seenHistories.at(-1)?.find((m) => m.role === "tool");
    expect(String(toolMessage?.content)).toContain("cluster-wide queries are out of scope");
    expect(result.stopReason).toBe("end_turn");
  });

  it("rewrites arguments before execution", async () => {
    const provider = new FakeProvider((_m, _o, call) =>
      call === 1 ? toolReply("call_1", "echo", { since: "30d" }) : reply("done")
    );
    const agent = agentWith(provider);

    let seen: Record<string, unknown> | undefined;
    agent.tools.register({
      definition: { name: "echo", description: "", inputSchema: { type: "object" } },
      async execute(args) {
        seen = args;
        return "ok";
      },
    });

    agent.setToolPolicy({
      check: () => ({ action: "rewrite", arguments: { since: "1h" } }),
    });

    await agent.createSession().run("go");
    expect(seen).toEqual({ since: "1h" });
  });

  it("fails closed when the policy itself throws", async () => {
    const provider = new FakeProvider((_m, _o, call) =>
      call === 1 ? toolReply("call_1", "echo") : reply("done")
    );
    const agent = agentWith(provider);

    let executed = false;
    agent.tools.register({
      definition: { name: "echo", description: "", inputSchema: { type: "object" } },
      async execute() {
        executed = true;
        return "ran";
      },
    });

    agent.setToolPolicy({
      check: () => {
        throw new Error("policy backend down");
      },
    });

    const result = await agent.createSession().run("go");
    // A broken policy must not become an ungated tool call.
    expect(executed).toBe(false);
    expect(result.toolCalls[0].denied).toBe(true);
  });
});

describe("lifecycle and caps", () => {
  it("evicts idle sessions past the TTL", async () => {
    const agent = agentWith(new FakeProvider(() => reply("ok")), {
      sessions: { ttlMs: 1, sweepIntervalMs: 0 },
    });
    const session = agent.createSession();
    await new Promise((r) => setTimeout(r, 10));

    expect(agent.getSession(session.id)).toBeUndefined();
    expect(agent.sessionCount).toBe(0);
  });

  it("refuses to exceed the session cap rather than evicting someone's work", () => {
    const agent = agentWith(new FakeProvider(() => reply("ok")), {
      sessions: { maxSessions: 1, ttlMs: 0 },
    });
    agent.createSession();
    expect(() => agent.createSession()).toThrow(/Session cap reached/);
  });

  it("caps turns per session", async () => {
    const agent = agentWith(new FakeProvider(() => reply("ok")), {
      sessions: { maxTurnsPerSession: 1 },
    });
    const session = agent.createSession();

    await session.run("one");
    const second = await session.run("two");
    expect(second.stopReason).toBe("error");
    expect(second.error?.message).toMatch(/turn cap/);
  });

  it("drops history on close", async () => {
    const agent = agentWith(new FakeProvider(() => reply("ok")));
    const session = agent.createSession();
    await session.run("sensitive evidence");
    expect(session.getMessages()).toHaveLength(2);

    agent.closeSession(session.id);
    expect(session.getMessages()).toHaveLength(0);
    expect(session.closed).toBe(true);
  });
});

describe("usage and audit", () => {
  it("accumulates cache token counts", async () => {
    const provider = new FakeProvider(() => ({
      message: { role: "assistant", content: "ok" },
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 100,
        cacheWriteTokens: 20,
      },
      stopReason: "end_turn" as const,
    }));
    const agent = agentWith(provider);
    const session = agent.createSession();

    await session.run("a");
    await session.run("b");

    // Zero cache reads across repeated runs is the signal that something
    // volatile leaked into the prompt prefix, so it has to be observable.
    expect(session.usage.cacheReadTokens).toBe(200);
    expect(session.usage.cacheWriteTokens).toBe(40);
    expect(agent.stats.summary.cacheReadTokens).toBe(200);
  });

  it("writes one audit record per turn with the tool calls it made", async () => {
    const sink = new MemoryAuditSink();
    const provider = new FakeProvider((_m, _o, call) =>
      call === 1 ? toolReply("call_1", "echo", { value: "x" }) : reply("done")
    );
    const agent = agentWith(provider);
    agent.tools.register(echoTool());
    agent.setAuditSink(sink);

    const principal = { subject: "alice", groups: ["ops"], scopes: [], email: "a@example.com" };
    const session = agent.createSession({ principal });
    const result = await session.run("go");

    expect(sink.turns).toHaveLength(1);
    const record = sink.turns[0];
    expect(record.correlationId).toBe(result.correlationId);
    expect(record.sessionId).toBe(session.id);
    expect(record.principal?.subject).toBe("alice");
    expect(record.stopReason).toBe("end_turn");
    expect(record.model).toBe("fake-model");
    expect(record.toolCalls).toHaveLength(1);
    expect(record.toolCalls[0].name).toBe("echo");
  });

  it("threads the correlation id into tool execution", async () => {
    let seen: string | undefined;
    const provider = new FakeProvider((_m, _o, call) =>
      call === 1 ? toolReply("call_1", "probe") : reply("done")
    );
    const agent = agentWith(provider);
    agent.tools.register({
      definition: { name: "probe", description: "", inputSchema: { type: "object" } },
      async execute(_args, execCtx) {
        seen = execCtx?.correlationId;
        return "ok";
      },
    });

    const result = await agent.createSession().run("go", {}, { correlationId: "corr-1" });
    expect(seen).toBe("corr-1");
    expect(result.correlationId).toBe("corr-1");
  });
});

describe("structured output", () => {
  it("returns a typed validation failure instead of throwing", async () => {
    const agent = agentWith(new FakeProvider(() => reply('{"answer": 42}')));
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    };

    const result = await agent
      .createSession()
      .run("q", {}, { responseFormat: { type: "json_schema", schema } });

    expect(result.stopReason).toBe("end_turn");
    expect(result.structured?.ok).toBe(false);
    if (!result.structured?.ok) {
      expect(result.structured?.error).toContain("expected string");
    }
  });

  it("validates a conforming response", async () => {
    const agent = agentWith(new FakeProvider(() => reply('{"answer": "yes"}')));
    const result = await agent.createSession().run(
      "q",
      {},
      {
        responseFormat: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
          },
        },
      }
    );

    expect(result.structured).toEqual({ ok: true, value: { answer: "yes" } });
  });
});

describe("legacy Agent.run", () => {
  it("still returns a plain string", async () => {
    const agent = agentWith(new FakeProvider(() => reply("hello")));
    await expect(agent.run("hi")).resolves.toBe("hello");
  });

  it("still rejects when the provider fails", async () => {
    const agent = agentWith(
      new FakeProvider(() => {
        throw new Error("boom");
      })
    );
    await expect(agent.run("hi")).rejects.toThrow("boom");
  });

  it("reuses one implicit session across calls", async () => {
    const agent = agentWith(new FakeProvider(() => reply("ok")));
    await agent.run("first");
    await agent.run("second");
    expect(agent.getMessages()).toHaveLength(4);
    expect(agent.sessionCount).toBe(1);
  });
});
