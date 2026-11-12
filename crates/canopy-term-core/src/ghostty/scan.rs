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
//! It never changes, holds back or reorders bytes. It needs no CSI parameters
//! except the kitty keyboard stack sequences (`CSI > u`, `CSI < u`, `CSI = u`),
//! which tell the host to remember the flags of the screen that is active now
//! (the inactive screen's flags cannot be read back from the engine later).
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

#[derive(Debug)]
pub struct Scanner {
    st: St,
    body: Vec<u8>,
    overflow: bool,
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
        }
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
        for (i, &b) in bytes.iter().enumerate() {
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
                continue;
            }
            // Transitions that apply in every other state.
            match b {
                0x18 | 0x1a => {
                    self.st = St::Ground;
                    continue;
                }
                0x1b => {
                    self.st = St::Esc;
                    continue;
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
                    b'[' => self.st = St::Csi(None),
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
                    0x40..=0x7e => {
                        if b == b'u' && matches!(prefix, Some(b'<' | b'=' | b'>')) {
                            out.push((i + 1, Step::KittyChanged));
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
}

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
