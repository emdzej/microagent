import { describe, it, expect } from "vitest";
import { applyOverrides } from "../src/config.js";
import { resolveActiveProvider, resolveProviders } from "@microagent/core";
import type { MicroagentConfig } from "@microagent/core";

function baseConfig(): MicroagentConfig {
  return {
    providers: [
      { type: "ollama", model: "llama3.2" },
      { type: "openai", model: "gpt-4o", name: "work" },
    ],
  };
}

describe("applyOverrides", () => {
  it("applies a model override to the active provider only", () => {
    const config = applyOverrides(baseConfig(), { model: "qwen2.5" });

    expect(resolveActiveProvider(config).model).toBe("qwen2.5");
    // The other provider is untouched.
    expect(resolveProviders(config)[1].model).toBe("gpt-4o");
  });

  it("switches the active provider by name", () => {
    const config = applyOverrides(baseConfig(), { provider: "work" });
    expect(resolveActiveProvider(config).name ?? resolveActiveProvider(config).type).toBe("work");
  });

  /**
   * The behaviour the README documents. `loadConfig` used to return as soon as
   * it found a config file, so these flags were silently discarded.
   */
  it("honours provider and model flags together against a loaded config", () => {
    const config = applyOverrides(baseConfig(), { provider: "work", model: "gpt-4o-mini" });

    const active = resolveActiveProvider(config);
    expect(active.name ?? active.type).toBe("work");
    expect(active.model).toBe("gpt-4o-mini");
  });

  it("adds a provider that is not in the config rather than ignoring the flag", () => {
    const config = applyOverrides(baseConfig(), {
      provider: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
    });

    const active = resolveActiveProvider(config);
    expect(active.type).toBe("groq");
    expect(active.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(resolveProviders(config)).toHaveLength(3);
  });

  it("works on a legacy single-provider config", () => {
    const config = applyOverrides(
      { provider: { type: "ollama", model: "llama3.2" } },
      { model: "phi4" }
    );
    expect(resolveActiveProvider(config).model).toBe("phi4");
  });

  it("migrates a legacy config to the array form when adding a provider", () => {
    const config = applyOverrides(
      { provider: { type: "ollama", model: "llama3.2" } },
      { provider: "openai" }
    );
    expect(config.provider).toBeUndefined();
    expect(resolveProviders(config)).toHaveLength(2);
    expect(resolveActiveProvider(config).type).toBe("openai");
  });

  it("overrides the system prompt", () => {
    const config = applyOverrides({ ...baseConfig(), systemPrompt: "old" }, { system: "new" });
    expect(config.systemPrompt).toBe("new");
  });

  it("leaves the config untouched when no flags are passed", () => {
    const before = baseConfig();
    const after = applyOverrides(baseConfig(), {});
    expect(after).toEqual(before);
  });

  it("applies base URL and API key to the active provider", () => {
    const config = applyOverrides(baseConfig(), {
      baseUrl: "http://localhost:1234/v1",
      apiKey: "sk-test",
    });
    const active = resolveActiveProvider(config);
    expect(active.baseUrl).toBe("http://localhost:1234/v1");
    expect(active.apiKey).toBe("sk-test");
  });
});
