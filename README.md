# microagent

A minimal AI agent built in TypeScript. A reference implementation showing how to build an interactive LLM agent with tool use, MCP server integration, and streaming — in ~1500 lines of code.

> **[How It Works](docs/HOW_IT_WORKS.md)** — deep dive into the agent loop, provider abstraction, tool binding, MCP integration, and message protocol (with Mermaid diagrams).

## Features

- **Interactive CLI** (Ink) and **Web UI** (Svelte 5 + Tailwind, light theme)
- **Any OpenAI-compatible LLM** — Ollama, GitHub Copilot, OpenAI, Groq, Together, LM Studio, vLLM...
- **Multimodal** — attach images via CLI (`/image`), web UI (upload/paste), or API
- **Runtime model switching** — `/model <name>` persists to config file
- **Plugin-based tool system** — built-in tools and MCP servers register through the same registry
- **MCP client** — connect to any MCP server via stdio or HTTP
- **Streaming** — SSE streaming in both CLI and web UI
- **Usage stats** — token counts, request counts, tool call counts, elapsed time
- **Docker ready** — single Dockerfile, docker-compose with mounted config

## Architecture

```
packages/
  core/       @microagent/core     LLM provider, tool registry, MCP client, agent loop
  server/     @microagent/server   Fastify HTTP API (REST + SSE streaming)
  cli/        @microagent/cli      Ink terminal UI + commander entry point
  web/        @microagent/web      Svelte 5 SPA (Tailwind CSS)
```

```
User ──► CLI (Ink)  ──► Agent ──► OpenAI-compatible API (Ollama/Copilot/...)
         Web (Svelte) ──► Fastify ──► Agent ──► ...
                                  └──► Tool Registry ──► Built-in tools
                                                     └──► MCP servers
```

## Quick Start

### Prerequisites

- Node.js 22+
- pnpm 9+
- An LLM provider (Ollama, GitHub Copilot, or any OpenAI-compatible endpoint)

### Install & Build

```bash
git clone <repo-url> && cd microagent
pnpm install
pnpm build
```

### Run

```bash
# Generate a config file interactively
pnpm wizard

# Interactive CLI (default: Ollama with llama3.2)
pnpm chat

# With a specific provider/model
pnpm chat -- -p github-copilot -m gpt-4o

# HTTP API server (port 3100)
pnpm serve

# Web UI — opens browser (port 3200)
pnpm ui
pnpm ui -- --no-open    # skip auto-open

# List available models for a provider
pnpm chat -- models -p github-copilot

# All commands accept these flags:
#   -p, --provider <type>   ollama | github-copilot | openai | <any>
#   -m, --model <name>      Model name
#   --base-url <url>        Provider base URL
#   --api-key <key>         API key
#   -c, --config <path>     Path to config JSON
#   -s, --system <prompt>   System prompt
```

## Chat Slash Commands

The following slash commands work in both the **CLI** and **Web UI**:

| Command | Description |
|---|---|
| `/stats` | Show token usage, request count, and tool call stats |
| `/tools` | List all registered tools (built-in + MCP) |
| `/models` | Fetch and display available models from the provider |
| `/model <name>` | Switch to a different model (persists to config file) |
| `/model` | Show the currently active model |
| `/image <path-or-url>` | Queue an image for the next message (CLI only) |
| `/clear` | Clear chat history (Web UI only) |
| `/help` | Show available commands (Web UI only) |
| `/quit` | Exit the chat (CLI only, also `/exit` or Ctrl+C) |

The Web UI also supports **image upload** via the `+img` button and **clipboard paste** (Ctrl+V).

## Config Wizard

The fastest way to get started. The interactive wizard walks you through provider selection, model, API keys, system prompt, and MCP server setup — then writes a config file.

```bash
# Generate config at XDG path (default)
pnpm wizard

# Write to a custom path
pnpm wizard -- -o my-config.json
```

The wizard steps:

1. **Provider** — pick from Ollama, GitHub Copilot, OpenAI, or custom endpoint
2. **Model** — enter model name (sensible default pre-filled per provider)
3. **Base URL** — only prompted for custom endpoints
4. **API Key** — prompted for providers that need auth (can be left empty to use env vars at runtime)
5. **System prompt** — customize or keep the default
6. **MCP Servers** — optionally add one or more MCP servers (stdio or HTTP)
7. **Output path** — confirm where to save the config file

Then run with the generated config:

```bash
pnpm chat -- -c microagent.config.json
pnpm serve -- -c microagent.config.json
pnpm ui -- -c microagent.config.json
```

