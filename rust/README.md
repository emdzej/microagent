# microagent (Rust)

A Rust implementation of microagent, living beside the TypeScript one. Same agent
loop, same provider abstraction, same tool registry, same MCP client — expressed
in a language with very different constraints.

The two implementations are interoperable by design: they share one config file
(`~/.config/microagent/config.json`), one Copilot token cache, one HTTP API shape,
and one web UI build. Either binary can serve the same front-end and read the
same settings.

> **[Rust Port Plan](../docs/RUST_PORT_PLAN.md)** — the design decisions, the
> deliberate deviations from the TypeScript version, and an honest record of what
> the port turned up.

## Install

Prebuilt binaries for Linux, macOS (Intel and Apple Silicon) and Windows are
attached to each [release](../../../releases), with SHA-256 checksums. They embed
the web UI, so there is nothing else to install:

```sh
tar -xzf microagent-<version>-<target>.tar.gz
./microagent-<version>-<target>/microagent chat
```

## Build

Requires Rust 1.97+ (edition 2024).

```sh
cd rust
cargo build --release
```

To bake the web UI into the binary — one self-contained file, no Node runtime:

```sh
pnpm --filter @microagent/web build      # from the repo root, once
cargo build --release --features embed-web
```

That produces a ~12.6 MB `target/release/microagent` that serves the full web UI
from anywhere on disk.

## Run

From the repository root, the same commands are available as pnpm scripts —
`pnpm rust:chat`, `pnpm rust:ask`, `pnpm rust:serve`, `pnpm rust:ui`,
`pnpm rust:wizard`, `pnpm rust:test`, `pnpm rust:lint`.

```sh
cargo run -- config                  # interactive config wizard
cargo run -- chat                    # interactive TUI
cargo run -- ask 'explain this'      # one-shot query
echo 'explain this error' | cargo run -- ask
cargo run -- ask -a shot.png -r 'describe this image'
cargo run -- models                  # list models across all providers
cargo run -- serve                   # HTTP API on :3100
cargo run -- ui                      # API + web UI on :3200
```

Provider flags are global — accepted before or after the subcommand:

```
-p, --provider <type>   ollama | github-copilot | openai | <any>
-m, --model <name>      Model name
    --base-url <url>    Provider base URL
    --api-key <key>     API key
-c, --config <path>     Path to config JSON
-s, --system <prompt>   System prompt
```

Unlike the TypeScript CLI, these override a config file that was found rather
than being ignored when one exists.

## TUI keys

| Key | Action |
|---|---|
| `Enter` | Send |
| `Ctrl+C` | Quit (also `Ctrl+D` on an empty line) |
| `PageUp` / `PageDown` | Scroll history |
| `Ctrl+Home` / `Ctrl+End` | Jump to top / follow the tail |
| `Ctrl+A` / `Ctrl+E` | Start / end of line |
| `Ctrl+K` / `Ctrl+U` / `Ctrl+W` | Kill to end / to start / previous word |

Commands: `/stats` `/tools` `/models` `/model` `/image` `/clear` `/help` `/quit`

## Layout

```
crates/
  core/     microagent-core     types, agent loop, providers, tools, MCP client
  server/   microagent-server   axum REST + SSE
  cli/      microagent (bin)    clap + ratatui TUI + built-in tools
```

## Tests

```sh
cargo test --all-features
cargo clippy --all-targets --all-features -- -D warnings
cargo fmt --check
```

166 tests. The MCP tests run against a real stdio server (a dependency-free
Python fixture, so no network), and the provider tests drive a real socket rather
than mocking the transport.

One test is opt-in because it needs a live model:

```sh
ollama pull llama3.2
cargo test -p microagent-core -- --ignored
```
