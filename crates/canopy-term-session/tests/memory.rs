//! 10 MB of output through a session: memory stays bounded and does not grow
//! with the amount of output, and every byte is parsed.
//!
//! Its own test binary with no harness (one function, run from `main`): the
//! counting allocator sees every thread in the process, and the numbers it
//! prints reach the CI log.

use std::alloc::{GlobalAlloc, Layout, System};
use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use canopy_term_session::frame::{Attrs, Frame};
use canopy_term_session::{FrameSource, LinkRead, Session, SessionConfig, SessionLink};

struct Counting;

static CURRENT: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn grew(by: usize) {
    let now = CURRENT.fetch_add(by, Ordering::Relaxed) + by;
    PEAK.fetch_max(now, Ordering::Relaxed);
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc(layout);
        if !p.is_null() {
            grew(layout.size());
        }
        p
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc_zeroed(layout);
        if !p.is_null() {
            grew(layout.size());
        }
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
        CURRENT.fetch_sub(layout.size(), Ordering::Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = System.realloc(ptr, layout, new_size);
        if !p.is_null() {
            if new_size >= layout.size() {
                grew(new_size - layout.size());
            } else {
                CURRENT.fetch_sub(layout.size() - new_size, Ordering::Relaxed);
            }
        }
        p
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// 78 visible characters and CRLF: one line per 80 columns, never wrapped.
const LINE: &[u8] =
    b"the quick brown fox jumps over the lazy dog 0123456789 abcdefghijklmnopqrstuvw\r\n";

/// A program that writes `left` bytes of lines as fast as it is read, then
/// exits. Generated on demand so the test's own input is not counted.
struct Firehose {
    left: usize,
    pos: usize,
}

impl SessionLink for Firehose {
    fn try_read(&mut self, buf: &mut [u8]) -> io::Result<LinkRead> {
        if self.left == 0 {
            return Ok(LinkRead::Closed);
        }
        let n = buf.len().min(self.left);
        for b in &mut buf[..n] {
            *b = LINE[self.pos];
            self.pos = (self.pos + 1) % LINE.len();
        }
        self.left -= n;
        Ok(LinkRead::Data(n))
    }

    fn try_write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        Ok(bytes.len())
    }

    fn resize(&mut self, _cols: u16, _rows: u16) -> io::Result<()> {
        Ok(())
    }

    fn close(&mut self) {}
}

fn row_text(f: &Frame, row: u16) -> String {
    let mut s = String::new();
    for col in 0..f.cols {
        let cell = f.cell(row, col).expect("cell in range");
        if !cell.attrs.has(Attrs::WIDE_TAIL) {
            s.push_str(&f.text(cell));
        }
    }
    s.trim_end().to_string()
}

const MIB: usize = 1024 * 1024;

fn main() {
    ten_megabytes_stay_within_a_memory_bound_and_finish();
    eprintln!("memory: ok");
}

fn ten_megabytes_stay_within_a_memory_bound_and_finish() {
    const TOTAL: usize = 10 * MIB;
    const WARM: u64 = 2 * MIB as u64;
    assert_eq!(LINE.len(), 80);
    let config = SessionConfig {
        cols: 80,
        rows: 24,
        scrollback: 1000,
        ..SessionConfig::default()
    };
    let budget = config.tick_budget;

    let base = CURRENT.load(Ordering::Relaxed);
    PEAK.store(base, Ordering::Relaxed);
    let started = Instant::now();
    let mut s = Session::new(
        Firehose {
            left: TOTAL,
            pos: 0,
        },
        config,
    );
    let t = Instant::now();
    let mut seq = 0;
    let mut ticks = 0usize;
    let mut last = None;

    // Warm up: past 2 MB (26,000 lines) the 1,000-line scrollback is full and
    // every buffer has reached its working size.
    while s.stats().live_bytes < WARM {
        if let Some(f) = s.frame_since_at(seq, t) {
            seq = f.seq;
        }
        ticks += 1;
        assert!(ticks < 100_000);
    }
    let warm_peak = PEAK.load(Ordering::Relaxed).saturating_sub(base);

    // The other 8 MB.
    PEAK.store(CURRENT.load(Ordering::Relaxed), Ordering::Relaxed);
    while !s.closed() {
        if let Some(f) = s.frame_since_at(seq, t) {
            seq = f.seq;
            last = Some(f);
        }
        ticks += 1;
        assert!(ticks < 100_000);
    }
    if let Some(f) = s.frame_since_at(seq, t) {
        last = Some(f);
    }
    let peak = PEAK.load(Ordering::Relaxed).saturating_sub(base);
    let elapsed = started.elapsed();

    eprintln!(
        "10 MB: {ticks} ticks, {} advances, {} frames, peak {} KiB after warm-up \
         {} KiB, {elapsed:?}",
        s.stats().advances,
        s.stats().frames,
        peak / 1024,
        warm_peak / 1024
    );

    assert_eq!(s.stats().live_bytes, TOTAL as u64, "every byte parsed");
    // Coalesced: about one emulator pass per budget, not per read.
    assert!(
        s.stats().advances as usize <= TOTAL / budget + 2,
        "{} advances",
        s.stats().advances
    );
    assert!(ticks <= 2 * (TOTAL / budget) + 4, "{ticks} ticks");
    // Bounded: a fixed ceiling, and no growth from 2 MB to 10 MB.
    assert!(peak < 64 * MIB, "peak {peak} bytes");
    assert!(
        peak <= warm_peak + MIB,
        "grew with output: {warm_peak} -> {peak} bytes"
    );

    // The last line written is on screen, above the empty cursor row.
    let f = last.expect("frames were published");
    assert_eq!(row_text(&f, 22).as_bytes(), &LINE[..78]);
    assert_eq!(row_text(&f, 23), "");
}
