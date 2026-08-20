//! Interactive chat TUI, replacing `packages/cli/src/components/Chat.tsx`.
//!
//! A rewrite rather than a port: Ink's declarative React model has no Rust
//! analog. State that Ink keeps in `useState` lives on [`App`]; the render
//! function redraws the whole frame each tick.
//!
//! The event loop is the reason the [`AgentEvent`] channel design pays off here —
//! terminal input and agent progress are two streams `select!`ed together, with
//! no callbacks reaching back into UI state.

mod commands;
mod input;
mod render;
mod wrap;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use crossterm::event::{Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use futures_util::StreamExt;
use microagent_core::{Agent, AgentEvent, Conversation, StatsSummary, StreamDelta};
use tokio::sync::{Mutex, mpsc};

use crate::tui::input::TextInput;

/// How a history line is styled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    User,
    Assistant,
    Tool,
    Error,
    Info,
}

#[derive(Debug, Clone)]
pub struct OutputLine {
    pub kind: LineKind,
    pub text: String,
}

impl OutputLine {
    pub fn new(kind: LineKind, text: impl Into<String>) -> Self {
        OutputLine {
            kind,
            text: text.into(),
        }
    }
}

/// Messages the UI reacts to, from any source.
///
/// Wrapping [`AgentEvent`] rather than using it directly lets slash commands
/// that need to await something (`/models` hits the network) report back through
/// the same channel as a running turn.
enum UiMessage {
    Agent(AgentEvent),
    Lines(Vec<OutputLine>),
    /// A turn or command finished; re-enable input.
    Idle,
}

pub struct App {
    agent: Arc<Agent>,
    conversation: Arc<Mutex<Conversation>>,
    config_path: Option<PathBuf>,
    lines: Vec<OutputLine>,
    input: TextInput,
    /// Text streamed so far in the current turn, shown live.
    streaming: String,
    busy: bool,
    pending_images: Vec<String>,
    /// Display lines scrolled up from the bottom. Zero means follow the tail.
    scroll: usize,
    stats: StatsSummary,
    should_quit: bool,
}

impl App {
    fn new(agent: Arc<Agent>, config_path: Option<PathBuf>) -> Self {
        let active = agent.active();
        let tools = agent.tools().list();

        let lines = vec![
            OutputLine::new(
                LineKind::Info,
                format!(
                    "microagent v{} — {}/{} — providers: {}",
                    env!("CARGO_PKG_VERSION"),
                    active.provider,
                    active.model,
                    agent.provider_names().join(", ")
                ),
            ),
            OutputLine::new(
                LineKind::Info,
                format!(
                    "tools: {}",
                    if tools.is_empty() {
                        "(none)".to_string()
                    } else {
                        tools.join(", ")
                    }
                ),
            ),
            OutputLine::new(
                LineKind::Info,
                "Type your message. Ctrl+C to exit. Commands: /stats /tools /models /model /image /clear /help /quit",
            ),
        ];

        let conversation = Arc::new(Mutex::new(agent.new_conversation()));

        App {
            agent,
            conversation,
            config_path,
            lines,
            input: TextInput::default(),
            streaming: String::new(),
            busy: false,
            pending_images: Vec::new(),
            scroll: 0,
            stats: StatsSummary {
                requests: 0,
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
                tool_calls: 0,
                elapsed_ms: 0,
            },
            should_quit: false,
        }
    }

    fn push(&mut self, line: OutputLine) {
        self.lines.push(line);
        // Any new output snaps back to the tail, matching how a scrollback
        // terminal behaves.
        self.scroll = 0;
    }

    fn info(&mut self, text: impl Into<String>) {
        self.push(OutputLine::new(LineKind::Info, text));
    }

    fn error(&mut self, text: impl Into<String>) {
        self.push(OutputLine::new(LineKind::Error, text));
    }

