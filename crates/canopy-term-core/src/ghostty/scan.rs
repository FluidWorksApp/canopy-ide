//! A small, engine-independent walk over the byte stream.
//!
//! libghostty-vt draws the grid but, by design, does not answer or report
//! everything a host needs: it has no hook for colour queries (OSC 4, 10, 11,
//! 12), prompt marks (OSC 133) or the clipboard policy we want, and its reset
//! does not tell us when it happened. This scanner finds exactly those events
//! in the stream, split anywhere, and reports each with the offset at which the
//! engine must have been fed before the host reacts. That keeps replies and
//! events in stream order relative to the engine's own replies.
//!
//! It never changes, holds back or reorders bytes. It reads CSI parameters for
//! two things only: the kitty keyboard stack sequences (`CSI > u`, `CSI < u`,
//! `CSI = u`), which tell the host to remember the flags of the screen that is
//! active now (the inactive screen's flags cannot be read back later), and
//! private mode set/reset (`CSI ? Pm h` / `l`), so the host can follow the
//! mouse modes the way the engine's stream handler applies them (the last one
//! set wins, any reset turns tracking off), which the engine's getters hide.
//!
//! Memory is bounded: an OSC body is collected up to [`MAX_OSC_BYTES`], longer
//! bodies are flagged `overflow` and the rest is skipped.

use crate::shared::MAX_OSC_BYTES;

/// A finished OSC string.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Osc {
    /// Everything between `ESC ]` and the terminator, control bytes removed,
    /// cut at [`MAX_OSC_BYTES`].
    pub body: Vec<u8>,
    /// The body was longer than [`MAX_OSC_BYTES`].
    pub overflow: bool,
    /// Ended with BEL (replies mirror the terminator the program used).
    pub bel: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// `ESC c` was fed.
    Reset,
    /// A BEL in the ground state (not an OSC terminator).
    Bell,
    /// A kitty keyboard flags change was fed.
    KittyChanged,
    /// `CSI ? Pm h` (`set`) or `CSI ? Pm l` was fed. At most [`MAX_MODE_PARAMS`]
    /// parameters are kept.
    PrivateMode {
        set: bool,
        params: Vec<u16>,
    },
    Osc(Osc),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum St {
    Ground,
    Esc,
    EscInter,
    /// Inside a CSI; the first parameter byte (`<`, `=`, `>`, `?`) if any.
    Csi(Option<u8>),
    /// DCS, SOS, PM or APC: skipped until a string terminator.
    Str,
    Osc,
}

/// Most parameters kept from one private mode sequence.
pub const MAX_MODE_PARAMS: usize = 16;

#[derive(Debug)]
pub struct Scanner {
    st: St,
    body: Vec<u8>,
    overflow: bool,
    // The CSI being read.
    params: Vec<u16>,
    cur: Option<u32>,
    inter: bool,
}

impl Default for Scanner {
    fn default() -> Self {
        Scanner::new()
    }
}

impl Scanner {
    pub fn new() -> Self {
        Scanner {
            st: St::Ground,
            body: Vec::new(),
            overflow: false,
            params: Vec::new(),
            cur: None,
            inter: false,
        }
    }

    fn start_csi(&mut self) {
        self.params.clear();
        self.cur = None;
        self.inter = false;
        self.st = St::Csi(None);
    }

    fn finish_osc(&mut self, bel: bool) -> Step {
        Step::Osc(Osc {
            body: std::mem::take(&mut self.body),
            overflow: std::mem::take(&mut self.overflow),
            bel,
        })
    }

    /// Walk `bytes`, pushing `(offset, step)` in order. Feed the engine
    /// `bytes[..offset]` (everything fed so far) before acting on a step. For an
    /// OSC the offset is that of its terminator, which is not yet fed; for
    /// every other step it is just past the last byte of the sequence.
    pub fn feed(&mut self, bytes: &[u8], out: &mut Vec<(usize, Step)>) {
        let mut i = 0;
        while i < bytes.len() {
            // In the ground state only BEL, CAN, SUB and ESC matter; skip the
            // printable run in between without touching the state machine.
            if self.st == St::Ground {
                while i < bytes.len() && !GROUND_SPECIAL[bytes[i] as usize] {
                    i += 1;
                }
                if i == bytes.len() {
                    return;
                }
            }
            self.byte(i, bytes[i], out);
            i += 1;
        }
    }

