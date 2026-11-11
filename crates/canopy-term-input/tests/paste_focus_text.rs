//! Paste, focus, text, and a property test that a bracketed paste can never
//! close its own bracket.

mod common;

use canopy_term_input::*;
use common::*;

fn bracketed() -> Modes {
    Modes {
        bracketed_paste: true,
        ..Modes::default()
    }
}

fn paste(text: &str, m: Modes) -> Vec<u8> {
    let mut out = Vec::new();
    let wrote = encode_paste(text, m, &mut out);
    assert_eq!(wrote, !out.is_empty());
    out
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

#[test]
fn bracketed_paste_wraps_and_keeps_newlines() {
    assert_eq!(paste("hi", bracketed()), b"\x1b[200~hi\x1b[201~");
    assert_eq!(
        paste("a\nb\r\nc", bracketed()),
        b"\x1b[200~a\nb\r\nc\x1b[201~"
    );
    assert_eq!(paste("", bracketed()), b"\x1b[200~\x1b[201~");
    assert_eq!(
        paste("héllo 😀", bracketed()),
        "\x1b[200~héllo 😀\x1b[201~".as_bytes()
    );
}

#[test]
fn bracketed_paste_strips_escapes_and_c1() {
    let cases: &[(&str, &str)] = &[
        ("\x1b[201~rm -rf ~\n", "[201~rm -rf ~\n"),
        ("a\x1bb", "ab"),
        ("\x1b\x1b\x1b", ""),
        // Removing only the marker would splice a new one; removing ESC cannot.
        ("\x1b[20\x1b[201~1~", "[20[201~1~"),
        // 8-bit CSI (U+009B) and the rest of C1.
        ("\u{9b}201~", "201~"),
        ("x\u{80}y\u{9f}z", "xyz"),
        // Neighbours of C1 in UTF-8 survive.
        ("\u{a0}\u{7f}\u{100}", "\u{a0}\u{7f}\u{100}"),
        // Other C0 controls are the program's business inside the bracket.
        ("\t\x03\x08", "\t\x03\x08"),
    ];
    for &(input, inner) in cases {
        let want = format!("\x1b[200~{inner}\x1b[201~");
        assert_eq!(
            show(&paste(input, bracketed())),
            show(want.as_bytes()),
            "{input:?}"
        );
    }
}

#[test]
fn unbracketed_paste_sends_newlines_as_cr() {
    let m = Modes::default();
    assert_eq!(paste("a\nb", m), b"a\rb");
    assert_eq!(paste("a\r\nb", m), b"a\rb");
    assert_eq!(paste("a\n\nb\r\n", m), b"a\r\rb\r");
    assert_eq!(paste("a\rb", m), b"a\rb");
    assert_eq!(paste("\r\r\n", m), b"\r\r");
    assert_eq!(paste("plain", m), b"plain");
    assert!(paste("", m).is_empty());
}

#[test]
fn paste_appends() {
    let mut out = b"x".to_vec();
    assert!(encode_paste("y", bracketed(), &mut out));
    assert_eq!(out, b"x\x1b[200~y\x1b[201~");
}

/// xorshift64*: deterministic, no dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// Random text biased toward bracket-marker fragments, so splices and nested
/// markers actually occur.
fn random_paste(rng: &mut Rng) -> String {
    const FRAGMENTS: &[&str] = &[
        "\x1b",
        "[",
        "2",
        "0",
        "1",
        "~",
        "\x1b[",
        "\x1b[2",
        "\x1b[20",
        "\x1b[201",
        "\x1b[201~",
        "\x1b[200~",
        "201~",
        "[201~",
        "\u{9b}",
        "\u{9b}201~",
        "\u{85}",
        "\u{c2}",
        "\n",
        "\r\n",
        "a",
        "é",
        "😀",
        "\x07",
    ];
    let mut s = String::new();
    let len = rng.below(40);
    for _ in 0..len {
        if rng.below(5) == 0 {
            // Any scalar value from a few ranges, C0/C1 included.
            let c = match rng.below(3) {
                0 => rng.below(0x80) as u32,
                1 => 0x80 + rng.below(0x80) as u32,
                _ => rng.below(0x11_0000) as u32,
            };
            if let Some(c) = char::from_u32(c) {
                s.push(c);
            }
        } else {
            s.push_str(FRAGMENTS[rng.below(FRAGMENTS.len())]);
        }
    }
    s
}

#[test]
fn property_bracketed_paste_never_closes_early() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for i in 0..20_000 {
        let input = random_paste(&mut rng);
        let out = paste(&input, bracketed());
        assert!(out.starts_with(PASTE_START), "case {i}");
        assert!(out.ends_with(PASTE_END), "case {i}");
        let inner = &out[PASTE_START.len()..out.len() - PASTE_END.len()];
        assert!(!contains(inner, PASTE_END), "case {i}: {input:?}");
        assert!(!inner.contains(&0x1b), "case {i}: {input:?}");
        // Still valid UTF-8 with no C1 controls (no 8-bit CSI).
        let inner = std::str::from_utf8(inner).expect("valid UTF-8");
        assert!(!inner.chars().any(|c| ('\u{80}'..='\u{9f}').contains(&c)));
        // Exactly the input minus ESC and C1, nothing else lost.
        let expected: String = input
            .chars()
            .filter(|&c| c != '\x1b' && !('\u{80}'..='\u{9f}').contains(&c))
            .collect();
        assert_eq!(inner, expected, "case {i}");
        // The end marker appears exactly once in the whole output.
        let ends = out
            .windows(PASTE_END.len())
            .filter(|w| *w == PASTE_END)
            .count();
        assert_eq!(ends, 1, "case {i}");
    }
}

