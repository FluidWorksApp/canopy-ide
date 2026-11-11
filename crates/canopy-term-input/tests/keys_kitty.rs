//! Kitty keyboard protocol, table-driven against
//! <https://sw.kovidgoyal.net/kitty/keyboard-protocol/>.

mod common;

use canopy_term_input::kitty_flags::*;
use canopy_term_input::*;
use common::*;

const RELEASE: KeyEventKind = KeyEventKind::Release;
const REPEAT: KeyEventKind = KeyEventKind::Repeat;

#[test]
fn functional_key_table_every_entry() {
    // "Functional key definitions", every row, with no modifiers. Report-all
    // is on so that modifier and lock keys are reported too; `CSI 1 X` drops
    // the 1 when it has nothing after it.
    let table: &[(Key, &[u8])] = &[
        (Key::Escape, b"\x1b[27u"),
        (Key::Enter, b"\x1b[13u"),
        (Key::Tab, b"\x1b[9u"),
        (Key::Backspace, b"\x1b[127u"),
        (Key::Insert, b"\x1b[2~"),
        (Key::Delete, b"\x1b[3~"),
        (Key::Left, b"\x1b[D"),
        (Key::Right, b"\x1b[C"),
        (Key::Up, b"\x1b[A"),
        (Key::Down, b"\x1b[B"),
        (Key::PageUp, b"\x1b[5~"),
        (Key::PageDown, b"\x1b[6~"),
        (Key::Home, b"\x1b[H"),
        (Key::End, b"\x1b[F"),
        (Key::CapsLock, b"\x1b[57358u"),
        (Key::ScrollLock, b"\x1b[57359u"),
        (Key::NumLock, b"\x1b[57360u"),
        (Key::PrintScreen, b"\x1b[57361u"),
        (Key::Pause, b"\x1b[57362u"),
        (Key::Menu, b"\x1b[57363u"),
        (Key::F(1), b"\x1b[P"),
        (Key::F(2), b"\x1b[Q"),
        (Key::F(3), b"\x1b[13~"),
        (Key::F(4), b"\x1b[S"),
        (Key::F(5), b"\x1b[15~"),
        (Key::F(6), b"\x1b[17~"),
        (Key::F(7), b"\x1b[18~"),
        (Key::F(8), b"\x1b[19~"),
        (Key::F(9), b"\x1b[20~"),
        (Key::F(10), b"\x1b[21~"),
        (Key::F(11), b"\x1b[23~"),
        (Key::F(12), b"\x1b[24~"),
        (Key::Keypad(Keypad::Begin), b"\x1b[E"),
        (Key::Media(Media::Play), b"\x1b[57428u"),
        (Key::Media(Media::Pause), b"\x1b[57429u"),
        (Key::Media(Media::PlayPause), b"\x1b[57430u"),
        (Key::Media(Media::Reverse), b"\x1b[57431u"),
        (Key::Media(Media::Stop), b"\x1b[57432u"),
        (Key::Media(Media::FastForward), b"\x1b[57433u"),
        (Key::Media(Media::Rewind), b"\x1b[57434u"),
        (Key::Media(Media::TrackNext), b"\x1b[57435u"),
        (Key::Media(Media::TrackPrevious), b"\x1b[57436u"),
        (Key::Media(Media::Record), b"\x1b[57437u"),
        (Key::Media(Media::LowerVolume), b"\x1b[57438u"),
        (Key::Media(Media::RaiseVolume), b"\x1b[57439u"),
        (Key::Media(Media::MuteVolume), b"\x1b[57440u"),
        (Key::Modifier(ModifierKey::LeftShift), b"\x1b[57441u"),
        (Key::Modifier(ModifierKey::LeftControl), b"\x1b[57442u"),
        (Key::Modifier(ModifierKey::LeftAlt), b"\x1b[57443u"),
        (Key::Modifier(ModifierKey::LeftSuper), b"\x1b[57444u"),
        (Key::Modifier(ModifierKey::LeftHyper), b"\x1b[57445u"),
        (Key::Modifier(ModifierKey::LeftMeta), b"\x1b[57446u"),
        (Key::Modifier(ModifierKey::RightShift), b"\x1b[57447u"),
        (Key::Modifier(ModifierKey::RightControl), b"\x1b[57448u"),
        (Key::Modifier(ModifierKey::RightAlt), b"\x1b[57449u"),
        (Key::Modifier(ModifierKey::RightSuper), b"\x1b[57450u"),
        (Key::Modifier(ModifierKey::RightHyper), b"\x1b[57451u"),
        (Key::Modifier(ModifierKey::RightMeta), b"\x1b[57452u"),
        (Key::Modifier(ModifierKey::IsoLevel3Shift), b"\x1b[57453u"),
        (Key::Modifier(ModifierKey::IsoLevel5Shift), b"\x1b[57454u"),
    ];
    let modes = kitty(DISAMBIGUATE | REPORT_ALL_KEYS);
    for &(key, want) in table {
        assert_eq!(show(&common::key(k(key), modes)), show(want), "{key:?}");
    }
    // F13-F35: 57376-57398.
    for n in 13u8..=35 {
        let want = format!("\x1b[{}u", 57376 + (n as u32 - 13));
        assert_eq!(
            show(&common::key(k(Key::F(n)), modes)),
            show(want.as_bytes()),
            "F{n}"
        );
    }
    assert!(common::key(k(Key::F(36)), modes).is_empty());
    assert!(common::key(k(Key::F(0)), modes).is_empty());
    // KP_0 .. KP_DELETE: 57399-57426, in table order.
    let keypad = [
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
    ];
    for (i, kp) in keypad.into_iter().enumerate() {
        let want = format!("\x1b[{}u", 57399 + i as u32);
        // No text given, so even digits are reported as keys.
        assert_eq!(
            show(&common::key(k(Key::Keypad(kp)), kitty(DISAMBIGUATE))),
            show(want.as_bytes()),
            "{kp:?}"
        );
    }
}

