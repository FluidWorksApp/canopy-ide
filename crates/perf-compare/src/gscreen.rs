//! Measurement only. `GhosttyScreen` (canopy-term-core, feature `ghostty`) on
//! the same stream, grid and read sizes as `ours` (old `Screen::advance`) and
//! the spike's bare `vt_write`.
//!
//! `GhosttyScreen::advance` may only queue bytes to the engine thread, so the
//! timed region always ends at a call that proves the frame is observable:
//!
//! * `gs_end`: `advance` for every read, then ONE `seq()` after the last one.
//!   `seq()` runs on the engine thread behind everything queued, and (whatever
//!   the frame policy) returns the sequence number of an up-to-date frame, so
//!   the clock stops when the engine has parsed every byte and the frame for
//!   the final state exists. A renderer that reads only now and then.
//! * `gs_read_seq`: `advance` then `seq()` after EVERY read. Parse and frame
//!   state are forced to be consistent per read; no Frame is copied out.
//! * `gs_read_frame`: `advance` then `frame()` (a Frame clone) after every
//!   read: a consumer that wants the full frame each time.
//!
//! Usage: `gscreen perf | rss-idle | rss-fill | profile <MiB> end|read|bare`.

#[path = "stream.rs"]
mod stream;

use canopy_term_core::Screen as GhosttyScreen;
use std::time::Instant;
use stream::synthetic_stream;

const MIB: f64 = 1024.0 * 1024.0;
const SCROLLBACK_LINES_FED: usize = 12_000;

#[derive(Clone, Copy)]
enum Mode {
    End,
    ReadSeq,
    ReadFrame,
}

fn peak_rss_kib() -> Option<u64> {
    let s = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = s.lines().find(|l| l.starts_with("VmHWM:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}

fn scrollback_line(i: usize, cols: usize) -> String {
    let word = "lorem ipsum dolor sit amet ";
    let mut line = String::new();
    while line.len() < cols - 7 {
        line.push_str(word);
    }
    line.truncate(cols - 7);
    format!("{i:05} {line}\r\n")
}

fn run(s: &mut GhosttyScreen, data: &[u8], chunk: usize, mode: Mode) {
    for c in data.chunks(chunk) {
        s.advance(c);
        match mode {
            Mode::End => {}
            Mode::ReadSeq => {
                std::hint::black_box(s.seq());
            }
            Mode::ReadFrame => {
                std::hint::black_box(s.frame());
            }
        }
    }
    std::hint::black_box(s.seq());
}

/// Same method as `ours`: a warm-up pass over the first 8 MiB on its own
/// engine, then one timed pass over everything on a fresh engine. The clock
/// starts after the engine (and its thread) exist and stops after the final
/// `seq()` returned.
fn throughput(data: &[u8], chunk: usize, mode: Mode) -> f64 {
    let mut warm = GhosttyScreen::with_scrollback(80, 24, 10_000);
    run(&mut warm, &data[..8 * 1024 * 1024], chunk, mode);
    drop(warm);
    let mut s = GhosttyScreen::with_scrollback(80, 24, 10_000);
    let start = Instant::now();
    run(&mut s, data, chunk, mode);
    let secs = start.elapsed().as_secs_f64();
    drop(s);
    data.len() as f64 / MIB / secs
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    println!(
        "engine=gscreen os={} arch={}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    match mode.as_str() {
        "perf" => {
            let data = synthetic_stream(32 * 1024 * 1024);
            println!("stream_bytes={}", data.len());
            for chunk in [4096usize, 65536] {
                for (name, m) in [
                    ("gs_end", Mode::End),
                    ("gs_read_seq", Mode::ReadSeq),
                    ("gs_read_frame", Mode::ReadFrame),
                ] {
                    println!(
                        "RESULT {name} throughput 80x24 {} KiB reads: {:.1} MiB/s",
                        chunk / 1024,
                        throughput(&data, chunk, m)
                    );
                }
            }
        }
        // One pass, for a profiler: no warm-up, no timing.
        "profile" => {
            let mib: usize = std::env::args()
                .nth(2)
                .and_then(|a| a.parse().ok())
                .unwrap_or(4);
            let how = std::env::args().nth(3).unwrap_or_else(|| "end".into());
            let data = synthetic_stream(mib * 1024 * 1024);
            match how.as_str() {
                "bare" => {
                    use libghostty_vt::{Terminal, TerminalOptions};
                    let mut t = Terminal::new(TerminalOptions {
                        cols: 80,
                        rows: 24,
                        max_scrollback: 10_000 * (160 * 12 + 256),
                    })
                    .expect("Terminal::new");
                    for c in data.chunks(4096) {
                        t.vt_write(c);
                    }
                    std::hint::black_box(&t);
                }
                other => {
                    let m = if other == "read" {
                        Mode::ReadSeq
                    } else {
                        Mode::End
                    };
                    let mut s = GhosttyScreen::with_scrollback(80, 24, 10_000);
                    run(&mut s, &data, 4096, m);
                }
            }
            println!("profiled {} bytes ({how})", data.len());
        }
        "rss-idle" | "rss-fill" => {
            let mut s = GhosttyScreen::with_scrollback(80, 24, 10_000);
            if mode == "rss-fill" {
                for i in 0..SCROLLBACK_LINES_FED {
                    s.advance(scrollback_line(i, 80).as_bytes());
                }
            }
            // Barrier: every queued byte parsed and the frame built.
            std::hint::black_box(s.seq());
            if mode == "rss-fill" {
                println!("scrollback_lines_held={}", s.scrollback_len());
            }
            if let Some(k) = peak_rss_kib() {
                println!("RESULT gscreen {mode} peak RSS (VmHWM): {k} KiB");
            }
        }
        _ => eprintln!("usage: gscreen perf | rss-idle | rss-fill | profile <MiB> end|read|bare"),
    }
}
