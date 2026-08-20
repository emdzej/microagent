import { describe, it, expect } from "vitest";
import { Agent } from "../src/agent.js";
import type { LLMProvider, Message, ModelInfo, ToolDefinition, ToolPlugin } from "../src/types.js";

/**
 * A provider that replays a fixed script of responses, one per request.
 *
 * Optionally delays, so overlapping turns genuinely interleave if the agent
 * lets them.
 */
class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  currentModel = "scripted-model";
  requests: Message[][] = [];
  private index = 0;

  constructor(
    private script: Array<{ message: Message }>,
    private delayMs = 0
  ) {}

  setModel(model: string): void {
    this.currentModel = model;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  async chat(messages: Message[]) {
    // Snapshot the history as the provider saw it — this is what a real API
    // would receive, and what must never be malformed.
    this.requests.push(structuredClone(messages));
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));

    const next = this.script[Math.min(this.index++, this.script.length - 1)];
    return {
      message: next.message,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}

function echoTool(name: string): ToolPlugin {
  const definition: ToolDefinition = {
    name,
    description: "echo",
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
  };
  return {
    definition,
    async execute(args) {
      return `${name}:${String(args.value)}`;
    },
  };
}

/** Build an agent whose provider is replaced with a scripted one. */
function agentWith(provider: ScriptedProvider, tools: ToolPlugin[] = []) {
  const agent = new Agent({
    provider: { type: "ollama", model: "unused" },
    systemPrompt: "sys",
  });
  // The provider map is private; swap it for the scripted one.
  (agent as unknown as { _provider: LLMProvider })._provider = provider;
  (agent as unknown as { _providers: Map<string, LLMProvider> })._providers = new Map([
    ["ollama", provider],
  ]);
  for (const tool of tools) agent.tools.register(tool);
  return agent;
}

describe("tool call events", () => {
  it("passes the tool call id to onToolCall so results can be paired", async () => {
    const provider = new ScriptedProvider([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_a", name: "echo", arguments: { value: "first" } },
            { id: "call_b", name: "echo", arguments: { value: "second" } },
          ],
        },
      },
      { message: { role: "assistant", content: "done" } },
    ]);

    const agent = agentWith(provider, [echoTool("echo")]);

    const calls: Array<{ id: string; name: string }> = [];
    const results: Array<{ id: string; content: string }> = [];

    await agent.run("go", {
      onToolCall: (name, _args, id) => calls.push({ id, name }),
      onToolResult: (_name, result) =>
        results.push({ id: result.toolCallId, content: result.content }),
    });

    expect(calls).toEqual([
      { id: "call_a", name: "echo" },
      { id: "call_b", name: "echo" },
    ]);

    // Pairing by id gives the right answer even though both calls share a name.
    // Matching on name alone — as the server used to — would mis-assign these.
    const byId = new Map(results.map((r) => [r.id, r.content]));
    expect(byId.get("call_a")).toBe("echo:first");
    expect(byId.get("call_b")).toBe("echo:second");
  });
});

describe("concurrent turns", () => {
  /**
   * Regression test: `messages` is one array shared by all callers, so two
   * overlapping `run()` calls used to interleave their appends and produce a
   * history most providers reject with a 400.
   */
  it("serialises overlapping runs into a well-formed history", async () => {
    const provider = new ScriptedProvider(
      [{ message: { role: "assistant", content: "reply" } }],
      20
    );
    const agent = agentWith(provider);

    await Promise.all([agent.run("first"), agent.run("second"), agent.run("third")]);

    const messages = agent.getMessages();

    // system + 3 × (user, assistant)
    expect(messages).toHaveLength(7);
    expect(messages[0].role).toBe("system");

    // Turns must appear as clean user/assistant pairs, not interleaved.
    for (let i = 1; i < messages.length; i += 2) {
      expect(messages[i].role).toBe("user");
      expect(messages[i + 1].role).toBe("assistant");
    }

    // The prompts must arrive in submission order.
    expect(messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("keeps every tool message adjacent to the assistant turn that requested it", async () => {
    // Distinct ids per turn: with a shared id the ownership check below would be
    // satisfied by either turn's assistant message and prove nothing.
    let callSeq = 0;
    const provider = new ScriptedProvider([], 10);
    provider.chat = async (messages: Message[]) => {
      provider.requests.push(structuredClone(messages));
      await new Promise((r) => setTimeout(r, 10));
      // Alternate: request a tool, then finish.
      const pending = messages.at(-1)?.role === "tool";
      if (pending) {
        return {
          message: { role: "assistant", content: "final" } as Message,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      }
      const id = `call_${++callSeq}`;
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id, name: "echo", arguments: { value: id } }],
        } as Message,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    };

    const agent = agentWith(provider, [echoTool("echo")]);
    await Promise.all([agent.run("a"), agent.run("b")]);

    // Every `tool` message must be owned by the nearest preceding assistant
    // message. This is the invariant providers enforce with a 400.
    const messages = agent.getMessages();
    let toolMessages = 0;
    messages.forEach((m, i) => {
      if (m.role !== "tool") return;
      toolMessages++;
      const owner = messages.slice(0, i).reverse().find((p) => p.role === "assistant");
      expect(owner?.toolCalls?.some((t) => t.id === m.toolCallId)).toBe(true);
    });
    expect(toolMessages).toBe(2);
  });

  it("does not wedge the queue when one turn fails", async () => {
    let calls = 0;
    const provider = new ScriptedProvider([{ message: { role: "assistant", content: "ok" } }]);
    const original = provider.chat.bind(provider);
    provider.chat = async (messages: Message[]) => {
      if (++calls === 1) throw new Error("provider exploded");
      return original(messages);
    };

    const agent = agentWith(provider);

    await expect(agent.run("first")).rejects.toThrow("provider exploded");
    // A later turn must still run.
    await expect(agent.run("second")).resolves.toBe("ok");
  });
});
