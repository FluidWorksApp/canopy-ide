//! Headless VT screen state: PTY bytes in, [`Frame`]s, replies and snapshots
//! out.
//!
//! The emulator is `alacritty_terminal` (Apache-2.0), chosen by measurement
//! (see `PERF.md` and `tests/compare.rs`). None of its types appear in this
//! module's public API, so the engine can be swapped without touching callers.
//!
//! Every byte first passes a filter (`filter.rs`) that walks the same state
//! machine as the engine's parser. It bounds what the engine would buffer
//! without limit (OSC bodies, titles) and tracks what the engine does not keep
//! or keep safely: synchronized output (2026), X10 mouse (9), the scroll
//! region (private in the engine), and the kitty keyboard stacks (the engine's
//! kitty support is switched off because its push at the depth limit can
//! panic). Synchronized output never holds bytes back: a pass-through
//! [`Timeout`] lets every byte reach the grid at once, and
//! [`Modes::sync_output`] tells the consumer to hold the frame.
//!
//! # Replies
//!
//! Queries from the program (device attributes, cursor position report, mode
//! reports, kitty flags, colour queries) produce bytes that must be written
//! back to the PTY. Collect them with [`Screen::take_replies`] after each
//! [`Screen::advance`]. Colour queries (OSC 10/11/12/4) are answered from
//! colours the program set, else from [`Screen::set_reply_colors`]; with
//! neither there is no reply. Pixel-size queries (`CSI 14 t`) are not answered.
//!
//! # What a snapshot contains
//!
//! [`Screen::snapshot`] returns escape sequences that, fed to a fresh `Screen`
//! of the same size, reproduce the visible grid (text, colours, attributes,
//! wide characters, combining clusters, soft wraps), the cursor position,
//! shape, blink and visibility, the title, the pen (the style the next
//! character is drawn with), the scroll region, insert/origin/newline/autowrap
//! and alternate-scroll modes, every mouse mode and encoding bit, the kitty
//! flags of both screens, and every mode in [`Modes`]. If the program is on the
//! alternate screen, the snapshot enters it first.
//!
//! **Scrollback is not in the snapshot.** Read it with
//! [`Screen::scrollback_len`] and [`Screen::scrollback_row`]; on the alternate
//! screen these read the alternate screen, which has none (the engine does not
//! expose the primary grid behind it).
//!
//! Not carried: the primary screen contents behind an active alternate screen,
//! tab stops, saved-cursor (DECSC) slots, character sets, a pending autowrap at
//! the last column, an empty scroll region, kitty stack entries below the top,
//! a soft wrap on the bottom row, the palette (OSC 4/10/11/12), underline
//! styles and colour, and hyperlinks (OSC 8).
//!
//! # Bounds
//!
//! Frame, snapshot and per-cell clusters are bounded ([`MAX_CLUSTER_SCALARS`],
//! [`MAX_TITLE_BYTES`]); OSC bodies are cut at [`MAX_OSC_BYTES`] before the
//! engine; combining marks beyond the cluster bound are trimmed from the
//! engine's cells after every 4 KiB fed to it (so a line that scrolls into
//! history inside one large `advance` holds at most about 2,000 marks per
//! cell); replies held for the owner are capped; sizes are capped at [`MAX_COLS`] x [`MAX_ROWS`]
//! and scrollback at [`MAX_SCROLLBACK`].

pub use crate::filter::{KITTY_STACK_MAX, MAX_OSC_BYTES, MAX_TITLE_BYTES};

use crate::filter::{Action, Filter};
use crate::frame::{
    Attrs, Cell, Color, Cursor, CursorShape, Damage, Frame, Modes, MouseEncoding, MouseMode,
};
use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell as EngineCell, Flags};
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{
    Color as EngineColor, CursorShape as EngineShape, NamedColor, Processor, Rgb, Timeout,
};
use std::collections::VecDeque;
use std::fmt::Write as _;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const MIN_COLS: u16 = 2;
const MIN_ROWS: u16 = 1;
/// Largest grid accepted; larger requests are clamped.
pub const MAX_COLS: u16 = 2000;
pub const MAX_ROWS: u16 = 1000;
/// Most scrollback lines accepted.
pub const MAX_SCROLLBACK: usize = 100_000;

