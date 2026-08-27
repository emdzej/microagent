import { describe, it, expect } from "vitest";
import { ToolRegistry, ToolCollisionError } from "../src/tool-registry.js";
import type { ToolPlugin } from "../src/types.js";

function tool(name: string, result = "ok"): ToolPlugin {
  return {
    definition: { name, description: name, inputSchema: { type: "object" } },
    async execute() {
      return result;
    },
  };
}

describe("tool name collisions", () => {
  /**
   * The latent bug this replaces: `register` was a bare `Map.set`, so a second
   * tool with the same name silently shadowed the first. The model then calls a
   * tool belonging to somewhere else, with no error and nothing in the logs to
   * explain the result.
   */
  it("rejects a duplicate name by default", () => {
    const registry = new ToolRegistry();
    registry.register(tool("search", "from-a"), { source: "kubernetes" });

    expect(() => registry.register(tool("search", "from-b"), { source: "grafana" })).toThrow(
      ToolCollisionError
    );
    expect(() => registry.register(tool("search"), { source: "grafana" })).toThrow(
      /already registered \(from kubernetes and grafana\)/
    );
  });

  it("keeps the original when a collision is skipped", async () => {
    const registry = new ToolRegistry();
    registry.register(tool("search", "from-a"), { source: "a" });
    registry.register(tool("search", "from-b"), { source: "b", onConflict: "skip" });

    const result = await registry.execute({ id: "1", name: "search", arguments: {} });
    expect(result.content).toBe("from-a");
    expect(registry.sourceOf("search")).toBe("a");
  });

  it("replaces only when asked explicitly", async () => {
    const registry = new ToolRegistry();
    registry.register(tool("search", "from-a"), { source: "a" });
    registry.register(tool("search", "from-b"), { source: "b", onConflict: "replace" });

    const result = await registry.execute({ id: "1", name: "search", arguments: {} });
    expect(result.content).toBe("from-b");
  });
});

describe("unavailable tools", () => {
  /**
   * If a dead server's tools simply vanished, the model would see a shorter
   * tool list and quietly work around the gap — producing an answer that reads
   * as complete while silently omitting whatever that server was for.
   */
  it("keeps the definition but fails the call with a clear reason", async () => {
    const registry = new ToolRegistry();
    registry.register(tool("kubernetes__get_pods"), { source: "kubernetes" });

    registry.setSourceAvailability("kubernetes", false, "connection closed");

    // Still advertised to the model...
    expect(registry.getDefinitions().map((d) => d.name)).toEqual(["kubernetes__get_pods"]);
    expect(registry.isAvailable("kubernetes__get_pods")).toBe(false);

    // ...but the call reports the outage rather than silently doing nothing.
    const result = await registry.execute({
      id: "1",
      name: "kubernetes__get_pods",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unavailable");
    expect(result.content).toContain("connection closed");
  });

  it("restores availability on reconnect", async () => {
    const registry = new ToolRegistry();
    registry.register(tool("srv__thing"), { source: "srv" });
    registry.setSourceAvailability("srv", false, "gone");
    registry.setSourceAvailability("srv", true);

    const result = await registry.execute({ id: "1", name: "srv__thing", arguments: {} });
    expect(result.isError).toBeUndefined();
  });
});

describe("tool execution failures", () => {
  it("names the available tools when one is unknown", async () => {
    const registry = new ToolRegistry();
    registry.register(tool("known"));

    const result = await registry.execute({ id: "1", name: "typo", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown tool: typo");
    expect(result.content).toContain("known");
  });

  it("turns a throwing tool into an error result rather than a rejection", async () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: { name: "bad", description: "", inputSchema: { type: "object" } },
      async execute() {
        throw new Error("disk on fire");
      },
    });

    const result = await registry.execute({ id: "1", name: "bad", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("disk on fire");
  });

  it("reports a timeout distinctly from a cancellation", async () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: { name: "slow", description: "", inputSchema: { type: "object" } },
      async execute(_args, ctx) {
        await new Promise((resolve, reject) => {
          ctx?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          setTimeout(resolve, 5000);
        });
        return "never";
      },
    });

    const timedOut = await registry.execute(
      { id: "1", name: "slow", arguments: {} },
      { timeoutMs: 20 }
    );
    expect(timedOut.content).toContain("timed out after 20ms");

    const controller = new AbortController();
    const cancelled = registry.execute(
      { id: "2", name: "slow", arguments: {} },
      { signal: controller.signal, timeoutMs: 5000 }
    );
    controller.abort();
    expect((await cancelled).content).toContain("was cancelled");
  });
});
