import { describe, it, expect } from "vitest";
import { Agent } from "../src/agent.js";
import {
  JsonAuditSink,
  MemoryAuditSink,
  MultiAuditSink,
  truncate,
  type AuditRedactor,
  type AuditToolCallRecord,
  type AuditTurnRecord,
} from "../src/audit.js";
import type {
  ChatOptions,
  ChatResult,
  LLMProvider,
  Message,
  MicroagentConfig,
  ModelInfo,
  ProviderStopReason,
  ToolPlugin,
} from "../src/types.js";

class FakeProvider implements LLMProvider {
  readonly name = "fake";
  currentModel = "fake-model";
  calls = 0;

  constructor(
    private readonly respond: (messages: Message[], call: number) => ChatResult
  ) {}

  setModel(model: string): void {
    this.currentModel = model;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  async chat(messages: Message[], _options: ChatOptions = {}): Promise<ChatResult> {
    this.calls++;
    return this.respond(messages, this.calls);
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

function tool(name: string, result: string): ToolPlugin {
  return {
    definition: { name, description: name, inputSchema: { type: "object" } },
    async execute() {
      return result;
    },
  };
}

/** An agent that runs one tool call then answers. */
function harness(config: MicroagentConfig = {}, toolResult = "pod-a running\npod-b crashloop") {
  const provider = new FakeProvider((_m, call) =>
    call === 1
      ? toolReply("call_1", "kubernetes__get_pods", { namespace: "payments", token: "sk-secret" })
      : reply("Two pods; one is crashlooping.")
  );
  const agent = new Agent({
    provider: { type: "ollama", model: "unused" },
    systemPrompt: "You investigate alerts.",
    ...config,
  });
  (agent as unknown as { _provider: LLMProvider })._provider = provider;
  agent.tools.register(tool("kubernetes__get_pods", toolResult), { source: "kubernetes" });

  const sink = new MemoryAuditSink();
  agent.setAuditSink(sink);
  return { agent, sink, provider };
}

describe("per-tool-call records", () => {
  /**
   * The reason these are not folded into the turn summary: a turn can run for
   * minutes across many rounds, and batching means nothing is observable while
   * it happens — and a crash mid-turn loses every call already made.
   */
  it("emits a record as each call finishes, before the turn ends", async () => {
    const { agent, sink } = harness();
    const session = agent.createSession();
    await session.run("what is wrong");

    const calls = sink.toolCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0].call.name).toBe("kubernetes__get_pods");
    expect(calls[0].round).toBe(1);
    expect(calls[0].sessionId).toBe(session.id);

    // The per-call record is written before the turn summary.
    expect(sink.records[0].type).toBe("tool_call");
    expect(sink.records[1].type).toBe("turn");
  });

  it("names the tool set the tool came from", async () => {
    const { agent, sink } = harness();
    await agent.createSession().run("go");
    expect(sink.toolCalls[0].call.source).toBe("kubernetes");
  });

  it("can be turned off, leaving only the turn summary", async () => {
    const { agent, sink } = harness({ audit: { perToolCall: false } });
    await agent.createSession().run("go");

    expect(sink.toolCalls).toHaveLength(0);
    expect(sink.turns).toHaveLength(1);
    expect(sink.turns[0].toolCalls).toHaveLength(1);
  });

  it("records a policy denial with its reason and no execution", async () => {
    const { agent, sink } = harness();
    agent.setToolPolicy({ check: () => ({ action: "deny", reason: "namespace out of scope" }) });

    await agent.createSession().run("go");

    const call = sink.toolCalls[0].call;
    expect(call.denied).toBe(true);
    expect(call.denyReason).toBe("namespace out of scope");
    expect(call.isError).toBe(true);
  });
});

describe("level: metadata (default)", () => {
  /**
   * The default has to be safe. Prompts and tool results are the most sensitive
   * data the agent handles, so recording them is always a deliberate act.
   */
  it("records outcomes but no prompt, argument, or result text", async () => {
    const { agent, sink } = harness();
    await agent.createSession().run("what is wrong with payments");

    const turn = sink.turns[0];
    expect(turn.stopReason).toBe("end_turn");
    expect(turn.rounds).toBe(2);
    expect(turn.toolCalls[0].name).toBe("kubernetes__get_pods");
    expect(turn.toolCalls[0].durationMs).toBeGreaterThanOrEqual(0);

    // Nothing that could carry gathered data.
    expect(turn.prompt).toBeUndefined();
    expect(turn.response).toBeUndefined();
    expect(turn.toolCalls[0].arguments).toBeUndefined();
    expect(turn.toolCalls[0].result).toBeUndefined();

    const serialised = JSON.stringify(sink.records);
    expect(serialised).not.toContain("payments");
    expect(serialised).not.toContain("crashloop");
    expect(serialised).not.toContain("sk-secret");
  });
});

describe("level: io", () => {
  it("records the input, response, and each call's arguments and result", async () => {
    const { agent, sink } = harness({ audit: { level: "io" } });
    await agent.createSession().run("what is wrong with payments");

    const turn = sink.turns[0];
    expect(turn.prompt?.system).toBe("You investigate alerts.");
    expect(turn.prompt?.input).toBe("what is wrong with payments");
    expect(turn.prompt?.tools).toEqual(["kubernetes__get_pods"]);
    expect(turn.response).toBe("Two pods; one is crashlooping.");

    expect(turn.toolCalls[0].arguments).toEqual({
      namespace: "payments",
      token: "sk-secret",
    });
    expect(turn.toolCalls[0].result).toBe("pod-a running\npod-b crashloop");

    // The history itself stays out until `full`.
    expect(turn.prompt?.messages).toBeUndefined();
  });

  it("puts the same content on the per-call record", async () => {
    const { agent, sink } = harness({ audit: { level: "io" } });
    await agent.createSession().run("go");

    const call = sink.toolCalls[0].call;
    expect(call.arguments?.namespace).toBe("payments");
    expect(call.result).toBe("pod-a running\npod-b crashloop");
  });
});

describe("level: full", () => {
  it("records the message history as sent to the model", async () => {
    const { agent, sink } = harness({ audit: { level: "full" } });
    await agent.createSession().run("check payments");

    const messages = sink.turns[0].prompt?.messages;
    expect(messages?.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(messages?.[0].content).toBe("check payments");
    expect(messages?.[1].toolCalls?.[0].name).toBe("kubernetes__get_pods");
    expect(messages?.[2].toolCallId).toBe("call_1");
    expect(messages?.[2].content).toBe("pod-a running\npod-b crashloop");
    expect(messages?.[3].content).toBe("Two pods; one is crashlooping.");
  });

  /**
   * A base64 image is typically hundreds of kilobytes and worthless as a blob
   * in a log; its media type and size are what an auditor needs.
   */
  it("describes an inline image instead of recording it", async () => {
    const provider = new FakeProvider(() => reply("a cat"));
    const agent = new Agent({
      provider: { type: "ollama", model: "unused" },
      audit: { level: "full" },
    });
    (agent as unknown as { _provider: LLMProvider })._provider = provider;
    const sink = new MemoryAuditSink();
    agent.setAuditSink(sink);

    const payload = "A".repeat(4000);
    await agent
      .createSession()
      .run("what is this", {}, { images: [`data:image/png;base64,${payload}`] });

    const first = sink.turns[0].prompt?.messages?.[0];
    expect(first?.content).toBe("what is this");
    expect(first?.attachments).toEqual(["image image/png (2.9 KB)"]);
    expect(JSON.stringify(sink.records)).not.toContain(payload);
  });

  /**
   * Provider-native blocks are opaque to core by contract, and may be signed or
   * encrypted — so the record notes that one was present, not what it held.
   */
  it("notes a provider-native block without recording its payload", async () => {
    const provider = new FakeProvider((_m, call) =>
      call === 1
        ? {
            message: {
              role: "assistant",
              content: [
                { type: "provider_native", provider: "bedrock", block: { secret: "reasoning" } },
                { type: "text", text: "done" },
              ],
            },
            usage,
            stopReason: "end_turn" as const,
          }
        : reply("done")
    );
    const agent = new Agent({
      provider: { type: "ollama", model: "unused" },
      audit: { level: "full" },
    });
    (agent as unknown as { _provider: LLMProvider })._provider = provider;
    const sink = new MemoryAuditSink();
    agent.setAuditSink(sink);

    await agent.createSession().run("think");

    const assistant = sink.turns[0].prompt?.messages?.[1];
    expect(assistant?.attachments).toEqual(["provider_native:bedrock"]);
    expect(JSON.stringify(sink.records)).not.toContain("reasoning");
  });
});

describe("redaction", () => {
  const redactor: AuditRedactor = (value) => value.replace(/sk-[A-Za-z0-9]+/g, "[redacted]");

  it("scrubs strings nested inside tool arguments, keeping the shape", async () => {
    const { agent, sink } = harness({ audit: { level: "io" } });
    agent.setAuditRedactor(redactor);

    await agent.createSession().run("go");

    const args = sink.turns[0].toolCalls[0].arguments;
    expect(args).toEqual({ namespace: "payments", token: "[redacted]" });
    expect(JSON.stringify(sink.records)).not.toContain("sk-secret");
  });

  it("scrubs results, prompts and the response", async () => {
    const provider = new FakeProvider((_m, call) =>
      call === 1 ? toolReply("call_1", "leaky") : reply("the key is sk-response")
    );
    const agent = new Agent({
      provider: { type: "ollama", model: "unused" },
      systemPrompt: "the deploy key is sk-system",
      audit: { level: "full" },
    });
    (agent as unknown as { _provider: LLMProvider })._provider = provider;
    agent.tools.register(tool("leaky", "found sk-toolresult in the log"));
    const sink = new MemoryAuditSink();
    agent.setAuditSink(sink);
    agent.setAuditRedactor(redactor);

    await agent.createSession().run("my token is sk-input");

    const turn = sink.turns[0];
    expect(turn.prompt?.system).toBe("the deploy key is [redacted]");
    expect(turn.prompt?.input).toBe("my token is [redacted]");
    expect(turn.response).toBe("the key is [redacted]");
    expect(turn.toolCalls[0].result).toBe("found [redacted] in the log");

    const serialised = JSON.stringify(sink.records);
    for (const secret of ["sk-system", "sk-input", "sk-response", "sk-toolresult"]) {
      expect(serialised).not.toContain(secret);
    }
  });

  /**
   * A redactor that throws must not leak the value it failed to scrub, and must
   * not take the turn down either.
   */
  it("fails closed when the redactor throws", async () => {
    const { agent, sink } = harness({ audit: { level: "io" } });
    agent.setAuditRedactor(() => {
      throw new Error("scrubber backend down");
    });

    const result = await agent.createSession().run("sensitive question");

    expect(result.stopReason).toBe("end_turn");
    expect(sink.turns[0].prompt?.input).toBe("[redaction failed]");
    expect(JSON.stringify(sink.records)).not.toContain("sensitive question");
  });
});

describe("size caps", () => {
  /**
   * A tool returning a 40MB log dump would otherwise put all of it into the
   * audit stream, where it is both a cost and a liability.
   */
  it("truncates a huge tool result with a visible marker", async () => {
    const { agent, sink } = harness({ audit: { level: "io", maxFieldChars: 50 } }, "x".repeat(5000));
    await agent.createSession().run("go");

    const recorded = sink.turns[0].toolCalls[0].result!;
    expect(recorded.length).toBeLessThan(120);
    expect(recorded).toContain("[truncated 4950 chars]");
  });

  it("truncates strings inside arguments too", async () => {
    const provider = new FakeProvider((_m, call) =>
      call === 1 ? toolReply("call_1", "echo", { blob: "y".repeat(3000) }) : reply("done")
    );
    const agent = new Agent({
      provider: { type: "ollama", model: "unused" },
      audit: { level: "io", maxFieldChars: 20 },
    });
    (agent as unknown as { _provider: LLMProvider })._provider = provider;
    agent.tools.register(tool("echo", "ok"));
    const sink = new MemoryAuditSink();
    agent.setAuditSink(sink);

    await agent.createSession().run("go");
    expect(String(sink.turns[0].toolCalls[0].arguments?.blob)).toContain("[truncated 2980 chars]");
  });

  it("leaves a value under the cap untouched", () => {
    expect(truncate("short", 100)).toBe("short");
  });
});

describe("sinks", () => {
  it("JsonAuditSink writes one JSON line per record", async () => {
    const lines: string[] = [];
    const { agent } = harness({ audit: { level: "io" } });
    agent.setAuditSink(new JsonAuditSink((line) => lines.push(line)));

    await agent.createSession().run("go");

    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.endsWith("\n")).toBe(true);

    const parsed = lines.map((l) => JSON.parse(l) as { type: string });
    expect(parsed.map((p) => p.type)).toEqual(["tool_call", "turn"]);
  });

  it("JsonAuditSink degrades rather than throwing on an unserialisable record", () => {
    const lines: string[] = [];
    const sink = new JsonAuditSink((line) => lines.push(line));

    const circular: Record<string, unknown> = {};
    circular.self = circular;

    sink.record({
      type: "turn",
      timestamp: "2026-01-01T00:00:00.000Z",
      correlationId: "c1",
      sessionId: "s1",
      provider: "p",
      model: "m",
      stopReason: "end_turn",
      rounds: 1,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      durationMs: 1,
      toolCalls: [
        { id: "1", name: "bad", isError: false, arguments: circular as Record<string, unknown> },
      ],
    } as AuditTurnRecord);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).error).toBe("audit record not serialisable");
  });