/// Most scalars kept in one cell's cluster (base plus combining marks).
pub const MAX_CLUSTER_SCALARS: usize = 16;

/// Default scrollback, in lines.
pub const DEFAULT_SCROLLBACK: usize = 10_000;

/// Lets the engine run synchronized-output sequences straight through instead
/// of buffering them behind a timer.
#[derive(Default)]
struct PassThrough;

impl Timeout for PassThrough {
    fn set_timeout(&mut self, _: Duration) {}
    fn clear_timeout(&mut self) {}
    fn pending_timeout(&self) -> bool {
        false
    }
}

type ColorFormatter = Arc<dyn Fn(Rgb) -> String + Sync + Send + 'static>;

enum Pending {
    Bytes(String),
    Color(usize, ColorFormatter),
}

#[derive(Clone, Default)]
struct Listener {
    title: Arc<Mutex<Option<String>>>,
    replies: Arc<Mutex<VecDeque<Pending>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Most replies held for the owner; the oldest are dropped past this, so a
/// screen nobody drains (a mirror replaying output) cannot grow without end.
pub const MAX_PENDING_REPLIES: usize = 1024;

fn push_reply(q: &Mutex<VecDeque<Pending>>, p: Pending) {
    let mut q = lock(q);
    if q.len() >= MAX_PENDING_REPLIES {
        q.pop_front();
    }
    q.push_back(p);
}

/// The engine is fed at most this many bytes between passes that trim
/// combining marks from its cells, so a line that scrolls into history inside
/// one large `advance` carries at most about this many bytes of marks.
const TRIM_SLICE: usize = 4096;

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        match event {
            Event::Title(t) => *lock(&self.title) = Some(t),
            Event::ResetTitle => *lock(&self.title) = None,
            Event::PtyWrite(s) => push_reply(&self.replies, Pending::Bytes(s)),
            Event::ColorRequest(i, f) => push_reply(&self.replies, Pending::Color(i, f)),
            _ => {}
        }
    }
}

struct Size {
    cols: usize,
    rows: usize,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

/// One line of scrollback. `Cell::cluster` indexes `clusters` (index 0 unused).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Row {
    pub cells: Vec<Cell>,
    pub clusters: Vec<String>,
}

impl Row {
    /// The line as text, trailing blanks trimmed.
    pub fn text(&self) -> String {
        let mut out = String::new();
        for cell in &self.cells {
            if cell.attrs.has(Attrs::WIDE_TAIL) {
                continue;
            }
            match self.clusters.get(cell.cluster as usize) {
                Some(t) if cell.cluster != 0 => out.push_str(t),
                _ => out.push(cell.ch),
            }
        }
        out.trim_end().to_string()
    }
}

pub struct Screen {
    term: Term<Listener>,
    processor: Processor<PassThrough>,
    filter: Filter,
    title: Arc<Mutex<Option<String>>>,
    replies: Arc<Mutex<VecDeque<Pending>>>,
    reply_colors: [Option<Rgb>; 3],
    filtered: Vec<u8>,
    actions: Vec<(usize, Action)>,
    cols: u16,
    rows: u16,
    frame: Frame,
    /// Sequence at which each row last changed.
    row_seq: Vec<u64>,
    /// Sequence of the last change that needs a full redraw.
    full_seq: u64,
    /// The cursor's template cell: the pen the next character is drawn with.
    pen: Cell,
    blinking: bool,
}

fn convert_color(c: EngineColor) -> Color {
    match c {
        EngineColor::Indexed(i) => Color::Indexed(i),
        EngineColor::Spec(rgb) => Color::Rgb(rgb.r, rgb.g, rgb.b),
        EngineColor::Named(n) => {
            let i = n as usize;
            let dim0 = NamedColor::DimBlack as usize;
            let dim7 = NamedColor::DimWhite as usize;
            if i < 16 {
                Color::Indexed(i as u8)
            } else if (dim0..=dim7).contains(&i) {
                Color::Indexed((i - dim0) as u8)
            } else {
                Color::Default
            }
        }
    }
}

