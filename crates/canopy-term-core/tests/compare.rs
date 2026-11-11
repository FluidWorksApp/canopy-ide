//! Candidate emulator comparison, report only. Runs the same synthetic fixtures
//! and the same synthetic byte stream through each candidate and prints a
//! conformance table and throughput numbers to the CI log. Nothing here asserts
//! on timing, or on which candidate wins; the numbers inform the choice.

mod engines;

use engines::{stream::synthetic_stream, Alacritty, Dump, Engine, Vt100};
use std::time::Instant;

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

fn mode<T: PartialEq + std::fmt::Debug>(name: &str, got: Option<T>, want: T) -> Result<(), String> {
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

fn run_fixture<E: Engine>(f: &Fixture) -> Dump {
    let mut e = E::new(f.cols, f.rows, 100);
    e.feed(f.input);
    e.dump()
}

/// Sequences split at every byte boundary must give the same screen.
fn split_test<E: Engine>() -> Result<(), String> {
    let input = "x\x1b[1;31mred\x1b[0m \x1b[?1002h\x1b[?1006h\x1b[>5u\x1b[?1004h日e\u{301}\x1b[2;3Hz\x1b[?1049hq\x1b[?1049l"
        .as_bytes();
    let mut whole = E::new(20, 5, 100);
    whole.feed(input);
    let want = whole.dump();
    for i in 1..input.len() {
        let mut e = E::new(20, 5, 100);
        e.feed(&input[..i]);
        e.feed(&input[i..]);
        let got = e.dump();
        if got != want {
            return Err(format!("differs when split at byte {i}"));
        }
    }
    Ok(())
}

/// Report what resize does to a wrapped line: reflow or truncate.
fn resize_behaviour<E: Engine>() -> String {
    let mut e = E::new(10, 4, 100);
    e.feed(b"0123456789ABCDE");
    e.resize(20, 4);
    let d = e.dump();
    format!("{:?}", &d.rows[..2.min(d.rows.len())])
}

fn throughput<E: Engine>(data: &[u8]) -> (f64, f64) {
    let chunk = 4096;
    // One warm-up pass, then the measured pass on a fresh engine.
    let mut warm = E::new(120, 40, 10_000);
    for c in data.chunks(chunk).take(256) {
        warm.feed(c);
    }
    let mut e = E::new(120, 40, 10_000);
    let start = Instant::now();
    for c in data.chunks(chunk) {
        e.feed(c);
    }
    let secs = start.elapsed().as_secs_f64();
    let mb = data.len() as f64 / (1024.0 * 1024.0);
    // Keep the work observable so it cannot be optimised away.
    let d = e.dump();
    assert!(!d.rows.is_empty());
    (mb / secs, secs)
}

fn report<E: Engine>(data: &[u8]) {
    println!("\n=== {} ===", E::name());
    let mut pass = 0;
    let fx = fixtures();
    for f in &fx {
        let d = run_fixture::<E>(f);
        match (f.check)(&d) {
            Ok(()) => {
                pass += 1;
                println!("  PASS  {}", f.name);
            }
            Err(why) => println!("  FAIL  {} ({why})", f.name),
        }
    }
    println!("  conformance: {pass}/{} fixtures", fx.len());
    match split_test::<E>() {
        Ok(()) => println!("  split at every byte: identical"),
        Err(why) => println!("  split at every byte: FAIL ({why})"),
    }
    println!(
        "  resize 10->20 cols on a wrapped line: {}",
        resize_behaviour::<E>()
    );
    let (mbs, secs) = throughput::<E>(data);
    println!(
        "  throughput: {mbs:.1} MiB/s ({:.2} s for {:.1} MiB)",
        secs,
        data.len() as f64 / (1024.0 * 1024.0)
    );
}

fn main() {
    println!(
        "profile: dev with opt-level=3; os={} arch={}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    let data = synthetic_stream(32 * 1024 * 1024);
    println!("synthetic stream: {} bytes", data.len());
    report::<Vt100>(&data);
    report::<Alacritty>(&data);
}
