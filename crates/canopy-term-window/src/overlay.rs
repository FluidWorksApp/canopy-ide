//! Text drawn over a copy of the frame: the scrollback badge and the find bar.
//!
//! Like the IME composition in [`crate::compose`], overlays are ordinary cells
//! in a copy of the frame, so the renderer needs no support for them and they
//! are tested without a window. The copy is fully damaged (see
//! [`crate::viewport::scrolled_view`] and `Composer`).

use canopy_term_core::frame::{Attrs, Cell, Color, Frame};
use unicode_width::UnicodeWidthChar;

/// Colours and attributes of drawn text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Style {
    pub fg: Color,
    pub bg: Color,
    pub attrs: u16,
}

/// The badge shown while the view is scrolled back.
pub const BADGE: Style = Style {
    fg: Color::Rgb(0x1b, 0x1b, 0x1b),
    bg: Color::Rgb(0xe5, 0xc0, 0x7b),
    attrs: Attrs::BOLD,
};

/// Draws `text` on `row` starting at column `col`, at most `max_cols` columns
/// wide (clipped, never splitting a wide character). Zero-width marks join the
/// character before them. Control characters are skipped. Returns the columns
/// used.
pub fn draw_text(
    frame: &mut Frame,
    row: u16,
    col: u16,
    max_cols: u16,
    text: &str,
    style: Style,
) -> u16 {
    let cols = frame.cols;
    if row >= frame.rows || col >= cols || frame.cells.len() != cols as usize * frame.rows as usize
    {
        return 0;
    }
    let limit = col.saturating_add(max_cols).min(cols);
    let base = row as usize * cols as usize;
    // Overwriting a wide character's tail orphans its head.
    if col > 0 && frame.cells[base + col as usize].attrs.has(Attrs::WIDE_TAIL) {
        frame.cells[base + col as usize - 1] = Cell::default();
    }
    let mut at = col;
    let mut last_head: Option<usize> = None;
    for ch in text.chars() {
        if ch.is_control() {
            continue;
        }
        let w = ch.width().unwrap_or(0) as u16;
        if w == 0 {
            // A mark joins the previous drawn character.
            if let Some(i) = last_head {
                let cluster = frame.cells[i].cluster;
                if cluster == 0 {
                    let mut t = frame.cells[i].ch.to_string();
                    t.push(ch);
                    frame.clusters.push(t);
                    frame.cells[i].cluster = (frame.clusters.len() - 1) as u32;
                } else if let Some(t) = frame.clusters.get_mut(cluster as usize) {
                    t.push(ch);
                }
            }
            continue;
        }
        if at + w > limit {
            break;
        }
        let i = base + at as usize;
        frame.cells[i] = Cell {
            ch,
            cluster: 0,
            fg: style.fg,
            bg: style.bg,
            attrs: Attrs(style.attrs),
        };
        if w == 2 {
            frame.cells[i + 1] = Cell {
                ch: '\0',
                cluster: 0,
                fg: style.fg,
                bg: style.bg,
                attrs: Attrs(style.attrs | Attrs::WIDE_TAIL),
            };
        }
        last_head = Some(i);
        at += w;
    }
    // A wide character cut off by the end of the text loses its orphan tail.
    if at < cols && frame.cells[base + at as usize].attrs.has(Attrs::WIDE_TAIL) {
        frame.cells[base + at as usize] = Cell::default();
    }
    at - col
}

/// Fills `cols` columns from `col` on `row` with blanks in `style`.
pub fn fill(frame: &mut Frame, row: u16, col: u16, cols: u16, style: Style) {
    let blank: String = " ".repeat(cols as usize);
    draw_text(frame, row, col, cols, &blank, style);
}

