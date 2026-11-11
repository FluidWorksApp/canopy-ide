//! winit events onto `canopy-term-input`'s types. The encoding itself (legacy,
//! kitty, mouse encodings, bracketed paste) is entirely canopy-term-input's;
//! this module only translates.
//!
//! Functions take the parts of a winit `KeyEvent` rather than the event itself
//! (its platform field cannot be built outside winit), so the mapping is tested
//! here without a window.

use canopy_term_core::frame::{Modes, MouseMode};
use canopy_term_input::{
    Key, KeyEvent, KeyEventKind, Keypad, Media, ModifierKey, Mods, MouseButton,
};
use winit::event::{ElementState, MouseButton as WMouseButton, MouseScrollDelta};
use winit::keyboard::{Key as WKey, KeyLocation, ModifiersState, NamedKey};

use crate::shortcuts::Platform;

/// winit's modifier state as canopy-term-input bits. winit 0.30 reports no
/// lock state, so Caps Lock and Num Lock are never set.
pub fn mods_from(m: ModifiersState) -> Mods {
    let mut out = Mods::NONE;
    if m.shift_key() {
        out |= Mods::SHIFT;
    }
    if m.alt_key() {
        out |= Mods::ALT;
    }
    if m.control_key() {
        out |= Mods::CTRL;
    }
    if m.super_key() {
        out |= Mods::SUPER;
    }
    out
}

/// The parts of a winit key event the mapping reads.
#[derive(Clone, Copy, Debug)]
pub struct KeyParts<'a> {
    /// `KeyEvent::logical_key`: the key with modifiers applied ("A", "!").
    pub logical: &'a WKey,
    /// The key without modifiers (`key_without_modifiers()` where winit has
    /// it, else the logical key): "a", "1".
    pub unmodified: &'a WKey,
    pub location: KeyLocation,
    pub state: ElementState,
    pub repeat: bool,
    /// `KeyEvent::text`.
    pub text: Option<&'a str>,
    pub mods: ModifiersState,
}

fn single_char(s: &str) -> Option<char> {
    let mut it = s.chars();
    let c = it.next()?;
    it.next().is_none().then_some(c)
}

const F_KEYS: [NamedKey; 35] = [
    NamedKey::F1,
    NamedKey::F2,
    NamedKey::F3,
    NamedKey::F4,
    NamedKey::F5,
    NamedKey::F6,
    NamedKey::F7,
    NamedKey::F8,
    NamedKey::F9,
    NamedKey::F10,
    NamedKey::F11,
    NamedKey::F12,
    NamedKey::F13,
    NamedKey::F14,
    NamedKey::F15,
    NamedKey::F16,
    NamedKey::F17,
    NamedKey::F18,
    NamedKey::F19,
    NamedKey::F20,
    NamedKey::F21,
    NamedKey::F22,
    NamedKey::F23,
    NamedKey::F24,
    NamedKey::F25,
    NamedKey::F26,
    NamedKey::F27,
    NamedKey::F28,
    NamedKey::F29,
    NamedKey::F30,
    NamedKey::F31,
    NamedKey::F32,
    NamedKey::F33,
    NamedKey::F34,
    NamedKey::F35,
];