#[test]
fn disambiguate() {
    check_keys(
        kitty(DISAMBIGUATE),
        &[
            // Text keys stay text, Shift included.
            (c('a').with_text("a"), &b"a"[..]),
            (c('a').with_mods(SHIFT).with_text("A"), &b"A"[..]),
            (c('a').with_mods(SHIFT), &b"A"[..]),
            (c('a').with_mods(CAPS).with_text("A"), &b"A"[..]),
            (c('é').with_text("é"), "é".as_bytes()),
            // Ctrl/Alt/Super combos become CSI u with the unshifted key.
            (c('a').with_mods(CTRL), &b"\x1b[97;5u"[..]),
            (c('a').with_mods(ALT).with_text("a"), &b"\x1b[97;3u"[..]),
            (c('a').with_mods(CTRL | ALT), &b"\x1b[97;7u"[..]),
            (
                c('a').with_mods(CTRL | SHIFT).with_shifted_key('A'),
                &b"\x1b[97;6u"[..],
            ),
            (c('A').with_mods(CTRL | SHIFT), &b"\x1b[97;6u"[..]),
            (c('a').with_mods(SUPER), &b"\x1b[97;9u"[..]),
            (c('i').with_mods(CTRL), &b"\x1b[105;5u"[..]),
            (c(' ').with_mods(CTRL), &b"\x1b[32;5u"[..]),
            (c('[').with_mods(ALT), &b"\x1b[91;3u"[..]),
            // Spec "Disambiguate escape codes": "Note that the Lock modifiers
            // are not reported for text producing keys, to keep them usable in
            // legacy programs. To get lock modifiers for all keys use the
            // report_all_keys enhancement." (rst 372-374)
            (c('a').with_mods(CTRL | CAPS), &b"\x1b[97;5u"[..]),
            (c('a').with_mods(CTRL | NUM), &b"\x1b[97;5u"[..]),
            (c('a').with_mods(SUPER | CAPS | NUM), &b"\x1b[97;9u"[..]),
            // Functional keys do report them.
            (k(Key::Up).with_mods(CAPS), &b"\x1b[1;65A"[..]),
            (k(Key::F(5)).with_mods(NUM | CTRL), &b"\x1b[15;133~"[..]),
            // Esc is disambiguated.
            (k(Key::Escape), &b"\x1b[27u"[..]),
            (k(Key::Escape).with_mods(SHIFT), &b"\x1b[27;2u"[..]),
            // Enter, Tab, Backspace keep legacy bytes unmodified...
            (k(Key::Enter), &b"\r"[..]),
            (k(Key::Tab), &b"\t"[..]),
            (k(Key::Backspace), &b"\x7f"[..]),
            (k(Key::Enter).with_mods(CAPS | NUM), &b"\r"[..]),
            // ...and become CSI u with modifiers.
            (k(Key::Enter).with_mods(CTRL), &b"\x1b[13;5u"[..]),
            (k(Key::Enter).with_mods(ALT), &b"\x1b[13;3u"[..]),
            (k(Key::Tab).with_mods(SHIFT), &b"\x1b[9;2u"[..]),
            (k(Key::Tab).with_mods(CTRL | SHIFT), &b"\x1b[9;6u"[..]),
            (k(Key::Backspace).with_mods(CTRL), &b"\x1b[127;5u"[..]),
            // Functional keys with modifiers.
            (k(Key::Up).with_mods(SHIFT), &b"\x1b[1;2A"[..]),
            (k(Key::Home).with_mods(CTRL), &b"\x1b[1;5H"[..]),
            (k(Key::F(1)).with_mods(CTRL), &b"\x1b[1;5P"[..]),
            (k(Key::F(3)).with_mods(SHIFT), &b"\x1b[13;2~"[..]),
            (k(Key::PageUp).with_mods(ALT), &b"\x1b[5;3~"[..]),
            (k(Key::F(13)).with_mods(CTRL), &b"\x1b[57376;5u"[..]),
            (k(Key::Up).with_mods(NUM), &b"\x1b[1;129A"[..]),
            // Keypad: text when it types, its own number otherwise.
            (k(Key::Keypad(Keypad::Num1)).with_text("1"), &b"1"[..]),
            (
                k(Key::Keypad(Keypad::Num1)).with_mods(CTRL),
                &b"\x1b[57400;5u"[..],
            ),
            (k(Key::Keypad(Keypad::Enter)), &b"\x1b[57414u"[..]),
            (k(Key::Keypad(Keypad::Home)), &b"\x1b[57423u"[..]),
            (
                k(Key::Keypad(Keypad::Begin)).with_mods(CTRL),
                &b"\x1b[1;5E"[..],
            ),
            // Not reported without the other flags.
            (c('a').with_text("a").with_kind(RELEASE), &b""[..]),
            (k(Key::Up).with_kind(RELEASE), &b""[..]),
            (
                k(Key::Modifier(ModifierKey::LeftShift)).with_mods(SHIFT),
                &b""[..],
            ),
            (k(Key::CapsLock).with_mods(CAPS), &b""[..]),
            // Repeat is a press.
            (c('a').with_mods(CTRL).with_kind(REPEAT), &b"\x1b[97;5u"[..]),
            (k(Key::Up).with_kind(REPEAT), &b"\x1b[A"[..]),
        ],
    );
}