## Provider Setup

### Ollama (local, free)

```bash
# Install: https://ollama.com
ollama pull llama3.2

# Run microagent (Ollama is the default)
pnpm chat
pnpm chat -- -m mistral
pnpm chat -- -m qwen2.5-coder:7b
```

Ollama runs on `http://localhost:11434` by default. Override with `--base-url`.

### GitHub Copilot

Requires an active GitHub Copilot subscription. Authentication uses the GitHub device OAuth flow — no token setup needed.

```bash
# Just run — you'll be prompted to authenticate via browser on first use
pnpm chat -- -p github-copilot -m gpt-4o
pnpm chat -- -p github-copilot -m claude-sonnet-4
```

On first run, microagent will:
1. Display a **user code** and open a **verification URL**
2. You authorize in your browser
3. The OAuth token is cached at `~/.local/share/microagent/github-copilot-token.json`
4. Session tokens refresh automatically — you only authenticate once

Config file (no API key needed):

```json
{
  "provider": {
    "type": "github-copilot",
    "model": "gpt-4o"
  }
}
```

### OpenAI (or any OpenAI-compatible endpoint)

```bash
export OPENAI_API_KEY=sk-xxxxxxxxxxxx
pnpm chat -- -p openai -m gpt-4o
```

### Custom endpoint (Groq, Together, LM Studio, vLLM, etc.)

```bash
pnpm chat -- -p groq --base-url https://api.groq.com/openai/v1 --api-key $GROQ_API_KEY -m llama-3.3-70b-versatile
```

Any value for `-p` that doesn't match a preset is treated as a raw OpenAI-compatible provider — just supply `--base-url` and `--api-key`.

## Configuration

microagent follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/):

| Purpose | Default path | Override |
|---|---|---|
| Config files | `~/.config/microagent/config.json` | `XDG_CONFIG_HOME` |
| Data (cached tokens) | `~/.local/share/microagent/` | `XDG_DATA_HOME` |
| Cache | `~/.cache/microagent/` | `XDG_CACHE_HOME` |

The config wizard (`pnpm wizard`) writes to the XDG config path by default. Config is also auto-discovered from the XDG path or a local `microagent.config.json`.

Create a config file (or use `pnpm wizard`):

```json
{
  "provider": {
    "type": "ollama",
    "model": "llama3.2",
    "baseUrl": "http://localhost:11434/v1"
  },
  "systemPrompt": "You are a helpful coding assistant.",
  "mcpServers": [
    {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    {
      "name": "remote-tools",
      "transport": "http",
      "url": "http://localhost:4000/mcp"
    }
  ]
}
```

```bash
pnpm chat -- -c microagent.config.json
```

## Adding Tool Plugins

Every tool — built-in or external — implements the same `ToolPlugin` interface:

```typescript
import type { ToolPlugin } from "@microagent/core";

const myTool: ToolPlugin = {
  definition: {
    name: "weather",
    description: "Get current weather for a city",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
      },
      required: ["city"],
    },
  },
  async execute(args) {
    const res = await fetch(`https://wttr.in/${args.city}?format=3`);
    return await res.text();
  },
};
```

Register it:

```typescript
import { Agent } from "@microagent/core";

const agent = new Agent(config);
agent.tools.register(myTool);
```

### Built-in tools

| Tool | Description |
|---|---|
| `file_read` | Read file contents |
| `file_write` | Write to file (creates dirs) |
| `bash` | Execute shell command |
| `list_directory` | List directory entries |

### MCP tools

MCP server tools are auto-registered as `servername__toolname` when configured in `mcpServers`. They go through the same `ToolRegistry` — no special handling needed.

## HTTP API

Start with `pnpm serve` or `pnpm ui`.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Provider, tool count, uptime |
| `GET` | `/tools` | All tool definitions |
| `GET` | `/stats` | Token/request/tool usage |
| `GET` | `/models` | List available models from the provider |
| `GET` | `/model` | Get current model and provider |
| `POST` | `/model` | Switch model `{ model }` -> `{ model, persisted }` |
| `POST` | `/chat` | Sync chat `{ message, images? }` -> `{ response, toolCalls, stats }` |
| `POST` | `/chat/stream` | SSE stream — events: `delta`, `tool_call`, `tool_result`, `complete`, `error` |

Both `/chat` and `/chat/stream` accept an optional `images` array (data URIs or URLs) for multimodal messages.

```bash
# Sync
curl -X POST http://localhost:3100/chat \
  -H 'Content-Type: application/json' \
  -d '{"message": "What files are in /tmp?"}'

