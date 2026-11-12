#![no_main]

use canopy_term_input::*;
use libfuzzer_sys::fuzz_target;

struct Reader<'a>(&'a [u8]);

impl Reader<'_> {
    fn u8(&mut self) -> u8 {
        match self.0.split_first() {
            Some((&b, rest)) => {
                self.0 = rest;
                b
            }
            None => 0,
        }
    }
    fn u16(&mut self) -> u16 {
        u16::from(self.u8()) << 8 | u16::from(self.u8())
    }
    fn char(&mut self) -> char {
        char::from_u32(u32::from(self.u16()) * 17).unwrap_or('a')
    }
}

fn key(r: &mut Reader<'_>) -> Key {
    match r.u8() % 12 {
        0 => Key::Char(r.char()),
        1 => Key::F(r.u8()),
        2 => Key::Keypad(Keypad::Begin),
        3 => Key::Media(Media::Play),
        4 => Key::Modifier(ModifierKey::LeftShift),
        5 => Key::Escape,
        6 => Key::Enter,
        7 => Key::Tab,
        8 => Key::Backspace,
        9 => Key::Up,
        10 => Key::Delete,
        _ => Key::Home,
    }
}

fn check(wrote: bool, before: usize, out: &[u8]) {
    assert_eq!(wrote, out.len() != before);
}

fuzz_target!(|data: &[u8]| {
    let mut r = Reader(data);
    let modes = Modes {
        mouse: match r.u8() % 5 {
            0 => MouseMode::Off,
            1 => MouseMode::Press,
            2 => MouseMode::Normal,
            3 => MouseMode::Drag,
            _ => MouseMode::Any,
        },
        mouse_encoding: match r.u8() % 3 {
            0 => MouseEncoding::Default,
            1 => MouseEncoding::Utf8,
            _ => MouseEncoding::Sgr,
        },
        bracketed_paste: r.u8() & 1 == 1,
        app_cursor_keys: r.u8() & 1 == 1,
        app_keypad: r.u8() & 1 == 1,
        focus_events: r.u8() & 1 == 1,
        sync_output: false,
        kitty_keyboard: r.u8(),
    };
    let mut out = b"pre".to_vec();
    let before = out.len();
    match r.u8() % 4 {
        0 => {
            let text = String::from_utf8_lossy(r.0).into_owned();
            let mut ev = KeyEvent::new(key(&mut r)).with_mods(Mods(r.u8()));
            ev = ev.with_kind(match r.u8() % 3 {
                0 => KeyEventKind::Press,
                1 => KeyEventKind::Repeat,
                _ => KeyEventKind::Release,
            });
            if r.u8() & 1 == 1 {
                ev = ev.with_text(&text);
            }
            let wrote = encode_key(&ev, modes, &mut out);
            check(wrote, before, &out);
        }
        1 => {
            let button = match r.u8() % 4 {
                0 => MouseButton::Left,
                1 => MouseButton::WheelUp,
                2 => MouseButton::Back,
                _ => MouseButton::Button11,
            };
            let kind = match r.u8() % 3 {
                0 => MouseEventKind::Press(button),
                1 => MouseEventKind::Release(button),
                _ => MouseEventKind::Motion(Some(button)),
            };
            let ev = MouseEvent {
                kind,
                col: r.u16(),
                row: r.u16(),
                mods: Mods(r.u8()),
            };
            let wrote = encode_mouse(&ev, modes, &mut out);
            check(wrote, before, &out);
        }
        2 => {
            let text = String::from_utf8_lossy(r.0).into_owned();
            let res = encode_paste_with(&text, modes, r.u8() & 1 == 1, &mut out);
            check(res.written, before, &out);
        }
        _ => {
            let wrote = encode_focus(r.u8() & 1 == 1, modes, &mut out);
            check(wrote, before, &out);
        }
    }
    assert!(out.starts_with(b"pre"));
});
