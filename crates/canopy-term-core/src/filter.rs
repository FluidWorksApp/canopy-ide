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
//! * **Sequences the engine ignores or must not act on.** OSC 52 (clipboard)
//!   and OSC 133 (semantic prompts) are parsed here into [`Action`]s; the engine
//!   has OSC 52 switched off, so it can neither write nor answer from a
//!   clipboard. Horizontal tab stops (HTS, TBC), reverse scrolling and screen
//!   switches are reported as actions too, so the screen can mirror what the
//!   engine keeps private (see `screen.rs`). The active charset (SO/SI) is
//!   tracked in [`Tracker`].
//!
//! The filter never holds bytes back or reorders them; it only drops OSC bytes
//! past the cap. Everything else passes through unchanged.

use crate::event::{ClipboardTarget, SemanticMark, MAX_CLIPBOARD_TEXT};
use std::fmt::Write as _;

/// Longest OSC body passed to the engine, in bytes.
pub const MAX_OSC_BYTES: usize = 64 * 1024;
/// Longest title (OSC 0, 1, 2 payload after the first `;`) passed on, in bytes.
pub const MAX_TITLE_BYTES: usize = 4096;
/// Deepest kitty keyboard stack kept per screen; the oldest entry is dropped.
pub const KITTY_STACK_MAX: usize = 256;

/// Longest hyperlink URI (OSC 8) passed to the engine, in bytes. A longer one is
/// cut a byte past this, and anything longer than this is never exposed, so a
/// cut link is never mistaken for a whole one.
pub const MAX_URI_BYTES: usize = 2048;
/// Longest OSC 8 parameter field (`id=...`), in bytes; past it the sequence is
/// cut short and the engine ignores it.
const MAX_LINK_PARAMS_BYTES: usize = 256;
/// Longest OSC 133 body kept, in bytes.
const MAX_MARK_BODY: usize = 256;
/// Base64 length of the largest accepted clipboard payload.
const MAX_CLIPBOARD_B64: usize = MAX_CLIPBOARD_TEXT.div_ceil(3) * 4;

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
    /// OSC 52 set request (complete, within the size cap, valid UTF-8).
    ClipboardSet {
        target: ClipboardTarget,
        text: String,
    },
    /// OSC 52 read request.
    ClipboardRead(ClipboardTarget),
    /// OSC 133 mark.
    Mark(SemanticMark),
    /// HTS: a tab stop at the cursor column.
    TabSet,
    /// TBC: clear the stop at the cursor column, or all of them.
    TabClear { all: bool },
    /// Something moved rows without a line feed at the bottom (reverse index,
    /// scroll down, insert or delete lines, a new scroll region).
    ShiftRows,
    /// Placed on both sides of a switch to or from the alternate screen so the
    /// screen feeds the engine in separate pieces around it. Does nothing.
    Split,
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
    /// SO is in effect: the G1 charset is the active one (SI selects G0).
    pub shift_out: bool,
}

impl Tracker {
    pub fn new(rows: u16) -> Self {
        Tracker {
            rows,
            ..Tracker::default()
        }
    }