# Streaming
curl -N -X POST http://localhost:3100/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"message": "Explain this codebase"}'
```

### Usage from TypeScript / JavaScript

```ts
const BASE = "http://localhost:3100";

// --- Sync chat ---
const res = await fetch(`${BASE}/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "What files are in /tmp?" }),
});
const { response, toolCalls, stats } = await res.json();
console.log(response);

// --- Streaming chat (SSE) ---
const sse = await fetch(`${BASE}/chat/stream`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "Explain this codebase" }),
});

const reader = sse.body!.getReader();
const decoder = new TextDecoder();
let buf = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });

  // Parse SSE frames
  const parts = buf.split("\n\n");
  buf = parts.pop()!; // keep incomplete frame

  for (const part of parts) {
    const line = part.replace(/^data: /, "");
    if (!line || line === "[DONE]") continue;
    const event = JSON.parse(line);

    switch (event.type) {
      case "delta":
        process.stdout.write(event.content); // stream text to terminal
        break;
      case "tool_call":
        console.log(`\nTool: ${event.name}(${JSON.stringify(event.args)})`);
        break;
      case "tool_result":
        console.log(`Result: ${event.result.slice(0, 120)}...`);
        break;
      case "complete":
        console.log("\n\nDone.", event.stats);
        break;
      case "error":
        console.error("Error:", event.error);
        break;
    }
  }
}

// --- List models / tools / stats ---
const models = await fetch(`${BASE}/models`).then((r) => r.json());
const tools = await fetch(`${BASE}/tools`).then((r) => r.json());
const stats2 = await fetch(`${BASE}/stats`).then((r) => r.json());
```

## Docker

### Build & run

```bash
docker compose up --build
```

This starts the API + Web UI on port 3100. The config file is mounted from `./microagent.config.json`.

### Using Ollama from Docker

If Ollama runs on your host, update `microagent.config.json` to use the Docker-accessible host:

```json
{
  "provider": {
    "type": "ollama",
    "model": "llama3.2",
    "baseUrl": "http://host.docker.internal:11434/v1"
  }
}
```

Or uncomment the `ollama` service in `docker-compose.yml` to run Ollama as a sidecar.

### Using GitHub Copilot / OpenAI from Docker

For GitHub Copilot, run the device auth flow on the host first (`pnpm chat -- -p github-copilot`), then mount the token cache:

```bash
docker compose up --build
# Mount ~/.local/share/microagent/ into the container
```

For OpenAI:

```bash
OPENAI_API_KEY=sk-xxx docker compose up --build
```

## Development

```bash
pnpm install
pnpm build
pnpm test          # 19 tests across core, cli, server

# Dev workflow (two terminals)
pnpm serve         # API on :3100
pnpm dev:web       # Vite dev on :5100 (proxies /api -> :3100)
pnpm ui            # Production: API + SPA on :3200 (opens browser)
```

## Project Structure

```
microagent/
├── packages/
│   ├── core/src/
│   │   ├── types.ts              # Shared types
│   │   ├── agent.ts              # Agent loop (chat -> tool calls -> loop)
│   │   ├── tool-registry.ts      # Plugin registry
│   │   ├── mcp.ts                # MCP client (stdio + HTTP)
│   │   ├── stats.ts              # Usage tracking
│   │   ├── paths.ts              # XDG Base Directory paths
│   │   └── providers/
│   │       ├── openai-compatible.ts  # Single provider for all OpenAI-compat APIs
│   │       ├── factory.ts            # createProvider() + presets
│   │       └── github-auth.ts        # GitHub Copilot device OAuth flow
│   ├── server/src/
│   │   └── index.ts              # Fastify routes + static file serving
│   ├── cli/src/
│   │   ├── bin.ts                # Commander (chat/serve/ui subcommands)
│   │   ├── app.ts                # Ink bootstrap
│   │   ├── components/Chat.tsx          # Terminal UI
│   │   ├── components/ConfigWizard.tsx  # Interactive config generator
│   │   └── tools/                # Built-in tool plugins
│   └── web/src/
│       ├── lib/api.ts            # SSE client
│       └── routes/+page.svelte   # Chat UI (Svelte 5 runes)
├── microagent.config.json        # Default config
├── Dockerfile                    # Multi-stage build
├── docker-compose.yml            # Production stack
├── turbo.json                    # Build pipeline
└── pnpm-workspace.yaml
```

## License

MIT