fn convert_cell(cell: &EngineCell, clusters: &mut Vec<String>) -> Cell {
    let f = cell.flags;
    let mut attrs = 0u16;
    if f.contains(Flags::BOLD) {
        attrs |= Attrs::BOLD;
    }
    if f.contains(Flags::ITALIC) {
        attrs |= Attrs::ITALIC;
    }
    if f.intersects(Flags::ALL_UNDERLINES) {
        attrs |= Attrs::UNDERLINE;
    }
    if f.contains(Flags::INVERSE) {
        attrs |= Attrs::INVERSE;
    }
    if f.contains(Flags::STRIKEOUT) {
        attrs |= Attrs::STRIKE;
    }
    if f.contains(Flags::DIM) {
        attrs |= Attrs::DIM;
    }
    if f.contains(Flags::HIDDEN) {
        attrs |= Attrs::HIDDEN;
    }
    let fg = convert_color(cell.fg);
    let bg = convert_color(cell.bg);
    if f.contains(Flags::WIDE_CHAR_SPACER) {
        return Cell {
            ch: '\0',
            cluster: 0,
            fg,
            bg,
            attrs: Attrs(attrs | Attrs::WIDE_TAIL),
        };
    }
    // A tab leaves '\t' in the cell where it started; the grid position is what
    // matters, so show a blank (and never print a TAB in a snapshot).
    let ch = if f.contains(Flags::LEADING_WIDE_CHAR_SPACER) || cell.c == '\t' {
        ' '
    } else {
        cell.c
    };
    let mut cluster = 0u32;
    if let Some(z) = cell.zerowidth() {
        if !z.is_empty() {
            let mut s = String::new();
            s.push(ch);
            s.extend(z.iter().take(MAX_CLUSTER_SCALARS - 1));
            cluster = clusters.len() as u32;
            clusters.push(s);
        }
    }
    Cell {
        ch,
        cluster,
        fg,
        bg,
        attrs: Attrs(attrs),
    }
}

/// Drop combining marks past the cluster bound from an engine cell, keeping
/// everything else about it.
fn trim_marks(cell: &mut EngineCell) {
    let Some(z) = cell.zerowidth() else { return };
    if z.len() < MAX_CLUSTER_SCALARS {
        return;
    }
    let keep: Vec<char> = z.iter().take(MAX_CLUSTER_SCALARS - 1).copied().collect();
    let underline = cell.underline_color();
    let link = cell.hyperlink();
    cell.extra = None;
    for c in keep {
        cell.push_zerowidth(c);
    }
    cell.set_underline_color(underline);
    cell.set_hyperlink(link);
}

fn cell_text<'a>(clusters: &'a [String], cell: &Cell, buf: &'a mut String) -> &'a str {
    match clusters.get(cell.cluster as usize) {
        Some(t) if cell.cluster != 0 => t,
        _ => {
            buf.clear();
            buf.push(cell.ch);
            buf
        }
    }
}

/// Rows are equal when every cell matches, comparing clusters by text rather
/// than by table index (indices shift when an earlier row changes).
fn rows_equal(a: &Frame, b_cells: &[Cell], b_clusters: &[String], row: usize) -> bool {
    let cols = a.cols as usize;
    let range = row * cols..(row + 1) * cols;
    let (ac, bc) = (&a.cells[range.clone()], &b_cells[range]);
    for (x, y) in ac.iter().zip(bc) {
        if x.fg != y.fg || x.bg != y.bg || x.attrs != y.attrs || x.ch != y.ch {
            return false;
        }
        if (x.cluster == 0) != (y.cluster == 0) {
            return false;
        }
        if x.cluster != 0 {
            let (mut s1, mut s2) = (String::new(), String::new());
            if cell_text(&a.clusters, x, &mut s1) != cell_text(b_clusters, y, &mut s2) {
                return false;
            }
        }
    }
    true
}

