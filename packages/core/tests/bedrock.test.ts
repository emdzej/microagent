import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BedrockProvider, normalizeModelId } from "../src/providers/bedrock.js";
import type { Message } from "../src/types.js";

/**
 * Swap the SDK client for a recorder.
 *
 * The value under test is the request this provider builds — Anthropic's shape
 * differs from the OpenAI one in ways that matter (top-level `system`,
 * `tool_result` blocks in user turns, manual cache breakpoints), and getting
 * any of those wrong is a 400 at best.
 */
function providerWithRecorder(model = "claude-opus-5") {
  const provider = new BedrockProvider({ model, region: "eu-central-1", maxTokens: 1024 });
  const recorder: { request?: Record<string, unknown> } = {};
  let response: unknown = {
    content: [{ type: "text", text: "hello" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 4 },
  };

  (provider as unknown as { client: unknown }).client = {
    messages: {
      create: async (request: Record<string, unknown>) => {
        recorder.request = request;
        return response;
      },
    },
  };

  return {
    provider,
    recorder,
    setResponse(next: unknown) {
      response = next;
    },
  };
}

let savedRegion: string | undefined;

beforeEach(() => {
  savedRegion = process.env.AWS_REGION;
});

afterEach(() => {
  if (savedRegion === undefined) delete process.env.AWS_REGION;
  else process.env.AWS_REGION = savedRegion;
});

describe("normalizeModelId", () => {
  it("adds the anthropic. prefix Bedrock expects", () => {
    expect(normalizeModelId("claude-opus-5")).toBe("anthropic.claude-opus-5");
  });

  /**
   * Cross-region inference profiles and already-qualified ids are left alone —
   * guessing at those would break a deployment that had it right.
   */
  it("leaves an already-qualified id untouched", () => {
    expect(normalizeModelId("anthropic.claude-opus-5")).toBe("anthropic.claude-opus-5");
    expect(normalizeModelId("us.anthropic.claude-opus-5")).toBe("us.anthropic.claude-opus-5");
  });
});

describe("construction", () => {
  it("requires a region rather than guessing one", () => {
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    expect(() => new BedrockProvider({ model: "claude-opus-5" })).toThrow(/requires a region/);
  });

  it("accepts a region from the environment", () => {
    process.env.AWS_REGION = "us-east-1";
    expect(new BedrockProvider({ model: "claude-opus-5" }).currentModel).toBe(
      "anthropic.claude-opus-5"
    );
  });
});

describe("request construction", () => {
  it("sends the system prompt as a top-level parameter, not a message", async () => {
    const { provider, recorder } = providerWithRecorder();
    await provider.chat([{ role: "user", content: "hi" }], { system: "you are terse" });

    expect(recorder.request?.system).toEqual([{ type: "text", text: "you are terse" }]);
    expect(recorder.request?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  /**
   * Bedrock does no automatic prompt caching, so a breakpoint has to be placed
   * by hand or the whole prefix is re-billed every turn.
   */
  it("places cache_control where breakpoints ask for it", async () => {
    const { provider, recorder } = providerWithRecorder();
    await provider.chat([{ role: "user", content: "hi" }], {
      system: "big stable prompt",
      tools: [
        { name: "a", description: "", inputSchema: { type: "object" } },
        { name: "b", description: "", inputSchema: { type: "object" } },
      ],
      cacheBreakpoints: { system: true, tools: true },
    });

    const system = recorder.request?.system as Array<Record<string, unknown>>;
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });

    // On the last tool, so the breakpoint covers the whole tool list.
    const tools = recorder.request?.tools as Array<Record<string, unknown>>;
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("does not place cache_control when no breakpoints are requested", async () => {
    const { provider, recorder } = providerWithRecorder();
    await provider.chat([{ role: "user", content: "hi" }], { system: "prompt" });
    const system = recorder.request?.system as Array<Record<string, unknown>>;
    expect(system[0].cache_control).toBeUndefined();
  });

  /**
   * All tool results for one assistant turn belong in a single user message.
   * Splitting them across messages trains the model to stop making parallel
   * calls, and core emits one `tool` message per call.
   */
  it("merges consecutive tool results into one user message", async () => {
    const { provider, recorder } = providerWithRecorder();
    const history: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_a", name: "one", arguments: {} },
          { id: "call_b", name: "two", arguments: {} },
        ],
      },
      { role: "tool", content: "result a", toolCallId: "call_a" },
      { role: "tool", content: "result b", toolCallId: "call_b" },
    ];

    await provider.chat(history);

    const messages = recorder.request?.messages as Array<{ role: string; content: unknown[] }>;
    expect(messages).toHaveLength(3);
    expect(messages[2].role).toBe("user");
    expect(messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "call_a", content: "result a" },
      { type: "tool_result", tool_use_id: "call_b", content: "result b" },
    ]);
  });

  it("translates a data-URI image into a base64 source block", async () => {
    const { provider, recorder } = providerWithRecorder();
    await provider.chat([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ]);

    const messages = recorder.request?.messages as Array<{ content: unknown[] }>;
    expect(messages[0].content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
  });

  it("replays this provider's own opaque blocks and drops foreign ones", async () => {
    const { provider, recorder } = providerWithRecorder();
    const thinking = { type: "thinking", thinking: "reasoning", signature: "sig" };

    await provider.chat([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "provider_native", provider: "bedrock", block: thinking },
          { type: "provider_native", provider: "openai", block: { type: "other" } },
          { type: "text", text: "answer" },
        ],
      },
    ]);

    const messages = recorder.request?.messages as Array<{ content: unknown[] }>;
    // Verbatim — a thinking block that has been edited or reconstructed fails
    // signature checks and breaks the turn.
    expect(messages[1].content).toEqual([thinking, { type: "text", text: "answer" }]);
  });

  it("passes effort and thinking configuration through", async () => {
    const { provider, recorder } = providerWithRecorder();
    await provider.chat([{ role: "user", content: "hi" }], {
      thinking: { type: "adaptive", display: "summarized" },
      effort: "high",
    });

    expect(recorder.request?.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(recorder.request?.output_config).toEqual({ effort: "high" });
  });
});

