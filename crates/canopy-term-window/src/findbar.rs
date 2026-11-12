//! The find bar: its editing model, key mapping, layout, drawing and match
//! highlighting. No window: the bar is drawn into a copy of the frame (see
//! [`crate::overlay`]) on the bottom row, and the window routes keys and
//! clicks to it while it is open.
//!
//! Keys while the bar is open (the window sends every key press to it, except
//! copy, paste, zoom and scroll keys):
//!
//! * typing and IME commits edit the query; Left/Right/Home/End move the caret;
//!   Backspace/Delete delete; Cmd+Backspace (Ctrl+Backspace) clears it; paste
//!   inserts the first line of the clipboard.
//! * Enter or F3: next match, with Shift previous; macOS also Cmd+G and
//!   Shift+Cmd+G.
//! * Alt+C (Option+Cmd+C on macOS): toggle case sensitivity.
//! * Escape: close.
//!
//! Searching is incremental: every edit searches again (see [`crate::search`]).

use canopy_term_core::frame::{Attrs, Color, Frame};
use unicode_width::UnicodeWidthChar;

use crate::ime::Preedit;
use crate::overlay::{draw_text, fill, Style};
use crate::search::{FindState, Match};
use crate::shortcuts::{Mods, Platform};

/// Longest query, in characters.
pub const MAX_QUERY_CHARS: usize = 256;

/// The text before the query box.
pub const LABEL: &str = " Find: ";

const BAR: Style = Style {
    fg: Color::Rgb(0xdd, 0xdd, 0xdd),
    bg: Color::Rgb(0x2b, 0x2d, 0x31),
    attrs: 0,
};
const INPUT: Style = Style {
    fg: Color::Rgb(0xf2, 0xf2, 0xf2),
    bg: Color::Rgb(0x1a, 0x1b, 0x1e),
    attrs: 0,
};
const PREEDIT: Style = Style {
    attrs: Attrs::UNDERLINE,
    ..INPUT
};
const STATUS: Style = Style {
    fg: Color::Rgb(0xa0, 0xa4, 0xad),
    bg: BAR.bg,
    attrs: 0,
};
const STATUS_NONE: Style = Style {
    fg: Color::Rgb(0xff, 0x7b, 0x72),
    ..STATUS
};
const BUTTON: Style = Style {
    fg: Color::Rgb(0xdd, 0xdd, 0xdd),
    bg: Color::Rgb(0x3b, 0x3f, 0x46),
    attrs: 0,
};
const BUTTON_ON: Style = Style {
    fg: Color::Rgb(0x1b, 0x1b, 0x1b),
    bg: Color::Rgb(0xe5, 0xc0, 0x7b),
    attrs: Attrs::BOLD,
};
/// Every match.
const MATCH: (Color, Color) = (Color::Rgb(0x1b, 0x1b, 0x1b), Color::Rgb(0xff, 0xd8, 0x66));
/// The current match.
const CURRENT: (Color, Color) = (Color::Rgb(0x1b, 0x1b, 0x1b), Color::Rgb(0xff, 0x8c, 0x00));

/// An edit or command for the bar.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FindKey {
    Text(String),
    Backspace,
    Delete,
    Left,
    Right,
    Home,
    End,
    Clear,
    Next,
    Prev,
    ToggleCase,
    Close,
}

/// What the window must do after a key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FindEvent {
    Nothing,
    /// Only the bar changed (the caret moved).
    Redraw,
    /// The query changed: search again.
    QueryChanged,
    /// Case sensitivity changed: search again.
    CaseChanged,
    Next,
    Prev,
    Close,
}

/// The keys the bar treats specially; the window maps its toolkit's keys onto
/// these.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Nav {
    Enter,
    Escape,
    Backspace,
    Delete,
    Left,
    Right,
    Home,
    End,
    F3,
    Other,
}

/// First line of `text`, without control characters.
fn sanitize(text: &str) -> String {
    text.chars()
        .take_while(|c| *c != '\n' && *c != '\r')
        .filter(|c| !c.is_control())
        .collect()
}

