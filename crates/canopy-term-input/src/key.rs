//! Key events and their encoding.
//!
//! Two encoders, chosen by `Modes::kitty_keyboard`:
//!
//! * **Legacy xterm** (no kitty flags pushed). Sources: xterm ctlseqs, sections
//!   "PC-Style Function Keys" and "VT220-Style Function Keys"
//!   (<https://invisible-island.net/xterm/ctlseqs/ctlseqs.html>), and the kitty
//!   spec's "Legacy key event encoding" tables for C0 keys and the Ctrl mapping
//!   (<https://sw.kovidgoyal.net/kitty/keyboard-protocol/#legacy-key-event-encoding>).
//! * **Kitty keyboard protocol** with progressive enhancement
//!   (<https://sw.kovidgoyal.net/kitty/keyboard-protocol/>). Key numbers come
//!   from its "Functional key definitions" table, modifier bits from its
//!   "Modifiers" section.
//!
//! Choices where the sources leave room, each pinned by a test:
//!
//! * With no flags pushed the output is plain xterm: combinations legacy cannot
//!   express are folded to the nearest legacy bytes (Ctrl+Shift+A sends `0x01`
//!   like xterm with modifyOtherKeys off), never `CSI u`. Keys legacy has no
//!   code for (media, lock and modifier keys, F25 and up) and text keys with
//!   Super/Hyper/Meta send nothing. modifyOtherKeys is not implemented.
//! * Legacy F13-F24 are xterm's terminfo `kf13`-`kf24`: F1-F12 with Shift
//!   added, so F13 is `CSI 1;2P`.
//! * Legacy Shift+F3 is xterm's `CSI 1;2R` (terminfo `kf15`). Kitty mode uses
//!   `CSI 13;2~` as the spec says, since `CSI 1;2R` collides with a cursor
//!   position report.
//! * Application keypad (DECKPAM) uses the VT220 table (`SS3 p`..`SS3 y` for
//!   digits) and only applies to unmodified keypad keys; a modified keypad key
//!   is sent as its numeric-mode character.
//! * Without kitty `0b1` (disambiguate) or `0b1000` (report all keys), a key
//!   **press** is sent exactly as legacy would send it, DECCKM and DECKPAM
//!   included; `0b10` only adds repeat and release reports and `0b100` only
//!   decorates keys that are escaped anyway (spec "Report alternate keys":
//!   "only key events represented as escape codes due to the other
//!   enhancements in effect will be affected"). Associated text (`0b10000`) is
//!   undefined without `0b1000`. A press legacy cannot express (Super+A, media
//!   keys) falls back to `CSI u`.
//! * Under `0b1` or `0b1000` DECCKM and DECKPAM do not apply: the spec's SS3
//!   forms are in "Legacy key event encoding", while "Disambiguate escape
//!   codes" says every non-text key is `CSI number; modifier u` or
//!   `CSI 1; modifier [~ABCDEFHPQS]`, and keypad keys get their own numbers.
//! * Kitty: lock bits are not reported for `Char` keys unless `0b1000` is set
//!   (spec "Disambiguate escape codes": "the Lock modifiers are not reported
//!   for text producing keys").
//! * A `Char` holding a control character is mapped to the named key (`\r`
//!   and `\n` Enter, `\t` Tab, ESC Escape, DEL and BS Backspace); any other
//!   control character sends nothing.
//! * Legacy Ctrl on a non-ASCII key uses its ASCII `base_layout_key`, so
//!   Ctrl+С on a Cyrillic layout sends `0x03`.
//! * Kitty: a key that produces text is sent as that text and its release is
//!   not reported unless `0b1000` is set (spec "Event types", note). Enter,
//!   Tab and Backspace have no release events without `0b1000`.
//! * Kitty keypad Begin is `CSI 1 E` (`CSI 1;<mods> E`), the first form the
//!   table lists.

use canopy_term_core::frame::Modes;

use crate::buf::{csi, push_char, push_u32, ss3, ESC};
use crate::mods::Mods;

