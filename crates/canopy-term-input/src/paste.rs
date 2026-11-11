//! Text, paste and focus.

use canopy_term_core::frame::Modes;

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

/// What [`encode_paste`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Hash)]
pub struct PasteResult {
    /// Anything was appended to `out`.
    pub written: bool,
    /// Control characters were removed from the pasted text, so the UI can
    /// tell the user the paste was altered. Newline conversion does not count.
    pub removed_controls: bool,
}

/// Appends a paste to `out`.
///
/// In both modes every control character except Tab, LF and CR is removed
/// first: C0 (including ESC, and `0x03`, which would raise SIGINT mid-paste),
/// DEL, and C1 (U+0080-U+009F, including the 8-bit CSI U+009B). So a paste can
/// neither end the bracket early nor type a key sequence into the program
/// (pasting `ESC:!cmd` into vim). Removing every ESC rather than only
/// `ESC[201~` matters: deleting the marker alone can splice a new one together
/// out of its neighbours.
///
/// * Bracketed paste on (2004): `ESC[200~`, the text, `ESC[201~`. Newlines are
///   kept as they are. The markers are written even for empty text.
/// * Bracketed paste off: after the removal, `\r\n` and `\n` become `\r`, which
///   is what the Enter key sends.
pub fn encode_paste(text: &str, modes: Modes, out: &mut Vec<u8>) -> PasteResult {
    encode_paste_with(text, modes, true, out)
}

/// [`encode_paste`] with the control stripping switchable. `strip_controls:
/// false` leaves every control character in the text (newline conversion when
/// bracketed paste is off still applies). That lets a pasted `ESC[201~` close
/// the bracket early and lets a paste type key sequences into the program, so
/// only pass `false` for text the user typed or explicitly trusts.
pub fn encode_paste_with(
    text: &str,
    modes: Modes,
    strip_controls: bool,
    out: &mut Vec<u8>,
) -> PasteResult {
    let start = out.len();
    let removed_controls = if modes.bracketed_paste {
        out.reserve(text.len() + PASTE_START.len() + PASTE_END.len());
        out.extend_from_slice(PASTE_START);
        let removed = push_sanitized(text, strip_controls, false, out);
        out.extend_from_slice(PASTE_END);
        removed
    } else {
        push_sanitized(text, strip_controls, true, out)
    };
    PasteResult {
        written: out.len() != start,
        removed_controls,
    }
}

/// Removed from every paste: all control characters but Tab, LF and CR.
fn is_removed(c: char) -> bool {
    c.is_control() && !matches!(c, '\t' | '\n' | '\r')
}

/// Copies `text` without the removed controls, copying the runs between
/// removals whole. With `newlines_to_cr`, `\n` becomes `\r` unless the last
/// character kept was a `\r` (so `\r\n`, even with removed controls between,
/// becomes one `\r`). Returns whether anything was removed.
fn push_sanitized(text: &str, strip: bool, newlines_to_cr: bool, out: &mut Vec<u8>) -> bool {
    let bytes = text.as_bytes();
    let mut removed = false;
    let mut run = 0;
    let mut last_kept_cr = false;
    for (i, c) in text.char_indices() {
        if strip && is_removed(c) {
            out.extend_from_slice(&bytes[run..i]);
            run = i + c.len_utf8();
            removed = true;
        } else if newlines_to_cr && c == '\n' {
            out.extend_from_slice(&bytes[run..i]);
            run = i + 1;
            if !last_kept_cr {
                out.push(b'\r');
            }
            last_kept_cr = false;
        } else {
            last_kept_cr = c == '\r';
        }
    }
    out.extend_from_slice(&bytes[run..]);
    removed
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
