//! Deterministic, seeded robustness tests for the input encoders: arbitrary
//! key, mouse, text, paste and focus events under arbitrary modes. Synthetic
//! input only.
//!
//! Checked for every event: no panic (debug build, so integer overflow counts),
//! the return value says whether bytes were appended, bytes are only appended
//! (the caller's buffer prefix is untouched and the result does not depend on
//! it), output is bounded by the input, and the structure of what is written
//! (valid UTF-8 for keys, report layouts for the mouse, markers and stripped
//! controls for paste). Seeds are fixed; a failure prints the event.
//!
//! Longer manual runs: `CANOPY_FUZZ_CASES=2000000 CANOPY_FUZZ_SEED=7 cargo test
//! --release --test fuzz`. The `fuzz/` directory next to `src/` holds the
//! cargo-fuzz targets (not part of CI).

use canopy_term_input::*;

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        Rng(z | 1)
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn chance(&mut self, percent: usize) -> bool {
        self.below(100) < percent
    }

    fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[self.below(items.len())]
    }
}

fn cases(default: u64) -> u64 {
    std::env::var("CANOPY_FUZZ_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn seed(salt: u64) -> u64 {
    std::env::var("CANOPY_FUZZ_SEED")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(1)
        ^ salt
}

fn esc(bytes: &[u8]) -> String {
    bytes
        .iter()
        .flat_map(|&b| std::ascii::escape_default(b))
        .map(char::from)
        .collect()
}

// ---------------------------------------------------------------------------
// Value pools
// ---------------------------------------------------------------------------

const KEYPAD: [Keypad; 29] = [
    Keypad::Num0,
    Keypad::Num1,
    Keypad::Num2,
    Keypad::Num3,
    Keypad::Num4,
    Keypad::Num5,
    Keypad::Num6,
    Keypad::Num7,
    Keypad::Num8,
    Keypad::Num9,
    Keypad::Decimal,
    Keypad::Divide,
    Keypad::Multiply,
    Keypad::Subtract,
    Keypad::Add,
    Keypad::Enter,
    Keypad::Equal,
    Keypad::Separator,
    Keypad::Left,
    Keypad::Right,
    Keypad::Up,
    Keypad::Down,
    Keypad::PageUp,
    Keypad::PageDown,
    Keypad::Home,
    Keypad::End,
    Keypad::Insert,
    Keypad::Delete,
    Keypad::Begin,
];

const MEDIA: [Media; 13] = [
    Media::Play,
    Media::Pause,
    Media::PlayPause,
    Media::Reverse,
    Media::Stop,
    Media::FastForward,
    Media::Rewind,
    Media::TrackNext,
    Media::TrackPrevious,
    Media::Record,
    Media::LowerVolume,
    Media::RaiseVolume,
    Media::MuteVolume,
];

const MODIFIER_KEYS: [ModifierKey; 14] = [
    ModifierKey::LeftShift,
    ModifierKey::LeftControl,
    ModifierKey::LeftAlt,
    ModifierKey::LeftSuper,
    ModifierKey::LeftHyper,
    ModifierKey::LeftMeta,
    ModifierKey::RightShift,
    ModifierKey::RightControl,
    ModifierKey::RightAlt,
    ModifierKey::RightSuper,
    ModifierKey::RightHyper,
    ModifierKey::RightMeta,
    ModifierKey::IsoLevel3Shift,
    ModifierKey::IsoLevel5Shift,
];

const CHARS: [char; 28] = [
    'a',
    'A',
    'z',
    '0',
    '9',
    ' ',
    '!',
    '~',
    '@',
    '[',
    '?',
    'é',
    'С',
    '日',
    '😀',
    '\0',
    '\x01',
    '\x08',
    '\t',
    '\r',
    '\x1b',
    '\x7f',
    '\u{85}',
    '\u{9b}',
    '\u{e000}',
    '\u{f8ff}',
    '\u{10ffff}',
    char::MAX,
];

const TEXTS: [Option<&str>; 14] = [
    None,
    None,
    Some(""),
    Some("a"),
    Some("A"),
    Some("é"),
    Some("😀"),
    Some("日本"),
    Some("e\u{301}"),
    Some("\x1b"),
    Some("a\x07"),
    Some("\u{85}"),
    Some("\x7f"),
    Some("a\u{9b}b"),
];

const KINDS: [KeyEventKind; 3] = [
    KeyEventKind::Press,
    KeyEventKind::Repeat,
    KeyEventKind::Release,
];

fn all_keys() -> Vec<Key> {
    let mut keys: Vec<Key> = CHARS.iter().map(|&c| Key::Char(c)).collect();
    keys.extend([
        Key::Escape,
        Key::Enter,
        Key::Tab,
        Key::Backspace,
        Key::Insert,
        Key::Delete,
        Key::Left,
        Key::Right,
        Key::Up,
        Key::Down,
        Key::PageUp,
        Key::PageDown,
        Key::Home,
        Key::End,
        Key::CapsLock,
        Key::ScrollLock,
        Key::NumLock,
        Key::PrintScreen,
        Key::Pause,
        Key::Menu,
    ]);
    keys.extend((0..=40).map(Key::F));
    keys.push(Key::F(255));
    keys.extend(KEYPAD.iter().map(|&k| Key::Keypad(k)));
    keys.extend(MEDIA.iter().map(|&k| Key::Media(k)));
    keys.extend(MODIFIER_KEYS.iter().map(|&k| Key::Modifier(k)));
    keys
}

fn random_char(rng: &mut Rng) -> char {
    match rng.below(4) {
        0 => rng.pick(&CHARS),
        1 => (0x20 + rng.below(95) as u8) as char,
        _ => loop {
            if let Some(c) = char::from_u32(rng.next() as u32 % 0x11_0000) {
                break c;
            }
        },
    }
}

fn random_text(rng: &mut Rng) -> String {
    let n = if rng.chance(5) {
        rng.below(400)
    } else {
        rng.below(6)
    };
    (0..n).map(|_| random_char(rng)).collect()
}

fn random_modes(rng: &mut Rng) -> Modes {
    Modes {
        mouse: rng.pick(&[
            MouseMode::Off,
            MouseMode::Press,
            MouseMode::Normal,
            MouseMode::Drag,
            MouseMode::Any,
        ]),
        mouse_encoding: rng.pick(&[
            MouseEncoding::Default,
            MouseEncoding::Utf8,
            MouseEncoding::Sgr,
        ]),
        bracketed_paste: rng.chance(50),
        app_cursor_keys: rng.chance(50),
        app_keypad: rng.chance(50),
        focus_events: rng.chance(50),
        sync_output: rng.chance(50),
        // Every byte, not only the five defined bits.
        kitty_keyboard: rng.next() as u8,
    }
}

/// The checks every encoder call must pass; `what` names the event on failure.
fn check_append(what: &str, wrote: bool, before: &[u8], after: &[u8], alone: &[u8]) {
    assert!(
        after.starts_with(before),
        "{what}: the caller's bytes were changed"
    );
    assert_eq!(
        wrote,
        after.len() != before.len(),
        "{what}: return value {wrote} but {} bytes appended",
        after.len() - before.len().min(after.len())
    );
    assert_eq!(
        &after[before.len()..],
        alone,
        "{what}: output depends on what was already in the buffer"
    );
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

fn check_key(ev: &KeyEvent<'_>, modes: Modes) {
    let what = format!("{ev:?} under {modes:?}");
    let mut alone = Vec::new();
    let wrote = encode_key(ev, modes, &mut alone);

    let before = b"PRE\x1b[".to_vec();
    let mut after = before.clone();
    let wrote_again = encode_key(ev, modes, &mut after);
    assert_eq!(wrote, wrote_again, "{what}: not deterministic");
    check_append(&what, wrote, &before, &after, &alone);

    // Bounded by the input: a code point is at most 8 bytes in the text list,
    // everything else is a handful of numbers.
    let text_len = ev.text.map_or(0, str::len);
    assert!(
        alone.len() <= 96 + 8 * text_len,
        "{what}: {} bytes written",
        alone.len()
    );
    assert!(
        std::str::from_utf8(&alone).is_ok(),
        "{what}: output is not UTF-8: {}",
        esc(&alone)
    );

    let flags = modes.kitty_keyboard & kitty_flags::ALL;
    let legacy = flags
        & (kitty_flags::DISAMBIGUATE
            | kitty_flags::REPORT_EVENT_TYPES
            | kitty_flags::REPORT_ALL_KEYS)
        == 0;
    if legacy && ev.kind == KeyEventKind::Release {
        assert!(!wrote, "{what}: a release in legacy mode wrote bytes");
    }
    if let Key::F(n) = ev.key {
        if n == 0 || n > 35 {
            assert!(!wrote, "{what}: F{n} wrote {}", esc(&alone));
        }
    }
    if let Some(t) = ev.text {
        if t.chars().any(char::is_control) {
            // Text with control characters is ignored, whole.
            let bare = KeyEvent { text: None, ..*ev };
            let mut without = Vec::new();
            encode_key(&bare, modes, &mut without);
            assert_eq!(
                alone,
                without,
                "{what}: control text changed the output (without it: {})",
                esc(&without)
            );
        }
    }
}

#[test]
fn every_key_under_every_flag_and_modifier_combination() {
    let keys = all_keys();
    let mods = [
        0u8,
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        16,
        32,
        64,
        128,
        63,
        64 | 1,
        128 | 4,
        192,
        255,
        0b1010_1010,
        0b0101_0101,
    ];
    for &key in &keys {
        for flags in 0u8..64 {
            for &m in &mods {
                for kind in KINDS {
                    for (cursor, keypad) in [(false, false), (true, true)] {
                        let modes = Modes {
                            kitty_keyboard: flags,
                            app_cursor_keys: cursor,
                            app_keypad: keypad,
                            ..Modes::default()
                        };
                        let ev = KeyEvent::new(key).with_mods(Mods(m)).with_kind(kind);
                        check_key(&ev, modes);
                    }
                }
            }
        }
    }
}

#[test]
fn random_key_events() {
    let keys = all_keys();
    let mut rng = Rng::new(seed(0xA1));
    for _ in 0..cases(40_000) {
        let key = if rng.chance(15) {
            Key::Char(random_char(&mut rng))
        } else {
            rng.pick(&keys)
        };
        let text = match rng.below(4) {
            0 => Some(random_text(&mut rng)),
            1 => rng.pick(&TEXTS).map(str::to_string),
            _ => None,
        };
        let mut ev = KeyEvent::new(key)
            .with_mods(Mods(rng.next() as u8))
            .with_kind(rng.pick(&KINDS));
        if let Some(t) = &text {
            ev = ev.with_text(t);
        }
        if rng.chance(30) {
            ev = ev.with_shifted_key(random_char(&mut rng));
        }
        if rng.chance(30) {
            ev = ev.with_base_layout_key(random_char(&mut rng));
        }
        check_key(&ev, random_modes(&mut rng));
    }
}

#[test]
fn a_buffer_is_only_ever_appended_to() {
    // Many events into one buffer, as the window layer does: the bytes are the
    // concatenation of each event alone.
    let keys = all_keys();
    let mut rng = Rng::new(seed(0xA2));
    let modes = random_modes(&mut rng);
    let mut together = Vec::new();
    let mut expect = Vec::new();
    for _ in 0..cases(20_000) {
        let ev = KeyEvent::new(rng.pick(&keys))
            .with_mods(Mods(rng.next() as u8))
            .with_kind(rng.pick(&KINDS));
        let mut one = Vec::new();
        encode_key(&ev, modes, &mut one);
        expect.extend_from_slice(&one);
        encode_key(&ev, modes, &mut together);
    }
    assert_eq!(together, expect);
}

// ---------------------------------------------------------------------------
// Mouse
// ---------------------------------------------------------------------------

const BUTTONS: [MouseButton; 11] = [
    MouseButton::Left,
    MouseButton::Middle,
    MouseButton::Right,
    MouseButton::WheelUp,
    MouseButton::WheelDown,
    MouseButton::WheelLeft,
    MouseButton::WheelRight,
    MouseButton::Back,
    MouseButton::Forward,
    MouseButton::Button10,
    MouseButton::Button11,
];

fn coord(rng: &mut Rng) -> u16 {
    match rng.below(6) {
        0 => rng.below(30) as u16,
        1 => 222 + rng.below(3) as u16,
        2 => 2013 + rng.below(5) as u16,
        3 => u16::MAX - rng.below(2) as u16,
        _ => rng.below(3000) as u16,
    }
}

fn random_mouse(rng: &mut Rng) -> MouseEvent {
    let button = rng.pick(&BUTTONS);
    let kind = match rng.below(4) {
        0 => MouseEventKind::Press(button),
        1 => MouseEventKind::Release(button),
        2 => MouseEventKind::Motion(Some(button)),
        _ => MouseEventKind::Motion(None),
    };
    MouseEvent {
        kind,
        col: coord(rng),
        row: coord(rng),
        mods: Mods(rng.next() as u8),
    }
}

fn check_mouse(ev: &MouseEvent, modes: Modes) {
    let what = format!("{ev:?} under {:?}/{:?}", modes.mouse, modes.mouse_encoding);
    let mut alone = Vec::new();
    let wrote = encode_mouse(ev, modes, &mut alone);
    let before = b"PRE\x1b[".to_vec();
    let mut after = before.clone();
    let wrote_again = encode_mouse(ev, modes, &mut after);
    assert_eq!(wrote, wrote_again, "{what}: not deterministic");
    check_append(&what, wrote, &before, &after, &alone);
    assert!(alone.len() <= 32, "{what}: {} bytes written", alone.len());

    if modes.mouse == MouseMode::Off {
        assert!(!wrote, "{what}: mouse off but wrote {}", esc(&alone));
    }
    if !wrote {
        return;
    }
    let (x, y) = (ev.col as u32 + 1, ev.row as u32 + 1);
    let released = matches!(ev.kind, MouseEventKind::Release(_));
    match modes.mouse_encoding {
        MouseEncoding::Sgr => {
            let text = std::str::from_utf8(&alone).unwrap_or_else(|_| panic!("{what}: not UTF-8"));
            let body = text
                .strip_prefix("\x1b[<")
                .unwrap_or_else(|| panic!("{what}: no SGR prefix: {}", esc(&alone)));
            let (nums, last) = body.split_at(body.len() - 1);
            assert_eq!(last, if released { "m" } else { "M" }, "{what}: final");
            let parts: Vec<u32> = nums
                .split(';')
                .map(|p| {
                    p.parse()
                        .unwrap_or_else(|_| panic!("{what}: bad number {p}"))
                })
                .collect();
            assert_eq!(parts.len(), 3, "{what}");
            assert_eq!((parts[1], parts[2]), (x, y), "{what}: position");
        }
        MouseEncoding::Default => {
            assert!(x <= LEGACY_COORD_LIMIT && y <= LEGACY_COORD_LIMIT, "{what}");
            assert_eq!(alone.len(), 6, "{what}: {}", esc(&alone));
            assert_eq!(&alone[..3], b"\x1b[M", "{what}");
            assert_eq!(
                (alone[4] as u32 - 32, alone[5] as u32 - 32),
                (x, y),
                "{what}: position"
            );
        }
        MouseEncoding::Utf8 => {
            assert!(x <= UTF8_COORD_LIMIT && y <= UTF8_COORD_LIMIT, "{what}");
            let text = std::str::from_utf8(&alone).unwrap_or_else(|_| panic!("{what}: not UTF-8"));
            let body = text
                .strip_prefix("\x1b[M")
                .unwrap_or_else(|| panic!("{what}: no prefix: {}", esc(&alone)));
            let chars: Vec<u32> = body.chars().map(|c| c as u32).collect();
            assert_eq!(chars.len(), 3, "{what}");
            assert_eq!((chars[1] - 32, chars[2] - 32), (x, y), "{what}: position");
        }
    }
}

#[test]
fn every_mouse_mode_encoding_and_edge_coordinate() {
    let mut rng = Rng::new(seed(0xB1));
    for mouse in [
        MouseMode::Off,
        MouseMode::Press,
        MouseMode::Normal,
        MouseMode::Drag,
        MouseMode::Any,
    ] {
        for mouse_encoding in [
            MouseEncoding::Default,
            MouseEncoding::Utf8,
            MouseEncoding::Sgr,
        ] {
            let modes = Modes {
                mouse,
                mouse_encoding,
                ..Modes::default()
            };
            for button in BUTTONS {
                for kind in [
                    MouseEventKind::Press(button),
                    MouseEventKind::Release(button),
                    MouseEventKind::Motion(Some(button)),
                    MouseEventKind::Motion(None),
                ] {
                    for coord in [0u16, 1, 221, 222, 223, 2013, 2014, 2015, 2016, u16::MAX] {
                        for mods in [0u8, 1, 2, 4, 8, 16, 32, 255] {
                            let ev = MouseEvent {
                                kind,
                                col: coord,
                                row: rng.below(2) as u16 * coord,
                                mods: Mods(mods),
                            };
                            check_mouse(&ev, modes);
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn random_mouse_events() {
    let mut rng = Rng::new(seed(0xB2));
    for _ in 0..cases(60_000) {
        let ev = random_mouse(&mut rng);
        check_mouse(&ev, random_modes(&mut rng));
    }
}

// ---------------------------------------------------------------------------
// Text, paste and focus
// ---------------------------------------------------------------------------

fn removed(c: char) -> bool {
    c.is_control() && !matches!(c, '\t' | '\n' | '\r')
}

fn check_paste(text: &str, modes: Modes, strip: bool) {
    let what = format!(
        "paste {:?} bracketed {} strip {strip}",
        if text.len() > 80 { &text[..0] } else { text },
        modes.bracketed_paste
    );
    let mut alone = Vec::new();
    let res = encode_paste_with(text, modes, strip, &mut alone);
    let before = b"PRE\x1b[".to_vec();
    let mut after = before.clone();
    let res2 = encode_paste_with(text, modes, strip, &mut after);
    assert_eq!(res, res2, "{what}: not deterministic");
    check_append(&what, res.written, &before, &after, &alone);

    let kept: String = if strip {
        text.chars().filter(|&c| !removed(c)).collect()
    } else {
        text.to_string()
    };
    assert_eq!(
        res.removed_controls,
        strip && kept.len() != text.len(),
        "{what}: removed_controls"
    );

    let inner = if modes.bracketed_paste {
        assert!(alone.starts_with(PASTE_START), "{what}: start marker");
        assert!(alone.ends_with(PASTE_END), "{what}: end marker");
        let inner = &alone[PASTE_START.len()..alone.len() - PASTE_END.len()];
        assert_eq!(inner, kept.as_bytes(), "{what}: bracketed text");
        inner
    } else {
        let want = kept.replace("\r\n", "\r").replace('\n', "\r");
        assert_eq!(alone, want.as_bytes(), "{what}: plain text");
        &alone[..]
    };
    if strip {
        // Nothing pasted can close the bracket or type a key sequence.
        let inner = std::str::from_utf8(inner).unwrap_or_else(|_| panic!("{what}: not UTF-8"));
        assert!(
            !inner.chars().any(removed),
            "{what}: a control character survived: {}",
            esc(inner.as_bytes())
        );
        assert!(!inner.contains('\x1b'), "{what}: ESC survived");
    }
}

#[test]
fn random_paste_text_and_focus() {
    let mut rng = Rng::new(seed(0xC1));
    for _ in 0..cases(20_000) {
        let mut text = random_text(&mut rng);
        if rng.chance(10) {
            // Markers and the pieces that splice into one.
            for piece in [
                "\x1b[201~",
                "\x1b[20",
                "1~",
                "\x1b",
                "\r\n",
                "\r\x01\n",
                "\u{9b}201~",
            ] {
                if rng.chance(50) {
                    text.push_str(piece);
                }
            }
        }
        if rng.chance(2) {
            text = text.repeat(200);
        }
        let modes = random_modes(&mut rng);
        check_paste(&text, modes, true);
        check_paste(&text, modes, false);

        // Plain text goes out as it is, in every mode.
        let mut out = Vec::new();
        assert_eq!(encode_text(&text, modes, &mut out), !text.is_empty());
        assert_eq!(out, text.as_bytes());

        // Focus: a fixed report, only when the program asked for it.
        for focused in [true, false] {
            let mut out = b"PRE".to_vec();
            let wrote = encode_focus(focused, modes, &mut out);
            assert_eq!(wrote, modes.focus_events);
            let want: &[u8] = match (wrote, focused) {
                (false, _) => b"PRE",
                (true, true) => b"PRE\x1b[I",
                (true, false) => b"PRE\x1b[O",
            };
            assert_eq!(out, want);
        }
    }
}

#[test]
fn paste_corpus() {
    let texts = [
        "",
        "\x1b[201~",
        "\x1b[2\x1b[201~01~",
        "\x1b\x1b[201~[201~",
        "a\x03b",
        "\r\n\r\n",
        "\r\x01\n",
        "\n\r",
        "\u{9b}201~\u{85}\u{9d}",
        "\x7f\x00\x08",
        "tab\tnewline\ncr\r",
        "日本語\u{301}😀",
    ];
    for text in texts {
        for bracketed_paste in [false, true] {
            let modes = Modes {
                bracketed_paste,
                ..Modes::default()
            };
            check_paste(text, modes, true);
            check_paste(text, modes, false);
            let mut out = Vec::new();
            let res = encode_paste(text, modes, &mut out);
            assert_eq!(res.written, bracketed_paste || !out.is_empty());
        }
    }
}