/// Kitty progressive-enhancement flag bits, as pushed with `CSI > flags u`.
/// <https://sw.kovidgoyal.net/kitty/keyboard-protocol/#progressive-enhancement>
pub mod kitty_flags {
    /// `0b1`: disambiguate escape codes.
    pub const DISAMBIGUATE: u8 = 0b1;
    /// `0b10`: report event types (repeat and release).
    pub const REPORT_EVENT_TYPES: u8 = 0b10;
    /// `0b100`: report alternate keys.
    pub const REPORT_ALTERNATES: u8 = 0b100;
    /// `0b1000`: report all keys as escape codes.
    pub const REPORT_ALL_KEYS: u8 = 0b1000;
    /// `0b10000`: report associated text.
    pub const REPORT_TEXT: u8 = 0b10000;
    /// Every defined bit.
    pub const ALL: u8 = 0b11111;
}

use self::kitty_flags::{
    DISAMBIGUATE, REPORT_ALL_KEYS, REPORT_ALTERNATES, REPORT_EVENT_TYPES, REPORT_TEXT,
};

/// Press, repeat or release.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Hash)]
pub enum KeyEventKind {
    /// Key went down.
    #[default]
    Press,
    /// Auto-repeat while held. Sent as a press unless the program asked for
    /// event types.
    Repeat,
    /// Key went up. Sent only when the program asked for event types.
    Release,
}

/// Keypad keys. `Num0`..`Num9`, the operators and `Enter` are what the keypad
/// sends with Num Lock on; the navigation keys are what it sends with Num Lock
/// off. Kitty numbers 57399-57427 in this order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[allow(missing_docs)]
pub enum Keypad {
    Num0,
    Num1,
    Num2,
    Num3,
    Num4,
    Num5,
    Num6,
    Num7,
    Num8,
    Num9,
    Decimal,
    Divide,
    Multiply,
    Subtract,
    Add,
    Enter,
    Equal,
    Separator,
    Left,
    Right,
    Up,
    Down,
    PageUp,
    PageDown,
    Home,
    End,
    Insert,
    Delete,
    Begin,
}

/// Media and volume keys. Kitty numbers 57428-57440 in this order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[allow(missing_docs)]
pub enum Media {
    Play,
    Pause,
    PlayPause,
    Reverse,
    Stop,
    FastForward,
    Rewind,
    TrackNext,
    TrackPrevious,
    Record,
    LowerVolume,
    RaiseVolume,
    MuteVolume,
}

/// Modifier keys as keys in their own right (reported only with kitty flag
/// `0b1000`). Kitty numbers 57441-57454 in this order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[allow(missing_docs)]
pub enum ModifierKey {
    LeftShift,
    LeftControl,
    LeftAlt,
    LeftSuper,
    LeftHyper,
    LeftMeta,
    RightShift,
    RightControl,
    RightAlt,
    RightSuper,
    RightHyper,
    RightMeta,
    IsoLevel3Shift,
    IsoLevel5Shift,
}

/// The key that was pressed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Key {
    /// A key that has a Unicode code point: the **unshifted** character in the
    /// active layout (`'a'` for A with or without Shift, `'1'` for 1 and !,
    /// `' '` for Space). An ASCII uppercase letter is treated as its lowercase.
    Char(char),
    #[allow(missing_docs)]
    Escape,
    #[allow(missing_docs)]
    Enter,
    #[allow(missing_docs)]
    Tab,
    #[allow(missing_docs)]
    Backspace,
    #[allow(missing_docs)]
    Insert,
    #[allow(missing_docs)]
    Delete,
    #[allow(missing_docs)]
    Left,
    #[allow(missing_docs)]
    Right,
    #[allow(missing_docs)]
    Up,
    #[allow(missing_docs)]
    Down,
    #[allow(missing_docs)]
    PageUp,
    #[allow(missing_docs)]
    PageDown,
    #[allow(missing_docs)]
    Home,
    #[allow(missing_docs)]
    End,
    #[allow(missing_docs)]
    CapsLock,
    #[allow(missing_docs)]
    ScrollLock,
    #[allow(missing_docs)]
    NumLock,
    #[allow(missing_docs)]
    PrintScreen,
    #[allow(missing_docs)]
    Pause,
    #[allow(missing_docs)]
    Menu,
    /// F1 to F35. Other numbers encode to nothing.
    F(u8),
    /// A keypad key.
    Keypad(Keypad),
    /// A media or volume key.
    Media(Media),
    /// A modifier key itself.
    Modifier(ModifierKey),
}