    /// Apply one message from the channel.
    fn handle_message(&mut self, message: UiMessage) {
        match message {
            UiMessage::Agent(AgentEvent::Delta(StreamDelta::Text { text })) => {
                self.streaming.push_str(&text);
                self.scroll = 0;
            }
            UiMessage::Agent(AgentEvent::Delta(_)) => {}
            UiMessage::Agent(AgentEvent::ToolCall { name, .. }) => {
                self.push(OutputLine::new(LineKind::Tool, format!("→ calling {name}")));
            }
            UiMessage::Agent(AgentEvent::ToolResult {
                name,
                content,
                is_error,
                ..
            }) => {
                let kind = if is_error {
                    LineKind::Error
                } else {
                    LineKind::Tool
                };
                self.push(OutputLine::new(
                    kind,
                    format!("← {name}: {}", preview(&content)),
                ));
            }
            UiMessage::Agent(AgentEvent::Complete { response, stats }) => {
                self.streaming.clear();
                self.stats = stats;
                if !response.is_empty() {
                    self.push(OutputLine::new(LineKind::Assistant, response));
                }
            }
            UiMessage::Agent(AgentEvent::Error { error }) => {
                self.streaming.clear();
                self.error(format!("Error: {error}"));
            }
            UiMessage::Lines(lines) => {
                for line in lines {
                    self.push(line);
                }
            }
            UiMessage::Idle => {
                self.busy = false;
                self.streaming.clear();
            }
        }
    }

    /// Handle a key press. Returns true if the frame should be redrawn.
    fn handle_key(&mut self, key: KeyEvent, tx: &mpsc::Sender<UiMessage>) -> bool {
        // Windows reports both press and release; only act on press.
        if key.kind != KeyEventKind::Press {
            return false;
        }

        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);

        match key.code {
            KeyCode::Char('c') if ctrl => {
                self.should_quit = true;
            }
            KeyCode::Char('d') if ctrl && self.input.is_empty() => {
                self.should_quit = true;
            }

            // Scrolling. Page keys rather than arrows, so the arrows stay
            // available for cursor movement.
            KeyCode::PageUp => self.scroll = self.scroll.saturating_add(10),
            KeyCode::PageDown => self.scroll = self.scroll.saturating_sub(10),
            KeyCode::Home if ctrl => self.scroll = usize::MAX,
            KeyCode::End if ctrl => self.scroll = 0,

            // Editing is disabled mid-turn, matching the Ink UI, which swaps the
            // input for a "thinking..." indicator.
            _ if self.busy => return false,

            KeyCode::Enter => {
                let value = self.input.value();
                if !value.trim().is_empty() {
                    self.input.clear();
                    self.submit(value, tx);
                }
            }
            KeyCode::Backspace => self.input.backspace(),
            KeyCode::Delete => self.input.delete(),
            KeyCode::Left => self.input.left(),
            KeyCode::Right => self.input.right(),
            KeyCode::Home => self.input.home(),
            KeyCode::End => self.input.end(),
            KeyCode::Char('a') if ctrl => self.input.home(),
            KeyCode::Char('e') if ctrl => self.input.end(),
            KeyCode::Char('k') if ctrl => self.input.kill_to_end(),
            KeyCode::Char('u') if ctrl => self.input.kill_to_start(),
            KeyCode::Char('w') if ctrl => self.input.kill_word(),
            KeyCode::Char(c) if !ctrl => self.input.insert(c),
            _ => return false,
        }

        true
    }

    /// Dispatch a submitted line: either a slash command or a turn.
    fn submit(&mut self, value: String, tx: &mpsc::Sender<UiMessage>) {
        let trimmed = value.trim().to_string();

        if trimmed.starts_with('/') {
            commands::dispatch(self, &trimmed, tx);
            return;
        }

        let images = std::mem::take(&mut self.pending_images);
        let label = if images.is_empty() {
            trimmed.clone()
        } else {
            format!("{trimmed} [+{} image(s)]", images.len())
        };
        self.push(OutputLine::new(LineKind::User, label));

        self.busy = true;
        self.streaming.clear();

        let agent = self.agent.clone();
        let conversation = self.conversation.clone();
        let tx = tx.clone();

        // The turn runs in its own task so the event loop keeps rendering; the
        // conversation lock keeps its history consistent.
        tokio::spawn(async move {
            let (event_tx, mut event_rx) = mpsc::channel::<AgentEvent>(256);

            let forward = {
                let tx = tx.clone();
                tokio::spawn(async move {
                    while let Some(event) = event_rx.recv().await {
                        if tx.send(UiMessage::Agent(event)).await.is_err() {
                            break;
                        }
                    }
                })
            };

            let mut guard = conversation.lock().await;
            let result = agent
                .run(&mut guard, &trimmed, &images, Some(&event_tx))
                .await;
            drop(event_tx);
            let _ = forward.await;

            let terminal = match result {
                Ok(response) => AgentEvent::Complete {
                    response,
                    stats: guard.stats().summary(),
                },
                Err(err) => AgentEvent::Error {
                    error: err.to_string(),
                },
            };
            let _ = tx.send(UiMessage::Agent(terminal)).await;
            let _ = tx.send(UiMessage::Idle).await;
        });
    }
}

