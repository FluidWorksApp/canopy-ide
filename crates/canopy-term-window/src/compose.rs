//! The frame the renderer draws: the program's frame, plus the IME composition
//! drawn over the cursor row.
//!
//! The composition is drawn as ordinary underlined cells in a copy of the frame,
//! so the renderer needs no IME support. A frame with an overlay (and the first
//! frame after one) is marked fully damaged: the renderer's damage tracking is
//! by frame sequence, and the overlay changes cells without a new sequence. A
//! full rebuild per composition keystroke is cheap next to the IME round trip.

use std::borrow::Cow;

use canopy_term_core::frame::{Attrs, Cell, CursorShape, Frame};

use crate::ime::{preedit_cells, Preedit};

/// Draws `preedit` at the cursor of a copy of `frame`: one underlined cell per
/// composed character starting at the cursor column, clipped at the end of the
/// row, with the cursor moved to the composition's caret (a bar) or hidden.
pub fn overlay_preedit(frame: &Frame, preedit: &Preedit) -> Frame {
    let mut out = frame.clone();
    let (cols, rows) = (frame.cols, frame.rows);
    if cols == 0 || rows == 0 || out.cells.len() != cols as usize * rows as usize {
        return out;
    }
    let row = frame.cursor.row.min(rows - 1);
    let start = frame.cursor.col.min(cols - 1);
    let base = row as usize * cols as usize;
    let (cells, caret) = preedit_cells(preedit);

    // A composition starting on the tail of a wide character replaces the
    // whole character.
    if start > 0 && out.cells[base + start as usize].attrs.has(Attrs::WIDE_TAIL) {
        out.cells[base + start as usize - 1] = Cell::default();
    }

    let mut col = start;
    for pc in &cells {
        let w = pc.cols as u16;
        if col + w > cols {
            break;
        }
        let mut chars = pc.text.chars();
        let ch = chars.next().unwrap_or(' ');
        let cluster = if chars.next().is_some() {
            out.clusters.push(pc.text.clone());
            (out.clusters.len() - 1) as u32
        } else {
            0
        };
        out.cells[base + col as usize] = Cell {
            ch,
            cluster,
            attrs: Attrs(Attrs::UNDERLINE),
            ..Cell::default()
        };
        if w == 2 {
            out.cells[base + col as usize + 1] = Cell {
                ch: '\0',
                attrs: Attrs(Attrs::WIDE_TAIL | Attrs::UNDERLINE),
                ..Cell::default()
            };
        }
        col += w;
    }
    // A wide character cut in half by the end of the composition loses its
    // orphaned tail.
    if col < cols && out.cells[base + col as usize].attrs.has(Attrs::WIDE_TAIL) {
        out.cells[base + col as usize] = Cell::default();
    }

    match caret {
        Some(c) => {
            out.cursor.col = (start + c).min(cols - 1);
            out.cursor.row = row;
            out.cursor.shape = CursorShape::Bar;
            out.cursor.visible = true;
        }
        None => out.cursor.visible = false,
    }
    out.damage.full = true;
    out
}

/// Chooses between the frame as it is and a composed copy, and remembers
/// whether the last drawn frame had an overlay so the frame after it is
/// redrawn in full (the overlay's cells are otherwise left on screen).
#[derive(Clone, Copy, Debug, Default)]
pub struct Composer {
    overlay_drawn: bool,
    pending: bool,
}