/// One key event, as the window layer saw it.
///
/// `text` is what the key would type under the current layout and modifiers
/// (`"A"` for Shift+A, `"å"` when the OS composed Option+A). Leave it `None`
/// when the key types nothing. Text containing control characters (C0, DEL,
/// C1) is ignored, as the kitty spec requires. When the OS consumed a modifier
/// to compose the text (macOS Option producing `å`), remove that modifier from
/// `mods`: the encoder treats Alt as "prefix ESC", per xterm.
///
/// The encoder decides from `mods` whether text goes out raw: with Ctrl, Alt,
/// Super, Hyper or Meta held it never does, whatever `text` says.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct KeyEvent<'a> {
    /// The key.
    pub key: Key,
    /// Modifiers active during the event.
    pub mods: Mods,
    /// Press, repeat or release.
    pub kind: KeyEventKind,
    /// Text the key produces, if any.
    pub text: Option<&'a str>,
    /// The key's shifted character in the active layout (`'A'` for `'a'`,
    /// `'!'` for `'1'` on US). Kitty "shifted key" alternate; also used for
    /// legacy Shift when `text` is absent.
    pub shifted_key: Option<char>,
    /// The character of the same physical key in the standard US PC-101
    /// layout (`'c'` for Cyrillic С). Kitty "base layout key" alternate.
    pub base_layout_key: Option<char>,
}

impl<'a> KeyEvent<'a> {
    /// A press of `key` with no modifiers, text or alternates.
    pub fn new(key: Key) -> Self {
        KeyEvent {
            key,
            mods: Mods::NONE,
            kind: KeyEventKind::Press,
            text: None,
            shifted_key: None,
            base_layout_key: None,
        }
    }

    /// Sets the modifiers.
    pub fn with_mods(mut self, mods: Mods) -> Self {
        self.mods = mods;
        self
    }

    /// Sets press, repeat or release.
    pub fn with_kind(mut self, kind: KeyEventKind) -> Self {
        self.kind = kind;
        self
    }

    /// Sets the produced text.
    pub fn with_text(mut self, text: &'a str) -> Self {
        self.text = Some(text);
        self
    }

    /// Sets the shifted-key alternate.
    pub fn with_shifted_key(mut self, c: char) -> Self {
        self.shifted_key = Some(c);
        self
    }

    /// Sets the base-layout-key alternate.
    pub fn with_base_layout_key(mut self, c: char) -> Self {
        self.base_layout_key = Some(c);
        self
    }
}

/// Appends the bytes for `ev` under `modes` to `out`. Returns `true` if
/// anything was written; `false` means the event sends nothing (a release in
/// legacy mode, a modifier key without kitty `0b1000`, and so on).
///
/// Never clears `out` and never allocates except to grow it.
pub fn encode_key(ev: &KeyEvent<'_>, modes: Modes, out: &mut Vec<u8>) -> bool {
    let start = out.len();
    let normalized;
    let ev = match ev.key {
        Key::Char(c) if c.is_control() => {
            let key = match c {
                '\r' | '\n' => Key::Enter,
                '\t' => Key::Tab,
                '\x1b' => Key::Escape,
                '\x7f' | '\x08' => Key::Backspace,
                _ => return false,
            };
            normalized = KeyEvent { key, ..*ev };
            &normalized
        }
        _ => ev,
    };
    let flags = modes.kitty_keyboard & kitty_flags::ALL;
    if flags & (DISAMBIGUATE | REPORT_EVENT_TYPES | REPORT_ALL_KEYS) == 0 {
        legacy(ev, modes, out);
    } else {
        kitty(ev, flags, modes, out);
    }
    out.len() != start
}

/// Text a key produces: the caller's string, or for a `Char` key with no
/// text given, the character itself (shifted when Shift is held).
#[derive(Clone, Copy)]
enum Text<'a> {
    Str(&'a str),
    Ch(char),
}

impl Text<'_> {
    fn push_utf8(self, out: &mut Vec<u8>) {
        match self {
            Text::Str(s) => out.extend_from_slice(s.as_bytes()),
            Text::Ch(c) => push_char(out, c),
        }
    }

    /// Code points separated by `:`, the kitty "text as code points" form.
    fn push_codepoints(self, out: &mut Vec<u8>) {
        match self {
            Text::Str(s) => {
                for (i, c) in s.chars().enumerate() {
                    if i > 0 {
                        out.push(b':');
                    }
                    push_u32(out, c as u32);
                }
            }
            Text::Ch(c) => push_u32(out, c as u32),
        }
    }
}

