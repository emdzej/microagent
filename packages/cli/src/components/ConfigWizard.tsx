import React, { useState, useEffect } from "react";
import { Box, Text, useApp } from "ink";
import { Select, TextInput, ConfirmInput } from "@inkjs/ui";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { MicroagentConfig, McpServerConfig, ModelInfo } from "@microagent/core";
import { paths, listModelsForProvider } from "@microagent/core";

type Step =
  | "provider"
  | "baseUrl"
  | "apiKey"
  | "fetchModels"
  | "model"
  | "modelManual"
  | "addAnotherProvider"
  | "systemPrompt"
  | "addMcp"
  | "mcpName"
  | "mcpTransport"
  | "mcpCommand"
  | "mcpUrl"
  | "outputPath"
  | "done";

const PROVIDER_OPTIONS = [
  { label: "Ollama (local, free)", value: "ollama" },
  { label: "GitHub Copilot (requires subscription)", value: "github-copilot" },
  { label: "OpenAI", value: "openai" },
  { label: "Custom (any OpenAI-compatible endpoint)", value: "custom" },
];

const MODEL_SUGGESTIONS: Record<string, string> = {
  ollama: "llama3.2",
  "github-copilot": "gpt-4o",
  openai: "gpt-4o",
  custom: "gpt-4o",
};

const BASE_URL_DEFAULTS: Record<string, string> = {
  ollama: "http://localhost:11434/v1",
  "github-copilot": "https://api.githubcopilot.com",
  openai: "https://api.openai.com/v1",
  custom: "",
};

interface Props {
  outputPath: string;
}

