//! The scrollback viewport: which lines of history the window shows, and the
//! frame it draws for them.
//!
//! Lines are addressed two ways. An *absolute* line counts from the oldest
//! scrollback line (0) through the last history line (`total - 1`), then the
//! live screen's rows (`total` ..). History only ever appends at its end, so
//! an absolute line keeps meaning the same text while output scrolls (until
//! the engine's scrollback cap trims the oldest lines). The *offset* is how
//! many lines the view sits above the live screen: 0 is live, `total` is the
//! top of history.
//!
//! Everything here is pure: the window asks the source for the history rows
//! [`history_span`] names, and [`scrolled_view`] builds the frame to draw.

use canopy_term_core::frame::{Cell, Frame};
use canopy_term_core::Row;

/// Lines one wheel notch scrolls (a trackpad scrolls a line per cell height of
/// movement instead).
pub const WHEEL_LINES_PER_NOTCH: i64 = 3;
/// Most lines one wheel event scrolls or sends as arrow keys.
pub const MAX_WHEEL_LINES: usize = 200;
/// Most arrow keys one wheel event sends on the alternate screen.
pub const MAX_WHEEL_ARROWS: usize = 30;

/// Where the view sits above the live screen.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Viewport {
    offset: usize,
}

impl Viewport {
    /// Lines above the live screen; 0 is live.
    pub fn offset(&self) -> usize {
        self.offset
    }

    pub fn is_live(&self) -> bool {
        self.offset == 0
    }

    /// Keeps the offset within `total` history lines. True if it changed.
    pub fn clamp(&mut self, total: usize) -> bool {
        if self.offset > total {
            self.offset = total;
            true
        } else {
            false
        }
    }

    /// Moves by `lines` (positive: toward older lines). True if the offset
    /// changed (false at either end).
    pub fn scroll_by(&mut self, lines: i64, total: usize) -> bool {
        let before = self.offset;
        let moved = if lines >= 0 {
            before.saturating_add(lines as usize)
        } else {
            before.saturating_sub(lines.unsigned_abs() as usize)
        };
        self.offset = moved.min(total);
        self.offset != before
    }

    /// One page toward older (`up`) or newer lines: the screen height less one
    /// line of overlap, so the eye keeps its place.
    pub fn page(&mut self, up: bool, rows: u16, total: usize) -> bool {
        let page = (rows as i64 - 1).max(1);
        self.scroll_by(if up { page } else { -page }, total)
    }

    pub fn to_top(&mut self, total: usize) -> bool {
        let before = self.offset;
        self.offset = total;
        before != total
    }

    /// Back to the live screen. True if it was scrolled.
    pub fn to_bottom(&mut self) -> bool {
        let was = self.offset != 0;
        self.offset = 0;
        was
    }

    /// History grew from `prev_total` to `total` lines while the view stayed
    /// still: move the offset with it so the same text stays on screen. A
    /// live view stays live.
    pub fn follow(&mut self, prev_total: usize, total: usize) {
        if self.offset > 0 && total > prev_total {
            self.offset += total - prev_total;
        }
        self.clamp(total);
    }

    /// Scrolls just enough to show absolute line `abs`, centring it when it
    /// was off screen. Lines of the live screen are shown by going live.
    /// True if the offset changed.
    pub fn reveal(&mut self, abs: usize, total: usize, rows: u16) -> bool {
        let rows = rows.max(1) as usize;
        let top = total.saturating_sub(self.offset.min(total));
        if abs >= top && abs < top + rows {
            return false;
        }
        let new_top = abs.saturating_sub(rows / 2).min(total);
        let before = self.offset;
        self.offset = total - new_top;
        self.offset != before
    }

    /// The absolute line shown on screen row `row`.
    pub fn abs_line(&self, row: u16, total: usize) -> usize {
        total.saturating_sub(self.offset.min(total)) + row as usize
    }

