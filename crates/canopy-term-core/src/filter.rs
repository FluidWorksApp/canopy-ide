//! A byte filter in front of the engine.
//!
//! It walks the stream with the same state machine as the engine's parser
//! (vte 0.15, `lib.rs`), so it sees exactly the sequences the engine sees,
//! split anywhere. It does two jobs:
//!
//! * **Bounds.** OSC bodies are cut at [`MAX_OSC_BYTES`] (titles at
//!   [`MAX_TITLE_BYTES`]); the engine's parser otherwise buffers an OSC body
//!   without limit until it is terminated. Terminators always pass.
//! * **State the engine does not keep or keep safely.** Synchronized output
//!   (2026), X10 mouse (9), the scroll region (DECSTBM, private in the
//!   engine), and the kitty keyboard stacks (the engine's push at its depth
//!   limit removes from the wrong stack and can panic, so the engine's kitty
//!   support is switched off and this tracker answers `CSI ? u` itself).
//!
//! The filter never holds bytes back or reorders them; it only drops OSC bytes
//! past the cap. Everything else passes through unchanged.

use std::fmt::Write as _;

/// Longest OSC body passed to the engine, in bytes.
pub const MAX_OSC_BYTES: usize = 64 * 1024;
/// Longest title (OSC 0, 1, 2 payload after the first `;`) passed on, in bytes.
pub const MAX_TITLE_BYTES: usize = 4096;
/// Deepest kitty keyboard stack kept per screen; the oldest entry is dropped.
pub const KITTY_STACK_MAX: usize = 256;

/// vte's limits: more than this many parameters (or two intermediates) and the
/// sequence is flagged ignored, which the engine does not act on.
const MAX_PARAMS: usize = 32;
const MAX_INTERMEDIATES: usize = 2;

/// What happened at a point in the filtered output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    /// `ESC c` ended here.
    Reset,
    /// Bytes to send back to the program, after everything before this point.
    Reply(String),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Kitty {
    /// The flags in effect.
    pub active: u8,
    pub stack: Vec<u8>,
}

impl Kitty {
    fn push(&mut self, flags: u8) {
        if self.stack.len() >= KITTY_STACK_MAX {
            self.stack.remove(0);
        }
        self.stack.push(flags);
        self.active = flags;
    }
    fn pop(&mut self, n: usize) {
        let len = self.stack.len().saturating_sub(n);
        self.stack.truncate(len);
        self.active = self.stack.last().copied().unwrap_or(0);
    }
}

/// Everything tracked, kept separate from the byte walking so a test can drive
/// the same tracker from the engine's own parser and compare.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Tracker {
    pub sync: bool,
    pub x10: bool,
    pub rows: u16,
    /// Scroll region as the engine stores it: rows `start..end`, zero-based,
    /// end exclusive. `None` is the whole screen.
    pub region: Option<(u16, u16)>,
    pub alt: bool,
    /// Kitty keyboard state for the main (0) and alternate (1) screens.
    pub kitty: [Kitty; 2],
}

impl Tracker {
    pub fn new(rows: u16) -> Self {
        Tracker {
            rows,
            ..Tracker::default()
        }
    }

    pub fn kitty_active(&self) -> u8 {
        self.kitty[self.alt as usize].active
    }

    pub fn reset(&mut self) {
        *self = Tracker::new(self.rows);
    }

    pub fn resize(&mut self, rows: u16) {
        self.rows = rows;
        // The engine resets the scroll region on resize.
        self.region = None;
    }

    fn switch_screen(&mut self, alt: bool) {
        if self.alt != alt {
            self.alt = alt;
            let k = &mut self.kitty[alt as usize];
            k.active = k.stack.last().copied().unwrap_or(0);
        }
    }

