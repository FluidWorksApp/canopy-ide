//! The current engine (`canopy_term_core::Screen`) on the same stream and the
//! same reads as the ghostty bin. Usage: `current perf | rss-idle | rss-fill`.

use canopy_term_core::Screen;
use spike_ghostty_vt::{
    peak_rss_kib, scrollback_line, stream::synthetic_stream, throughput, SCROLLBACK_LINES_FED,
};

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    println!(
        "engine=current os={} arch={}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    match mode.as_str() {
        "perf" => {
            let data = synthetic_stream(32 * 1024 * 1024);
            println!("stream_bytes={}", data.len());
            for chunk in [4096usize, 65536] {
                let v = throughput(
                    &data,
                    chunk,
                    || Screen::with_scrollback(80, 24, 10_000),
                    |s, c| s.advance(c),
                );
                println!(
                    "RESULT current throughput 80x24 {} KiB reads: {:.1} MiB/s",
                    chunk / 1024,
                    v
                );
            }
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
                println!("RESULT current {mode} peak RSS (VmHWM): {k} KiB");
            }
        }
        _ => eprintln!("usage: current perf | rss-idle | rss-fill"),
    }
}
