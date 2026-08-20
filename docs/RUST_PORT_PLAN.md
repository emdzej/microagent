# Rust Port Plan

A Rust implementation of microagent, living beside the TypeScript one in the same
repository. Both share one config file (`~/.config/microagent/config.json`), one HTTP API
shape, and one web UI build (`packages/web/build`), so either binary can serve the same
front-end and read the same settings.

The point of keeping both is pedagogical: the same agent loop, provider abstraction, tool
registry, and MCP client expressed twice, in two languages with very different constraints.
Where the Rust version deviates, the deviation is documented below — those are the
interesting parts.

## Table of Contents

- [Workspace Layout](#workspace-layout)
- [Dependencies](#dependencies)
- [Cross-Cutting Design Decisions](#cross-cutting-design-decisions)
- [Deliberate Deviations from the TypeScript Version](#deliberate-deviations-from-the-typescript-version)
- [Phases](#phases)
- [Testing Strategy](#testing-strategy)
- [Risks](#risks)

---

## Workspace Layout

```
rust/
  Cargo.toml                  # workspace root
  crates/
    core/                     # microagent-core   — types, agent loop, providers, tools, MCP
    server/                   # microagent-server — axum REST + SSE
    cli/                      # microagent (bin)  — clap + ratatui TUI + built-in tools
```

Mapping to the TypeScript packages:

| TypeScript | Rust | Notes |
|---|---|---|
| `@microagent/core` | `microagent-core` | Direct correspondence. |
| `@microagent/server` | `microagent-server` | Fastify → axum. |
| `@microagent/cli` | `microagent` (bin) | commander → clap, Ink → ratatui. |
| `@microagent/web` | *(not ported)* | Svelte SPA speaks HTTP; the build output is reused verbatim. |

## Dependencies

Versions verified against crates.io at time of writing. Toolchain: Rust 1.97.1, edition
2024, resolver 3.

```toml
# core
tokio = { version = "1.53", features = ["rt-multi-thread", "macros", "process", "time", "sync", "io-util"] }
reqwest = { version = "0.13", default-features = false, features = ["json", "stream", "rustls-tls"] }
eventsource-stream = "0.2"
futures-util = "0.3"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
schemars = "1.2"
async-trait = "0.1"
thiserror = "2.0"
base64 = "0.23"
rmcp = { version = "3.1", features = [
  "client",
  "transport-child-process",
  "transport-streamable-http-client-reqwest",
] }

# server
axum = { version = "0.8", features = ["json", "macros"] }
tower-http = { version = "0.7", features = ["cors", "fs"] }
rust-embed = "8.12"

# cli
clap = { version = "4.6", features = ["derive", "env"] }
ratatui = "0.30"
crossterm = { version = "0.29", features = ["event-stream"] }
dialoguer = "0.12"
anyhow = "1"
```

Notable feature-flag requirements, all of which are easy to get wrong:

- `reqwest`'s `stream` feature gates `Response::bytes_stream()`, which the SSE parser needs.
- `crossterm`'s `event-stream` feature gates `EventStream`, needed to `select!` terminal
  input against agent events. Without it you only get the blocking `event::read()`.
- `rmcp`'s transports are individually gated. `client` alone is not enough — stdio needs
  `transport-child-process` and HTTP needs
  `transport-streamable-http-client-reqwest`.

Quality gates, matching the `lint`/`build` tasks in `turbo.json`:

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

## Cross-Cutting Design Decisions

### 1. `Agent` splits into `Agent` + `Conversation`

The TypeScript `Agent` class conflates immutable configuration (providers, tool registry,
MCP manager) with mutable per-conversation state (`messages`, `stats`). That works in Node
because there is one event loop and, in practice, one conversation.

In Rust the split is forced and also better:

```rust
pub struct Agent {                    // immutable; wrapped in Arc, shared freely
    providers: HashMap<String, Arc<dyn LlmProvider>>,
    tools: ToolRegistry,
    mcp: McpManager,
    active: RwLock<ActiveModel>,      // the one piece of mutable config
}

pub struct Conversation {             // per-session; owns the mutable turn state
    messages: Vec<Message>,
    stats: UsageStats,
}
```

`Agent` is `Send + Sync` and cheap to clone as an `Arc`. `Conversation` is owned by whoever
is driving a turn.

### 2. Sessions, and a concurrency bug fixed in passing

`Agent.messages` in the TypeScript version is a single `Vec`, and `startServer` creates
exactly one `Agent` for the process. Two concurrent `POST /chat` requests therefore
interleave their turns into one shared history. The result is a corrupted transcript — a
`tool` message can end up without the `assistant` message carrying its `tool_calls`, which
most providers reject outright with a 400. Node's single thread hides the interleave
*between* awaits, not across them.

The Rust server keys conversations by session:

```rust
sessions: RwLock<HashMap<SessionId, Mutex<Conversation>>>
```

The CLI uses a single implicit session. `dashmap` was considered and rejected: the
contention win is irrelevant at this scale and the extra dependency is not worth it in a
codebase whose selling point is being small.

**This bug also exists in the TypeScript version and should be fixed there.**

### 3. The active model is per-request, not provider state

`LLMProvider.setModel()` mutates the provider, and the server shares one provider across
all handlers. Porting that shape directly would require a `RwLock<String>` inside every
provider.

Instead, the model travels with the request:

```rust
async fn chat(&self, req: ChatRequest<'_>) -> Result<ChatResponse>;  // req carries the model
```

Providers become fully immutable, trivially `Send + Sync`, with no interior mutability at
all. `Agent::set_model` writes the single `RwLock<ActiveModel>` instead.

### 4. Callbacks become an event enum over a channel

The TypeScript `AgentEvents` interface is four optional closures. Rust uses one enum sent
over an `mpsc` channel:

```rust
pub enum AgentEvent {
    Delta(StreamDelta),
    ToolCall   { id: String, name: String, args: JsonObject },
    ToolResult { id: String, name: String, content: String, is_error: bool },
    Complete   { response: String, stats: StatsSummary },
    Error(String),
}
```

This is strictly better than the callback version, in three ways:

- The variants map 1:1 onto SSE event names, so the server's stream handler is a `map`.
- The TUI `select!`s the same receiver against terminal input — no reentrancy problems.
- Carrying `id` on both tool variants removes a fragile lookup. The TypeScript server
  correlated a result back to its call with
  `[...toolCalls].reverse().find(t => t.name === name)`
  (`packages/server/src/index.ts:118`). That was not actively wrong — tool calls execute
  strictly sequentially, so the newest call with a given name always was the right one —
  but it breaks silently the moment calls run in parallel or results arrive out of order.
  Both implementations now match on the id.

### 5. The `Tool` trait takes `JsonObject`, not `Value`

```rust
#[async_trait]
pub trait Tool: Send + Sync {
    fn definition(&self) -> &ToolDefinition;
    async fn execute(&self, args: JsonObject) -> Result<String, ToolError>;
}
```

`JsonObject` (`serde_json::Map<String, Value>`) rather than `Value`, because rmcp's
`CallToolRequestParams::arguments` is `Option<JsonObject>`. Matching it means MCP
passthrough needs no unwrap-and-rewrap.

Registry: `HashMap<String, Arc<dyn Tool>>`. As in the TypeScript version, `execute` never
propagates a tool failure as an `Err` to the caller — failures are captured into
`ToolResult { is_error: true }` so the model sees them as text and can recover.

### 6. Serde must mirror the TypeScript wire format exactly

Both binaries read one config file and serve one HTTP API, so the representations cannot
drift:

- `#[serde(rename_all = "camelCase")]` on config and message types, for `baseUrl`,
  `apiKey`, `systemPrompt`, `mcpServers`, `activeProvider`, `toolCallId`, `toolCalls`.
- `Content` is `#[serde(untagged)] enum { Text(String), Parts(Vec<ContentPart>) }`,
  matching TypeScript's `string | ContentPart[]`.
- `ContentPart` is `#[serde(tag = "type", rename_all = "snake_case")]` → `text` /
  `image_url`.
- `skip_serializing_if = "Option::is_none"` throughout. Absent must stay absent rather than
  becoming `null`; the OpenAI API distinguishes the two for `content`.
- Legacy single-`provider` configs keep working, via the same fallback as
  `resolveProviders`.

### 7. XDG paths are hand-rolled, not delegated

`paths.ts` uses XDG conventions on every platform. The `directories` crate resolves
`~/Library/Application Support` on macOS, which would put the Rust binary's config
somewhere the TypeScript binary never looks. Since sharing one config file is a goal,
`paths.rs` is a literal 30-line port instead.

## Deliberate Deviations from the TypeScript Version

Beyond the design decisions above, these are intentional behavioural differences:

| Area | TypeScript | Rust | Why |
|---|---|---|---|
| `bash` tool | `execSync`, blocks the event loop up to 30s | `tokio::process` + `timeout` | Streaming and the TUI freeze during every shell command today. |
| SSE keep-alive | none | `KeepAlive::default()` | Idle proxies drop long tool-running turns. |
| Tool schemas | hand-written JSON Schema literals | `schemars` derive from arg structs | Real deserialization instead of `String(args.command)`. |
| Model sort | `localeCompare` | `str::cmp` (byte order) | No locale-aware collation in std; documented, not hidden. |
| Web UI delivery | served from a directory | `rust-embed`, single binary | No Node runtime needed to serve the UI. |
| Tool-call accumulation | overwrites entry on `id` chunk | `entry().or_insert_with()` | See below. |

Two upstream bugs are fixed rather than ported:

1. **Dropped tool-call arguments.** In `handleSSE`
   (`packages/core/src/providers/openai-compatible.ts:170`), a chunk carrying `tc.id`
   overwrites the map entry and discards any `argsJson` accumulated so far. Harmless with
   providers that send the id in the first chunk, wrong in general.
2. **Tool-result misattribution.** Decision 4 above.

## Phases

Phases 1–3 produce a fully useful Rust microagent — headless agent, HTTP API, embedded web
UI, one binary, no Node — for roughly a third of the total work. Phases 4 and 5 are
independent of each other. Phase 6 is the long tail.

Rough total: ~2,300 lines of Rust, against 2,969 of TypeScript (of which ~520 is Svelte and
is not ported).

### Phase 1 — Core foundation (~700 LOC)

| File | Ports from |
|---|---|
| `core/src/types.rs` | `types.ts` |
| `core/src/paths.rs` | `paths.ts` |
| `core/src/stats.rs` | `stats.ts` |
| `core/src/tool_registry.rs` | `tool-registry.ts` |
| `core/src/providers/openai_compatible.rs` | `openai-compatible.ts` |
| `core/src/providers/factory.rs` | `factory.ts` |
| `core/src/agent.rs` | `agent.ts` |

`openai_compatible.rs` is the largest single file: request construction, message
conversion, the SSE stream parser (`bytes_stream()` → `eventsource-stream` → chunk parse →
`StreamDelta`), and `list_models`. `UsageStats` uses `Instant` for elapsed time, as
`Date.now()` has no direct analog.

Preset table becomes a `match` on `config.type` with an unknown-type fallback to raw
OpenAI-compatible, exactly as the TypeScript factory does.

**Exit criteria:** the four `tool-registry.test.ts` cases ported and green; one `#[ignore]`d
integration test performing a real streaming tool-call round-trip against local Ollama.

### Phase 2 — `ask` subcommand and built-in tools (~350 LOC)

A `clap` derive CLI with a flattened `ProviderOpts` struct mirroring `addProviderOpts`, and
config discovery matching `loadConfig` (explicit `--config`, then the XDG path, then
`./microagent.config.json`, then flag defaults).

`ask` takes its prompt from varargs or stdin (`!stdin().is_terminal()`), streams response
text to stdout and tool progress to stderr, with `-r/--raw` suppressing both and `-a`
attaching images.

Four tools — `file_read`, `file_write`, `bash`, `list_directory` — each with a
`#[derive(Deserialize, JsonSchema)]` argument struct.

A caveat about `schemars` 1.x that shapes this phase: it emits a root
`"$schema": "https://json-schema.org/draft/2020-12/schema"` key and hoists nested types
into `$defs`/`$ref`. Both are hostile to LLM function-calling, and several providers
(Ollama among them) mishandle `$ref` inside tool parameters. So:

- Strip the root `$schema` key before handing a schema to a provider.
- Keep every argument struct flat and primitive, so no `$defs` is ever generated.
- Add `#[serde(deny_unknown_fields)]` to get `additionalProperties: false`, which strict
  function-calling modes want.
- A unit test asserts no generated schema contains `$defs`, so this cannot regress
  silently.

**Exit criteria:** `microagent ask 'hi'` streams against Ollama; `microagent ask 'read
Cargo.toml'` completes a tool round-trip.

### Phase 3 — axum server (~250 LOC)

All seven routes: `GET /health`, `GET /tools`, `GET /stats`, `GET /models`,
`GET|POST /model`, `POST /chat`, `POST /chat/stream`. `tower-http`'s `CorsLayer` and
`ServeDir` (with SPA fallback) replace `@fastify/cors` and `@fastify/static`.

`/chat/stream` spawns the turn onto a task, wraps the receiver in `ReceiverStream`, maps
each `AgentEvent` to `sse::Event::default().event(name).json_data(payload)`, and returns
`Sse::new(stream).keep_alive(KeepAlive::default())`.

Fastify's JSON-schema body validation has no axum equivalent; `Json<T>` deserialization
plus a rejection mapper produces the same 400s.

`rust-embed` bakes `packages/web/build` into the binary behind an `embed-web` feature, so
`microagent ui` is a single file with no Node runtime — the clearest practical win of the
port.

**Exit criteria:** the four `routes.test.ts` cases ported via `tower::ServiceExt::oneshot`;
the existing Svelte UI runs unmodified against the Rust server.

### Phase 4 — GitHub Copilot device auth (~250 LOC)

A direct port of `github-auth.ts`: device-code request, poll loop honouring
`authorization_pending` / `slow_down` / `expired_token` / `access_denied`, then exchange for
a Copilot session token, cached with the same 300-second expiry buffer.

Provider authentication becomes `enum Auth { Static(String), Copilot }`, resolved per
request, rather than the TypeScript `getApiKey?: () => Promise<string>` closure. There are
exactly two cases, and closures returning futures inside a `Sync` provider get unpleasant
quickly.

The `{ mode: 0o600 }` token write needs `#[cfg(unix)]` and `PermissionsExt`. On Windows the
file is created without ACL restriction, matching the TypeScript version, which silently
ignores the mode there.

**Exit criteria:** a manual device-flow run producing a working `models` listing; the cached
token file stays readable by the TypeScript implementation.

### Phase 5 — MCP client via rmcp (~150 LOC)

`McpManager::connect` matches on transport: stdio via `TokioChildProcess` wrapping
`tokio::process::Command`, HTTP via `StreamableHttpClientTransport`. Then `list_tools`, and
each discovered tool becomes a `Tool` implementation named `{server}__{tool}` whose
`execute` calls
`peer.call_tool(CallToolRequestParams::new(name).with_arguments(args))`, joins the text
parts of `CallToolResult.content`, and maps `is_error` to `Err`.

One difference from the TypeScript SDK worth noting in a comment rather than acting on:
rmcp 3.x exposes task metadata (SEP-1319) for long-running tool calls, which the TypeScript
path does not use. Ignore it for parity; it is the natural next feature.

**Exit criteria:** connect to a real stdio MCP server, list its tools, execute one
end-to-end.

### Phase 6 — ratatui TUI and dialoguer wizard (~600 LOC)

A rewrite, not a port. Ink's declarative React model has no Rust analog.

```
cli/src/tui/
  mod.rs        App state: Vec<OutputLine>, input, streaming buffer, busy, pending_images
  event.rs      tokio::select! over EventStream and mpsc::Receiver<AgentEvent>
  render.rs     Layout: history (scrollable) / streaming / input / status bar
  commands.rs   /stats /tools /models /model /image /quit
```

Use `ratatui::init()` for its panic hook — without it, a panic leaves the terminal in raw
mode and the alternate screen — with an explicit `restore()` on exit. Drive input through
`crossterm`'s `EventStream` rather than the blocking `event::read()` shown in ratatui's own
docs, so keystrokes and agent deltas interleave in one `select!`. Note that ratatui
documents only the blocking loop; the async integration is ours to build.
`ratatui::run()` is sync-`FnOnce` and does not fit under `#[tokio::main]`.

State that Ink holds in `useState` becomes fields on `App`, mutated by a
`handle(AgentEvent)` method. The channel from decision 4 is what makes this
straightforward.

Two things Ink provides for free that have to be built here:

- **Text input.** A small cursor-and-editing struct, or the `tui-input` crate.
- **History scrolling.** Ink simply grows the terminal's scrollback; ratatui owns a fixed
  viewport, so scroll offset and line wrapping become explicit state. This is the main
  reason the phase is ~600 lines rather than ~350.

The 457-line `ConfigWizard.tsx` becomes roughly 120 lines of `dialoguer`: `Select` for
provider type, `Input` for model and base URL, `Password` for the API key, `Confirm` to add
another provider, `FuzzySelect` over fetched models. It runs before the TUI starts, so it
never contends for the terminal.

**Exit criteria:** `microagent chat` reaches parity with the Ink UI, including mid-stream
tool-call display and `/model` persistence.

## Testing Strategy

- **Unit** — `tool_registry` (ported from `tool-registry.test.ts`), serde round-trips
  against fixtures captured from the TypeScript wire format, SSE chunk parsing including
  the split-`id` case that the TypeScript version gets wrong, tool-schema shape assertions.
- **Route** — `tower::ServiceExt::oneshot` against the axum router, porting
  `routes.test.ts`.
- **Integration, `#[ignore]`d** — real streaming and tool round-trips against local Ollama,
  run explicitly with `cargo test -- --ignored`.
- **Cross-implementation** — a config file written by the TypeScript wizard must load in
  the Rust binary and vice versa. This is the guard on decision 6 and deserves a test, not
  just care.

## Risks

Ordered by how likely they are to move the estimate:

1. **The ratatui scrolling viewport** is the least specified part of this plan and the most
   likely to need iteration.
2. **rmcp 3.x's API** is confirmed against current docs but not yet compiled against.
3. **Provider-specific tool-schema quirks** are only really discoverable by running against
   each endpoint, which is why the `$defs` assertion goes in at phase 2 rather than later.

---

# Outcome

All six phases are implemented. This section records what actually happened,
including where the plan above was wrong.

## Actuals

| Metric | Planned | Actual |
|---|---|---|
| Implementation LOC | ~2,300 | 4,901 |
| Test LOC | not estimated | 2,813 |
| Tests | not estimated | 166 (1 opt-in) |
| Release binary (`--features embed-web`) | — | 12.6 MB |

The LOC estimate was off by 2.1×. The gap is not one thing: explicit serde types
and error enums, dense doc comments recording *why* each deviation exists,
defensive null handling that live servers turned out to require, and a TUI that
came in above its own estimate. The phase *ordering* held up — phases 1–3 did
produce a useful agent for roughly a third of the work.

Quality gates, run against both `--all-features` and default features:

```sh
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
```

## Corrections to the plan

Things the plan got wrong, discovered by compiling and running:

- **`reqwest` 0.13 renamed its TLS features.** `rustls-tls` is now `rustls`, and
  ≥0.13.2 folded the cert-source features in entirely — `rustls-native-certs`
  no longer exists, because `rustls` pulls `rustls-platform-verifier` and reads
  the OS trust store by default. `rmcp` 3.1 also requires `reqwest ≥0.13.2`, so
  the workspace floor is pinned there.
- **`schemars` has a better answer than the discipline the plan proposed.**
  Rather than merely forbidding nested argument types, `SchemaSettings` exposes
  `inline_subschemas` (no `$defs`/`$ref` ever emitted) and `meta_schema: None`
  (no root `$schema`). Combined with `draft07`, nested types are now
  structurally safe instead of a rule someone has to remember. The `$defs`
  assertion test remains as a guard.
- **`rmcp` was lower-risk than estimated.** It was scheduled last for that
  reason; the client API mapped onto `McpManager` almost directly and needed no
  exploration budget.
- **`dialoguer`'s `FuzzySelect` is feature-gated** behind `fuzzy-select`.
- **`tower_http`'s `not_found_service` wraps in `SetStatus<404>`**, which would
  have served the SPA shell with a 404 on every client-side route. `.fallback()`
  is the correct method.
- **`ratatui::run()` does not fit an async app** (it is sync `FnOnce`), so
  `init()`/`restore()` are used explicitly, as the plan anticipated.

## Bugs found and fixed

Five defects. Four originated in the TypeScript implementation, and **all of those
have now been fixed there too**, with regression tests.

1. **Dropped tool-call arguments** (`openai-compatible.ts`) — a chunk carrying
   `tc.id` replaced the accumulator entry, discarding any arguments buffered
   before it. Harmless when the id arrives in the first chunk, silently
   corrupting for providers that send arguments first.
   *Fixed in both. Regression tests:
   `arguments_buffered_before_the_id_arrives_are_not_discarded` (Rust),
   `does not discard arguments buffered before the id arrives` (TS).*

2. **Tool-result correlation by name** (`server/src/index.ts`) — results were
   matched to calls with `[...toolCalls].reverse().find(t => t.name === name)`.
   This was **latent, not active**: the agent executes tool calls strictly
   sequentially (call, await, result), so the newest call with a given name
   always was the correct one. It breaks the moment calls run in parallel or
   results arrive out of order. My initial report overstated this as an active
   defect; the TypeScript test written for it passes against the old code, which
   is how the overstatement was caught.
   *Fixed in both as a robustness change; both now match on the id and carry it
   on the SSE `tool_call` / `tool_result` events.*

3. **Corrupted history on concurrent requests** — `Agent.messages` is one array
   shared by the whole process, so two overlapping `run()` calls interleave their
   appends and can produce a `tool` message with no preceding `assistant`
   message carrying its `tool_calls`, which most providers reject with a 400.
   *Fixed in both, by different means: Rust keys conversations by session; the
   TypeScript `Agent` serialises turns through a promise queue, which fixes the
   corruption without restructuring its public API. Regression test:
   `serialises overlapping runs into a well-formed history`.*

4. **Model persisted onto the wrong provider** — the legacy single-`provider`
   branch wrote the new model unconditionally, so starting with `-p ollama`
   against a `github-copilot` config and switching models stamped an Ollama model
   onto the Copilot entry. Found by running the real server against a real config
   — it corrupted one.
   *Fixed in both. In TypeScript the logic was duplicated in the server and in
   `Chat.tsx`, and both copies had the bug; they now share one `persistModel`
   helper in core. Regression test: `leaves a non-matching legacy provider
   untouched`.*

5. **CLI flags silently ignored** — `loadConfig` returned as soon as it found a
   config file, so `-p github-copilot -m gpt-4o` did nothing whenever one
   existed, despite the README documenting it.
   *Fixed in both. The TypeScript provider flags no longer carry commander
   defaults (so "unset" is distinguishable from "explicitly set"), and
   `applyOverrides` layers flags on top of the loaded file. Verified end to end:
   with a `github-copilot` config on disk, `-p ollama` now produces an
   `ollama error`, and omitting the flag produces a `github-copilot error`.*

Two further problems were found only by running against live servers, and neither
was predictable from the specification:

- **Ollama returns `{"data":null}`** from `/v1/models` when nothing is pulled.
  `#[serde(default)]` covers a *missing* field, not an explicit null, so this
  failed to decode. The TypeScript version survives it by accident via `?? []`.
  A `null_to_default` helper now covers every collection field a provider might
  null out. *(Rust-only bug; the TypeScript behaviour is now covered by a test.)*
- **clap promotes a flattened struct's doc comment** to the command's
  `long_about`, so `--help` was printing internal implementation notes instead
  of the tool description. *(Rust-only.)*

One UI bug was found by a headless render test: at 40 columns the status bar
truncates, and the scroll indicator was last — so it vanished exactly when the
user most needed to know they were not following the tail. Status segments are
now ordered by priority. *(Rust-only.)*

## Verification performed

Beyond the unit and route tests:

- **Streaming, tool calls and error paths** are covered by integration tests
  driving a real socket (`crates/core/tests/streaming.rs`), so
  `reqwest` → `eventsource-stream` → accumulator is exercised as one piece.
- **MCP** is tested against a real stdio server — a dependency-free Python
  fixture in `crates/core/tests/fixtures/`, so no `npx` download or network is
  needed (`crates/core/tests/mcp.rs`).
- **Cross-implementation compatibility is confirmed, not just asserted.** The
  Rust binary read the Copilot token cache written by the TypeScript
  implementation, silently refreshed the expired session token from the
  long-lived OAuth token, and listed live models.
- **Full stack against a real provider** — `microagent ask` completed a
  streaming turn with a real tool call and result against GitHub Copilot, and
  again through an MCP tool.
- **The web UI runs unmodified** against the Rust server, including the SPA
  fallback and the embedded single-binary build.
- **The TUI** is covered by headless `TestBackend` render assertions and was
  driven end-to-end in a real pty, confirming alternate-screen enter/restore.

## Still unverified

- **The device flow's interactive path.** Token *refresh* is confirmed against
  the real cache, but the first-run device-code flow was not exercised, since
  a valid OAuth token was already present.
- **`agent_loop_against_ollama`** is `#[ignore]`d — it needs a tool-capable model
  pulled locally. Run it with:
  `cargo test -p microagent-core -- --ignored`
- **Windows.** The `#[cfg(unix)]` / `#[cfg(windows)]` branches compile-check
  only; nothing was run there.