/// A keypad key from the logical key (which says whether Num Lock turned it
/// into a digit or a navigation key).
fn keypad_key(logical: &WKey) -> Option<Key> {
    let k = match logical {
        WKey::Character(s) => match single_char(s)? {
            c @ '0'..='9' => match c {
                '0' => Keypad::Num0,
                '1' => Keypad::Num1,
                '2' => Keypad::Num2,
                '3' => Keypad::Num3,
                '4' => Keypad::Num4,
                '5' => Keypad::Num5,
                '6' => Keypad::Num6,
                '7' => Keypad::Num7,
                '8' => Keypad::Num8,
                _ => Keypad::Num9,
            },
            '.' => Keypad::Decimal,
            ',' => Keypad::Separator,
            '/' => Keypad::Divide,
            '*' => Keypad::Multiply,
            '-' => Keypad::Subtract,
            '+' => Keypad::Add,
            '=' => Keypad::Equal,
            _ => return None,
        },
        WKey::Named(n) => match n {
            NamedKey::Enter => Keypad::Enter,
            NamedKey::ArrowLeft => Keypad::Left,
            NamedKey::ArrowRight => Keypad::Right,
            NamedKey::ArrowUp => Keypad::Up,
            NamedKey::ArrowDown => Keypad::Down,
            NamedKey::PageUp => Keypad::PageUp,
            NamedKey::PageDown => Keypad::PageDown,
            NamedKey::Home => Keypad::Home,
            NamedKey::End => Keypad::End,
            NamedKey::Insert => Keypad::Insert,
            NamedKey::Delete => Keypad::Delete,
            NamedKey::Clear => Keypad::Begin,
            _ => return None,
        },
        _ => return None,
    };
    Some(Key::Keypad(k))
}

fn side(location: KeyLocation, left: ModifierKey, right: ModifierKey) -> Key {
    Key::Modifier(if location == KeyLocation::Right {
        right
    } else {
        left
    })
}

/// A non-keypad key.
fn main_key(key: &WKey, location: KeyLocation) -> Option<Key> {
    use ModifierKey as M;
    let n = match key {
        WKey::Character(s) => return single_char(s).map(Key::Char),
        WKey::Named(n) => *n,
        _ => return None,
    };
    if let Some(i) = F_KEYS.iter().position(|f| *f == n) {
        return Some(Key::F(i as u8 + 1));
    }
    Some(match n {
        NamedKey::Escape => Key::Escape,
        NamedKey::Enter => Key::Enter,
        NamedKey::Tab => Key::Tab,
        NamedKey::Backspace => Key::Backspace,
        NamedKey::Space => Key::Char(' '),
        NamedKey::Insert => Key::Insert,
        NamedKey::Delete => Key::Delete,
        NamedKey::ArrowLeft => Key::Left,
        NamedKey::ArrowRight => Key::Right,
        NamedKey::ArrowUp => Key::Up,
        NamedKey::ArrowDown => Key::Down,
        NamedKey::PageUp => Key::PageUp,
        NamedKey::PageDown => Key::PageDown,
        NamedKey::Home => Key::Home,
        NamedKey::End => Key::End,
        NamedKey::CapsLock => Key::CapsLock,
        NamedKey::ScrollLock => Key::ScrollLock,
        NamedKey::NumLock => Key::NumLock,
        NamedKey::PrintScreen => Key::PrintScreen,
        NamedKey::Pause => Key::Pause,
        NamedKey::ContextMenu => Key::Menu,
        NamedKey::Shift => side(location, M::LeftShift, M::RightShift),
        NamedKey::Control => side(location, M::LeftControl, M::RightControl),
        NamedKey::Alt => side(location, M::LeftAlt, M::RightAlt),
        NamedKey::Super => side(location, M::LeftSuper, M::RightSuper),
        NamedKey::Hyper => side(location, M::LeftHyper, M::RightHyper),
        NamedKey::Meta => side(location, M::LeftMeta, M::RightMeta),
        NamedKey::AltGraph => Key::Modifier(M::IsoLevel3Shift),
        NamedKey::MediaPlay => Key::Media(Media::Play),
        NamedKey::MediaPause => Key::Media(Media::Pause),
        NamedKey::MediaPlayPause => Key::Media(Media::PlayPause),
        NamedKey::MediaStop => Key::Media(Media::Stop),
        NamedKey::MediaFastForward => Key::Media(Media::FastForward),
        NamedKey::MediaRewind => Key::Media(Media::Rewind),
        NamedKey::MediaTrackNext => Key::Media(Media::TrackNext),
        NamedKey::MediaTrackPrevious => Key::Media(Media::TrackPrevious),
        NamedKey::MediaRecord => Key::Media(Media::Record),
        NamedKey::AudioVolumeDown => Key::Media(Media::LowerVolume),
        NamedKey::AudioVolumeUp => Key::Media(Media::RaiseVolume),
        NamedKey::AudioVolumeMute => Key::Media(Media::MuteVolume),
        _ => return None,
    })
}