    #[inline]
    fn byte(&mut self, i: usize, b: u8, out: &mut Vec<(usize, Step)>) {
        if self.st == St::Osc {
            match b {
                0x07 => {
                    let s = self.finish_osc(true);
                    out.push((i, s));
                    self.st = St::Ground;
                }
                0x1b => {
                    let s = self.finish_osc(false);
                    out.push((i, s));
                    self.st = St::Esc;
                }
                0x18 | 0x1a => {
                    self.body.clear();
                    self.overflow = false;
                    self.st = St::Ground;
                }
                0x00..=0x1f => {}
                _ => {
                    if self.body.len() < MAX_OSC_BYTES {
                        self.body.push(b);
                    } else {
                        self.overflow = true;
                    }
                }
            }
            return;
        }
        // Transitions that apply in every other state.
        match b {
            0x18 | 0x1a => {
                self.st = St::Ground;
                return;
            }
            0x1b => {
                self.st = St::Esc;
                return;
            }
            _ => {}
        }
        match self.st {
            St::Ground => {
                if b == 0x07 {
                    out.push((i + 1, Step::Bell));
                }
            }
            St::Esc => match b {
                b']' => {
                    self.body.clear();
                    self.overflow = false;
                    self.st = St::Osc;
                }
                b'c' => {
                    out.push((i + 1, Step::Reset));
                    self.st = St::Ground;
                }
                b'P' | b'X' | b'^' | b'_' => self.st = St::Str,
                b'[' => self.start_csi(),
                0x20..=0x2f => self.st = St::EscInter,
                0x00..=0x1f => {}
                _ => self.st = St::Ground,
            },
            St::EscInter => match b {
                0x30..=0x7e => self.st = St::Ground,
                _ => {}
            },
            St::Csi(prefix) => match b {
                b'<' | b'=' | b'>' | b'?' if prefix.is_none() => {
                    self.st = St::Csi(Some(b));
                }
                b'0'..=b'9' => {
                    let d = (b - b'0') as u32;
                    self.cur = Some(self.cur.unwrap_or(0).saturating_mul(10).saturating_add(d));
                }
                b';' => {
                    if self.params.len() < MAX_MODE_PARAMS {
                        self.params
                            .push(self.cur.unwrap_or(0).min(u16::MAX as u32) as u16);
                    }
                    self.cur = None;
                }
                0x20..=0x2f => self.inter = true,
                0x40..=0x7e => {
                    if b == b'u' && matches!(prefix, Some(b'<' | b'=' | b'>')) {
                        out.push((i + 1, Step::KittyChanged));
                    } else if matches!(b, b'h' | b'l') && prefix == Some(b'?') && !self.inter {
                        if self.params.len() < MAX_MODE_PARAMS {
                            self.params
                                .push(self.cur.unwrap_or(0).min(u16::MAX as u32) as u16);
                        }
                        out.push((
                            i + 1,
                            Step::PrivateMode {
                                set: b == b'h',
                                params: std::mem::take(&mut self.params),
                            },
                        ));
                    }
                    self.st = St::Ground;
                }
                _ => {}
            },
            St::Str => {}
            St::Osc => unreachable!("handled above"),
        }
    }
}

/// Bytes that do something in the ground state: BEL, CAN, SUB, ESC.
static GROUND_SPECIAL: [bool; 256] = {
    let mut t = [false; 256];
    t[0x07] = true;
    t[0x18] = true;
    t[0x1a] = true;
    t[0x1b] = true;
    t
};

/// Split an OSC body at its first `;` into the command number and the rest.
/// `None` when the body does not start with a number.
pub fn split_osc(body: &[u8]) -> Option<(u32, &[u8])> {
    let end = body.iter().position(|&b| b == b';').unwrap_or(body.len());
    let num = std::str::from_utf8(&body[..end]).ok()?;
    if num.is_empty() || num.len() > 5 || !num.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let rest = if end < body.len() {
        &body[end + 1..]
    } else {
        &[]
    };
    Some((num.parse().ok()?, rest))
}

