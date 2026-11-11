//! Headless VT screen state: PTY bytes in, [`Frame`]s and snapshots out.
//!
//! The emulator is `alacritty_terminal` (Apache-2.0), chosen by measurement
//! (see `PERF.md` and `tests/compare.rs`). None of its types appear in this
//! module's public API, so the engine can be swapped without touching callers.
//!
//! Three things the engine does not give us are handled here:
//!
//! * Synchronized output (2026): the engine's own handling buffers bytes behind
//!   a wall-clock timeout, which makes screen state depend on time and keeps
//!   buffered bytes out of any snapshot. A pass-through [`Timeout`] turns that
//!   off, so every byte reaches the grid at once; the mode itself is tracked
//!   here and reported in [`Modes::sync_output`] so the consumer can hold the
//!   frame.
//! * X10 mouse (mode 9): not tracked by the engine, tracked here.
//! * Reset (`ESC c`): the engine resets its own modes, so the modes tracked
//!   here (and the title) are reset at exactly the same point in the stream.
//!
//! # What a snapshot contains
//!
//! [`Screen::snapshot`] returns escape sequences that, fed to a fresh `Screen`
//! of the same size, reproduce the visible grid (text, colours, attributes,
//! wide characters and combining clusters), the cursor position, shape and
//! visibility, the title, the pen (the style the next character is drawn
//! with), and every mode in [`Modes`]. If the program is on the alternate
//! screen, the snapshot enters it first.
//!
//! **Scrollback is not in the snapshot.** It can be read with
//! [`Screen::scrollback_len`] and [`Screen::scrollback_row`].
//!
//! Not carried (unproven or lost): the primary screen contents behind an
//! active alternate screen (the engine does not expose the inactive grid),
//! the scroll region, tab stops, saved-cursor (DECSC) slots, character sets,
//! origin and newline modes, a pending autowrap at the last column, and the
//! kitty keyboard stack beyond its top entry.

use crate::frame::{
    Attrs, Cell, Color, Cursor, CursorShape, Damage, Frame, Modes, MouseEncoding, MouseMode,
};
use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell as EngineCell, Flags};
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{
    Color as EngineColor, CursorShape as EngineShape, NamedColor, Processor, Timeout,
};
use alacritty_terminal::vte::{Params, Parser, Perform};
use std::fmt::Write as _;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const MIN_COLS: u16 = 2;
const MIN_ROWS: u16 = 1;

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

