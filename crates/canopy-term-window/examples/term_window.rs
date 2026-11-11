//! A window you can type into, for checking the window shell by hand (fonts,
//! HiDPI, zoom, IME, clipboard, screen readers) before the emulator exists.
//!
//! `cargo run --example term_window`
//!
//! The "terminal" is a toy line editor: it echoes what you type and answers a
//! few commands (type `help`). It is not a shell and runs nothing.

use std::collections::{BTreeSet, VecDeque};

use canopy_term_window::frame::{Attrs, Cell, Color, Cursor, Damage, Frame};
use canopy_term_window::source::{FrameSource, Waker};
use canopy_term_window::window::{run, WindowConfig};
use unicode_width::UnicodeWidthChar;

const HELP: &[&str] = &[
    "commands:",
    "  help          this list",
    "  lines N       print N numbered lines (screen reader announcements)",
    "  wide          CJK, emoji and combining marks (font fallback)",
    "  colors        the 16 ANSI colours",
    "  title TEXT    set the window title",
    "  alt           switch to the alternate screen (q returns)",
    "  clear         clear the screen",
    "  exit          close the window",
    "shortcuts: Cmd (macOS) or Ctrl+Shift (elsewhere) with C copy, V paste,",
    "  + / - / 0 zoom. Drag to select; hold Alt for a block selection.",
];

struct Demo {
    frame: Frame,
    seq: u64,
    line: String,
    dirty: BTreeSet<u16>,
    dirty_full: bool,
    touched: bool,
    /// (sequence, rows changed or `None` for everything), oldest first.
    history: VecDeque<(u64, Option<Vec<u16>>)>,
    saved_main: Option<(Vec<Cell>, Cursor)>,
    waker: Option<Waker>,
    closed: bool,
    esc: Option<String>,
}

impl Demo {
    fn new(cols: u16, rows: u16) -> Self {
        let mut frame = Frame::blank(cols, rows);
        frame.cursor.visible = true;
        let mut d = Demo {
            frame,
            seq: 0,
            line: String::new(),
            dirty: BTreeSet::new(),
            dirty_full: true,
            touched: true,
            history: VecDeque::new(),
            saved_main: None,
            waker: None,
            closed: false,
            esc: None,
        };
        d.put_line(
            "Canopy terminal window demo. Type `help`.",
            Attrs::BOLD,
            Color::Default,
        );
        d.put_line(
            "日本語 中文 한국어  emoji 😀🎉  e\u{301}",
            0,
            Color::Indexed(6),
        );
        d.prompt();
        d.commit();
        d
    }

    fn mark(&mut self, row: u16) {
        self.dirty.insert(row);
        self.touched = true;
    }

    fn mark_all(&mut self) {
        self.dirty_full = true;
        self.touched = true;
    }

    fn idx(&self, row: u16, col: u16) -> usize {
        row as usize * self.frame.cols as usize + col as usize
    }

    fn scroll_up(&mut self) {
        let cols = self.frame.cols as usize;
        self.frame.cells.drain(0..cols);
        self.frame
            .cells
            .extend(std::iter::repeat(Cell::default()).take(cols));
        self.mark_all();
    }

    fn newline(&mut self) {
        self.frame.cursor.col = 0;
        if self.frame.cursor.row + 1 >= self.frame.rows {
            self.scroll_up();
        } else {
            self.frame.cursor.row += 1;
        }
        self.touched = true;
    }

    fn put_char(&mut self, ch: char, attrs: u16, fg: Color) {
        let Some(w) = ch.width() else {
            return;
        };
        let (row, col) = (self.frame.cursor.row, self.frame.cursor.col);
        if w == 0 {
            // A combining mark joins the previous cell's cluster.
            if col == 0 {
                return;
            }
            let mut prev = col - 1;
            if prev > 0
                && self.frame.cells[self.idx(row, prev)]
                    .attrs
                    .has(Attrs::WIDE_TAIL)
            {
                prev -= 1;
            }
            let i = self.idx(row, prev);
            let mut text = self.frame.text(&self.frame.cells[i]);
            text.push(ch);
            self.frame.clusters.push(text);
            self.frame.cells[i].cluster = (self.frame.clusters.len() - 1) as u32;
            self.mark(row);
            return;
        }
        let w = w.min(2) as u16;
        if col + w > self.frame.cols {
            self.newline();
        }
        let (row, col) = (self.frame.cursor.row, self.frame.cursor.col);
        let i = self.idx(row, col);
        self.frame.cells[i] = Cell {
            ch,
            cluster: 0,
            fg,
            bg: Color::Default,
            attrs: Attrs(attrs),
        };
        if w == 2 {
            self.frame.cells[i + 1] = Cell {
                ch: '\0',
                attrs: Attrs(attrs | Attrs::WIDE_TAIL),
                ..Cell::default()
            };
        }
        self.frame.cursor.col = (col + w).min(self.frame.cols - 1);
        if col + w >= self.frame.cols {
            // Keep the cursor on screen; the next character wraps.
            self.newline();
        }
        self.mark(row);
    }