/// Maps a key press to a bar command. `unmodified` is the key without
/// modifiers ("c" for Option+C), `text` what the key types.
pub fn key_to_find(
    nav: Nav,
    unmodified: &str,
    text: Option<&str>,
    mods: Mods,
    platform: Platform,
) -> Option<FindKey> {
    // Command on macOS, Ctrl elsewhere: word-sized edits.
    let cmd = match platform {
        Platform::MacOs => mods.logo && !mods.ctrl,
        Platform::Other => mods.ctrl && !mods.logo,
    };
    match nav {
        Nav::Escape => return Some(FindKey::Close),
        Nav::Enter | Nav::F3 => {
            return Some(if mods.shift {
                FindKey::Prev
            } else {
                FindKey::Next
            })
        }
        Nav::Backspace => {
            return Some(if cmd {
                FindKey::Clear
            } else {
                FindKey::Backspace
            })
        }
        Nav::Delete => return Some(FindKey::Delete),
        Nav::Left => {
            return Some(if cmd { FindKey::Home } else { FindKey::Left });
        }
        Nav::Right => {
            return Some(if cmd { FindKey::End } else { FindKey::Right });
        }
        Nav::Home => return Some(FindKey::Home),
        Nav::End => return Some(FindKey::End),
        Nav::Other => {}
    }
    let letter = unmodified.to_ascii_lowercase();
    if platform == Platform::MacOs && mods.logo && !mods.ctrl {
        return match letter.as_str() {
            "g" => Some(if mods.shift {
                FindKey::Prev
            } else {
                FindKey::Next
            }),
            "c" if mods.alt => Some(FindKey::ToggleCase),
            _ => None,
        };
    }
    if platform == Platform::Other && mods.alt && !mods.ctrl && !mods.logo && letter == "c" {
        return Some(FindKey::ToggleCase);
    }
    // Ctrl and Command chords are not text (Ctrl+Alt is how some layouts
    // type AltGr characters).
    if mods.logo || (mods.ctrl && !mods.alt) {
        return None;
    }
    let clean = sanitize(text?);
    (!clean.is_empty()).then_some(FindKey::Text(clean))
}

/// The find bar's state: whether it is open, the caret in the query and the
/// search results.
#[derive(Clone, Debug, Default)]
pub struct FindBar {
    open: bool,
    /// Caret as a character index into the query.
    caret: usize,
    state: FindState,
}

impl FindBar {
    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn state(&self) -> &FindState {
        &self.state
    }

    pub fn state_mut(&mut self) -> &mut FindState {
        &mut self.state
    }

    pub fn caret(&self) -> usize {
        self.caret
    }

    fn query_len(&self) -> usize {
        self.state.query().chars().count()
    }

    fn byte_at(&self, index: usize) -> usize {
        let q = self.state.query();
        q.char_indices().nth(index).map_or(q.len(), |(b, _)| b)
    }

    /// Opens the bar. A fresh open with a non-empty `prefill` (the selected
    /// text) replaces the query; otherwise the last query is kept. True when
    /// the query was replaced.
    pub fn open(&mut self, prefill: Option<&str>) -> bool {
        let was_open = self.open;
        self.open = true;
        if !was_open {
            if let Some(p) = prefill {
                let clean: String = sanitize(p).chars().take(MAX_QUERY_CHARS).collect();
                if !clean.is_empty() {
                    self.state.set_query(clean);
                    self.caret = self.query_len();
                    return true;
                }
            }
        }
        self.caret = self.caret.min(self.query_len());
        false
    }

    /// Closes the bar, keeping the query for the next time.
    pub fn close(&mut self) {
        self.open = false;
    }

    /// Inserts typed, committed or pasted text at the caret (first line only,
    /// controls removed, up to the query limit).
    pub fn insert_text(&mut self, text: &str) -> FindEvent {
        let room = MAX_QUERY_CHARS.saturating_sub(self.query_len());
        let clean: String = sanitize(text).chars().take(room).collect();
        if clean.is_empty() {
            return FindEvent::Nothing;
        }
        let mut q = self.state.query().to_string();
        q.insert_str(self.byte_at(self.caret), &clean);
        self.caret += clean.chars().count();
        self.state.set_query(q);
        FindEvent::QueryChanged
    }

    fn remove_char(&mut self, index: usize) {
        let start = self.byte_at(index);
        let end = self.byte_at(index + 1);
        let mut q = self.state.query().to_string();
        q.replace_range(start..end, "");
        self.state.set_query(q);
    }

