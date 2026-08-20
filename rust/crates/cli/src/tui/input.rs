//! A single-line text input with cursor editing.
//!
//! Ink provides `ink-text-input` for free; ratatui owns only the drawing, so
//! editing has to be implemented. Characters are stored as a `Vec<char>` so the
//! cursor is a simple index — byte offsets would need boundary checks on every
//! movement and would break on multi-byte input.

#[derive(Default)]
pub struct TextInput {
    chars: Vec<char>,
    cursor: usize,
}

impl TextInput {
    pub fn value(&self) -> String {
        self.chars.iter().collect()
    }

    pub fn is_empty(&self) -> bool {
        self.chars.is_empty()
    }

    /// Cursor position in characters from the start.
    pub fn cursor(&self) -> usize {
        self.cursor
    }

    pub fn clear(&mut self) {
        self.chars.clear();
        self.cursor = 0;
    }

    pub fn insert(&mut self, c: char) {
        self.chars.insert(self.cursor, c);
        self.cursor += 1;
    }

    pub fn insert_str(&mut self, s: &str) {
        for c in s.chars() {
            // Newlines from a paste would submit unpredictably; treat them as
            // spaces so multi-line pastes land as one prompt.
            self.insert(if c == '\n' || c == '\r' { ' ' } else { c });
        }
    }

    pub fn backspace(&mut self) {
        if self.cursor > 0 {
            self.cursor -= 1;
            self.chars.remove(self.cursor);
        }
    }

    pub fn delete(&mut self) {
        if self.cursor < self.chars.len() {
            self.chars.remove(self.cursor);
        }
    }

    pub fn left(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    pub fn right(&mut self) {
        if self.cursor < self.chars.len() {
            self.cursor += 1;
        }
    }

    pub fn home(&mut self) {
        self.cursor = 0;
    }

    pub fn end(&mut self) {
        self.cursor = self.chars.len();
    }

    /// Delete from the cursor to the end of the line (Ctrl-K).
    pub fn kill_to_end(&mut self) {
        self.chars.truncate(self.cursor);
    }

    /// Delete from the start of the line to the cursor (Ctrl-U).
    pub fn kill_to_start(&mut self) {
        self.chars.drain(..self.cursor);
        self.cursor = 0;
    }

    /// Delete the word before the cursor (Ctrl-W).
    pub fn kill_word(&mut self) {
        // Skip any run of spaces, then the word itself.
        let mut end = self.cursor;
        while end > 0 && self.chars[end - 1].is_whitespace() {
            end -= 1;
        }
        while end > 0 && !self.chars[end - 1].is_whitespace() {
            end -= 1;
        }
        self.chars.drain(end..self.cursor);
        self.cursor = end;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(s: &str) -> TextInput {
        let mut i = TextInput::default();
        i.insert_str(s);
        i
    }

    #[test]
    fn inserts_and_reports_its_value() {
        let i = input("hello");
        assert_eq!(i.value(), "hello");
        assert_eq!(i.cursor(), 5);
    }

    #[test]
    fn cursor_movement_is_clamped_at_both_ends() {
        let mut i = input("ab");
        i.right();
        i.right();
        assert_eq!(i.cursor(), 2);
        i.left();
        i.left();
        i.left();
        assert_eq!(i.cursor(), 0);
    }

    #[test]
    fn inserts_at_the_cursor_not_the_end() {
        let mut i = input("ac");
        i.left();
        i.insert('b');
        assert_eq!(i.value(), "abc");
        assert_eq!(i.cursor(), 2);
    }

    #[test]
    fn backspace_and_delete_remove_the_right_side() {
        let mut i = input("abc");
        i.left();
        i.backspace();
        assert_eq!(i.value(), "ac");
        i.delete();
        assert_eq!(i.value(), "a");
        // Delete at the end is a no-op.
        i.end();
        i.delete();
        assert_eq!(i.value(), "a");
    }

    #[test]
    fn backspace_at_the_start_is_a_no_op() {
        let mut i = input("a");
        i.home();
        i.backspace();
        assert_eq!(i.value(), "a");
    }

    #[test]
    fn multibyte_characters_are_handled_per_character() {
        // Byte-indexed cursors would panic or corrupt here.
        let mut i = input("héllo→");
        assert_eq!(i.cursor(), 6);
        i.backspace();
        assert_eq!(i.value(), "héllo");
        i.home();
        i.right();
        i.delete();
        assert_eq!(i.value(), "hllo");
    }

    #[test]
    fn kill_to_end_and_start() {
        let mut i = input("hello world");
        i.home();
        i.right();
        i.right();
        i.kill_to_end();
        assert_eq!(i.value(), "he");

        let mut i = input("hello world");
        i.kill_to_start();
        assert_eq!(i.value(), "");
        assert_eq!(i.cursor(), 0);
    }

    #[test]
    fn kill_word_removes_trailing_spaces_then_the_word() {
        let mut i = input("hello world   ");
        i.kill_word();
        assert_eq!(i.value(), "hello ");
        i.kill_word();
        assert_eq!(i.value(), "");
    }

    #[test]
    fn pasted_newlines_become_spaces() {
        let i = input("line one\nline two");
        assert_eq!(i.value(), "line one line two");
    }

    #[test]
    fn clear_resets_value_and_cursor() {
        let mut i = input("something");
        i.clear();
        assert!(i.is_empty());
        assert_eq!(i.cursor(), 0);
    }
}