#[cfg(test)]
/// `rgb:rrrr/gggg/bbbb` as xterm answers colour queries (each byte doubled).
pub fn rgb_spec(r: u8, g: u8, b: u8) -> String {
    format!("rgb:{r:02x}{r:02x}/{g:02x}{g:02x}/{b:02x}{b:02x}")
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64, padding optional, whitespace not allowed. `None` on any
/// other byte or an impossible length.
pub fn base64_decode(input: &[u8]) -> Option<Vec<u8>> {
    let mut data = input;
    while let Some((&b'=', rest)) = data.split_last() {
        data = rest;
    }
    if data.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(data.len() / 4 * 3 + 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &c in data {
        let v = B64.iter().position(|&x| x == c)? as u32;
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

    fn run(chunks: &[&[u8]]) -> Vec<(usize, Step)> {
        let mut s = Scanner::new();
        let mut all = Vec::new();
        let mut base = 0;
        for c in chunks {
            let mut out = Vec::new();
            s.feed(c, &mut out);
            all.extend(out.into_iter().map(|(at, st)| (base + at, st)));
            base += c.len();
        }
        all
    }

    fn osc(body: &str, bel: bool) -> Step {
        Step::Osc(Osc {
            body: body.as_bytes().to_vec(),
            overflow: false,
            bel,
        })
    }

    #[test]
    fn osc_ends_at_bel_or_st_and_reports_the_terminator_offset() {
        assert_eq!(run(&[b"a\x1b]11;?\x07b"]), vec![(7, osc("11;?", true))]);
        assert_eq!(run(&[b"\x1b]10;?\x1b\\x"]), vec![(6, osc("10;?", false))]);
    }

    #[test]
    fn any_split_gives_the_same_steps() {
        let input = b"x\x1b]133;A\x07y\x1bcz\x07\x1b[>5u\x1b]2;t\x1b\\";
        let whole = run(&[input]);
        assert_eq!(whole.len(), 5, "{whole:?}");
        for i in 1..input.len() {
            assert_eq!(run(&[&input[..i], &input[i..]]), whole, "split at {i}");
        }
        let singles: Vec<&[u8]> = input.chunks(1).collect();
        assert_eq!(run(&singles), whole);
    }

    #[test]
    fn reset_bell_and_kitty_are_found_only_where_they_act() {
        assert_eq!(run(&[b"\x1bc"]), vec![(2, Step::Reset)]);
        assert_eq!(run(&[b"\x07"]), vec![(1, Step::Bell)]);
        // BEL inside a DCS or a CSI is not a bell; ESC ( c is not a reset.
        assert!(run(&[b"\x1bPabc\x07def\x1b\\"]).is_empty());
        assert!(run(&[b"\x1b(c"]).is_empty());
        assert_eq!(run(&[b"\x1b[>5u"]), vec![(5, Step::KittyChanged)]);
        assert_eq!(run(&[b"\x1b[<u"]), vec![(4, Step::KittyChanged)]);
        assert_eq!(run(&[b"\x1b[=1;2u"]), vec![(7, Step::KittyChanged)]);
        assert!(run(&[b"\x1b[?u\x1b[u"]).is_empty(), "query and SCORC");
    }

    #[test]
    fn private_modes_are_reported_with_their_parameters() {
        assert_eq!(
            run(&[b"\x1b[?9h\x1b[?1000;1006l"]),
            vec![
                (
                    5,
                    Step::PrivateMode {
                        set: true,
                        params: vec![9]
                    }
                ),
                (
                    18,
                    Step::PrivateMode {
                        set: false,
                        params: vec![1000, 1006]
                    }
                ),
            ]
        );
        // Not mode changes: ANSI modes, queries, intermediates.
        assert!(run(&[b"\x1b[4h\x1b[?7$p\x1b[?1 h"]).is_empty());
        // Split anywhere.
        let input = b"\x1b[?1002;1006h";
        let whole = run(&[input]);
        for i in 1..input.len() {
            assert_eq!(run(&[&input[..i], &input[i..]]), whole, "split at {i}");
        }
    }

    #[test]
    fn can_aborts_an_osc_and_esc_starts_a_new_sequence() {
        assert_eq!(
            run(&[b"\x1b]2;abc\x18def\x07"]).len(),
            1,
            "only the later BEL"
        );
        assert_eq!(
            run(&[b"\x1b]2;a\x1b]52;c;?\x07"]),
            vec![(5, osc("2;a", false)), (13, osc("52;c;?", true))]
        );
    }

    #[test]
    fn long_bodies_are_cut_and_flagged() {
        let mut input = b"\x1b]52;c;".to_vec();
        input.extend(std::iter::repeat_n(b'A', 3 * MAX_OSC_BYTES));
        input.push(0x07);
        let steps = run(&[&input]);
        match &steps[0].1 {
            Step::Osc(o) => {
                assert_eq!(o.body.len(), MAX_OSC_BYTES);
                assert!(o.overflow);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn osc_helpers() {
        assert_eq!(split_osc(b"52;c;AAAA"), Some((52, &b"c;AAAA"[..])));
        assert_eq!(split_osc(b"133"), Some((133, &b""[..])));
        assert_eq!(split_osc(b"x;y"), None);
        assert_eq!(rgb_spec(0x10, 0x20, 0x30), "rgb:1010/2020/3030");
        assert_eq!(base64_decode(b"aGVsbG8=").as_deref(), Some(&b"hello"[..]));
        assert_eq!(base64_decode(b"aGVsbG8").as_deref(), Some(&b"hello"[..]));
        assert_eq!(base64_decode(b"").as_deref(), Some(&b""[..]));
        assert_eq!(base64_decode(b"a"), None);
        assert_eq!(base64_decode(b"a*bc"), None);
    }
}