/// The SS3 forms are in the spec's "Legacy key event encoding" section
/// ("This form is used only in *cursor key mode* and only when no modifiers
/// are present", rst 494-496). Under disambiguate the spec instead says: "With
/// this flag turned on, all key events that do not generate text are
/// represented in one of the following two forms: `CSI number; modifier u` /
/// `CSI 1; modifier [~ABCDEFHPQS]`" (rst 359-363), and "all non text keypad
/// keys will be reported as separate keys with CSI u encoding" (rst 356-357).
/// So DECCKM and DECKPAM do not apply once disambiguate (or report-all) is on.
#[test]
fn disambiguate_ignores_decckm_and_deckpam() {
    let modes = Modes {
        app_cursor_keys: true,
        app_keypad: true,
        kitty_keyboard: DISAMBIGUATE,
        ..Modes::default()
    };
    check_keys(
        modes,
        &[
            (k(Key::Up), &b"\x1b[A"[..]),
            (k(Key::Home), &b"\x1b[H"[..]),
            (k(Key::F(1)), &b"\x1b[P"[..]),
            (k(Key::Keypad(Keypad::Num1)).with_text("1"), &b"1"[..]),
            (k(Key::Keypad(Keypad::Num1)), &b"\x1b[57400u"[..]),
        ],
    );
}