    fn put_str(&mut self, s: &str, attrs: u16, fg: Color) {
        for ch in s.chars() {
            self.put_char(ch, attrs, fg);
        }
    }

    fn put_line(&mut self, s: &str, attrs: u16, fg: Color) {
        self.put_str(s, attrs, fg);
        self.newline();
    }

    fn prompt(&mut self) {
        self.put_str("$ ", Attrs::BOLD, Color::Indexed(2));
    }

    fn clear(&mut self) {
        let (c, r) = (self.frame.cols, self.frame.rows);
        self.frame.cells = vec![Cell::default(); c as usize * r as usize];
        self.frame.clusters = vec![String::new()];
        self.frame.cursor.row = 0;
        self.frame.cursor.col = 0;
        self.mark_all();
    }

    fn backspace(&mut self) {
        let Some(ch) = self.line.pop() else {
            return;
        };
        let w = ch.width().unwrap_or(0).min(2) as u16;
        let (row, col) = (self.frame.cursor.row, self.frame.cursor.col);
        if w == 0 || col < w {
            return;
        }
        let col = col - w;
        for c in col..col + w {
            let i = self.idx(row, c);
            self.frame.cells[i] = Cell::default();
        }
        self.frame.cursor.col = col;
        self.mark(row);
    }

    fn enter_alt(&mut self) {
        self.saved_main = Some((self.frame.cells.clone(), self.frame.cursor));
        self.clear();
        self.frame.alt_screen = true;
        self.put_line(
            "ALTERNATE SCREEN (a full-screen program would draw here)",
            Attrs::INVERSE,
            Color::Default,
        );
        self.put_line(
            "Screen readers should not announce this screen. Press q to return.",
            0,
            Color::Default,
        );
    }

    fn leave_alt(&mut self) {
        self.frame.alt_screen = false;
        match self.saved_main.take() {
            Some((cells, cursor)) if cells.len() == self.frame.cells.len() => {
                self.frame.cells = cells;
                self.frame.cursor = cursor;
                self.mark_all();
            }
            _ => self.clear(),
        }
        self.prompt();
    }

    fn run_command(&mut self, line: &str) {
        let line = line.trim();
        let (cmd, arg) = line.split_once(' ').unwrap_or((line, ""));
        match cmd {
            "" => {}
            "help" => {
                for l in HELP {
                    self.put_line(l, 0, Color::Default);
                }
            }
            "lines" => {
                let n: usize = arg.trim().parse().unwrap_or(10).min(10_000);
                for i in 1..=n {
                    self.put_line(&format!("line {i}"), 0, Color::Default);
                }
            }
            "wide" => {
                self.put_line(
                    "日本語のテキスト / 中文文本 / 한국어 텍스트",
                    0,
                    Color::Default,
                );
                self.put_line("emoji: 😀 🎉 👍🏽 🇯🇵", 0, Color::Default);
                self.put_line("combining: e\u{301} a\u{308} n\u{303}", 0, Color::Default);
                self.put_line("box: ┌──┬──┐ │▒▒│░░│ └──┴──┘", 0, Color::Default);
            }
            "colors" => {
                for i in 0..16u8 {
                    self.put_str(&format!("{i:>3}"), 0, Color::Indexed(i));
                }
                self.newline();
            }
            "title" => {
                self.frame.title = Some(arg.to_string()).filter(|t| !t.is_empty());
                self.touched = true;
            }
            "alt" => {
                self.enter_alt();
                return;
            }
            "clear" => {
                self.clear();
                self.prompt();
                return;
            }
            "exit" => self.closed = true,
            _ => self.put_line(&format!("echo: {line}"), 0, Color::Default),
        }
        self.prompt();
    }

