//! Slash commands, porting the command handling in `Chat.tsx`.

use std::collections::BTreeMap;

use tokio::sync::mpsc;

use crate::config::persist_model;
use crate::image::resolve_image;
use crate::tui::{App, LineKind, OutputLine, UiMessage};

const HELP: &[(&str, &str)] = &[
    ("/stats", "Show token and tool-call counters"),
    ("/tools", "List registered tools"),
    ("/models", "List models across all providers"),
    ("/model [provider/model]", "Show or switch the active model"),
    (
        "/image <path-or-url>",
        "Attach an image to the next message",
    ),
    ("/clear", "Clear the history view"),
    ("/help", "Show this help"),
    ("/quit", "Exit (also /exit, Ctrl+C)"),
];

/// Handle a slash command. Anything unrecognised is reported, not sent to the
/// model, so a typo does not silently cost a request.
pub fn dispatch(app: &mut App, line: &str, tx: &mpsc::Sender<UiMessage>) {
    let (command, rest) = match line.split_once(char::is_whitespace) {
        Some((c, r)) => (c, r.trim()),
        None => (line, ""),
    };

    match command {
        "/quit" | "/exit" => app.should_quit = true,

        "/clear" => {
            app.lines.clear();
            app.scroll = 0;
        }

        "/help" => {
            app.info("Commands:");
            for (name, description) in HELP {
                app.info(format!("  {name:<26} {description}"));
            }
        }

        "/stats" => {
            // The conversation is only locked by a running turn, and input is
            // frozen then, so this cannot block.
            let summary = match app.conversation.try_lock() {
                Ok(guard) => guard.stats().format(),
                Err(_) => "stats unavailable while a turn is running".to_string(),
            };
            for line in summary.lines() {
                app.info(line.to_string());
            }
        }

        "/tools" => {
            let tools = app.agent.tools().list();
            app.info(format!(
                "Registered tools ({}): {}",
                tools.len(),
                if tools.is_empty() {
                    "(none)".to_string()
                } else {
                    tools.join(", ")
                }
            ));
        }

        "/models" => {
            app.info("Fetching models from all providers...");
            app.busy = true;

            let agent = app.agent.clone();
            let tx = tx.clone();
            // Network-bound, so it runs off the event loop and reports back
            // through the same channel a turn uses.
            tokio::spawn(async move {
                let models = agent.list_all_models().await;
                let active = agent.active();
                let mut lines = Vec::new();

                if models.is_empty() {
                    lines.push(OutputLine::new(LineKind::Info, "No models found."));
                } else {
                    let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
                    for m in models {
                        grouped.entry(m.provider).or_default().push(m.id);
                    }

                    let count: usize = grouped.values().map(Vec::len).sum();
                    let providers = grouped.len();

                    for (provider, ids) in grouped {
                        let marker = if provider == active.provider {
                            " (active)"
                        } else {
                            ""
                        };
                        lines.push(OutputLine::new(
                            LineKind::Info,
                            format!("  {provider}{marker}:"),
                        ));
                        for id in ids {
                            let current = if provider == active.provider && id == active.model {
                                " ←"
                            } else {
                                ""
                            };
                            lines.push(OutputLine::new(
                                LineKind::Info,
                                format!("    {provider}/{id}{current}"),
                            ));
                        }
                    }
                    lines.push(OutputLine::new(
                        LineKind::Info,
                        format!("{count} model(s) across {providers} provider(s)."),
                    ));
                }

                let _ = tx.send(UiMessage::Lines(lines)).await;
                let _ = tx.send(UiMessage::Idle).await;
            });
        }

        "/model" => {
            if rest.is_empty() {
                let active = app.agent.active();
                app.info(format!("Current: {}/{}", active.provider, active.model));
                return;
            }

            match app.agent.set_model(rest) {
                Ok(active) => {
                    app.info(format!("Switched to {}/{}", active.provider, active.model));

                    if let Some(path) = app.config_path.clone() {
                        match persist_model(&path, &active.provider, &active.model) {
                            Ok(()) => app.info(format!("Config saved to {}", path.display())),
                            Err(err) => app.error(format!("Failed to save config: {err}")),
                        }
                    }
                }
                Err(err) => app.error(err.to_string()),
            }
        }

        "/image" => {
            if rest.is_empty() {
                app.error("Usage: /image <file-path-or-url>");
                return;
            }
            match resolve_image(rest) {
                Some(url) => {
                    app.pending_images.push(url);
                    let suffix = if rest.starts_with("http") {
                        String::new()
                    } else {
                        format!(" ({rest})")
                    };
                    app.info(format!(
                        "Image queued{suffix}. Type your message to send with the image."
                    ));
                }
                None => app.error(format!("File not found: {rest}")),
            }
        }

        other => {
            app.error(format!("Unknown command: {other}. Try /help"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tui::tests_support::test_app;

    fn channel() -> mpsc::Sender<UiMessage> {
        mpsc::channel(64).0
    }

    #[test]
    fn quit_and_exit_both_stop_the_app() {
        for command in ["/quit", "/exit"] {
            let mut app = test_app();
            dispatch(&mut app, command, &channel());
            assert!(app.should_quit, "{command} should quit");
        }
    }

    #[test]
    fn clear_empties_the_history() {
        let mut app = test_app();
        assert!(!app.lines.is_empty());
        dispatch(&mut app, "/clear", &channel());
        assert!(app.lines.is_empty());
        assert_eq!(app.scroll, 0);
    }

    #[test]
    fn tools_lists_the_registry() {
        let mut app = test_app();
        dispatch(&mut app, "/tools", &channel());
        assert!(app.lines.last().unwrap().text.contains("Registered tools"));
    }

    #[test]
    fn model_without_arguments_reports_the_current_model() {
        let mut app = test_app();
        dispatch(&mut app, "/model", &channel());
        assert_eq!(app.lines.last().unwrap().text, "Current: ollama/llama3.2");
    }

    #[test]
    fn model_with_a_bare_name_switches_the_model() {
        let mut app = test_app();
        dispatch(&mut app, "/model qwen2.5", &channel());
        assert_eq!(app.agent.active().model, "qwen2.5");
        assert!(app.lines.last().unwrap().text.contains("Switched to"));
    }

    #[test]
    fn stats_prints_both_summary_lines() {
        let mut app = test_app();
        let before = app.lines.len();
        dispatch(&mut app, "/stats", &channel());
        assert_eq!(app.lines.len() - before, 2, "expected a two-line summary");
    }

    #[test]
    fn help_lists_every_command() {
        let mut app = test_app();
        dispatch(&mut app, "/help", &channel());
        let rendered: String = app.lines.iter().map(|l| l.text.clone()).collect();
        for (name, _) in HELP {
            let head = name.split(' ').next().unwrap();
            assert!(rendered.contains(head), "help is missing {head}");
        }
    }

    #[test]
    fn image_requires_an_argument_and_rejects_a_missing_file() {
        let mut app = test_app();

        dispatch(&mut app, "/image", &channel());
        assert_eq!(app.lines.last().unwrap().kind, LineKind::Error);

        dispatch(&mut app, "/image /nope/missing.png", &channel());
        assert_eq!(app.lines.last().unwrap().kind, LineKind::Error);
        assert!(app.pending_images.is_empty());
    }

    #[test]
    fn image_queues_a_url_without_touching_the_filesystem() {
        let mut app = test_app();
        dispatch(&mut app, "/image https://example.test/a.png", &channel());
        assert_eq!(app.pending_images.len(), 1);
        assert_eq!(app.pending_images[0], "https://example.test/a.png");
    }

    #[test]
    fn an_unknown_command_is_reported_rather_than_sent_to_the_model() {
        let mut app = test_app();
        dispatch(&mut app, "/nonsense", &channel());
        assert_eq!(app.lines.last().unwrap().kind, LineKind::Error);
        assert!(app.lines.last().unwrap().text.contains("Unknown command"));
        assert!(!app.busy, "an unknown command must not start a turn");
    }
}
