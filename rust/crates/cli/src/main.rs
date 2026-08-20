mod cli;
mod commands;
mod config;
mod image;
mod tools;
mod tui;

use anyhow::Result;
use clap::Parser;

use crate::cli::{Cli, Command};

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    // No subcommand means chat, matching commander's `isDefault: true`.
    match cli.command.unwrap_or(Command::Chat) {
        Command::Chat => commands::chat::run(&cli.opts).await,
        Command::Ask {
            prompt,
            attachments,
            raw,
        } => commands::ask::run(&cli.opts, prompt, attachments, raw).await,
        Command::Models => commands::models::run(&cli.opts).await,
        Command::Serve { host, port } => {
            commands::serve::run(&cli.opts, &host, port, None, false, false).await
        }
        Command::Ui {
            host,
            port,
            no_open,
            static_dir,
        } => {
            commands::serve::run(
                &cli.opts,
                &host,
                port,
                static_dir.as_deref(),
                true,
                !no_open,
            )
            .await
        }
        Command::Config { output } => commands::config_wizard::run(&output).await,
    }
}