impl Composer {
    pub fn view<'a>(&mut self, frame: &'a Frame, preedit: Option<&Preedit>) -> Cow<'a, Frame> {
        self.pending = preedit.is_some();
        match preedit {
            Some(p) => Cow::Owned(overlay_preedit(frame, p)),
            None if self.overlay_drawn => {
                let mut f = frame.clone();
                f.damage.full = true;
                Cow::Owned(f)
            }
            None => Cow::Borrowed(frame),
        }
    }

    /// After the renderer built the view: `held` is true when it drew nothing
    /// (synchronized output), in which case the previous state stands.
    pub fn drawn(&mut self, held: bool) {
        if !held {
            self.overlay_drawn = self.pending;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_term_core::frame::Damage;

    fn prompt() -> Frame {
        let mut f = Frame::blank(10, 2);
        f.seq = 7;
        f.damage = Damage {
            since: 6,
            full: false,
            rows: vec![(0, 0)],
        };
        for (i, ch) in "$ ".chars().enumerate() {
            f.cells[i].ch = ch;
        }
        f.cursor.col = 2;
        f.cursor.visible = true;
        f
    }

    fn p(text: &str, caret: Option<(usize, usize)>) -> Preedit {
        Preedit {
            text: text.into(),
            caret,
        }
    }

    #[test]
    fn composition_is_drawn_underlined_at_the_cursor_with_wide_tails() {
        let f = prompt();
        let out = overlay_preedit(&f, &p("日本", Some((6, 6))));
        assert_eq!(out.cells[2].ch, '日');
        assert!(out.cells[2].attrs.has(Attrs::UNDERLINE));
        assert!(out.cells[3].attrs.has(Attrs::WIDE_TAIL));
        assert_eq!(out.cells[4].ch, '本');
        assert!(out.cells[5].attrs.has(Attrs::WIDE_TAIL));
        assert_eq!(out.cursor.col, 6);
        assert_eq!(out.cursor.shape, CursorShape::Bar);
        assert!(out.damage.full);
        // The program's frame is untouched.
        assert_eq!(f.cells[2].ch, ' ');
    }

    #[test]
    fn composition_is_clipped_at_the_row_end_without_splitting_a_wide_char() {
        let mut f = prompt();
        f.cursor.col = 7;
        let out = overlay_preedit(&f, &p("あいう", None));
        // Col 7-8 hold "あ"; "い" would need 9-10 and is dropped.
        assert_eq!(out.cells[7].ch, 'あ');
        assert_eq!(out.cells[9].ch, ' ');
        assert!(!out.cursor.visible);
        // Nothing spills into the next row.
        assert_eq!(out.cells[10].ch, ' ');
    }

    #[test]
    fn combining_marks_become_one_cluster_cell() {
        let f = prompt();
        let out = overlay_preedit(&f, &p("e\u{301}", Some((3, 3))));
        assert_eq!(out.text(&out.cells[2]), "e\u{301}");
        assert_eq!(out.cursor.col, 3);
    }

    #[test]
    fn overwriting_half_a_wide_character_blanks_the_other_half() {
        let mut f = prompt();
        f.cells[2].ch = '漢';
        f.cells[3] = Cell {
            ch: '\0',
            attrs: Attrs(Attrs::WIDE_TAIL),
            ..Cell::default()
        };
        f.cells[4].ch = '字';
        f.cells[5] = Cell {
            ch: '\0',
            attrs: Attrs(Attrs::WIDE_TAIL),
            ..Cell::default()
        };
        // Starting on a tail: the head is cleared.
        f.cursor.col = 3;
        let out = overlay_preedit(&f, &p("a", None));
        assert_eq!(out.cells[2], Cell::default());
        assert_eq!(out.cells[3].ch, 'a');
        // Ending on a head: its tail is cleared.
        f.cursor.col = 2;
        let out = overlay_preedit(&f, &p("abc", None));
        assert_eq!(out.cells[4].ch, 'c');
        assert_eq!(out.cells[5], Cell::default());
    }

    #[test]
    fn the_frame_after_a_composition_is_redrawn_in_full_once() {
        let f = prompt();
        let mut c = Composer::default();
        // No composition: the frame passes through untouched.
        assert!(matches!(c.view(&f, None), Cow::Borrowed(_)));
        c.drawn(false);
        let pe = p("か", None);
        assert!(c.view(&f, Some(&pe)).damage.full);
        c.drawn(false);
        // Composition ended: one full redraw to wipe it.
        let v = c.view(&f, None);
        assert!(v.damage.full);
        assert_eq!(v.cells[2].ch, ' ');
        c.drawn(false);
        assert!(matches!(c.view(&f, None), Cow::Borrowed(_)));
    }

    #[test]
    fn a_held_frame_does_not_forget_the_overlay() {
        let f = prompt();
        let mut c = Composer::default();
        let pe = p("か", None);
        let _ = c.view(&f, Some(&pe));
        c.drawn(false);
        let _ = c.view(&f, None);
        c.drawn(true); // synchronized output: nothing was drawn
        assert!(c.view(&f, None).damage.full);
    }
}