#[test]
fn report_event_types() {
    check_keys(
        kitty(DISAMBIGUATE | REPORT_EVENT_TYPES),
        &[
            (c('a').with_mods(CTRL), &b"\x1b[97;5u"[..]),
            (
                c('a').with_mods(CTRL).with_kind(REPEAT),
                &b"\x1b[97;5:2u"[..],
            ),
            (
                c('a').with_mods(CTRL).with_kind(RELEASE),
                &b"\x1b[97;5:3u"[..],
            ),
            // No modifiers: the field is 1 so the event type can follow.
            (k(Key::Up).with_kind(RELEASE), &b"\x1b[1;1:3A"[..]),
            (k(Key::Up).with_kind(REPEAT), &b"\x1b[1;1:2A"[..]),
            (k(Key::F(5)).with_kind(RELEASE), &b"\x1b[15;1:3~"[..]),
            (k(Key::Escape).with_kind(RELEASE), &b"\x1b[27;1:3u"[..]),
            (
                k(Key::Up).with_mods(SHIFT).with_kind(RELEASE),
                &b"\x1b[1;2:3A"[..],
            ),
            // Text keys: text on press and repeat, no release (spec note).
            (c('a').with_text("a"), &b"a"[..]),
            (c('a').with_text("a").with_kind(REPEAT), &b"a"[..]),
            (c('a').with_text("a").with_kind(RELEASE), &b""[..]),
            (
                c('a').with_mods(SHIFT).with_text("A").with_kind(RELEASE),
                &b""[..],
            ),
            // Enter, Tab and Backspace: no release events without report-all.
            (k(Key::Enter).with_kind(RELEASE), &b""[..]),
            (k(Key::Tab).with_kind(RELEASE), &b""[..]),
            (k(Key::Backspace).with_kind(RELEASE), &b""[..]),
            (k(Key::Enter).with_mods(CTRL).with_kind(RELEASE), &b""[..]),
            (k(Key::Enter).with_kind(REPEAT), &b"\r"[..]),
            // Modifier keys still need report-all.
            (
                k(Key::Modifier(ModifierKey::LeftControl)).with_mods(CTRL),
                &b""[..],
            ),
        ],
    );
}

#[test]
fn report_event_types_without_disambiguate() {
    // Presses are exactly the legacy bytes, DECCKM and DECKPAM included (spec
    // "Report event types" only adds repeat and release; rst 494-496 for the
    // SS3 forms). Repeats and releases are kitty escapes.
    let modes = Modes {
        app_cursor_keys: true,
        app_keypad: true,
        kitty_keyboard: REPORT_EVENT_TYPES,
        ..Modes::default()
    };
    check_keys(
        modes,
        &[
            (c('a').with_mods(CTRL), &b"\x01"[..]),
            (c('a').with_mods(ALT), &b"\x1ba"[..]),
            (
                c('a').with_mods(CTRL).with_kind(RELEASE),
                &b"\x1b[97;5:3u"[..],
            ),
            (c('a').with_mods(SUPER), &b"\x1b[97;9u"[..]),
            (k(Key::Escape), &b"\x1b"[..]),
            (k(Key::Escape).with_kind(RELEASE), &b"\x1b[27;1:3u"[..]),
            (k(Key::Enter).with_mods(CTRL), &b"\r"[..]),
            (k(Key::Tab).with_mods(SHIFT), &b"\x1b[Z"[..]),
            (k(Key::Backspace).with_mods(CTRL), &b"\x08"[..]),
            (k(Key::Up), &b"\x1bOA"[..]),
            (k(Key::Up).with_mods(SHIFT), &b"\x1b[1;2A"[..]),
            (k(Key::Up).with_kind(RELEASE), &b"\x1b[1;1:3A"[..]),
            (k(Key::Up).with_kind(REPEAT), &b"\x1b[1;1:2A"[..]),
            (k(Key::Home), &b"\x1bOH"[..]),
            (k(Key::F(1)), &b"\x1bOP"[..]),
            (k(Key::F(1)).with_kind(RELEASE), &b"\x1b[1;1:3P"[..]),
            (k(Key::Menu), &b"\x1b[29~"[..]),
            (k(Key::Menu).with_kind(RELEASE), &b"\x1b[57363;1:3u"[..]),
            (k(Key::F(13)), &b"\x1b[1;2P"[..]),
            (k(Key::Media(Media::Play)), &b"\x1b[57428u"[..]),
            (k(Key::Keypad(Keypad::Num1)).with_text("1"), &b"\x1bOq"[..]),
            (k(Key::Keypad(Keypad::Num1)).with_mods(ALT), &b"\x1b1"[..]),
            (k(Key::Keypad(Keypad::Enter)), &b"\x1bOM"[..]),
            (k(Key::Keypad(Keypad::Home)), &b"\x1bOH"[..]),
            (
                k(Key::Keypad(Keypad::Home)).with_kind(RELEASE),
                &b"\x1b[1;1:3H"[..],
            ),
        ],
    );
}

