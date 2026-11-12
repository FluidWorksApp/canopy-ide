//! Legacy (no kitty flags) key encoding, table-driven against the kitty spec's
//! "Legacy key event encoding" tables and xterm ctlseqs "PC-Style Function
//! Keys" / "VT220-Style Function Keys".

mod common;

use canopy_term_input::*;
use common::*;

fn legacy() -> Modes {
    Modes::default()
}

fn app_cursor() -> Modes {
    Modes {
        app_cursor_keys: true,
        ..Modes::default()
    }
}

fn app_keypad() -> Modes {
    Modes {
        app_keypad: true,
        ..Modes::default()
    }
}

#[test]
fn c0_keys_match_the_kitty_legacy_table() {
    // Columns: no mods, ctrl, alt, shift, ctrl+shift, alt+shift, ctrl+alt.
    let mods = [
        Mods::NONE,
        CTRL,
        ALT,
        SHIFT,
        CTRL | SHIFT,
        ALT | SHIFT,
        CTRL | ALT,
    ];
    let rows: [(Key, [&[u8]; 7]); 4] = [
        (
            Key::Enter,
            [b"\r", b"\r", b"\x1b\r", b"\r", b"\r", b"\x1b\r", b"\x1b\r"],
        ),
        (
            Key::Escape,
            [
                b"\x1b",
                b"\x1b",
                b"\x1b\x1b",
                b"\x1b",
                b"\x1b",
                b"\x1b\x1b",
                b"\x1b\x1b",
            ],
        ),
        (
            Key::Backspace,
            [
                b"\x7f",
                b"\x08",
                b"\x1b\x7f",
                b"\x7f",
                b"\x08",
                b"\x1b\x7f",
                b"\x1b\x08",
            ],
        ),
        (
            Key::Tab,
            [
                b"\t",
                b"\t",
                b"\x1b\t",
                b"\x1b[Z",
                b"\x1b[Z",
                b"\x1b\x1b[Z",
                b"\x1b\t",
            ],
        ),
    ];
    for (key, wants) in rows {
        for (m, want) in mods.iter().zip(wants) {
            let got = common::key(k(key).with_mods(*m), legacy());
            assert_eq!(show(&got), show(want), "{key:?} with {m:?}");
        }
    }
    // Space is a Char key.
    let space: [&[u8]; 7] = [
        b" ",
        b"\x00",
        b"\x1b ",
        b" ",
        b"\x00",
        b"\x1b ",
        b"\x1b\x00",
    ];
    for (m, want) in mods.iter().zip(space) {
        let got = common::key(c(' ').with_mods(*m), legacy());
        assert_eq!(show(&got), show(want), "space with {m:?}");
    }
}

#[test]
fn text_keys_match_the_kitty_example_table() {
    // "Example encodings": plain, shift, alt, ctrl, shift+alt, alt+ctrl.
    check_keys(
        legacy(),
        &[
            (c('i').with_text("i"), &b"i"[..]),
            (c('i').with_mods(SHIFT).with_text("I"), &b"I"[..]),
            (c('i').with_mods(ALT), &b"\x1bi"[..]),
            (c('i').with_mods(CTRL), &b"\t"[..]),
            (c('i').with_mods(SHIFT | ALT).with_text("I"), &b"\x1bI"[..]),
            (c('i').with_mods(ALT | CTRL), &b"\x1b\t"[..]),
            (c('3').with_text("3"), &b"3"[..]),
            (c('3').with_mods(SHIFT).with_text("#"), &b"#"[..]),
            (c('3').with_mods(ALT), &b"\x1b3"[..]),
            (c('3').with_mods(CTRL), &b"\x1b"[..]),
            (
                c('3').with_mods(SHIFT | ALT).with_shifted_key('#'),
                &b"\x1b#"[..],
            ),
            (c('3').with_mods(ALT | CTRL), &b"\x1b\x1b"[..]),
            (c(';').with_text(";"), &b";"[..]),
            (c(';').with_mods(SHIFT).with_shifted_key(':'), &b":"[..]),
            (c(';').with_mods(ALT), &b"\x1b;"[..]),
            (c(';').with_mods(CTRL), &b";"[..]),
            (c(';').with_mods(SHIFT | ALT).with_text(":"), &b"\x1b:"[..]),
            (c(';').with_mods(ALT | CTRL), &b"\x1b;"[..]),
        ],
    );
}

