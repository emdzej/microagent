# microagent

A minimal AI agent built in TypeScript. A reference implementation showing how to build an interactive LLM agent with tool use, MCP server integration, and streaming — in ~1500 lines of code.

> **[How It Works](docs/HOW_IT_WORKS.md)** — deep dive into the agent loop, provider abstraction, tool binding, MCP integration, and message protocol (with Mermaid diagrams).
>
> **[microagent-rust](https://github.com/emdzej/microagent-rust)** — a Rust implementation of the same agent, in its own repository. Interoperable: same config file, same token cache, same HTTP API, and it serves this repo's web UI build.

## Features

- **Interactive CLI** (Ink) and **Web UI** (Svelte 5 + Tailwind, light theme)
- **Any OpenAI-compatible LLM** — Ollama, GitHub Copilot, OpenAI, Groq, Together, LM Studio, vLLM...
- **Multiple providers** — configure several providers at once, list models across all, switch with `provider/model` syntax
- **Multimodal** — attach images via CLI (`/image`), web UI (upload/paste), or API
- **Runtime model switching** — `/model provider/model` switches provider and model, persists to config
- **Anthropic on Bedrock** — SigV4 via the ambient AWS credential chain, adaptive thinking, manual prompt-cache breakpoints
- **Isolated sessions** — a conversation per caller, running concurrently, with TTL eviction and caps
- **Typed run outcomes** — `stopReason` distinguishes a finished answer from one truncated by a round cap, budget, deadline, or output limit
- **Budgets and cancellation** — token ceiling, wall-clock deadline, per-tool timeout, and an `AbortSignal` that reaches both the provider and the tools
- **Tool policy** — a gate that can allow, rewrite, or deny a call before it runs, with the reason fed back to the model
- **Plugin-based tool system** — built-in tools and MCP servers register through the same registry
- **MCP client** — stdio or HTTP, with connect timeouts, reconnection, and tools that report being offline instead of vanishing
- **OIDC auth** — bearer JWT against the realm's JWKS, plus `/.well-known/microagent-config` so clients discover the IdP instead of hard-coding it
- **Streaming** — SSE streaming in both CLI and web UI
- **Structured output** — constrain a response to a JSON Schema and get a typed validation failure rather than an exception
- **Audit trail** — structured JSON per tool call and per turn: correlation id, principal, stop reason, usage with cache tokens, tool arguments and results, and optionally the full prompt — with a redaction hook and size caps
- **Usage stats** — token counts, cache reads/writes, request counts, tool call counts, elapsed time
- **Docker ready** — single Dockerfile, docker-compose with mounted config

## Architecture

```
packages/
  core/       @microagent/core     LLM provider, tool registry, MCP client, agent loop
  server/     @microagent/server   Fastify HTTP API (REST + SSE streaming)
  cli/        @microagent/cli      Ink terminal UI + commander entry point
  web/        @microagent/web      Svelte 5 SPA (Tailwind CSS)
```

### The Rust implementation

A second implementation of the same agent lives in
**[microagent-rust](https://github.com/emdzej/microagent-rust)** — same agent
loop, provider abstraction, tool registry and MCP client, expressed in a language
with very different constraints. It reads the same config file and Copilot token
cache and serves the same HTTP API, so either can back the same front-end.

It also hosts **this repo's web UI build**: `packages/web/build` is what its
`embed-web` feature bakes into a single binary with no Node runtime. That is the
one dependency between the two repositories — its `scripts/sync-web.sh` copies a
build from a checkout of this one. Prebuilt binaries with the UI embedded are
attached to its releases.

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

# List available models for all configured providers
pnpm chat -- models

# One-shot query (no interactive UI)
pnpm ask 'explain what a monad is'

# Pipe from stdin
echo 'explain this error' | pnpm ask

# With image attachment and raw output (no tool calls / progress)
pnpm ask -a screenshot.png -r 'describe this image'

# All commands accept these flags:
#   -p, --provider <type>   ollama | github-copilot | openai | <any>
#   -m, --model <name>      Model name
#   --base-url <url>        Provider base URL
#   --api-key <key>         API key
#   -c, --config <path>     Path to config JSON
#   -s, --system <prompt>   System prompt
```

## Global Install

After publishing, install globally for the `microagent` command:

```bash
npm i -g @microagent/cli

# Then use directly
microagent chat
microagent ask 'what is 2+2' --raw
microagent serve
microagent ui
```

## Chat Slash Commands

The following slash commands work in both the **CLI** and **Web UI**:

| Command | Description |
|---|---|
| `/stats` | Show token usage, request count, and tool call stats |
| `/tools` | List all registered tools (built-in + MCP) |
| `/models` | Fetch and display available models from all configured providers |
| `/model <provider/model>` | Switch to a model (and its provider). e.g. `/model openai/gpt-4o` |
| `/model <name>` | Switch model on the current provider |
| `/model` | Show the currently active provider and model |
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
5. **Add another provider?** — repeat steps 1-4 to configure additional providers
6. **System prompt** — customize or keep the default
7. **MCP Servers** — optionally add one or more MCP servers (stdio or HTTP)
8. **Output path** — confirm where to save the config file

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
  "providers": [
    {
      "type": "github-copilot",
      "model": "gpt-4o"
    }
  ]
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
  "providers": [
    {
      "type": "ollama",
      "model": "llama3.2"
    },
    {
      "type": "openai",
      "model": "gpt-4o",
      "apiKey": "sk-..."
    },
    {
      "type": "github-copilot",
      "model": "gpt-4o"
    }
  ],
  "activeProvider": "ollama",
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

The legacy single-provider format is still supported for backward compatibility:

```json
{
  "provider": {
    "type": "ollama",
    "model": "llama3.2"
  }
}
```

```bash
pnpm chat -- -c microagent.config.json
```

### Secrets

An inline `apiKey` is fine for the CLI, where the config file is your own
dotfile. For anything deployed, reference the secret instead of embedding it:

```json
{
  "providers": [
    { "type": "openai", "model": "gpt-4o", "apiKeyEnv": "OPENAI_API_KEY" },
    { "type": "custom", "model": "m", "apiKeyFile": "/var/run/secrets/llm/api-key" }
  ]
}
```

`apiKeyFile` is how a mounted Kubernetes secret arrives. Exactly one of the
three sources may be set. A named source that is missing or empty **fails at
startup** — the alternative is a puzzling 401 from the provider much later, far
from the cause.

Set `"allowConfigWrites": false` (or `MICROAGENT_ALLOW_CONFIG_WRITES=false`) for
a container with a read-only root filesystem, so a `POST /model` switches the
model in memory without attempting a write that would crash the pod.

### Session limits and per-caller limits

```json
{
  "sessions": {
    "maxSessions": 100,
    "ttlMs": 1800000,
    "maxTurnsPerSession": 100,
    "maxMessagesPerSession": 2000
  },
  "limits": {
    "requestsPerMinute": 60,
    "tokensPerMinute": 200000,
    "maxSessionsPerPrincipal": 5
  }
}
```

Sessions hold whatever the tools gathered — memory, and often personal data — so
they expire on idle and can be closed explicitly. `limits` are enforced **per
principal**, not per process: a process-wide limit lets the busiest caller set
everyone else's ceiling.

### Amazon Bedrock

```json
{
  "providers": [
    {
      "type": "bedrock",
      "model": "claude-opus-5",
      "region": "eu-central-1",
      "maxTokens": 8192,
      "thinking": { "type": "adaptive" },
      "effort": "high"
    }
  ]
}
```

Credentials come from the ambient AWS chain, so IRSA works with no static keys
anywhere in the config. Model ids are normalised to Bedrock's `anthropic.`
prefix (`claude-opus-5` → `anthropic.claude-opus-5`); an already-qualified id or
a cross-region inference profile (`us.anthropic.…`) is left exactly as written.

Bedrock does no automatic prompt caching, so breakpoints have to be placed by
hand or the whole prefix is re-billed every turn. Ask for them per session:

```ts
const session = agent.createSession({
  cacheBreakpoints: { system: true, tools: true },
});
```

Watch `cacheReadTokens` in `/stats` or on a run's `usage`. Zero cache reads
across repeated runs is the one signal that something volatile has leaked into
the prompt prefix — a regression that shows up as a cost increase with no
functional symptom.

### Audit trail

One structured JSON record per line on stdout — what a log collector in a
container already reads. Two record types:

- **`tool_call`** — emitted as each call finishes: name, source server,
  arguments, result, duration, error/denial outcome.
- **`turn`** — emitted at turn end: principal, model, stop reason, rounds,
  usage including cache tokens, every tool call, and the prompt.

The per-call record exists because a turn can run for minutes across many
rounds. Batching everything into the turn summary means nothing is observable
while it happens, and a crash mid-turn loses every call already made — which is
exactly the window worth having a trail for.

```json
{
  "audit": {
    "enabled": true,
    "level": "io",
    "maxFieldChars": 8192,
    "perToolCall": true
  }
}
```

| `level` | Records |
|---|---|
| `metadata` *(default)* | Outcomes, tool names, counts, usage. No prompt, argument, or result text. |
| `io` | Adds the user input, the model's response, and each tool call's arguments and result. |
| `full` | Adds the whole message history as sent to the model. |

**`metadata` is the default deliberately.** Prompts and tool results are the
most sensitive data the agent handles — everything the tools gathered ends up in
them — so content capture is always an explicit choice, and one with a retention
policy attached.

Every record for a turn shares one `correlationId`, which is also returned to
the caller in the HTTP response. A complaint about a specific answer can
therefore be traced to the tool calls that produced it, and onward to whatever
those tools logged themselves.

Two things are described rather than recorded: an inline base64 image becomes
`image image/png (2.9 KB)`, and a provider-native block (Anthropic thinking)
becomes `provider_native:bedrock`. The first would otherwise dominate the record
at no forensic value; the second is opaque to core by contract and may be signed
or encrypted.

#### Redaction

What counts as a secret is deployment-specific — which token formats, which
customer identifiers, which internal hostnames — so core provides the hook and
you provide the rules. It runs on every recorded string, including each one
nested inside tool arguments, and before truncation so it always sees whole
values:

```ts
await createServer({
  config,
  auditRedactor: (value, ctx) => {
    // ctx.field is system | input | response | message | tool_arguments | tool_result
    // ctx.toolName is set for tool fields
    return value.replace(/sk-[A-Za-z0-9]+/g, "[redacted]");
  },
});
```

A redactor that throws fails closed — the field is recorded as
`[redaction failed]` rather than leaking the value it could not scrub, and the
turn continues. `maxFieldChars` caps every text field with a visible
`… [truncated N chars]` marker, so a tool returning a 40MB log dump cannot put
all of it into the audit stream.

### MCP servers

```json
{
  "mcpServers": [
    {
      "name": "kubernetes",
      "transport": "http",
      "url": "http://mcp-kubernetes:4000/mcp",
      "headers": { "X-Tenant": "prod" },
      "connectTimeoutMs": 15000,
      "reconnect": { "enabled": true, "maxAttempts": 5, "maxDelayMs": 30000 }
    }
  ]
}
```

Tools are namespaced by server (`kubernetes__get_pods`), and a residual name
collision now raises instead of silently shadowing — the old behaviour left the
model calling a tool that belonged to a different server with nothing in the
logs to explain the result.

A server that dies is reconnected with backoff. Meanwhile its tools stay
*registered but unavailable*, so a call returns a clear "unavailable" result
rather than the tool quietly vanishing from the list — otherwise the model sees
a shorter tool set, works around the gap, and produces an answer that reads as
complete while silently omitting whatever that server was for.

Set `MICROAGENT_DISALLOW_STDIO_MCP=true` to reject the stdio transport outright.
`StdioClientTransport` spawns a child process, which is the wrong shape in a
hardened pod with a read-only root filesystem and dropped capabilities; HTTP to
a sidecar fits better.

## Embedding the agent

`Agent` holds the shared, per-turn-stateless things — providers, the tool
registry, MCP connections — and hands out `Session` objects that each own one
conversation.

```ts
import { Agent, JsonAuditSink } from "@microagent/core";

const agent = new Agent(config);
await agent.init(config.mcpServers);

// One JSON line per tool call and per turn. `config.audit.level` decides how
// much content each carries; `metadata` (the default) carries none.
agent.setAuditSink(new JsonAuditSink());
agent.setAuditRedactor((value) => value.replace(/sk-[A-Za-z0-9]+/g, "[redacted]"));

// Reject or bound a call before it runs. A denial becomes the tool's result, so
// the model can adapt instead of stalling against a silent failure.
agent.setToolPolicy({
  check(call) {
    if (call.arguments.allNamespaces) {
      return { action: "deny", reason: "cluster-wide queries are out of scope" };
    }
    if (call.name === "logs" && !call.arguments.since) {
      return { action: "rewrite", arguments: { ...call.arguments, since: "1h" } };
    }
    return { action: "allow" };
  },
});

const session = agent.createSession({
  principal,                       // owns the session
  systemPrompt: "You investigate alerts.",
  cacheBreakpoints: { system: true, tools: true },
});

const result = await session.run(
  "Why did checkout latency spike?",
  { onDelta: (d) => process.stdout.write(d.text ?? "") },
  {
    signal: controller.signal,
    tokenBudget: 200_000,
    deadlineMs: 120_000,
    toolTimeoutMs: 30_000,
    responseFormat: { type: "json_schema", schema: findingSchema },
  },
);

if (result.stopReason !== "end_turn") {
  // max_tool_rounds | budget_exhausted | deadline_exceeded | cancelled |
  // refusal | max_tokens | error — four of these are truncations carrying
  // plausible-looking text, so this branch is not optional.
  console.warn(`incomplete: ${result.stopReason}`);
}

if (result.structured && !result.structured.ok) {
  // A schema failure is a number to count and alert on, not an exception.
  metrics.increment("schema_violation");
}

agent.closeSession(session.id);
```

`Agent.run()` still exists and still returns a plain `string`, backed by an
implicit default session — the CLI really does have exactly one conversation.
Use `runDetailed()` or a session when you need the outcome.

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

Registered by `registerBuiltinTools` from the CLI package, so every command —
including `serve` and `ui` — has all four. `@microagent/server` registers none
itself; embedded standalone it starts with an empty registry.

| Tool | Arguments | Description |
|---|---|---|
| `file_read` | `path` | Read file contents as utf-8 |
| `file_write` | `path`, `content` | Write to file, creating parent directories |
| `bash` | `command`, `cwd?` | Run a shell command; returns stdout, or `EXIT ERROR` with stdout/stderr on a non-zero exit |
| `list_directory` | `path` | List entries, one `d `/`f ` prefixed line each |

`bash` runs asynchronously and honours the run's cancellation: a
`toolTimeoutMs`, a wall-clock deadline, or a client hanging up all terminate the
command. It is spawned into its own process group so terminating reaps the whole
tree, including the grandchildren of a compound command like `sleep 60 & wait`.
Output is capped at 1MB, keeping what fits and appending a
`[output truncated …]` marker rather than discarding everything captured.

Shell resolution is unchanged (`/bin/sh -c` on POSIX, `cmd.exe` on Windows)
despite the tool's name, so existing commands behave as before.

### Confining filesystem access

The built-in tools resolve whatever path they are given — for a local coding
agent, reading a file outside the working directory is the point. On a
multi-user server it is not: `file_read` will return any file the process can
read, including the config file with an inline `apiKey`.

That boundary is a policy decision, so it is opt-in rather than baked into the
tools:

```ts
import { pathConfinementPolicy, denyToolsPolicy, composePolicies } from "@microagent/core";

agent.setToolPolicy(
  composePolicies([
    denyToolsPolicy(["bash"], "shell access is disabled on this deployment"),
    pathConfinementPolicy({ root: "/workspace" }),
  ]),
);
```

`pathConfinementPolicy` resolves symlinks on every component that exists, so a
link inside the root pointing out of it is rejected — a check against the
literal string would miss that. Allowed calls are **rewritten** to the absolute
resolved path: the tools call `path.resolve()` themselves, and a policy that
checked one path while the tool resolved another would be decoration.

It is a boundary against a confused model, not against a local attacker: a
symlink swapped between the check and the tool's `open` would still escape.
Closing that needs `openat`/`O_NOFOLLOW`, which Node does not expose.

`denyToolsPolicy` turns a capability off without unregistering the tool, so the
model is told plainly why it cannot use it instead of silently working around a
gap it cannot see.

### MCP tools

MCP server tools are auto-registered as `servername__toolname` when configured in `mcpServers`. They go through the same `ToolRegistry` — no special handling needed.

## HTTP API

Start with `pnpm serve` or `pnpm ui`.

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | public | Provider, tool count, session count, MCP state, uptime |
| `GET` | `/.well-known/microagent-config` | public | Which IdP to authenticate against (404 when auth is off) |
| `GET` | `/tools` | yes | All tool definitions, with availability and source server |
| `GET` | `/stats` | yes | Token/request/tool usage, including cache tokens |
| `GET` | `/models` | yes | List available models from all configured providers |
| `GET` | `/model` | yes | Get current model and provider |
| `POST` | `/model` | yes | Switch model `{ model: "provider/model" }` -> `{ provider, model, persisted }` |
| `POST` | `/sessions` | yes | Create a conversation `{ systemPrompt?, metadata? }` -> session |
| `GET` | `/sessions` | yes | List **your own** sessions |
| `GET` | `/sessions/:id` | yes | Session detail (turns, messages, usage) |
| `DELETE` | `/sessions/:id` | yes | Close a session and drop its history |
| `POST` | `/sessions/:id/messages` | yes | Run a turn in that session |
| `POST` | `/sessions/:id/messages/stream` | yes | Same, as SSE |
| `POST` | `/chat` | yes | Compatibility shim over an implicit per-caller session |
| `POST` | `/chat/stream` | yes | SSE — events: `delta`, `tool_call`, `tool_result`, `tool_denied`, `complete`, `error` |

Every run route accepts the same body: `{ message, images?, maxToolRounds?, tokenBudget?, deadlineMs?, toolTimeoutMs?, maxTokens?, responseFormat? }`. `images` takes data URIs or URLs for multimodal messages.

Responses carry the run's outcome, not just its text:

```jsonc
{
  "response": "…",
  "stopReason": "end_turn",   // or max_tool_rounds | budget_exhausted |
                              // deadline_exceeded | cancelled | refusal |
                              // max_tokens | error
  "rounds": 2,
  "usage": { "totalTokens": 812, "cacheReadTokens": 4096, "cacheWriteTokens": 0 },
  "correlationId": "…",       // ties this turn to its audit record
  "toolCalls": [ /* … */ ],
  "stats": { /* … */ }
}
```

`stopReason` matters: without it a caller cannot tell a finished answer from one
truncated by the round cap, a token budget, or the model's own output limit.

**Sessions are owned.** A session belongs to the principal that created it, and
a request for someone else's session gets a `404` — the same answer as one that
does not exist, because confirming that another subject's id is valid is itself
a small leak. `/chat` is backed by an implicit session **per caller**; it
previously appended to one process-wide conversation, so one caller's context
and tool output ended up in the next caller's prompt.

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

## Authentication

Off by default — the CLI and a local `pnpm serve` need no token. Configure an
`auth.oidc` block and the server requires a bearer JWT on every API route.

```json
{
  "auth": {
    "oidc": {
      "issuer": "https://auth.example.com/realms/myproduct",
      "audience": "microagent",
      "clientIdHint": "microagent-cli",
      "requiredScopes": []
    }
  }
}
```

Or by environment variable, for a container with no config file:

```bash
MICROAGENT_OIDC_ISSUER=https://auth.example.com/realms/myproduct
MICROAGENT_OIDC_AUDIENCE=microagent
MICROAGENT_OIDC_CLIENT_ID=microagent-cli
```

Auth is enabled whenever an issuer is present, so a deployment can only lose
authentication by asking for it (`auth.enabled: false`), never by forgetting a
flag. Tokens are verified against the realm's JWKS, discovered from the issuer
at startup — a bad issuer fails the process rather than turning every later
request into a confusing 401. Verification checks, in order: the algorithm
allowlist (`RS256`/`ES256`; `none` is never accepted and the token's own `alg`
header never gets a say), the signing key by `kid`, exact `iss`, `aud`
membership, `exp`/`nbf` with a 60s skew allowance, then optional `azp` and
required scopes. Keys are cached and refetched on an unknown `kid` so rotation
needs no restart, with a cooldown so an unknown-`kid` flood cannot turn every
request into an outbound fetch.

### Client discovery — `/.well-known/microagent-config`

A client should not need the IdP's URL compiled into it. It asks the deployment
where to authenticate and then runs the OAuth flow itself:

```bash
curl http://localhost:3100/.well-known/microagent-config
```

```json
{
  "issuer": "https://auth.example.com/realms/myproduct",
  "audience": "microagent",
  "scopes": [
    "microagent:session:create",
    "microagent:session:read",
    "microagent:session:write",
    "microagent:session:delete",
    "microagent:model:read",
    "microagent:model:write",
    "microagent:tools:read"
  ],
  "authorization_endpoint": "https://auth.example.com/realms/myproduct/protocol/openid-connect/auth",
  "token_endpoint": "https://auth.example.com/realms/myproduct/protocol/openid-connect/token",
  "device_authorization_endpoint": "https://auth.example.com/realms/myproduct/protocol/openid-connect/auth/device",
  "client_id_hint": "microagent-cli"
}
```

The endpoint is public — a client has to read it *before* it has a token — and
carries no secrets. When auth is disabled it returns **404** with
`auth disabled on this deployment`, which a client can map to a "no token
needed" sentinel; a `200` with blank fields would instead read like a
misconfigured IdP.

Why a microagent-specific path rather than reusing the OIDC one:
`.well-known/openid-configuration` is the *IdP's* document, served by the IdP.
This one is served by the agent and carries deployment-specific metadata — the
scopes this API understands and the shared `client_id_hint` — that has no place
in the IdP's response.

`device_authorization_endpoint` is there so a CLI can drive the RFC 8628 device
authorization grant: no browser redirect, no callback URL. Register one public,
device-flow-enabled OAuth client at your IdP and publish its id as
`clientIdHint`; every client of the deployment shares it, because the rendezvous
party is the deployment, not the individual user. Browser apps should **not**
use device flow — most IdPs do not enable CORS on the token endpoint for it —
and should run auth-code + PKCE instead, passing the resulting access token
through as a bearer.

### Authorisation

Authentication and authorisation are separate. By default each route requires
its named scope (`ROUTE_SCOPES`, deny-by-default for anything unmapped). Replace
the policy to enforce rules that are specific to your deployment — which
environments or namespaces a caller may touch is domain knowledge that does not
belong in a generic runtime:

```ts
import { createServer } from "@microagent/server";

await createServer({
  config,
  authorize: (principal, request) =>
    principal.groups.includes("platform-ops")
      ? { allow: true }
      : { allow: false, reason: "not a platform operator" },
});
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
  "providers": [
    {
      "type": "ollama",
      "model": "llama3.2",
      "baseUrl": "http://host.docker.internal:11434/v1"
    }
  ]
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
