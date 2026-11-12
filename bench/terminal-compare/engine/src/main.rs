//! Bench binary for `canopy-term-core`'s `Screen::advance`.
//!
//!   terminal-compare-engine dump <dir>        write the shared byte streams
//!   terminal-compare-engine throughput <dir> <out.json>
//!   terminal-compare-engine mem <out.json>    peak RSS after 100k scrollback lines
//!
//! Every engine reads the files `dump` writes, so the bytes are identical by
//! construction. Report only: nothing here asserts on timing.

#[allow(dead_code)]
#[path = "../../../../crates/canopy-term-core/tests/engines/stream.rs"]
mod stream;

use canopy_term_core::Screen;
use std::fmt::Write as _;
use std::time::Instant;

const COLS: u16 = 80;
const ROWS: u16 = 24;
const SCROLLBACK: usize = 10_000;
const STREAM_BYTES: usize = 8 * 1024 * 1024;
const WRITE_SIZES: [usize; 2] = [4 * 1024, 64 * 1024];
const MEM_LINES: usize = 100_000;
const RUNS: usize = 3;

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

const WORDS: &[&str] = &[
    "lorem",
    "ipsum",
    "dolor",
    "sit",
    "amet",
    "consectetur",
    "adipiscing",
    "elit",
    "sed",
    "do",
    "eiusmod",
    "tempor",
    "incididunt",
    "ut",
    "labore",
];

fn ascii_stream(min: usize) -> Vec<u8> {
    let mut rng = Lcg(1);
    let mut out = Vec::with_capacity(min + 256);
    let mut n = 0u64;
    while out.len() < min {
        let mut line = format!("{n:07} ");
        while line.len() < 70 {
            line.push_str(WORDS[rng.below(WORDS.len() as u64) as usize]);
            line.push(' ');
        }
        line.truncate(78);
        out.extend_from_slice(line.as_bytes());
        out.extend_from_slice(b"\r\n");
        n += 1;
    }
    out
}

fn sgr_stream(min: usize) -> Vec<u8> {
    let mut rng = Lcg(2);
    let mut out = Vec::with_capacity(min + 256);
    while out.len() < min {
        let mut width = 0;
        while width < 60 {
            let seq = match rng.below(4) {
                0 => format!("\x1b[{}m", 31 + rng.below(7)),
                1 => format!("\x1b[1;{};{}m", 31 + rng.below(7), 41 + rng.below(7)),
                2 => format!("\x1b[38;5;{}m", rng.below(256)),
                _ => format!(
                    "\x1b[38;2;{};{};{}m\x1b[48;2;{};{};{}m",
                    rng.below(256),
                    rng.below(256),
                    rng.below(256),
                    rng.below(64),
                    rng.below(64),
                    rng.below(64)
                ),
            };
            let word = WORDS[rng.below(WORDS.len() as u64) as usize];
            out.extend_from_slice(seq.as_bytes());
            out.extend_from_slice(word.as_bytes());
            out.push(b' ');
            width += word.len() + 1;
        }
        out.extend_from_slice(b"\x1b[0m\r\n");
    }
    out
}

/// Full-screen repaint loop: home, then every row addressed with CUP, rewritten
/// and cleared to end of line. Frame number changes the content.
fn repaint_stream(min: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(min + 4096);
    let mut frame = 0u64;
    out.extend_from_slice(b"\x1b[?25l\x1b[2J");
    while out.len() < min {
        out.extend_from_slice(b"\x1b[H");
        for r in 1..=ROWS {
            let text = format!(
                "frame {frame:06} row {r:02} {}",
                WORDS[((frame + r as u64) % WORDS.len() as u64) as usize]
            );
            let colour = 31 + (frame + r as u64) % 7;
            let _ = write!(
                out_str(&mut out),
                "\x1b[{r};1H\x1b[{colour}m{text}\x1b[0m\x1b[K"
            );
        }
        frame += 1;
    }
    out
}

/// Tiny adapter so `write!` can append to a Vec<u8>.
fn out_str(v: &mut Vec<u8>) -> impl std::fmt::Write + '_ {
    struct W<'a>(&'a mut Vec<u8>);
    impl std::fmt::Write for W<'_> {
        fn write_str(&mut self, s: &str) -> std::fmt::Result {
            self.0.extend_from_slice(s.as_bytes());
            Ok(())
        }
    }
    W(v)
}