#[test]
fn legacy_text_key_choices() {
    check_keys(
        legacy(),
        &[
            // No text given: the key itself, uppercased for ASCII with Shift.
            (c('a'), &b"a"[..]),
            (c('a').with_mods(SHIFT), &b"A"[..]),
            // An uppercase Char is its lowercase key.
            (c('A').with_mods(CTRL), &b"\x01"[..]),
            // Ctrl+Shift+letter folds to Ctrl+letter, as xterm without
            // modifyOtherKeys. (Kitty itself would send CSI 105;6u.)
            (c('i').with_mods(CTRL | SHIFT), &b"\t"[..]),
            (
                c('a').with_mods(CTRL | SHIFT).with_shifted_key('A'),
                &b"\x01"[..],
            ),
            // Ctrl+Shift on a non-letter uses the shifted key: Ctrl+@ and Ctrl+_.
            (
                c('2').with_mods(CTRL | SHIFT).with_shifted_key('@'),
                &b"\x00"[..],
            ),
            (
                c('-').with_mods(CTRL | SHIFT).with_shifted_key('_'),
                &b"\x1f"[..],
            ),
            (c('/').with_mods(CTRL), &b"\x1f"[..]),
            (c('[').with_mods(CTRL), &b"\x1b"[..]),
            (c('8').with_mods(CTRL), &b"\x7f"[..]),
            // Non-ASCII text passes through as UTF-8; Ctrl leaves it untouched.
            (c('é').with_text("é"), "é".as_bytes()),
            (c('é').with_mods(CTRL), "é".as_bytes()),
            (c('е').with_mods(ALT).with_text("е"), "\x1bе".as_bytes()),
            // Ctrl on a non-ASCII layout uses the base layout key.
            (
                c('\u{441}').with_mods(CTRL).with_base_layout_key('c'),
                &b"\x03"[..],
            ),
            (
                c('\u{441}').with_mods(CTRL | ALT).with_base_layout_key('c'),
                &b"\x1b\x03"[..],
            ),
            (
                c('\u{445}')
                    .with_mods(CTRL | SHIFT)
                    .with_shifted_key('\u{425}')
                    .with_base_layout_key('['),
                &b"\x1b"[..],
            ),
            // Without a base key, or for plain text, nothing changes.
            (c('\u{441}').with_mods(CTRL), "\u{441}".as_bytes()),
            (
                c('\u{441}').with_text("\u{441}").with_base_layout_key('c'),
                "\u{441}".as_bytes(),
            ),
            // Locks are not encoded in legacy.
            (c('a').with_mods(CAPS).with_text("A"), &b"A"[..]),
            (c('a').with_mods(CTRL | NUM | CAPS), &b"\x01"[..]),
            // Super, Hyper and Meta have no legacy form on text keys.
            (c('c').with_mods(SUPER), &b""[..]),
            (c('c').with_mods(HYPER | CTRL), &b""[..]),
            (c('c').with_mods(META), &b""[..]),
            // Control characters in text are ignored, the key is used.
            (c('a').with_text("\x1b[A"), &b"a"[..]),
            // Repeat is a press; release sends nothing.
            (c('x').with_kind(KeyEventKind::Repeat), &b"x"[..]),
            (c('x').with_kind(KeyEventKind::Release), &b""[..]),
            (k(Key::Up).with_kind(KeyEventKind::Release), &b""[..]),
        ],
    );
}

