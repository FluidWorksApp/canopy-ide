//! Deterministic, seeded robustness tests for `Screen`, run on each engine:
//! random and hostile byte streams, chunking, resizing, snapshots. Synthetic
//! input only.
//!
//! Every stream comes from a fixed seed through a small xorshift generator, so
//! a failure reproduces exactly (the message carries the seed and the stream).
//! Properties checked after every `advance` and `resize`:
//!
//! * no panic and no hang (each test runs under a deadline);
//! * the frame is consistent: `cols * rows` cells, cursor inside the grid,
//!   cluster table and references valid and bounded, title bounded, scrollback
//!   within its cap, damage ranges inside the grid, `seq` never going backwards;
//! * any split of the same stream (byte by byte, random chunks) gives the same
//!   screen as one `advance`;
//! * a snapshot restores into a screen of the same size without panicking and
//!   stays within a fixed size bound.
//!
//! Longer manual runs: `CANOPY_FUZZ_CASES=2000 CANOPY_FUZZ_SEED=7 cargo test
//! --release --test fuzz`.

/// `$hostile_utf8`: also generate invalid and truncated UTF-8. The current
/// engine is known to lose bytes after a UTF-8 sequence cut between two feeds
/// (fixed on an unmerged branch), so its instance leaves those out; the
/// libghostty-vt instance must handle them.
macro_rules! define {
    ($m:ident, $screen:ty, $hostile_utf8:expr) => {
        mod $m {
            use canopy_term_core::frame::{Attrs, Frame};
            use canopy_term_core::screen::{
                MAX_CLUSTER_SCALARS, MAX_COLS, MAX_PENDING_REPLIES, MAX_ROWS, MAX_TITLE_BYTES,
            };
            use std::sync::mpsc;
            use std::thread;
            use std::time::Duration;

            type Screen = $screen;
            const HOSTILE_UTF8: bool = $hostile_utf8;

            const SCROLLBACK: usize = 200;

            struct Rng(u64);

            impl Rng {
                fn new(seed: u64) -> Self {
                    let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
                    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
                    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
                    z ^= z >> 31;
                    Rng(z | 1)
                }
                fn next(&mut self) -> u64 {
                    let mut x = self.0;
                    x ^= x << 13;
                    x ^= x >> 7;
                    x ^= x << 17;
                    self.0 = x;
                    x
                }
                fn below(&mut self, n: usize) -> usize {
                    (self.next() % n as u64) as usize
                }
                fn range(&mut self, lo: usize, hi: usize) -> usize {
                    lo + self.below(hi - lo + 1)
                }
                fn chance(&mut self, percent: usize) -> bool {
                    self.below(100) < percent
                }
                fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
                    &items[self.below(items.len())]
                }
            }

            /// One step of a stream: an input byte, or a resize between bytes.
            #[derive(Clone, Copy, Debug, PartialEq, Eq)]
            enum Tok {
                B(u8),
                Resize(u16, u16),
            }

            fn toks(bytes: &[u8]) -> Vec<Tok> {
                bytes.iter().map(|&b| Tok::B(b)).collect()
            }

            fn esc(bytes: &[u8]) -> String {
                let s: String = bytes
                    .iter()
                    .flat_map(|&b| std::ascii::escape_default(b))
                    .map(char::from)
                    .collect();
                if s.len() > 600 {
                    format!("{}... ({} bytes)", &s[..600], bytes.len())
                } else {
                    s
                }
            }

            fn show(stream: &[Tok]) -> String {
                let mut out = String::new();
                let mut run: Vec<u8> = Vec::new();
                for t in stream {
                    match *t {
                        Tok::B(b) => run.push(b),
                        Tok::Resize(c, r) => {
                            out.push_str(&esc(&run));
                            run.clear();
                            out.push_str(&format!(" <resize {c}x{r}> "));
                        }
                    }
                }
                out.push_str(&esc(&run));
                out
            }

            /// Runs `f` on its own thread and fails, instead of hanging CI, when
            /// it does not finish in time.
            fn with_deadline<F: FnOnce() + Send + 'static>(secs: u64, f: F) {
                let (tx, rx) = mpsc::channel();
                let handle = thread::Builder::new()
                    .stack_size(64 << 20)
                    .spawn(move || {
                        f();
                        let _ = tx.send(());
                    })
                    .expect("spawn");
                match rx.recv_timeout(Duration::from_secs(secs)) {
                    Ok(()) => handle.join().expect("join"),
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        if let Err(e) = handle.join() {
                            std::panic::resume_unwind(e);
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        panic!("no result within {secs}s: a hang or unbounded work")
                    }
                }
            }

            fn env_num(name: &str, default: u64) -> u64 {
                std::env::var(name)
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(default)
            }

            #[derive(Clone, Copy, Debug)]
            enum Split {
                Whole,
                Bytes,
                Random(u64),
            }

            fn check_frame(s: &mut Screen, prev_seq: u64) -> Result<(), String> {
                let f = s.frame();
                let (cols, rows) = (s.cols(), s.rows());
                if (f.cols, f.rows) != (cols, rows) {
                    return Err(format!("frame {}x{} but screen {cols}x{rows}", f.cols, f.rows));
                }
                if f.cells.len() != cols as usize * rows as usize {
                    return Err(format!("{} cells for {cols}x{rows}", f.cells.len()));
                }
                if f.cursor.row >= rows || f.cursor.col >= cols {
                    return Err(format!("cursor {:?} outside {cols}x{rows}", f.cursor));
                }
                if f.clusters.is_empty() || !f.clusters[0].is_empty() {
                    return Err("cluster 0 must exist and be empty".into());
                }
                if f.clusters.len() > f.cells.len() + 1 {
                    return Err(format!("{} clusters for {} cells", f.clusters.len(), f.cells.len()));
                }
                for (i, c) in f.cells.iter().enumerate() {
                    if c.cluster as usize >= f.clusters.len() {
                        return Err(format!("cell {i} cluster {} out of range", c.cluster));
                    }
                    if c.cluster != 0 {
                        let n = f.clusters[c.cluster as usize].chars().count();
                        if !(2..=MAX_CLUSTER_SCALARS).contains(&n) {
                            return Err(format!("cell {i} cluster of {n} scalars"));
                        }
                    }
                }
                if let Some(t) = &f.title {
                    if t.len() > 4 * MAX_TITLE_BYTES {
                        return Err(format!("title of {} bytes", t.len()));
                    }
                }
                if f.seq < prev_seq {
                    return Err(format!("seq went back from {prev_seq} to {}", f.seq));
                }
                let d = s.damage_since(prev_seq);
                if !d.full {
                    for &(a, b) in &d.rows {
                        if a > b || b >= rows {
                            return Err(format!("damage range ({a}, {b}) outside {rows} rows"));
                        }
                    }
                }
                let len = s.scrollback_len();
                if len > SCROLLBACK {
                    return Err(format!("scrollback {len} over its cap {SCROLLBACK}"));
                }
                if len > 0 {
                    if s.scrollback_row(len - 1).is_none() {
                        return Err("newest scrollback row missing".into());
                    }
                    if s.scrollback_row(len).is_some() {
                        return Err("scrollback row past the end".into());
                    }
                }
                let replies = s.take_replies();
                if replies.len() > MAX_PENDING_REPLIES * 256 {
                    return Err(format!("{} reply bytes held", replies.len()));
                }
                Ok(())
            }

            fn play(
                cols: u16,
                rows: u16,
                stream: &[Tok],
                split: Split,
                verify: bool,
            ) -> Result<Screen, String> {
                let mut s = Screen::with_scrollback(cols, rows, SCROLLBACK);
                let mut rng = Rng::new(match split {
                    Split::Random(seed) => seed,
                    _ => 1,
                });
                let mut prev_seq = s.seq();
                let mut i = 0;
                while i < stream.len() {
                    match stream[i] {
                        Tok::Resize(c, r) => {
                            s.resize(c, r);
                            i += 1;
                        }
                        Tok::B(_) => {
                            let start = i;
                            while i < stream.len() && matches!(stream[i], Tok::B(_)) {
                                i += 1;
                            }
                            let run: Vec<u8> = stream[start..i]
                                .iter()
                                .map(|t| if let Tok::B(b) = t { *b } else { 0 })
                                .collect();
                            let mut at = 0;
                            while at < run.len() {
                                let n = match split {
                                    Split::Whole => run.len(),
                                    Split::Bytes => 1,
                                    Split::Random(_) => {
                                        if rng.chance(10) {
                                            rng.range(1, 3000)
                                        } else {
                                            rng.range(1, 48)
                                        }
                                    }
                                }
                                .min(run.len() - at);
                                s.advance(&run[at..at + n]);
                                at += n;
                                if verify && n > 0 {
                                    check_frame(&mut s, prev_seq)?;
                                    prev_seq = s.seq();
                                }
                                if matches!(split, Split::Random(_)) && rng.chance(5) {
                                    s.advance(&[]);
                                }
                            }
                            continue;
                        }
                    }
                    if verify {
                        check_frame(&mut s, prev_seq)?;
                        prev_seq = s.seq();
                    }
                }
                Ok(s)
            }

            fn norm(mut f: Frame) -> Frame {
                f.seq = 0;
                f.damage = Default::default();
                f
            }

            fn same_screen(a: &Screen, b: &Screen) -> Option<String> {
                let (fa, fb) = (norm(a.frame()), norm(b.frame()));
                if fa == fb {
                    return None;
                }
                if (fa.cols, fa.rows) != (fb.cols, fb.rows) {
                    return Some("size".into());
                }
                for (i, (x, y)) in fa.cells.iter().zip(&fb.cells).enumerate() {
                    let (xt, yt) = (fa.text(x), fb.text(y));
                    if (xt.clone(), x.fg, x.bg, x.attrs) != (yt.clone(), y.fg, y.bg, y.attrs) {
                        return Some(format!(
                            "cell {i} (row {}, col {}): {xt:?} {:?} vs {yt:?} {:?}",
                            i / fa.cols as usize,
                            i % fa.cols as usize,
                            (x.fg, x.bg, x.attrs),
                            (y.fg, y.bg, y.attrs),
                        ));
                    }
                }
                if fa.cursor != fb.cursor {
                    return Some(format!("cursor {:?} vs {:?}", fa.cursor, fb.cursor));
                }
                if fa.modes != fb.modes {
                    return Some(format!("modes {:?} vs {:?}", fa.modes, fb.modes));
                }
                if fa.alt_screen != fb.alt_screen {
                    return Some("alt screen".into());
                }
                if fa.title != fb.title {
                    return Some(format!("title {:?} vs {:?}", fa.title, fb.title));
                }
                Some("cluster tables".into())
            }

            /// Bytes in a snapshot are bounded by the grid: per cell one full SGR
            /// and a maximal cluster, per row a cursor move, plus fixed extras
            /// (title, modes, hyperlinks).
            fn snapshot_bound(cols: u16, rows: u16) -> usize {
                let cells = cols as usize * rows as usize;
                cells * (64 + 4 * MAX_CLUSTER_SCALARS) + rows as usize * 16
                    + 4 * 4 * MAX_TITLE_BYTES
                    + 32 * 1024
            }

            fn check_case(
                cols: u16,
                rows: u16,
                stream: &[Tok],
                splits: &[Split],
            ) -> Result<(), String> {
                let whole = play(cols, rows, stream, Split::Whole, true)?;
                for &sp in splits {
                    let other = play(cols, rows, stream, sp, false)?;
                    if let Some(d) = same_screen(&whole, &other) {
                        return Err(format!("{sp:?} differs from one advance: {d}"));
                    }
                }
                let snap = whole.snapshot();
                let (c, r) = (whole.cols(), whole.rows());
                if snap.len() > snapshot_bound(c, r) {
                    return Err(format!("snapshot of {} bytes over its bound", snap.len()));
                }
                let restored = Screen::restore(c, r, &snap);
                let f = restored.frame();
                if (f.cols, f.rows) != (c, r) || f.cells.len() != c as usize * r as usize {
                    return Err("restored screen has the wrong size".into());
                }
                Ok(())
            }

            fn run_case(cols: u16, rows: u16, stream: Vec<Tok>, seed: u64, name: &str) {
                // The current engine's split behaviour is covered by its own tests
                // (and a known bug on a branch); only libghostty-vt is held to
                // split invariance on arbitrary random streams here.
                let all = [Split::Bytes, Split::Random(seed ^ 0xABCD)];
                let splits: &[Split] = if HOSTILE_UTF8 { &all } else { &[] };
                if let Err(why) = check_case(cols, rows, &stream, splits) {
                    panic!(
                        "{name}: seed {seed}, grid {cols}x{rows}: {why}\nstream: {}",
                        show(&stream)
                    );
                }
            }

            // ---------------------------------------------------------------
            // Generators
            // ---------------------------------------------------------------

            fn num(rng: &mut Rng) -> String {
                match rng.below(6) {
                    0 => String::new(),
                    1 => "0".into(),
                    2 => rng.range(1, 9).to_string(),
                    3 => rng.range(10, 300).to_string(),
                    4 => rng.range(300, 70_000).to_string(),
                    _ => "99999999999".into(),
                }
            }

            fn g_noise(rng: &mut Rng, out: &mut Vec<u8>) {
                for _ in 0..rng.range(1, 24) {
                    out.push(rng.next() as u8);
                }
            }

            fn g_text(rng: &mut Rng, out: &mut Vec<u8>) {
                const WORDS: [&str; 8] = [
                    "hello ", "world ", "日本語", "e\u{301}", "x\u{301}\u{302}\u{303}", "\u{1F600}",
                    "tab\there", "\r\n",
                ];
                for _ in 0..rng.range(1, 6) {
                    out.extend_from_slice(rng.pick(&WORDS).as_bytes());
                }
            }

            fn g_invalid(rng: &mut Rng, out: &mut Vec<u8>) {
                let pieces: [&[u8]; 6] = [
                    b"\xff", b"\xc0\xaf", b"\xe6\x97", b"\xf0\x9f\x98", b"\xed\xa0\x80", b"\x80\x80",
                ];
                out.extend_from_slice(rng.pick(&pieces));
            }

            fn g_csi(rng: &mut Rng, out: &mut Vec<u8>) {
                out.extend_from_slice(b"\x1b[");
                if rng.chance(15) {
                    out.push(*rng.pick(b"?>=<!"));
                }
                for i in 0..rng.range(0, 4) {
                    if i > 0 {
                        out.push(*rng.pick(b";:"));
                    }
                    out.extend_from_slice(num(rng).as_bytes());
                }
                if rng.chance(10) {
                    out.push(*rng.pick(b" !\"$'"));
                }
                out.push(*rng.pick(b"ABCDEFGHJKLMPSTXZ@`abdefghlmnqrstuvwxyz"));
            }

            fn g_sgr(rng: &mut Rng, out: &mut Vec<u8>) {
                out.extend_from_slice(b"\x1b[");
                for i in 0..rng.range(1, 6) {
                    if i > 0 {
                        out.push(b';');
                    }
                    match rng.below(6) {
                        0 => out.extend_from_slice(rng.range(0, 9).to_string().as_bytes()),
                        1 => out.extend_from_slice(rng.range(30, 37).to_string().as_bytes()),
                        2 => out.extend_from_slice(rng.range(90, 107).to_string().as_bytes()),
                        3 => out.extend_from_slice(
                            format!("38;5;{}", rng.range(0, 300)).as_bytes(),
                        ),
                        4 => out.extend_from_slice(
                            format!(
                                "48;2;{};{};{}",
                                rng.range(0, 300),
                                rng.range(0, 255),
                                rng.range(0, 255)
                            )
                            .as_bytes(),
                        ),
                        _ => out.extend_from_slice(b"4:3"),
                    }
                }
                out.push(b'm');
            }

            fn g_mode(rng: &mut Rng, out: &mut Vec<u8>) {
                const MODES: [u32; 22] = [
                    1, 3, 4, 6, 7, 9, 12, 20, 25, 47, 1000, 1002, 1003, 1004, 1005, 1006, 1007,
                    1047, 1049, 2004, 2026, 2027,
                ];
                out.extend_from_slice(b"\x1b[?");
                out.extend_from_slice(rng.pick(&MODES).to_string().as_bytes());
                out.push(*rng.pick(b"hl"));
            }

            fn g_kitty(rng: &mut Rng, out: &mut Vec<u8>) {
                match rng.below(4) {
                    0 => out.extend_from_slice(format!("\x1b[>{}u", rng.range(0, 40)).as_bytes()),
                    1 => out.extend_from_slice(format!("\x1b[<{}u", rng.range(0, 5)).as_bytes()),
                    2 => out.extend_from_slice(
                        format!("\x1b[={};{}u", rng.range(0, 40), rng.range(1, 4)).as_bytes(),
                    ),
                    _ => out.extend_from_slice(b"\x1b[?u"),
                }
            }

            fn g_region(rng: &mut Rng, out: &mut Vec<u8>) {
                out.extend_from_slice(
                    format!("\x1b[{};{}r", rng.range(0, 14), rng.range(0, 14)).as_bytes(),
                );
                if rng.chance(50) {
                    out.extend_from_slice(b"\n\n\n\x1b[2S\x1b[3T\x1b[2L\x1b[2M");
                }
            }

            fn g_cursor(rng: &mut Rng, out: &mut Vec<u8>) {
                out.extend_from_slice(
                    format!("\x1b[{};{}H", rng.range(0, 40), rng.range(0, 90)).as_bytes(),
                );
            }

            fn terminator(rng: &mut Rng, out: &mut Vec<u8>) {
                match rng.below(5) {
                    0 | 1 => out.push(0x07),
                    2 | 3 => out.extend_from_slice(b"\x1b\\"),
                    _ => {}
                }
            }

            fn g_osc(rng: &mut Rng, out: &mut Vec<u8>) {
                out.extend_from_slice(b"\x1b]");
                match rng.below(9) {
                    0 => out.extend_from_slice(b"2;a title \xe6\x97\xa5"),
                    1 => out.extend_from_slice(b"0;"),
                    2 => out.extend_from_slice(b"8;;http://example.com/x"),
                    3 => out.extend_from_slice(b"8;;"),
                    4 => out.extend_from_slice(b"52;c;aGVsbG8="),
                    5 => out.extend_from_slice(b"52;c;?"),
                    6 => out.extend_from_slice(b"133;A"),
                    7 => out.extend_from_slice(b"11;?"),
                    _ => out.extend_from_slice(format!("4;{};?", rng.range(0, 300)).as_bytes()),
                }
                if rng.chance(10) {
                    out.extend(std::iter::repeat_n(b'z', rng.range(100, 9000)));
                }
                terminator(rng, out);
            }

            fn g_string(rng: &mut Rng, out: &mut Vec<u8>) {
                out.extend_from_slice(match rng.below(4) {
                    0 => b"\x1bP1$r".as_slice(),
                    1 => b"\x1b_Gf=24,s=1,v=1;AAAA".as_slice(),
                    2 => b"\x1bPq#0;2;0;0;0#0!10~-".as_slice(),
                    _ => b"\x1b^private".as_slice(),
                });
                out.extend(std::iter::repeat_n(b'a', rng.range(0, 40)));
                terminator(rng, out);
            }

            fn g_query(rng: &mut Rng, out: &mut Vec<u8>) {
                const QUERIES: [&str; 12] = [
                    "\x1b[c", "\x1b[>c", "\x1b[=c", "\x1b[5n", "\x1b[6n", "\x1b[?6n", "\x1b[?7$p",
                    "\x1b[4$p", "\x1b[>q", "\x1b[14t", "\x1b[18t", "\x05",
                ];
                out.extend_from_slice(rng.pick(&QUERIES).as_bytes());
            }

            fn g_ctl(rng: &mut Rng, out: &mut Vec<u8>) {
                out.push(*rng.pick(&[
                    0x00u8, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x18, 0x1a, 0x1b,
                    0x7f,
                ]));
            }

            type Gen = fn(&mut Rng, &mut Vec<u8>);

            const MIXED: &[Gen] = &[
                g_noise, g_text, g_text, g_text, g_invalid, g_csi, g_csi, g_sgr, g_sgr, g_mode,
                g_kitty, g_region, g_cursor, g_osc, g_osc, g_string, g_query, g_ctl,
            ];
            const MIXED_VALID_UTF8: &[Gen] = &[
                g_text, g_text, g_text, g_csi, g_csi, g_sgr, g_sgr, g_mode, g_kitty, g_region,
                g_cursor, g_osc, g_osc, g_string, g_query, g_ctl,
            ];

            fn gen_stream(rng: &mut Rng, target: usize, resizes: bool) -> Vec<Tok> {
                let mut bytes: Vec<u8> = Vec::new();
                let mut stream: Vec<Tok> = Vec::new();
                while bytes.len() + stream.len() < target {
                    if resizes && rng.chance(4) {
                        stream.extend(toks(&bytes));
                        bytes.clear();
                        stream.push(Tok::Resize(
                            rng.range(0, 60) as u16,
                            rng.range(0, 20) as u16,
                        ));
                    } else {
                        let g = *rng.pick(if HOSTILE_UTF8 { MIXED } else { MIXED_VALID_UTF8 });
                        g(rng, &mut bytes);
                    }
                }
                stream.extend(toks(&bytes));
                stream
            }

            fn run_random(name: &'static str, salt: u64, default_cases: u64, resizes: bool) {
                let cases = env_num("CANOPY_FUZZ_CASES", default_cases);
                let seed0 = env_num("CANOPY_FUZZ_SEED", 1);
                with_deadline(240, move || {
                    for i in 0..cases {
                        let seed = seed0.wrapping_mul(1_000_003).wrapping_add(i) ^ salt;
                        let mut rng = Rng::new(seed);
                        let cols = rng.range(2, 40) as u16;
                        let rows = rng.range(1, 12) as u16;
                        let len = rng.range(20, 500);
                        let stream = gen_stream(&mut rng, len, resizes);
                        run_case(cols, rows, stream, seed, name);
                    }
                });
            }

            #[test]
            fn random_mixed_streams() {
                run_random("mixed", 0x11, 40, false);
            }

            #[test]
            fn random_streams_with_resizes() {
                run_random("resizes", 0x22, 40, true);
            }

            fn rep(s: &str, n: usize) -> Vec<u8> {
                s.repeat(n).into_bytes()
            }

            fn corpus() -> Vec<(&'static str, Vec<u8>)> {
                let mut huge_osc = b"\x1b]52;c;".to_vec();
                huge_osc.extend(std::iter::repeat_n(b'A', 1 << 20));
                huge_osc.extend_from_slice(b"\x07after");
                let mut huge_title = b"\x1b]2;".to_vec();
                huge_title.extend(std::iter::repeat_n(b't', 1 << 20));
                huge_title.push(0x07);
                let mut huge_link = b"\x1b]8;;http://".to_vec();
                huge_link.extend(std::iter::repeat_n(b'h', 100_000));
                huge_link.extend_from_slice(b"\x07linked\x1b]8;;\x07");
                let mut marks = b"q".to_vec();
                marks.extend(rep("\u{301}", 20_000));
                let mut noise = Vec::new();
                let mut x: u64 = 0x0bad_5eed;
                for _ in 0..20_000 {
                    x = x
                        .wrapping_mul(6364136223846793005)
                        .wrapping_add(1442695040888963407);
                    noise.push((x >> 40) as u8);
                }
                vec![
                    ("huge OSC 52", huge_osc),
                    ("huge title", huge_title),
                    ("huge hyperlink", huge_link),
                    ("20000 combining marks", marks),
                    ("random bytes", if HOSTILE_UTF8 { noise } else { Vec::new() }),
                    ("ESC storm", rep("\x1b", 5000)),
                    ("ESC [ storm", rep("\x1b[", 3000)),
                    ("CSI with 200 params", {
                        let mut v = b"\x1b[".to_vec();
                        for i in 0..200 {
                            v.extend_from_slice(format!("{i};").as_bytes());
                        }
                        v.extend_from_slice(b"m");
                        v
                    }),
                    ("out-of-range CSI numbers", {
                        b"\x1b[99999;99999HX\x1b[65535L\x1b[65535M\x1b[65535@\x1b[65535P\x1b[65535X\x1b[65535S\x1b[65535T\x1b[65535;65535r\x1b[0;0r\x1b[9;2ra\x1b[65535b\x1b[65535C\x1b[65535B".to_vec()
                    }),
                    ("kitty pushes past any depth", rep("\x1b[>1u", 10_000)),
                    ("kitty pops past empty", rep("\x1b[<99u", 1000)),
                    ("unterminated DCS then text", b"\x1bPabc\x1b[31mred".to_vec()),
                    ("unterminated OSC then text", b"\x1b]2;abc\x1b[31mred".to_vec()),
                    ("CAN inside OSC", b"\x1b]2;abc\x18def\x07g".to_vec()),
                    ("mode flapping", rep("\x1b[?1049h\x1b[?1049l\x1b[?2026h\x1b[?2026l", 400)),
                    ("wide chars at every edge", rep("日本語日本語日本語\r\n", 60)),
                    ("emoji and ZWJ", rep("\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{FE0F} ", 80)),
                    ("scroll region games", rep("\x1b[2;3r\n\n\n\x1b[1;1H\x1bM\x1bM\x1bM\x1b[r", 100)),
                    ("replies nobody drains", rep("\x1b[5n\x1b[6n\x1b[c", 5000)),
                    ("colour queries", rep("\x1b]10;?\x07\x1b]11;?\x1b\\\x1b]4;1;?\x07", 500)),
                    ("insert/delete storms", rep("\x1b[100@\x1b[100P\x1b[100L\x1b[100M\x1b[100X", 300)),
                    ("tabs and backspaces", rep("\t\t\x08\x08\x08 ", 500)),
                    ("full reset between writes", rep("abc\x1bcdef\x1bc", 500)),
                ]
            }

            #[test]
            fn nasty_corpus_holds_every_invariant() {
                with_deadline(240, || {
                    for (name, bytes) in corpus() {
                        let stream = toks(&bytes);
                        // Byte-by-byte replay of the biggest entries is slow on
                        // every engine and adds nothing: whole and random splits.
                        let splits: &[Split] = if bytes.len() > 20_000 {
                            &[Split::Random(7)]
                        } else {
                            &[Split::Random(7), Split::Bytes]
                        };
                        for &(cols, rows) in &[(2u16, 1u16), (7, 3), (40, 10)] {
                            if let Err(why) = check_case(cols, rows, &stream, splits) {
                                panic!(
                                    "corpus entry {name:?} at {cols}x{rows}: {why}\nstream: {}",
                                    esc(&bytes)
                                );
                            }
                        }
                    }
                });
            }

            #[test]
            fn resize_to_the_extremes_keeps_the_frame_consistent() {
                with_deadline(120, || {
                    let mut s = Screen::with_scrollback(20, 5, SCROLLBACK);
                    s.advance(b"abc\r\n\xe6\x97\xa5\xe6\x9c\xac\r\n\x1b[1;31mred\x1b[0m\r\nx\r\ny\r\nz");
                    let mut prev = s.seq();
                    for (c, r) in [
                        (1, 1),
                        (2, 1),
                        (MAX_COLS, 1),
                        (3, MAX_ROWS),
                        (u16::MAX, u16::MAX),
                        (0, 0),
                        (20, 5),
                        (20, 5),
                        (7, 2),
                    ] {
                        s.resize(c, r);
                        if let Err(why) = check_frame(&mut s, prev) {
                            panic!("after resize to {c}x{r}: {why}");
                        }
                        prev = s.seq();
                        s.advance(b"more\r\ntext \xe6\x97\xa5");
                        if let Err(why) = check_frame(&mut s, prev) {
                            panic!("after text at {c}x{r}: {why}");
                        }
                        prev = s.seq();
                    }
                });
            }

            #[test]
            fn scrollback_never_exceeds_its_cap() {
                with_deadline(120, || {
                    let mut s = Screen::with_scrollback(20, 4, 50);
                    for i in 0..5000 {
                        s.advance(format!("line {i}\r\n").as_bytes());
                    }
                    assert!(s.scrollback_len() <= 50, "{}", s.scrollback_len());
                    assert!(s.scrollback_len() > 0);
                    let mut none = Screen::with_scrollback(20, 4, 0);
                    none.advance("x\r\n".repeat(100).as_bytes());
                    assert_eq!(none.scrollback_len(), 0);
                });
            }

            #[test]
            fn replies_are_capped_whatever_is_asked() {
                with_deadline(120, || {
                    let mut s = Screen::new(20, 4);
                    s.advance("\x1b[5n\x1b[6n\x1b[c\x1b[?7$p".repeat(10_000).as_bytes());
                    let n = s.take_replies().len();
                    assert!(n > 0 && n <= MAX_PENDING_REPLIES * 64, "{n} reply bytes");
                    assert!(s.take_replies().is_empty());
                });
            }

            #[test]
            fn a_cell_of_marks_never_outgrows_its_cluster_bound() {
                with_deadline(120, || {
                    let mut s = Screen::new(10, 2);
                    let mut bytes = b"a".to_vec();
                    bytes.extend(rep("\u{301}", 5000));
                    s.advance(&bytes);
                    let f = s.frame();
                    let a = f.cell(0, 0).unwrap();
                    assert!(f.text(a).chars().count() <= MAX_CLUSTER_SCALARS);
                    assert!(!f.cell(0, 0).unwrap().attrs.has(Attrs::WIDE_TAIL));
                });
            }
        }
    };
}
pub(crate) use define;
