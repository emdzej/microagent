import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { MicroagentConfig, ProviderConfig } from "./types.js";
import { resolveProviders } from "./types.js";

/**
 * Persist a model switch back to the config file.
 *
 * Re-reads the file rather than serialising an in-memory config, so unrelated
 * keys and hand-written formatting survive.
 *
 * Lives here because both the HTTP server and the CLI's `/model` command need
 * it. They previously each had their own copy, and both copies shared the same
 * bug: the legacy single-`provider` branch wrote the new model unconditionally,
 * without checking that the entry on disk was the provider being switched. So
 * starting with `-p ollama` against a `github-copilot` config and switching
 * models would write an Ollama model onto the Copilot entry.
 *
 * @returns true if the file was updated.
 */
export function persistModel(
  configPath: string,
  providerName: string,
  model: string
): boolean {
  if (!existsSync(configPath)) return false;

  let raw: MicroagentConfig;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8")) as MicroagentConfig;
  } catch {
    return false;
  }

  // A container with a read-only root filesystem must not attempt the write at
  // all — the failure there is a crash loop, not a lost preference.
  if (raw.allowConfigWrites === false) return false;

  const matches = (p: { name?: string; type: string }) =>
    (p.name ?? p.type) === providerName || p.type === providerName;

  if (raw.providers?.length) {
    const entry = raw.providers.find(matches);
    if (entry) entry.model = model;
    raw.activeProvider = providerName;
  } else if (raw.provider) {
    // Only touch the legacy single provider when it is the one being switched.
    if (!matches(raw.provider)) return false;
    raw.provider.model = model;
  } else {
    return false;
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n");
  return true;
}

// ── Secrets ────────────────────────────────────────────────────────────────

/**
 * Resolve a provider's API key from, in order: an env var, a file, the literal.
 *
 * The env var and file forms exist so a cluster deployment never has a secret
 * sitting in a config file — the file form in particular is how a mounted
 * Kubernetes secret arrives. The literal is kept for the CLI, where the config
 * file is the user's own dotfile.
 *
 * @throws when a named source is configured but unreadable. A missing secret is
 * a startup failure, not something to paper over with an empty string that
 * later produces a puzzling 401.
 */
