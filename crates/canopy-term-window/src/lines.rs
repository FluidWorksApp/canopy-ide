//! Selection over the whole transcript (scrollback and live screen): word and
//! line boundaries, multi-click counting, drag extension by word or line, and
//! the text a selection copies.
//!
//! Lines are *absolute* (see [`crate::viewport`]): 0 is the oldest scrollback
//! line, then the live screen. A selection stored this way keeps pointing at
//! the same text while output scrolls and while the view moves through
//! history. Columns are cell columns, as in [`crate::selection`].
//!
//! Soft wraps are not recorded in rows, so a wrapped long line copies as
//! several lines and a word cut by a wrap is two words. That is the same
//! limit as `selection::selection_text`.

use std::time::{Duration, Instant};

use canopy_term_core::frame::Attrs;
use canopy_term_core::Row;
use unicode_width::UnicodeWidthChar;

use crate::selection::Selection;

/// Line access over scrollback and the live screen.
pub trait Lines {
    /// Number of lines (scrollback plus live rows).
    fn total(&self) -> usize;
    /// Up to `count` lines from absolute line `start`; fewer at the end.
    fn fetch(&self, start: usize, count: usize) -> Vec<Row>;
    fn line(&self, abs: usize) -> Option<Row> {
        self.fetch(abs, 1).into_iter().next()
    }
}

/// Rows held in memory (tests, and anything that already has them).
impl Lines for Vec<Row> {
    fn total(&self) -> usize {
        self.len()
    }
    fn fetch(&self, start: usize, count: usize) -> Vec<Row> {
        self.iter().skip(start).take(count).cloned().collect()
    }
}

/// Characters, besides letters, digits and `_`, that belong to a word, so a
/// double-click takes a whole path, URL or option.
pub const WORD_EXTRA: &str = "-./~@%+:#";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Class {
    Space,
    Word,
    Punct,
}

fn base_char(row: &Row, col: usize) -> Option<char> {
    let cell = row.cells.get(col)?;
    if cell.cluster != 0 {
        if let Some(c) = row
            .clusters
            .get(cell.cluster as usize)
            .and_then(|t| t.chars().next())
        {
            return Some(c);
        }
    }
    Some(cell.ch)
}

/// The cell that owns `col`: a wide character's tail belongs to its head, and
/// a stray zero-width mark (not folded into a cluster) to the cell before it.
fn head_of(row: &Row, mut col: usize) -> usize {
    while col > 0 {
        let Some(cell) = row.cells.get(col) else {
            break;
        };
        let tail = cell.attrs.has(Attrs::WIDE_TAIL);
        let zero_width =
            cell.cluster == 0 && cell.ch != '\0' && cell.ch != ' ' && cell.ch.width() == Some(0);
        if tail || zero_width {
            col -= 1;
        } else {
            break;
        }
    }
    col
}

fn class_at(row: &Row, col: usize) -> Class {
    let col = head_of(row, col);
    let Some(cell) = row.cells.get(col) else {
        return Class::Space;
    };
    if cell.attrs.has(Attrs::HIDDEN) {
        return Class::Space;
    }
    match base_char(row, col) {
        None | Some('\0') => Class::Space,
        Some(c) if c.is_whitespace() => Class::Space,
        Some(c) if c.is_alphanumeric() || c == '_' || WORD_EXTRA.contains(c) => Class::Word,
        Some(_) => Class::Punct,
    }
}

/// The word under `col`, as inclusive columns `(start, end)`: the run of cells
/// of the same kind (word characters, other punctuation, or blanks), whole
/// wide characters and clusters included. `col` past the row clamps to its
/// last cell. An empty row gives `(0, 0)`.
pub fn word_range(row: &Row, col: u16) -> (u16, u16) {
    let n = row.cells.len();
    if n == 0 {
        return (0, 0);
    }
    let at = head_of(row, (col as usize).min(n - 1));
    let class = class_at(row, at);
    let mut start = at;
    while start > 0 && class_at(row, start - 1) == class {
        start -= 1;
    }
    start = head_of(row, start);
    let mut end = at;
    while end + 1 < n && class_at(row, end + 1) == class {
        end += 1;
    }
    (start as u16, end as u16)
}