#[derive(Clone, Default)]
struct Listener {
    title: Arc<Mutex<Option<String>>>,
}

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        let mut title = self.title.lock().unwrap_or_else(|e| e.into_inner());
        match event {
            Event::Title(t) => *title = Some(t),
            Event::ResetTitle => *title = None,
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

/// Second, tiny parse of the same stream for the modes the engine does not
/// expose. Its own `vte::Parser` carries partial sequences across calls, so
/// split input behaves like unsplit input.
#[derive(Default)]
struct Tap {
    sync: bool,
    x10: bool,
}

impl Perform for Tap {
    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], _ignore: bool, action: char) {
        if intermediates == [b'?'] && (action == 'h' || action == 'l') {
            let on = action == 'h';
            for p in params.iter() {
                match p.first().copied() {
                    Some(2026) => self.sync = on,
                    Some(9) => self.x10 = on,
                    // Any of the other mouse modes supersedes X10.
                    Some(1000) | Some(1002) | Some(1003) => self.x10 = false,
                    _ => {}
                }
            }
        }
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
    tap_parser: Parser,
    tap: Tap,
    title: Arc<Mutex<Option<String>>>,
    /// The last byte seen was ESC, so a leading `c` is a reset.
    prev_esc: bool,
    cols: u16,
    rows: u16,
    frame: Frame,
    /// Sequence at which each row last changed.
    row_seq: Vec<u64>,
    /// Sequence of the last change that needs a full redraw.
    full_seq: u64,
    /// The cursor's template cell: the pen the next character is drawn with.
    pen: Cell,
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
            s.extend(z.iter());
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

impl Screen {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self::with_scrollback(cols, rows, DEFAULT_SCROLLBACK)
    }

    pub fn with_scrollback(cols: u16, rows: u16, scrollback: usize) -> Self {
        let (cols, rows) = (cols.max(MIN_COLS), rows.max(MIN_ROWS));
        let listener = Listener::default();
        let title = listener.title.clone();
        let config = Config {
            scrolling_history: scrollback,
            kitty_keyboard: true,
            ..Config::default()
        };
        let size = Size {
            cols: cols as usize,
            rows: rows as usize,
        };
        let mut screen = Screen {
            term: Term::new(config, &size, listener),
            processor: Processor::<PassThrough>::new(),
            tap_parser: Parser::new(),
            tap: Tap::default(),
            title,
            prev_esc: false,
            cols,
            rows,
            frame: Frame::blank(cols, rows),
            row_seq: vec![1; rows as usize],
            full_seq: 1,
            pen: Cell::default(),
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
    /// screen: both parsers keep partial sequences between calls.
    pub fn advance(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let mut start = 0;
        for i in 0..bytes.len() {
            let b = bytes[i];
            if b == b'c' && self.prev_esc {
                // RIS: feed up to and including it, then reset what we track.
                self.feed(&bytes[start..=i]);
                self.tap = Tap::default();
                *self.title.lock().unwrap_or_else(|e| e.into_inner()) = None;
                start = i + 1;
            }
            self.prev_esc = b == 0x1b;
        }
        if start < bytes.len() {
            self.feed(&bytes[start..]);
        }
        self.refresh(false);
    }

    fn feed(&mut self, bytes: &[u8]) {
        self.processor.advance(&mut self.term, bytes);
        self.tap_parser.advance(&mut self.tap, bytes);
    }

    /// Resize the grid. The engine reflows wrapped lines: see the resize test.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        let (cols, rows) = (cols.max(MIN_COLS), rows.max(MIN_ROWS));
        if (cols, rows) == (self.cols, self.rows) {
            return;
        }
        self.term.resize(Size {
            cols: cols as usize,
            rows: rows as usize,
        });
        self.cols = cols;
        self.rows = rows;
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

    /// Lines of scrollback currently held (primary screen only).
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
        let grid = self.term.grid();
        let mut clusters = vec![String::new()];
        let mut cells = Vec::with_capacity(cols * rows);
        for r in 0..rows {
            let row = &grid[Line(r as i32)];
            for c in 0..cols {
                cells.push(convert_cell(&row[Column(c)], &mut clusters));
            }
        }
        let p = grid.cursor.point;
        let template = &grid.cursor.template;
        let mut scratch = Vec::new();
        let pen = convert_cell(template, &mut scratch);
        let mode = self.term.mode();
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
        let mouse = if mode.contains(TermMode::MOUSE_MOTION) {
            MouseMode::Any
        } else if mode.contains(TermMode::MOUSE_DRAG) {
            MouseMode::Drag
        } else if mode.contains(TermMode::MOUSE_REPORT_CLICK) {
            MouseMode::Normal
        } else if self.tap.x10 {
            MouseMode::Press
        } else {
            MouseMode::Off
        };
        let mut kitty = 0u8;
        for (flag, bit) in [
            (TermMode::DISAMBIGUATE_ESC_CODES, 1u8),
            (TermMode::REPORT_EVENT_TYPES, 2),
            (TermMode::REPORT_ALTERNATE_KEYS, 4),
            (TermMode::REPORT_ALL_KEYS_AS_ESC, 8),
            (TermMode::REPORT_ASSOCIATED_TEXT, 16),
        ] {
            if mode.contains(flag) {
                kitty |= bit;
            }
        }
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
            sync_output: self.tap.sync,
            kitty_keyboard: kitty,
        };
        let alt_screen = mode.contains(TermMode::ALT_SCREEN);
        let title = self.title.lock().unwrap_or_else(|e| e.into_inner()).clone();
        self.pen = pen;

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
        let mut out = String::new();
        // Reset, then enter the alternate screen first if the program is on it.
        out.push_str("\x1bc");
        if f.alt_screen {
            out.push_str("\x1b[?1049h");
        }
        let blank = Cell::default();
        let mut cur: (Color, Color, Attrs) = (Color::Default, Color::Default, Attrs(0));
        for r in 0..f.rows as usize {
            let row = &f.cells[r * f.cols as usize..(r + 1) * f.cols as usize];
            let last = match row.iter().rposition(|c| *c != blank) {
                Some(i) => i,
                None => continue,
            };
            let _ = write!(out, "\x1b[{};1H", r + 1);
            for cell in &row[..=last] {
                if cell.attrs.has(Attrs::WIDE_TAIL) {
                    continue;
                }
                let attrs = Attrs(cell.attrs.0 & !Attrs::WIDE_TAIL);
                if (cell.fg, cell.bg, attrs) != cur {
                    write_sgr(&mut out, cell.fg, cell.bg, attrs);
                    cur = (cell.fg, cell.bg, attrs);
                }
                match f.clusters.get(cell.cluster as usize) {
                    Some(t) if cell.cluster != 0 => out.push_str(t),
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
        if !self.term.mode().contains(TermMode::LINE_WRAP) {
            out.push_str("\x1b[?7l");
        }
        if let Some(title) = &f.title {
            let clean: String = title.chars().filter(|c| !c.is_control()).collect();
            let _ = write!(out, "\x1b]2;{clean}\x07");
        }
        let m = &f.modes;
        match m.mouse {
            MouseMode::Off => {}
            MouseMode::Press => out.push_str("\x1b[?9h"),
            MouseMode::Normal => out.push_str("\x1b[?1000h"),
            MouseMode::Drag => out.push_str("\x1b[?1002h"),
            MouseMode::Any => out.push_str("\x1b[?1003h"),
        }
        match m.mouse_encoding {
            MouseEncoding::Default => {}
            MouseEncoding::Utf8 => out.push_str("\x1b[?1005h"),
            MouseEncoding::Sgr => out.push_str("\x1b[?1006h"),
        }
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
        if m.kitty_keyboard != 0 {
            let _ = write!(out, "\x1b[>{}u", m.kitty_keyboard);
        }
        let shape = match f.cursor.shape {
            CursorShape::Block => 2,
            CursorShape::Underline => 4,
            CursorShape::Bar => 6,
        };
        let _ = write!(out, "\x1b[{shape} q");
        let _ = write!(out, "\x1b[{};{}H", f.cursor.row + 1, f.cursor.col + 1);
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