#[test]
fn property_unbracketed_paste_has_no_line_feeds() {
    let mut rng = Rng(0x0123_4567_89AB_CDEF);
    for i in 0..5_000 {
        let input = random_paste(&mut rng);
        let out = paste(&input, Modes::default());
        assert!(!out.contains(&b'\n'), "case {i}: {input:?}");
        let expected = input.replace("\r\n", "\r").replace('\n', "\r");
        assert_eq!(out, expected.into_bytes(), "case {i}");
    }
}

#[test]
fn focus_reports_only_in_mode_1004() {
    let on = Modes {
        focus_events: true,
        ..Modes::default()
    };
    let mut out = Vec::new();
    assert!(encode_focus(true, on, &mut out));
    assert_eq!(out, b"\x1b[I");
    out.clear();
    assert!(encode_focus(false, on, &mut out));
    assert_eq!(out, b"\x1b[O");
    out.clear();
    assert!(!encode_focus(true, Modes::default(), &mut out));
    assert!(!encode_focus(false, Modes::default(), &mut out));
    assert!(out.is_empty());
}

#[test]
fn text_is_utf8_passthrough_in_every_mode() {
    let mut out = Vec::new();
    for flags in [0u8, kitty_flags::DISAMBIGUATE, kitty_flags::ALL] {
        out.clear();
        assert!(encode_text("日本語 é 😀", kitty(flags), &mut out));
        assert_eq!(out, "日本語 é 😀".as_bytes());
    }
    out.clear();
    assert!(!encode_text("", Modes::default(), &mut out));
    assert!(out.is_empty());
}

#[test]
fn every_mode_toggle_has_its_effect_and_no_other() {
    let base = Modes::default();
    let up = KeyEvent::new(Key::Up);
    let kp1 = KeyEvent::new(Key::Keypad(Keypad::Num1)).with_text("1");
    let esc = KeyEvent::new(Key::Escape);
    let click = MouseEvent {
        kind: MouseEventKind::Press(MouseButton::Left),
        col: 0,
        row: 0,
        mods: Mods::NONE,
    };
    let snapshot = |m: Modes| {
        let mut out = Vec::new();
        let mut parts = Vec::new();
        for ev in [up, kp1, esc] {
            out.clear();
            encode_key(&ev, m, &mut out);
            parts.push(out.clone());
        }
        out.clear();
        encode_mouse(&click, m, &mut out);
        parts.push(out.clone());
        out.clear();
        encode_paste("a\nb", m, &mut out);
        parts.push(out.clone());
        out.clear();
        encode_focus(true, m, &mut out);
        parts.push(out.clone());
        parts
    };
    let before = snapshot(base);
    assert_eq!(before[0], b"\x1b[A");
    assert_eq!(before[1], b"1");
    assert_eq!(before[2], b"\x1b");
    assert!(before[3].is_empty());
    assert_eq!(before[4], b"a\rb");
    assert!(before[5].is_empty());

    // (toggle, index of the only output that may change)
    let toggles: Vec<(Modes, usize)> = vec![
        (
            Modes {
                app_cursor_keys: true,
                ..base
            },
            0,
        ),
        (
            Modes {
                app_keypad: true,
                ..base
            },
            1,
        ),
        (
            Modes {
                kitty_keyboard: kitty_flags::DISAMBIGUATE,
                ..base
            },
            2,
        ),
        (
            Modes {
                mouse: MouseMode::Press,
                ..base
            },
            3,
        ),
        (
            Modes {
                mouse: MouseMode::Normal,
                ..base
            },
            3,
        ),
        (
            Modes {
                mouse: MouseMode::Drag,
                ..base
            },
            3,
        ),
        (
            Modes {
                mouse: MouseMode::Any,
                ..base
            },
            3,
        ),
        (
            Modes {
                bracketed_paste: true,
                ..base
            },
            4,
        ),
        (
            Modes {
                focus_events: true,
                ..base
            },
            5,
        ),
    ];
    for (m, idx) in toggles {
        let after = snapshot(m);
        for (j, (a, b)) in before.iter().zip(&after).enumerate() {
            if j == idx {
                assert_ne!(a, b, "{m:?} should change output {j}");
            } else {
                assert_eq!(a, b, "{m:?} should not change output {j}");
            }
        }
    }
    // Encoding alone changes nothing while tracking is off.
    for e in [MouseEncoding::Utf8, MouseEncoding::Sgr] {
        assert_eq!(
            snapshot(Modes {
                mouse_encoding: e,
                ..base
            }),
            before
        );
    }
    // Synchronized output is a display concern: no input changes at all.
    assert_eq!(
        snapshot(Modes {
            sync_output: true,
            ..base
        }),
        before
    );
    let all_on = Modes {
        app_cursor_keys: true,
        app_keypad: true,
        bracketed_paste: true,
        focus_events: true,
        mouse: MouseMode::Any,
        mouse_encoding: MouseEncoding::Sgr,
        ..base
    };
    assert_eq!(
        snapshot(Modes {
            sync_output: true,
            ..all_on
        }),
        snapshot(all_on)
    );
    assert_eq!(
        snapshot(all_on),
        vec![
            b"\x1bOA".to_vec(),
            b"\x1bOq".to_vec(),
            b"\x1b".to_vec(),
            b"\x1b[<0;1;1M".to_vec(),
            b"\x1b[200~a\nb\x1b[201~".to_vec(),
            b"\x1b[I".to_vec(),
        ]
    );
}