    pub fn on_key(&mut self, key: FindKey) -> FindEvent {
        match key {
            FindKey::Text(t) => self.insert_text(&t),
            FindKey::Backspace => {
                if self.caret == 0 {
                    return FindEvent::Nothing;
                }
                self.remove_char(self.caret - 1);
                self.caret -= 1;
                FindEvent::QueryChanged
            }
            FindKey::Delete => {
                if self.caret >= self.query_len() {
                    return FindEvent::Nothing;
                }
                self.remove_char(self.caret);
                FindEvent::QueryChanged
            }
            FindKey::Left => self.move_caret(self.caret.saturating_sub(1)),
            FindKey::Right => self.move_caret((self.caret + 1).min(self.query_len())),
            FindKey::Home => self.move_caret(0),
            FindKey::End => self.move_caret(self.query_len()),
            FindKey::Clear => {
                if self.state.query().is_empty() {
                    return FindEvent::Nothing;
                }
                self.state.set_query(String::new());
                self.caret = 0;
                FindEvent::QueryChanged
            }
            FindKey::Next => FindEvent::Next,
            FindKey::Prev => FindEvent::Prev,
            FindKey::ToggleCase => {
                let on = !self.state.case_sensitive();
                self.state.set_case_sensitive(on);
                FindEvent::CaseChanged
            }
            FindKey::Close => FindEvent::Close,
        }
    }

    fn move_caret(&mut self, to: usize) -> FindEvent {
        if to == self.caret {
            FindEvent::Nothing
        } else {
            self.caret = to;
            FindEvent::Redraw
        }
    }

    /// What the accessibility tree needs.
    pub fn a11y(&self, cols: u16, rows: u16) -> FindA11y {
        FindA11y {
            query: self.state.query().to_string(),
            status: self.state.status(),
            case_sensitive: self.state.case_sensitive(),
            layout: layout(cols, rows),
        }
    }
}

/// The bar as the accessibility tree describes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FindA11y {
    pub query: String,
    pub status: String,
    pub case_sensitive: bool,
    pub layout: BarLayout,
}

/// The bar's buttons, left to right.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FindButton {
    Case,
    Prev,
    Next,
    Close,
}

impl FindButton {
    fn text(self) -> &'static str {
        match self {
            FindButton::Case => " Aa ",
            FindButton::Prev => " Prev ",
            FindButton::Next => " Next ",
            FindButton::Close => " Close ",
        }
    }

    /// The accessible name.
    pub fn name(self) -> &'static str {
        match self {
            FindButton::Case => "Match case",
            FindButton::Prev => "Previous match",
            FindButton::Next => "Next match",
            FindButton::Close => "Close find bar",
        }
    }
}

/// Where each part of the bar is, in cells: `(first column, width)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BarLayout {
    /// The bar's screen row: the last one.
    pub row: u16,
    pub cols: u16,
    pub label: (u16, u16),
    pub query: (u16, u16),
    pub status: (u16, u16),
    /// Buttons with their column and width. Narrow windows show fewer (all of
    /// them still work from the keyboard and the accessibility tree).
    pub buttons: Vec<(FindButton, u16, u16)>,
}

impl BarLayout {
    /// The button at column `col`.
    pub fn hit(&self, col: u16) -> Option<FindButton> {
        self.buttons
            .iter()
            .find(|(_, c, w)| col >= *c && col < c + w)
            .map(|b| b.0)
    }
}

/// Lays the bar out for a grid `cols` wide and `rows` tall.
pub fn layout(cols: u16, rows: u16) -> BarLayout {
    let row = rows.saturating_sub(1);
    let mut right = cols;
    let mut buttons = Vec::new();
    let shown: &[FindButton] = if cols >= 70 {
        &[
            FindButton::Close,
            FindButton::Next,
            FindButton::Prev,
            FindButton::Case,
        ]
    } else if cols >= 44 {
        &[FindButton::Case]
    } else {
        &[]
    };
    for b in shown {
        let w = b.text().len() as u16;
        if right < w {
            break;
        }
        right -= w;
        buttons.push((*b, right, w));
        right = right.saturating_sub(1);
    }
    buttons.reverse();
    let status_w = if cols >= 34 { 14u16.min(right) } else { 0 };
    let status = (right - status_w, status_w);
    right -= status_w;
    let label_w = if cols >= 20 {
        (LABEL.len() as u16).min(right)
    } else {
        0
    };
    let query_w = right
        .saturating_sub(label_w)
        .max(1)
        .min(cols.saturating_sub(label_w));
    BarLayout {
        row,
        cols,
        label: (0, label_w),
        query: (label_w, query_w),
        status,
        buttons,
    }
}

fn width_of(c: char) -> u16 {
    c.width().unwrap_or(0) as u16
}

/// Where the bar drew its caret.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Drawn {
    /// (row, column) of the caret, for the IME candidate window.
    pub caret: (u16, u16),
}

