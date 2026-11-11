//! libghostty-vt on the 18 conformance fixtures and the perf stream.
//! Usage: `ghostty conf | perf | rss-idle | rss-fill`.

use libghostty_vt::screen::{CellContentTag, CellWide, Screen};
use libghostty_vt::style::{StyleColor, Underline};
use libghostty_vt::terminal::{Mode, Point, PointCoordinate};
use libghostty_vt::{Terminal, TerminalOptions};
use spike_ghostty_vt::conformance::{fixtures, Dump};
use spike_ghostty_vt::{
    peak_rss_kib, scrollback_line, stream::synthetic_stream, throughput, SCROLLBACK_LINES_FED,
};

fn new_term(cols: u16, rows: u16, scrollback: usize) -> Terminal<'static, 'static> {
    Terminal::new(TerminalOptions {
        cols,
        rows,
        max_scrollback: scrollback,
    })
    .expect("Terminal::new")
}

fn color(c: StyleColor) -> Option<String> {
    match c {
        StyleColor::Palette(p) => Some(format!("{}", p.0)),
        StyleColor::Rgb(c) => Some(format!("{}/{}/{}", c.r, c.g, c.b)),
        _ => None,
    }
}

fn dump(t: &Terminal<'_, '_>) -> Dump {
    let cols = t.cols().expect("cols");
    let rows = t.rows().expect("rows");
    let mut d = Dump::default();
    for r in 0..rows {
        let mut line = String::new();
        for c in 0..cols {
            let gr = match t.grid_ref(Point::Active(PointCoordinate { x: c, y: r as u32 })) {
                Ok(g) => g,
                Err(_) => {
                    line.push('?');
                    continue;
                }
            };
            let cell = gr.cell().expect("cell");
            if matches!(
                cell.wide(),
                Ok(CellWide::SpacerTail) | Ok(CellWide::SpacerHead)
            ) {
                continue;
            }
            let mut buf = ['\0'; 32];
            let n = gr.graphemes(&mut buf).unwrap_or(0);
            if n == 0 {
                line.push(' ');
            } else {
                line.extend(buf[..n].iter());
            }
            let st = gr.style().unwrap_or_default();
            let mut a: Vec<String> = Vec::new();
            if st.bold {
                a.push("bold".into());
            }
            if st.faint {
                a.push("dim".into());
            }
            if st.italic {
                a.push("italic".into());
            }
            if st.underline != Underline::None {
                a.push("underline".into());
            }
            if st.inverse {
                a.push("inverse".into());
            }
            if st.invisible {
                a.push("hidden".into());
            }
            if st.strikethrough {
                a.push("strike".into());
            }
            if let Some(f) = color(st.fg_color) {
                a.push(format!("fg={f}"));
            }
            let mut bg = color(st.bg_color);
            match cell.content_tag() {
                Ok(CellContentTag::BgColorPalette) => {
                    bg = cell.bg_color_palette().ok().map(|p| format!("{}", p.0));
                }
                Ok(CellContentTag::BgColorRgb) => {
                    bg = cell
                        .bg_color_rgb()
                        .ok()
                        .map(|c| format!("{}/{}/{}", c.r, c.g, c.b));
                }
                _ => {}
            }
            if let Some(b) = bg {
                a.push(format!("bg={b}"));
            }
            if !a.is_empty() {
                d.styles.push(format!("{r},{c}:{}", a.join(",")));
            }
        }
        d.rows.push(line.trim_end().to_string());
    }
    let m = |mode: Mode| t.mode(mode).unwrap_or(false);
    d.cursor = (t.cursor_y().unwrap_or(0), t.cursor_x().unwrap_or(0));
    d.cursor_visible = t.is_cursor_visible().unwrap_or(true);
    d.alt = matches!(t.active_screen(), Ok(Screen::Alternate));
    d.app_cursor = m(Mode::DECCKM);
    d.app_keypad = m(Mode::KEYPAD_KEYS);
    d.bracketed = m(Mode::BRACKETED_PASTE);
    d.mouse = if m(Mode::ANY_MOUSE) {
        "AnyMotion"
    } else if m(Mode::BUTTON_MOUSE) {
        "ButtonMotion"
    } else if m(Mode::NORMAL_MOUSE) {
        "PressRelease"
    } else if m(Mode::X10_MOUSE) {
        "Press"
    } else {
        "None"
    }
    .to_string();
    d.mouse_enc = if m(Mode::SGR_MOUSE) {
        "Sgr"
    } else if m(Mode::UTF8_MOUSE) {
        "Utf8"
    } else {
        "Default"
    }
    .to_string();
    d.focus = Some(m(Mode::FOCUS_EVENT));
    d.sync = Some(m(Mode::SYNC_OUTPUT));
    d.kitty = t.kitty_keyboard_flags().ok().map(|f| f.bits());
    d.scrollback_len = t.scrollback_rows().unwrap_or(0);
    d
}

