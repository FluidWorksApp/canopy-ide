//! Adapters that put each candidate emulator behind one neutral interface, so
//! the same fixtures and the same byte stream can be run through all of them.
#![allow(dead_code)]

use std::num::NonZeroU16;

pub mod stream;

/// What a candidate exposes after consuming bytes. `Option` fields are `None`
/// when the candidate does not expose that mode at all (reported, not failed).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Dump {
    pub rows: Vec<String>,
    pub cursor: (u16, u16),
    pub cursor_visible: bool,
    pub alt: bool,
    pub app_cursor: bool,
    pub app_keypad: bool,
    pub bracketed: bool,
    pub mouse: String,
    pub mouse_enc: String,
    pub focus: Option<bool>,
    pub sync: Option<bool>,
    pub kitty: Option<u8>,
    /// `row,col:attrs` for each non-default cell, e.g. `0,0:bold,fg=1`.
    pub styles: Vec<String>,
    pub scrollback_len: usize,
}

pub trait Engine {
    fn name() -> &'static str;
    fn new(cols: u16, rows: u16, scrollback: usize) -> Self;
    fn feed(&mut self, bytes: &[u8]);
    fn resize(&mut self, cols: u16, rows: u16);
    fn dump(&self) -> Dump;
}

fn nz(n: u16) -> NonZeroU16 {
    NonZeroU16::new(n.max(1)).unwrap()
}

// ---------------------------------------------------------------- vt100

/// vt100 does not parse 1004, 2026 or the kitty keyboard sequences; its
/// callbacks hand us the unhandled CSI so the adapter can track them.
#[derive(Default)]
pub struct ExtraModes {
    pub focus: bool,
    pub sync: bool,
    pub kitty_stack: Vec<u8>,
}

fn first(params: &[&[u16]]) -> Option<u16> {
    params.first().and_then(|p| p.first()).copied()
}

impl vt100::Callbacks for ExtraModes {
    fn unhandled_csi(
        &mut self,
        _: &mut vt100::Screen,
        i1: Option<u8>,
        _i2: Option<u8>,
        params: &[&[u16]],
        c: char,
    ) {
        match (i1, c) {
            (Some(b'?'), 'h') | (Some(b'?'), 'l') => {
                let on = c == 'h';
                for p in params {
                    match p.first().copied() {
                        Some(1004) => self.focus = on,
                        Some(2026) => self.sync = on,
                        _ => {}
                    }
                }
            }
            (Some(b'>'), 'u') => {
                self.kitty_stack.push(first(params).unwrap_or(0) as u8);
            }
            (Some(b'<'), 'u') => {
                for _ in 0..first(params).unwrap_or(1).max(1) {
                    self.kitty_stack.pop();
                }
            }
            _ => {}
        }
    }
}

pub struct Vt100(vt100::Parser<ExtraModes>);

fn vcolor(c: vt100::Color) -> Option<String> {
    match c {
        vt100::Color::Default => None,
        vt100::Color::Idx(i) => Some(format!("{i}")),
        vt100::Color::Rgb(r, g, b) => Some(format!("{r}/{g}/{b}")),
    }
}

