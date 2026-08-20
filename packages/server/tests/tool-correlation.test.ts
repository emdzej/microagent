import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer } from "../src/index.js";
import { Agent } from "@microagent/core";
import type { ToolPlugin } from "@microagent/core";

/** A tool that echoes its argument, so each call has a distinguishable result. */
const echoTool: ToolPlugin = {
  definition: {
    name: "echo",
    description: "echo",
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
  },
  async execute(args) {
    return `echoed:${String(args.value)}`;
  },
};

/** Queue of canned chat completions, served in order. */
function stubCompletions(responses: unknown[]) {
  let index = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const body = responses[Math.min(index++, responses.length - 1)];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
}

function completionWithToolCalls(
  calls: Array<{ id: string; name: string; args: unknown }>
) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

const finalCompletion = {
  choices: [{ message: { role: "assistant", content: "all done" } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /chat tool call reporting", () => {
  /**
   * Characterisation test, not a regression test — and worth being precise about.
   *
   * Results used to be matched to calls by searching backwards for the most
   * recent call with the same *name*. That is ambiguous in principle, but it was
   * never actually wrong here: the agent executes tool calls strictly
   * sequentially (call, await, result), so the newest call with a given name
   * always was the correct one. This test therefore passes against the old code
   * too.
   *
   * The id-based matching it now exercises is a robustness fix. It matters the
   * moment tool calls run in parallel or results arrive out of order — the
   * obvious optimisation for a turn requesting several tools — at which point
   * name matching starts silently mis-assigning results.
   */
  it("pairs each result with its own call when one tool is invoked twice", async () => {
    stubCompletions([
      completionWithToolCalls([
        { id: "call_a", name: "echo", args: { value: "first" } },
        { id: "call_b", name: "echo", args: { value: "second" } },
      ]),
      finalCompletion,
    ]);

    const agent = new Agent({ provider: { type: "ollama", model: "test" } });
    agent.tools.register(echoTool);
    const { app } = await createServer({ agent });

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "run echo twice" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.response).toBe("all done");
    expect(body.toolCalls).toHaveLength(2);

    const byId = new Map(
      body.toolCalls.map((t: { id: string; result: string }) => [t.id, t.result])
    );
    expect(byId.get("call_a")).toBe("echoed:first");
    expect(byId.get("call_b")).toBe("echoed:second");

    await app.close();
    await agent.shutdown();
  });

  it("reports a failing tool with isError against the right call", async () => {
    const failing: ToolPlugin = {
      definition: { name: "boom", description: "fails", inputSchema: { type: "object" } },
      async execute() {
        throw new Error("kaboom");
      },
    };

    stubCompletions([
      completionWithToolCalls([
        { id: "call_ok", name: "echo", args: { value: "fine" } },
        { id: "call_bad", name: "boom", args: {} },
      ]),
      finalCompletion,
    ]);

    const agent = new Agent({ provider: { type: "ollama", model: "test" } });
    agent.tools.register(echoTool);
    agent.tools.register(failing);
    const { app } = await createServer({ agent });

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "go" },
    });

    const calls = res.json().toolCalls as Array<{
      id: string;
      result: string;
      isError?: boolean;
    }>;

    const ok = calls.find((c) => c.id === "call_ok");
    const bad = calls.find((c) => c.id === "call_bad");
    expect(ok?.isError).toBeFalsy();
    expect(ok?.result).toBe("echoed:fine");
    expect(bad?.isError).toBe(true);
    expect(bad?.result).toContain("kaboom");

    await app.close();
    await agent.shutdown();
  });
});

describe("POST /model persistence", () => {
  it("reports persisted:false when the provider is not in the config file", async () => {
    // No configPath at all, so nothing can be written.
    const agent = new Agent({ provider: { type: "ollama", model: "test" } });
    const { app } = await createServer({ agent });

    const res = await app.inject({
      method: "POST",
      url: "/model",
      payload: { model: "llama3.2" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      provider: "ollama",
      model: "llama3.2",
      persisted: false,
    });

    await app.close();
    await agent.shutdown();
  });
});