    /// A CSI the engine acts on (not flagged ignored). `params` holds the
    /// first value of each parameter, as vte groups them.
    pub fn csi(&mut self, params: &[u16], intermediates: &[u8], action: char) -> Option<String> {
        // vte's `next_param_or`: a missing or zero parameter takes the default.
        let nth = |i: usize, default: u16| match params.get(i) {
            Some(&p) if p != 0 => p,
            _ => default,
        };
        match (intermediates, action) {
            ([b'?'], 'h') | ([b'?'], 'l') => {
                let on = action == 'h';
                for &p in params {
                    match p {
                        2026 => self.sync = on,
                        9 => self.x10 = on,
                        // Any of the other mouse modes supersedes X10.
                        1000 | 1002 | 1003 => self.x10 = false,
                        // DECCOLM: the engine clears the region (and the grid).
                        3 => self.region = None,
                        1049 => self.switch_screen(on),
                        _ => {}
                    }
                }
            }
            ([], 'r') => {
                // DECSTBM, mirroring the engine's `set_scrolling_region`.
                let top = nth(0, 1) as u32;
                let bottom = match params.get(1) {
                    Some(&p) if p != 0 => p as u32,
                    _ => self.rows as u32,
                };
                if top < bottom {
                    let rows = self.rows as u32;
                    let start = (top - 1).min(rows) as u16;
                    let end = bottom.min(rows) as u16;
                    self.region = if (start, end) == (0, self.rows) {
                        None
                    } else {
                        Some((start, end))
                    };
                }
            }
            ([b'>'], 'u') => {
                let flags = (nth(0, 0) as u8) & 0x1f;
                self.kitty[self.alt as usize].push(flags);
            }
            ([b'<'], 'u') => {
                self.kitty[self.alt as usize].pop(nth(0, 1) as usize);
            }
            ([b'='], 'u') => {
                let flags = (nth(0, 0) as u8) & 0x1f;
                let k = &mut self.kitty[self.alt as usize];
                k.active = match nth(1, 1) {
                    2 => k.active | flags,
                    3 => k.active & !flags,
                    _ => flags,
                };
            }
            ([b'?'], 'u') => {
                let mut reply = String::new();
                let _ = write!(reply, "\x1b[?{}u", self.kitty_active());
                return Some(reply);
            }
            _ => {}
        }
        None
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum St {
    Ground,
    Esc,
    EscInter,
    CsiEntry,
    CsiParam,
    CsiInter,
    CsiIgnore,
    Osc,
    DcsEntry,
    DcsParam,
    DcsInter,
    DcsIgnore,
    DcsPass,
    SosPmApc,
}

pub struct Filter {
    st: St,
    pub tracker: Tracker,
    // CSI being parsed.
    params: Vec<u16>,
    param_len: usize,
    cur: u16,
    group_first: u16,
    in_sub: bool,
    inter: Vec<u8>,
    ignoring: bool,
    // OSC being passed.
    osc_num: u32,
    osc_head: bool,
    osc_payload: usize,
    osc_total: usize,
    osc_dropping: bool,
}

/// Offset of the first ESC in `s`, or `s.len()`. Eight bytes at a time.
#[inline]
fn find_esc(s: &[u8]) -> usize {
    const LO: u64 = 0x0101_0101_0101_0101;
    const HI: u64 = 0x8080_8080_8080_8080;
    let mut chunks = s.chunks_exact(8);
    let mut base = 0;
    for c in &mut chunks {
        let w = u64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]) ^ (LO * 0x1B);
        if w.wrapping_sub(LO) & !w & HI != 0 {
            break;
        }
        base += 8;
    }
    base + s[base..]
        .iter()
        .position(|&b| b == 0x1B)
        .unwrap_or(s.len() - base)
}

fn is_exec(b: u8) -> bool {
    matches!(b, 0x00..=0x17 | 0x19 | 0x1C..=0x1F)
}

impl Filter {
    pub fn new(rows: u16) -> Self {
        Filter {
            st: St::Ground,
            tracker: Tracker::new(rows),
            params: Vec::with_capacity(MAX_PARAMS),
            param_len: 0,
            cur: 0,
            group_first: 0,
            in_sub: false,
            inter: Vec::with_capacity(MAX_INTERMEDIATES),
            ignoring: false,
            osc_num: 0,
            osc_head: true,
            osc_payload: 0,
            osc_total: 0,
            osc_dropping: false,
        }
    }

    fn reset_params(&mut self) {
        self.params.clear();
        self.param_len = 0;
        self.cur = 0;
        self.group_first = 0;
        self.in_sub = false;
        self.inter.clear();
        self.ignoring = false;
    }

    fn collect(&mut self, b: u8) {
        if self.inter.len() == MAX_INTERMEDIATES {
            self.ignoring = true;
        } else {
            self.inter.push(b);
        }
    }

    fn digit(&mut self, b: u8) {
        if self.param_len == MAX_PARAMS {
            self.ignoring = true;
        } else if !self.in_sub {
            self.cur = self
                .cur
                .saturating_mul(10)
                .saturating_add((b - b'0') as u16);
        }
    }

