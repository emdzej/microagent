import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistModel } from "../src/config.js";
import type { MicroagentConfig } from "../src/types.js";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "microagent-config-"));
  configPath = join(dir, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(config: unknown) {
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function read(): MicroagentConfig {
  return JSON.parse(readFileSync(configPath, "utf-8")) as MicroagentConfig;
}

describe("persistModel", () => {
  it("updates the matching entry in a providers array and marks it active", () => {
    write({
      providers: [
        { type: "ollama", model: "llama3.2" },
        { type: "openai", model: "gpt-4o", name: "work" },
      ],
    });

    expect(persistModel(configPath, "work", "gpt-4o-mini")).toBe(true);

    const after = read();
    expect(after.providers?.[1].model).toBe("gpt-4o-mini");
    expect(after.providers?.[0].model).toBe("llama3.2");
    expect(after.activeProvider).toBe("work");
  });

  it("updates a legacy single provider when it is the one being switched", () => {
    write({ provider: { type: "ollama", model: "llama3.2" } });
    expect(persistModel(configPath, "ollama", "qwen2.5")).toBe(true);
    expect(read().provider?.model).toBe("qwen2.5");
  });

  /**
   * Regression test. The legacy branch used to write unconditionally, so
   * starting with `-p ollama` against a `github-copilot` config and switching
   * models stamped an Ollama model onto the Copilot entry.
   */
  it("leaves a non-matching legacy provider untouched", () => {
    write({ provider: { type: "github-copilot", model: "gpt-5-mini" } });

    expect(persistModel(configPath, "ollama", "qwen2.5")).toBe(false);

    const after = read();
    expect(after.provider?.type).toBe("github-copilot");
    expect(after.provider?.model).toBe("gpt-5-mini");
  });

  it("preserves unrelated keys and trailing newline", () => {
    write({
      providers: [{ type: "ollama", model: "llama3.2" }],
      systemPrompt: "keep me",
      mcpServers: [{ name: "fs", transport: "stdio", command: "x" }],
    });

    persistModel(configPath, "ollama", "qwen2.5");

    const raw = readFileSync(configPath, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);

    const after = read();
    expect(after.systemPrompt).toBe("keep me");
    expect(after.mcpServers).toHaveLength(1);
  });

  it("returns false for a missing file rather than creating one", () => {
    expect(persistModel(join(dir, "nope.json"), "ollama", "x")).toBe(false);
  });

  it("returns false for an unparseable file rather than clobbering it", () => {
    writeFileSync(configPath, "{ not json");
    expect(persistModel(configPath, "ollama", "x")).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toBe("{ not json");
  });

  it("returns false when the config has no providers at all", () => {
    write({ systemPrompt: "only this" });
    expect(persistModel(configPath, "ollama", "x")).toBe(false);
  });
});