/// The whole line, as inclusive columns.
pub fn line_range(row: &Row) -> (u16, u16) {
    (0, row.cells.len().saturating_sub(1) as u16)
}

/// A selection between two (absolute line, column) points, inclusive, as the
/// user made it: `anchor` is where it started, `head` where it is now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AbsSelection {
    pub anchor: (usize, u16),
    pub head: (usize, u16),
    /// Rectangular (block) selection instead of flowing text.
    pub block: bool,
}

impl AbsSelection {
    /// The two ends in reading order.
    pub fn ordered(&self) -> ((usize, u16), (usize, u16)) {
        if self.anchor <= self.head {
            (self.anchor, self.head)
        } else {
            (self.head, self.anchor)
        }
    }

    /// The selected columns on line `line` as `[start, end)` for a row `cols`
    /// wide, or `None`.
    pub fn cols_on(&self, line: usize, cols: u16) -> Option<(u16, u16)> {
        if cols == 0 {
            return None;
        }
        if self.block {
            let (l0, l1) = (
                self.anchor.0.min(self.head.0),
                self.anchor.0.max(self.head.0),
            );
            if line < l0 || line > l1 {
                return None;
            }
            let a = self.anchor.1.min(self.head.1);
            let b = self.anchor.1.max(self.head.1);
            return Some((a.min(cols), b.saturating_add(1).min(cols))).filter(|(s, e)| s < e);
        }
        let (a, b) = self.ordered();
        if line < a.0 || line > b.0 {
            return None;
        }
        let start = if line == a.0 { a.1 } else { 0 };
        let end = if line == b.0 {
            b.1.saturating_add(1)
        } else {
            cols
        };
        Some((start.min(cols), end.min(cols))).filter(|(s, e)| s < e)
    }

    /// The part of the selection that is on screen, as a screen-relative
    /// [`Selection`]: the screen shows absolute lines `top .. top + rows`.
    /// `None` when none of it is visible.
    pub fn to_screen(&self, top: usize, rows: u16, cols: u16) -> Option<Selection> {
        if rows == 0 || cols == 0 {
            return None;
        }
        let last = top + rows as usize - 1;
        let last_col = cols - 1;
        if self.block {
            let (l0, l1) = (
                self.anchor.0.min(self.head.0),
                self.anchor.0.max(self.head.0),
            );
            if l1 < top || l0 > last {
                return None;
            }
            let r0 = l0.max(top) - top;
            let r1 = l1.min(last) - top;
            let (c0, c1) = (
                self.anchor.1.min(self.head.1),
                self.anchor.1.max(self.head.1),
            );
            return Some(Selection {
                start: (r0 as u16, c0),
                end: (r1 as u16, c1),
                block: true,
            });
        }
        let (a, b) = self.ordered();
        if b.0 < top || a.0 > last {
            return None;
        }
        let start = if a.0 < top {
            (0, 0)
        } else {
            ((a.0 - top) as u16, a.1)
        };
        let end = if b.0 > last {
            (rows - 1, last_col)
        } else {
            ((b.0 - top) as u16, b.1)
        };
        Some(Selection {
            start,
            end,
            block: false,
        })
    }

    /// The same selection on a screen showing lines from `top`, moved to
    /// absolute lines (for a request that names screen cells).
    pub fn from_screen(sel: &Selection, top: usize) -> AbsSelection {
        AbsSelection {
            anchor: (top + sel.start.0 as usize, sel.start.1),
            head: (top + sel.end.0 as usize, sel.end.1),
            block: sel.block,
        }
    }
}

