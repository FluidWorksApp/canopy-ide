//! Report-only performance numbers for `Screen`: parse throughput, memory per
//! session, per-frame cost. Printed to the CI log as markdown table rows and
//! copied into PERF.md. Nothing here asserts on timing.
//!
//! `harness = false`: libtest would capture the output of a passing test, and
//! would run other tests in parallel and skew the timings.

mod engines;

use canopy_term_core::Screen;
use engines::stream::synthetic_stream;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

/// Counts live heap bytes so memory per session can be measured without a
/// dependency and on every OS.
struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            LIVE.fetch_add(l.size(), Ordering::Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        System.dealloc(p, l);
        LIVE.fetch_sub(l.size(), Ordering::Relaxed);
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        let p = System.alloc_zeroed(l);
        if !p.is_null() {
            LIVE.fetch_add(l.size(), Ordering::Relaxed);
        }
        p
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        let q = System.realloc(p, l, new);
        if !q.is_null() {
            LIVE.fetch_sub(l.size(), Ordering::Relaxed);
            LIVE.fetch_add(new, Ordering::Relaxed);
        }
        q
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

fn live() -> usize {
    LIVE.load(Ordering::Relaxed)
}

fn kib(bytes: usize) -> String {
    format!("{:.0} KiB", bytes as f64 / 1024.0)
}

fn row(metric: &str, value: String) {
    println!("| {metric} | {value} |");
}

/// Feed lines until the scrollback is full, then some more. Returns the
/// scrollback length actually reached.
fn fill_scrollback(s: &mut Screen, cols: u16) -> usize {
    let word = "lorem ipsum dolor sit amet ";
    let mut line = String::new();
    while line.len() < cols as usize - 2 {
        line.push_str(word);
    }
    line.truncate(cols as usize - 2);
    for i in 0..12_000 {
        s.advance(format!("{i:05} {line}\r\n").as_bytes());
    }
    s.scrollback_len()
}

fn main() {
    println!(
        "profile: dev, opt-level=3, dependency debug-assertions off; os={} arch={}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    println!("PERF-TABLE-BEGIN");
    println!("| metric | value |");
    println!("| --- | --- |");

    // Memory per session.
    for (cols, rows) in [(80u16, 24u16), (200, 50)] {
        let before = live();
        let mut s = Screen::with_scrollback(cols, rows, 10_000);
        let idle = live() - before;
        row(
            &format!("idle session {cols}x{rows}, 10k scrollback allowed, empty"),
            kib(idle),
        );
        let reached = fill_scrollback(&mut s, cols);
        let full = live() - before;
        row(
            &format!("{cols}x{rows} with scrollback filled ({reached} lines held)"),
            kib(full),
        );
        if reached > 0 {
            row(
                &format!("{cols}x{rows} per scrollback line"),
                format!("{} B", (full - idle) / reached),
            );
        }
        drop(s);
    }

    // Parse throughput on a large synthetic mixed stream, in 4 KiB reads.
    let data = synthetic_stream(32 * 1024 * 1024);
    let mib = data.len() as f64 / (1024.0 * 1024.0);
    for (cols, rows) in [(80u16, 24u16), (200, 50)] {
        let mut s = Screen::with_scrollback(cols, rows, 10_000);
        let start = Instant::now();
        for chunk in data.chunks(4096) {
            s.advance(chunk);
        }
        let secs = start.elapsed().as_secs_f64();
        row(
            &format!("parse throughput {cols}x{rows} (Screen::advance, 4 KiB reads, {mib:.0} MiB mixed stream)"),
            format!("{:.1} MiB/s", mib / secs),
        );
    }
    // Big reads amortise the per-call frame rebuild.
    {
        let mut s = Screen::with_scrollback(80, 24, 10_000);
        let start = Instant::now();
        for chunk in data.chunks(256 * 1024) {
            s.advance(chunk);
        }
        let secs = start.elapsed().as_secs_f64();
        row(
            "parse throughput 80x24 (256 KiB reads)",
            format!("{:.1} MiB/s", mib / secs),
        );
    }

    // Per-frame cost on a warm screen: one small update, then reading it out.
    for (cols, rows) in [(80u16, 24u16), (200, 50)] {
        let mut s = Screen::with_scrollback(cols, rows, 10_000);
        s.advance(&data[..1024 * 1024]);
        let n = 2_000u32;
        let start = Instant::now();
        for i in 0..n {
            s.advance(format!("\x1b[{};1Hprogress {}%", 1 + i % rows as u32, i % 100).as_bytes());
        }
        let advance_us = start.elapsed().as_secs_f64() * 1e6 / n as f64;
        row(
            &format!("{cols}x{rows} advance with one-line update (includes frame rebuild + diff)"),
            format!("{advance_us:.1} us"),
        );

        let start = Instant::now();
        let mut cells = 0usize;
        for _ in 0..n {
            cells += s.frame().cells.len();
        }
        let frame_us = start.elapsed().as_secs_f64() * 1e6 / n as f64;
        row(
            &format!("{cols}x{rows} frame() clone ({} cells)", cells / n as usize),
            format!("{frame_us:.1} us"),
        );

        let start = Instant::now();
        let mut snap_len = 0usize;
        for _ in 0..n {
            snap_len = s.snapshot().len();
        }
        let snap_us = start.elapsed().as_secs_f64() * 1e6 / n as f64;
        row(
            &format!("{cols}x{rows} snapshot() ({snap_len} bytes)"),
            format!("{snap_us:.1} us"),
        );

        let since = s.seq();
        s.advance(b"\x1b[2;1Hx");
        let start = Instant::now();
        let mut rows_damaged = 0usize;
        for _ in 0..n {
            rows_damaged += s.damage_since(since).rows.len();
        }
        let damage_us = start.elapsed().as_secs_f64() * 1e6 / n as f64;
        row(
            &format!(
                "{cols}x{rows} damage_since() ({} damaged rows)",
                rows_damaged / n as usize
            ),
            format!("{damage_us:.2} us"),
        );
    }
    println!("PERF-TABLE-END");
}