fn write_sgr(out: &mut String, fg: Color, bg: Color, attrs: Attrs) {
    out.push_str("\x1b[0");
    for (flag, code) in [
        (Attrs::BOLD, 1),
        (Attrs::DIM, 2),
        (Attrs::ITALIC, 3),
        (Attrs::UNDERLINE, 4),
        (Attrs::INVERSE, 7),
        (Attrs::HIDDEN, 8),
        (Attrs::STRIKE, 9),
    ] {
        if attrs.has(flag) {
            let _ = write!(out, ";{code}");
        }
    }
    match fg {
        Color::Default => {}
        Color::Indexed(i) => {
            let _ = write!(out, ";38;5;{i}");
        }
        Color::Rgb(r, g, b) => {
            let _ = write!(out, ";38;2;{r};{g};{b}");
        }
    }
    match bg {
        Color::Default => {}
        Color::Indexed(i) => {
            let _ = write!(out, ";48;5;{i}");
        }
        Color::Rgb(r, g, b) => {
            let _ = write!(out, ";48;2;{r};{g};{b}");
        }
    }
    out.push('m');
}

fn clamp_size(cols: u16, rows: u16) -> (u16, u16) {
    (
        cols.clamp(MIN_COLS, MAX_COLS),
        rows.clamp(MIN_ROWS, MAX_ROWS),
    )
}

