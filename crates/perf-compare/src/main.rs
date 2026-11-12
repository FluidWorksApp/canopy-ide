//! Measurement only. `Screen::advance` on the same stream, grid and read sizes
//! as `spike-ghostty-vt`'s `ghostty perf` (branch spike/libghostty-vt), which
//! times the bare `vt_write`. Usage: `ours perf | rss-idle | rss-fill | profile <MiB>`.

mod stream;

use canopy_term_core::Screen;
use std::time::Instant;
use stream::synthetic_stream;

const MIB: f64 = 1024.0 * 1024.0;
const SCROLLBACK_LINES_FED: usize = 12_000;

fn peak_rss_kib() -> Option<u64> {
    let s = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = s.lines().find(|l| l.starts_with("VmHWM:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}

/// Same line as the spike's `scrollback_line`: exactly `cols - 1` cells.
fn scrollback_line(i: usize, cols: usize) -> String {
    let word = "lorem ipsum dolor sit amet ";
    let mut line = String::new();
    while line.len() < cols - 7 {
        line.push_str(word);
    }
    line.truncate(cols - 7);
    format!("{i:05} {line}\r\n")
}

/// Same method as the spike's `throughput`: a warm-up pass over the first 8 MiB
/// on its own engine, then one timed pass over everything on a fresh engine.
fn throughput(data: &[u8], chunk: usize) -> f64 {
    let mut warm = Screen::with_scrollback(80, 24, 10_000);
    for c in data[..8 * 1024 * 1024].chunks(chunk) {
        warm.advance(c);
    }
    drop(warm);
    let mut s = Screen::with_scrollback(80, 24, 10_000);
    let start = Instant::now();
    for c in data.chunks(chunk) {
        s.advance(c);
    }
    let secs = start.elapsed().as_secs_f64();
    std::hint::black_box(&s);
    data.len() as f64 / MIB / secs
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    println!(
        "engine=ours os={} arch={}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    match mode.as_str() {
        "perf" => {
            let data = synthetic_stream(32 * 1024 * 1024);
            println!("stream_bytes={}", data.len());
            for chunk in [4096usize, 65536] {
                println!(
                    "RESULT ours throughput 80x24 {} KiB reads: {:.1} MiB/s",
                    chunk / 1024,
                    throughput(&data, chunk)
                );
            }
        }
        // One pass, for a profiler: no warm-up, no timing.
        "profile" => {
            let mib: usize = std::env::args()
                .nth(2)
                .and_then(|a| a.parse().ok())
                .unwrap_or(4);
            let data = synthetic_stream(mib * 1024 * 1024);
            let mut s = Screen::with_scrollback(80, 24, 10_000);
            for c in data.chunks(4096) {
                s.advance(c);
            }
            std::hint::black_box(&s);
            println!("profiled {} bytes", data.len());
        }
        "rss-idle" | "rss-fill" => {
            let mut s = Screen::with_scrollback(80, 24, 10_000);
            if mode == "rss-fill" {
                for i in 0..SCROLLBACK_LINES_FED {
                    s.advance(scrollback_line(i, 80).as_bytes());
                }
                println!("scrollback_lines_held={}", s.scrollback_len());
            }
            std::hint::black_box(&s);
            if let Some(k) = peak_rss_kib() {
                println!("RESULT ours {mode} peak RSS (VmHWM): {k} KiB");
            }
        }
        _ => eprintln!("usage: ours perf | rss-idle | rss-fill | profile <MiB>"),
    }
}
