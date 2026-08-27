import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApiKey, validateConfig, assertValidConfig, applyEnvOverrides } from "../src/config.js";
import type { MicroagentConfig } from "../src/types.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "microagent-secrets-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  delete process.env.TEST_API_KEY;
});

describe("resolveApiKey", () => {
  it("reads an environment variable", () => {
    process.env.TEST_API_KEY = "from-env";
    expect(resolveApiKey({ type: "openai", model: "m", apiKeyEnv: "TEST_API_KEY" })).toBe(
      "from-env"
    );
  });

  /**
   * A missing secret has to fail loudly at startup. Returning undefined would
   * surface later as a puzzling 401 from the provider, far from the cause.
   */
  it("throws when the named environment variable is unset", () => {
    expect(() => resolveApiKey({ type: "openai", model: "m", apiKeyEnv: "TEST_API_KEY" })).toThrow(
      /TEST_API_KEY is empty or unset/
    );
  });

  it("reads a file, which is how a mounted secret arrives", () => {
    const dir = tempDir();
    const file = join(dir, "key");
    writeFileSync(file, "from-file\n");
    expect(resolveApiKey({ type: "openai", model: "m", apiKeyFile: file })).toBe("from-file");
  });

  it("throws when the secret file is missing or empty", () => {
    const dir = tempDir();
    expect(() =>
      resolveApiKey({ type: "openai", model: "m", apiKeyFile: join(dir, "absent") })
    ).toThrow(/cannot read secret file/);

    const empty = join(dir, "empty");
    writeFileSync(empty, "  \n");
    expect(() => resolveApiKey({ type: "openai", model: "m", apiKeyFile: empty })).toThrow(
      /is empty/
    );
  });

  it("still accepts a literal, for the CLI's own dotfile", () => {
    expect(resolveApiKey({ type: "openai", model: "m", apiKey: "literal" })).toBe("literal");
  });
});

describe("validateConfig", () => {
  it("accepts a minimal valid config", () => {
    expect(validateConfig({ providers: [{ type: "ollama", model: "llama3" }] })).toEqual([]);
  });

  it("reports a missing provider list", () => {
    expect(validateConfig({})).toEqual([
      { path: "providers", message: "no providers configured" },
    ]);
  });

  it("rejects more than one secret source on a provider", () => {
    const problems = validateConfig({
      providers: [{ type: "openai", model: "m", apiKey: "a", apiKeyEnv: "B" }],
    });
    expect(problems).toContainEqual({
      path: "providers[0]",
      message: "set only one of apiKey, apiKeyEnv, apiKeyFile",
    });
  });

  it("catches duplicate provider names, which would shadow each other", () => {
    const problems = validateConfig({
      providers: [
        { type: "openai", model: "a" },
        { type: "openai", model: "b" },
      ],
    });
    expect(problems.some((p) => p.message.includes("duplicate provider name"))).toBe(true);
  });

  it("requires a region for bedrock", () => {
    const previous = process.env.AWS_REGION;
    delete process.env.AWS_REGION;
    try {
      const problems = validateConfig({ providers: [{ type: "bedrock", model: "claude-opus-5" }] });
      expect(problems).toContainEqual({
        path: "providers[0].region",
        message: "bedrock requires `region` or the AWS_REGION environment variable",
      });
    } finally {
      if (previous !== undefined) process.env.AWS_REGION = previous;
    }
  });

  it("validates MCP transports and catches duplicate server names", () => {
    const problems = validateConfig({
      providers: [{ type: "ollama", model: "m" }],
      mcpServers: [
        { name: "k8s", transport: "stdio" },
        { name: "k8s", transport: "http" },
      ],
    });
    expect(problems).toContainEqual({
      path: "mcpServers[0].command",
      message: "stdio transport requires `command`",
    });
    expect(problems).toContainEqual({
      path: "mcpServers[1].name",
      message: 'duplicate MCP server name "k8s"',
    });
    expect(problems).toContainEqual({
      path: "mcpServers[1].url",
      message: "http transport requires `url`",
    });
  });

  it('never tolerates "none" as a signature algorithm', () => {
    const problems = validateConfig({
      providers: [{ type: "ollama", model: "m" }],
      auth: { oidc: { issuer: "https://idp.example.com", algorithms: ["RS256", "none"] } },
    });
    expect(problems).toContainEqual({
      path: "auth.oidc.algorithms",
      message: '"none" is never an acceptable signature algorithm',
    });
  });

  it("requires an absolute issuer URL", () => {
    const problems = validateConfig({
      providers: [{ type: "ollama", model: "m" }],
      auth: { oidc: { issuer: "idp.example.com" } },
    });
    expect(problems).toContainEqual({
      path: "auth.oidc.issuer",
      message: "issuer must be an absolute http(s) URL",
    });
  });

  /**
   * A malformed config should fail the process, not degrade into a pod that
   * answers health checks while every request fails.
   */
  it("assertValidConfig lists every problem at once", () => {
    expect(() => assertValidConfig({ providers: [{ type: "", model: "" }] })).toThrow(
      /providers\[0\].type[\s\S]*providers\[0\].model/
    );
  });
});

describe("applyEnvOverrides", () => {
  it("lets a container configure OIDC without a config file", () => {
    const base: MicroagentConfig = { providers: [{ type: "ollama", model: "m" }] };
    const merged = applyEnvOverrides(base, {
      MICROAGENT_OIDC_ISSUER: "https://idp.example.com/realms/x",
      MICROAGENT_OIDC_AUDIENCE: "microagent",
      MICROAGENT_OIDC_CLIENT_ID: "microagent-cli",
    } as NodeJS.ProcessEnv);

    expect(merged.auth?.oidc).toEqual({
      issuer: "https://idp.example.com/realms/x",
      audience: "microagent",
      clientIdHint: "microagent-cli",
    });
  });

  it("can disable config writes for a read-only root filesystem", () => {
    const merged = applyEnvOverrides({}, {
      MICROAGENT_ALLOW_CONFIG_WRITES: "false",
    } as NodeJS.ProcessEnv);
    expect(merged.allowConfigWrites).toBe(false);
  });

  it("does not mutate the input", () => {
    const base: MicroagentConfig = { systemPrompt: "original" };
    applyEnvOverrides(base, { MICROAGENT_SYSTEM_PROMPT: "changed" } as NodeJS.ProcessEnv);
    expect(base.systemPrompt).toBe("original");
  });
});