/// A winit key event as a canopy-term-input `KeyEvent`, or `None` for keys
/// it has no name for (dead keys, unidentified keys); the caller then sends
/// the event's text, if any, as text.
pub fn map_key<'a>(p: &KeyParts<'a>, platform: Platform) -> Option<KeyEvent<'a>> {
    let kind = match (p.state, p.repeat) {
        (ElementState::Released, _) => KeyEventKind::Release,
        (ElementState::Pressed, true) => KeyEventKind::Repeat,
        (ElementState::Pressed, false) => KeyEventKind::Press,
    };
    let key = if p.location == KeyLocation::Numpad {
        keypad_key(p.logical).or_else(|| main_key(p.unmodified, p.location))
    } else {
        main_key(p.unmodified, p.location)
    }?;
    let mut mods = mods_from(p.mods);
    let text = p.text.filter(|t| !t.is_empty());
    let unmodified_char = match p.unmodified {
        WKey::Character(s) => single_char(s),
        _ => None,
    };
    let logical_char = match p.logical {
        WKey::Character(s) => single_char(s),
        _ => None,
    };
    // macOS Option composes characters (Option+A is "å"): the OS consumed Alt,
    // so it must not also become an ESC prefix.
    if platform == Platform::MacOs && mods.contains(Mods::ALT) {
        if let Some(t) = text {
            let composed = !t.chars().any(char::is_control) && single_char(t) != unmodified_char;
            if composed {
                mods = mods.difference(Mods::ALT);
            }
        }
    }
    let shifted_key = if mods.contains(Mods::SHIFT) && logical_char != unmodified_char {
        logical_char
    } else {
        None
    };
    Some(KeyEvent {
        key,
        mods,
        kind,
        text,
        shifted_key,
        base_layout_key: None,
    })
}

/// winit's buttons onto canopy-term-input's (wheel directions come from
/// `wheel_steps`). Buttons beyond Back/Forward are not reported.
pub fn mouse_button(b: WMouseButton) -> Option<MouseButton> {
    Some(match b {
        WMouseButton::Left => MouseButton::Left,
        WMouseButton::Middle => MouseButton::Middle,
        WMouseButton::Right => MouseButton::Right,
        WMouseButton::Back => MouseButton::Back,
        WMouseButton::Forward => MouseButton::Forward,
        WMouseButton::Other(_) => return None,
    })
}

/// Whether mouse events go to the program: it asked for them, and Shift is
/// not held (Shift always selects text instead).
pub fn reports_mouse(modes: &Modes, mods: ModifiersState) -> bool {
    modes.mouse != MouseMode::Off && !mods.shift_key()
}