fn range_text(row: &Row, start: u16, end: u16) -> String {
    let mut out = String::new();
    let end = (end as usize).min(row.cells.len());
    for col in start as usize..end {
        let cell = &row.cells[col];
        if cell.attrs.has(Attrs::WIDE_TAIL) {
            continue;
        }
        if cell.attrs.has(Attrs::HIDDEN) || cell.ch == '\0' {
            out.push(' ');
            continue;
        }
        match row.clusters.get(cell.cluster as usize) {
            Some(t) if cell.cluster != 0 => out.push_str(t),
            _ => out.push(cell.ch),
        }
    }
    out
}

/// What a copy puts on the clipboard: each selected line's text with trailing
/// blanks removed, joined by `\n`. Lines outside the transcript are empty.
pub fn selection_text(sel: &AbsSelection, lines: &dyn Lines) -> String {
    let (first, last) = if sel.block {
        (sel.anchor.0.min(sel.head.0), sel.anchor.0.max(sel.head.0))
    } else {
        let (a, b) = sel.ordered();
        (a.0, b.0)
    };
    let total = lines.total();
    if first >= total {
        return String::new();
    }
    let last = last.min(total - 1);
    let rows = lines.fetch(first, last - first + 1);
    let mut out = Vec::with_capacity(rows.len());
    for (i, row) in rows.iter().enumerate() {
        let cols = row.cells.len().min(u16::MAX as usize) as u16;
        match sel.cols_on(first + i, cols) {
            Some((s, e)) => out.push(range_text(row, s, e).trim_end().to_string()),
            None => out.push(String::new()),
        }
    }
    out.join("\n")
}

/// How far a click-and-drag selects at a time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Granularity {
    Cell,
    Word,
    Line,
}

impl Granularity {
    /// The unit a click count selects: 1 a cell, 2 a word, 3 a line.
    pub fn for_clicks(count: u8) -> Granularity {
        match count {
            0 | 1 => Granularity::Cell,
            2 => Granularity::Word,
            _ => Granularity::Line,
        }
    }
}

/// Counts clicks in quick succession on the same cell: 1, 2, 3, then 1 again.
#[derive(Clone, Copy, Debug)]
pub struct ClickTracker {
    last: Option<(Instant, (u16, u16), u8)>,
    interval: Duration,
}

impl Default for ClickTracker {
    fn default() -> Self {
        ClickTracker {
            last: None,
            interval: Duration::from_millis(400),
        }
    }
}

impl ClickTracker {
    /// A press at screen cell `cell` at time `now`; returns the click count.
    pub fn register(&mut self, now: Instant, cell: (u16, u16)) -> u8 {
        let count = match self.last {
            Some((t, c, n)) if c == cell && now.saturating_duration_since(t) <= self.interval => {
                if n >= 3 {
                    1
                } else {
                    n + 1
                }
            }
            _ => 1,
        };
        self.last = Some((now, cell, count));
        count
    }

    /// Forget the sequence (the view moved, so the same cell is other text).
    pub fn reset(&mut self) {
        self.last = None;
    }
}

/// An in-progress mouse selection: the unit that was pressed, and how far
/// dragging extends it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SelectionDrag {
    pub gran: Granularity,
    start: (usize, u16),
    end: (usize, u16),
}

fn unit(gran: Granularity, lines: &dyn Lines, at: (usize, u16)) -> ((usize, u16), (usize, u16)) {
    let range = match gran {
        Granularity::Cell => (at.1, at.1),
        Granularity::Word => lines
            .line(at.0)
            .map_or((at.1, at.1), |r| word_range(&r, at.1)),
        Granularity::Line => lines.line(at.0).map_or((0, at.1), |r| line_range(&r)),
    };
    ((at.0, range.0), (at.0, range.1))
}

impl SelectionDrag {
    /// A press at `at` selecting by `gran`.
    pub fn new(gran: Granularity, lines: &dyn Lines, at: (usize, u16)) -> Self {
        let (start, end) = unit(gran, lines, at);
        SelectionDrag { gran, start, end }
    }

    /// The selection from the pressed unit to the unit under the pointer at
    /// `to`: dragging backwards keeps the far end of the pressed unit.
    pub fn selection_to(&self, lines: &dyn Lines, to: (usize, u16), block: bool) -> AbsSelection {
        let (ustart, uend) = unit(self.gran, lines, to);
        if to < self.start {
            AbsSelection {
                anchor: self.end,
                head: ustart,
                block,
            }
        } else {
            AbsSelection {
                anchor: self.start,
                head: uend,
                block,
            }
        }
    }

