#!/usr/bin/env node
import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { startChat } from "./app.js";
import { startServer } from "@microagent/server";
import type { MicroagentConfig } from "@microagent/core";
import { Agent, paths, listModelsForProvider } from "@microagent/core";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { ConfigWizard } from "./components/ConfigWizard.js";
import { registerBuiltinTools } from "./tools/index.js";

/** Create an agent with built-in tools registered */
function createAgent(config: MicroagentConfig): Agent {
  const agent = new Agent(config);
  registerBuiltinTools(agent.tools);
  return agent;
}

function loadConfig(opts: Record<string, string>): MicroagentConfig {
  // Explicit --config flag
  if (opts.config) {
    const cfgPath = resolve(opts.config);
    if (!existsSync(cfgPath)) {
      console.error(`Config file not found: ${cfgPath}`);
      process.exit(1);
    }
    return JSON.parse(readFileSync(cfgPath, "utf-8")) as MicroagentConfig;
  }

  // Auto-discover: XDG config dir, then local file
  const candidates = [paths.configFile(), resolve("microagent.config.json")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, "utf-8")) as MicroagentConfig;
    }
  }

  // Fallback to CLI flags
  return {
    provider: {
      type: opts.provider ?? "ollama",
      model: opts.model ?? "llama3.2",
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
    },
    systemPrompt: opts.system ?? "You are a helpful coding assistant. Be concise.",
  };
}

const program = new Command();

program
  .name("microagent")
  .description("Minimal AI coding agent with tool & MCP support")
  .version("0.1.0");

// ── Shared options ─────────────────────────────────────────────
const addProviderOpts = (cmd: Command) =>
  cmd
    .option("-p, --provider <type>", "LLM provider: ollama | github-copilot | openai", "ollama")
    .option("-m, --model <name>", "Model name", "llama3.2")
    .option("--base-url <url>", "Provider base URL")
    .option("--api-key <key>", "API key (or use GITHUB_TOKEN / OPENAI_API_KEY env)")
    .option("-c, --config <path>", "Path to config JSON file")
    .option("-s, --system <prompt>", "System prompt");

// ── chat (default) ─────────────────────────────────────────────
addProviderOpts(
  program
    .command("chat", { isDefault: true })
    .description("Start interactive chat (default)")
).action(async (opts) => {
  await startChat(loadConfig(opts));
});

// ── serve ──────────────────────────────────────────────────────
addProviderOpts(
  program
    .command("serve")
    .description("Start HTTP server for remote access")
    .option("-H, --host <host>", "Bind host", "0.0.0.0")
    .option("--port <port>", "Bind port", "3100")
).action(async (opts) => {
  const config = loadConfig(opts);
  const agent = createAgent(config);
  await startServer({
    agent,
    config,
    host: opts.host,
    port: parseInt(opts.port, 10),
  });
});

// ── ui ─────────────────────────────────────────────────────────
addProviderOpts(
  program
    .command("ui")
    .description("Start server + web UI")
    .option("-H, --host <host>", "Bind host", "0.0.0.0")
    .option("--port <port>", "Bind port", "3200")
    .option("--no-open", "Don't open browser automatically")
).action(async (opts) => {
  const config = loadConfig(opts);
  const agent = createAgent(config);
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const webDir = resolve(__dirname, "../../web/build");
  if (!existsSync(webDir)) {
    console.error(`Web UI not built. Run "pnpm --filter @microagent/web build" first.`);
    process.exit(1);
  }
  const port = parseInt(opts.port, 10);
  await startServer({
    agent,
    config,
    host: opts.host,
    port,
    staticDir: webDir,
  });
  const url = `http://localhost:${port}`;
  console.log(`Web UI available at ${url}`);
  if (opts.open !== false) {
    const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${openCmd} ${url}`);
  }
});

// ── config ─────────────────────────────────────────────────────
program
  .command("config")
  .description("Interactive config wizard")
  .option("-o, --output <path>", "Output file path", paths.configFile())
  .action(async (opts) => {
    const { waitUntilExit } = render(
      React.createElement(ConfigWizard, { outputPath: opts.output })
    );
    await waitUntilExit();
  });

// ── models ─────────────────────────────────────────────────────
addProviderOpts(
  program
    .command("models")
    .description("List available models for a provider")
).action(async (opts) => {
  const config = loadConfig(opts);
  try {
    console.log(`Fetching models from ${config.provider.type}...\n`);
    const models = await listModelsForProvider(
      config.provider.type,
      { baseUrl: config.provider.baseUrl, apiKey: config.provider.apiKey }
    );
    if (!models.length) {
      console.log("No models found.");
      return;
    }
    for (const m of models) {
      console.log(`  ${m.id}`);
    }
    console.log(`\n${models.length} model(s) available.`);
  } catch (err) {
    console.error(`Failed to list models: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
});

program.parse();