#[test]
fn cursor_keys_follow_decckm() {
    let keys = [
        (Key::Up, b'A'),
        (Key::Down, b'B'),
        (Key::Right, b'C'),
        (Key::Left, b'D'),
        (Key::Home, b'H'),
        (Key::End, b'F'),
    ];
    for (key, letter) in keys {
        let normal = [0x1b, b'[', letter];
        let app = [0x1b, b'O', letter];
        assert_eq!(common::key(k(key), legacy()), normal, "{key:?} normal");
        assert_eq!(common::key(k(key), app_cursor()), app, "{key:?} DECCKM");
        // With modifiers DECCKM does not apply: CSI 1;<mod> X.
        for modes in [legacy(), app_cursor()] {
            let want = [0x1b, b'[', b'1', b';', b'5', letter];
            assert_eq!(common::key(k(key).with_mods(CTRL), modes), want);
        }
    }
}

#[test]
fn modifier_parameter_values() {
    // xterm "PC-Style Function Keys" codes 2-16, plus kitty's Hyper/Meta bits.
    let cases: &[(Mods, &[u8])] = &[
        (SHIFT, b"\x1b[1;2A"),
        (ALT, b"\x1b[1;3A"),
        (SHIFT | ALT, b"\x1b[1;4A"),
        (CTRL, b"\x1b[1;5A"),
        (SHIFT | CTRL, b"\x1b[1;6A"),
        (ALT | CTRL, b"\x1b[1;7A"),
        (SHIFT | ALT | CTRL, b"\x1b[1;8A"),
        (SUPER, b"\x1b[1;9A"),
        (SUPER | SHIFT | ALT | CTRL, b"\x1b[1;16A"),
        (HYPER | CTRL, b"\x1b[1;21A"),
        (META, b"\x1b[1;33A"),
        // Locks are dropped.
        (CAPS | NUM, b"\x1b[A"),
        (CAPS | SHIFT, b"\x1b[1;2A"),
    ];
    for &(m, want) in cases {
        assert_eq!(
            show(&common::key(k(Key::Up).with_mods(m), legacy())),
            show(want),
            "{m:?}"
        );
    }
}