/// Truncate a tool result for the history line, as the Ink UI does at 200 chars.
fn preview(content: &str) -> String {
    const LIMIT: usize = 200;
    if content.chars().count() <= LIMIT {
        return content.to_string();
    }
    let truncated: String = content.chars().take(LIMIT).collect();
    format!("{truncated}...")
}

/// Run the TUI until the user quits.
pub async fn run(agent: Arc<Agent>, config_path: Option<PathBuf>) -> Result<()> {
    let mut app = App::new(agent, config_path);

    // `init` also installs a panic hook that restores the terminal — without it
    // a panic leaves the shell in raw mode inside the alternate screen.
    let mut terminal = ratatui::init();
    let result = event_loop(&mut terminal, &mut app).await;
    ratatui::restore();

    result
}

async fn event_loop(terminal: &mut ratatui::DefaultTerminal, app: &mut App) -> Result<()> {
    let (tx, mut rx) = mpsc::channel::<UiMessage>(512);
    // `EventStream` rather than the blocking `event::read()` shown in ratatui's
    // own docs, so keystrokes and agent deltas interleave in one `select!`.
    let mut events = EventStream::new();

    terminal.draw(|frame| render::draw(frame, app))?;

    loop {
        let mut dirty = false;

        tokio::select! {
            maybe_event = events.next() => {
                match maybe_event {
                    Some(Ok(Event::Key(key))) => {
                        dirty = app.handle_key(key, &tx);
                    }
                    Some(Ok(Event::Paste(text))) => {
                        if !app.busy {
                            app.input.insert_str(&text);
                            dirty = true;
                        }
                    }
                    Some(Ok(Event::Resize(_, _))) => dirty = true,
                    Some(Ok(_)) => {}
                    Some(Err(err)) => return Err(err.into()),
                    None => app.should_quit = true,
                }
            }

            Some(message) = rx.recv() => {
                app.handle_message(message);
                dirty = true;

                // Drain anything else already queued before redrawing. Streaming
                // deltas arrive far faster than a useful frame rate, and redrawing
                // per token wastes most of the work.
                while let Ok(next) = rx.try_recv() {
                    app.handle_message(next);
                }
            }
        }

        if app.should_quit {
            break;
        }
        if dirty {
            terminal.draw(|frame| render::draw(frame, app))?;
        }
    }

    Ok(())
}

/// Shared test fixture, used here and by the command tests.
#[cfg(test)]
pub(crate) mod tests_support {
    use super::*;
    use microagent_core::MicroagentConfig;

    pub(crate) fn test_app() -> App {
        let config: MicroagentConfig = serde_json::from_value(serde_json::json!({
            "providers": [{ "type": "ollama", "model": "llama3.2" }],
            "systemPrompt": "be brief"
        }))
        .unwrap();
        let mut builder = Agent::builder(config);
        for tool in crate::tools::builtin_tools() {
            builder.register_tool(tool);
        }
        App::new(Arc::new(builder.build().unwrap()), None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tui::tests_support::test_app as app;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn ctrl(c: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
    }

    #[test]
    fn starts_with_a_banner_and_no_pending_state() {
        let app = app();
        assert_eq!(app.lines.len(), 3);
        assert!(app.lines.iter().all(|l| l.kind == LineKind::Info));
        assert!(!app.busy);
        assert_eq!(app.scroll, 0);
    }

    #[tokio::test]
    async fn typing_and_editing_updates_the_input() {
        let mut app = app();
        let (tx, _rx) = mpsc::channel(16);

        for c in "helo".chars() {
            app.handle_key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE), &tx);
        }
        app.handle_key(key(KeyCode::Left), &tx);
        app.handle_key(KeyEvent::new(KeyCode::Char('l'), KeyModifiers::NONE), &tx);
        assert_eq!(app.input.value(), "hello");
    }