    fn param_sep(&mut self) {
        if self.param_len == MAX_PARAMS {
            self.ignoring = true;
        } else {
            let v = if self.in_sub {
                self.group_first
            } else {
                self.cur
            };
            self.params.push(v);
            self.param_len += 1;
            self.cur = 0;
            self.in_sub = false;
        }
    }

    fn subparam_sep(&mut self) {
        if self.param_len == MAX_PARAMS {
            self.ignoring = true;
        } else {
            if !self.in_sub {
                self.group_first = self.cur;
                self.in_sub = true;
            }
            self.param_len += 1;
        }
    }

    fn csi_dispatch(&mut self, action: u8, actions: &mut Vec<(usize, Action)>, at: usize) {
        if self.param_len == MAX_PARAMS {
            self.ignoring = true;
        } else {
            let v = if self.in_sub {
                self.group_first
            } else {
                self.cur
            };
            self.params.push(v);
        }
        self.st = St::Ground;
        if self.ignoring {
            return;
        }
        let params = std::mem::take(&mut self.params);
        let inter = std::mem::take(&mut self.inter);
        if let Some(reply) = self.tracker.csi(&params, &inter, action as char) {
            actions.push((at, Action::Reply(reply)));
        }
        self.params = params;
        self.inter = inter;
    }

    /// The `anywhere` transitions vte applies in most states.
    fn anywhere(&mut self, b: u8) {
        match b {
            0x18 | 0x1A => self.st = St::Ground,
            0x1B => {
                self.reset_params();
                self.st = St::Esc;
            }
            _ => {}
        }
    }

    /// Filter `input` into `out`, recording actions at offsets into `out`.
    pub fn feed(&mut self, input: &[u8], out: &mut Vec<u8>, actions: &mut Vec<(usize, Action)>) {
        out.reserve(input.len());
        let mut i = 0;
        while i < input.len() {
            // Ground passes every byte through except ESC, which starts a
            // sequence: copy the whole run up to the next ESC at once.
            if self.st == St::Ground {
                let n = find_esc(&input[i..]);
                out.extend_from_slice(&input[i..i + n]);
                i += n;
                if i >= input.len() {
                    break;
                }
            }
            let b = input[i];
            i += 1;
            let mut keep = true;
            match self.st {
                St::Ground => {
                    if b == 0x1B {
                        self.reset_params();
                        self.st = St::Esc;
                    }
                }
                St::Esc => match b {
                    _ if is_exec(b) => {}
                    0x20..=0x2F => {
                        self.collect(b);
                        self.st = St::EscInter;
                    }
                    0x50 => {
                        self.reset_params();
                        self.st = St::DcsEntry;
                    }
                    0x58 | 0x5E | 0x5F => self.st = St::SosPmApc,
                    0x5B => {
                        self.reset_params();
                        self.st = St::CsiEntry;
                    }
                    0x5D => {
                        self.osc_num = 0;
                        self.osc_head = true;
                        self.osc_payload = 0;
                        self.osc_total = 0;
                        self.osc_dropping = false;
                        self.st = St::Osc;
                    }
                    0x30..=0x7E => {
                        self.st = St::Ground;
                        if b == b'c' && self.inter.is_empty() && !self.ignoring {
                            self.tracker.reset();
                            out.push(b);
                            actions.push((out.len(), Action::Reset));
                            continue;
                        }
                    }
                    0x18 | 0x1A => self.st = St::Ground,
                    _ => {}
                },
                St::EscInter => match b {
                    _ if is_exec(b) => {}
                    0x20..=0x2F => self.collect(b),
                    0x30..=0x7E => self.st = St::Ground,
                    0x7F => {}
                    _ => self.anywhere(b),
                },
                St::CsiEntry => match b {
                    _ if is_exec(b) => {}
                    0x20..=0x2F => {
                        self.collect(b);
                        self.st = St::CsiInter;
                    }
                    0x30..=0x39 => {
                        self.digit(b);
                        self.st = St::CsiParam;
                    }
                    0x3A => {
                        self.subparam_sep();
                        self.st = St::CsiParam;
                    }
                    0x3B => {
                        self.param_sep();
                        self.st = St::CsiParam;
                    }
                    0x3C..=0x3F => {
                        self.collect(b);
                        self.st = St::CsiParam;
                    }
                    0x40..=0x7E => self.csi_dispatch(b, actions, out.len() + 1),
                    _ => self.anywhere(b),
                },
                St::CsiParam => match b {
                    _ if is_exec(b) => {}
                    0x20..=0x2F => {
                        self.collect(b);
                        self.st = St::CsiInter;
                    }
                    0x30..=0x39 => self.digit(b),
                    0x3A => self.subparam_sep(),
                    0x3B => self.param_sep(),
                    0x3C..=0x3F => self.st = St::CsiIgnore,
                    0x40..=0x7E => self.csi_dispatch(b, actions, out.len() + 1),
                    0x7F => {}
                    _ => self.anywhere(b),
                },
                St::CsiInter => match b {
                    _ if is_exec(b) => {}
                    0x20..=0x2F => self.collect(b),
                    0x30..=0x3F => self.st = St::CsiIgnore,
                    0x40..=0x7E => self.csi_dispatch(b, actions, out.len() + 1),
                    _ => self.anywhere(b),
                },
                St::CsiIgnore => match b {
                    _ if is_exec(b) => {}
                    0x20..=0x3F | 0x7F => {}
                    0x40..=0x7E => self.st = St::Ground,
                    _ => self.anywhere(b),
                },
                St::Osc => match b {
                    0x07 | 0x18 | 0x1A => self.st = St::Ground,
                    0x1B => {
                        self.reset_params();
                        self.st = St::Esc;
                    }
                    // Other C0 bytes are ignored by the engine; pass them.
                    _ if b < 0x20 => {}
                    _ => keep = self.osc_byte(b),
                },
                St::DcsEntry | St::DcsParam | St::DcsInter => match b {
                    _ if is_exec(b) => {}
                    0x20..=0x2F => self.st = St::DcsInter,
                    0x30..=0x3F => {
                        self.st = match (self.st, b) {
                            (St::DcsInter, _) => St::DcsIgnore,
                            (St::DcsParam, 0x3C..=0x3F) => St::DcsIgnore,
                            _ => St::DcsParam,
                        }
                    }
                    0x40..=0x7E => self.st = St::DcsPass,
                    _ => self.anywhere(b),
                },
                St::DcsIgnore | St::SosPmApc => self.anywhere(b),
                St::DcsPass => match b {
                    0x18 | 0x1A | 0x9C => self.st = St::Ground,
                    0x1B => {
                        self.reset_params();
                        self.st = St::Esc;
                    }
                    _ => {}
                },
            }
            if keep {
                out.push(b);
            }
        }
    }