#[test]
fn editing_and_function_keys() {
    check_keys(
        legacy(),
        &[
            (k(Key::Insert), &b"\x1b[2~"[..]),
            (k(Key::Delete), &b"\x1b[3~"[..]),
            (k(Key::PageUp), &b"\x1b[5~"[..]),
            (k(Key::PageDown), &b"\x1b[6~"[..]),
            (k(Key::Insert).with_mods(SHIFT), &b"\x1b[2;2~"[..]),
            (k(Key::Delete).with_mods(CTRL), &b"\x1b[3;5~"[..]),
            (k(Key::PageDown).with_mods(ALT | CTRL), &b"\x1b[6;7~"[..]),
            (k(Key::F(1)), &b"\x1bOP"[..]),
            (k(Key::F(2)), &b"\x1bOQ"[..]),
            (k(Key::F(3)), &b"\x1bOR"[..]),
            (k(Key::F(4)), &b"\x1bOS"[..]),
            (k(Key::F(5)), &b"\x1b[15~"[..]),
            (k(Key::F(6)), &b"\x1b[17~"[..]),
            (k(Key::F(7)), &b"\x1b[18~"[..]),
            (k(Key::F(8)), &b"\x1b[19~"[..]),
            (k(Key::F(9)), &b"\x1b[20~"[..]),
            (k(Key::F(10)), &b"\x1b[21~"[..]),
            (k(Key::F(11)), &b"\x1b[23~"[..]),
            (k(Key::F(12)), &b"\x1b[24~"[..]),
            // SS3 becomes CSI 1;<mod> with modifiers.
            (k(Key::F(1)).with_mods(SHIFT), &b"\x1b[1;2P"[..]),
            (k(Key::F(3)).with_mods(CTRL), &b"\x1b[1;5R"[..]),
            (k(Key::F(4)).with_mods(ALT), &b"\x1b[1;3S"[..]),
            // ctlseqs example: shift-F5 is CSI 15;2~.
            (k(Key::F(5)).with_mods(SHIFT), &b"\x1b[15;2~"[..]),
            (k(Key::F(12)).with_mods(CTRL | SHIFT), &b"\x1b[24;6~"[..]),
            // F13-F24 are xterm terminfo kf13-kf24: F1-F12 plus Shift.
            (k(Key::F(13)), &b"\x1b[1;2P"[..]),
            (k(Key::F(14)), &b"\x1b[1;2Q"[..]),
            (k(Key::F(15)), &b"\x1b[1;2R"[..]),
            (k(Key::F(16)), &b"\x1b[1;2S"[..]),
            (k(Key::F(17)), &b"\x1b[15;2~"[..]),
            (k(Key::F(24)), &b"\x1b[24;2~"[..]),
            (k(Key::F(13)).with_mods(CTRL), &b"\x1b[1;6P"[..]),
            // Beyond what legacy can say.
            (k(Key::F(0)), &b""[..]),
            (k(Key::F(25)), &b""[..]),
            (k(Key::F(35)), &b""[..]),
            // Menu uses xterm's F16 code, as the kitty legacy table lists.
            (k(Key::Menu), &b"\x1b[29~"[..]),
            (k(Key::CapsLock), &b""[..]),
            (k(Key::ScrollLock), &b""[..]),
            (k(Key::NumLock), &b""[..]),
            (k(Key::PrintScreen), &b""[..]),
            (k(Key::Pause), &b""[..]),
            (k(Key::Media(Media::PlayPause)), &b""[..]),
            (
                k(Key::Modifier(ModifierKey::LeftShift)).with_mods(SHIFT),
                &b""[..],
            ),
        ],
    );
    // F1-F4 are SS3 regardless of DECCKM.
    assert_eq!(common::key(k(Key::F(1)), app_cursor()), b"\x1bOP");
}

#[test]
fn keypad_numeric_mode() {
    check_keys(
        legacy(),
        &[
            (k(Key::Keypad(Keypad::Num1)).with_text("1"), &b"1"[..]),
            (k(Key::Keypad(Keypad::Num0)), &b"0"[..]),
            (k(Key::Keypad(Keypad::Num9)), &b"9"[..]),
            (k(Key::Keypad(Keypad::Decimal)), &b"."[..]),
            (k(Key::Keypad(Keypad::Divide)), &b"/"[..]),
            (k(Key::Keypad(Keypad::Multiply)), &b"*"[..]),
            (k(Key::Keypad(Keypad::Subtract)), &b"-"[..]),
            (k(Key::Keypad(Keypad::Add)), &b"+"[..]),
            (k(Key::Keypad(Keypad::Equal)), &b"="[..]),
            (k(Key::Keypad(Keypad::Separator)), &b","[..]),
            (k(Key::Keypad(Keypad::Enter)), &b"\r"[..]),
            (k(Key::Keypad(Keypad::Enter)).with_mods(ALT), &b"\x1b\r"[..]),
            // Num Lock off: navigation keys, same as the main ones.
            (k(Key::Keypad(Keypad::Up)), &b"\x1b[A"[..]),
            (k(Key::Keypad(Keypad::Home)), &b"\x1b[H"[..]),
            (k(Key::Keypad(Keypad::End)), &b"\x1b[F"[..]),
            (k(Key::Keypad(Keypad::PageUp)), &b"\x1b[5~"[..]),
            (k(Key::Keypad(Keypad::PageDown)), &b"\x1b[6~"[..]),
            (k(Key::Keypad(Keypad::Insert)), &b"\x1b[2~"[..]),
            (k(Key::Keypad(Keypad::Delete)), &b"\x1b[3~"[..]),
            (k(Key::Keypad(Keypad::Left)), &b"\x1b[D"[..]),
            (k(Key::Keypad(Keypad::Right)), &b"\x1b[C"[..]),
            (k(Key::Keypad(Keypad::Down)), &b"\x1b[B"[..]),
            (k(Key::Keypad(Keypad::Begin)), &b"\x1b[E"[..]),
            (
                k(Key::Keypad(Keypad::Begin)).with_mods(CTRL),
                &b"\x1b[1;5E"[..],
            ),
            (
                k(Key::Keypad(Keypad::Home)).with_mods(SHIFT),
                &b"\x1b[1;2H"[..],
            ),
        ],
    );
    check_keys(
        app_cursor(),
        &[
            (k(Key::Keypad(Keypad::Up)), &b"\x1bOA"[..]),
            (k(Key::Keypad(Keypad::Begin)), &b"\x1bOE"[..]),
            (k(Key::Keypad(Keypad::Num5)), &b"5"[..]),
        ],
    );
}

