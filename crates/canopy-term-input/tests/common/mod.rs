#![allow(dead_code)]

use canopy_term_input::*;

/// Printable form of bytes for failure messages.
pub fn show(bytes: &[u8]) -> String {
    bytes
        .iter()
        .flat_map(|&b| std::ascii::escape_default(b))
        .map(char::from)
        .collect()
}

pub fn key(ev: KeyEvent<'_>, modes: Modes) -> Vec<u8> {
    let mut out = Vec::new();
    let wrote = encode_key(&ev, modes, &mut out);
    assert_eq!(
        wrote,
        !out.is_empty(),
        "return value must say whether bytes were written"
    );
    out
}

/// Runs a table of (event, expected bytes) under `modes`.
pub fn check_keys(modes: Modes, table: &[(KeyEvent<'_>, &[u8])]) {
    for (i, (ev, want)) in table.iter().enumerate() {
        let got = key(*ev, modes);
        assert_eq!(
            show(&got),
            show(want),
            "row {i}: {ev:?} under kitty flags {:#b}",
            modes.kitty_keyboard
        );
    }
}

pub fn kitty(flags: u8) -> Modes {
    Modes {
        kitty_keyboard: flags,
        ..Modes::default()
    }
}

pub fn k(key: Key) -> KeyEvent<'static> {
    KeyEvent::new(key)
}

pub fn c(ch: char) -> KeyEvent<'static> {
    KeyEvent::new(Key::Char(ch))
}

pub const SHIFT: Mods = Mods::SHIFT;
pub const ALT: Mods = Mods::ALT;
pub const CTRL: Mods = Mods::CTRL;
pub const SUPER: Mods = Mods::SUPER;
pub const HYPER: Mods = Mods::HYPER;
pub const META: Mods = Mods::META;
pub const CAPS: Mods = Mods::CAPS_LOCK;
pub const NUM: Mods = Mods::NUM_LOCK;