    /// The screen row showing absolute line `abs`, if it is on screen.
    pub fn row_of(&self, abs: usize, total: usize, rows: u16) -> Option<u16> {
        let top = total.saturating_sub(self.offset.min(total));
        if abs < top {
            return None;
        }
        let r = abs - top;
        (r < rows as usize).then_some(r as u16)
    }
}

/// The history rows a view at `offset` needs: (first absolute line, count).
pub fn history_span(total: usize, offset: usize, rows: u16) -> (usize, usize) {
    let offset = offset.min(total);
    (total - offset, offset.min(rows as usize))
}

/// The frame to draw when the view is `offset` lines above the live screen:
/// the newest `rows - offset` rows of `live` pushed down, with `history` (the
/// rows [`history_span`] named, oldest first) above them. A missing history
/// row is drawn blank. The cursor is hidden (it is on the live screen), the
/// frame is fully damaged, and it says it is scrolled back. With nothing to
/// scroll (`offset` 0 or no history) it is a copy of `live`.
pub fn scrolled_view(live: &Frame, history: &[Row], total: usize, offset: usize) -> Frame {
    let offset = offset.min(total);
    let (cols, rows) = (live.cols as usize, live.rows as usize);
    if offset == 0 || cols == 0 || rows == 0 || live.cells.len() != cols * rows {
        return live.clone();
    }
    let hist_rows = offset.min(rows);
    let mut out = live.clone();
    let mut cells = vec![Cell::default(); cols * rows];
    for r in hist_rows..rows {
        let src = (r - offset) * cols;
        cells[r * cols..(r + 1) * cols].copy_from_slice(&live.cells[src..src + cols]);
    }
    for (r, row) in history.iter().take(hist_rows).enumerate() {
        for c in 0..cols {
            let mut cell = row.cells.get(c).copied().unwrap_or_default();
            if cell.cluster != 0 {
                match row.clusters.get(cell.cluster as usize) {
                    Some(text) => {
                        out.clusters.push(text.clone());
                        cell.cluster = (out.clusters.len() - 1) as u32;
                    }
                    None => cell.cluster = 0,
                }
            }
            cells[r * cols + c] = cell;
        }
    }
    out.cells = cells;
    out.cursor.visible = false;
    out.viewport_offset = offset.min(u32::MAX as usize) as u32;
    out.scrolled_back = true;
    out.damage.full = true;
    out
}

/// A history row's cells as a frame row, for text that is on the live screen.
pub fn row_from_frame(frame: &Frame, row: u16) -> Row {
    let cols = frame.cols as usize;
    let start = row as usize * cols;
    let cells = frame
        .cells
        .get(start..start + cols)
        .map(|c| c.to_vec())
        .unwrap_or_default();
    Row {
        cells,
        clusters: frame.clusters.clone(),
    }
}

/// Text for the "you are scrolled back" badge, shortened to fit `cols`.
pub fn indicator_text(offset: usize, total: usize, cols: u16) -> String {
    let long = format!(" Scrollback: {offset} of {total} lines up (Shift+End: live) ");
    let short = format!(" Scrollback {offset}/{total} ");
    let tiny = " Scrollback ".to_string();
    [long, short, tiny]
        .into_iter()
        .find(|t| t.chars().count() <= cols as usize)
        .unwrap_or_default()
}

/// What the wheel does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WheelAction {
    /// Nothing to do.
    None,
    /// The program asked for the mouse: report `steps` (positive is up).
    Report(i32),
    /// Alternate screen without mouse reporting: this many Up (`up`) or Down
    /// arrow keys.
    Arrows { up: bool, count: usize },
    /// Scroll the viewport by this many lines (positive: toward older).
    Scroll(i64),
}