#[test]
fn keypad_application_mode_matches_the_vt220_table() {
    check_keys(
        app_keypad(),
        &[
            (k(Key::Keypad(Keypad::Num0)).with_text("0"), &b"\x1bOp"[..]),
            (k(Key::Keypad(Keypad::Num1)), &b"\x1bOq"[..]),
            (k(Key::Keypad(Keypad::Num2)), &b"\x1bOr"[..]),
            (k(Key::Keypad(Keypad::Num3)), &b"\x1bOs"[..]),
            (k(Key::Keypad(Keypad::Num4)), &b"\x1bOt"[..]),
            (k(Key::Keypad(Keypad::Num5)), &b"\x1bOu"[..]),
            (k(Key::Keypad(Keypad::Num6)), &b"\x1bOv"[..]),
            (k(Key::Keypad(Keypad::Num7)), &b"\x1bOw"[..]),
            (k(Key::Keypad(Keypad::Num8)), &b"\x1bOx"[..]),
            (k(Key::Keypad(Keypad::Num9)), &b"\x1bOy"[..]),
            (k(Key::Keypad(Keypad::Decimal)), &b"\x1bOn"[..]),
            (k(Key::Keypad(Keypad::Divide)), &b"\x1bOo"[..]),
            (k(Key::Keypad(Keypad::Multiply)), &b"\x1bOj"[..]),
            (k(Key::Keypad(Keypad::Subtract)), &b"\x1bOm"[..]),
            (k(Key::Keypad(Keypad::Add)), &b"\x1bOk"[..]),
            (k(Key::Keypad(Keypad::Separator)), &b"\x1bOl"[..]),
            (k(Key::Keypad(Keypad::Equal)), &b"\x1bOX"[..]),
            (k(Key::Keypad(Keypad::Enter)), &b"\x1bOM"[..]),
            // Locks do not count as modifiers.
            (k(Key::Keypad(Keypad::Num1)).with_mods(NUM), &b"\x1bOq"[..]),
            // A modified keypad key falls back to numeric mode.
            (k(Key::Keypad(Keypad::Num1)).with_mods(ALT), &b"\x1b1"[..]),
            (k(Key::Keypad(Keypad::Enter)).with_mods(ALT), &b"\x1b\r"[..]),
            // Navigation keys are cursor keys, not affected by DECKPAM.
            (k(Key::Keypad(Keypad::Up)), &b"\x1b[A"[..]),
            (k(Key::Keypad(Keypad::Insert)), &b"\x1b[2~"[..]),
            // Main-keyboard digits are unaffected.
            (c('1').with_text("1"), &b"1"[..]),
            (k(Key::Enter), &b"\r"[..]),
        ],
    );
}

#[test]
fn encode_key_appends_and_never_clears() {
    let mut out = b"prefix".to_vec();
    assert!(encode_key(&k(Key::Up), Modes::default(), &mut out));
    assert_eq!(out, b"prefix\x1b[A");
    assert!(!encode_key(
        &k(Key::Up).with_kind(KeyEventKind::Release),
        Modes::default(),
        &mut out
    ));
    assert_eq!(out, b"prefix\x1b[A");
}
