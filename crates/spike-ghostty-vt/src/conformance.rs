//! The 18 conformance fixtures (byte streams and expected values) copied from
//! canopy-term-core tests/compare.rs, plus the neutral `Dump` they check.
#![allow(dead_code)]

/// What a candidate exposes after consuming bytes. `Option` fields are `None`
/// when the candidate does not expose that mode at all (reported, not failed).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Dump {
    pub rows: Vec<String>,
    pub cursor: (u16, u16),
    pub cursor_visible: bool,
    pub alt: bool,
    pub app_cursor: bool,
    pub app_keypad: bool,
    pub bracketed: bool,
    pub mouse: String,
    pub mouse_enc: String,
    pub focus: Option<bool>,
    pub sync: Option<bool>,
    pub kitty: Option<u8>,
    /// `row,col:attrs` for each non-default cell, e.g. `0,0:bold,fg=1`.
    pub styles: Vec<String>,
    pub scrollback_len: usize,
}

pub struct Fixture {
    pub name: &'static str,
    pub cols: u16,
    pub rows: u16,
    pub input: &'static [u8],
    pub check: fn(&Dump) -> Result<(), String>,
}

fn row(d: &Dump, i: usize, want: &str) -> Result<(), String> {
    let got = d.rows.get(i).map(String::as_str).unwrap_or("<none>");
    if got == want {
        Ok(())
    } else {
        Err(format!("row {i}: got {got:?}, want {want:?}"))
    }
}

fn mode<T: PartialEq + std::fmt::Debug>(name: &str, got: Option<T>, want: T) -> Result<(), String> {
    match got {
        None => Err(format!("{name}: not exposed")),
        Some(g) if g == want => Ok(()),
        Some(g) => Err(format!("{name}: got {g:?}, want {want:?}")),
    }
}

pub fn fixtures() -> Vec<Fixture> {
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