    /// The selection of just the pressed unit (what a double or triple click
    /// selects before any drag).
    pub fn selection(&self, block: bool) -> AbsSelection {
        AbsSelection {
            anchor: self.start,
            head: self.end,
            block,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_term_core::frame::Cell;

    fn row(text: &str, cols: usize) -> Row {
        let mut cells = vec![Cell::default(); cols];
        let mut clusters = vec![String::new()];
        let mut col = 0;
        let mut chars = text.chars().peekable();
        while let Some(c) = chars.next() {
            if col >= cols {
                break;
            }
            let w = c.width().unwrap_or(0);
            if w == 0 {
                continue;
            }
            // Fold following zero-width marks into a cluster, as the engine does.
            let mut cluster = String::new();
            while let Some(&m) = chars.peek() {
                if m.width() == Some(0) {
                    if cluster.is_empty() {
                        cluster.push(c);
                    }
                    cluster.push(m);
                    chars.next();
                } else {
                    break;
                }
            }
            let idx = if cluster.is_empty() {
                0
            } else {
                clusters.push(cluster);
                (clusters.len() - 1) as u32
            };
            cells[col] = Cell {
                ch: c,
                cluster: idx,
                ..Cell::default()
            };
            if w == 2 && col + 1 < cols {
                cells[col + 1] = Cell {
                    ch: '\0',
                    attrs: Attrs(Attrs::WIDE_TAIL),
                    ..Cell::default()
                };
            }
            col += w;
        }
        Row { cells, clusters }
    }

    #[test]
    fn a_word_is_a_run_of_word_characters_including_path_punctuation() {
        let r = row("cat /usr/local/bin/x.sh  --flag=1", 40);
        assert_eq!(word_range(&r, 1), (0, 2));
        assert_eq!(word_range(&r, 4), (4, 22));
        assert_eq!(word_range(&r, 22), (4, 22));
        assert_eq!(
            word_range(&r, 3),
            (3, 3),
            "a blank selects the run of blanks"
        );
        assert_eq!(word_range(&r, 24), (23, 24));
        assert_eq!(word_range(&r, 26), (25, 30), "dashes are word characters");
        assert_eq!(word_range(&r, 31), (31, 31), "but '=' is not");
        assert_eq!(word_range(&r, 32), (32, 32));
    }

    #[test]
    fn punctuation_runs_are_their_own_word() {
        let r = row("a,b ((x))", 20);
        assert_eq!(word_range(&r, 1), (1, 1));
        assert_eq!(word_range(&r, 5), (4, 5));
        assert_eq!(word_range(&r, 6), (6, 6));
        assert_eq!(word_range(&r, 7), (7, 8));
    }

    #[test]
    fn a_wide_character_is_selected_whole_from_either_half() {
        let r = row("ab日本語cd", 12);
        // 'a'0 'b'1 日2-3 本4-5 語6-7 'c'8 'd'9. CJK letters are alphanumeric.
        assert_eq!(word_range(&r, 3), (0, 9));
        let r = row("日 本", 8);
        assert_eq!(word_range(&r, 1), (0, 1));
        assert_eq!(word_range(&r, 0), (0, 1));
        assert_eq!(word_range(&r, 3), (3, 4));
        // Starting a word on a tail snaps to the head.
        let r = row("x 日", 8);
        assert_eq!(word_range(&r, 3), (2, 3));
    }

    #[test]
    fn combining_marks_stay_with_their_base() {
        // "cafe" with a combining acute on the e, as a cluster cell.
        let r = row("cafe\u{301} ok", 12);
        assert_eq!(word_range(&r, 3), (0, 3));
        assert_eq!(word_range(&r, 0), (0, 3));
        assert_eq!(word_range(&r, 5), (5, 6));
        // A zero-width mark that is its own cell joins the cell before it.
        let mut r = row("ab cd", 8);
        r.cells[2] = Cell {
            ch: '\u{301}',
            ..Cell::default()
        };
        assert_eq!(word_range(&r, 2), (0, 4));
        assert_eq!(word_range(&r, 0), (0, 4));
    }

    #[test]
    fn edges_and_empty_rows_do_not_panic() {
        let r = row("abc", 3);
        assert_eq!(word_range(&r, 99), (0, 2));
        assert_eq!(word_range(&Row::default(), 5), (0, 0));
        assert_eq!(line_range(&r), (0, 2));
        assert_eq!(line_range(&Row::default()), (0, 0));
        let blank = row("", 5);
        assert_eq!(word_range(&blank, 2), (0, 4));
    }

    #[test]
    fn hidden_cells_do_not_leak_into_a_word() {
        let mut r = row("ab", 4);
        r.cells[1].attrs = Attrs(Attrs::HIDDEN);
        assert_eq!(word_range(&r, 0), (0, 0));
    }

    fn sel(a: (usize, u16), h: (usize, u16)) -> AbsSelection {
        AbsSelection {
            anchor: a,
            head: h,
            block: false,
        }
    }

    #[test]
    fn selection_text_spans_scrollback_and_live_lines() {
        let lines: Vec<Row> = ["old one", "old two", "live a", "live b"]
            .iter()
            .map(|l| row(l, 10))
            .collect();
        let s = sel((1, 4), (3, 3));
        assert_eq!(selection_text(&s, &lines), "two\nlive a\nlive");
        // Backwards drag, same text.
        let b = sel((3, 3), (1, 4));
        assert_eq!(selection_text(&b, &lines), "two\nlive a\nlive");
        // Past the end clamps; before nothing returns empty.
        assert_eq!(selection_text(&sel((3, 5), (99, 0)), &lines), "b");
        assert_eq!(selection_text(&sel((50, 0), (60, 0)), &lines), "");
    }

    #[test]
    fn block_selection_takes_the_same_columns_on_every_line() {
        let lines: Vec<Row> = ["abcdef", "ghijkl", "mnopqr"]
            .iter()
            .map(|l| row(l, 6))
            .collect();
        let s = AbsSelection {
            anchor: (2, 3),
            head: (0, 1),
            block: true,
        };
        assert_eq!(selection_text(&s, &lines), "bcd\nhij\nnop");
    }

    #[test]
    fn copy_keeps_wide_characters_and_clusters_once_and_drops_trailing_blanks() {
        let lines = vec![row("日e\u{301}x   ", 10)];
        assert_eq!(selection_text(&sel((0, 0), (0, 9)), &lines), "日e\u{301}x");
    }

    #[test]
    fn columns_and_screen_conversion() {
        let s = sel((10, 70), (12, 5));
        assert_eq!(s.cols_on(10, 80), Some((70, 80)));
        assert_eq!(s.cols_on(11, 80), Some((0, 80)));
        assert_eq!(s.cols_on(12, 80), Some((0, 6)));
        assert_eq!(s.cols_on(13, 80), None);
        assert_eq!(s.cols_on(10, 0), None);
        // Screen shows lines 11..35: the selection's first line is above it.
        let v = s.to_screen(11, 24, 80).unwrap();
        assert_eq!((v.start, v.end), ((0, 0), (1, 5)));
        // Screen shows lines 0..4: the selection starts below it... partly.
        let v = s.to_screen(8, 3, 80).unwrap();
        assert_eq!((v.start, v.end), ((2, 70), (2, 79)));
        // Entirely above or below.
        assert_eq!(s.to_screen(13, 24, 80), None);
        assert_eq!(s.to_screen(0, 10, 80), None);
        assert_eq!(s.to_screen(0, 0, 80), None);
        // It round-trips through screen cells.
        let top = 7;
        let back = AbsSelection::from_screen(
            &Selection {
                start: (3, 4),
                end: (5, 6),
                block: false,
            },
            top,
        );
        assert_eq!((back.anchor, back.head), ((10, 4), (12, 6)));
    }

    #[test]
    fn block_selection_clips_to_the_visible_lines() {
        let s = AbsSelection {
            anchor: (5, 8),
            head: (20, 2),
            block: true,
        };
        let v = s.to_screen(10, 6, 80).unwrap();
        assert_eq!((v.start, v.end, v.block), ((0, 2), (5, 8), true));
        assert_eq!(s.to_screen(30, 6, 80), None);
    }

    #[test]
    fn click_counts_cycle_and_reset_on_time_or_place() {
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        let mut c = ClickTracker::default();
        assert_eq!(c.register(ms(0), (3, 4)), 1);
        assert_eq!(c.register(ms(200), (3, 4)), 2);
        assert_eq!(c.register(ms(350), (3, 4)), 3);
        assert_eq!(c.register(ms(500), (3, 4)), 1, "a fourth click starts over");
        assert_eq!(c.register(ms(600), (3, 5)), 1, "another cell");
        assert_eq!(c.register(ms(1200), (3, 5)), 1, "too slow");
        assert_eq!(c.register(ms(1300), (3, 5)), 2);
        c.reset();
        assert_eq!(c.register(ms(1350), (3, 5)), 1);
        assert_eq!(Granularity::for_clicks(1), Granularity::Cell);
        assert_eq!(Granularity::for_clicks(2), Granularity::Word);
        assert_eq!(Granularity::for_clicks(3), Granularity::Line);
    }

    #[test]
    fn double_click_selects_a_word_and_dragging_extends_by_words() {
        let lines: Vec<Row> = vec![row("alpha beta gamma", 20), row("delta epsilon", 20)];
        let d = SelectionDrag::new(Granularity::Word, &lines, (0, 7));
        assert_eq!(selection_text(&d.selection(false), &lines), "beta");
        // Drag forward into the next word, then the next line.
        let s = d.selection_to(&lines, (0, 12), false);
        assert_eq!(selection_text(&s, &lines), "beta gamma");
        let s = d.selection_to(&lines, (1, 2), false);
        assert_eq!(selection_text(&s, &lines), "beta gamma\ndelta");
        // Backwards keeps the whole pressed word.
        let s = d.selection_to(&lines, (0, 1), false);
        assert_eq!(selection_text(&s, &lines), "alpha beta");
        // Back inside the pressed word: just the word.
        let s = d.selection_to(&lines, (0, 8), false);
        assert_eq!(selection_text(&s, &lines), "beta");
    }

    #[test]
    fn triple_click_selects_a_line_and_dragging_extends_by_lines() {
        let lines: Vec<Row> = vec![row("one", 8), row("two two", 8), row("three", 8)];
        let d = SelectionDrag::new(Granularity::Line, &lines, (1, 3));
        assert_eq!(selection_text(&d.selection(false), &lines), "two two");
        let s = d.selection_to(&lines, (2, 0), false);
        assert_eq!(selection_text(&s, &lines), "two two\nthree");
        let s = d.selection_to(&lines, (0, 7), false);
        assert_eq!(selection_text(&s, &lines), "one\ntwo two");
    }

    #[test]
    fn a_plain_drag_selects_cells() {
        let lines: Vec<Row> = vec![row("hello world", 12)];
        let d = SelectionDrag::new(Granularity::Cell, &lines, (0, 2));
        let s = d.selection_to(&lines, (0, 6), false);
        assert_eq!(selection_text(&s, &lines), "llo w");
        let s = d.selection_to(&lines, (0, 0), false);
        assert_eq!(selection_text(&s, &lines), "hel");
    }

    #[test]
    fn a_word_drag_over_a_missing_line_does_not_panic() {
        let lines: Vec<Row> = vec![row("abc def", 8)];
        let d = SelectionDrag::new(Granularity::Word, &lines, (0, 1));
        let s = d.selection_to(&lines, (9, 3), false);
        assert_eq!(s.head, (9, 3));
        assert_eq!(selection_text(&s, &lines), "abc def".to_string());
    }
}