fn conformance() {
    let fx = fixtures();
    let mut pass = 0;
    let mut failed: Vec<String> = Vec::new();
    for f in &fx {
        let mut t = new_term(f.cols, f.rows, 100);
        t.vt_write(f.input);
        let d = dump(&t);
        match (f.check)(&d) {
            Ok(()) => {
                pass += 1;
                println!("  PASS  {}", f.name);
            }
            Err(why) => {
                println!("  FAIL  {} ({why})", f.name);
                failed.push(f.name.to_string());
            }
        }
    }
    println!("RESULT ghostty conformance: {pass}/{} fixtures", fx.len());
    for n in &failed {
        println!("RESULT ghostty differs on: {n}");
    }

    // Split at every byte must give the same screen.
    let input = "x\x1b[1;31mred\x1b[0m \x1b[?1002h\x1b[?1006h\x1b[>5u\x1b[?1004h日e\u{301}\x1b[2;3Hz\x1b[?1049hq\x1b[?1049l".as_bytes();
    let mut whole = new_term(20, 5, 100);
    whole.vt_write(input);
    let want = dump(&whole);
    let mut bad = None;
    for i in 1..input.len() {
        let mut e = new_term(20, 5, 100);
        e.vt_write(&input[..i]);
        e.vt_write(&input[i..]);
        if dump(&e) != want {
            bad = Some(i);
            break;
        }
    }
    match bad {
        None => println!("RESULT ghostty split at every byte: identical"),
        Some(i) => println!("RESULT ghostty split at every byte: differs at byte {i}"),
    }

    // Resize of a wrapped line: reflow or truncate.
    let mut t = new_term(10, 4, 100);
    t.vt_write(b"0123456789ABCDE");
    match t.resize(20, 4, 8, 16) {
        Ok(()) => {
            let d = dump(&t);
            println!(
                "RESULT ghostty resize 10->20 on a wrapped line: {:?}",
                &d.rows[..2]
            );
        }
        Err(e) => println!("RESULT ghostty resize error: {e:?}"),
    }
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    println!(
        "engine=libghostty-vt 0.2.2 os={} arch={}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    match mode.as_str() {
        "conf" => conformance(),
        "perf" => {
            let data = synthetic_stream(32 * 1024 * 1024);
            println!("stream_bytes={}", data.len());
            for chunk in [4096usize, 65536] {
                let v = throughput(
                    &data,
                    chunk,
                    || new_term(80, 24, 10_000),
                    |t, c| t.vt_write(c),
                );
                println!(
                    "RESULT ghostty throughput 80x24 {} KiB reads: {:.1} MiB/s",
                    chunk / 1024,
                    v
                );
            }
        }
        "rss-idle" | "rss-fill" => {
            let mut t = new_term(80, 24, 10_000);
            if mode == "rss-fill" {
                for i in 0..SCROLLBACK_LINES_FED {
                    t.vt_write(scrollback_line(i, 80).as_bytes());
                }
                println!("scrollback_lines_held={}", t.scrollback_rows().unwrap_or(0));
            }
            std::hint::black_box(&t);
            if let Some(k) = peak_rss_kib() {
                println!("RESULT ghostty {mode} peak RSS (VmHWM): {k} KiB");
            }
        }
        _ => eprintln!("usage: ghostty conf | perf | rss-idle | rss-fill"),
    }
}
