import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { OpenAIProviderOptions } from "./openai-compatible.js";
import type { ProviderConfig, LLMProvider, ModelInfo } from "../types.js";
import { getCopilotToken } from "./github-auth.js";
import type { DeviceFlowCallbacks } from "./github-auth.js";

/** Pre-configured presets — just add model + optional overrides */
const PRESETS: Record<string, (config: ProviderConfig) => OpenAIProviderOptions> = {
  ollama: (c) => ({
    name: "ollama",
    model: c.model,
    baseUrl: c.baseUrl ?? "http://localhost:11434/v1",
  }),

  "github-copilot": (c) => ({
    name: "github-copilot",
    model: c.model,
    baseUrl: c.baseUrl ?? "https://api.githubcopilot.com",
    getApiKey: () => getCopilotToken(),
    headers: { "Copilot-Integration-Id": "vscode-chat" },
  }),

  openai: (c) => ({
    name: "openai",
    model: c.model,
    baseUrl: c.baseUrl ?? "https://api.openai.com/v1",
    apiKey: c.apiKey ?? process.env.OPENAI_API_KEY,
  }),
};

/** Create a provider from config — uses presets or falls back to raw OpenAI-compat */
export function createProvider(config: ProviderConfig): LLMProvider {
  const preset = PRESETS[config.type];
  if (preset) {
    return new OpenAICompatibleProvider(preset(config));
  }
  // Fallback: treat type as a custom OpenAI-compatible endpoint
  return new OpenAICompatibleProvider({
    name: config.type,
    model: config.model,
    baseUrl: config.baseUrl ?? "",
    apiKey: config.apiKey,
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
