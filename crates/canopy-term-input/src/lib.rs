//! Turns key, text, mouse, paste and focus events into the exact bytes a
//! terminal writes to its PTY, driven by the modes the program has set.
//!
//! Pure and I/O-free. Every encoder takes the program's current
//! [`Modes`](canopy_term_core::frame::Modes) by value (it is `Copy`, taken
//! from the latest frame) and **appends** to a caller-owned `Vec<u8>`: keep
//! one buffer, clear it between writes, and the hot path does not allocate
//! once it has grown. Each encoder returns `true` if it wrote anything
//! ([`encode_paste`] returns a [`PasteResult`] that also says whether control
//! characters were removed).
//!
//! ```
//! use canopy_term_input::{encode_key, Key, KeyEvent, Mods, Modes};
//!
//! let mut out = Vec::new();
//! let modes = Modes { app_cursor_keys: true, ..Modes::default() };
//! encode_key(&KeyEvent::new(Key::Up), modes, &mut out);
//! assert_eq!(out, b"\x1bOA");
//!
//! out.clear();
//! let ctrl_c = KeyEvent::new(Key::Char('c')).with_mods(Mods::CTRL);
//! encode_key(&ctrl_c, Modes::default(), &mut out);
//! assert_eq!(out, b"\x03");
//! ```
//!
//! Sources, cited where each table lives:
//!
//! * Kitty keyboard protocol: <https://sw.kovidgoyal.net/kitty/keyboard-protocol/>
//!   (modifier bits, progressive-enhancement flags, functional key numbers,
//!   legacy C0 and Ctrl tables).
//! * xterm control sequences: <https://invisible-island.net/xterm/ctlseqs/ctlseqs.html>
//!   (cursor and keypad modes, function keys, mouse tracking and encodings,
//!   bracketed paste, focus events).
//!
//! The window layer maps its platform events onto [`KeyEvent`],
//! [`MouseEvent`], paste text and focus changes; nothing here depends on a
//! windowing crate.

#![forbid(unsafe_code)]

mod buf;
mod key;
mod mods;
mod mouse;
mod paste;

pub use canopy_term_core::frame::{Modes, MouseEncoding, MouseMode};
pub use key::{encode_key, kitty_flags, Key, KeyEvent, KeyEventKind, Keypad, Media, ModifierKey};
pub use mods::Mods;
pub use mouse::{
    encode_mouse, MouseButton, MouseEvent, MouseEventKind, LEGACY_COORD_LIMIT, UTF8_COORD_LIMIT,
};
pub use paste::{
    encode_focus, encode_paste, encode_paste_with, encode_text, PasteResult, PASTE_END, PASTE_START,
};