fn given_text<'a>(ev: &KeyEvent<'a>) -> Option<&'a str> {
    match ev.text {
        Some(t) if !t.is_empty() && !t.chars().any(char::is_control) => Some(t),
        _ => None,
    }
}

fn unshifted(c: char) -> char {
    c.to_ascii_lowercase()
}

fn shifted_char(c: char, shifted: Option<char>, shift: bool) -> char {
    if !shift {
        return c;
    }
    match shifted {
        Some(s) => s,
        None => c.to_ascii_uppercase(),
    }
}

/// The text a key event types, for deciding whether it is a "text key".
fn key_text<'a>(ev: &KeyEvent<'a>) -> Option<Text<'a>> {
    if let Some(t) = given_text(ev) {
        return Some(Text::Str(t));
    }
    match ev.key {
        Key::Char(c) if !c.is_control() => {
            let c = unshifted(c);
            let shifted = ev.shifted_key.filter(|s| !s.is_control());
            Some(Text::Ch(shifted_char(
                c,
                shifted,
                ev.mods.contains(Mods::SHIFT),
            )))
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Legacy xterm
// ---------------------------------------------------------------------------

/// Modifier bits legacy sequences carry; the lock bits have no legacy form.
const LEGACY_MASK: u8 = 0b0011_1111;

fn legacy(ev: &KeyEvent<'_>, modes: Modes, out: &mut Vec<u8>) {
    if ev.kind == KeyEventKind::Release {
        return;
    }
    let m = ev.mods.difference(Mods::LOCKS);
    match ev.key {
        Key::Char(c) => {
            legacy_char(
                unshifted(c),
                given_text(ev),
                ev.shifted_key,
                ev.base_layout_key,
                m,
                out,
            );
        }
        Key::Keypad(k) => legacy_keypad(k, ev, m, modes, out),
        key => {
            legacy_functional(key, m, modes.app_cursor_keys, out);
        }
    }
}

/// The kitty spec's legacy Ctrl mapping table ("Legacy ctrl mapping of ASCII
/// keys"). Keys not listed are left untouched by Ctrl.
pub(crate) fn ctrl_byte(c: char) -> Option<u8> {
    Some(match c {
        ' ' | '2' | '@' => 0,
        'a'..='z' => c as u8 - b'a' + 1,
        '3' | '[' => 27,
        '4' | '\\' => 28,
        '5' | ']' => 29,
        '6' | '^' | '~' => 30,
        '7' | '/' | '_' => 31,
        '8' | '?' => 127,
        _ => return None,
    })
}

/// Legacy encoding of a key with a code point. Returns `false` (and writes
/// nothing) when legacy has no encoding: Super, Hyper or Meta held.
///
/// Ctrl on a non-ASCII key with an ASCII base layout key uses the base key,
/// so Ctrl+С on a Cyrillic layout is Ctrl+C (`0x03`).
fn legacy_char(
    c: char,
    text: Option<&str>,
    shifted: Option<char>,
    base: Option<char>,
    m: Mods,
    out: &mut Vec<u8>,
) -> bool {
    if m.intersects(Mods::SUPER | Mods::HYPER | Mods::META) {
        return false;
    }
    let shift = m.contains(Mods::SHIFT);
    if m.contains(Mods::ALT) {
        out.push(ESC);
    }
    if !m.contains(Mods::CTRL) {
        match text {
            Some(t) => out.extend_from_slice(t.as_bytes()),
            None => push_char(out, shifted_char(c, shifted, shift)),
        }
        return true;
    }
    // Ctrl. Shift on a letter is dropped (xterm without modifyOtherKeys);
    // on anything else it selects the shifted character first, so Ctrl+Shift+2
    // is Ctrl+@ and Ctrl+Shift+- is Ctrl+_.
    let c = match base {
        Some(b) if !c.is_ascii() && b.is_ascii() && !b.is_ascii_control() => unshifted(b),
        _ => c,
    };
    let shifted = if c.is_ascii() {
        shifted.filter(char::is_ascii)
    } else {
        shifted
    };
    let k = if shift && !c.is_ascii_lowercase() {
        shifted.unwrap_or(c)
    } else {
        c
    };
    match ctrl_byte(k) {
        Some(b) => out.push(b),
        None => push_char(out, k),
    }
    true
}

/// `CSI 1;<mods> <letter>` with mods, else `SS3 <letter>` or `CSI <letter>`.
fn letter_key(out: &mut Vec<u8>, letter: u8, m: Mods, ss3_when_plain: bool) {
    let bits = m.bits() & LEGACY_MASK;
    if bits == 0 {
        if ss3_when_plain {
            ss3(out);
        } else {
            csi(out);
        }
    } else {
        csi(out);
        out.extend_from_slice(b"1;");
        push_u32(out, bits as u32 + 1);
    }
    out.push(letter);
}

/// `CSI <n>[;<mods>] ~`.
fn tilde_key(out: &mut Vec<u8>, n: u32, m: Mods) {
    csi(out);
    push_u32(out, n);
    let bits = m.bits() & LEGACY_MASK;
    if bits != 0 {
        out.push(b';');
        push_u32(out, bits as u32 + 1);
    }
    out.push(b'~');
}

/// Legacy keys without a code point. Returns `false` if legacy has no code.
fn legacy_functional(key: Key, m: Mods, app_cursor: bool, out: &mut Vec<u8>) -> bool {
    let alt = m.contains(Mods::ALT);
    match key {
        Key::Escape => {
            if alt {
                out.push(ESC);
            }
            out.push(ESC);
        }
        Key::Enter => {
            if alt {
                out.push(ESC);
            }
            out.push(b'\r');
        }
        Key::Backspace => {
            if alt {
                out.push(ESC);
            }
            out.push(if m.contains(Mods::CTRL) { 0x08 } else { 0x7f });
        }
        Key::Tab => {
            if alt {
                out.push(ESC);
            }
            if m.contains(Mods::SHIFT) {
                out.extend_from_slice(b"\x1b[Z");
            } else {
                out.push(b'\t');
            }
        }
        Key::Up => letter_key(out, b'A', m, app_cursor),
        Key::Down => letter_key(out, b'B', m, app_cursor),
        Key::Right => letter_key(out, b'C', m, app_cursor),
        Key::Left => letter_key(out, b'D', m, app_cursor),
        Key::Home => letter_key(out, b'H', m, app_cursor),
        Key::End => letter_key(out, b'F', m, app_cursor),
        Key::Insert => tilde_key(out, 2, m),
        Key::Delete => tilde_key(out, 3, m),
        Key::PageUp => tilde_key(out, 5, m),
        Key::PageDown => tilde_key(out, 6, m),
        // xterm sends F16's code for Menu; the kitty spec's legacy table agrees.
        Key::Menu => tilde_key(out, 29, m),
        Key::F(n) => return legacy_f(n, m, out),
        _ => return false,
    }
    true
}

fn legacy_f(n: u8, m: Mods, out: &mut Vec<u8>) -> bool {
    match n {
        1 => letter_key(out, b'P', m, true),
        2 => letter_key(out, b'Q', m, true),
        3 => letter_key(out, b'R', m, true),
        4 => letter_key(out, b'S', m, true),
        5..=12 => {
            const CODES: [u32; 8] = [15, 17, 18, 19, 20, 21, 23, 24];
            tilde_key(out, CODES[(n - 5) as usize], m);
        }
        13..=24 => return legacy_f(n - 12, m | Mods::SHIFT, out),
        _ => return false,
    }
    true
}

/// The character a keypad key types with Num Lock on, and its VT220
/// application-keypad final byte (`SS3 <final>`).
fn keypad_char(k: Keypad) -> Option<(char, u8)> {
    Some(match k {
        Keypad::Num0 => ('0', b'p'),
        Keypad::Num1 => ('1', b'q'),
        Keypad::Num2 => ('2', b'r'),
        Keypad::Num3 => ('3', b's'),
        Keypad::Num4 => ('4', b't'),
        Keypad::Num5 => ('5', b'u'),
        Keypad::Num6 => ('6', b'v'),
        Keypad::Num7 => ('7', b'w'),
        Keypad::Num8 => ('8', b'x'),
        Keypad::Num9 => ('9', b'y'),
        Keypad::Decimal => ('.', b'n'),
        Keypad::Divide => ('/', b'o'),
        Keypad::Multiply => ('*', b'j'),
        Keypad::Subtract => ('-', b'm'),
        Keypad::Add => ('+', b'k'),
        Keypad::Equal => ('=', b'X'),
        Keypad::Separator => (',', b'l'),
        _ => return None,
    })
}

/// The main-keyboard key a keypad key stands for when the keypad is not
/// reported separately.
fn keypad_as_main(k: Keypad) -> Key {
    if let Some((c, _)) = keypad_char(k) {
        return Key::Char(c);
    }
    match k {
        Keypad::Enter => Key::Enter,
        Keypad::Left => Key::Left,
        Keypad::Right => Key::Right,
        Keypad::Up => Key::Up,
        Keypad::Down => Key::Down,
        Keypad::PageUp => Key::PageUp,
        Keypad::PageDown => Key::PageDown,
        Keypad::Home => Key::Home,
        Keypad::End => Key::End,
        Keypad::Insert => Key::Insert,
        Keypad::Delete => Key::Delete,
        // Begin has no main-keyboard twin.
        _ => Key::Keypad(k),
    }
}

fn legacy_keypad(k: Keypad, ev: &KeyEvent<'_>, m: Mods, modes: Modes, out: &mut Vec<u8>) {
    let app = modes.app_keypad && m.is_empty();
    if let Some((c, app_final)) = keypad_char(k) {
        if app {
            ss3(out);
            out.push(app_final);
        } else {
            legacy_char(c, given_text(ev), None, None, m, out);
        }
        return;
    }
    match k {
        Keypad::Enter if app => {
            ss3(out);
            out.push(b'M');
        }
        Keypad::Begin => letter_key(out, b'E', m, modes.app_cursor_keys),
        _ => {
            legacy_functional(keypad_as_main(k), m, modes.app_cursor_keys, out);
        }
    }
}

// ---------------------------------------------------------------------------
// Kitty keyboard protocol
// ---------------------------------------------------------------------------

fn is_modifier_key(key: Key) -> bool {
    matches!(
        key,
        Key::Modifier(_) | Key::CapsLock | Key::NumLock | Key::ScrollLock
    )
}

/// Number and final byte from the kitty "Functional key definitions" table.
fn kitty_code(key: Key) -> Option<(u32, u8)> {
    Some(match key {
        Key::Char(c) => (unshifted(c) as u32, b'u'),
        Key::Escape => (27, b'u'),
        Key::Enter => (13, b'u'),
        Key::Tab => (9, b'u'),
        Key::Backspace => (127, b'u'),
        Key::Insert => (2, b'~'),
        Key::Delete => (3, b'~'),
        Key::Left => (1, b'D'),
        Key::Right => (1, b'C'),
        Key::Up => (1, b'A'),
        Key::Down => (1, b'B'),
        Key::PageUp => (5, b'~'),
        Key::PageDown => (6, b'~'),
        Key::Home => (1, b'H'),
        Key::End => (1, b'F'),
        Key::CapsLock => (57358, b'u'),
        Key::ScrollLock => (57359, b'u'),
        Key::NumLock => (57360, b'u'),
        Key::PrintScreen => (57361, b'u'),
        Key::Pause => (57362, b'u'),
        Key::Menu => (57363, b'u'),
        Key::F(n) => match n {
            1 => (1, b'P'),
            2 => (1, b'Q'),
            3 => (13, b'~'),
            4 => (1, b'S'),
            5 => (15, b'~'),
            6 => (17, b'~'),
            7 => (18, b'~'),
            8 => (19, b'~'),
            9 => (20, b'~'),
            10 => (21, b'~'),
            11 => (23, b'~'),
            12 => (24, b'~'),
            13..=35 => (57376 + (n as u32 - 13), b'u'),
            _ => return None,
        },
        Key::Keypad(k) => match k {
            Keypad::Num0 => (57399, b'u'),
            Keypad::Num1 => (57400, b'u'),
            Keypad::Num2 => (57401, b'u'),
            Keypad::Num3 => (57402, b'u'),
            Keypad::Num4 => (57403, b'u'),
            Keypad::Num5 => (57404, b'u'),
            Keypad::Num6 => (57405, b'u'),
            Keypad::Num7 => (57406, b'u'),
            Keypad::Num8 => (57407, b'u'),
            Keypad::Num9 => (57408, b'u'),
            Keypad::Decimal => (57409, b'u'),
            Keypad::Divide => (57410, b'u'),
            Keypad::Multiply => (57411, b'u'),
            Keypad::Subtract => (57412, b'u'),
            Keypad::Add => (57413, b'u'),
            Keypad::Enter => (57414, b'u'),
            Keypad::Equal => (57415, b'u'),
            Keypad::Separator => (57416, b'u'),
            Keypad::Left => (57417, b'u'),
            Keypad::Right => (57418, b'u'),
            Keypad::Up => (57419, b'u'),
            Keypad::Down => (57420, b'u'),
            Keypad::PageUp => (57421, b'u'),
            Keypad::PageDown => (57422, b'u'),
            Keypad::Home => (57423, b'u'),
            Keypad::End => (57424, b'u'),
            Keypad::Insert => (57425, b'u'),
            Keypad::Delete => (57426, b'u'),
            Keypad::Begin => (1, b'E'),
        },
        Key::Media(m) => (
            match m {
                Media::Play => 57428,
                Media::Pause => 57429,
                Media::PlayPause => 57430,
                Media::Reverse => 57431,
                Media::Stop => 57432,
                Media::FastForward => 57433,
                Media::Rewind => 57434,
                Media::TrackNext => 57435,
                Media::TrackPrevious => 57436,
                Media::Record => 57437,
                Media::LowerVolume => 57438,
                Media::RaiseVolume => 57439,
                Media::MuteVolume => 57440,
            },
            b'u',
        ),
        Key::Modifier(m) => (
            match m {
                ModifierKey::LeftShift => 57441,
                ModifierKey::LeftControl => 57442,
                ModifierKey::LeftAlt => 57443,
                ModifierKey::LeftSuper => 57444,
                ModifierKey::LeftHyper => 57445,
                ModifierKey::LeftMeta => 57446,
                ModifierKey::RightShift => 57447,
                ModifierKey::RightControl => 57448,
                ModifierKey::RightAlt => 57449,
                ModifierKey::RightSuper => 57450,
                ModifierKey::RightHyper => 57451,
                ModifierKey::RightMeta => 57452,
                ModifierKey::IsoLevel3Shift => 57453,
                ModifierKey::IsoLevel5Shift => 57454,
            },
            b'u',
        ),
    })
}

/// One kitty escape:
/// `CSI key[:shifted[:base]] [; mods+1[:event]] [; text-codepoints] final`.
struct KittySeq<'a> {
    code: u32,
    final_byte: u8,
    shifted: Option<u32>,
    base: Option<u32>,
    mods: u8,
    /// `2` repeat or `3` release; `None` for a press.
    event: Option<u8>,
    text: Option<Text<'a>>,
}

impl KittySeq<'_> {
    fn write(&self, out: &mut Vec<u8>) {
        let alternates = self.shifted.is_some() || self.base.is_some();
        let second = self.mods != 0 || self.event.is_some();
        let third = self.text.is_some();
        csi(out);
        // `CSI 1 X` drops the 1 when nothing follows it.
        if self.code != 1 || alternates || second || third {
            push_u32(out, self.code);
        }
        if alternates {
            out.push(b':');
            if let Some(s) = self.shifted {
                push_u32(out, s);
            }
            if let Some(b) = self.base {
                out.push(b':');
                push_u32(out, b);
            }
        }
        if second || third {
            out.push(b';');
            if second {
                push_u32(out, self.mods as u32 + 1);
                if let Some(e) = self.event {
                    out.push(b':');
                    push_u32(out, e as u32);
                }
            }
        }
        if let Some(t) = self.text {
            out.push(b';');
            t.push_codepoints(out);
        }
        out.push(self.final_byte);
    }
}

