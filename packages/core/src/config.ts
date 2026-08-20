import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { MicroagentConfig } from "./types.js";

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
