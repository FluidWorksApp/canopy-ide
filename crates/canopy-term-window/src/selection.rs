//! Mouse selection over the visible grid and the text it copies.
//!
//! Same shape as the renderer's `geometry::Selection` (the window converts), so
//! this module needs no renderer and is testable on its own.

use canopy_term_core::frame::{Attrs, Frame};

/// A selection between two cells, inclusive, as the user dragged it:
/// `start` is where the drag began, `end` where it is now. (row, col).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Selection {
    pub start: (u16, u16),
    pub end: (u16, u16),
    /// Rectangular (block) selection instead of flowing text.
    pub block: bool,
}

impl Selection {
    /// Start and end in reading order.
    pub fn ordered(&self) -> ((u16, u16), (u16, u16)) {
        if self.start <= self.end {
            (self.start, self.end)
        } else {
            (self.end, self.start)
        }
    }

    /// The selected columns on `row` as `[start, end)`, or `None`.
    pub fn cols_on(&self, row: u16, cols: u16) -> Option<(u16, u16)> {
        if cols == 0 {
            return None;
        }
        if self.block {
            let (r0, r1) = (self.start.0.min(self.end.0), self.start.0.max(self.end.0));
            if row < r0 || row > r1 {
                return None;
            }
            let a = self.start.1.min(self.end.1);
            let b = self.start.1.max(self.end.1);
            return Some((a.min(cols), b.saturating_add(1).min(cols))).filter(|(s, e)| s < e);
        }
        let (a, b) = self.ordered();
        if row < a.0 || row > b.0 {
            return None;
        }
        let start = if row == a.0 { a.1 } else { 0 };
        let end = if row == b.0 {
            b.1.saturating_add(1)
        } else {
            cols
        };
        Some((start.min(cols), end.min(cols))).filter(|(s, e)| s < e)
    }
}

/// The text of `cols` [start, end) on `row`: wide-character tails skipped,
/// clusters in full, hidden (concealed) cells as spaces.
pub fn row_text(frame: &Frame, row: u16, start: u16, end: u16) -> String {
    let mut out = String::new();
    for col in start..end.min(frame.cols) {
        let Some(cell) = frame.cell(row, col) else {
            break;
        };
        if cell.attrs.has(Attrs::WIDE_TAIL) {
            continue;
        }
        if cell.attrs.has(Attrs::HIDDEN) || cell.ch == '\0' {
            out.push(' ');
        } else {
            out.push_str(&frame.text(cell));
        }
    }
    out
}

/// What a copy puts on the clipboard: each selected row's text with trailing
/// blanks removed, rows joined by `\n`. A flowing selection that reaches the
/// end of a row and continues is still a line break here (the frame does not
/// record soft wraps yet).
pub fn selection_text(frame: &Frame, sel: &Selection) -> String {
    let mut lines = Vec::new();
    let (first, last) = if sel.block {
        (sel.start.0.min(sel.end.0), sel.start.0.max(sel.end.0))
    } else {
        let (a, b) = sel.ordered();
        (a.0, b.0)
    };
    for row in first..=last.min(frame.rows.saturating_sub(1)) {
        if let Some((s, e)) = sel.cols_on(row, frame.cols) {
            lines.push(row_text(frame, row, s, e).trim_end().to_string());
        } else {
            lines.push(String::new());
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_term_core::frame::Cell;

    fn frame_of(lines: &[&str], cols: u16) -> Frame {
        let mut f = Frame::blank(cols, lines.len() as u16);
        for (r, line) in lines.iter().enumerate() {
            for (c, ch) in line.chars().enumerate() {
                f.cells[r * cols as usize + c].ch = ch;
            }
        }
        f
    }

    #[test]
    fn flowing_selection_spans_rows_and_trims_trailing_blanks() {
        let f = frame_of(&["hello world", "second line", "third"], 12);
        let sel = Selection {
            start: (0, 6),
            end: (2, 2),
            block: false,
        };
        assert_eq!(selection_text(&f, &sel), "world\nsecond line\nthi");
    }

    #[test]
    fn a_backwards_drag_selects_the_same_text() {
        let f = frame_of(&["hello world", "second line"], 12);
        let fwd = Selection {
            start: (0, 6),
            end: (1, 5),
            block: false,
        };
        let back = Selection {
            start: (1, 5),
            end: (0, 6),
            block: false,
        };
        assert_eq!(selection_text(&f, &fwd), selection_text(&f, &back));
        assert_eq!(selection_text(&f, &fwd), "world\nsecond");
    }

    #[test]
    fn block_selection_takes_the_same_columns_on_every_row() {
        let f = frame_of(&["abcdef", "ghijkl", "mnopqr"], 6);
        let sel = Selection {
            start: (2, 3),
            end: (0, 1),
            block: true,
        };
        assert_eq!(selection_text(&f, &sel), "bcd\nhij\nnop");
    }

    #[test]
    fn wide_characters_and_clusters_copy_once_and_hidden_cells_do_not_leak() {
        let mut f = Frame::blank(6, 1);
        f.cells[0].ch = '日';
        f.cells[1] = Cell {
            ch: '\0',
            attrs: Attrs(Attrs::WIDE_TAIL),
            ..Cell::default()
        };
        f.clusters.push("e\u{301}".into());
        f.cells[2] = Cell {
            ch: 'e',
            cluster: 1,
            ..Cell::default()
        };
        f.cells[3] = Cell {
            ch: 'p',
            attrs: Attrs(Attrs::HIDDEN),
            ..Cell::default()
        };
        f.cells[4].ch = 'x';
        let sel = Selection {
            start: (0, 0),
            end: (0, 5),
            block: false,
        };
        assert_eq!(selection_text(&f, &sel), "日e\u{301} x");
    }

    #[test]
    fn cols_on_clips_to_the_grid() {
        let sel = Selection {
            start: (0, 70),
            end: (0, 200),
            block: false,
        };
        assert_eq!(sel.cols_on(0, 80), Some((70, 80)));
        assert_eq!(sel.cols_on(1, 80), None);
        assert_eq!(sel.cols_on(0, 0), None);
    }
}
