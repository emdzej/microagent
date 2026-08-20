import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { MicroagentConfig } from "@microagent/core";
import { paths, resolveProviders, resolveActiveProvider } from "@microagent/core";

export const DEFAULT_PROVIDER = "ollama";
export const DEFAULT_MODEL = "llama3.2";
const DEFAULT_SYSTEM_PROMPT = "You are a helpful coding assistant. Be concise.";

/**
 * Apply CLI flags on top of a config loaded from disk.
 *
 * Without this, `loadConfig` returned as soon as it found a file and every
 * provider flag was silently discarded — so `-p github-copilot -m gpt-4o` did
 * nothing whenever a config file existed, despite the README documenting it.
 *
 * The provider flags deliberately carry no commander defaults, so "not passed"
 * is distinguishable from "passed the default value"; defaults are applied only
 * when synthesising a config from scratch.
 */
export function applyOverrides(
  config: MicroagentConfig,
  opts: Record<string, string | undefined>
): MicroagentConfig {
  if (opts.system) config.systemPrompt = opts.system;

  const matches = (p: { name?: string; type: string }, wanted: string) =>
    (p.name ?? p.type) === wanted || p.type === wanted;

  // Naming a provider makes it active. If it is not configured, add it, so
  // `-p openai` works against a config that has never heard of openai.
  if (opts.provider) {
    const known = resolveProviders(config).some((p) => matches(p, opts.provider!));
    if (!known) {
      const entry = {
        type: opts.provider,
        model: opts.model ?? DEFAULT_MODEL,
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
      };
      config.providers = [...resolveProviders(config), entry];
      delete config.provider;
    }
    config.activeProvider = opts.provider;
  }

  if (!opts.model && !opts.baseUrl && !opts.apiKey) return config;

  // Remaining flags apply to whichever provider is now active.
  let active;
  try {
    active = resolveActiveProvider(config);
  } catch {
    return config;
  }

  if (opts.model) active.model = opts.model;
  if (opts.baseUrl) active.baseUrl = opts.baseUrl;
  if (opts.apiKey) active.apiKey = opts.apiKey;

  return config;
}

export function loadConfig(opts: Record<string, string>): { config: MicroagentConfig; configPath: string | null } {
  const read = (path: string) =>
    JSON.parse(readFileSync(path, "utf-8")) as MicroagentConfig;

  // Explicit --config flag
  if (opts.config) {
    const cfgPath = resolve(opts.config);
    if (!existsSync(cfgPath)) {
      console.error(`Config file not found: ${cfgPath}`);
      process.exit(1);
    }
    return { config: applyOverrides(read(cfgPath), opts), configPath: cfgPath };
  }

  // Auto-discover: XDG config dir, then local file
  const candidates = [paths.configFile(), resolve("microagent.config.json")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { config: applyOverrides(read(candidate), opts), configPath: candidate };
    }
  }

  // Fallback to CLI flags — no config file to persist to
  return {
    config: {
      provider: {
        type: opts.provider ?? DEFAULT_PROVIDER,
        model: opts.model ?? DEFAULT_MODEL,
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
      },
      systemPrompt: opts.system ?? DEFAULT_SYSTEM_PROMPT,
    },
    configPath: null,
  };
}