  it("MultiAuditSink keeps going when one sink throws", async () => {
    const good = new MemoryAuditSink();
    const broken = {
      record() {
        throw new Error("sink down");
      },
    };

    const { agent } = harness();
    agent.setAuditSink(new MultiAuditSink([broken, good]));

    await agent.createSession().run("go");
    expect(good.records.length).toBeGreaterThan(0);
  });

  it("separates turn and tool_call records by type", async () => {
    const { agent, sink } = harness();
    await agent.createSession().run("go");

    expect(sink.records).toHaveLength(2);
    expect(sink.turns).toHaveLength(1);
    expect(sink.toolCalls).toHaveLength(1);

    const byType = (t: string) => sink.records.filter((r) => r.type === t);
    expect(byType("turn")[0]).toBe(sink.turns[0] as AuditTurnRecord);
    expect(byType("tool_call")[0]).toBe(sink.toolCalls[0] as AuditToolCallRecord);
  });
});

describe("correlation", () => {
  /**
   * Every record for a turn carries the same correlation id, so a finding can
   * be traced from the answer back to the individual tool calls that produced
   * it — and out to whatever the tool itself logged.
   */
  it("shares one correlation id across a turn's records", async () => {
    const { agent, sink } = harness();
    const result = await agent.createSession().run("go", {}, { correlationId: "corr-42" });

    expect(result.correlationId).toBe("corr-42");
    for (const record of sink.records) {
      expect(record.correlationId).toBe("corr-42");
    }
  });

  it("keeps two concurrent sessions' records distinguishable", async () => {
    const { agent, sink } = harness();
    const a = agent.createSession();
    const b = agent.createSession();

    await Promise.all([a.run("first"), b.run("second")]);

    const sessions = new Set(sink.records.map((r) => r.sessionId));
    expect(sessions).toEqual(new Set([a.id, b.id]));

    // Each session's records agree on their own correlation id.
    for (const id of [a.id, b.id]) {
      const ids = new Set(
        sink.records.filter((r) => r.sessionId === id).map((r) => r.correlationId)
      );
      expect(ids.size).toBe(1);
    }
  });
});