/// Routes whole wheel `steps` (positive is wheel up). `reporting` is whether
/// the program gets mouse events (it asked, and Shift is not held);
/// `line_delta` is a notch wheel (a trackpad's pixel deltas already count one
/// step per line).
pub fn wheel_action(
    alt_screen: bool,
    reporting: bool,
    steps: i32,
    line_delta: bool,
) -> WheelAction {
    if steps == 0 {
        return WheelAction::None;
    }
    if reporting {
        return WheelAction::Report(steps);
    }
    let lines = steps as i64 * if line_delta { WHEEL_LINES_PER_NOTCH } else { 1 };
    if alt_screen {
        return WheelAction::Arrows {
            up: lines > 0,
            count: (lines.unsigned_abs() as usize).min(MAX_WHEEL_ARROWS),
        };
    }
    let cap = MAX_WHEEL_LINES as i64;
    WheelAction::Scroll(lines.clamp(-cap, cap))
}

/// Keys the window itself uses to move through history.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScrollKey {
    PageUp,
    PageDown,
    Home,
    End,
}

/// What a scroll key does to the viewport.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScrollCmd {
    PageUp,
    PageDown,
    Top,
    Bottom,
}

/// Whether `key` scrolls the view (and is not sent to the program).
///
/// * Shift+PageUp / Shift+PageDown / Shift+Home / Shift+End always scroll on
///   the primary screen.
/// * Plain PageUp / PageDown scroll only while the view is already scrolled
///   back, so Page Down returns to the live screen; while live they go to the
///   program (readline, less on the primary screen, ...).
/// * Any other modifier, or the alternate screen (no scrollback there), leaves
///   the key to the program.
pub fn scroll_command(
    key: ScrollKey,
    shift: bool,
    other_mods: bool,
    alt_screen: bool,
    scrolled_back: bool,
) -> Option<ScrollCmd> {
    if alt_screen || other_mods {
        return None;
    }
    match key {
        ScrollKey::PageUp if shift || scrolled_back => Some(ScrollCmd::PageUp),
        ScrollKey::PageDown if shift || scrolled_back => Some(ScrollCmd::PageDown),
        ScrollKey::Home if shift => Some(ScrollCmd::Top),
        ScrollKey::End if shift => Some(ScrollCmd::Bottom),
        _ => None,
    }
}

