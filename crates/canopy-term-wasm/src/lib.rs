//! `canopy-term-core` for JavaScript: the same Ghostty engine the native
//! window uses, built for `wasm32-unknown-unknown` and loaded by the webview
//! (desktop tabs), the browser portal and the remote host's Node server.
//!
//! The page owns the bytes (PTY output arrives over whatever transport the tab
//! already uses) and feeds them to [`Terminal::advance`]; it reads the screen
//! back as packed cells and draws them itself. Nothing here touches the DOM.
//!
//! # Packed cells
//!
//! [`Terminal::cells`] and [`Terminal::scrollback_cells`] return a
//! `Uint32Array` with [`WORDS_PER_CELL`] words per cell, row-major:
//!
//! | word | meaning |
//! | --- | --- |
//! | 0 | the first Unicode scalar (`0` for the right half of a wide character) |
//! | 1 | foreground, see [`pack_color`] |
//! | 2 | background, see [`pack_color`] |
//! | 3 | `attrs` (bits 0-15, `frame::Attrs`) \| underline style << 16 (bits 16-18) |
//! | 4 | cluster index (0: `ch` is the whole text; else an index into `clusters()`) |
//! | 5 | underline colour, see [`pack_color`] |
//!
//! The same packing feeds [`digest`], which the parity test computes natively
//! and in wasm over the same byte streams: identical digests mean the browser
//! build draws exactly what the native engine draws.

use canopy_term_core::frame::{Cell, Color, CursorShape, Frame, MouseEncoding, MouseMode};
use canopy_term_core::{Event, PromptKind, Row, Screen};
use canopy_term_input::{
    encode_focus, encode_key, encode_mouse, encode_paste_with, Key, KeyEvent, KeyEventKind, Keypad,
    ModifierKey, Mods, MouseButton, MouseEvent, MouseEventKind,
};
use wasm_bindgen::prelude::*;

/// Words per packed cell.
pub const WORDS_PER_CELL: usize = 6;

/// `0` default; `0x0100_00nn` palette index `nn`; `0x0200_0000 | 0xRRGGBB`.
pub fn pack_color(c: Color) -> u32 {
    match c {
        Color::Default => 0,
        Color::Indexed(n) => 0x0100_0000 | n as u32,
        Color::Rgb(r, g, b) => 0x0200_0000 | (r as u32) << 16 | (g as u32) << 8 | b as u32,
    }
}

pub fn pack_cell(cell: &Cell) -> [u32; WORDS_PER_CELL] {
    [
        cell.ch as u32,
        pack_color(cell.fg),
        pack_color(cell.bg),
        cell.attrs.0 as u32 | (cell.underline as u32) << 16,
        cell.cluster,
        pack_color(cell.underline_color),
    ]
}

fn pack_cells(cells: &[Cell], out: &mut Vec<u32>) {
    out.reserve(cells.len() * WORDS_PER_CELL);
    for c in cells {
        out.extend_from_slice(&pack_cell(c));
    }
}

/// FNV-1a, 64 bit: small, dependency-free and identical on every target.
struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Fnv(0xcbf2_9ce4_8422_2325)
    }
    fn bytes(&mut self, b: &[u8]) {
        for &x in b {
            self.0 ^= x as u64;
            self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
        }
    }
    fn u32(&mut self, v: u32) {
        self.bytes(&v.to_le_bytes());
    }
    fn str(&mut self, s: &str) {
        self.u32(s.len() as u32);
        self.bytes(s.as_bytes());
    }
}

fn hash_cells(h: &mut Fnv, cells: &[Cell], clusters: &[String]) {
    for c in cells {
        for w in pack_cell(c) {
            h.u32(w);
        }
        if c.cluster != 0 {
            h.str(clusters.get(c.cluster as usize).map_or("", String::as_str));
        }
    }
}

/// Everything a renderer can see: the visible grid with its clusters, the
/// cursor, the modes, the title, the alternate-screen flag and every
/// scrollback line. Same value on every target for the same input.
pub fn digest(screen: &Screen) -> String {
    let f = screen.frame();
    let mut h = Fnv::new();
    h.u32(f.cols as u32);
    h.u32(f.rows as u32);
    hash_cells(&mut h, &f.cells, &f.clusters);
    h.u32(f.cursor.row as u32);
    h.u32(f.cursor.col as u32);
    h.u32(f.cursor.shape as u32);
    h.u32(f.cursor.visible as u32);
    let m = f.modes;
    for v in [
        m.mouse as u32,
        m.mouse_encoding as u32,
        m.bracketed_paste as u32,
        m.app_cursor_keys as u32,
        m.app_keypad as u32,
        m.focus_events as u32,
        m.sync_output as u32,
        m.kitty_keyboard as u32,
    ] {
        h.u32(v);
    }
    h.u32(f.alt_screen as u32);
    h.str(f.title.as_deref().unwrap_or(""));
    let n = screen.scrollback_len();
    h.u32(n as u32);
    let mut start = 0;
    while start < n {
        for row in screen.scrollback_rows(start, 512) {
            hash_cells(&mut h, &row.cells, &row.clusters);
        }
        start += 512;
    }
    format!("{:016x}", h.0)
}