#[test]
fn alternates_never_change_whether_a_press_is_escaped() {
    // Spec "Report alternate keys": "only key events represented as escape
    // codes due to the other enhancements in effect will be affected by this
    // enhancement. In other words, only if a key event was already going to be
    // represented as an escape code due to one of the other enhancements will
    // this enhancement affect it." (rst 401-405)
    let cyr_es = '\u{441}'; // с
    let cyr_es_upper = '\u{421}'; // С
    check_keys(
        kitty(REPORT_EVENT_TYPES | REPORT_ALTERNATES),
        &[
            (
                c('a').with_mods(CTRL | SHIFT).with_shifted_key('A'),
                &b"\x01"[..],
            ),
            (
                c(cyr_es).with_mods(CTRL).with_base_layout_key('c'),
                &b"\x03"[..],
            ),
            (
                c(cyr_es)
                    .with_mods(CTRL | SHIFT)
                    .with_shifted_key(cyr_es_upper)
                    .with_base_layout_key('c'),
                &b"\x03"[..],
            ),
            // Releases are escaped by event types, so alternates decorate them.
            (
                c('a')
                    .with_mods(CTRL | SHIFT)
                    .with_shifted_key('A')
                    .with_kind(RELEASE),
                &b"\x1b[97:65;6:3u"[..],
            ),
            (
                c(cyr_es)
                    .with_mods(CTRL)
                    .with_base_layout_key('c')
                    .with_kind(RELEASE),
                &b"\x1b[1089::99;5:3u"[..],
            ),
            // A press legacy cannot express is escaped, and decorated.
            (
                c(cyr_es).with_mods(SUPER).with_base_layout_key('c'),
                &b"\x1b[1089::99;9u"[..],
            ),
        ],
    );
}

