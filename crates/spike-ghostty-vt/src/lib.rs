//! Shared helpers for the spike binaries. Throwaway; never merge.

pub mod conformance;
pub mod stream;

use std::time::Instant;

pub const MIB: f64 = 1024.0 * 1024.0;

/// Peak resident set (VmHWM) in KiB. Linux only; on macOS the workflow wraps the
/// process in `/usr/bin/time -l` instead.
pub fn peak_rss_kib() -> Option<u64> {
    let s = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = s.lines().find(|l| l.starts_with("VmHWM:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}

/// One line that fills exactly `cols - 1` cells, so it never wraps. Same shape as
/// canopy-term-core tests/perf.rs `fill_scrollback`.
pub fn scrollback_line(i: usize, cols: usize) -> String {
    let word = "lorem ipsum dolor sit amet ";
    let mut line = String::new();
    while line.len() < cols - 7 {
        line.push_str(word);
    }
    line.truncate(cols - 7);
    format!("{i:05} {line}\r\n")
}

pub const SCROLLBACK_LINES_FED: usize = 12_000;

/// MiB/s for `data` fed in `chunk`-byte reads to a fresh engine. A warm-up pass
/// over the first 8 MiB runs on its own engine first.
pub fn throughput<T>(
    data: &[u8],
    chunk: usize,
    new: impl Fn() -> T,
    mut feed: impl FnMut(&mut T, &[u8]),
) -> f64 {
    let mut warm = new();
    for c in data[..8 * 1024 * 1024].chunks(chunk) {
        feed(&mut warm, c);
    }
    drop(warm);
    let mut e = new();
    let start = Instant::now();
    for c in data.chunks(chunk) {
        feed(&mut e, c);
    }
    let secs = start.elapsed().as_secs_f64();
    std::hint::black_box(&e);
    data.len() as f64 / MIB / secs
}
