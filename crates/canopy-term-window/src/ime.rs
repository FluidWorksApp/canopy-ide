//! Input method composition, as a state machine with no window.
//!
//! * `Preedit` text is shown at the cursor (see `compose`) and never sent to the
//!   program; only a `Commit` is, as text.
//! * While a composition is in progress key events are not forwarded: the input
//!   method owns them (arrow keys pick candidates, Enter confirms).
//! * Some platforms deliver the committed text a second time as the text of the
//!   key event that confirmed it. `ImeGate` drops a key whose text equals the
//!   commit that just arrived, once.
//! * The candidate window is placed under the composition: `cursor_area` gives
//!   the physical-pixel rectangle for `Window::set_ime_cursor_area`.

use unicode_width::UnicodeWidthChar;

use crate::grid::{cell_rect, CellPx, PxRect};

/// The window-independent mirror of `winit::event::Ime`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImeEvent {
    Enabled,
    /// Composition text and the caret as a byte range into it (`None` hides
    /// the caret). Empty text clears the composition.
    Preedit(String, Option<(usize, usize)>),
    Commit(String),
    Disabled,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preedit {
    pub text: String,
    pub caret: Option<(usize, usize)>,
}

/// What the window should do after an IME event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImeAction {
    None,
    /// The composition changed: redraw (and move the candidate window).
    Redraw,
    /// Send this text to the program, then redraw (the composition ended).
    Send(String),
}

#[derive(Clone, Debug, Default)]
pub struct ImeGate {
    enabled: bool,
    preedit: Option<Preedit>,
    /// The last commit, until the next key event: a key carrying the same text
    /// is the platform repeating it.
    just_committed: Option<String>,
}

impl ImeGate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// The composition to draw, if any.
    pub fn preedit(&self) -> Option<&Preedit> {
        self.preedit.as_ref()
    }

    pub fn composing(&self) -> bool {
        self.preedit.is_some()
    }

    pub fn on_event(&mut self, event: ImeEvent) -> ImeAction {
        match event {
            ImeEvent::Enabled => {
                self.enabled = true;
                ImeAction::None
            }
            ImeEvent::Preedit(text, caret) => {
                let next = if text.is_empty() {
                    None
                } else {
                    let caret = caret.filter(|&(a, b)| {
                        a <= b
                            && b <= text.len()
                            && text.is_char_boundary(a)
                            && text.is_char_boundary(b)
                    });
                    Some(Preedit { text, caret })
                };
                if next == self.preedit {
                    return ImeAction::None;
                }
                self.preedit = next;
                ImeAction::Redraw
            }
            ImeEvent::Commit(text) => {
                self.preedit = None;
                if text.is_empty() {
                    return ImeAction::Redraw;
                }
                self.just_committed = Some(text.clone());
                ImeAction::Send(text)
            }
            ImeEvent::Disabled => {
                self.enabled = false;
                let had = self.preedit.take().is_some();
                if had {
                    ImeAction::Redraw
                } else {
                    ImeAction::None
                }
            }
        }
    }

    /// Whether a key event should go to the program. `text` is the key's
    /// produced text, if any. Call for presses only.
    pub fn forward_key(&mut self, text: Option<&str>) -> bool {
        if self.preedit.is_some() {
            return false;
        }
        let committed = self.just_committed.take();
        match (committed, text) {
            (Some(c), Some(t)) if c == t => false,
            _ => true,
        }
    }

    /// Focus moved away: an unfinished composition is dropped (the input
    /// method cancels it too).
    pub fn focus_lost(&mut self) -> bool {
        self.just_committed = None;
        self.preedit.take().is_some()
    }
}

/// One drawn cell of a composition.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreeditCell {
    /// One scalar, or a base plus its combining marks.
    pub text: String,
    /// Grid columns: 1, or 2 for a wide (CJK) character.
    pub cols: u8,
}

/// Lays composition text out in cells, and the caret's column offset from the
/// start of the composition (`None` when the caret is hidden).
///
/// Zero-width scalars (combining marks, joiners) attach to the previous cell;
/// control characters are dropped.
pub fn preedit_cells(p: &Preedit) -> (Vec<PreeditCell>, Option<u16>) {
    let mut cells: Vec<PreeditCell> = Vec::new();
    let mut caret_col = None;
    let caret_byte = p.caret.map(|(a, _)| a);
    let mut col: u16 = 0;
    for (byte, ch) in p.text.char_indices() {
        if caret_byte == Some(byte) {
            caret_col = Some(col);
        }
        match ch.width() {
            None => {}
            Some(0) => match cells.last_mut() {
                Some(last) => last.text.push(ch),
                None => {
                    cells.push(PreeditCell {
                        text: ch.to_string(),
                        cols: 1,
                    });
                    col = col.saturating_add(1);
                }
            },
            Some(w) => {
                let cols = w.min(2) as u8;
                cells.push(PreeditCell {
                    text: ch.to_string(),
                    cols,
                });
                col = col.saturating_add(cols as u16);
            }
        }
    }
    if caret_byte == Some(p.text.len()) {
        caret_col = Some(col);
    }
    (cells, caret_col)
}

/// Total grid columns a composition takes.
pub fn preedit_cols(p: &Preedit) -> u16 {
    preedit_cells(p).0.iter().map(|c| c.cols as u16).sum()
}