/// Accumulates wheel movement and returns whole steps: positive is wheel up
/// (content moves down). Pixel deltas (trackpads) count one step per cell
/// height.
pub fn wheel_steps(acc: &mut f64, delta: MouseScrollDelta, cell_height: u32) -> i32 {
    match delta {
        MouseScrollDelta::LineDelta(_, y) => *acc += y as f64,
        MouseScrollDelta::PixelDelta(p) => *acc += p.y / cell_height.max(1) as f64,
    }
    let steps = acc.trunc();
    *acc -= steps;
    steps.clamp(-1000.0, 1000.0) as i32
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_term_input::encode_key;
    use winit::dpi::PhysicalPosition;

    fn ch(s: &str) -> WKey {
        WKey::Character(s.into())
    }

    fn parts<'a>(logical: &'a WKey, unmodified: &'a WKey, text: Option<&'a str>) -> KeyParts<'a> {
        KeyParts {
            logical,
            unmodified,
            location: KeyLocation::Standard,
            state: ElementState::Pressed,
            repeat: false,
            text,
            mods: ModifiersState::empty(),
        }
    }

    fn bytes(ev: &KeyEvent<'_>, modes: Modes) -> Vec<u8> {
        let mut out = Vec::new();
        encode_key(ev, modes, &mut out);
        out
    }

    #[test]
    fn modifiers_map_bit_for_bit() {
        let m = ModifiersState::SHIFT | ModifiersState::CONTROL;
        assert_eq!(mods_from(m), Mods::SHIFT | Mods::CTRL);
        assert_eq!(
            mods_from(ModifiersState::ALT | ModifiersState::SUPER),
            Mods::ALT | Mods::SUPER
        );
        assert_eq!(mods_from(ModifiersState::empty()), Mods::NONE);
    }

    #[test]
    fn a_letter_maps_to_its_unshifted_char_with_text() {
        let (l, u) = (ch("A"), ch("a"));
        let mut p = parts(&l, &u, Some("A"));
        p.mods = ModifiersState::SHIFT;
        let ev = map_key(&p, Platform::Other).unwrap();
        assert_eq!(ev.key, Key::Char('a'));
        assert_eq!(ev.text, Some("A"));
        assert_eq!(ev.mods, Mods::SHIFT);
        assert_eq!(ev.shifted_key, Some('A'));
        assert_eq!(bytes(&ev, Modes::default()), b"A");
    }

    #[test]
    fn ctrl_c_becomes_etx_through_the_encoder() {
        let (l, u) = (ch("c"), ch("c"));
        let mut p = parts(&l, &u, None);
        p.mods = ModifiersState::CONTROL;
        let ev = map_key(&p, Platform::Other).unwrap();
        assert_eq!(bytes(&ev, Modes::default()), b"\x03");
    }

    #[test]
    fn arrows_follow_cursor_key_mode() {
        let k = WKey::Named(NamedKey::ArrowUp);
        let ev = map_key(&parts(&k, &k, None), Platform::Other).unwrap();
        assert_eq!(ev.key, Key::Up);
        let app = Modes {
            app_cursor_keys: true,
            ..Modes::default()
        };
        assert_eq!(bytes(&ev, app), b"\x1bOA");
        assert_eq!(bytes(&ev, Modes::default()), b"\x1b[A");
    }

    #[test]
    fn named_keys_function_keys_and_space() {
        let cases = [
            (NamedKey::Enter, Key::Enter),
            (NamedKey::Escape, Key::Escape),
            (NamedKey::Backspace, Key::Backspace),
            (NamedKey::Space, Key::Char(' ')),
            (NamedKey::F1, Key::F(1)),
            (NamedKey::F12, Key::F(12)),
            (NamedKey::F35, Key::F(35)),
            (NamedKey::ContextMenu, Key::Menu),
            (NamedKey::MediaPlayPause, Key::Media(Media::PlayPause)),
        ];
        for (named, want) in cases {
            let k = WKey::Named(named);
            assert_eq!(
                map_key(&parts(&k, &k, None), Platform::Other).map(|e| e.key),
                Some(want),
                "{named:?}"
            );
        }
    }

    #[test]
    fn modifier_keys_keep_their_side() {
        let k = WKey::Named(NamedKey::Shift);
        let mut p = parts(&k, &k, None);
        p.location = KeyLocation::Right;
        assert_eq!(
            map_key(&p, Platform::Other).unwrap().key,
            Key::Modifier(ModifierKey::RightShift)
        );
        p.location = KeyLocation::Left;
        assert_eq!(
            map_key(&p, Platform::Other).unwrap().key,
            Key::Modifier(ModifierKey::LeftShift)
        );
    }

    #[test]
    fn keypad_digits_and_navigation_follow_num_lock() {
        let one = ch("1");
        let mut p = parts(&one, &one, Some("1"));
        p.location = KeyLocation::Numpad;
        assert_eq!(
            map_key(&p, Platform::Other).unwrap().key,
            Key::Keypad(Keypad::Num1)
        );
        let end = WKey::Named(NamedKey::End);
        let mut p = parts(&end, &end, None);
        p.location = KeyLocation::Numpad;
        assert_eq!(
            map_key(&p, Platform::Other).unwrap().key,
            Key::Keypad(Keypad::End)
        );
        let enter = WKey::Named(NamedKey::Enter);
        let mut p = parts(&enter, &enter, None);
        p.location = KeyLocation::Numpad;
        assert_eq!(
            map_key(&p, Platform::Other).unwrap().key,
            Key::Keypad(Keypad::Enter)
        );
    }

    #[test]
    fn release_and_repeat_kinds() {
        let k = ch("x");
        let mut p = parts(&k, &k, Some("x"));
        p.repeat = true;
        assert_eq!(
            map_key(&p, Platform::Other).unwrap().kind,
            KeyEventKind::Repeat
        );
        p.state = ElementState::Released;
        let ev = map_key(&p, Platform::Other).unwrap();
        assert_eq!(ev.kind, KeyEventKind::Release);
        // Legacy mode sends nothing for a release.
        assert!(bytes(&ev, Modes::default()).is_empty());
    }

    #[test]
    fn macos_option_composition_drops_alt_but_option_arrow_keeps_it() {
        let (l, u) = (ch("å"), ch("a"));
        let mut p = parts(&l, &u, Some("å"));
        p.mods = ModifiersState::ALT;
        let ev = map_key(&p, Platform::MacOs).unwrap();
        assert_eq!(ev.mods, Mods::NONE);
        assert_eq!(bytes(&ev, Modes::default()), "å".as_bytes());
        // Elsewhere Alt stays and becomes the encoder's ESC prefix.
        let ev = map_key(&p, Platform::Other).unwrap();
        assert!(ev.mods.contains(Mods::ALT));
        let left = WKey::Named(NamedKey::ArrowLeft);
        let mut p = parts(&left, &left, None);
        p.mods = ModifiersState::ALT;
        assert!(map_key(&p, Platform::MacOs)
            .unwrap()
            .mods
            .contains(Mods::ALT));
    }

    #[test]
    fn dead_and_unidentified_keys_are_left_to_text() {
        let dead = WKey::Dead(Some('`'));
        assert!(map_key(&parts(&dead, &dead, None), Platform::Other).is_none());
    }

    #[test]
    fn mouse_buttons_and_reporting() {
        assert_eq!(mouse_button(WMouseButton::Left), Some(MouseButton::Left));
        assert_eq!(mouse_button(WMouseButton::Other(9)), None);
        let on = Modes {
            mouse: MouseMode::Normal,
            ..Modes::default()
        };
        assert!(reports_mouse(&on, ModifiersState::empty()));
        assert!(!reports_mouse(&on, ModifiersState::SHIFT));
        assert!(!reports_mouse(&Modes::default(), ModifiersState::empty()));
    }

    #[test]
    fn wheel_steps_accumulate_fractions() {
        let mut acc = 0.0;
        assert_eq!(
            wheel_steps(&mut acc, MouseScrollDelta::LineDelta(0.0, 1.0), 20),
            1
        );
        assert_eq!(
            wheel_steps(&mut acc, MouseScrollDelta::LineDelta(0.0, -2.0), 20),
            -2
        );
        // A trackpad: 10 px at 20 px per cell is half a step, twice.
        let px = MouseScrollDelta::PixelDelta(PhysicalPosition::new(0.0, 10.0));
        assert_eq!(wheel_steps(&mut acc, px, 20), 0);
        assert_eq!(wheel_steps(&mut acc, px, 20), 1);
        assert!(acc.abs() < 1e-9);
    }
}