#[test]
fn presses_are_legacy_bytes_without_disambiguate_or_report_all() {
    // Invariant: any press that legacy encodes gives identical bytes under
    // 0b10, 0b100, 0b110 and 0b10110, in every cursor/keypad mode.
    let mut events = vec![
        k(Key::Escape),
        k(Key::Enter),
        k(Key::Tab),
        k(Key::Backspace),
        k(Key::Insert),
        k(Key::Delete),
        k(Key::Left),
        k(Key::Right),
        k(Key::Up),
        k(Key::Down),
        k(Key::PageUp),
        k(Key::PageDown),
        k(Key::Home),
        k(Key::End),
        k(Key::Menu),
        k(Key::Keypad(Keypad::Begin)),
        k(Key::Keypad(Keypad::Num5)).with_text("5"),
        k(Key::Keypad(Keypad::Enter)),
        k(Key::Keypad(Keypad::Up)),
        c('a').with_text("a"),
        c('a').with_shifted_key('A'),
        c('3').with_shifted_key('#'),
        c(' '),
        c('\u{441}').with_base_layout_key('c'),
    ];
    for n in 1..=24 {
        events.push(k(Key::F(n)));
    }
    let mod_sets = [
        Mods::NONE,
        SHIFT,
        ALT,
        CTRL,
        CTRL | SHIFT,
        CTRL | ALT,
        SHIFT | ALT,
        CAPS | NUM,
    ];
    for app_cursor_keys in [false, true] {
        for app_keypad in [false, true] {
            let base = Modes {
                app_cursor_keys,
                app_keypad,
                ..Modes::default()
            };
            for ev in &events {
                for m in mod_sets {
                    let ev = ev.with_mods(ev.mods | m);
                    let legacy = common::key(ev, base);
                    if legacy.is_empty() {
                        continue;
                    }
                    for flags in [
                        REPORT_EVENT_TYPES,
                        REPORT_ALTERNATES,
                        REPORT_EVENT_TYPES | REPORT_ALTERNATES,
                        REPORT_EVENT_TYPES | REPORT_ALTERNATES | REPORT_TEXT,
                    ] {
                        let got = common::key(
                            ev,
                            Modes {
                                kitty_keyboard: flags,
                                ..base
                            },
                        );
                        assert_eq!(
                            show(&got),
                            show(&legacy),
                            "{ev:?} flags {flags:#b} DECCKM {app_cursor_keys} DECKPAM {app_keypad}"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn control_characters_in_char_keys() {
    // A Char holding a control character is the named key, or nothing.
    for flags in [0, DISAMBIGUATE, REPORT_EVENT_TYPES, REPORT_ALL_KEYS] {
        let m = kitty(flags);
        for (ch, named) in [
            ('\r', Key::Enter),
            ('\n', Key::Enter),
            ('\t', Key::Tab),
            ('\x1b', Key::Escape),
            ('\x7f', Key::Backspace),
            ('\x08', Key::Backspace),
        ] {
            for mods in [Mods::NONE, CTRL, ALT | SHIFT] {
                assert_eq!(
                    common::key(c(ch).with_mods(mods), m),
                    common::key(k(named).with_mods(mods), m),
                    "{ch:?} {mods:?} flags {flags:#b}"
                );
            }
        }
        for ch in ['\u{0}', '\u{1}', '\u{1f}', '\u{80}', '\u{9b}', '\u{9f}'] {
            assert!(common::key(c(ch), m).is_empty(), "{ch:?} flags {flags:#b}");
            assert!(
                common::key(c(ch).with_mods(CTRL), m).is_empty(),
                "{ch:?} flags {flags:#b}"
            );
        }
    }
    assert_eq!(common::key(c('\r'), Modes::default()), b"\r");
    assert_eq!(common::key(c('\x1b'), kitty(DISAMBIGUATE)), b"\x1b[27u");
}

#[test]
fn report_alternate_keys() {
    let cyr_es = '\u{441}'; // с
    let cyr_es_upper = '\u{421}'; // С
    check_keys(
        kitty(DISAMBIGUATE | REPORT_ALTERNATES),
        &[
            (
                c('a').with_mods(CTRL | SHIFT).with_shifted_key('A'),
                &b"\x1b[97:65;6u"[..],
            ),
            // The shifted key is present only with Shift.
            (
                c('a').with_mods(CTRL).with_shifted_key('A'),
                &b"\x1b[97;5u"[..],
            ),
            // Base layout key alone: empty shifted sub-field.
            (
                c(cyr_es).with_mods(CTRL).with_base_layout_key('c'),
                &b"\x1b[1089::99;5u"[..],
            ),
            (
                c(cyr_es)
                    .with_mods(CTRL | SHIFT)
                    .with_shifted_key(cyr_es_upper)
                    .with_base_layout_key('c'),
                &b"\x1b[1089:1057:99;6u"[..],
            ),
            // A base key equal to the key adds nothing.
            (
                c('c').with_mods(CTRL).with_base_layout_key('c'),
                &b"\x1b[99;5u"[..],
            ),
            // Only keys already escaped are affected.
            (
                c('a').with_mods(SHIFT).with_text("A").with_shifted_key('A'),
                &b"A"[..],
            ),
            (k(Key::Up).with_mods(SHIFT), &b"\x1b[1;2A"[..]),
        ],
    );
}

#[test]
fn alternates_or_text_alone_are_legacy() {
    for flags in [
        REPORT_ALTERNATES,
        REPORT_TEXT,
        REPORT_ALTERNATES | REPORT_TEXT,
    ] {
        let modes = Modes {
            app_cursor_keys: true,
            kitty_keyboard: flags,
            ..Modes::default()
        };
        check_keys(
            modes,
            &[
                (k(Key::Up), &b"\x1bOA"[..]),
                (k(Key::Escape), &b"\x1b"[..]),
                (
                    c('a').with_mods(CTRL | SHIFT).with_shifted_key('A'),
                    &b"\x01"[..],
                ),
                (c('a').with_text("a").with_kind(RELEASE), &b""[..]),
                (k(Key::F(13)), &b"\x1b[1;2P"[..]),
            ],
        );
    }
}

#[test]
fn report_all_keys() {
    check_keys(
        kitty(REPORT_ALL_KEYS),
        &[
            (c('a').with_text("a"), &b"\x1b[97u"[..]),
            (c('a').with_mods(SHIFT).with_text("A"), &b"\x1b[97;2u"[..]),
            (c('a').with_mods(CAPS).with_text("A"), &b"\x1b[97;65u"[..]),
            (c('a').with_mods(CTRL), &b"\x1b[97;5u"[..]),
            (k(Key::Enter), &b"\x1b[13u"[..]),
            (k(Key::Tab), &b"\x1b[9u"[..]),
            (k(Key::Backspace), &b"\x1b[127u"[..]),
            (k(Key::Escape), &b"\x1b[27u"[..]),
            (k(Key::Enter).with_mods(CAPS), &b"\x1b[13;65u"[..]),
            (
                k(Key::Keypad(Keypad::Num1)).with_text("1"),
                &b"\x1b[57400u"[..],
            ),
            // Modifier keys: the bit reflects the state after the event.
            (
                k(Key::Modifier(ModifierKey::LeftShift)).with_mods(SHIFT),
                &b"\x1b[57441;2u"[..],
            ),
            (k(Key::CapsLock).with_mods(CAPS), &b"\x1b[57358;65u"[..]),
            // Still no release without event types.
            (c('a').with_text("a").with_kind(RELEASE), &b""[..]),
        ],
    );
    check_keys(
        kitty(REPORT_ALL_KEYS | REPORT_EVENT_TYPES),
        &[
            (
                c('a').with_text("a").with_kind(RELEASE),
                &b"\x1b[97;1:3u"[..],
            ),
            (
                c('a').with_text("a").with_kind(REPEAT),
                &b"\x1b[97;1:2u"[..],
            ),
            (k(Key::Enter).with_kind(RELEASE), &b"\x1b[13;1:3u"[..]),
            (k(Key::Tab).with_kind(RELEASE), &b"\x1b[9;1:3u"[..]),
            (
                k(Key::Modifier(ModifierKey::LeftShift)).with_kind(RELEASE),
                &b"\x1b[57441;1:3u"[..],
            ),
        ],
    );
}

#[test]
fn report_associated_text() {
    check_keys(
        kitty(REPORT_ALL_KEYS | REPORT_TEXT),
        &[
            // Spec example: shift+a -> CSI 97 ; 2 ; 65 u
            (
                c('a').with_mods(SHIFT).with_text("A"),
                &b"\x1b[97;2;65u"[..],
            ),
            // No modifiers: empty second field.
            (c('a').with_text("a"), &b"\x1b[97;;97u"[..]),
            (c('a'), &b"\x1b[97;;97u"[..]),
            (c('a').with_mods(SHIFT), &b"\x1b[97;2;65u"[..]),
            // Several code points are colon-separated.
            (c('e').with_text("e\u{301}"), &b"\x1b[101;;101:769u"[..]),
            // Keys that type nothing carry no text.
            (c('a').with_mods(CTRL), &b"\x1b[97;5u"[..]),
            (k(Key::Enter), &b"\x1b[13u"[..]),
            (c('a').with_text("\r"), &b"\x1b[97;;97u"[..]),
            (k(Key::Up), &b"\x1b[A"[..]),
            (
                k(Key::Keypad(Keypad::Num1)).with_text("1"),
                &b"\x1b[57400;;49u"[..],
            ),
        ],
    );
    check_keys(
        kitty(ALL),
        &[
            (
                c('a').with_text("a").with_kind(RELEASE),
                &b"\x1b[97;1:3u"[..],
            ),
            (
                c('a').with_text("a").with_kind(REPEAT),
                &b"\x1b[97;1:2;97u"[..],
            ),
            (
                c('a')
                    .with_mods(CTRL | SHIFT)
                    .with_shifted_key('A')
                    .with_kind(RELEASE),
                &b"\x1b[97:65;6:3u"[..],
            ),
            (
                c('a').with_mods(SHIFT).with_text("A").with_shifted_key('A'),
                &b"\x1b[97:65;2;65u"[..],
            ),
        ],
    );
}

#[test]
fn unknown_flag_bits_are_ignored() {
    assert_eq!(common::key(k(Key::Up), kitty(0b1110_0000)), b"\x1b[A");
    assert_eq!(
        common::key(k(Key::Escape), kitty(0b1110_0000 | DISAMBIGUATE)),
        b"\x1b[27u"
    );
}