    fn input_char(&mut self, ch: char) {
        if self.frame.alt_screen {
            if ch == 'q' {
                self.leave_alt();
            }
            return;
        }
        match ch {
            '\r' => {
                let line = std::mem::take(&mut self.line);
                self.newline();
                self.run_command(&line);
            }
            '\u{7f}' | '\u{8}' => self.backspace(),
            '\u{3}' => {
                self.line.clear();
                self.put_str("^C", 0, Color::Default);
                self.newline();
                self.prompt();
            }
            '\u{c}' => {
                self.clear();
                self.prompt();
                let line = self.line.clone();
                self.put_str(&line, 0, Color::Default);
            }
            c if c.is_control() => {}
            c => {
                self.line.push(c);
                self.put_char(c, 0, Color::Default);
            }
        }
    }

    /// Ends a batch of changes: a new sequence with the rows it touched.
    fn commit(&mut self) {
        if !self.touched {
            return;
        }
        self.seq += 1;
        let rows = if self.dirty_full {
            None
        } else {
            Some(self.dirty.iter().copied().collect())
        };
        self.history.push_back((self.seq, rows));
        while self.history.len() > 64 {
            self.history.pop_front();
        }
        self.dirty.clear();
        self.dirty_full = false;
        self.touched = false;
        self.frame.seq = self.seq;
        if let Some(wake) = &self.waker {
            (**wake)();
        }
    }
}

fn ranges(rows: &BTreeSet<u16>) -> Vec<(u16, u16)> {
    let mut out: Vec<(u16, u16)> = Vec::new();
    for &r in rows {
        match out.last_mut() {
            Some((_, b)) if *b + 1 == r => *b = r,
            _ => out.push((r, r)),
        }
    }
    out
}

impl FrameSource for Demo {
    fn frame_since(&mut self, since: u64) -> Option<Frame> {
        if since == self.seq {
            return None;
        }
        let complete = match self.history.front() {
            Some((first, _)) => since + 1 >= *first,
            None => false,
        };
        let full = since == 0
            || since > self.seq
            || !complete
            || self
                .history
                .iter()
                .any(|(s, rows)| *s > since && rows.is_none());
        let rows: BTreeSet<u16> = if full {
            BTreeSet::new()
        } else {
            self.history
                .iter()
                .filter(|(s, _)| *s > since)
                .flat_map(|(_, rows)| rows.iter().flatten().copied())
                .collect()
        };
        let mut f = self.frame.clone();
        f.damage = Damage {
            since,
            full,
            rows: ranges(&rows),
        };
        Some(f)
    }

    fn resize(&mut self, cols: u16, rows: u16) {
        if (cols, rows) == (self.frame.cols, self.frame.rows) || cols == 0 || rows == 0 {
            return;
        }
        let old = std::mem::replace(&mut self.frame, Frame::blank(cols, rows));
        // Keep the cursor row on screen: drop rows from the top if needed.
        let offset = (old.cursor.row + 1).saturating_sub(rows);
        for r in 0..rows.min(old.rows.saturating_sub(offset)) {
            for c in 0..cols.min(old.cols) {
                let src = (r + offset) as usize * old.cols as usize + c as usize;
                let dst = r as usize * cols as usize + c as usize;
                self.frame.cells[dst] = old.cells[src];
            }
        }
        self.frame.clusters = old.clusters;
        self.frame.title = old.title;
        self.frame.alt_screen = old.alt_screen;
        self.frame.modes = old.modes;
        self.frame.cursor = Cursor {
            row: old.cursor.row - offset,
            col: old.cursor.col.min(cols - 1),
            ..old.cursor
        };
        self.saved_main = None;
        self.mark_all();
        self.commit();
    }

    fn write(&mut self, bytes: &[u8]) {
        let text = String::from_utf8_lossy(bytes).into_owned();
        for ch in text.chars() {
            // Skip escape sequences (arrows, bracketed paste markers).
            if let Some(seq) = self.esc.as_mut() {
                seq.push(ch);
                let done = (seq.len() > 1 && ch.is_ascii_alphabetic())
                    || ch == '~'
                    || (seq.len() == 1 && ch != '[' && ch != 'O');
                if done || seq.len() > 16 {
                    self.esc = None;
                }
                continue;
            }
            if ch == '\u{1b}' {
                self.esc = Some(String::new());
                continue;
            }
            self.input_char(ch);
        }
        self.commit();
    }

    fn set_waker(&mut self, waker: Waker) {
        self.waker = Some(waker);
    }

    fn closed(&self) -> bool {
        self.closed
    }
}

fn main() {
    let demo = Demo::new(100, 30);
    let config = WindowConfig {
        title: "Canopy terminal window demo".to_string(),
        ..WindowConfig::default()
    };
    if let Err(e) = run(demo, config) {
        eprintln!("term_window: {e}");
        std::process::exit(1);
    }
}
