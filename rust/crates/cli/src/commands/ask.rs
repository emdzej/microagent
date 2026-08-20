//! One-shot query, porting the `ask` subcommand from
//! `packages/cli/src/bin.ts`.

use std::io::{IsTerminal, Read, Write};

use anyhow::{Result, bail};
use microagent_core::{AgentEvent, StreamDelta};
use tokio::sync::mpsc;

use crate::cli::ProviderOpts;
use crate::config::load_config;
use crate::image::resolve_image;

/// Preview length for tool results echoed to stderr.
const PREVIEW: usize = 200;

pub async fn run(
    opts: &ProviderOpts,
    prompt_parts: Vec<String>,
    attachments: Vec<String>,
    raw: bool,
) -> Result<()> {
    let prompt = resolve_prompt(prompt_parts)?;

    let images = attachments
        .iter()
        .map(|a| resolve_image(a).ok_or_else(|| anyhow::anyhow!("File not found: {a}")))
        .collect::<Result<Vec<_>>>()?;

    let loaded = load_config(opts)?;
    let agent = crate::commands::build_agent(loaded.config).await?;
    let mut conversation = agent.new_conversation();

    let (tx, mut rx) = mpsc::channel::<AgentEvent>(256);

    // Progress goes to stderr and streamed text to stdout, so `microagent ask`
    // stays pipeable: `microagent ask 'x' > out.txt` captures only the answer.
    let printer = tokio::spawn(async move {
        let mut stdout = std::io::stdout();
        while let Some(event) = rx.recv().await {
            match event {
                AgentEvent::Delta(StreamDelta::Text { text }) if !raw => {
                    let _ = stdout.write_all(text.as_bytes());
                    let _ = stdout.flush();
                }
                AgentEvent::ToolCall { name, .. } if !raw => {
                    eprintln!("→ {name}");
                }
                AgentEvent::ToolResult { name, content, .. } if !raw => {
                    eprintln!("← {name}: {}", preview(&content));
                }
                _ => {}
            }
        }
    });

    let result = agent
        .run(&mut conversation, &prompt, &images, Some(&tx))
        .await;

    // Dropping the sender ends the printer task; await it so all output is
    // flushed before the process exits.
    drop(tx);
    let _ = printer.await;

    agent.shutdown().await;

    let response = result?;

    let mut stdout = std::io::stdout();
    if raw {
        stdout.write_all(response.as_bytes())?;
    } else {
        // Newline after the streamed output.
        stdout.write_all(b"\n")?;
    }
    stdout.flush()?;

    Ok(())
}

/// Resolve the prompt from positional arguments, else stdin.
fn resolve_prompt(parts: Vec<String>) -> Result<String> {
    if !parts.is_empty() {
        return Ok(parts.join(" "));
    }

    if std::io::stdin().is_terminal() {
        bail!("provide a prompt as arguments or pipe via stdin.");
    }

    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf)?;
    let prompt = buf.trim().to_string();
    if prompt.is_empty() {
        bail!("empty prompt.");
    }
    Ok(prompt)
}

/// Truncate a tool result for the stderr progress line.
fn preview(content: &str) -> String {
    if content.chars().count() <= PREVIEW {
        return content.to_string();
    }
    let truncated: String = content.chars().take(PREVIEW).collect();
    format!("{truncated}...")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positional_parts_are_joined_with_spaces() {
        assert_eq!(
            resolve_prompt(vec!["explain".into(), "this".into()]).unwrap(),
            "explain this"
        );
    }

    #[test]
    fn preview_truncates_on_character_boundaries() {
        // Slicing bytes here would panic on the multi-byte boundary.
        let content = "é".repeat(PREVIEW + 50);
        let out = preview(&content);
        assert!(out.ends_with("..."));
        assert_eq!(out.chars().count(), PREVIEW + 3);
    }

    #[test]
    fn short_content_is_not_truncated() {
        assert_eq!(preview("hello"), "hello");
    }
}