/// Draws the bar on the last row of `frame`. `preedit` is an IME composition
/// in progress, drawn underlined at the caret. `None` when the frame is empty.
pub fn draw(frame: &mut Frame, bar: &FindBar, preedit: Option<&Preedit>) -> Option<Drawn> {
    if frame.cols == 0 || frame.rows == 0 {
        return None;
    }
    let l = layout(frame.cols, frame.rows);
    fill(frame, l.row, 0, frame.cols, BAR);
    if l.label.1 > 0 {
        draw_text(frame, l.row, l.label.0, l.label.1, LABEL, BAR);
    }

    // The query with the composition inserted at the caret.
    let (qcol, qwidth) = l.query;
    fill(frame, l.row, qcol, qwidth, INPUT);
    let query: Vec<char> = bar.state.query().chars().collect();
    let caret = bar.caret.min(query.len());
    let mut chars: Vec<(char, bool)> = Vec::with_capacity(query.len() + 8);
    chars.extend(query[..caret].iter().map(|c| (*c, false)));
    if let Some(p) = preedit {
        chars.extend(
            p.text
                .chars()
                .filter(|c| !c.is_control())
                .map(|c| (c, true)),
        );
    }
    let caret_at = chars.len();
    chars.extend(query[caret..].iter().map(|c| (*c, false)));

    // Scroll the text left so the caret stays inside the box.
    let room = qwidth.saturating_sub(1);
    let mut start = caret_at;
    let mut used = 0u16;
    while start > 0 {
        let w = width_of(chars[start - 1].0);
        if used + w > room {
            break;
        }
        used += w;
        start -= 1;
    }
    let caret_col = qcol + used;

    let end_col = qcol + qwidth;
    let mut col = qcol;
    let mut segments: Vec<(String, bool)> = Vec::new();
    for (c, pre) in &chars[start..] {
        match segments.last_mut() {
            Some((s, p)) if *p == *pre => s.push(*c),
            _ => segments.push((c.to_string(), *pre)),
        }
    }
    for (text, pre) in &segments {
        if col >= end_col {
            break;
        }
        let style = if *pre { PREEDIT } else { INPUT };
        col += draw_text(frame, l.row, col, end_col - col, text, style);
    }

    // The caret: the cell under it reversed.
    let idx = l.row as usize * frame.cols as usize + caret_col as usize;
    if caret_col < frame.cols {
        if let Some(cell) = frame.cells.get_mut(idx) {
            cell.attrs = Attrs(cell.attrs.0 | Attrs::INVERSE);
        }
    }

    // Results, right-aligned in their box.
    if l.status.1 > 0 {
        let text = bar.state.status();
        let w: u16 = text.chars().map(width_of).sum();
        let style = if text == "No matches" {
            STATUS_NONE
        } else {
            STATUS
        };
        fill(frame, l.row, l.status.0, l.status.1, STATUS);
        let at = l.status.0 + l.status.1.saturating_sub(w);
        draw_text(frame, l.row, at, l.status.1, &text, style);
    }

    for (button, c, w) in &l.buttons {
        let on = *button == FindButton::Case && bar.state.case_sensitive();
        let style = if on { BUTTON_ON } else { BUTTON };
        draw_text(frame, l.row, *c, *w, button.text(), style);
    }
    Some(Drawn {
        caret: (l.row, caret_col),
    })
}