    #[tokio::test]
    async fn ctrl_c_quits() {
        let mut app = app();
        let (tx, _rx) = mpsc::channel(16);
        app.handle_key(ctrl('c'), &tx);
        assert!(app.should_quit);
    }

    #[tokio::test]
    async fn ctrl_d_quits_only_on_an_empty_line() {
        let mut app = app();
        let (tx, _rx) = mpsc::channel(16);

        app.handle_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE), &tx);
        app.handle_key(ctrl('d'), &tx);
        assert!(!app.should_quit, "Ctrl-D must not discard a typed line");

        app.handle_key(ctrl('u'), &tx);
        app.handle_key(ctrl('d'), &tx);
        assert!(app.should_quit);
    }

    #[tokio::test]
    async fn keys_are_ignored_while_busy_but_scrolling_still_works() {
        let mut app = app();
        let (tx, _rx) = mpsc::channel(16);
        app.busy = true;

        app.handle_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE), &tx);
        assert!(app.input.is_empty(), "input must be frozen mid-turn");

        // Reading history while the model works is the whole point of scrolling.
        app.handle_key(key(KeyCode::PageUp), &tx);
        assert_eq!(app.scroll, 10);
    }

    #[tokio::test]
    async fn an_empty_submission_is_ignored() {
        let mut app = app();
        let (tx, _rx) = mpsc::channel(16);
        let before = app.lines.len();

        app.handle_key(KeyEvent::new(KeyCode::Char(' '), KeyModifiers::NONE), &tx);
        app.handle_key(key(KeyCode::Enter), &tx);

        assert_eq!(app.lines.len(), before);
        assert!(!app.busy);
    }

    #[test]
    fn streaming_text_accumulates_then_clears_on_completion() {
        let mut app = app();

        app.handle_message(UiMessage::Agent(AgentEvent::Delta(StreamDelta::Text {
            text: "par".into(),
        })));
        app.handle_message(UiMessage::Agent(AgentEvent::Delta(StreamDelta::Text {
            text: "tial".into(),
        })));
        assert_eq!(app.streaming, "partial");

        app.handle_message(UiMessage::Agent(AgentEvent::Complete {
            response: "partial".into(),
            stats: StatsSummary {
                requests: 1,
                prompt_tokens: 3,
                completion_tokens: 2,
                total_tokens: 5,
                tool_calls: 0,
                elapsed_ms: 10,
            },
        }));

        assert!(app.streaming.is_empty());
        assert_eq!(app.stats.total_tokens, 5);
        assert_eq!(app.lines.last().unwrap().kind, LineKind::Assistant);
        assert_eq!(app.lines.last().unwrap().text, "partial");
    }

    #[test]
    fn a_failing_tool_result_is_styled_as_an_error() {
        let mut app = app();
        app.handle_message(UiMessage::Agent(AgentEvent::ToolResult {
            id: "c1".into(),
            name: "bash".into(),
            content: "boom".into(),
            is_error: true,
        }));
        assert_eq!(app.lines.last().unwrap().kind, LineKind::Error);
        assert!(app.lines.last().unwrap().text.contains("bash"));
    }

    #[test]
    fn new_output_snaps_the_viewport_back_to_the_tail() {
        let mut app = app();
        app.scroll = 25;
        app.info("something happened");
        assert_eq!(app.scroll, 0);
    }

    #[test]
    fn tool_result_previews_are_truncated_on_char_boundaries() {
        let content = "é".repeat(500);
        let out = preview(&content);
        assert!(out.ends_with("..."));
        assert_eq!(out.chars().count(), 203);
    }
}
