//! Word wrapping for the history viewport.
//!
//! Ink simply grows the terminal's scrollback, so the TypeScript UI never wraps
//! anything itself. ratatui owns a fixed viewport, so history has to be wrapped
//! up front: scroll offsets are counted in *display* lines, and a `Paragraph`
//! that wraps internally would make the offset unknowable.

/// Break `text` into lines no wider than `width`, preserving existing newlines.
///
/// Breaks on whitespace where possible and hard-splits words longer than the
/// width, so a long path or a base64 blob cannot overflow the viewport.
pub fn wrap(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![String::new()];
    }

    let mut out = Vec::new();

    for raw_line in text.split('\n') {
        if raw_line.is_empty() {
            out.push(String::new());
            continue;
        }

        let mut current = String::new();
        let mut current_width = 0usize;

        for word in raw_line.split_inclusive(char::is_whitespace) {
            let word_width = word.chars().count();

            // A word that cannot fit on any line is hard-split.
            if word_width > width {
                if current_width > 0 {
                    out.push(std::mem::take(&mut current));
                    current_width = 0;
                }
                for c in word.chars() {
                    if current_width == width {
                        out.push(std::mem::take(&mut current));
                        current_width = 0;
                    }
                    current.push(c);
                    current_width += 1;
                }
                continue;
            }

            if current_width + word_width > width && current_width > 0 {
                out.push(std::mem::take(&mut current));
                current_width = 0;
            }

            current.push_str(word);
            current_width += word_width;
        }

        out.push(current);
    }

    if out.is_empty() {
        out.push(String::new());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_stays_on_one_line() {
        assert_eq!(wrap("hello", 20), vec!["hello"]);
    }

    #[test]
    fn wraps_on_word_boundaries() {
        let lines = wrap("the quick brown fox", 10);
        for line in &lines {
            assert!(line.chars().count() <= 10, "too wide: {line:?}");
        }
        assert_eq!(
            lines.join("").replace("  ", " ").trim(),
            "the quick brown fox"
        );
    }

    #[test]
    fn preserves_explicit_newlines() {
        assert_eq!(wrap("a\nb", 10), vec!["a", "b"]);
        // Blank lines are meaningful in tool output.
        assert_eq!(wrap("a\n\nb", 10), vec!["a", "", "b"]);
    }

    #[test]
    fn hard_splits_words_longer_than_the_width() {
        // A base64 data URI or a long path must not overflow the viewport.
        let lines = wrap("aaaaaaaaaaaaaaaaaaaa", 5);
        assert_eq!(lines.len(), 4);
        for line in &lines {
            assert!(line.chars().count() <= 5);
        }
        assert_eq!(lines.concat(), "aaaaaaaaaaaaaaaaaaaa");
    }

    #[test]
    fn multibyte_text_is_measured_in_characters() {
        let lines = wrap("ééééééééé", 3);
        for line in &lines {
            assert!(line.chars().count() <= 3, "too wide: {line:?}");
        }
        assert_eq!(lines.concat(), "ééééééééé");
    }

    #[test]
    fn zero_width_does_not_loop_forever() {
        assert_eq!(wrap("anything", 0), vec![String::new()]);
    }

    #[test]
    fn empty_text_yields_one_empty_line() {
        assert_eq!(wrap("", 10), vec![String::new()]);
    }

    #[test]
    fn a_long_word_after_short_words_starts_a_new_line() {
        let lines = wrap("hi supercalifragilistic", 8);
        assert_eq!(lines[0].trim(), "hi");
        for line in &lines {
            assert!(line.chars().count() <= 8);
        }
    }
}