/// Paints the matches on the lines shown (`top` is the first absolute line on
/// screen); the current one stands out.
pub fn highlight(frame: &mut Frame, top: usize, matches: &[Match], current: Option<Match>) {
    let (cols, rows) = (frame.cols as usize, frame.rows as usize);
    if cols == 0 || rows == 0 || frame.cells.len() != cols * rows {
        return;
    }
    for m in matches {
        if m.line < top || m.line - top >= rows {
            continue;
        }
        let row = m.line - top;
        let (fg, bg) = if current == Some(*m) { CURRENT } else { MATCH };
        let last = (m.end as usize).min(cols - 1);
        for col in m.start as usize..=last {
            let cell = &mut frame.cells[row * cols + col];
            cell.fg = fg;
            cell.bg = bg;
            cell.attrs = Attrs(cell.attrs.0 & !Attrs::INVERSE);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: Mods = Mods {
        shift: false,
        ctrl: false,
        alt: false,
        logo: false,
    };
    const SHIFT: Mods = Mods {
        shift: true,
        ..NONE
    };
    const CTRL: Mods = Mods { ctrl: true, ..NONE };
    const ALT: Mods = Mods { alt: true, ..NONE };
    const CMD: Mods = Mods { logo: true, ..NONE };
    const MAC: Platform = Platform::MacOs;
    const OTHER: Platform = Platform::Other;

    fn k(nav: Nav, un: &str, text: Option<&str>, m: Mods, p: Platform) -> Option<FindKey> {
        key_to_find(nav, un, text, m, p)
    }

    #[test]
    fn named_keys_map_to_commands() {
        assert_eq!(k(Nav::Escape, "", None, NONE, MAC), Some(FindKey::Close));
        assert_eq!(k(Nav::Enter, "", None, NONE, MAC), Some(FindKey::Next));
        assert_eq!(k(Nav::Enter, "", None, SHIFT, MAC), Some(FindKey::Prev));
        assert_eq!(k(Nav::F3, "", None, NONE, OTHER), Some(FindKey::Next));
        assert_eq!(k(Nav::F3, "", None, SHIFT, OTHER), Some(FindKey::Prev));
        assert_eq!(
            k(Nav::Backspace, "", None, NONE, MAC),
            Some(FindKey::Backspace)
        );
        assert_eq!(k(Nav::Backspace, "", None, CMD, MAC), Some(FindKey::Clear));
        assert_eq!(
            k(Nav::Backspace, "", None, CTRL, OTHER),
            Some(FindKey::Clear)
        );
        assert_eq!(k(Nav::Left, "", None, NONE, MAC), Some(FindKey::Left));
        assert_eq!(k(Nav::Left, "", None, CMD, MAC), Some(FindKey::Home));
        assert_eq!(k(Nav::Right, "", None, CTRL, OTHER), Some(FindKey::End));
        assert_eq!(k(Nav::Home, "", None, NONE, OTHER), Some(FindKey::Home));
        assert_eq!(k(Nav::End, "", None, NONE, OTHER), Some(FindKey::End));
        assert_eq!(k(Nav::Delete, "", None, NONE, OTHER), Some(FindKey::Delete));
    }

    #[test]
    fn mac_chords_and_the_case_toggle() {
        assert_eq!(k(Nav::Other, "g", None, CMD, MAC), Some(FindKey::Next));
        let cmd_shift = Mods { shift: true, ..CMD };
        assert_eq!(
            k(Nav::Other, "G", None, cmd_shift, MAC),
            Some(FindKey::Prev)
        );
        let cmd_alt = Mods { alt: true, ..CMD };
        assert_eq!(
            k(Nav::Other, "c", None, cmd_alt, MAC),
            Some(FindKey::ToggleCase)
        );
        // Other Command chords are ignored, never typed.
        assert_eq!(k(Nav::Other, "x", Some("x"), CMD, MAC), None);
        // Option+C on macOS types a character; it is not the toggle.
        assert_eq!(
            k(Nav::Other, "c", Some("ç"), ALT, MAC),
            Some(FindKey::Text("ç".into()))
        );
        // Elsewhere Alt+C toggles.
        assert_eq!(
            k(Nav::Other, "c", Some("c"), ALT, OTHER),
            Some(FindKey::ToggleCase)
        );
    }

    #[test]
    fn text_keys_type_and_ctrl_chords_do_not() {
        assert_eq!(
            k(Nav::Other, "a", Some("a"), NONE, OTHER),
            Some(FindKey::Text("a".into()))
        );
        assert_eq!(
            k(Nav::Other, "a", Some("A"), SHIFT, OTHER),
            Some(FindKey::Text("A".into()))
        );
        assert_eq!(k(Nav::Other, "a", Some("\u{1}"), CTRL, OTHER), None);
        // AltGr (Ctrl+Alt) still types.
        let altgr = Mods {
            ctrl: true,
            alt: true,
            ..NONE
        };
        assert_eq!(
            k(Nav::Other, "q", Some("@"), altgr, OTHER),
            Some(FindKey::Text("@".into()))
        );
        // Keys with no text type nothing; controls are stripped.
        assert_eq!(k(Nav::Other, "", None, NONE, OTHER), None);
        assert_eq!(k(Nav::Other, "", Some("\u{1b}"), NONE, OTHER), None);
        assert_eq!(
            k(Nav::Other, "", Some("日本"), NONE, OTHER),
            Some(FindKey::Text("日本".into()))
        );
    }

    fn typed(s: &str) -> FindBar {
        let mut b = FindBar::default();
        b.open(None);
        assert_eq!(b.insert_text(s), FindEvent::QueryChanged);
        b
    }

    #[test]
    fn typing_inserts_at_the_caret_and_moves_it() {
        let mut b = typed("ac");
        assert_eq!(b.caret(), 2);
        assert_eq!(b.on_key(FindKey::Left), FindEvent::Redraw);
        assert_eq!(b.on_key(FindKey::Text("b".into())), FindEvent::QueryChanged);
        assert_eq!(b.state().query(), "abc");
        assert_eq!(b.caret(), 2);
        assert_eq!(b.on_key(FindKey::End), FindEvent::Redraw);
        assert_eq!(b.on_key(FindKey::End), FindEvent::Nothing);
        assert_eq!(b.on_key(FindKey::Home), FindEvent::Redraw);
        assert_eq!(b.on_key(FindKey::Left), FindEvent::Nothing);
        assert_eq!(b.on_key(FindKey::Text("_".into())), FindEvent::QueryChanged);
        assert_eq!(b.state().query(), "_abc");
    }

    #[test]
    fn backspace_delete_and_clear_edit_by_character() {
        let mut b = typed("a日\u{e9}");
        assert_eq!(b.caret(), 3);
        assert_eq!(b.on_key(FindKey::Backspace), FindEvent::QueryChanged);
        assert_eq!(b.state().query(), "a日");
        assert_eq!(b.on_key(FindKey::Left), FindEvent::Redraw);
        assert_eq!(b.on_key(FindKey::Delete), FindEvent::QueryChanged);
        assert_eq!(b.state().query(), "a");
        assert_eq!(b.on_key(FindKey::Delete), FindEvent::Nothing);
        assert_eq!(b.on_key(FindKey::Home), FindEvent::Redraw);
        assert_eq!(b.on_key(FindKey::Backspace), FindEvent::Nothing);
        assert_eq!(b.on_key(FindKey::Clear), FindEvent::QueryChanged);
        assert_eq!(b.state().query(), "");
        assert_eq!(b.caret(), 0);
        assert_eq!(b.on_key(FindKey::Clear), FindEvent::Nothing);
    }

    #[test]
    fn pasted_text_is_one_clean_line_and_the_query_is_capped() {
        let mut b = FindBar::default();
        b.open(None);
        assert_eq!(b.insert_text("first\nsecond"), FindEvent::QueryChanged);
        assert_eq!(b.state().query(), "first");
        assert_eq!(b.insert_text("\n\n"), FindEvent::Nothing);
        assert_eq!(b.insert_text("\u{1b}[31m"), FindEvent::QueryChanged);
        assert_eq!(b.state().query(), "first[31m");
        let mut b = FindBar::default();
        b.open(None);
        b.insert_text(&"x".repeat(MAX_QUERY_CHARS + 50));
        assert_eq!(b.state().query().chars().count(), MAX_QUERY_CHARS);
        assert_eq!(b.insert_text("more"), FindEvent::Nothing);
    }

    #[test]
    fn opening_prefills_once_and_remembers_the_query_after_close() {
        let mut b = FindBar::default();
        assert!(!b.is_open());
        assert!(b.open(Some("selected\nrest")));
        assert_eq!(b.state().query(), "selected");
        assert_eq!(b.caret(), 8);
        // Opening again while open keeps what was typed.
        assert!(!b.open(Some("other")));
        assert_eq!(b.state().query(), "selected");
        b.close();
        assert!(!b.is_open());
        // Re-opening with nothing selected shows the last query.
        assert!(!b.open(None));
        assert_eq!(b.state().query(), "selected");
        b.close();
        // A selection wins again after a close.
        assert!(b.open(Some("new")));
        assert_eq!(b.state().query(), "new");
        // A blank prefill does not clear it.
        b.close();
        assert!(!b.open(Some("\n")));
        assert_eq!(b.state().query(), "new");
    }

    #[test]
    fn next_prev_case_and_close_are_events() {
        let mut b = typed("x");
        assert_eq!(b.on_key(FindKey::Next), FindEvent::Next);
        assert_eq!(b.on_key(FindKey::Prev), FindEvent::Prev);
        assert_eq!(b.on_key(FindKey::Close), FindEvent::Close);
        assert!(!b.state().case_sensitive());
        assert_eq!(b.on_key(FindKey::ToggleCase), FindEvent::CaseChanged);
        assert!(b.state().case_sensitive());
        assert_eq!(b.on_key(FindKey::ToggleCase), FindEvent::CaseChanged);
        assert!(!b.state().case_sensitive());
    }

    #[test]
    fn the_layout_never_overlaps_and_degrades_with_width() {
        for cols in [3u16, 10, 19, 20, 33, 34, 43, 44, 69, 70, 80, 200] {
            let l = layout(cols, 24);
            assert_eq!(l.row, 23);
            // Parts left to right: label, query, status, buttons, all inside.
            let mut edge = 0u16;
            for (c, w) in [l.label, l.query, l.status] {
                assert!(c >= edge, "cols {cols}: {c} < {edge}");
                edge = c + w;
                assert!(edge <= cols, "cols {cols}");
            }
            for (_, c, w) in &l.buttons {
                assert!(*c >= edge && c + w <= cols, "cols {cols}");
                edge = c + w;
            }
            assert!(l.query.1 >= 1, "cols {cols}: no room to type");
        }
        assert_eq!(layout(80, 24).buttons.len(), 4);
        assert_eq!(layout(50, 24).buttons.len(), 1);
        assert!(layout(30, 24).buttons.is_empty());
        assert_eq!(layout(80, 0).row, 0);
    }

    #[test]
    fn buttons_are_hit_by_column() {
        let l = layout(80, 24);
        let order: Vec<FindButton> = l.buttons.iter().map(|b| b.0).collect();
        assert_eq!(
            order,
            vec![
                FindButton::Case,
                FindButton::Prev,
                FindButton::Next,
                FindButton::Close
            ]
        );
        for (b, c, w) in &l.buttons {
            assert_eq!(l.hit(*c), Some(*b));
            assert_eq!(l.hit(c + w - 1), Some(*b));
            assert_eq!(
                l.hit(c + w),
                None,
                "the gap after a button is not part of it"
            );
        }
        assert_eq!(l.hit(0), None);
        assert_eq!(l.hit(l.query.0), None);
    }

    fn text_of(f: &Frame, row: u16) -> String {
        (0..f.cols)
            .filter_map(|c| {
                let cell = f.cell(row, c)?;
                (!cell.attrs.has(Attrs::WIDE_TAIL)).then(|| f.text(cell))
            })
            .collect()
    }

    #[test]
    fn the_bar_draws_label_query_status_and_buttons_on_the_last_row() {
        let mut f = Frame::blank(80, 5);
        let mut b = typed("needle");
        b.state_mut().set_case_sensitive(true);
        let drawn = draw(&mut f, &b, None).unwrap();
        let row = text_of(&f, 4);
        assert!(row.starts_with(" Find: needle"), "{row:?}");
        assert!(row.contains(" Aa "));
        assert!(row.contains(" Prev "));
        assert!(row.contains(" Next "));
        assert!(row.trim_end().ends_with(" Close"));
        // Other rows are untouched.
        assert_eq!(text_of(&f, 3), " ".repeat(80));
        // The caret is after the query, drawn reversed.
        assert_eq!(drawn.caret, (4, 7 + 6));
        assert!(f.cell(4, 13).unwrap().attrs.has(Attrs::INVERSE));
        assert!(!f.cell(4, 12).unwrap().attrs.has(Attrs::INVERSE));
        // Case sensitivity lights its button.
        let l = layout(80, 5);
        let (_, c, _) = l.buttons[0];
        assert_eq!(f.cell(4, c + 1).unwrap().bg, BUTTON_ON.bg);
        let (_, c, _) = l.buttons[1];
        assert_eq!(f.cell(4, c + 1).unwrap().bg, BUTTON.bg);
    }

    #[test]
    fn the_status_is_right_aligned_and_flags_no_matches() {
        let mut f = Frame::blank(80, 3);
        let b = typed("zzz");
        // No refresh yet: no matches are known, so the bar says so.
        draw(&mut f, &b, None).unwrap();
        let l = layout(80, 3);
        let end = l.status.0 + l.status.1;
        assert_eq!(f.cell(2, end - 1).unwrap().ch, 's');
        assert_eq!(f.cell(2, end - 1).unwrap().fg, STATUS_NONE.fg);
        let row = text_of(&f, 2);
        assert!(row.contains("No matches"));
        // Empty query: nothing in the status box.
        let mut f = Frame::blank(80, 3);
        let mut e = FindBar::default();
        e.open(None);
        draw(&mut f, &e, None).unwrap();
        assert!(!text_of(&f, 2).contains("matches"));
    }

    #[test]
    fn a_long_query_scrolls_so_the_caret_stays_visible() {
        let mut f = Frame::blank(40, 2);
        let b = typed(&format!("{}END", "x".repeat(60)));
        let drawn = draw(&mut f, &b, None).unwrap();
        let l = layout(40, 2);
        let (qc, qw) = l.query;
        assert!(drawn.caret.1 < qc + qw, "caret inside the query box");
        let row = text_of(&f, 1);
        assert!(row.contains("xEND"), "{row:?}");
        // Caret at the start shows the start of the text.
        let mut b = b;
        b.on_key(FindKey::Home);
        let mut g = Frame::blank(40, 2);
        let drawn = draw(&mut g, &b, None).unwrap();
        assert_eq!(drawn.caret.1, qc);
        assert!(text_of(&g, 1).contains(" Find: xxxx"));
    }

    #[test]
    fn wide_characters_and_marks_in_the_query_draw_whole() {
        let mut f = Frame::blank(60, 2);
        let b = typed("日本e\u{301}");
        let drawn = draw(&mut f, &b, None).unwrap();
        let row = text_of(&f, 1);
        assert!(row.contains("日本e\u{301}"), "{row:?}");
        // Two wide characters (4 cells) and the accented e (1 cell).
        assert_eq!(drawn.caret.1, 7 + 5);
    }

    #[test]
    fn a_composition_is_drawn_underlined_at_the_caret_and_moves_it() {
        let mut f = Frame::blank(60, 2);
        let mut b = typed("ab");
        b.on_key(FindKey::Left);
        let pre = Preedit {
            text: "かな".into(),
            caret: None,
        };
        let drawn = draw(&mut f, &b, Some(&pre)).unwrap();
        let row = text_of(&f, 1);
        assert!(row.contains("aかなb"), "{row:?}");
        assert!(f.cell(1, 8).unwrap().attrs.has(Attrs::UNDERLINE));
        assert!(!f.cell(1, 7).unwrap().attrs.has(Attrs::UNDERLINE));
        // The caret (and so the candidate window) is after the composition.
        assert_eq!(drawn.caret.1, 7 + 1 + 4);
        // The query itself is unchanged.
        assert_eq!(b.state().query(), "ab");
    }

    #[test]
    fn a_tiny_or_empty_frame_is_left_alone() {
        let mut f = Frame::blank(0, 0);
        assert!(draw(&mut f, &typed("a"), None).is_none());
        let mut f = Frame::blank(4, 1);
        let drawn = draw(&mut f, &typed("abcdef"), None).unwrap();
        assert!(drawn.caret.1 < 4);
        assert_eq!(drawn.caret.0, 0);
    }

    #[test]
    fn matches_are_painted_and_the_current_one_stands_out() {
        let mut f = Frame::blank(10, 3);
        for (i, ch) in "foo foo".chars().enumerate() {
            f.cells[10 + i].ch = ch;
        }
        f.cells[10].attrs = Attrs(Attrs::INVERSE | Attrs::BOLD);
        let ms = [
            Match {
                line: 11,
                start: 0,
                end: 2,
            },
            Match {
                line: 11,
                start: 4,
                end: 6,
            },
            Match {
                line: 99,
                start: 0,
                end: 1,
            },
        ];
        highlight(&mut f, 10, &ms, Some(ms[1]));
        assert_eq!(f.cell(1, 0).unwrap().bg, MATCH.1);
        assert_eq!(f.cell(1, 2).unwrap().bg, MATCH.1);
        assert_eq!(f.cell(1, 3).unwrap().bg, Color::Default);
        assert_eq!(f.cell(1, 4).unwrap().bg, CURRENT.1);
        assert_eq!(f.cell(1, 6).unwrap().bg, CURRENT.1);
        // Inverse is dropped so the colours read as set; other attributes stay.
        assert!(!f.cell(1, 0).unwrap().attrs.has(Attrs::INVERSE));
        assert!(f.cell(1, 0).unwrap().attrs.has(Attrs::BOLD));
        // Lines off screen, and a match past a resized grid, are skipped.
        assert_eq!(f.cell(0, 0).unwrap().bg, Color::Default);
        let far = [Match {
            line: 10,
            start: 50,
            end: 60,
        }];
        highlight(&mut f, 10, &far, None);
        assert_eq!(f.cell(0, 9).unwrap().bg, Color::Default);
    }

    #[test]
    fn the_accessibility_description_follows_the_bar() {
        let mut b = typed("abc");
        let a = b.a11y(80, 24);
        assert_eq!(a.query, "abc");
        assert_eq!(a.status, "No matches");
        assert!(!a.case_sensitive);
        assert_eq!(a.layout.row, 23);
        b.on_key(FindKey::ToggleCase);
        assert!(b.a11y(80, 24).case_sensitive);
        assert_eq!(FindButton::Next.name(), "Next match");
    }
}