    /// Count an OSC body byte; false means drop it.
    fn osc_byte(&mut self, b: u8) -> bool {
        if self.osc_dropping {
            return false;
        }
        if self.osc_head {
            if b == b';' {
                self.osc_head = false;
            } else if b.is_ascii_digit() {
                self.osc_num = self
                    .osc_num
                    .saturating_mul(10)
                    .saturating_add((b - b'0') as u32);
            }
        } else {
            self.osc_payload += 1;
        }
        self.osc_total += 1;
        let cap_hit = self.osc_total > MAX_OSC_BYTES
            || (matches!(self.osc_num, 0..=2) && self.osc_payload > MAX_TITLE_BYTES);
        if cap_hit {
            // Finish a UTF-8 scalar already started so the kept text stays
            // valid, then drop the rest of the body.
            if (0x80..=0xBF).contains(&b) {
                return true;
            }
            self.osc_dropping = true;
            return false;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alacritty_terminal::vte::{Params, Parser, Perform};

    /// The engine's own parser driving the same tracker: the oracle.
    struct Oracle(Tracker);

    impl Perform for Oracle {
        fn csi_dispatch(&mut self, params: &Params, inter: &[u8], ignore: bool, action: char) {
            if ignore || inter.len() > 2 {
                return;
            }
            let p: Vec<u16> = params.iter().map(|p| p[0]).collect();
            let _ = self.0.csi(&p, inter, action);
        }
        fn esc_dispatch(&mut self, inter: &[u8], _ignore: bool, byte: u8) {
            if inter.is_empty() && byte == b'c' {
                self.0.reset();
            }
        }
    }

    fn noise(len: usize, seed: u64) -> Vec<u8> {
        let mut x = seed;
        let alphabet = b"\x1b[]?;:0123456789<=>!$ #mHJKrhlqucPX^_\\\x07\x18\x1a\x9c\r\n";
        (0..len)
            .map(|_| {
                x = x
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                let r = (x >> 33) as usize;
                if r % 5 == 0 {
                    (r >> 8) as u8
                } else {
                    alphabet[(r >> 8) % alphabet.len()]
                }
            })
            .collect()
    }

    fn fixtures() -> Vec<Vec<u8>> {
        let mut v: Vec<Vec<u8>> = [
            "\x1b[?2026h\x1b[?9h\x1b[2;5r\x1b[>5u\x1b[?1049h\x1b[>3u\x1b[=1;2u\x1b[?1049l",
            "\x1b[?1000;1049;2026h\x1b[;r\x1b[0;0r\x1b[9;2r\x1b[?3l\x1b[<u\x1b[<9u\x1bc",
            "\x1b[1:2:3;4r\x1b[?1;2;3;4;5;6;7;8;9;10;11;12;13;14;15;16;17;18;19;20;21;22;23;24;25;26;27;28;29;30;31;32;2026h",
            "\x1b[?1;2;3;4;5;6;7;8;9;10;11;12;13;14;15;16;17;18;19;20;21;22;23;24;25;26;27;28;29;30;31;2026h",
            "\x1bP1;2|data\x1b[?2026h\x1b\\\x1b]2;title\x1b[?9h\x07\x1b_apc\x1b[?9h",
            "\x1b[?$2026h\x1b[?2026$h\x1b[ ?2026h\x1b[>!5u\x1b#c\x1b(c",
        ]
        .iter()
        .map(|s| s.as_bytes().to_vec())
        .collect();
        for seed in 1..6 {
            v.push(noise(64 * 1024, seed));
        }
        v
    }

    fn oracle_state(input: &[u8], rows: u16) -> Tracker {
        let mut parser = Parser::new();
        let mut o = Oracle(Tracker::new(rows));
        parser.advance(&mut o, input);
        o.0
    }

    #[test]
    fn tracked_state_matches_the_engines_parser_at_any_split() {
        for input in fixtures() {
            let want = oracle_state(&input, 24);
            for chunk in [1usize, 2, 3, 7, 64, 4096, input.len().max(1)] {
                let mut f = Filter::new(24);
                let (mut out, mut actions) = (Vec::new(), Vec::new());
                for c in input.chunks(chunk) {
                    f.feed(c, &mut out, &mut actions);
                }
                assert_eq!(f.tracker, want, "chunk {chunk}");
                assert_eq!(out, input, "nothing dropped without a long OSC");
            }
        }
    }

    #[test]
    fn long_osc_bodies_are_cut_and_terminators_pass() {
        let mut f = Filter::new(24);
        let (mut out, mut actions) = (Vec::new(), Vec::new());
        let mut input = b"\x1b]52;c;".to_vec();
        input.extend(std::iter::repeat_n(b'A', 3 * MAX_OSC_BYTES));
        input.extend_from_slice(b"\x07ok");
        f.feed(&input, &mut out, &mut actions);
        assert!(out.len() <= MAX_OSC_BYTES + 8, "{}", out.len());
        assert!(out.ends_with(b"\x07ok"));

        let mut out = Vec::new();
        let mut title = b"\x1b]2;".to_vec();
        title.extend("é".repeat(MAX_TITLE_BYTES).as_bytes());
        title.extend_from_slice(b"\x1b\\");
        f.feed(&title, &mut out, &mut actions);
        let body = &out[4..out.len() - 2];
        assert!(body.len() <= MAX_TITLE_BYTES + 1);
        assert!(std::str::from_utf8(body).is_ok(), "cut on a char boundary");
        assert!(out.ends_with(b"\x1b\\"));
    }

    #[test]
    fn kitty_stack_depth_is_bounded() {
        let mut f = Filter::new(24);
        let (mut out, mut actions) = (Vec::new(), Vec::new());
        f.feed("\x1b[>1u".repeat(10_000).as_bytes(), &mut out, &mut actions);
        assert_eq!(f.tracker.kitty[0].stack.len(), KITTY_STACK_MAX);
        assert_eq!(f.tracker.kitty_active(), 1);
    }

    #[test]
    fn replies_and_resets_are_placed_in_stream_order() {
        let mut f = Filter::new(24);
        let (mut out, mut actions) = (Vec::new(), Vec::new());
        f.feed(b"ab\x1b[>5u\x1b[?ucd\x1bcx", &mut out, &mut actions);
        assert_eq!(
            actions,
            vec![
                (b"ab\x1b[>5u\x1b[?u".len(), Action::Reply("\x1b[?5u".into())),
                (b"ab\x1b[>5u\x1b[?ucd\x1bc".len(), Action::Reset),
            ]
        );
    }
}