/// The visible screen as text, one line per row, trailing blanks trimmed.
pub fn visible_text(frame: &Frame) -> String {
    let mut out = String::new();
    for r in 0..frame.rows {
        let start = r as usize * frame.cols as usize;
        let row = Row {
            cells: frame.cells[start..start + frame.cols as usize].to_vec(),
            clusters: frame.clusters.clone(),
        };
        if r > 0 {
            out.push('\n');
        }
        out.push_str(&row.text());
    }
    out
}

fn json_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn events_json(events: &[Event]) -> String {
    let mut out = String::from("[");
    for (i, e) in events.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        match e {
            Event::Bell => out.push_str(r#"{"t":"bell"}"#),
            Event::ClipboardWrite { selection, data } => {
                out.push_str(r#"{"t":"clipboard-write","selection":"#);
                json_str(selection, &mut out);
                out.push_str(r#","data":"#);
                json_str(&String::from_utf8_lossy(data), &mut out);
                out.push('}');
            }
            Event::ClipboardReadRequest { selection } => {
                out.push_str(r#"{"t":"clipboard-read","selection":"#);
                json_str(selection, &mut out);
                out.push('}');
            }
            Event::PromptMark(p) => {
                let kind = match p.kind {
                    PromptKind::PromptStart => "A",
                    PromptKind::PromptEnd => "B",
                    PromptKind::OutputStart => "C",
                    PromptKind::CommandEnd => "D",
                };
                out.push_str(&format!(
                    r#"{{"t":"prompt","kind":"{kind}","row":{}"#,
                    p.row
                ));
                if let Some(code) = p.exit_code {
                    out.push_str(&format!(r#","exit":{code}"#));
                }
                out.push('}');
            }
        }
    }
    out.push(']');
    out
}

/// A key name from the page (see [`Terminal::encode_key`]).
fn parse_key(name: &str) -> Option<Key> {
    let mut chars = name.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return Some(Key::Char(c));
    }
    if let Some(n) = name.strip_prefix('F').and_then(|n| n.parse::<u8>().ok()) {
        return Some(Key::F(n));
    }
    if let Some(k) = name.strip_prefix("Kp") {
        return Some(Key::Keypad(match k {
            "0" => Keypad::Num0,
            "1" => Keypad::Num1,
            "2" => Keypad::Num2,
            "3" => Keypad::Num3,
            "4" => Keypad::Num4,
            "5" => Keypad::Num5,
            "6" => Keypad::Num6,
            "7" => Keypad::Num7,
            "8" => Keypad::Num8,
            "9" => Keypad::Num9,
            "Decimal" => Keypad::Decimal,
            "Divide" => Keypad::Divide,
            "Multiply" => Keypad::Multiply,
            "Subtract" => Keypad::Subtract,
            "Add" => Keypad::Add,
            "Enter" => Keypad::Enter,
            "Equal" => Keypad::Equal,
            "Separator" => Keypad::Separator,
            _ => return None,
        }));
    }
    if let Some(k) = name.strip_prefix("Mod") {
        return Some(Key::Modifier(match k {
            "LeftShift" => ModifierKey::LeftShift,
            "LeftControl" => ModifierKey::LeftControl,
            "LeftAlt" => ModifierKey::LeftAlt,
            "LeftSuper" => ModifierKey::LeftSuper,
            "RightShift" => ModifierKey::RightShift,
            "RightControl" => ModifierKey::RightControl,
            "RightAlt" => ModifierKey::RightAlt,
            "RightSuper" => ModifierKey::RightSuper,
            _ => return None,
        }));
    }
    Some(match name {
        "Escape" => Key::Escape,
        "Enter" => Key::Enter,
        "Tab" => Key::Tab,
        "Backspace" => Key::Backspace,
        "Insert" => Key::Insert,
        "Delete" => Key::Delete,
        "Left" => Key::Left,
        "Right" => Key::Right,
        "Up" => Key::Up,
        "Down" => Key::Down,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        "Home" => Key::Home,
        "End" => Key::End,
        "CapsLock" => Key::CapsLock,
        "ScrollLock" => Key::ScrollLock,
        "NumLock" => Key::NumLock,
        "PrintScreen" => Key::PrintScreen,
        "Pause" => Key::Pause,
        "Menu" => Key::Menu,
        _ => return None,
    })
}

/// One terminal screen. Feed it PTY output, read the screen back.
#[wasm_bindgen]
pub struct Terminal {
    screen: Screen,
    /// The last frame read by [`Terminal::refresh`]; the getters read from it
    /// so one engine round trip serves a whole paint.
    frame: Frame,
}

#[wasm_bindgen]
impl Terminal {
    #[wasm_bindgen(constructor)]
    pub fn new(cols: u16, rows: u16, scrollback: usize) -> Terminal {
        let screen = Screen::with_scrollback(cols, rows, scrollback);
        let frame = screen.frame();
        Terminal { screen, frame }
    }

    /// A screen brought to the state of a [`Terminal::snapshot`].
    pub fn restore(cols: u16, rows: u16, snapshot: &[u8]) -> Terminal {
        let screen = Screen::restore(cols, rows, snapshot);
        let frame = screen.frame();
        Terminal { screen, frame }
    }

    /// Feed PTY output. Any split of the same stream gives the same screen.
    pub fn advance(&mut self, bytes: &[u8]) {
        self.screen.advance(bytes);
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.screen.resize(cols, rows);
    }

    /// Answers the program asked for (device attributes, cursor position,
    /// colour queries...), to be written back to the PTY. Drain after every
    /// `advance`.
    pub fn take_replies(&mut self) -> Vec<u8> {
        self.screen.take_replies()
    }

    /// Bell, OSC 52 and OSC 133 events since the last call, as JSON.
    pub fn take_events(&mut self) -> String {
        events_json(&self.screen.take_events())
    }

    /// The 16 ANSI colours as 0xRRGGBB, for answering OSC 4 queries.
    pub fn set_default_palette(&mut self, colors: &[u32]) {
        let mut p = [(0u8, 0u8, 0u8); 16];
        for (i, c) in colors.iter().take(16).enumerate() {
            p[i] = ((c >> 16) as u8, (c >> 8) as u8, *c as u8);
        }
        self.screen.set_default_palette(p);
    }

    /// Default fg, bg and cursor as 0xRRGGBB (negative: unset), for answering
    /// OSC 10/11/12 queries.
    pub fn set_reply_colors(&mut self, fg: i32, bg: i32, cursor: i32) {
        let rgb = |v: i32| (v >= 0).then(|| ((v >> 16) as u8, (v >> 8) as u8, v as u8));
        self.screen.set_reply_colors(rgb(fg), rgb(bg), rgb(cursor));
    }

    /// Read the current screen into this handle. Returns its sequence number;
    /// the getters below describe this frame until the next `refresh`.
    pub fn refresh(&mut self) -> f64 {
        self.frame = self.screen.frame();
        self.frame.seq as f64
    }

    pub fn cols(&self) -> u16 {
        self.frame.cols
    }

    pub fn rows(&self) -> u16 {
        self.frame.rows
    }

    /// The visible grid, packed (see the crate docs).
    pub fn cells(&self) -> Vec<u32> {
        let mut out = Vec::new();
        pack_cells(&self.frame.cells, &mut out);
        out
    }

    /// Cluster texts; index 0 is unused.
    pub fn clusters(&self) -> Vec<String> {
        self.frame.clusters.clone()
    }

    /// `[row, col, shape (0 block, 1 underline, 2 bar), visible, blinking]`.
    pub fn cursor(&self) -> Vec<u32> {
        let c = self.frame.cursor;
        let shape = match c.shape {
            CursorShape::Block => 0,
            CursorShape::Underline => 1,
            CursorShape::Bar => 2,
        };
        vec![
            c.row as u32,
            c.col as u32,
            shape,
            c.visible as u32,
            self.screen.cursor_blinking() as u32,
        ]
    }

    /// `[mouse (0 off, 1 press, 2 normal, 3 drag, 4 any), encoding (0 default,
    /// 1 utf8, 2 sgr), bracketed_paste, app_cursor_keys, app_keypad,
    /// focus_events, sync_output, kitty_keyboard, alt_screen]`.
    pub fn modes(&self) -> Vec<u32> {
        let m = self.frame.modes;
        let mouse = match m.mouse {
            MouseMode::Off => 0,
            MouseMode::Press => 1,
            MouseMode::Normal => 2,
            MouseMode::Drag => 3,
            MouseMode::Any => 4,
        };
        let enc = match m.mouse_encoding {
            MouseEncoding::Default => 0,
            MouseEncoding::Utf8 => 1,
            MouseEncoding::Sgr => 2,
        };
        vec![
            mouse,
            enc,
            m.bracketed_paste as u32,
            m.app_cursor_keys as u32,
            m.app_keypad as u32,
            m.focus_events as u32,
            m.sync_output as u32,
            m.kitty_keyboard as u32,
            self.frame.alt_screen as u32,
        ]
    }

    pub fn title(&self) -> Option<String> {
        self.frame.title.clone()
    }

    /// Rows changed since frame `since`, as `[first, last, first, last, ...]`
    /// inclusive; empty and `damage_full()` true when everything changed.
    pub fn damage_rows(&self, since: f64) -> Vec<u16> {
        let d = self.screen.damage_since(since as u64);
        if d.full {
            return Vec::new();
        }
        d.rows.iter().flat_map(|&(a, b)| [a, b]).collect()
    }

    pub fn damage_full(&self, since: f64) -> bool {
        self.screen.damage_since(since as u64).full
    }

    pub fn scrollback_len(&self) -> usize {
        self.screen.scrollback_len()
    }

    /// `count` scrollback lines from `start` (0 is the oldest), packed, each
    /// padded or cut to the current width. Clusters come from
    /// [`Terminal::scrollback_clusters`] with the same arguments.
    pub fn scrollback_cells(&self, start: usize, count: usize) -> Vec<u32> {
        let cols = self.frame.cols as usize;
        let mut out = Vec::new();
        for row in self.screen.scrollback_rows(start, count) {
            let mut cells = row.cells;
            cells.resize(cols, Cell::default());
            pack_cells(&cells, &mut out);
        }
        out
    }

    /// The scrollback lines' text, one string per line.
    pub fn scrollback_text(&self, start: usize, count: usize) -> Vec<String> {
        self.screen
            .scrollback_rows(start, count)
            .iter()
            .map(Row::text)
            .collect()
    }

    /// Cluster texts of each scrollback line, flattened as `[line0 count,
    /// ...line0 clusters, line1 count, ...]` (index 0 of each line included).
    pub fn scrollback_clusters(&self, start: usize, count: usize) -> Vec<String> {
        let mut out = Vec::new();
        for row in self.screen.scrollback_rows(start, count) {
            out.push(row.clusters.len().to_string());
            out.extend(row.clusters);
        }
        out
    }

    /// The OSC 8 link target on a visible cell.
    pub fn hyperlink_at(&self, row: u16, col: u16) -> Option<String> {
        self.screen.hyperlink_at(row, col)
    }

    /// Visible screen as text (rows joined with `\n`).
    pub fn text(&self) -> String {
        visible_text(&self.frame)
    }

    /// Escape sequences that bring a fresh screen to this one's visible state.
    pub fn snapshot(&self) -> Vec<u8> {
        self.screen.snapshot()
    }

    /// See [`digest`].
    pub fn digest(&self) -> String {
        digest(&self.screen)
    }

    /// The bytes a key event sends to the program under its current modes
    /// (cursor and keypad application modes, kitty keyboard flags); empty
    /// when the event sends nothing.
    ///
    /// `key` is a single character (the unshifted character of the key) or a
    /// name: `Escape`, `Enter`, `Tab`, `Backspace`, `Insert`, `Delete`,
    /// `Left`, `Right`, `Up`, `Down`, `PageUp`, `PageDown`, `Home`, `End`,
    /// `CapsLock`, `ScrollLock`, `NumLock`, `PrintScreen`, `Pause`, `Menu`,
    /// `F1`..`F35`, `Kp<name>` for the keypad (`Kp0`..`Kp9`, `KpDecimal`,
    /// `KpDivide`, `KpMultiply`, `KpSubtract`, `KpAdd`, `KpEnter`, `KpEqual`)
    /// and `Mod<name>` for a modifier key (`ModLeftShift`...). An unknown
    /// name sends nothing.
    ///
    /// `kind`: 0 press, 1 repeat, 2 release. `mods`: shift 1, alt 2, ctrl 4,
    /// super 8, caps lock 64, num lock 128. `text` is what the key types
    /// (empty for none); `shifted` and `base` are the kitty alternates as
    /// code points (0 for none).
    pub fn encode_key(
        &self,
        key: &str,
        mods: u8,
        kind: u8,
        text: &str,
        shifted: u32,
        base: u32,
    ) -> Vec<u8> {
        let mut out = Vec::new();
        let Some(key) = parse_key(key) else {
            return out;
        };
        let mut ev = KeyEvent::new(key).with_mods(Mods(mods)).with_kind(match kind {
            1 => KeyEventKind::Repeat,
            2 => KeyEventKind::Release,
            _ => KeyEventKind::Press,
        });
        if !text.is_empty() {
            ev = ev.with_text(text);
        }
        if let Some(c) = char::from_u32(shifted).filter(|_| shifted != 0) {
            ev = ev.with_shifted_key(c);
        }
        if let Some(c) = char::from_u32(base).filter(|_| base != 0) {
            ev = ev.with_base_layout_key(c);
        }
        encode_key(&ev, self.frame.modes, &mut out);
        out
    }

    /// The report a mouse event sends under the program's mouse mode and
    /// encoding; empty when the mode does not report it.
    ///
    /// `kind`: 0 press (or one wheel step), 1 release, 2 motion. `button`: 0
    /// left, 1 middle, 2 right, 3 none (motion only), 4 wheel up, 5 wheel
    /// down, 6 wheel left, 7 wheel right, 8 back, 9 forward. `col` and `row`
    /// are 0-based cells.
    pub fn encode_mouse(&self, kind: u8, button: u8, col: u16, row: u16, mods: u8) -> Vec<u8> {
        let mut out = Vec::new();
        let b = match button {
            0 => Some(MouseButton::Left),
            1 => Some(MouseButton::Middle),
            2 => Some(MouseButton::Right),
            4 => Some(MouseButton::WheelUp),
            5 => Some(MouseButton::WheelDown),
            6 => Some(MouseButton::WheelLeft),
            7 => Some(MouseButton::WheelRight),
            8 => Some(MouseButton::Back),
            9 => Some(MouseButton::Forward),
            _ => None,
        };
        let kind = match (kind, b) {
            (2, held) => MouseEventKind::Motion(held),
            (1, Some(b)) => MouseEventKind::Release(b),
            (0, Some(b)) => MouseEventKind::Press(b),
            _ => return out,
        };
        let ev = MouseEvent {
            kind,
            col,
            row,
            mods: Mods(mods),
        };
        encode_mouse(&ev, self.frame.modes, &mut out);
        out
    }

    /// A paste as the program should receive it: bracketed when it asked for
    /// that, newlines as Enter otherwise. `strip_controls` removes control
    /// characters (ESC included) so pasted text can neither end the bracket
    /// early nor type key sequences.
    pub fn encode_paste(&self, text: &str, strip_controls: bool) -> Vec<u8> {
        let mut out = Vec::new();
        encode_paste_with(text, self.frame.modes, strip_controls, &mut out);
        out
    }

    /// The focus report (`CSI I` / `CSI O`); empty unless the program asked
    /// for focus events.
    pub fn encode_focus(&self, focused: bool) -> Vec<u8> {
        let mut out = Vec::new();
        encode_focus(focused, self.frame.modes, &mut out);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_pack_into_disjoint_ranges() {
        assert_eq!(pack_color(Color::Default), 0);
        assert_eq!(pack_color(Color::Indexed(9)), 0x0100_0009);
        assert_eq!(pack_color(Color::Rgb(1, 2, 3)), 0x0201_0203);
    }

    #[test]
    fn text_colour_and_replies_come_back() {
        let mut t = Terminal::new(20, 3, 100);
        t.advance(b"hi \x1b[31mred\x1b[0m\x1b[c");
        t.refresh();
        assert_eq!(t.text().lines().next(), Some("hi red"));
        let cells = t.cells();
        // 'r' at column 3: indexed red foreground.
        assert_eq!(cells[3 * WORDS_PER_CELL], 'r' as u32);
        assert_eq!(cells[3 * WORDS_PER_CELL + 1], 0x0100_0001);
        assert!(!t.take_replies().is_empty(), "DA1 gets an answer");
    }

    #[test]
    fn digest_is_split_independent() {
        let stream: Vec<u8> = (0..2000)
            .flat_map(|i| format!("\x1b[3{}mline {i}\x1b[0m\r\n", i % 8).into_bytes())
            .collect();
        let mut a = Terminal::new(80, 24, 1000);
        a.advance(&stream);
        let mut b = Terminal::new(80, 24, 1000);
        for chunk in stream.chunks(7) {
            b.advance(chunk);
        }
        assert_eq!(a.digest(), b.digest());
        assert!(a.scrollback_len() > 0);
    }

    #[test]
    fn events_are_json() {
        let mut t = Terminal::new(20, 3, 0);
        t.advance(b"\x07\x1b]52;c;aGk=\x07");
        assert_eq!(
            t.take_events(),
            r#"[{"t":"bell"},{"t":"clipboard-write","selection":"c","data":"hi"}]"#
        );
    }
}
