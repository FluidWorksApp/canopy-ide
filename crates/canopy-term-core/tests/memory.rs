//! Report-only peak memory (resident set) of `Screen` with 10k scrollback
//! lines at 80 columns, idle and filled, in the same shape as the
//! libghostty-vt spike measured it (one process per measurement, process peak
//! RSS, so the runtime is included). Printed to the CI log; nothing asserts on
//! the numbers except that the filled screen really holds the lines.
//!
//! `harness = false` so the output reaches the CI log. With no argument this
//! binary starts itself once per scenario and reports the child's peak; with
//! `idle` or `filled` it is that child.
//!
//! Peak RSS: `VmHWM` from `/proc/self/status` on Linux, `/usr/bin/time -l`
//! around the child on macOS (no libc dependency). Windows prints `n/a`.

use canopy_term_core::Screen;
use std::process::Command;

const COLS: u16 = 80;
const ROWS: u16 = 24;
const SCROLLBACK: usize = 10_000;
/// A little past the cap so the scrollback is full, as the spike's was.
const LINES: usize = 10_030;

/// Same text as `tests/perf.rs`: one row per line, never wrapping.
fn line(i: usize) -> String {
    let word = "lorem ipsum dolor sit amet ";
    let mut text = String::new();
    while text.len() < COLS as usize - 7 {
        text.push_str(word);
    }
    text.truncate(COLS as usize - 7);
    format!("{i:05} {text}\r\n")
}

fn child(mode: &str) {
    let mut s = Screen::with_scrollback(COLS, ROWS, SCROLLBACK);
    if mode == "filled" {
        for i in 0..LINES {
            s.advance(line(i).as_bytes());
        }
    }
    // Keep the screen alive to here so nothing is optimised away.
    println!("held={}", s.scrollback_len());
    #[cfg(target_os = "linux")]
    {
        let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
        for l in status.lines() {
            if l.starts_with("VmHWM:") || l.starts_with("VmRSS:") {
                println!("{}", l.split_whitespace().collect::<Vec<_>>().join(" "));
            }
        }
    }
}

/// Run one scenario in a fresh process. Returns (peak KiB, lines held).
fn measure(mode: &str) -> (Option<u64>, String) {
    let exe = std::env::current_exe().expect("current exe");
    #[cfg(target_os = "macos")]
    let out = Command::new("/usr/bin/time")
        .arg("-l")
        .arg(&exe)
        .arg(mode)
        .output()
        .expect("run child");
    #[cfg(not(target_os = "macos"))]
    let out = Command::new(&exe).arg(mode).output().expect("run child");
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let held = stdout
        .lines()
        .find_map(|l| l.strip_prefix("held="))
        .unwrap_or("?")
        .to_string();
    let mut peak = None;
    #[cfg(target_os = "linux")]
    for l in stdout.lines() {
        if let Some(rest) = l.strip_prefix("VmHWM: ") {
            peak = rest.split_whitespace().next().and_then(|v| v.parse().ok());
        }
    }
    #[cfg(target_os = "macos")]
    for l in stderr.lines() {
        // "  12345678  maximum resident set size" (bytes)
        if l.contains("maximum resident set size") {
            peak = l
                .split_whitespace()
                .next()
                .and_then(|v| v.parse::<u64>().ok())
                .map(|b| b / 1024);
        }
    }
    let _ = &stderr;
    (peak, held)
}

fn main() {
    if let Some(mode) = std::env::args().nth(1).filter(|a| a == "idle" || a == "filled") {
        child(&mode);
        return;
    }
    println!(
        "os={} arch={}; {COLS} cols, {ROWS} rows, scrollback {SCROLLBACK}, {LINES} lines fed",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    println!("MEMORY-TABLE-BEGIN");
    println!("| scenario | peak RSS | scrollback lines held |");
    println!("| --- | --- | --- |");
    let mut filled_held = String::new();
    for mode in ["idle", "filled"] {
        let (peak, held) = measure(mode);
        let peak = peak.map_or("n/a".to_string(), |k| format!("{k} KiB"));
        println!("| {mode} | {peak} | {held} |");
        if mode == "filled" {
            filled_held = held;
        }
    }
    println!("MEMORY-TABLE-END");
    assert_eq!(
        filled_held,
        SCROLLBACK.to_string(),
        "the filled screen must hold a full scrollback"
    );
}