impl Engine for Vt100 {
    fn name() -> &'static str {
        "vt100"
    }
    fn new(cols: u16, rows: u16, scrollback: usize) -> Self {
        Vt100(vt100::Parser::new_with_callbacks(
            nz(rows),
            nz(cols),
            scrollback,
            ExtraModes::default(),
        ))
    }
    fn feed(&mut self, bytes: &[u8]) {
        self.0.process(bytes);
    }
    fn resize(&mut self, cols: u16, rows: u16) {
        self.0.set_size(nz(rows), nz(cols));
    }
    fn dump(&self) -> Dump {
        let s = self.0.screen();
        let (rows, cols) = (s.size().0.get(), s.size().1.get());
        let mut d = Dump::default();
        for r in 0..rows {
            let mut line = String::new();
            for c in 0..cols {
                let cell = s.cell(r, c).unwrap();
                if cell.is_wide_continuation() {
                    continue;
                }
                let t = cell.contents();
                if t.is_empty() {
                    line.push(' ');
                } else {
                    line.push_str(t);
                }
                let mut a = Vec::new();
                if cell.bold() {
                    a.push("bold".to_string());
                }
                if cell.dim() {
                    a.push("dim".to_string());
                }
                if cell.italic() {
                    a.push("italic".to_string());
                }
                if cell.underline() {
                    a.push("underline".to_string());
                }
                if cell.inverse() {
                    a.push("inverse".to_string());
                }
                if let Some(f) = vcolor(cell.fgcolor()) {
                    a.push(format!("fg={f}"));
                }
                if let Some(b) = vcolor(cell.bgcolor()) {
                    a.push(format!("bg={b}"));
                }
                if !a.is_empty() {
                    d.styles.push(format!("{r},{c}:{}", a.join(",")));
                }
            }
            d.rows.push(line.trim_end().to_string());
        }
        d.cursor = s.cursor_position();
        d.cursor_visible = !s.hide_cursor();
        d.alt = s.alternate_screen();
        d.app_cursor = s.application_cursor();
        d.app_keypad = s.application_keypad();
        d.bracketed = s.bracketed_paste();
        d.mouse = format!("{:?}", s.mouse_protocol_mode());
        d.mouse_enc = format!("{:?}", s.mouse_protocol_encoding());
        let extra = self.0.callbacks();
        d.focus = Some(extra.focus);
        d.sync = Some(extra.sync);
        d.kitty = Some(extra.kitty_stack.last().copied().unwrap_or(0));
        d.scrollback_len = s.scrollback_len();
        d
    }
}

// ----------------------------------------------------------- alacritty

use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color as AColor, Processor, StdSyncHandler, Timeout};
use std::time::Duration;

struct Quiet;
impl EventListener for Quiet {}

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

/// Runs synchronized-output sequences straight through (no timer).
#[derive(Default)]
pub struct PassThrough;
impl Timeout for PassThrough {
    fn set_timeout(&mut self, _: Duration) {}
    fn clear_timeout(&mut self) {}
    fn pending_timeout(&self) -> bool {
        false
    }
}

pub struct Alac<T: Timeout> {
    term: Term<Quiet>,
    proc: Processor<T>,
}

/// alacritty_terminal as shipped: sync output buffered behind a wall-clock timer.
pub type Alacritty = Alac<StdSyncHandler>;
/// alacritty_terminal with the timer removed (what `Screen` uses).
pub type AlacrittyPass = Alac<PassThrough>;

pub trait Label {
    const NAME: &'static str;
}
impl Label for StdSyncHandler {
    const NAME: &'static str = "alacritty_terminal (default sync timer)";
}
impl Label for PassThrough {
    const NAME: &'static str = "alacritty_terminal (pass-through sync)";
}

fn acolor(c: AColor) -> Option<String> {
    match c {
        AColor::Named(n) => {
            let i = n as usize;
            if i < 16 {
                Some(format!("{i}"))
            } else {
                None
            }
        }
        AColor::Indexed(i) => Some(format!("{i}")),
        AColor::Spec(rgb) => Some(format!("{}/{}/{}", rgb.r, rgb.g, rgb.b)),
    }
}