    /// A C0 control the engine executes.
    pub fn exec(&mut self, b: u8) {
        match b {
            0x0E => self.shift_out = true,
            0x0F => self.shift_out = false,
            _ => {}
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
    osc8_in_uri: bool,
    osc8_params: usize,
    osc8_uri: usize,
    // What `observe` is collecting from the OSC being passed.
    obs: Obs,
    obs_num: u32,
    cap: Vec<u8>,
    // Where the CSI being parsed began in the output.
    csi_start: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Obs {
    /// Still reading the number before the first `;`.
    Head,
    /// Collecting the body of an OSC this filter acts on.
    Body,
    /// Not one it acts on, or the body was too long (never truncated).
    Skip,
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
            osc8_in_uri: false,
            osc8_params: 0,
            osc8_uri: 0,
            obs: Obs::Skip,
            obs_num: 0,
            cap: Vec::new(),
            csi_start: 0,
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
        if inter.is_empty() {
            match action as char {
                'g' => match params.first().copied().unwrap_or(0) {
                    0 => actions.push((at, Action::TabClear { all: false })),
                    3 => actions.push((at, Action::TabClear { all: true })),
                    _ => {}
                },
                'T' | 'L' | 'M' | 'r' if !self.tracker.alt => actions.push((at, Action::ShiftRows)),
                _ => {}
            }
        } else if inter.as_slice() == [b'?']
            && matches!(action, b'h' | b'l')
            && params.iter().any(|&p| matches!(p, 47 | 1047 | 1049))
        {
            // Both sides of the sequence, so the engine is fed the switch on
            // its own. `at` is just past the final byte.
            let before = self.csi_start.min(at - 1);
            actions.push((before, Action::Split));
            actions.push((at, Action::Split));
        }
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
        self.csi_start = out.len();
        for &b in input {
            let mut keep = true;
            match self.st {
                St::Ground => {
                    if b == 0x1B {
                        self.reset_params();
                        self.st = St::Esc;
                    } else if b < 0x10 {
                        self.tracker.exec(b);
                    }
                }
                St::Esc => match b {
                    _ if is_exec(b) => self.tracker.exec(b),
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
                        self.csi_start = out.len();
                        self.st = St::CsiEntry;
                    }
                    0x5D => {
                        self.osc_num = 0;
                        self.osc_head = true;
                        self.osc_payload = 0;
                        self.osc_total = 0;
                        self.osc_dropping = false;
                        self.osc8_in_uri = false;
                        self.osc8_params = 0;
                        self.osc8_uri = 0;
                        self.obs = Obs::Head;
                        self.obs_num = 0;
                        self.cap.clear();
                        self.st = St::Osc;
                    }
                    0x30..=0x7E => {
                        self.st = St::Ground;
                        if self.inter.is_empty() && !self.ignoring {
                            let action = match b {
                                b'c' => {
                                    self.tracker.reset();
                                    Some(Action::Reset)
                                }
                                b'H' => Some(Action::TabSet),
                                b'M' if !self.tracker.alt => Some(Action::ShiftRows),
                                _ => None,
                            };
                            if let Some(action) = action {
                                out.push(b);
                                actions.push((out.len(), action));
                                continue;
                            }
                        }
                    }
                    0x18 | 0x1A => self.st = St::Ground,
                    _ => {}
                },
                St::EscInter => match b {
                    _ if is_exec(b) => self.tracker.exec(b),
                    0x20..=0x2F => self.collect(b),
                    0x30..=0x7E => self.st = St::Ground,
                    0x7F => {}
                    _ => self.anywhere(b),
                },
                St::CsiEntry => match b {
                    _ if is_exec(b) => self.tracker.exec(b),
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
                    _ if is_exec(b) => self.tracker.exec(b),
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
                    _ if is_exec(b) => self.tracker.exec(b),
                    0x20..=0x2F => self.collect(b),
                    0x30..=0x3F => self.st = St::CsiIgnore,
                    0x40..=0x7E => self.csi_dispatch(b, actions, out.len() + 1),
                    _ => self.anywhere(b),
                },
                St::CsiIgnore => match b {
                    _ if is_exec(b) => self.tracker.exec(b),
                    0x20..=0x3F | 0x7F => {}
                    0x40..=0x7E => self.st = St::Ground,
                    _ => self.anywhere(b),
                },
                St::Osc => match b {
                    // Only a real terminator completes an OSC for the events;
                    // the engine also dispatches on CAN and SUB, but a
                    // cancelled clipboard request is not acted on.
                    0x07 => {
                        self.finish_osc(actions, out.len());
                        self.st = St::Ground;
                    }
                    0x18 | 0x1A => self.st = St::Ground,
                    0x1B => {
                        self.finish_osc(actions, out.len());
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
        self.observe(b);
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
            if self.osc_num == 8 {
                if self.osc8_in_uri {
                    self.osc8_uri += 1;
                } else if b == b';' {
                    self.osc8_in_uri = true;
                } else {
                    self.osc8_params += 1;
                }
            }
        }
        self.osc_total += 1;
        let cap_hit = self.osc_total > MAX_OSC_BYTES
            || (matches!(self.osc_num, 0..=2) && self.osc_payload > MAX_TITLE_BYTES)
            || (self.osc_num == 8
                && (self.osc8_params > MAX_LINK_PARAMS_BYTES || self.osc8_uri > MAX_URI_BYTES + 1));
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

impl Filter {
    /// Collect the body of OSC 52 and 133 (all of it, even past the cut that
    /// protects the engine: a clipboard payload is parsed whole or not at all).
    fn observe(&mut self, b: u8) {
        match self.obs {
            Obs::Head => {
                if b == b';' {
                    self.obs = if matches!(self.obs_num, 52 | 133) {
                        Obs::Body
                    } else {
                        Obs::Skip
                    };
                } else if b.is_ascii_digit() {
                    self.obs_num = self
                        .obs_num
                        .saturating_mul(10)
                        .saturating_add((b - b'0') as u32);
                } else {
                    self.obs = Obs::Skip;
                }
            }
            Obs::Body => {
                let max = if self.obs_num == 52 {
                    MAX_CLIPBOARD_B64 + 16
                } else {
                    MAX_MARK_BODY
                };
                if self.cap.len() < max {
                    self.cap.push(b);
                } else {
                    self.obs = Obs::Skip;
                }
            }
            Obs::Skip => {}
        }
    }

    /// The OSC being passed ended with a terminator.
    fn finish_osc(&mut self, actions: &mut Vec<(usize, Action)>, at: usize) {
        if self.obs != Obs::Body {
            return;
        }
        self.obs = Obs::Skip;
        let action = match self.obs_num {
            52 => parse_osc52(&self.cap),
            133 => parse_osc133(&self.cap).map(Action::Mark),
            _ => None,
        };
        if let Some(action) = action {
            actions.push((at, action));
        }
    }
}

/// `Pc ; Pd` of OSC 52: a selection, then base64 text or `?`.
fn parse_osc52(body: &[u8]) -> Option<Action> {
    let mut parts = body.split(|&b| b == b';');
    let sel = parts.next()?;
    let data = parts.next()?;
    let target = if sel.is_empty() || sel.contains(&b'c') {
        ClipboardTarget::Clipboard
    } else if sel.iter().any(|b| matches!(b, b'p' | b's')) {
        ClipboardTarget::Selection
    } else {
        return None;
    };
    if data == b"?" {
        return Some(Action::ClipboardRead(target));
    }
    let bytes = decode_base64(data)?;
    if bytes.len() > MAX_CLIPBOARD_TEXT {
        return None;
    }
    let text = String::from_utf8(bytes).ok()?;
    Some(Action::ClipboardSet { target, text })
}

/// `K [; options]` of OSC 133; `D` may carry an exit code first.
fn parse_osc133(body: &[u8]) -> Option<SemanticMark> {
    let (&kind, rest) = body.split_first()?;
    if !rest.is_empty() && rest[0] != b';' {
        return None;
    }
    match kind {
        b'A' => Some(SemanticMark::PromptStart),
        b'B' => Some(SemanticMark::CommandStart),
        b'C' => Some(SemanticMark::OutputStart),
        b'D' => {
            let code = rest
                .strip_prefix(b";")
                .and_then(|r| r.split(|&b| b == b';').next())
                .and_then(|f| std::str::from_utf8(f).ok())
                .and_then(|f| f.parse::<i32>().ok());
            Some(SemanticMark::CommandFinished(code))
        }
        _ => None,
    }
}

/// Standard-alphabet base64, padded or not. Anything else is refused.
fn decode_base64(input: &[u8]) -> Option<Vec<u8>> {
    let mut data = input;
    while let [rest @ .., b'='] = data {
        data = rest;
    }
    if input.len() - data.len() > 2 || data.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(data.len() / 4 * 3 + 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in data {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
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
        fn execute(&mut self, byte: u8) {
            self.0.exec(byte);
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
            "\x0e\x1b[?1049h\x0f\x0e\x1b[1\x0f;2m\x0e\x1b\x0f(0\x1b]2;\x0et\x07\x1bP\x0f\x1b\\\x0e",
            "\x0e\x1bc\x0e\x0f\x1b[\x0e;\x0f?\x0e1049h\x1b[?1049l\x0e",
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

    fn actions_of(input: &[u8]) -> (Vec<u8>, Vec<(usize, Action)>) {
        let mut f = Filter::new(24);
        let (mut out, mut actions) = (Vec::new(), Vec::new());
        f.feed(input, &mut out, &mut actions);
        (out, actions)
    }

    fn only_actions(input: &[u8]) -> Vec<Action> {
        actions_of(input).1.into_iter().map(|(_, a)| a).collect()
    }

    #[test]
    fn osc52_sets_are_parsed_whole_with_a_cap() {
        // "hello" is aGVsbG8=
        assert_eq!(
            only_actions(b"\x1b]52;c;aGVsbG8=\x07"),
            vec![Action::ClipboardSet {
                target: ClipboardTarget::Clipboard,
                text: "hello".into()
            }]
        );
        // ST terminator, selection `p`, no padding.
        assert_eq!(
            only_actions(b"\x1b]52;p;aGVsbG8\x1b\\"),
            vec![Action::ClipboardSet {
                target: ClipboardTarget::Selection,
                text: "hello".into()
            }]
        );
        // Empty selection means the clipboard; cut buffers are ignored.
        assert_eq!(only_actions(b"\x1b]52;;aGk=\x07").len(), 1);
        assert!(only_actions(b"\x1b]52;0;aGk=\x07").is_empty());
        // Not base64, not UTF-8, cancelled, unterminated: nothing.
        assert!(only_actions(b"\x1b]52;c;a$k=\x07").is_empty());
        assert!(only_actions(b"\x1b]52;c;/w==\x07").is_empty());
        assert!(only_actions(b"\x1b]52;c;aGk=\x18").is_empty());
        assert!(only_actions(b"\x1b]52;c;aGk=").is_empty());
        // A read is reported as such, never as data.
        assert_eq!(
            only_actions(b"\x1b]52;c;?\x07"),
            vec![Action::ClipboardRead(ClipboardTarget::Clipboard)]
        );
    }

    #[test]
    fn osc52_over_the_cap_is_dropped_not_truncated() {
        let ok = vec![b'A'; MAX_CLIPBOARD_TEXT / 3 * 4];
        let mut input = b"\x1b]52;c;".to_vec();
        input.extend_from_slice(&ok);
        input.push(0x07);
        assert_eq!(only_actions(&input).len(), 1, "within the cap");

        let mut input = b"\x1b]52;c;".to_vec();
        input.extend(std::iter::repeat_n(b'A', MAX_CLIPBOARD_B64 + 64));
        input.push(0x07);
        assert!(only_actions(&input).is_empty(), "over the cap");
        // The engine copy of the body is cut, but the terminator passes.
        let (out, _) = actions_of(&input);
        assert!(out.len() <= MAX_OSC_BYTES + 16);
        assert!(out.ends_with(&[0x07]));
    }

    #[test]
    fn osc133_marks_are_parsed() {
        assert_eq!(
            only_actions(b"\x1b]133;A\x07\x1b]133;B;k=i\x07\x1b]133;C\x1b\\"),
            vec![
                Action::Mark(SemanticMark::PromptStart),
                Action::Mark(SemanticMark::CommandStart),
                Action::Mark(SemanticMark::OutputStart),
            ]
        );
        assert_eq!(
            only_actions(b"\x1b]133;D;7\x07\x1b]133;D\x07\x1b]133;D;x\x07"),
            vec![
                Action::Mark(SemanticMark::CommandFinished(Some(7))),
                Action::Mark(SemanticMark::CommandFinished(None)),
                Action::Mark(SemanticMark::CommandFinished(None)),
            ]
        );
        assert!(only_actions(b"\x1b]133;AB\x07\x1b]133;\x07\x1b]133\x07").is_empty());
    }

    #[test]
    fn osc_events_are_found_at_any_split() {
        let input = b"x\x1b]52;c;aGk=\x07y\x1b]133;D;3\x1b\\z";
        let (_, want) = actions_of(input);
        assert_eq!(want.len(), 2);
        for chunk in [1usize, 2, 3, 5] {
            let mut f = Filter::new(24);
            let mut got = Vec::new();
            let mut base = 0;
            for c in input.chunks(chunk) {
                let (mut out, mut actions) = (Vec::new(), Vec::new());
                f.feed(c, &mut out, &mut actions);
                got.extend(actions.into_iter().map(|(_, a)| a));
                base += out.len();
            }
            assert_eq!(base, input.len());
            let want: Vec<Action> = want.iter().map(|(_, a)| a.clone()).collect();
            assert_eq!(got, want, "chunk {chunk}");
        }
    }

    #[test]
    fn hyperlink_uris_over_the_cap_are_cut_past_it() {
        let mut input = b"\x1b]8;;".to_vec();
        input.extend(std::iter::repeat_n(b'a', 3 * MAX_URI_BYTES));
        input.extend_from_slice(b"\x1b\\");
        let (out, _) = actions_of(&input);
        let kept = out.len() - b"\x1b]8;;".len() - 2;
        assert_eq!(kept, MAX_URI_BYTES + 1);

        // A URI at the cap passes whole.
        let mut input = b"\x1b]8;id=x;".to_vec();
        input.extend(std::iter::repeat_n(b'a', MAX_URI_BYTES));
        input.push(0x07);
        let (out, _) = actions_of(&input);
        assert_eq!(out, input);

        // Semicolons inside the URI count towards it, not as parameters.
        let mut input = b"\x1b]8;;".to_vec();
        input.extend(std::iter::repeat_n(b';', 3 * MAX_URI_BYTES));
        input.push(0x07);
        let (out, _) = actions_of(&input);
        assert_eq!(out.len(), b"\x1b]8;;".len() + MAX_URI_BYTES + 2);
    }

    #[test]
    fn tab_row_and_screen_switch_sequences_become_actions() {
        let (_, a) = actions_of(b"\x1bH\x1b[g\x1b[0g\x1b[3g\x1b[2g");
        let kinds: Vec<Action> = a.into_iter().map(|(_, a)| a).collect();
        assert_eq!(
            kinds,
            vec![
                Action::TabSet,
                Action::TabClear { all: false },
                Action::TabClear { all: false },
                Action::TabClear { all: true },
            ]
        );
        assert_eq!(
            only_actions(b"\x1bM\x1b[2T\x1b[L\x1b[3M\x1b[2;5r"),
            vec![Action::ShiftRows; 5]
        );
        // On the alternate screen the rows are not the primary's.
        assert!(only_actions(b"\x1b[?1049h\x1bM")
            .iter()
            .all(|a| *a == Action::Split));

        let (out, a) = actions_of(b"ab\x1b[?1049hcd");
        assert_eq!(
            a,
            vec![
                (b"ab\x1b".len(), Action::Split),
                (b"ab\x1b[?1049h".len(), Action::Split)
            ]
        );
        assert_eq!(out, b"ab\x1b[?1049hcd");
    }

    #[test]
    fn shift_out_is_tracked() {
        let mut f = Filter::new(24);
        let (mut out, mut actions) = (Vec::new(), Vec::new());
        f.feed(b"a\x0eb", &mut out, &mut actions);
        assert!(f.tracker.shift_out);
        f.feed(b"\x0f", &mut out, &mut actions);
        assert!(!f.tracker.shift_out);
        f.feed(b"\x0e\x1bc", &mut out, &mut actions);
        assert!(!f.tracker.shift_out, "a reset selects G0");
    }

    #[test]
    fn base64_decoding_is_strict() {
        assert_eq!(decode_base64(b"").unwrap(), b"");
        assert_eq!(decode_base64(b"Zg==").unwrap(), b"f");
        assert_eq!(decode_base64(b"Zg").unwrap(), b"f");
        assert_eq!(decode_base64(b"Zm9v").unwrap(), b"foo");
        assert_eq!(decode_base64(b"+/+/").unwrap(), [0xfb, 0xff, 0xbf]);
        assert!(decode_base64(b"Z").is_none());
        assert!(decode_base64(b"Zg===").is_none());
        assert!(decode_base64(b"Zm 9v").is_none());
        assert!(decode_base64(b"Zm9v\n").is_none());
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