/// Draws the scrollback badge at the right end of the top row. Returns the
/// columns it covers (0 when it does not fit).
pub fn draw_badge(frame: &mut Frame, text: &str) -> u16 {
    let w: u16 = text
        .chars()
        .map(|c| c.width().unwrap_or(0) as u16)
        .sum::<u16>()
        .min(frame.cols);
    if w == 0 {
        return 0;
    }
    let col = frame.cols - w;
    draw_text(frame, 0, col, w, text, BADGE)
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: Style = Style {
        fg: Color::Indexed(1),
        bg: Color::Indexed(2),
        attrs: Attrs::BOLD,
    };

    fn row_text(f: &Frame, r: u16) -> String {
        (0..f.cols)
            .filter_map(|c| {
                let cell = f.cell(r, c)?;
                (!cell.attrs.has(Attrs::WIDE_TAIL)).then(|| f.text(cell))
            })
            .collect()
    }

    #[test]
    fn text_is_drawn_styled_and_clipped_to_the_width() {
        let mut f = Frame::blank(10, 2);
        assert_eq!(draw_text(&mut f, 1, 2, 4, "abcdef", S), 4);
        assert_eq!(row_text(&f, 1), "  abcd    ");
        let c = f.cell(1, 2).unwrap();
        assert_eq!((c.fg, c.bg), (S.fg, S.bg));
        assert!(c.attrs.has(Attrs::BOLD));
        // Row 0 untouched.
        assert_eq!(row_text(&f, 0), " ".repeat(10));
    }

    #[test]
    fn out_of_range_draws_nothing() {
        let mut f = Frame::blank(4, 1);
        assert_eq!(draw_text(&mut f, 1, 0, 4, "x", S), 0);
        assert_eq!(draw_text(&mut f, 0, 4, 4, "x", S), 0);
        assert_eq!(draw_text(&mut f, 0, 0, 0, "x", S), 0);
        assert_eq!(row_text(&f, 0), "    ");
    }

    #[test]
    fn wide_characters_take_two_cells_and_are_never_split_by_the_edge() {
        let mut f = Frame::blank(6, 1);
        assert_eq!(draw_text(&mut f, 0, 1, 4, "日本語", S), 4);
        assert_eq!(row_text(&f, 0), " 日本 ");
        assert!(f.cell(0, 2).unwrap().attrs.has(Attrs::WIDE_TAIL));
        // Clipped in the middle of a wide character: it is left out.
        let mut f = Frame::blank(6, 1);
        assert_eq!(draw_text(&mut f, 0, 0, 3, "a日本", S), 3);
        assert_eq!(row_text(&f, 0), "a日   ");
    }

    #[test]
    fn marks_join_the_character_before_them() {
        let mut f = Frame::blank(6, 1);
        assert_eq!(draw_text(&mut f, 0, 0, 6, "e\u{301}x", S), 2);
        assert_eq!(f.text(f.cell(0, 0).unwrap()), "e\u{301}");
        assert_eq!(f.cell(0, 1).unwrap().ch, 'x');
        // A second mark extends the same cluster.
        let mut f = Frame::blank(6, 1);
        draw_text(&mut f, 0, 0, 6, "a\u{301}\u{302}", S);
        assert_eq!(f.text(f.cell(0, 0).unwrap()), "a\u{301}\u{302}");
    }

    #[test]
    fn controls_are_skipped() {
        let mut f = Frame::blank(6, 1);
        assert_eq!(draw_text(&mut f, 0, 0, 6, "a\nb\x1b[c", S), 4);
        assert_eq!(row_text(&f, 0), "ab[c  ");
    }

    #[test]
    fn drawing_over_half_a_wide_character_blanks_the_other_half() {
        let mut f = Frame::blank(6, 1);
        draw_text(&mut f, 0, 0, 6, "日本", S);
        // Start on the tail of 日: its head goes.
        draw_text(&mut f, 0, 1, 1, "x", S);
        assert_eq!(f.cell(0, 0).unwrap(), &Cell::default());
        assert_eq!(f.cell(0, 1).unwrap().ch, 'x');
        // End before the tail of 本 (cols 2-3): drawing "y" at col 2 leaves
        // the tail at 3, which is cleared.
        draw_text(&mut f, 0, 2, 1, "y", S);
        assert_eq!(f.cell(0, 2).unwrap().ch, 'y');
        assert_eq!(f.cell(0, 3).unwrap(), &Cell::default());
    }

    #[test]
    fn fill_paints_blanks_in_a_style() {
        let mut f = Frame::blank(5, 1);
        fill(&mut f, 0, 1, 3, S);
        assert_eq!(f.cell(0, 0).unwrap().bg, Color::Default);
        assert_eq!(f.cell(0, 1).unwrap().bg, S.bg);
        assert_eq!(f.cell(0, 3).unwrap().bg, S.bg);
        assert_eq!(f.cell(0, 4).unwrap().bg, Color::Default);
    }

    #[test]
    fn the_badge_sits_at_the_right_of_the_top_row() {
        let mut f = Frame::blank(20, 3);
        let used = draw_badge(&mut f, " Scrollback ");
        assert_eq!(used, 12);
        assert_eq!(
            row_text(&f, 0),
            format!("{}{}", " ".repeat(8), " Scrollback ")
        );
        assert_eq!(f.cell(0, 8).unwrap().bg, BADGE.bg);
        assert_eq!(f.cell(0, 7).unwrap().bg, Color::Default);
        assert_eq!(row_text(&f, 1), " ".repeat(20));
        // Nothing to draw, or too wide: clipped to the row.
        assert_eq!(draw_badge(&mut f, ""), 0);
        let mut g = Frame::blank(4, 1);
        assert_eq!(draw_badge(&mut g, " Scrollback "), 4);
    }
}