fn wide_stream(min: usize) -> Vec<u8> {
    const CJK: &[&str] = &["日本語", "終端", "文字", "表示", "テスト", "한국어", "中文"];
    const EMOJI: &[&str] = &["😀", "🚀", "🔥", "✅", "🎉", "🧪", "📦", "👩‍💻", "🇯🇵"];
    let mut rng = Lcg(4);
    let mut out = Vec::with_capacity(min + 256);
    while out.len() < min {
        for _ in 0..(4 + rng.below(6)) {
            match rng.below(3) {
                0 => out.extend_from_slice(CJK[rng.below(CJK.len() as u64) as usize].as_bytes()),
                1 => {
                    out.extend_from_slice(EMOJI[rng.below(EMOJI.len() as u64) as usize].as_bytes())
                }
                _ => {
                    out.extend_from_slice(WORDS[rng.below(WORDS.len() as u64) as usize].as_bytes())
                }
            }
            out.push(b' ');
        }
        out.extend_from_slice(b"\r\n");
    }
    out
}

fn streams() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        ("mixed", stream::synthetic_stream(STREAM_BYTES)),
        ("ascii", ascii_stream(STREAM_BYTES)),
        ("sgr", sgr_stream(STREAM_BYTES)),
        ("repaint", repaint_stream(STREAM_BYTES)),
        ("wide", wide_stream(STREAM_BYTES)),
    ]
}

/// Peak resident set size of this process, in bytes.
fn peak_rss() -> u64 {
    let mut u: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut u) };
    let v = u.ru_maxrss as u64;
    // Linux reports KiB, macOS bytes.
    if cfg!(target_os = "macos") {
        v
    } else {
        v * 1024
    }
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("dump") => {
            let dir = std::path::Path::new(&args[2]);
            std::fs::create_dir_all(dir).unwrap();
            for (name, data) in streams() {
                std::fs::write(dir.join(format!("{name}.bin")), &data).unwrap();
                println!("{name}.bin {} bytes", data.len());
            }
        }
        Some("throughput") => {
            let dir = std::path::Path::new(&args[2]);
            let mut rows = Vec::new();
            for name in ["mixed", "ascii", "sgr", "repaint", "wide"] {
                let data = std::fs::read(dir.join(format!("{name}.bin"))).unwrap();
                let mib = data.len() as f64 / (1024.0 * 1024.0);
                for write in WRITE_SIZES {
                    // One untimed pass to warm caches and the allocator.
                    let mut s = Screen::with_scrollback(COLS, ROWS, SCROLLBACK);
                    for c in data[..data.len().min(1 << 20)].chunks(write) {
                        s.advance(c);
                    }
                    let mut rates = Vec::new();
                    for _ in 0..RUNS {
                        let mut s = Screen::with_scrollback(COLS, ROWS, SCROLLBACK);
                        let t = Instant::now();
                        for c in data.chunks(write) {
                            s.advance(c);
                        }
                        rates.push(mib / t.elapsed().as_secs_f64());
                    }
                    let m = median(rates);
                    eprintln!("ours {name} {write}: {m:.1} MiB/s");
                    rows.push(format!(
                        "{{\"stream\":\"{name}\",\"write\":{write},\"bytes\":{},\"mibs\":{m:.3}}}",
                        data.len()
                    ));
                }
            }
            let json = format!("{{\"engine\":\"ours\",\"rows\":[{}]}}\n", rows.join(","));
            std::fs::write(&args[3], json).unwrap();
        }
        Some("mem") => {
            let baseline = peak_rss();
            let mut s = Screen::with_scrollback(COLS, ROWS, MEM_LINES);
            let pad = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod";
            let mut buf = Vec::with_capacity(64 * 1024);
            for i in 0..MEM_LINES + ROWS as usize {
                buf.extend_from_slice(format!("{i:06} {pad}\r\n").as_bytes());
                if buf.len() > 60 * 1024 {
                    s.advance(&buf);
                    buf.clear();
                }
            }
            s.advance(&buf);
            let held = s.scrollback_len();
            let peak = peak_rss();
            let mib = |b: u64| b as f64 / (1024.0 * 1024.0);
            eprintln!(
                "ours mem: baseline {:.1} MiB, peak {:.1} MiB, {held} scrollback lines",
                mib(baseline),
                mib(peak)
            );
            let json = format!(
                "{{\"engine\":\"ours\",\"lines_held\":{held},\"baseline_mib\":{:.2},\"peak_mib\":{:.2}}}\n",
                mib(baseline),
                mib(peak)
            );
            std::fs::write(&args[2], json).unwrap();
        }
        _ => {
            eprintln!("usage: terminal-compare-engine dump <dir> | throughput <dir> <out.json> | mem <out.json>");
            std::process::exit(2);
        }
    }
}