impl<T: Timeout + Label> Engine for Alac<T> {
    fn name() -> &'static str {
        T::NAME
    }
    fn new(cols: u16, rows: u16, scrollback: usize) -> Self {
        let cfg = Config {
            scrolling_history: scrollback,
            kitty_keyboard: true,
            ..Config::default()
        };
        let size = Size {
            cols: cols as usize,
            rows: rows as usize,
        };
        Alac {
            term: Term::new(cfg, &size, Quiet),
            proc: Processor::<T>::new(),
        }
    }
    fn feed(&mut self, bytes: &[u8]) {
        self.proc.advance(&mut self.term, bytes);
    }
    fn resize(&mut self, cols: u16, rows: u16) {
        self.term.resize(Size {
            cols: cols as usize,
            rows: rows as usize,
        });
    }
    fn dump(&self) -> Dump {
        let t = &self.term;
        let (rows, cols) = (t.screen_lines(), t.columns());
        let mut d = Dump::default();
        for r in 0..rows {
            let mut line = String::new();
            for c in 0..cols {
                let cell = &t.grid()[Point::new(Line(r as i32), Column(c))];
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    continue;
                }
                line.push(cell.c);
                if let Some(z) = cell.zerowidth() {
                    line.extend(z.iter());
                }
                let mut a = Vec::new();
                if cell.flags.contains(Flags::BOLD) {
                    a.push("bold".to_string());
                }
                if cell.flags.contains(Flags::DIM) {
                    a.push("dim".to_string());
                }
                if cell.flags.contains(Flags::ITALIC) {
                    a.push("italic".to_string());
                }
                if cell.flags.intersects(Flags::ALL_UNDERLINES) {
                    a.push("underline".to_string());
                }
                if cell.flags.contains(Flags::INVERSE) {
                    a.push("inverse".to_string());
                }
                if cell.flags.contains(Flags::HIDDEN) {
                    a.push("hidden".to_string());
                }
                if cell.flags.contains(Flags::STRIKEOUT) {
                    a.push("strike".to_string());
                }
                if let Some(f) = acolor(cell.fg) {
                    a.push(format!("fg={f}"));
                }
                if let Some(b) = acolor(cell.bg) {
                    a.push(format!("bg={b}"));
                }
                if !a.is_empty() {
                    d.styles.push(format!("{r},{c}:{}", a.join(",")));
                }
            }
            d.rows.push(line.trim_end().to_string());
        }
        let p = t.grid().cursor.point;
        d.cursor = (p.line.0 as u16, p.column.0 as u16);
        let m = t.mode();
        d.cursor_visible = m.contains(TermMode::SHOW_CURSOR);
        d.alt = m.contains(TermMode::ALT_SCREEN);
        d.app_cursor = m.contains(TermMode::APP_CURSOR);
        d.app_keypad = m.contains(TermMode::APP_KEYPAD);
        d.bracketed = m.contains(TermMode::BRACKETED_PASTE);
        d.mouse = if m.contains(TermMode::MOUSE_MOTION) {
            "AnyMotion"
        } else if m.contains(TermMode::MOUSE_DRAG) {
            "ButtonMotion"
        } else if m.contains(TermMode::MOUSE_REPORT_CLICK) {
            "PressRelease"
        } else {
            "None"
        }
        .to_string();
        d.mouse_enc = if m.contains(TermMode::SGR_MOUSE) {
            "Sgr"
        } else if m.contains(TermMode::UTF8_MOUSE) {
            "Utf8"
        } else {
            "Default"
        }
        .to_string();
        d.focus = Some(m.contains(TermMode::FOCUS_IN_OUT));
        // Synchronized output is buffered inside the processor and never
        // reaches `Term`, so the mode itself is not readable.
        d.sync = None;
        let mut k = 0u8;
        for (flag, bit) in [
            (TermMode::DISAMBIGUATE_ESC_CODES, 1u8),
            (TermMode::REPORT_EVENT_TYPES, 2),
            (TermMode::REPORT_ALTERNATE_KEYS, 4),
            (TermMode::REPORT_ALL_KEYS_AS_ESC, 8),
            (TermMode::REPORT_ASSOCIATED_TEXT, 16),
        ] {
            if m.contains(flag) {
                k |= bit;
            }
        }
        d.kitty = Some(k);
        d.scrollback_len = t.history_size();
        d
    }
}
