#!/usr/bin/env node
import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { startChat } from "./app.js";
import { startServer } from "@microagent/server";
import type { MicroagentConfig } from "@microagent/core";
import { Agent, paths, listModelsForProvider, resolveProviders } from "@microagent/core";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { ConfigWizard } from "./components/ConfigWizard.js";
import { registerBuiltinTools } from "./tools/index.js";
import { resolveImage } from "./util/resolve-image.js";

/** Create an agent with built-in tools registered */
function createAgent(config: MicroagentConfig): Agent {
  const agent = new Agent(config);
  registerBuiltinTools(agent.tools);
  return agent;
}

function loadConfig(opts: Record<string, string>): { config: MicroagentConfig; configPath: string | null } {
  // Explicit --config flag
  if (opts.config) {
    const cfgPath = resolve(opts.config);
    if (!existsSync(cfgPath)) {
      console.error(`Config file not found: ${cfgPath}`);
      process.exit(1);
    }
    return { config: JSON.parse(readFileSync(cfgPath, "utf-8")) as MicroagentConfig, configPath: cfgPath };
  }

  // Auto-discover: XDG config dir, then local file
  const candidates = [paths.configFile(), resolve("microagent.config.json")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { config: JSON.parse(readFileSync(candidate, "utf-8")) as MicroagentConfig, configPath: candidate };
    }
  }

  // Fallback to CLI flags — no config file to persist to
  return {
    config: {
      provider: {
        type: opts.provider ?? "ollama",
        model: opts.model ?? "llama3.2",
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
      },
      systemPrompt: opts.system ?? "You are a helpful coding assistant. Be concise.",
    },
    configPath: null,
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
  const { config, configPath } = loadConfig(opts);
  await startChat(config, configPath);
});

// ── serve ──────────────────────────────────────────────────────
addProviderOpts(
  program
    .command("serve")
    .description("Start HTTP server for remote access")
    .option("-H, --host <host>", "Bind host", "0.0.0.0")
    .option("--port <port>", "Bind port", "3100")
).action(async (opts) => {
  const { config, configPath } = loadConfig(opts);
  const agent = createAgent(config);
  await startServer({
    agent,
    config,
    configPath,
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
  const { config, configPath } = loadConfig(opts);
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
    configPath,
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
  const { config } = loadConfig(opts);
  const providers = resolveProviders(config);
  if (!providers.length) {
    console.error("No providers configured.");
    process.exit(1);
  }
  try {
    let total = 0;
    for (const pc of providers) {
      const name = pc.name ?? pc.type;
      console.log(`\n${name}:`);
      try {
        const models = await listModelsForProvider(
          pc.type,
          { baseUrl: pc.baseUrl, apiKey: pc.apiKey }
        );
        if (!models.length) {
          console.log("  (no models found)");
        } else {
          for (const m of models) {
            console.log(`  ${name}/${m.id}`);
          }
          total += models.length;
        }
      } catch (err) {
        console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`\n${total} model(s) across ${providers.length} provider(s).`);
  } catch (err) {
    console.error(`Failed to list models: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
});

// ── ask (one-shot query) ───────────────────────────────────────
addProviderOpts(
  program
    .command("ask [prompt...]")
    .description("Run a single query and exit. Prompt from args or stdin.")
    .option("-a, --attachment <path>", "Attach an image (repeatable)", (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option("-r, --raw", "Output only the final response text (no tool calls, no stats)")
).action(async (promptParts: string[], opts) => {
  // Resolve prompt: positional args or stdin
  let prompt: string;
  if (promptParts.length) {
    prompt = promptParts.join(" ");
  } else if (!process.stdin.isTTY) {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    prompt = Buffer.concat(chunks).toString("utf-8").trim();
  } else {
    console.error("Error: provide a prompt as arguments or pipe via stdin.");
    process.exit(1);
  }

  if (!prompt) {
    console.error("Error: empty prompt.");
    process.exit(1);
  }

  const { config } = loadConfig(opts);
  const agent = createAgent(config);
  await agent.init(config.mcpServers);

  // Resolve image attachments
  const images: string[] = [];
  for (const att of opts.attachment as string[]) {
    const resolved = resolveImage(att);
    if (!resolved) {
      console.error(`File not found: ${att}`);
      process.exit(1);
    }
    images.push(resolved);
  }

  const raw = Boolean(opts.raw);

  try {
    const response = await agent.run(prompt, {
      onDelta: (delta) => {
        if (!raw && delta.type === "text" && delta.text) {
          process.stdout.write(delta.text);
        }
      },
      onToolCall: (name, _args) => {
        if (!raw) process.stderr.write(`→ ${name}\n`);
      },
      onToolResult: (name, result) => {
        if (!raw) {
          const preview = result.content.slice(0, 200);
          process.stderr.write(`← ${name}: ${preview}${result.content.length > 200 ? "..." : ""}\n`);
        }
      },
    }, images.length ? images : undefined);

    if (raw) {
      process.stdout.write(response);
    } else {
      // Newline after streamed output
      process.stdout.write("\n");
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    await agent.shutdown();
  }
});

program.parse();
