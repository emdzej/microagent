//! Command-line interface, porting the commander setup in
//! `packages/cli/src/bin.ts`.

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};
use microagent_core::paths;

#[derive(Debug, Parser)]
#[command(
    name = "microagent",
    version,
    about = "Minimal AI coding agent with tool & MCP support"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,

    #[command(flatten)]
    pub opts: ProviderOpts,
}

// Provider selection flags.
//
// Declared `global`, so they are accepted before or after a subcommand:
// `microagent -m phi4 ask 'hi'` and `microagent ask -m phi4 'hi'` both work.
// Every field is optional so that "not passed" is distinguishable from "passed
// the default value" — `crate::config::load_config` needs that distinction to
// know what to override.
//
// Note: this must NOT be a doc comment. clap promotes the doc comment of a
// flattened struct to the command's `long_about`, which would replace the
// top-level help text with these implementation notes.
#[derive(Debug, Default, Clone, Args)]
pub struct ProviderOpts {
    /// LLM provider: ollama | github-copilot | openai | <any>
    #[arg(short = 'p', long, global = true)]
    pub provider: Option<String>,

    /// Model name
    #[arg(short = 'm', long, global = true)]
    pub model: Option<String>,

    /// Provider base URL
    #[arg(long, global = true)]
    pub base_url: Option<String>,

    /// API key (or use OPENAI_API_KEY env)
    #[arg(long, global = true, env = "MICROAGENT_API_KEY", hide_env = true)]
    pub api_key: Option<String>,

    /// Path to config JSON file
    #[arg(short = 'c', long, global = true, env = "MICROAGENT_CONFIG")]
    pub config: Option<PathBuf>,

    /// System prompt
    #[arg(short = 's', long, global = true)]
    pub system: Option<String>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Start interactive chat (default)
    Chat,

    /// Start HTTP server for remote access
    Serve {
        /// Bind host
        #[arg(short = 'H', long, default_value = "0.0.0.0")]
        host: String,
        /// Bind port
        #[arg(long, default_value_t = 3100)]
        port: u16,
    },

    /// Start server + web UI
    Ui {
        /// Bind host
        #[arg(short = 'H', long, default_value = "0.0.0.0")]
        host: String,
        /// Bind port
        #[arg(long, default_value_t = 3200)]
        port: u16,
        /// Don't open a browser automatically
        #[arg(long)]
        no_open: bool,
        /// Directory of built web assets. Defaults to the embedded copy when
        /// compiled with the `embed-web` feature.
        #[arg(long)]
        static_dir: Option<PathBuf>,
    },

    /// Interactive config wizard
    Config {
        /// Output file path
        #[arg(short = 'o', long, default_value_os_t = paths::config_file())]
        output: PathBuf,
    },

    /// List available models for all configured providers
    Models,

    /// Run a single query and exit. Prompt from args or stdin.
    Ask {
        /// The prompt. If omitted, read from stdin.
        prompt: Vec<String>,

        /// Attach an image (repeatable)
        #[arg(short = 'a', long = "attachment")]
        attachments: Vec<String>,

        /// Output only the final response text (no tool calls, no stats)
        #[arg(short = 'r', long)]
        raw: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn cli_definition_is_valid() {
        Cli::command().debug_assert();
    }

    #[test]
    fn no_subcommand_means_chat() {
        let cli = Cli::try_parse_from(["microagent"]).unwrap();
        assert!(cli.command.is_none());
    }

    #[test]
    fn provider_flags_are_accepted_before_and_after_a_subcommand() {
        let before = Cli::try_parse_from(["microagent", "-m", "phi4", "ask", "hi"]).unwrap();
        let after = Cli::try_parse_from(["microagent", "ask", "-m", "phi4", "hi"]).unwrap();
        assert_eq!(before.opts.model.as_deref(), Some("phi4"));
        assert_eq!(after.opts.model.as_deref(), Some("phi4"));
    }

    #[test]
    fn unpassed_flags_stay_none_so_overrides_can_be_detected() {
        let cli = Cli::try_parse_from(["microagent", "chat"]).unwrap();
        assert!(cli.opts.model.is_none());
        assert!(cli.opts.provider.is_none());
    }

    #[test]
    fn ask_collects_a_multi_word_prompt_and_repeated_attachments() {
        let cli = Cli::try_parse_from([
            "microagent",
            "ask",
            "-a",
            "one.png",
            "-a",
            "two.png",
            "-r",
            "explain",
            "this",
        ])
        .unwrap();
        match cli.command {
            Some(Command::Ask {
                prompt,
                attachments,
                raw,
            }) => {
                assert_eq!(prompt, vec!["explain", "this"]);
                assert_eq!(attachments, vec!["one.png", "two.png"]);
                assert!(raw);
            }
            other => panic!("expected ask, got {other:?}"),
        }
    }

    #[test]
    fn serve_and_ui_have_the_documented_default_ports() {
        match Cli::try_parse_from(["microagent", "serve"])
            .unwrap()
            .command
        {
            Some(Command::Serve { port, host }) => {
                assert_eq!(port, 3100);
                assert_eq!(host, "0.0.0.0");
            }
            other => panic!("expected serve, got {other:?}"),
        }
        match Cli::try_parse_from(["microagent", "ui"]).unwrap().command {
            Some(Command::Ui { port, .. }) => assert_eq!(port, 3200),
            other => panic!("expected ui, got {other:?}"),
        }
    }
}