export function resolveApiKey(provider: ProviderConfig): string | undefined {
  if (provider.apiKeyEnv) {
    const value = process.env[provider.apiKeyEnv];
    if (!value) {
      throw new Error(
        `Provider "${provider.name ?? provider.type}": environment variable ${provider.apiKeyEnv} is empty or unset`
      );
    }
    return value;
  }

  if (provider.apiKeyFile) {
    try {
      const value = readFileSync(provider.apiKeyFile, "utf-8").trim();
      if (!value) {
        throw new Error(
          `Provider "${provider.name ?? provider.type}": secret file ${provider.apiKeyFile} is empty`
        );
      }
      return value;
    } catch (err) {
      if (err instanceof Error && err.message.includes("is empty")) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Provider "${provider.name ?? provider.type}": cannot read secret file ${provider.apiKeyFile}: ${msg}`,
        { cause: err }
      );
    }
  }

  return provider.apiKey;
}

// ── Boot validation ────────────────────────────────────────────────────────

export interface ConfigProblem {
  path: string;
  message: string;
}

/**
 * Check a config before anything uses it.
 *
 * A malformed config should fail the process at startup with a clear message,
 * not degrade quietly into a pod that answers health checks while every request
 * fails. Returns the problems rather than throwing so a caller can report all
 * of them at once.
 */
export function validateConfig(config: MicroagentConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = [];

  const providers = resolveProviders(config);
  if (!providers.length) {
    problems.push({ path: "providers", message: "no providers configured" });
  }

  const seen = new Set<string>();
  providers.forEach((p, i) => {
    const at = `providers[${i}]`;
    if (!p.type) problems.push({ path: `${at}.type`, message: "missing provider type" });
    if (!p.model) problems.push({ path: `${at}.model`, message: "missing model" });

    const name = p.name ?? p.type;
    if (name && seen.has(name)) {
      problems.push({
        path: `${at}.name`,
        message: `duplicate provider name "${name}" — set a distinct \`name\``,
      });
    }
    seen.add(name);

    const sources = [p.apiKey, p.apiKeyEnv, p.apiKeyFile].filter(Boolean).length;
    if (sources > 1) {
      problems.push({
        path: at,
        message: "set only one of apiKey, apiKeyEnv, apiKeyFile",
      });
    }
    if (p.type === "bedrock" && !p.region && !process.env.AWS_REGION) {
      problems.push({
        path: `${at}.region`,
        message: "bedrock requires `region` or the AWS_REGION environment variable",
      });
    }
  });

  const mcpNames = new Set<string>();
  (config.mcpServers ?? []).forEach((server, i) => {
    const at = `mcpServers[${i}]`;
    if (!server.name) problems.push({ path: `${at}.name`, message: "missing server name" });
    if (server.name && mcpNames.has(server.name)) {
      problems.push({ path: `${at}.name`, message: `duplicate MCP server name "${server.name}"` });
    }
    if (server.name) mcpNames.add(server.name);

    if (server.transport === "stdio" && !server.command) {
      problems.push({ path: `${at}.command`, message: "stdio transport requires `command`" });
    }
    if (server.transport === "http" && !server.url) {
      problems.push({ path: `${at}.url`, message: "http transport requires `url`" });
    }
    if (server.transport !== "stdio" && server.transport !== "http") {
      problems.push({
        path: `${at}.transport`,
        message: `unknown transport "${String(server.transport)}" — expected stdio or http`,
      });
    }
  });

  const oidc = config.auth?.oidc;
  if (config.auth?.enabled && !oidc) {
    problems.push({ path: "auth.oidc", message: "auth is enabled but no oidc block is configured" });
  }
  if (oidc) {
    if (!oidc.issuer) {
      problems.push({ path: "auth.oidc.issuer", message: "missing issuer" });
    } else if (!/^https?:\/\//.test(oidc.issuer)) {
      problems.push({ path: "auth.oidc.issuer", message: "issuer must be an absolute http(s) URL" });
    }
    if (oidc.algorithms?.some((a) => a.toLowerCase() === "none")) {
      problems.push({
        path: "auth.oidc.algorithms",
        message: '"none" is never an acceptable signature algorithm',
      });
    }
  }

  return problems;
}

/**
 * Validate and throw on the first problem, listing all of them.
 *
 * Call this at process start. Failing here is the point.
 */
export function assertValidConfig(config: MicroagentConfig): void {
  const problems = validateConfig(config);
  if (!problems.length) return;
  const detail = problems.map((p) => `  - ${p.path}: ${p.message}`).join("\n");
  throw new Error(`Invalid microagent configuration:\n${detail}`);
}

/**
 * Overlay environment variables onto a config.
 *
 * Lets a container be configured without a config file at all, and lets a
 * mounted file be adjusted per environment without rewriting it.
 */
export function applyEnvOverrides(
  config: MicroagentConfig,
  env: NodeJS.ProcessEnv = process.env
): MicroagentConfig {
  const next: MicroagentConfig = { ...config };

  if (env.MICROAGENT_SYSTEM_PROMPT) next.systemPrompt = env.MICROAGENT_SYSTEM_PROMPT;
  if (env.MICROAGENT_ACTIVE_PROVIDER) next.activeProvider = env.MICROAGENT_ACTIVE_PROVIDER;
  if (env.MICROAGENT_ALLOW_CONFIG_WRITES) {
    next.allowConfigWrites = env.MICROAGENT_ALLOW_CONFIG_WRITES !== "false";
  }

  if (env.MICROAGENT_OIDC_ISSUER) {
    next.auth = {
      ...next.auth,
      oidc: {
        ...next.auth?.oidc,
        issuer: env.MICROAGENT_OIDC_ISSUER,
        audience: env.MICROAGENT_OIDC_AUDIENCE ?? next.auth?.oidc?.audience,
        clientIdHint: env.MICROAGENT_OIDC_CLIENT_ID ?? next.auth?.oidc?.clientIdHint,
      },
    };
  }
  if (env.MICROAGENT_AUTH_DISABLED === "true") {
    next.auth = { ...next.auth, enabled: false };
  }

  return next;
}
