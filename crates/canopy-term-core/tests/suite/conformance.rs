//! The 18 conformance fixtures from `tests/compare.rs` (byte streams and the
//! values they must produce), checked through `Screen` and its `Frame` so every
//! engine behind `Screen` meets the same bar. Synthetic input only.

macro_rules! define {
    ($m:ident, $screen:ty) => {
        mod $m {
            use canopy_term_core::frame::{Attrs, Color, MouseEncoding, MouseMode};

            type Screen = $screen;

            /// What a screen exposes after consuming bytes.
            #[derive(Clone, Debug, PartialEq, Default)]
            struct Dump {
                rows: Vec<String>,
                cursor: (u16, u16),
                cursor_visible: bool,
                alt: bool,
                app_cursor: bool,
                app_keypad: bool,
                bracketed: bool,
                mouse: String,
                mouse_enc: String,
                focus: Option<bool>,
                sync: Option<bool>,
                kitty: Option<u8>,
                /// `row,col:attrs` for each non-default cell, e.g. `0,0:bold,fg=1`.
                styles: Vec<String>,
                scrollback_len: usize,
            }

            fn dump(s: &Screen) -> Dump {
                let f = s.frame();
                let mut d = Dump::default();
                for r in 0..f.rows {
                    let mut line = String::new();
                    for c in 0..f.cols {
                        let cell = f.cell(r, c).unwrap();
                        if cell.attrs.has(Attrs::WIDE_TAIL) {
                            continue;
                        }
                        line.push_str(&f.text(cell));
                        let mut a: Vec<String> = Vec::new();
                        for (flag, name) in [
                            (Attrs::BOLD, "bold"),
                            (Attrs::DIM, "dim"),
                            (Attrs::ITALIC, "italic"),
                            (Attrs::UNDERLINE, "underline"),
                            (Attrs::INVERSE, "inverse"),
                            (Attrs::HIDDEN, "hidden"),
                            (Attrs::STRIKE, "strike"),
                        ] {
                            if cell.attrs.has(flag) {
                                a.push(name.to_string());
                            }
                        }
                        match cell.fg {
                            Color::Default => {}
                            Color::Indexed(i) => a.push(format!("fg={i}")),
                            Color::Rgb(x, y, z) => a.push(format!("fg={x}/{y}/{z}")),
                        }
                        match cell.bg {
                            Color::Default => {}
                            Color::Indexed(i) => a.push(format!("bg={i}")),
                            Color::Rgb(x, y, z) => a.push(format!("bg={x}/{y}/{z}")),
                        }
                        if !a.is_empty() {
                            d.styles.push(format!("{r},{c}:{}", a.join(",")));
                        }
                    }
                    d.rows.push(line.trim_end().to_string());
                }
                d.cursor = (f.cursor.row, f.cursor.col);
                d.cursor_visible = f.cursor.visible;
                d.alt = f.alt_screen;
                d.app_cursor = f.modes.app_cursor_keys;
                d.app_keypad = f.modes.app_keypad;
                d.bracketed = f.modes.bracketed_paste;
                d.mouse = match f.modes.mouse {
                    MouseMode::Off => "None",
                    MouseMode::Press => "Press",
                    MouseMode::Normal => "PressRelease",
                    MouseMode::Drag => "ButtonMotion",
                    MouseMode::Any => "AnyMotion",
                }
                .to_string();
                d.mouse_enc = match f.modes.mouse_encoding {
                    MouseEncoding::Default => "Default",
                    MouseEncoding::Utf8 => "Utf8",
                    MouseEncoding::Sgr => "Sgr",
                }
                .to_string();
                d.focus = Some(f.modes.focus_events);
                d.sync = Some(f.modes.sync_output);
                d.kitty = Some(f.modes.kitty_keyboard);
                d.scrollback_len = s.scrollback_len();
                d
            }

            struct Fixture {
                name: &'static str,
                cols: u16,
                rows: u16,
                input: &'static [u8],
                check: fn(&Dump) -> Result<(), String>,
            }

            fn row(d: &Dump, i: usize, want: &str) -> Result<(), String> {
                let got = d.rows.get(i).map(String::as_str).unwrap_or("<none>");
                if got == want {
                    Ok(())
                } else {
                    Err(format!("row {i}: got {got:?}, want {want:?}"))
                }
            }

            fn mode<T: PartialEq + std::fmt::Debug>(
                name: &str,
                got: Option<T>,
                want: T,
            ) -> Result<(), String> {
                match got {
                    None => Err(format!("{name}: not exposed")),
                    Some(g) if g == want => Ok(()),
                    Some(g) => Err(format!("{name}: got {g:?}, want {want:?}")),
                }
            }

            fn fixtures() -> Vec<Fixture> {
                vec![
                    Fixture {
                        name: "plain text and CRLF",
                        cols: 20,
                        rows: 4,
                        input: b"hello\r\nworld",
                        check: |d| {
                            row(d, 0, "hello")?;
                            row(d, 1, "world")?;
                            if d.cursor == (1, 5) {
                                Ok(())
                            } else {
                                Err(format!("cursor {:?}", d.cursor))
                            }
                        },
                    },
                    Fixture {
                        name: "SGR colour and bold",
                        cols: 20,
                        rows: 2,
                        input: b"\x1b[1;31mR\x1b[0m\x1b[38;2;1;2;3mT\x1b[0mz",
                        check: |d| {
                            let want = ["0,0:bold,fg=1", "0,1:fg=1/2/3"];
                            for w in want {
                                if !d.styles.iter().any(|s| s == w) {
                                    return Err(format!("missing {w}, have {:?}", d.styles));
                                }
                            }
                            if d.styles.len() != 2 {
                                return Err(format!("extra styled cells {:?}", d.styles));
                            }
                            Ok(())
                        },
                    },
                    Fixture {
                        name: "wide char",
                        cols: 10,
                        rows: 2,
                        input: "a日b".as_bytes(),
                        check: |d| {
                            row(d, 0, "a日b")?;
                            if d.cursor == (0, 4) {
                                Ok(())
                            } else {
                                Err(format!("cursor {:?}", d.cursor))
                            }
                        },
                    },
                    Fixture {
                        name: "combining mark kept in cell",
                        cols: 10,
                        rows: 2,
                        input: "e\u{301}x".as_bytes(),
                        check: |d| {
                            row(d, 0, "e\u{301}x")?;
                            if d.cursor == (0, 2) {
                                Ok(())
                            } else {
                                Err(format!("cursor {:?}", d.cursor))
                            }
                        },
                    },
                    Fixture {
                        name: "autowrap",
                        cols: 10,
                        rows: 3,
                        input: b"0123456789AB",
                        check: |d| {
                            row(d, 0, "0123456789")?;
                            row(d, 1, "AB")
                        },
                    },
                    Fixture {
                        name: "alt screen enter and leave",
                        cols: 20,
                        rows: 3,
                        input: b"main\x1b[?1049halt\x1b[?1049l",
                        check: |d| {
                            row(d, 0, "main")?;
                            if d.alt {
                                return Err("still on alt screen".into());
                            }
                            Ok(())
                        },
                    },
                    Fixture {
                        name: "on alt screen",
                        cols: 20,
                        rows: 3,
                        input: b"main\x1b[?1049h\x1b[Halt",
                        check: |d| {
                            row(d, 0, "alt")?;
                            if d.alt {
                                Ok(())
                            } else {
                                Err("not on alt screen".into())
                            }
                        },
                    },
                    Fixture {
                        name: "mouse 1002 + SGR encoding",
                        cols: 20,
                        rows: 3,
                        input: b"\x1b[?1002h\x1b[?1006h",
                        check: |d| {
                            mode("mouse", Some(d.mouse.as_str()), "ButtonMotion")?;
                            mode("encoding", Some(d.mouse_enc.as_str()), "Sgr")
                        },
                    },
                    Fixture {
                        name: "mouse X10 (9)",
                        cols: 20,
                        rows: 3,
                        input: b"\x1b[?9h",
                        check: |d| mode("mouse", Some(d.mouse.as_str()), "Press"),
                    },
                    Fixture {
                        name: "bracketed paste, DECCKM, DECKPAM",
                        cols: 20,
                        rows: 3,
                        input: b"\x1b[?2004h\x1b[?1h\x1b=",
                        check: |d| {
                            mode("bracketed", Some(d.bracketed), true)?;
                            mode("app_cursor", Some(d.app_cursor), true)?;
                            mode("app_keypad", Some(d.app_keypad), true)
                        },
                    },
                    Fixture {
                        name: "focus events (1004)",
                        cols: 20,
                        rows: 3,
                        input: b"\x1b[?1004h",
                        check: |d| mode("focus", d.focus, true),
                    },
                    Fixture {
                        name: "synchronized output (2026) readable",
                        cols: 20,
                        rows: 3,
                        input: b"\x1b[?2026h",
                        check: |d| mode("sync", d.sync, true),
                    },
                    Fixture {
                        name: "kitty keyboard flags (push 5)",
                        cols: 20,
                        rows: 3,
                        input: b"\x1b[>5u",
                        check: |d| mode("kitty", d.kitty, 5),
                    },
                    Fixture {
                        name: "text sent during sync (2026) reaches the grid",
                        cols: 20,
                        rows: 3,
                        input: b"\x1b[?2026hX",
                        check: |d| row(d, 0, "X"),
                    },
                    Fixture {
                        name: "RIS (ESC c) resets tracked modes",
                        cols: 20,
                        rows: 3,
                        input: b"\x1b[?1004h\x1b[?2004h\x1b[>5u\x1bc",
                        check: |d| {
                            mode("focus", d.focus, false)?;
                            mode("bracketed", Some(d.bracketed), false)?;
                            mode("kitty", d.kitty, 0)?;
                            match d.sync {
                                Some(true) => Err("sync still on after RIS".into()),
                                _ => Ok(()),
                            }
                        },
                    },
                    Fixture {
                        name: "SGR dim, italic, underline, hidden, strike",
                        cols: 20,
                        rows: 2,
                        input: b"\x1b[2ma\x1b[0m\x1b[3mb\x1b[0m\x1b[4mc\x1b[0m\x1b[8md\x1b[0m\x1b[9me",
                        check: |d| {
                            for w in [
                                "0,0:dim",
                                "0,1:italic",
                                "0,2:underline",
                                "0,3:hidden",
                                "0,4:strike",
                            ] {
                                if !d.styles.iter().any(|s| s == w) {
                                    return Err(format!("missing {w}, have {:?}", d.styles));
                                }
                            }
                            Ok(())
                        },
                    },
                    Fixture {
                        name: "cursor hidden",
                        cols: 20,
                        rows: 3,
                        input: b"\x1b[?25l",
                        check: |d| mode("cursor_visible", Some(d.cursor_visible), false),
                    },
                    Fixture {
                        name: "scrollback captured",
                        cols: 10,
                        rows: 3,
                        input: b"1\r\n2\r\n3\r\n4\r\n5",
                        check: |d| {
                            row(d, 0, "3")?;
                            if d.scrollback_len == 2 {
                                Ok(())
                            } else {
                                Err(format!("scrollback_len {}", d.scrollback_len))
                            }
                        },
                    },
                ]
            }

            fn run(f: &Fixture) -> Dump {
                let mut s = Screen::with_scrollback(f.cols, f.rows, 100);
                s.advance(f.input);
                dump(&s)
            }

            #[test]
            fn the_18_fixtures_pass() {
                let fx = fixtures();
                assert_eq!(fx.len(), 18);
                let mut failed: Vec<String> = Vec::new();
                for f in &fx {
                    match (f.check)(&run(f)) {
                        Ok(()) => println!("  PASS  {}", f.name),
                        Err(why) => {
                            println!("  FAIL  {} ({why})", f.name);
                            failed.push(format!("{} ({why})", f.name));
                        }
                    }
                }
                println!("conformance: {}/{} fixtures", fx.len() - failed.len(), fx.len());
                assert!(failed.is_empty(), "fixtures that differ: {failed:#?}");
            }

            /// Sequences split at every byte boundary give the same screen.
            #[test]
            fn split_at_every_byte_gives_the_same_screen() {
                let input = "x\x1b[1;31mred\x1b[0m \x1b[?1002h\x1b[?1006h\x1b[>5u\x1b[?1004h日e\u{301}\x1b[2;3Hz\x1b[?1049hq\x1b[?1049l"
                    .as_bytes();
                let mut whole = Screen::with_scrollback(20, 5, 100);
                whole.advance(input);
                let want = dump(&whole);
                for i in 1..input.len() {
                    let mut s = Screen::with_scrollback(20, 5, 100);
                    s.advance(&input[..i]);
                    s.advance(&input[i..]);
                    assert_eq!(dump(&s), want, "differs when split at byte {i}");
                }
            }

            #[test]
            fn resize_rejoins_a_wrapped_line() {
                let mut s = Screen::with_scrollback(10, 4, 100);
                s.advance(b"0123456789ABCDE");
                s.resize(20, 4);
                let d = dump(&s);
                assert_eq!(&d.rows[..2], ["0123456789ABCDE", ""]);
            }
        }
    };
}
pub(crate) use define;