/// Where to put the IME candidate window: the cells the composition covers
/// (at least one, clipped to the row) starting at the terminal cursor, in
/// physical pixels.
pub fn cursor_area(cursor: (u16, u16), preedit_cols: u16, cell: CellPx, grid_cols: u16) -> PxRect {
    let (row, col) = cursor;
    let col = col.min(grid_cols.saturating_sub(1));
    let room = grid_cols.saturating_sub(col).max(1);
    cell_rect(cell, row, col, preedit_cols.clamp(1, room))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preedit(text: &str, caret: Option<(usize, usize)>) -> ImeEvent {
        ImeEvent::Preedit(text.to_string(), caret)
    }

    #[test]
    fn japanese_composition_shows_preedit_then_sends_only_the_commit() {
        let mut g = ImeGate::new();
        assert_eq!(g.on_event(ImeEvent::Enabled), ImeAction::None);
        assert_eq!(g.on_event(preedit("に", Some((3, 3)))), ImeAction::Redraw);
        assert_eq!(g.on_event(preedit("にほ", Some((6, 6)))), ImeAction::Redraw);
        assert_eq!(g.preedit().unwrap().text, "にほ");
        // Keys go to the input method while composing.
        assert!(!g.forward_key(Some("n")));
        assert_eq!(g.on_event(preedit("日本", Some((6, 6)))), ImeAction::Redraw);
        // Platforms send an empty preedit before the commit.
        assert_eq!(g.on_event(preedit("", None)), ImeAction::Redraw);
        assert_eq!(
            g.on_event(ImeEvent::Commit("日本".into())),
            ImeAction::Send("日本".into())
        );
        assert!(!g.composing());
    }

    #[test]
    fn a_repeated_commit_in_the_next_key_event_is_dropped_once() {
        let mut g = ImeGate::new();
        g.on_event(ImeEvent::Commit("中文".into()));
        assert!(!g.forward_key(Some("中文")));
        // Only once: the same text typed again is real input.
        assert!(g.forward_key(Some("中文")));
        // A different key after a commit goes through.
        g.on_event(ImeEvent::Commit("a".into()));
        assert!(g.forward_key(Some("b")));
        // A key with no text (Enter, arrows) after a commit goes through.
        g.on_event(ImeEvent::Commit("x".into()));
        assert!(g.forward_key(None));
    }

    #[test]
    fn identical_preedit_needs_no_redraw_and_disable_clears_it() {
        let mut g = ImeGate::new();
        g.on_event(preedit("ㅎ", None));
        assert_eq!(g.on_event(preedit("ㅎ", None)), ImeAction::None);
        assert_eq!(g.on_event(ImeEvent::Disabled), ImeAction::Redraw);
        assert!(!g.composing());
        assert_eq!(g.on_event(ImeEvent::Disabled), ImeAction::None);
    }

    #[test]
    fn an_invalid_caret_is_hidden_not_trusted() {
        let mut g = ImeGate::new();
        // Byte 1 is inside the 3-byte "日".
        g.on_event(preedit("日", Some((1, 1))));
        assert_eq!(g.preedit().unwrap().caret, None);
        g.on_event(preedit("日本", Some((9, 9))));
        assert_eq!(g.preedit().unwrap().caret, None);
    }

    #[test]
    fn focus_loss_drops_the_composition() {
        let mut g = ImeGate::new();
        g.on_event(preedit("ni", None));
        assert!(g.focus_lost());
        assert!(g.forward_key(Some("a")));
    }

    #[test]
    fn preedit_cells_are_wide_for_cjk_and_marks_attach() {
        let p = Preedit {
            text: "日本e\u{301}x".into(),
            caret: Some(("日本e\u{301}".len(), "日本e\u{301}".len())),
        };
        let (cells, caret) = preedit_cells(&p);
        let texts: Vec<(&str, u8)> = cells.iter().map(|c| (c.text.as_str(), c.cols)).collect();
        assert_eq!(texts, vec![("日", 2), ("本", 2), ("e\u{301}", 1), ("x", 1)]);
        assert_eq!(caret, Some(5));
        assert_eq!(preedit_cols(&p), 6);
    }

    #[test]
    fn caret_at_the_end_and_at_the_start() {
        let end = Preedit {
            text: "かな".into(),
            caret: Some((6, 6)),
        };
        assert_eq!(preedit_cells(&end).1, Some(4));
        let start = Preedit {
            text: "かな".into(),
            caret: Some((0, 0)),
        };
        assert_eq!(preedit_cells(&start).1, Some(0));
        let hidden = Preedit {
            text: "かな".into(),
            caret: None,
        };
        assert_eq!(preedit_cells(&hidden).1, None);
    }

    #[test]
    fn candidate_window_sits_on_the_cursor_cell_and_covers_the_composition() {
        let cell = CellPx {
            width: 10,
            height: 20,
        };
        // Cursor at row 3, col 5; nothing composed yet: one cell.
        assert_eq!(
            cursor_area((3, 5), 0, cell, 80),
            PxRect {
                x: 50,
                y: 60,
                w: 10,
                h: 20
            }
        );
        // A 4-column composition.
        assert_eq!(cursor_area((3, 5), 4, cell, 80).w, 40);
        // Clipped at the right edge.
        assert_eq!(cursor_area((0, 78), 6, cell, 80).w, 20);
        // A cursor past the edge (pending wrap) stays in the last column.
        assert_eq!(cursor_area((0, 80), 1, cell, 80).x, 790);
    }
}
