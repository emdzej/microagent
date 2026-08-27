import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { OpenAIProviderOptions } from "./openai-compatible.js";
import { BedrockProvider } from "./bedrock.js";
import type { ProviderConfig, LLMProvider, ModelInfo } from "../types.js";
import { resolveApiKey } from "../config.js";
import { getCopilotToken } from "./github-auth.js";
import type { DeviceFlowCallbacks } from "./github-auth.js";

/** Pre-configured presets — just add model + optional overrides */
const PRESETS: Record<string, (config: ProviderConfig) => OpenAIProviderOptions> = {
  ollama: (c) => ({
    name: "ollama",
    model: c.model,
    baseUrl: c.baseUrl ?? "http://localhost:11434/v1",
    maxTokens: c.maxTokens,
  }),

  "github-copilot": (c) => ({
    name: "github-copilot",
    model: c.model,
    baseUrl: c.baseUrl ?? "https://api.githubcopilot.com",
    getApiKey: () => getCopilotToken(),
    headers: { "Copilot-Integration-Id": "vscode-chat" },
    maxTokens: c.maxTokens,
  }),

  openai: (c) => ({
    name: "openai",
    model: c.model,
    baseUrl: c.baseUrl ?? "https://api.openai.com/v1",
    // `resolveApiKey` covers the env-var and file forms, so a cluster
    // deployment never needs a literal key in its config file.
    apiKey: resolveApiKey(c) ?? process.env.OPENAI_API_KEY,
    maxTokens: c.maxTokens,
  }),
};

/** Create a provider from config — uses presets or falls back to raw OpenAI-compat */
export function createProvider(config: ProviderConfig): LLMProvider {
  if (config.type === "bedrock") {
    return new BedrockProvider({
      name: config.name ?? "bedrock",
      model: config.model,
      region: config.region,
      maxTokens: config.maxTokens,
      thinking: config.thinking,
      effort: config.effort,
    });
  }

  const preset = PRESETS[config.type];
  if (preset) {
    return new OpenAICompatibleProvider(preset(config));
  }
  // Fallback: treat type as a custom OpenAI-compatible endpoint
  return new OpenAICompatibleProvider({
    name: config.name ?? config.type,
    model: config.model,
    baseUrl: config.baseUrl ?? "",
    apiKey: resolveApiKey(config),
    maxTokens: config.maxTokens,
  });
}

/**
 * List available models for a provider type.
 * Creates a temporary provider instance just for the models query.
 * For github-copilot, this triggers the device auth flow if needed.
 */
export async function listModelsForProvider(
  type: string,
  opts?: { baseUrl?: string; apiKey?: string; authCallbacks?: DeviceFlowCallbacks }
): Promise<ModelInfo[]> {
  // For Copilot, we need to authenticate first with callbacks,
  // then create a provider with the resolved token
  if (type === "github-copilot") {
    const token = await getCopilotToken(opts?.authCallbacks);
    const provider = new OpenAICompatibleProvider({
      name: "github-copilot",
      model: "",
      baseUrl: opts?.baseUrl ?? "https://api.githubcopilot.com",
      apiKey: token,
    headers: { "Copilot-Integration-Id": "vscode-chat" },
    });
    return provider.listModels();
  }

  const config: ProviderConfig = {
    type,
    model: "",
    baseUrl: opts?.baseUrl,
    apiKey: opts?.apiKey,
  };
  const provider = createProvider(config);
  return provider.listModels();
}
