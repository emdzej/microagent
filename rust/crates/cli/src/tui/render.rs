//! Frame rendering.

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Position};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};

use crate::tui::wrap::wrap;
use crate::tui::{App, LineKind};

/// Colours chosen to match the Ink UI in `Chat.tsx`.
fn style_for(kind: LineKind) -> Style {
    match kind {
        LineKind::User => Style::default().fg(Color::Cyan),
        LineKind::Assistant => Style::default().fg(Color::Green),
        LineKind::Tool => Style::default().fg(Color::Yellow),
        LineKind::Error => Style::default().fg(Color::Red),
        LineKind::Info => Style::default().fg(Color::DarkGray),
    }
}

fn prefix_for(kind: LineKind) -> &'static str {
    match kind {
        LineKind::User => "▸ ",
        LineKind::Assistant => "◂ ",
        _ => "  ",
    }
}

pub fn draw(frame: &mut Frame, app: &App) {
    let [history_area, input_area, status_area] = Layout::vertical([
        Constraint::Min(1),
        Constraint::Length(3),
        Constraint::Length(1),
    ])
    .areas(frame.area());

    // ── History ──
    // Wrapped up front rather than by the Paragraph, so the scroll offset is in
    // display lines and can be clamped exactly.
    let width = history_area.width.max(1) as usize;
    let mut display: Vec<Line> = Vec::new();

    for line in &app.lines {
        let style = style_for(line.kind);
        let prefix = prefix_for(line.kind);
        let indent = " ".repeat(prefix.chars().count());

        for (i, wrapped) in wrap(&line.text, width.saturating_sub(prefix.chars().count()))
            .into_iter()
            .enumerate()
        {
            let lead = if i == 0 {
                prefix.to_string()
            } else {
                indent.clone()
            };
            display.push(Line::from(vec![
                Span::styled(lead, style),
                Span::styled(wrapped, style),
            ]));
        }
    }

    // The in-flight response, shown with a cursor block so it reads as live.
    if !app.streaming.is_empty() {
        let style = style_for(LineKind::Assistant).add_modifier(Modifier::DIM);
        let wrapped = wrap(&app.streaming, width.saturating_sub(2));
        let last = wrapped.len().saturating_sub(1);
        for (i, text) in wrapped.into_iter().enumerate() {
            let lead = if i == 0 { "◂ " } else { "  " };
            let mut spans = vec![Span::styled(lead, style), Span::styled(text, style)];
            if i == last {
                spans.push(Span::styled("▊", style));
            }
            display.push(Line::from(spans));
        }
    }

    let viewport = history_area.height as usize;
    let total = display.len();
    // Clamp here rather than at the key handler, since the limit depends on the
    // current frame size and the amount of history.
    let max_scroll = total.saturating_sub(viewport);
    let scroll = app.scroll.min(max_scroll);
    let end = total.saturating_sub(scroll);
    let start = end.saturating_sub(viewport);

    frame.render_widget(Paragraph::new(display[start..end].to_vec()), history_area);

    // ── Input ──
    let (indicator, indicator_style) = if app.busy {
        ("⟳ ", Style::default().fg(Color::DarkGray))
    } else {
        (
            "❯ ",
            Style::default()
                .fg(Color::Blue)
                .add_modifier(Modifier::BOLD),
        )
    };

    let input_text = if app.busy {
        Span::styled("thinking...", Style::default().add_modifier(Modifier::DIM))
    } else {
        Span::raw(app.input.value())
    };

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(if app.busy {
            Style::default().fg(Color::DarkGray)
        } else {
            Style::default().fg(Color::Blue)
        });
    let inner = block.inner(input_area);

    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(indicator, indicator_style),
            input_text,
        ]))
        .block(block),
        input_area,
    );

    if !app.busy {
        // Place the real terminal cursor, so the caret behaves as users expect
        // rather than being drawn as a character.
        let x = inner.x + indicator.chars().count() as u16 + app.input.cursor() as u16;
        frame.set_cursor_position(Position::new(
            x.min(inner.right().saturating_sub(1)),
            inner.y,
        ));
    }

    // ── Status bar ──
    // Ordered by priority, because a narrow terminal truncates the tail. The
    // transient, actionable items go first: on an 80-column frame everything
    // fits, but at 40 a trailing scroll indicator was getting cut off — exactly
    // when the user most needs to know they are not following the tail.
    let active = app.agent.active();
    let mut segments: Vec<String> = Vec::new();

    if scroll > 0 {
        segments.push(format!("scrolled {scroll} (Ctrl+End)"));
    }
    if !app.pending_images.is_empty() {
        segments.push(format!("images: {}", app.pending_images.len()));
    }
    segments.push(format!("{}/{}", active.provider, active.model));
    segments.push(format!("tokens: {}", app.stats.total_tokens));
    segments.push(format!("calls: {}", app.stats.tool_calls));
    segments.push(format!("reqs: {}", app.stats.requests));

    let status = format!(" {}", segments.join(" | "));

    frame.render_widget(
        Paragraph::new(Span::styled(
            status,
            Style::default().fg(Color::Black).bg(Color::DarkGray),
        )),
        status_area,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tui::tests_support::test_app;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    /// Render one frame and return the buffer as text lines.
    fn render(app: &App, width: u16, height: u16) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| draw(frame, app)).unwrap();

        let buffer = terminal.backend().buffer().clone();
        (0..height)
            .map(|y| {
                (0..width)
                    .map(|x| buffer[(x, y)].symbol().to_string())
                    .collect::<String>()
                    .trim_end()
                    .to_string()
            })
            .collect()
    }

    #[test]
    fn draws_the_banner_prompt_and_status_bar() {
        let app = test_app();
        let lines = render(&app, 80, 12);
        let all = lines.join("\n");

        assert!(all.contains("microagent v"), "banner missing:\n{all}");
        assert!(all.contains("tools:"), "tool list missing:\n{all}");
        // Prompt indicator and status bar.
        assert!(all.contains('❯'), "prompt missing:\n{all}");
        assert!(
            lines.last().unwrap().contains("ollama/llama3.2"),
            "status bar missing the active model:\n{all}"
        );
        assert!(lines.last().unwrap().contains("tokens: 0"));
    }

    #[test]
    fn user_and_assistant_lines_get_their_prefixes() {
        let mut app = test_app();
        app.push(crate::tui::OutputLine::new(
            crate::tui::LineKind::User,
            "what is 2+2",
        ));
        app.push(crate::tui::OutputLine::new(
            crate::tui::LineKind::Assistant,
            "four",
        ));

        let all = render(&app, 40, 12).join("\n");
        assert!(all.contains("▸ what is 2+2"), "{all}");
        assert!(all.contains("◂ four"), "{all}");
    }

    #[test]
    fn busy_state_replaces_the_input_with_a_thinking_indicator() {
        let mut app = test_app();
        app.busy = true;
        let all = render(&app, 40, 10).join("\n");
        assert!(all.contains("thinking..."), "{all}");
        assert!(!all.contains('❯'), "the prompt should be hidden:\n{all}");
    }

    #[test]
    fn streaming_text_is_shown_with_a_cursor_block() {
        let mut app = test_app();
        app.busy = true;
        app.streaming = "partial ans".to_string();
        let all = render(&app, 40, 10).join("\n");
        assert!(all.contains("partial ans▊"), "{all}");
    }

    #[test]
    fn long_lines_wrap_inside_the_viewport_rather_than_overflowing() {
        let mut app = test_app();
        app.push(crate::tui::OutputLine::new(
            crate::tui::LineKind::Assistant,
            "x".repeat(200),
        ));

        let lines = render(&app, 30, 20);
        for line in &lines {
            assert!(
                line.chars().count() <= 30,
                "line overflows the 30-column frame: {line:?}"
            );
        }
        // The content is spread over several rows rather than truncated.
        let xs: usize = lines.iter().map(|l| l.matches('x').count()).sum();
        assert!(xs > 100, "expected wrapping, only saw {xs} characters");
    }

    /// With more history than fits, the tail must be visible — a chat that
    /// scrolls away from the newest message is useless.
    #[test]
    fn the_newest_line_is_visible_when_history_overflows() {
        let mut app = test_app();
        for i in 0..100 {
            app.push(crate::tui::OutputLine::new(
                crate::tui::LineKind::Info,
                format!("line {i}"),
            ));
        }

        let all = render(&app, 40, 10).join("\n");
        assert!(all.contains("line 99"), "tail not visible:\n{all}");
        assert!(
            !all.contains("line 0\n"),
            "should have scrolled past the head"
        );
    }

    #[test]
    fn scrolling_up_shows_older_lines_and_reports_it_in_the_status_bar() {
        let mut app = test_app();
        for i in 0..100 {
            app.push(crate::tui::OutputLine::new(
                crate::tui::LineKind::Info,
                format!("line {i}"),
            ));
        }
        app.scroll = 50;

        let lines = render(&app, 40, 10);
        let all = lines.join("\n");
        assert!(
            !all.contains("line 99"),
            "should be scrolled away from the tail"
        );
        assert!(lines.last().unwrap().contains("scrolled"), "{all}");
    }

    /// Scroll is clamped against the current frame size, so an over-large offset
    /// cannot scroll past the beginning and blank the viewport.
    #[test]
    fn an_excessive_scroll_offset_is_clamped_to_the_first_line() {
        let mut app = test_app();
        for i in 0..30 {
            app.push(crate::tui::OutputLine::new(
                crate::tui::LineKind::Info,
                format!("line {i}"),
            ));
        }
        app.scroll = usize::MAX;

        let all = render(&app, 40, 10).join("\n");
        assert!(
            all.contains("microagent v"),
            "should show the very top:\n{all}"
        );
    }

    #[test]
    fn pending_images_are_surfaced_in_the_status_bar() {
        let mut app = test_app();
        app.pending_images
            .push("data:image/png;base64,AAA".to_string());
        let lines = render(&app, 80, 8);
        assert!(lines.last().unwrap().contains("images: 1"));
    }

    /// The scroll and image indicators must survive a narrow frame, where the
    /// status bar is truncated. They are transient and actionable, so they are
    /// ordered ahead of the always-available counters.
    #[test]
    fn transient_status_indicators_survive_truncation() {
        let mut app = test_app();
        for i in 0..100 {
            app.push(crate::tui::OutputLine::new(
                crate::tui::LineKind::Info,
                format!("line {i}"),
            ));
        }
        app.scroll = 50;
        app.pending_images.push("x".to_string());

        for width in [30u16, 40, 60] {
            let status = render(&app, width, 10).last().unwrap().clone();
            assert!(
                status.contains("scrolled"),
                "scroll indicator lost at width {width}: {status:?}"
            );
        }
    }

    #[test]
    fn a_very_narrow_frame_does_not_panic() {
        // Terminal resizes can get absurd; the layout must survive it.
        let app = test_app();
        for width in [1u16, 2, 3, 5] {
            let _ = render(&app, width, 5);
        }
    }

    #[test]
    fn a_very_short_frame_does_not_panic() {
        let app = test_app();
        for height in [1u16, 2, 3, 4, 5] {
            let _ = render(&app, 40, height);
        }
    }
}