export const ConfigWizard: React.FC<Props> = ({ outputPath: initialOutput }) => {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>("provider");

  // Config state
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [configuredProviders, setConfiguredProviders] = useState<Array<{ type: string; model: string; baseUrl?: string; apiKey?: string }>>([]);
  const [systemPrompt, setSystemPrompt] = useState(
    "You are a helpful coding assistant. Be concise and precise. Use the available tools when needed."
  );
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [currentMcp, setCurrentMcp] = useState<Partial<McpServerConfig>>({});
  const [outPath, setOutPath] = useState(initialOutput);

  // Model fetching state
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [fetchError, setFetchError] = useState("");
  const [authHint, setAuthHint] = useState("");

  const needsApiKey = provider === "openai" || provider === "custom";
  const needsBaseUrl = provider === "custom";

  // Determine the step after provider auth/config is done
  function nextStepAfterProvider() {
    return needsBaseUrl ? "baseUrl" : needsApiKey ? "apiKey" : "fetchModels";
  }

  function saveConfig() {
    const allProviders = [...configuredProviders];
    const config: MicroagentConfig = {
      providers: allProviders.map((p) => ({
        type: p.type,
        model: p.model,
        ...(p.baseUrl && p.baseUrl !== BASE_URL_DEFAULTS[p.type] ? { baseUrl: p.baseUrl } : {}),
        ...(p.apiKey ? { apiKey: p.apiKey } : {}),
      })),
      activeProvider: allProviders[0]?.type,
      systemPrompt,
      mcpServers: mcpServers.length ? mcpServers : undefined,
    };

    const resolved = resolve(outPath);
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return resolved;
  }

  // ── Fetch models when entering fetchModels step ────────────────
  useEffect(() => {
    if (step !== "fetchModels") return;
    let cancelled = false;

    setModels([]);
    setFetchError("");
    setAuthHint(`Connecting to ${provider}...`);

    listModelsForProvider(provider, {
      baseUrl: baseUrl || undefined,
      apiKey: apiKey || undefined,
      authCallbacks: {
        onUserCode(code, uri) {
          if (!cancelled) setAuthHint(`Go to ${uri} and enter code: ${code}`);
        },
        onPolling() {
          // keep showing the code/url hint
        },
        onComplete() {
          if (!cancelled) setAuthHint("Authenticated! Fetching models...");
        },
        onError(message) {
          if (!cancelled) setAuthHint(`Auth error: ${message}`);
        },
      },
    })
      .then((result) => {
        if (cancelled) return;
        setAuthHint("");
        if (result.length > 0) {
          setModels(result);
          setStep("model");
        } else {
          setFetchError("No models returned. You can enter a model name manually.");
          setStep("modelManual");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setAuthHint("");
        const msg = err instanceof Error ? err.message : String(err);
        setFetchError(`Could not fetch models: ${msg}`);
        setStep("modelManual");
      });

    return () => { cancelled = true; };
  }, [step, provider, baseUrl, apiKey]);

  // ── Provider selection ─────────────────────────────────────────
  if (step === "provider") {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text bold color="cyan">microagent config wizard</Text>
        <Text>Select your LLM provider:</Text>
        <Select
          options={PROVIDER_OPTIONS}
          onChange={(val) => {
            setProvider(val);
            setModel(MODEL_SUGGESTIONS[val] ?? "");
            setBaseUrl(BASE_URL_DEFAULTS[val] ?? "");
            setStep(
              val === "custom" ? "baseUrl" : (val === "openai" || val === "custom") ? "apiKey" : "fetchModels"
            );
          }}
        />
      </Box>
    );
  }

  // ── Base URL (custom only) ─────────────────────────────────────
  if (step === "baseUrl") {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text bold color="cyan">Base URL</Text>
        <Text>Enter the OpenAI-compatible endpoint base URL:</Text>
        <TextInput
          defaultValue={baseUrl}
          placeholder="https://api.example.com/v1"
          onSubmit={(val) => {
            setBaseUrl(val);
            setStep("apiKey");
          }}
        />
      </Box>
    );
  }

  // ── API Key ────────────────────────────────────────────────────
  if (step === "apiKey") {
    const envHint =
      provider === "openai"
        ? " (or set OPENAI_API_KEY env)"
        : "";
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text bold color="cyan">API Key</Text>
        <Text>Enter API key{envHint}:</Text>
        <Text dimColor>Leave empty to use environment variable at runtime</Text>
        <TextInput
          placeholder="sk-..."
          onSubmit={(val) => {
            setApiKey(val);
            setStep("fetchModels");
          }}
        />
      </Box>
    );
  }

  // ── Fetching models (loading state) ────────────────────────────
  if (step === "fetchModels") {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text bold color="cyan">Models</Text>
        <Text color="yellow">{authHint || "Connecting..."}</Text>
      </Box>
    );
  }

  // ── Select model from list ─────────────────────────────────────
  if (step === "model") {
    const options = models.map((m) => ({ label: m.id, value: m.id }));
    // Add manual entry option at the end
    options.push({ label: "[ Enter manually ]", value: "__manual__" });

    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text bold color="cyan">Select Model</Text>
        <Text dimColor>Provider: {provider} | {models.length} model(s) available</Text>
        <Select
          options={options}
          onChange={(val) => {
            if (val === "__manual__") {
              setStep("modelManual");
            } else {
              setModel(val);
              setConfiguredProviders((prev) => [...prev, { type: provider, model: val, baseUrl, apiKey }]);
              setStep("addAnotherProvider");
            }
          }}
        />
      </Box>
    );
  }

  // ── Manual model entry (fallback) ──────────────────────────────
  if (step === "modelManual") {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text bold color="cyan">Model</Text>
        {fetchError && <Text color="yellow">{fetchError}</Text>}
        <Text dimColor>Provider: {provider} | Default: {MODEL_SUGGESTIONS[provider]}</Text>
        <Text>Enter model name:</Text>
        <TextInput
          defaultValue={model}
          placeholder={MODEL_SUGGESTIONS[provider]}
          onSubmit={(val) => {
            const m = val || MODEL_SUGGESTIONS[provider];
            setModel(m);
            setConfiguredProviders((prev) => [...prev, { type: provider, model: m, baseUrl, apiKey }]);
            setStep("addAnotherProvider");
          }}
        />
      </Box>
    );
  }

  // ── Add another provider? ───────────────────────────────────────
  if (step === "addAnotherProvider") {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text bold color="cyan">Providers configured ({configuredProviders.length})</Text>
        {configuredProviders.map((p, i) => (
          <Text key={i} color="green">  - {p.type} → {p.model}</Text>
        ))}
        <Text>Add another provider? (Y/n)</Text>
        <ConfirmInput
          defaultChoice="cancel"
          onConfirm={() => {
            // Reset current provider state for next provider
            setProvider("");
            setModel("");
            setBaseUrl("");
            setApiKey("");
            setModels([]);
            setFetchError("");
            setStep("provider");
          }}
          onCancel={() => setStep("systemPrompt")}
        />
      </Box>
    );
  }

  // ── System Prompt ──────────────────────────────────────────────
  if (step === "systemPrompt") {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text bold color="cyan">System Prompt</Text>
        <Text dimColor>Press Enter to keep default</Text>
        <TextInput
          defaultValue={systemPrompt}
          placeholder="You are a helpful assistant..."
          onSubmit={(val) => {
            setSystemPrompt(val || systemPrompt);
            setStep("addMcp");
          }}
        />
      </Box>
    );
  }

  // ── Add MCP server? ────────────────────────────────────────────
  if (step === "addMcp") {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text bold color="cyan">MCP Servers</Text>
        {mcpServers.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>Configured servers:</Text>
            {mcpServers.map((s, i) => (
              <Text key={i} color="green">  - {s.name} ({s.transport})</Text>
            ))}
          </Box>
        )}
        <Text>Add an MCP server? (Y/n)</Text>
        <ConfirmInput
          defaultChoice="cancel"
          onConfirm={() => {
            setCurrentMcp({});
            setStep("mcpName");
          }}
          onCancel={() => setStep("outputPath")}
        />
      </Box>
    );
  }

  // ── MCP Name ───────────────────────────────────────────────────
  if (step === "mcpName") {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text bold color="cyan">MCP Server Name</Text>
        <TextInput
          placeholder="e.g. filesystem"
          onSubmit={(val) => {
            setCurrentMcp({ ...currentMcp, name: val });
            setStep("mcpTransport");
          }}
        />
      </Box>
    );
  }

  // ── MCP Transport ──────────────────────────────────────────────
  if (step === "mcpTransport") {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text bold color="cyan">Transport for {currentMcp.name}</Text>
        <Select
          options={[
            { label: "stdio (spawn local process)", value: "stdio" },
            { label: "http (remote server)", value: "http" },
          ]}
          onChange={(val) => {
            setCurrentMcp({ ...currentMcp, transport: val as "stdio" | "http" });
            setStep(val === "stdio" ? "mcpCommand" : "mcpUrl");
          }}
        />
      </Box>
    );
  }

  // ── MCP Command (stdio) ────────────────────────────────────────
  if (step === "mcpCommand") {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text bold color="cyan">Command for {currentMcp.name}</Text>
        <Text dimColor>Full command with args, e.g.: npx -y @modelcontextprotocol/server-filesystem /tmp</Text>
        <TextInput
          placeholder="npx -y @mcp/server-name"
          onSubmit={(val) => {
            const parts = val.split(/\s+/);
            const server: McpServerConfig = {
              name: currentMcp.name!,
              transport: "stdio",
              command: parts[0],
              args: parts.slice(1),
            };
            setMcpServers([...mcpServers, server]);
            setStep("addMcp");
          }}
        />
      </Box>
    );
  }

  // ── MCP URL (http) ─────────────────────────────────────────────
  if (step === "mcpUrl") {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text bold color="cyan">URL for {currentMcp.name}</Text>
        <TextInput
          placeholder="http://localhost:4000/mcp"
          onSubmit={(val) => {
            const server: McpServerConfig = {
              name: currentMcp.name!,
              transport: "http",
              url: val,
            };
            setMcpServers([...mcpServers, server]);
            setStep("addMcp");
          }}
        />
      </Box>
    );
  }

  // ── Output path ────────────────────────────────────────────────
  if (step === "outputPath") {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text bold color="cyan">Output Path</Text>
        <Text dimColor>Where to write the config file:</Text>
        <TextInput
          defaultValue={outPath}
          placeholder="microagent.config.json"
          onSubmit={(val) => {
            setOutPath(val || outPath);
            const path = saveConfig();
            setOutPath(path);
            setStep("done");
          }}
        />
      </Box>
    );
  }

  // ── Done ───────────────────────────────────────────────────────
  if (step === "done") {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text bold color="green">Config saved to {outPath}</Text>
        <Text dimColor>Run with: microagent chat -c {outPath}</Text>
        <Text dimColor>Press any key to exit</Text>
        <ConfirmInput
          defaultChoice="confirm"
          onConfirm={() => exit()}
          onCancel={() => exit()}
        />
      </Box>
    );
  }

  return null;
};