/// Lines to scroll while a selection drag is past the top or bottom edge of
/// the grid (positive: toward older lines, for a pointer above the grid):
/// one line at the edge, more the farther out, at most 5.
pub fn edge_scroll(y: f64, height_px: f64, cell_h: u32) -> i64 {
    let ch = cell_h.max(1) as f64;
    if y.is_nan() {
        return 0;
    }
    if y < 0.0 {
        return (1.0 + (-y / ch).floor()).min(5.0) as i64;
    }
    if y >= height_px {
        return -((1.0 + ((y - height_px) / ch).floor()).min(5.0) as i64);
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_term_core::frame::Attrs;

    fn live(lines: &[&str], cols: u16) -> Frame {
        let mut f = Frame::blank(cols, lines.len() as u16);
        for (r, line) in lines.iter().enumerate() {
            for (c, ch) in line.chars().enumerate() {
                f.cells[r * cols as usize + c].ch = ch;
            }
        }
        f.cursor.visible = true;
        f.cursor.row = lines.len() as u16 - 1;
        f
    }

    fn hist(line: &str, cols: usize) -> Row {
        let mut cells = vec![Cell::default(); cols];
        for (c, ch) in line.chars().enumerate() {
            cells[c].ch = ch;
        }
        Row {
            cells,
            clusters: vec![String::new()],
        }
    }

    fn row_str(f: &Frame, r: u16) -> String {
        (0..f.cols)
            .map(|c| f.cell(r, c).unwrap().ch)
            .collect::<String>()
            .trim_end()
            .to_string()
    }

    #[test]
    fn scrolling_clamps_at_both_ends_and_reports_change() {
        let mut v = Viewport::default();
        assert!(v.is_live());
        assert!(!v.scroll_by(-5, 100), "already at the bottom");
        assert!(v.scroll_by(10, 100));
        assert_eq!(v.offset(), 10);
        assert!(v.scroll_by(500, 100));
        assert_eq!(v.offset(), 100);
        assert!(!v.scroll_by(1, 100), "already at the top");
        assert!(v.scroll_by(-30, 100));
        assert_eq!(v.offset(), 70);
        assert!(v.scroll_by(i64::MIN + 1, 100));
        assert!(v.is_live());
        // With no history nothing moves.
        assert!(!v.scroll_by(5, 0));
    }

    #[test]
    fn a_page_is_the_screen_less_one_line() {
        let mut v = Viewport::default();
        assert!(v.page(true, 24, 1000));
        assert_eq!(v.offset(), 23);
        assert!(v.page(true, 24, 1000));
        assert_eq!(v.offset(), 46);
        assert!(v.page(false, 24, 1000));
        assert_eq!(v.offset(), 23);
        // A one-row screen still moves a line.
        let mut v = Viewport::default();
        assert!(v.page(true, 1, 10));
        assert_eq!(v.offset(), 1);
    }

    #[test]
    fn top_bottom_and_clamp() {
        let mut v = Viewport::default();
        assert!(v.to_top(40));
        assert_eq!(v.offset(), 40);
        assert!(!v.to_top(40));
        assert!(v.clamp(25));
        assert_eq!(v.offset(), 25);
        assert!(!v.clamp(25));
        assert!(v.to_bottom());
        assert!(!v.to_bottom());
    }

    #[test]
    fn new_output_keeps_a_scrolled_view_on_the_same_text() {
        let mut v = Viewport::default();
        v.scroll_by(10, 100);
        v.follow(100, 103);
        assert_eq!(
            v.offset(),
            13,
            "three more lines below, so three further up"
        );
        // A live view stays live.
        let mut live = Viewport::default();
        live.follow(100, 130);
        assert!(live.is_live());
        // History shrinking (resize reflow) clamps.
        v.follow(103, 8);
        assert_eq!(v.offset(), 8);
        // Same size: unchanged.
        v.follow(8, 8);
        assert_eq!(v.offset(), 8);
    }

    #[test]
    fn reveal_leaves_visible_lines_and_centres_others() {
        let mut v = Viewport::default();
        v.scroll_by(10, 100);
        // View shows absolute 90..114 on a 24-row screen.
        assert!(!v.reveal(95, 100, 24));
        assert_eq!(v.offset(), 10);
        assert!(v.reveal(20, 100, 24));
        // Line 20 centred: top = 20 - 12 = 8, offset = 92.
        assert_eq!(v.offset(), 92);
        assert_eq!(v.row_of(20, 100, 24), Some(12));
        // A line on the live screen goes live when it is below the view.
        assert!(v.reveal(110, 100, 24));
        assert_eq!(v.offset(), 100 - 98);
        // Near the very top the view cannot centre.
        assert!(v.reveal(1, 100, 24));
        assert_eq!(v.offset(), 100);
        // Beyond the live screen clamps at live.
        assert!(v.reveal(5000, 100, 24));
        assert!(v.is_live());
    }

    #[test]
    fn rows_and_absolute_lines_convert_both_ways() {
        let mut v = Viewport::default();
        assert_eq!(v.abs_line(0, 50), 50);
        assert_eq!(v.row_of(50, 50, 24), Some(0));
        v.scroll_by(5, 50);
        assert_eq!(v.abs_line(0, 50), 45);
        assert_eq!(v.abs_line(5, 50), 50);
        assert_eq!(v.row_of(44, 50, 24), None);
        assert_eq!(v.row_of(45, 50, 24), Some(0));
        assert_eq!(v.row_of(68, 50, 24), Some(23));
        assert_eq!(v.row_of(69, 50, 24), None);
    }

    #[test]
    fn the_history_a_view_needs() {
        assert_eq!(history_span(100, 0, 24), (100, 0));
        assert_eq!(history_span(100, 5, 24), (95, 5));
        assert_eq!(history_span(100, 50, 24), (50, 24));
        assert_eq!(history_span(10, 50, 24), (0, 10));
    }

    #[test]
    fn a_scrolled_view_pushes_the_live_screen_down_and_hides_the_cursor() {
        let f = live(&["l0", "l1", "l2", "l3"], 6);
        let h = [hist("h8", 6), hist("h9", 6)];
        let v = scrolled_view(&f, &h, 10, 2);
        assert_eq!(row_str(&v, 0), "h8");
        assert_eq!(row_str(&v, 1), "h9");
        assert_eq!(row_str(&v, 2), "l0");
        assert_eq!(row_str(&v, 3), "l1");
        assert!(!v.cursor.visible);
        assert!(v.scrolled_back);
        assert_eq!(v.viewport_offset, 2);
        assert!(v.damage.full);
        assert_eq!(v.seq, f.seq);
        // The live frame is untouched.
        assert_eq!(row_str(&f, 0), "l0");
        assert!(f.cursor.visible);
        assert!(!f.scrolled_back);
    }

    #[test]
    fn a_view_taller_than_the_screen_shows_only_history() {
        let f = live(&["l0", "l1"], 4);
        let h = [hist("a", 4), hist("b", 4)];
        let v = scrolled_view(&f, &h, 10, 7);
        assert_eq!((row_str(&v, 0), row_str(&v, 1)), ("a".into(), "b".into()));
        assert_eq!(v.viewport_offset, 7);
    }

    #[test]
    fn missing_or_short_history_rows_draw_blank_and_offset_is_clamped() {
        let f = live(&["l0", "l1", "l2"], 4);
        let v = scrolled_view(&f, &[hist("a", 2)], 2, 9);
        // Offset clamped to the 2 lines of history; only one row was supplied.
        assert_eq!(v.viewport_offset, 2);
        assert_eq!(row_str(&v, 0), "a");
        assert_eq!(row_str(&v, 1), "");
        assert_eq!(row_str(&v, 2), "l0");
    }

    #[test]
    fn no_offset_or_no_history_is_a_plain_copy() {
        let f = live(&["x"], 3);
        assert_eq!(scrolled_view(&f, &[], 5, 0), f);
        assert_eq!(scrolled_view(&f, &[], 0, 4), f);
    }

    #[test]
    fn history_clusters_are_remapped_into_the_frames_table() {
        let mut f = live(&["l0", "l1"], 4);
        f.clusters.push("x\u{301}".into());
        f.cells[0] = Cell {
            ch: 'x',
            cluster: 1,
            ..Cell::default()
        };
        let mut row = hist("ab", 4);
        row.clusters.push("e\u{301}".into());
        row.cells[1] = Cell {
            ch: 'e',
            cluster: 1,
            ..Cell::default()
        };
        row.cells[2] = Cell {
            ch: '日',
            ..Cell::default()
        };
        row.cells[3] = Cell {
            ch: '\0',
            attrs: Attrs(Attrs::WIDE_TAIL),
            ..Cell::default()
        };
        let v = scrolled_view(&f, &[row], 3, 1);
        assert_eq!(v.text(&v.cells[1]), "e\u{301}");
        assert!(v.cells[3].attrs.has(Attrs::WIDE_TAIL));
        // The live row that moved down still reads its own cluster.
        assert_eq!(v.text(&v.cells[4]), "x\u{301}");
    }

    #[test]
    fn a_frame_row_converts_to_a_history_style_row() {
        let mut f = live(&["ab", "cd"], 3);
        f.clusters.push("z".into());
        let r = row_from_frame(&f, 1);
        assert_eq!(r.cells.len(), 3);
        assert_eq!(r.text(), "cd");
        assert!(row_from_frame(&f, 9).cells.is_empty());
    }

    #[test]
    fn the_badge_shortens_to_fit() {
        assert!(indicator_text(12, 340, 80).contains("12 of 340"));
        let mid = indicator_text(12, 340, 20);
        assert!(mid.contains("12/340") && mid.chars().count() <= 20);
        assert_eq!(indicator_text(12, 340, 12), " Scrollback ");
        assert_eq!(indicator_text(12, 340, 4), "");
    }

    #[test]
    fn the_wheel_follows_the_mouse_mode_the_screen_and_the_device() {
        // The program asked for the mouse: it gets it, on either screen.
        assert_eq!(wheel_action(false, true, 2, true), WheelAction::Report(2));
        assert_eq!(wheel_action(true, true, -1, false), WheelAction::Report(-1));
        // Primary screen: scrollback, three lines a notch, one a trackpad line.
        assert_eq!(wheel_action(false, false, 2, true), WheelAction::Scroll(6));
        assert_eq!(
            wheel_action(false, false, -3, false),
            WheelAction::Scroll(-3)
        );
        // Alternate screen without the mouse: arrow keys.
        assert_eq!(
            wheel_action(true, false, 1, true),
            WheelAction::Arrows { up: true, count: 3 }
        );
        assert_eq!(
            wheel_action(true, false, -2, false),
            WheelAction::Arrows {
                up: false,
                count: 2
            }
        );
        // Caps and the empty case.
        assert_eq!(wheel_action(false, false, 0, true), WheelAction::None);
        assert_eq!(
            wheel_action(false, false, 1000, true),
            WheelAction::Scroll(MAX_WHEEL_LINES as i64)
        );
        assert_eq!(
            wheel_action(true, false, 1000, true),
            WheelAction::Arrows {
                up: true,
                count: MAX_WHEEL_ARROWS
            }
        );
    }

    #[test]
    fn scroll_keys_only_take_over_where_scrollback_exists() {
        use ScrollCmd as C;
        use ScrollKey as K;
        // Shift+PageUp enters scrollback from live; Shift+End leaves it.
        assert_eq!(
            scroll_command(K::PageUp, true, false, false, false),
            Some(C::PageUp)
        );
        assert_eq!(
            scroll_command(K::PageDown, true, false, false, true),
            Some(C::PageDown)
        );
        assert_eq!(
            scroll_command(K::Home, true, false, false, false),
            Some(C::Top)
        );
        assert_eq!(
            scroll_command(K::End, true, false, false, true),
            Some(C::Bottom)
        );
        // Plain PageUp/PageDown belong to the program until scrolled back.
        assert_eq!(scroll_command(K::PageUp, false, false, false, false), None);
        assert_eq!(
            scroll_command(K::PageDown, false, false, false, false),
            None
        );
        assert_eq!(
            scroll_command(K::PageUp, false, false, false, true),
            Some(C::PageUp)
        );
        assert_eq!(
            scroll_command(K::PageDown, false, false, false, true),
            Some(C::PageDown)
        );
        // Plain Home/End are the program's even when scrolled back.
        assert_eq!(scroll_command(K::Home, false, false, false, true), None);
        assert_eq!(scroll_command(K::End, false, false, false, true), None);
        // No scrollback on the alternate screen; other modifiers are the program's.
        assert_eq!(scroll_command(K::PageUp, true, false, true, false), None);
        assert_eq!(scroll_command(K::PageUp, true, true, false, false), None);
    }

    #[test]
    fn dragging_past_an_edge_scrolls_faster_the_farther_out() {
        // Grid is 400 px tall, cells 20 px.
        assert_eq!(edge_scroll(200.0, 400.0, 20), 0);
        assert_eq!(edge_scroll(-1.0, 400.0, 20), 1);
        assert_eq!(edge_scroll(-45.0, 400.0, 20), 3);
        assert_eq!(edge_scroll(-5000.0, 400.0, 20), 5);
        assert_eq!(edge_scroll(400.0, 400.0, 20), -1);
        assert_eq!(edge_scroll(461.0, 400.0, 20), -4);
        assert_eq!(edge_scroll(f64::NAN, 400.0, 20), 0);
    }
}