describe("response parsing", () => {
  it("keeps thinking blocks as opaque parts so multi-turn works", async () => {
    const { provider, setResponse } = providerWithRecorder();
    const thinking = { type: "thinking", thinking: "let me see", signature: "sig" };
    setResponse({
      content: [thinking, { type: "text", text: "the answer" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 2 },
    });

    const result = await provider.chat([{ role: "user", content: "q" }]);

    expect(Array.isArray(result.message.content)).toBe(true);
    const parts = result.message.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: "provider_native", provider: "bedrock", block: thinking });
    expect(parts[1]).toEqual({ type: "text", text: "the answer" });
  });

  it("extracts tool calls", async () => {
    const { provider, setResponse } = providerWithRecorder();
    setResponse({
      content: [{ type: "tool_use", id: "toolu_1", name: "get_pods", input: { ns: "default" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 2 },
    });

    const result = await provider.chat([{ role: "user", content: "q" }]);
    expect(result.message.toolCalls).toEqual([
      { id: "toolu_1", name: "get_pods", arguments: { ns: "default" } },
    ]);
    expect(result.stopReason).toBe("tool_use");
  });

  it("reports cache tokens and counts them in the total", async () => {
    const { provider, setResponse } = providerWithRecorder();
    setResponse({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 100,
      },
    });

    const { usage } = await provider.chat([{ role: "user", content: "q" }]);
    expect(usage.cacheReadTokens).toBe(900);
    expect(usage.cacheWriteTokens).toBe(100);
    // Cached tokens are billed but reported outside `input_tokens`, so a total
    // that ignored them would understate the request by an order of magnitude.
    expect(usage.totalTokens).toBe(1015);
  });

  it("maps stop reasons onto the normalised set", async () => {
    const { provider, setResponse } = providerWithRecorder();
    for (const [wire, expected] of [
      ["end_turn", "end_turn"],
      ["max_tokens", "max_tokens"],
      ["refusal", "refusal"],
      ["pause_turn", "pause_turn"],
      ["something_new", "unknown"],
    ] as const) {
      setResponse({ content: [{ type: "text", text: "x" }], stop_reason: wire });
      const result = await provider.chat([{ role: "user", content: "q" }]);
      expect(result.stopReason).toBe(expected);
    }
  });
});

describe("model id forms this endpoint accepts", () => {
  // Verified against eu-west-1. These assertions exist to stop a plausible
  // "fix": an inference-profile prefix is required by the legacy
  // bedrock-runtime API and rejected outright by the Messages endpoint used
  // here, so the two surfaces disagree in opposite directions.
  it("produces the bare anthropic. form, which is what this endpoint wants", () => {
    expect(normalizeModelId("claude-opus-5")).toBe("anthropic.claude-opus-5");
    expect(normalizeModelId("claude-haiku-4-5")).toBe("anthropic.claude-haiku-4-5");
  });

  it("does not add an inference-profile prefix, which this endpoint rejects", () => {
    for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]) {
      const normalized = normalizeModelId(model);
      expect(normalized.startsWith("anthropic.")).toBe(true);
      expect(normalized).not.toMatch(/^(?:eu|us|apac|global)\./);
    }
  });

  it("still passes an explicitly qualified id through untouched", () => {
    // A caller who has a profile id or an ARN knows something we do not.
    for (const model of [
      "eu.anthropic.claude-opus-5",
      "arn:aws:bedrock:eu-west-1:1:inference-profile/x",
    ]) {
      expect(normalizeModelId(model)).toBe(model);
    }
  });

  it("advertises the accepted form in listModels", async () => {
    const provider = new BedrockProvider({ model: "claude-opus-5", region: "eu-west-1" });
    for (const model of await provider.listModels()) {
      expect(model.id.startsWith("anthropic.")).toBe(true);
    }
  });
});
