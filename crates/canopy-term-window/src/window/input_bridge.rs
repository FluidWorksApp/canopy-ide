//! TEMPORARY. Track F (`crates/canopy-term-input`) owns the input event types
//! and the key, mouse, paste and focus encoders. Until it lands, this one
//! module maps winit events to bytes through a throwaway trait so the window can
//! be typed into. When canopy-term-input is pushed, this module is replaced by
//! a mapping from winit events onto its types and the trait is deleted.
//!
//! `BasicInput` covers only what a demo needs: text, Enter, Backspace, Tab,
//! Escape, arrows (DECCKM aware), Home/End/PageUp/PageDown/Insert/Delete,
//! Ctrl+letter, Alt as an ESC prefix (not on macOS), bracketed paste and focus
//! reports. No kitty protocol, no modifyOtherKeys, no mouse reporting.

use canopy_term_core::frame::Modes;
use winit::event::{ElementState, KeyEvent};
use winit::keyboard::{Key, ModifiersState, NamedKey};

/// TEMPORARY boundary, deleted when canopy-term-input lands.
pub trait InputBridge {
    /// Bytes for a key event (press, repeat or release), or `None`.
    fn key(&mut self, event: &KeyEvent, mods: ModifiersState, modes: &Modes) -> Option<Vec<u8>>;

    /// Bytes for text committed by an input method.
    fn text(&mut self, text: &str, _modes: &Modes) -> Vec<u8> {
        text.as_bytes().to_vec()
    }

    /// Bytes for pasted text.
    fn paste(&mut self, text: &str, modes: &Modes) -> Vec<u8>;

    /// Bytes for a focus change (only when the program asked for them).
    fn focus(&mut self, focused: bool, modes: &Modes) -> Option<Vec<u8>>;
}

/// TEMPORARY minimal encoder (see the module docs).
#[derive(Clone, Copy, Debug, Default)]
pub struct BasicInput;

fn ctrl_byte(c: char) -> Option<u8> {
    Some(match c.to_ascii_lowercase() {
        c @ 'a'..='z' => c as u8 - b'a' + 1,
        '@' | ' ' | '2' => 0,
        '[' | '3' => 0x1b,
        '\\' | '4' => 0x1c,
        ']' | '5' => 0x1d,
        '^' | '6' => 0x1e,
        '_' | '-' | '7' => 0x1f,
        '?' | '8' => 0x7f,
        _ => return None,
    })
}

impl InputBridge for BasicInput {
    fn key(&mut self, event: &KeyEvent, mods: ModifiersState, modes: &Modes) -> Option<Vec<u8>> {
        if event.state != ElementState::Pressed {
            return None;
        }
        let cursor = |c: u8| {
            if modes.app_cursor_keys {
                vec![0x1b, b'O', c]
            } else {
                vec![0x1b, b'[', c]
            }
        };
        let tilde = |n: &[u8]| {
            let mut v = vec![0x1b, b'['];
            v.extend_from_slice(n);
            v.push(b'~');
            v
        };
        let alt_prefix = mods.alt_key() && !cfg!(target_os = "macos");
        let named = match &event.logical_key {
            Key::Named(NamedKey::Enter) => Some(vec![b'\r']),
            Key::Named(NamedKey::Backspace) => Some(vec![0x7f]),
            Key::Named(NamedKey::Tab) if mods.shift_key() => Some(b"\x1b[Z".to_vec()),
            Key::Named(NamedKey::Tab) => Some(vec![b'\t']),
            Key::Named(NamedKey::Escape) => Some(vec![0x1b]),
            Key::Named(NamedKey::ArrowUp) => Some(cursor(b'A')),
            Key::Named(NamedKey::ArrowDown) => Some(cursor(b'B')),
            Key::Named(NamedKey::ArrowRight) => Some(cursor(b'C')),
            Key::Named(NamedKey::ArrowLeft) => Some(cursor(b'D')),
            Key::Named(NamedKey::Home) => Some(cursor(b'H')),
            Key::Named(NamedKey::End) => Some(cursor(b'F')),
            Key::Named(NamedKey::Insert) => Some(tilde(b"2")),
            Key::Named(NamedKey::Delete) => Some(tilde(b"3")),
            Key::Named(NamedKey::PageUp) => Some(tilde(b"5")),
            Key::Named(NamedKey::PageDown) => Some(tilde(b"6")),
            Key::Named(NamedKey::Space) if mods.control_key() => Some(vec![0]),
            _ => None,
        };
        if let Some(mut bytes) = named {
            if alt_prefix {
                bytes.insert(0, 0x1b);
            }
            return Some(bytes);
        }
        if mods.control_key() {
            if let Key::Character(s) = &event.logical_key {
                if let Some(b) = s.chars().next().and_then(ctrl_byte) {
                    let mut v = if alt_prefix { vec![0x1b] } else { Vec::new() };
                    v.push(b);
                    return Some(v);
                }
            }
        }
        let text = event.text.as_ref()?;
        if text.is_empty() {
            return None;
        }
        let mut v = if alt_prefix { vec![0x1b] } else { Vec::new() };
        v.extend_from_slice(text.as_bytes());
        Some(v)
    }

    fn paste(&mut self, text: &str, modes: &Modes) -> Vec<u8> {
        // Line breaks are sent as CR, as typed Enter would be.
        let body = text.replace("\r\n", "\r").replace('\n', "\r");
        if !modes.bracketed_paste {
            return body.into_bytes();
        }
        let body = body.replace("\x1b[201~", "");
        let mut v = b"\x1b[200~".to_vec();
        v.extend_from_slice(body.as_bytes());
        v.extend_from_slice(b"\x1b[201~");
        v
    }

    fn focus(&mut self, focused: bool, modes: &Modes) -> Option<Vec<u8>> {
        modes.focus_events.then(|| {
            if focused {
                b"\x1b[I".to_vec()
            } else {
                b"\x1b[O".to_vec()
            }
        })
    }
}