impl Screen {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self::with_scrollback(cols, rows, DEFAULT_SCROLLBACK)
    }

    pub fn with_scrollback(cols: u16, rows: u16, scrollback: usize) -> Self {
        let (cols, rows) = clamp_size(cols, rows);
        let listener = Listener::default();
        let title = listener.title.clone();
        let replies = listener.replies.clone();
        let config = Config {
            scrolling_history: scrollback.min(MAX_SCROLLBACK),
            // Tracked by the filter instead: see the module docs.
            kitty_keyboard: false,
            ..Config::default()
        };
        let size = Size {
            cols: cols as usize,
            rows: rows as usize,
        };
        let mut screen = Screen {
            term: Term::new(config, &size, listener),
            processor: Processor::<PassThrough>::new(),
            filter: Filter::new(rows),
            title,
            replies,
            reply_colors: [None; 3],
            filtered: Vec::new(),
            actions: Vec::new(),
            cols,
            rows,
            frame: Frame::blank(cols, rows),
            row_seq: vec![1; rows as usize],
            full_seq: 1,
            pen: Cell::default(),
            blinking: false,
        };
        screen.frame.seq = 1;
        screen.refresh(true);
        screen
    }

    pub fn cols(&self) -> u16 {
        self.cols
    }

    pub fn rows(&self) -> u16 {
        self.rows
    }

    /// Feed bytes from the PTY. Any split of the same stream gives the same
    /// screen.
    pub fn advance(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let mut filtered = std::mem::take(&mut self.filtered);
        let mut actions = std::mem::take(&mut self.actions);
        filtered.clear();
        actions.clear();
        self.filter.feed(bytes, &mut filtered, &mut actions);
        let mut start = 0;
        for (at, action) in actions.drain(..) {
            self.feed_engine(&filtered[start..at]);
            start = at;
            match action {
                Action::Reset => *lock(&self.title) = None,
                Action::Reply(s) => push_reply(&self.replies, Pending::Bytes(s)),
            }
        }
        if start < filtered.len() {
            self.feed_engine(&filtered[start..]);
        }
        self.filtered = filtered;
        self.actions = actions;
        self.refresh(false);
    }

    fn feed_engine(&mut self, bytes: &[u8]) {
        for slice in bytes.chunks(TRIM_SLICE) {
            self.processor.advance(&mut self.term, slice);
            self.trim_visible();
        }
    }

    /// Drop combining marks past the cluster bound from every visible cell.
    fn trim_visible(&mut self) {
        let (cols, rows) = (self.cols as usize, self.rows as usize);
        let grid = self.term.grid_mut();
        for r in 0..rows {
            let row = &mut grid[Line(r as i32)];
            for c in 0..cols {
                trim_marks(&mut row[Column(c)]);
            }
        }
    }

    /// Bytes the program asked to have written back to it (answers to its
    /// queries), in order. Drains the queue (at most [`MAX_PENDING_REPLIES`]
    /// are held; drain after every `advance`).
    pub fn take_replies(&mut self) -> Vec<u8> {
        let pending = std::mem::take(&mut *lock(&self.replies));
        let mut out = Vec::new();
        for p in pending {
            match p {
                Pending::Bytes(s) => out.extend_from_slice(s.as_bytes()),
                Pending::Color(index, format) => {
                    let set = if index < 269 {
                        self.term.colors()[index]
                    } else {
                        None
                    };
                    let fallback = match index {
                        256 => self.reply_colors[0],
                        257 => self.reply_colors[1],
                        258 => self.reply_colors[2],
                        _ => None,
                    };
                    if let Some(rgb) = set.or(fallback) {
                        out.extend_from_slice(format(rgb).as_bytes());
                    }
                }
            }
        }
        out
    }

    /// Default foreground, background and cursor colours used to answer
    /// colour queries the program has not overridden. The renderer knows the
    /// theme; until it says, those queries get no reply.
    pub fn set_reply_colors(
        &mut self,
        fg: Option<(u8, u8, u8)>,
        bg: Option<(u8, u8, u8)>,
        cursor: Option<(u8, u8, u8)>,
    ) {
        let rgb = |c: Option<(u8, u8, u8)>| c.map(|(r, g, b)| Rgb { r, g, b });
        self.reply_colors = [rgb(fg), rgb(bg), rgb(cursor)];
    }

    /// Resize the grid. The engine reflows wrapped lines: see the resize test.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        let (cols, rows) = clamp_size(cols, rows);
        if (cols, rows) == (self.cols, self.rows) {
            return;
        }
        self.term.resize(Size {
            cols: cols as usize,
            rows: rows as usize,
        });
        self.cols = cols;
        self.rows = rows;
        self.filter.tracker.resize(rows);
        self.refresh(true);
    }

    /// The current screen. Damage is full (no baseline); use
    /// [`Screen::damage_since`] with a remembered `seq` for incremental updates.
    pub fn frame(&self) -> Frame {
        self.frame.clone()
    }

    /// Frame sequence number of the current screen.
    pub fn seq(&self) -> u64 {
        self.frame.seq
    }

    /// Whether the cursor blinks (not part of the frame contract).
    pub fn cursor_blinking(&self) -> bool {
        self.blinking
    }

    /// Rows changed since the consumer's frame `since`. Full when `since` is 0,
    /// from the future, or older than the last resize / alternate-screen
    /// switch.
    pub fn damage_since(&self, since: u64) -> Damage {
        if since == 0 || since > self.frame.seq || since < self.full_seq {
            return Damage {
                since,
                full: true,
                rows: Vec::new(),
            };
        }
        let mut rows: Vec<(u16, u16)> = Vec::new();
        for (r, &s) in self.row_seq.iter().enumerate() {
            if s > since {
                let r = r as u16;
                match rows.last_mut() {
                    Some(last) if last.1 + 1 == r => last.1 = r,
                    _ => rows.push((r, r)),
                }
            }
        }
        Damage {
            since,
            full: false,
            rows,
        }
    }

    /// Lines of scrollback currently held. On the alternate screen this is 0:
    /// the primary screen's scrollback is behind it and the engine does not
    /// expose it.
    pub fn scrollback_len(&self) -> usize {
        self.term.history_size()
    }

    /// A scrollback line; index 0 is the oldest. Not part of the snapshot.
    pub fn scrollback_row(&self, index: usize) -> Option<Row> {
        let len = self.scrollback_len();
        if index >= len {
            return None;
        }
        let line = Line(-((len - index) as i32));
        let row = &self.term.grid()[line];
        let mut clusters = vec![String::new()];
        let cells = (0..self.cols as usize)
            .map(|c| convert_cell(&row[Column(c)], &mut clusters))
            .collect();
        Some(Row { cells, clusters })
    }

    fn refresh(&mut self, force_full: bool) {
        let (cols, rows) = (self.cols as usize, self.rows as usize);
        let mut clusters = vec![String::new()];
        let mut cells = Vec::with_capacity(cols * rows);
        let grid = self.term.grid();
        for r in 0..rows {
            let row = &grid[Line(r as i32)];
            for c in 0..cols {
                cells.push(convert_cell(&row[Column(c)], &mut clusters));
            }
        }
        let p = grid.cursor.point;
        let mut scratch = Vec::new();
        let pen = convert_cell(&grid.cursor.template, &mut scratch);
        let mode = *self.term.mode();
        let style = self.term.cursor_style();
        let cursor = Cursor {
            row: (p.line.0.max(0) as u16).min(self.rows - 1),
            col: (p.column.0 as u16).min(self.cols - 1),
            shape: match style.shape {
                EngineShape::Underline => CursorShape::Underline,
                EngineShape::Beam => CursorShape::Bar,
                _ => CursorShape::Block,
            },
            visible: mode.contains(TermMode::SHOW_CURSOR),
        };
        let tracker = &self.filter.tracker;
        let mouse = if mode.contains(TermMode::MOUSE_MOTION) {
            MouseMode::Any
        } else if mode.contains(TermMode::MOUSE_DRAG) {
            MouseMode::Drag
        } else if mode.contains(TermMode::MOUSE_REPORT_CLICK) {
            MouseMode::Normal
        } else if tracker.x10 {
            MouseMode::Press
        } else {
            MouseMode::Off
        };
        let modes = Modes {
            mouse,
            mouse_encoding: if mode.contains(TermMode::SGR_MOUSE) {
                MouseEncoding::Sgr
            } else if mode.contains(TermMode::UTF8_MOUSE) {
                MouseEncoding::Utf8
            } else {
                MouseEncoding::Default
            },
            bracketed_paste: mode.contains(TermMode::BRACKETED_PASTE),
            app_cursor_keys: mode.contains(TermMode::APP_CURSOR),
            app_keypad: mode.contains(TermMode::APP_KEYPAD),
            focus_events: mode.contains(TermMode::FOCUS_IN_OUT),
            sync_output: tracker.sync,
            kitty_keyboard: tracker.kitty_active(),
        };
        let alt_screen = mode.contains(TermMode::ALT_SCREEN);
        let title = lock(&self.title).clone();
        self.pen = pen;
        self.blinking = style.blinking;

        let old = &self.frame;
        let size_changed = old.cols != self.cols || old.rows != self.rows;
        let mut changed: Vec<usize> = Vec::new();
        if !size_changed {
            for r in 0..rows {
                if !rows_equal(old, &cells, &clusters, r) {
                    changed.push(r);
                }
            }
        }
        let alt_changed = old.alt_screen != alt_screen;
        let cursor_changed = old.cursor != cursor;
        let meta_changed = cursor_changed || old.modes != modes || old.title != title;
        if !(force_full || size_changed || alt_changed || meta_changed || !changed.is_empty()) {
            return;
        }
        let seq = old.seq + 1;
        let old_cursor_row = old.cursor.row as usize;
        if force_full || size_changed || alt_changed {
            self.full_seq = seq;
            self.row_seq = vec![seq; rows];
        } else {
            for r in changed {
                self.row_seq[r] = seq;
            }
            if cursor_changed {
                for r in [old_cursor_row, cursor.row as usize] {
                    if let Some(s) = self.row_seq.get_mut(r) {
                        *s = seq;
                    }
                }
            }
        }
        self.frame = Frame {
            seq,
            cols: self.cols,
            rows: self.rows,
            cells,
            clusters,
            cursor,
            modes,
            damage: Damage {
                since: 0,
                full: true,
                rows: Vec::new(),
            },
            alt_screen,
            title,
        };
    }

    /// Escape sequences that bring a fresh `Screen` of the same size to this
    /// screen's visible grid, cursor, pen, title and modes. See the module
    /// docs for exactly what is and is not carried. Scrollback is not.
    ///
    /// Ends with `CSI ? 2026 h` when synchronized output is on, so a client
    /// that holds frames while it is set does not draw a half-restored screen.
    pub fn snapshot(&self) -> Vec<u8> {
        let f = &self.frame;
        let t = &self.filter.tracker;
        let mode = *self.term.mode();
        let mut out = String::new();
        // Reset, then the main screen's kitty flags, then the alternate screen
        // if the program is on it (each screen keeps its own kitty stack).
        out.push_str("\x1bc");
        let kitty_restore = |out: &mut String, k: &crate::filter::Kitty| {
            if let Some(top) = k.stack.last() {
                let _ = write!(out, "\x1b[>{top}u");
            }
            if k.active != k.stack.last().copied().unwrap_or(0) {
                let _ = write!(out, "\x1b[={};1u", k.active);
            }
        };
        if f.alt_screen {
            kitty_restore(&mut out, &t.kitty[0]);
            out.push_str("\x1b[?1049h");
        }

        // The grid. A row that soft-wraps is written to its last column and the
        // next row follows without a cursor move, so the wrap is recreated.
        let (cols, rows) = (f.cols as usize, f.rows as usize);
        let grid = self.term.grid();
        let wrapped = |r: usize| {
            r + 1 < rows
                && grid[Line(r as i32)][Column(cols - 1)]
                    .flags
                    .contains(Flags::WRAPLINE)
        };
        let blank = Cell::default();
        let mut cur: (Color, Color, Attrs) = (Color::Default, Color::Default, Attrs(0));
        for r in 0..rows {
            let row = &f.cells[r * cols..(r + 1) * cols];
            let chained = r > 0 && wrapped(r - 1);
            let end = if wrapped(r) {
                Some(cols - 1)
            } else {
                row.iter().rposition(|c| *c != blank)
            };
            let end = match (end, chained) {
                (Some(e), _) => e,
                (None, true) => 0,
                (None, false) => continue,
            };
            if !chained {
                let _ = write!(out, "\x1b[{};1H", r + 1);
            }
            for cell in &row[..=end] {
                if cell.attrs.has(Attrs::WIDE_TAIL) {
                    continue;
                }
                let attrs = Attrs(cell.attrs.0 & !Attrs::WIDE_TAIL);
                if (cell.fg, cell.bg, attrs) != cur {
                    write_sgr(&mut out, cell.fg, cell.bg, attrs);
                    cur = (cell.fg, cell.bg, attrs);
                }
                match f.clusters.get(cell.cluster as usize) {
                    Some(text) if cell.cluster != 0 => out.push_str(text),
                    _ => out.push(cell.ch),
                }
            }
        }
        // Pen: what the next character is drawn with.
        write_sgr(
            &mut out,
            self.pen.fg,
            self.pen.bg,
            Attrs(self.pen.attrs.0 & !Attrs::WIDE_TAIL),
        );
        if let Some(title) = &f.title {
            let clean: String = title.chars().filter(|c| !c.is_control()).collect();
            let _ = write!(out, "\x1b]2;{clean}\x07");
        }

        // Modes, after the grid so insert and newline modes do not touch it.
        if !mode.contains(TermMode::LINE_WRAP) {
            out.push_str("\x1b[?7l");
        }
        if mode.contains(TermMode::INSERT) {
            out.push_str("\x1b[4h");
        }
        if mode.contains(TermMode::LINE_FEED_NEW_LINE) {
            out.push_str("\x1b[20h");
        }
        if !mode.contains(TermMode::ALTERNATE_SCROLL) {
            out.push_str("\x1b[?1007l");
        }
        for (flag, code) in [
            (TermMode::MOUSE_REPORT_CLICK, 1000),
            (TermMode::MOUSE_DRAG, 1002),
            (TermMode::MOUSE_MOTION, 1003),
            (TermMode::UTF8_MOUSE, 1005),
            (TermMode::SGR_MOUSE, 1006),
        ] {
            if mode.contains(flag) {
                let _ = write!(out, "\x1b[?{code}h");
            }
        }
        // X10 last: setting 1000/1002/1003 clears it.
        if t.x10 {
            out.push_str("\x1b[?9h");
        }
        let m = &f.modes;
        if m.bracketed_paste {
            out.push_str("\x1b[?2004h");
        }
        if m.app_cursor_keys {
            out.push_str("\x1b[?1h");
        }
        if m.app_keypad {
            out.push_str("\x1b=");
        }
        if m.focus_events {
            out.push_str("\x1b[?1004h");
        }
        kitty_restore(&mut out, &t.kitty[f.alt_screen as usize]);

        // Scroll region (homes the cursor), origin mode (homes it again,
        // relative to the region), then the cursor itself.
        let top = match t.region {
            Some((start, end)) if start < end => {
                let _ = write!(out, "\x1b[{};{}r", start + 1, end);
                start
            }
            _ => 0,
        };
        let origin = mode.contains(TermMode::ORIGIN);
        if origin {
            out.push_str("\x1b[?6h");
        }
        let shape = match (f.cursor.shape, self.blinking) {
            (CursorShape::Block, true) => 1,
            (CursorShape::Block, false) => 2,
            (CursorShape::Underline, true) => 3,
            (CursorShape::Underline, false) => 4,
            (CursorShape::Bar, true) => 5,
            (CursorShape::Bar, false) => 6,
        };
        let _ = write!(out, "\x1b[{shape} q");
        let row = if origin {
            f.cursor.row.saturating_sub(top)
        } else {
            f.cursor.row
        };
        let _ = write!(out, "\x1b[{};{}H", row + 1, f.cursor.col + 1);
        out.push_str(if f.cursor.visible {
            "\x1b[?25h"
        } else {
            "\x1b[?25l"
        });
        if m.sync_output {
            out.push_str("\x1b[?2026h");
        }
        out.into_bytes()
    }

    /// A fresh screen brought to the state a snapshot describes.
    pub fn restore(cols: u16, rows: u16, snapshot: &[u8]) -> Screen {
        let mut s = Screen::new(cols, rows);
        s.advance(snapshot);
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Most combining marks held by any engine cell, visible or in history.
    fn most_marks(s: &Screen) -> usize {
        let grid = s.term.grid();
        let top = -(s.term.history_size() as i32);
        let mut most = 0;
        for line in top..s.rows as i32 {
            let row = &grid[Line(line)];
            for c in 0..s.cols as usize {
                most = most.max(row[Column(c)].zerowidth().map_or(0, |z| z.len()));
            }
        }
        most
    }

    #[test]
    fn engine_cells_are_trimmed_when_the_cursor_moves_back() {
        let mut s = Screen::new(20, 2);
        s.advance(b"a");
        let round = format!("{}b\x1b[D", "\u{301}".repeat(15));
        for _ in 0..200 {
            s.advance(round.as_bytes());
        }
        assert!(most_marks(&s) < MAX_CLUSTER_SCALARS);
    }

    #[test]
    fn marks_that_scroll_off_inside_one_advance_stay_bounded() {
        let mut s = Screen::with_scrollback(20, 5, 100);
        let mut bytes = b"a".to_vec();
        bytes.extend("\u{301}".repeat(200_000).as_bytes());
        bytes.extend_from_slice(b"\x1b[30S");
        s.advance(&bytes);
        assert!(s.term.history_size() > 0, "the marked line reached history");
        // U+0301 is two bytes: one slice adds at most TRIM_SLICE / 2 marks.
        assert!(most_marks(&s) <= MAX_CLUSTER_SCALARS + TRIM_SLICE / 2);
    }

    #[test]
    fn replies_nobody_drains_are_capped() {
        let mut s = Screen::new(10, 2);
        s.advance("\x1b[5n".repeat(5 * MAX_PENDING_REPLIES).as_bytes());
        assert_eq!(lock(&s.replies).len(), MAX_PENDING_REPLIES);
        assert_eq!(
            s.take_replies().len(),
            MAX_PENDING_REPLIES * b"\x1b[0n".len()
        );
    }
}
