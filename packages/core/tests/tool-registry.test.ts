import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../src/tool-registry.js";
import type { ToolPlugin } from "../src/types.js";

const echoTool: ToolPlugin = {
  definition: {
    name: "echo",
    description: "Echoes back the input",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
  async execute(args) {
    return `echo: ${args.message}`;
  },
};

describe("ToolRegistry", () => {
  it("registers and lists tools", () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    expect(registry.list()).toEqual(["echo"]);
    expect(registry.getDefinitions()).toHaveLength(1);
    expect(registry.getDefinitions()[0].name).toBe("echo");
  });

  it("executes a registered tool", async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    const result = await registry.execute({
      id: "test-1",
      name: "echo",
      arguments: { message: "hello" },
    });
    expect(result.content).toBe("echo: hello");
    expect(result.isError).toBeUndefined();
  });

  it("returns error for unknown tool", async () => {
    const registry = new ToolRegistry();
    const result = await registry.execute({
      id: "test-2",
      name: "nope",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown tool");
  });

  it("unregisters tools", () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    expect(registry.list()).toHaveLength(1);
    registry.unregister("echo");
    expect(registry.list()).toHaveLength(0);
  });
});