fn kitty(ev: &KeyEvent<'_>, flags: u8, modes: Modes, out: &mut Vec<u8>) {
    let disambiguate = flags & DISAMBIGUATE != 0;
    let events = flags & REPORT_EVENT_TYPES != 0;
    let all_keys = flags & REPORT_ALL_KEYS != 0;
    let alternates = flags & REPORT_ALTERNATES != 0;
    let embed_text = all_keys && flags & REPORT_TEXT != 0;

    // Without disambiguation or report-all, a press is exactly the legacy
    // bytes: event types add releases and repeats, and alternates only
    // decorate keys some other flag escapes. This is decided before anything
    // else so neither flag can change whether a press is escaped.
    if !disambiguate && !all_keys && ev.kind == KeyEventKind::Press {
        let start = out.len();
        legacy(ev, modes, out);
        if out.len() != start {
            return;
        }
        // Nothing in legacy (Super+A, media keys, F25+): fall through to CSI u.
    }

    let kind = match ev.kind {
        KeyEventKind::Release if !events => return,
        KeyEventKind::Repeat if !events => KeyEventKind::Press,
        k => k,
    };
    if is_modifier_key(ev.key) && !all_keys {
        return;
    }
    let mods = ev.mods;
    let no_locks = mods.difference(Mods::LOCKS);
    let text = key_text(ev);
    // A key that types text (nothing but Shift and the locks held) is sent as
    // that text; its release is not reported without "report all keys".
    let typing = text.is_some() && no_locks.difference(Mods::SHIFT).is_empty();
    if typing && !all_keys {
        if kind != KeyEventKind::Release {
            if let Some(t) = text {
                t.push_utf8(out);
            }
        }
        return;
    }

    // Without disambiguation the keypad is reported as the main keys.
    let key = match ev.key {
        Key::Keypad(k) if !disambiguate && !all_keys => keypad_as_main(k),
        k => k,
    };
    // "The Lock modifiers are not reported for text producing keys" unless
    // report-all is on (spec "Disambiguate escape codes").
    let mods = match key {
        Key::Char(_) if !all_keys => mods.difference(Mods::LOCKS),
        _ => mods,
    };

    let mut shifted = None;
    let mut base = None;
    if let Key::Char(c) = key {
        if alternates {
            let c = unshifted(c);
            if mods.contains(Mods::SHIFT) {
                shifted = ev.shifted_key.filter(|&s| s != c).map(|s| s as u32);
            }
            base = ev.base_layout_key.filter(|&b| b != c).map(|b| b as u32);
        }
    }

    if matches!(key, Key::Enter | Key::Tab | Key::Backspace) && !all_keys {
        // No release events for these without report-all (spec "Report event
        // types", note), and unmodified they keep their legacy bytes.
        if kind == KeyEventKind::Release {
            return;
        }
        if no_locks.is_empty() || !disambiguate {
            legacy_functional(key, no_locks, false, out);
            return;
        }
    }

    let Some((code, final_byte)) = kitty_code(key) else {
        return;
    };
    let is_u = final_byte == b'u';
    let event = match kind {
        KeyEventKind::Press => None,
        KeyEventKind::Repeat => Some(2),
        KeyEventKind::Release => Some(3),
    };
    // Only a key that actually types text carries it (Ctrl+A types nothing).
    let text = if embed_text && typing && is_u && kind != KeyEventKind::Release {
        text
    } else {
        None
    };
    KittySeq {
        code,
        final_byte,
        shifted: if is_u { shifted } else { None },
        base: if is_u { base } else { None },
        mods: mods.bits(),
        event,
        text,
    }
    .write(out);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ctrl_mapping_matches_the_kitty_table() {
        // "Legacy ctrl mapping of ASCII keys", every row; keys mapping to
        // themselves ('0', '1', '9') are "left untouched".
        let table: &[(char, u8)] = &[
            (' ', 0),
            ('/', 31),
            ('0', 48),
            ('1', 49),
            ('2', 0),
            ('3', 27),
            ('4', 28),
            ('5', 29),
            ('6', 30),
            ('7', 31),
            ('8', 127),
            ('9', 57),
            ('?', 127),
            ('@', 0),
            ('[', 27),
            ('\\', 28),
            (']', 29),
            ('^', 30),
            ('_', 31),
            ('~', 30),
        ];
        for &(c, b) in table {
            let got = ctrl_byte(c).unwrap_or(c as u8);
            assert_eq!(got, b, "ctrl+{c:?}");
        }
        for (i, c) in ('a'..='z').enumerate() {
            assert_eq!(ctrl_byte(c), Some(i as u8 + 1));
        }
        assert_eq!(ctrl_byte(';'), None);
        assert_eq!(ctrl_byte('A'), None);
    }
}
