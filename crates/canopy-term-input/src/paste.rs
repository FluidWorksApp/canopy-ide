//! Text, paste and focus.

use canopy_term_core::frame::Modes;

use crate::buf::ESC;

/// Start of a bracketed paste (xterm ctlseqs, "Bracketed Paste Mode").
pub const PASTE_START: &[u8] = b"\x1b[200~";
/// End of a bracketed paste.
pub const PASTE_END: &[u8] = b"\x1b[201~";

/// Appends committed text (typed or from an IME) to `out` as UTF-8, unchanged.
/// Returns `true` if `text` was non-empty.
///
/// This is the path for text that did not come from a single key event. It
/// is sent raw in every mode today. The kitty spec says that with "report all
/// keys" and "report associated text" (`0b1000 | 0b10000`) a pure text event
/// should be `CSI 0;;<code points>u`; that form is not implemented yet. `modes`
/// is taken now so callers will not change when it is.
pub fn encode_text(text: &str, modes: Modes, out: &mut Vec<u8>) -> bool {
    let _ = modes;
    out.extend_from_slice(text.as_bytes());
    !text.is_empty()
}

/// Appends a paste to `out`.
///
/// * Bracketed paste on (2004): `ESC[200~`, the text, `ESC[201~`. Every ESC
///   and every C1 control (U+0080-U+009F, which includes the 8-bit CSI U+009B)
///   is removed from the text first, so the pasted bytes cannot end the
///   bracket early or smuggle in any other sequence. Removing all ESC rather
///   than only `ESC[201~` matters: deleting the marker alone can splice a new
///   one together out of its neighbours. Newlines are kept as they are.
/// * Bracketed paste off: `\r\n` and `\n` become `\r`, which is what the Enter
///   key sends. Nothing else changes.
///
/// Returns `true` if anything was written. Bracketed mode always writes the
/// markers, even for empty text.
pub fn encode_paste(text: &str, modes: Modes, out: &mut Vec<u8>) -> bool {
    let start = out.len();
    if modes.bracketed_paste {
        out.reserve(text.len() + PASTE_START.len() + PASTE_END.len());
        out.extend_from_slice(PASTE_START);
        push_without_escapes(text.as_bytes(), out);
        out.extend_from_slice(PASTE_END);
    } else {
        push_newlines_as_cr(text.as_bytes(), out);
    }
    out.len() != start
}

/// Copies `bytes` (valid UTF-8) without ESC and without C1 code points, which
/// in UTF-8 are exactly the pairs `C2 80` to `C2 9F`. Runs between removals
/// are copied whole.
fn push_without_escapes(bytes: &[u8], out: &mut Vec<u8>) {
    let mut run = 0;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        let skip = if b == ESC {
            1
        } else if b == 0xC2 && i + 1 < bytes.len() && (0x80..=0x9F).contains(&bytes[i + 1]) {
            2
        } else {
            0
        };
        if skip == 0 {
            i += 1;
        } else {
            out.extend_from_slice(&bytes[run..i]);
            i += skip;
            run = i;
        }
    }
    out.extend_from_slice(&bytes[run..]);
}

fn push_newlines_as_cr(bytes: &[u8], out: &mut Vec<u8>) {
    let mut run = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\n' => {
                out.extend_from_slice(&bytes[run..i]);
                out.push(b'\r');
                i += 1;
                run = i;
            }
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => {
                out.extend_from_slice(&bytes[run..i]);
                out.push(b'\r');
                i += 2;
                run = i;
            }
            _ => i += 1,
        }
    }
    out.extend_from_slice(&bytes[run..]);
}

/// Appends a focus report, `CSI I` on gaining focus and `CSI O` on losing it,
/// when the program enabled focus events (1004). Returns `true` if written.
pub fn encode_focus(focused: bool, modes: Modes, out: &mut Vec<u8>) -> bool {
    if !modes.focus_events {
        return false;
    }
    out.extend_from_slice(if focused { b"\x1b[I" } else { b"\x1b[O" });
    true
}
