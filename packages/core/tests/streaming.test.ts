import { describe, it, expect, afterEach, vi } from "vitest";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import type { Message, StreamDelta } from "../src/types.js";

/** Build a fetch stub returning the given payloads as an SSE stream. */
function sseResponse(payloads: unknown[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const p of payloads) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(p)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function provider() {
  return new OpenAICompatibleProvider({
    name: "test",
    model: "test-model",
    baseUrl: "http://example.test/v1",
  });
}

const userMessages: Message[] = [{ role: "user", content: "hi" }];

/** Stream the given chunks through the provider, collecting deltas. */
async function stream(payloads: unknown[]) {
  const deltas: StreamDelta[] = [];
  const result = await provider().chat(userMessages, undefined, (d) => deltas.push(d));
  return { deltas, ...result };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SSE streaming", () => {
  it("accumulates text deltas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { choices: [{ delta: { content: "Hel" } }] },
          { choices: [{ delta: { content: "lo" } }] },
        ])
      )
    );

    const { deltas, message } = await stream([]);
    expect(message.content).toBe("Hello");
    expect(deltas.filter((d) => d.type === "text").map((d) => d.text)).toEqual(["Hel", "lo"]);
    expect(deltas.at(-1)?.type).toBe("done");
  });

  it("assembles a tool call split across chunks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", function: { name: "bash", arguments: "" } },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"comm' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] },
        ])
      )
    );

    const { message } = await stream([]);
    expect(message.toolCalls).toHaveLength(1);
    expect(message.toolCalls?.[0].id).toBe("call_1");
    expect(message.toolCalls?.[0].name).toBe("bash");
    expect(message.toolCalls?.[0].arguments).toEqual({ command: "ls" });
  });

  /**
   * Regression test: a chunk carrying `tc.id` used to replace the accumulator
   * entry, discarding any arguments buffered before it. Harmless when the id
   * arrives first, silently corrupting for providers that send arguments first.
   */
  it("does not discard arguments buffered before the id arrives", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, function: { name: "bash", arguments: '{"command":' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_late", function: { arguments: '"ls -la"}' } },
                  ],
                },
              },
            ],
          },
        ])
      )
    );

    const { message } = await stream([]);
    expect(message.toolCalls?.[0].id).toBe("call_late");
    expect(message.toolCalls?.[0].name).toBe("bash");
    expect(message.toolCalls?.[0].arguments).toEqual({ command: "ls -la" });
  });

  it("emits exactly one tool_call_start even if the id repeats", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "bash" } }] } },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: "call_1", function: { arguments: "{}" } }],
                },
              },
            ],
          },
        ])
      )
    );

    const { deltas } = await stream([]);
    expect(deltas.filter((d) => d.type === "tool_call_start")).toHaveLength(1);
  });

  it("keeps parallel tool calls separated by index", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "a", function: { name: "first", arguments: "{}" } },
                    { index: 1, id: "b", function: { name: "second", arguments: "{}" } },
                  ],
                },
              },
            ],
          },
        ])
      )
    );

    const { message } = await stream([]);
    expect(message.toolCalls?.map((t) => t.name)).toEqual(["first", "second"]);
  });

  it("captures usage from the trailing chunk", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { choices: [{ delta: { content: "hi" } }] },
          {
            choices: [],
            usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
          },
        ])
      )
    );

    const { usage } = await stream([]);
    expect(usage.totalTokens).toBe(9);
    expect(usage.promptTokens).toBe(7);
  });

  it("skips unparseable payloads instead of failing the turn", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("data: not json\n\n"));
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`)
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));

    const { message } = await stream([]);
    expect(message.content).toBe("ok");
  });

  /**
   * Ollama with nothing pulled answers `/v1/models` with `{"data":null}` — an
   * explicit null rather than an absent field.
   */
  it("treats a null model list as empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ object: "list", data: null }), { status: 200 }))
    );
    await expect(provider().listModels()).resolves.toEqual([]);
  });
});
