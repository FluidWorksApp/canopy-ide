//! Deterministic, seeded robustness tests for `Screen`: random and hostile byte
//! streams, chunking, resizing, snapshots. Synthetic input only.
//!
//! Every stream is generated from a fixed seed by a small xorshift generator,
//! so a failure reproduces exactly. A failing stream is shrunk (a bounded
//! delete-ranges search) and printed in escaped form together with its seed.
//! Properties checked after every `advance` and `resize`:
//!
//! * no panic and no hang (each test runs under a deadline);
//! * the frame is consistent: `cols * rows` cells, cursor inside the grid,
//!   cluster table and cell references valid, clusters, title, scrollback and
//!   replies within their caps, damage ranges inside the grid, `seq` never
//!   going backwards;
//! * any split of the same stream (byte by byte, fixed, random) gives the same
//!   screen as one `advance`;
//! * `snapshot -> restore -> snapshot` is stable and the restored frame equals
//!   the live one (titles compared with control characters removed, as the
//!   snapshot removes them).
//!
//! Longer manual runs: `CANOPY_FUZZ_CASES=5000 CANOPY_FUZZ_SEED=7 cargo test
//! --release --test fuzz`. The `fuzz/` directory next to `src/` holds the
//! cargo-fuzz targets (not part of CI).

use canopy_term_core::frame::Attrs;
use canopy_term_core::screen::{
    KITTY_STACK_MAX, MAX_CLUSTER_SCALARS, MAX_COLS, MAX_PENDING_REPLIES, MAX_ROWS, MAX_SCROLLBACK,
    MAX_TITLE_BYTES,
};
use canopy_term_core::Screen;
use std::panic::{self, AssertUnwindSafe};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

// ---------------------------------------------------------------------------
// Generator and harness plumbing
// ---------------------------------------------------------------------------

/// xorshift64, seeded through splitmix64 so that nearby seeds differ.
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

    /// In `0..n`; `n` must be non-zero.
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    /// In `lo..=hi`.
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
    if s.len() > 700 {
        format!("{}... ({} bytes)", &s[..700], bytes.len())
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

/// Runs `f` on its own thread and fails the test, instead of hanging CI, when
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
                panic::resume_unwind(e);
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

#[derive(Debug)]
struct Fail {
    kind: String,
    detail: String,
}

impl Fail {
    fn new(kind: impl Into<String>, detail: impl Into<String>) -> Self {
        Fail {
            kind: kind.into(),
            detail: detail.into(),
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum Split {
    Whole,
    Fixed(usize),
    Random(u64),
}

impl Split {
    fn label(self) -> String {
        match self {
            Split::Whole => "whole".to_string(),
            Split::Fixed(n) => format!("fixed({n})"),
            Split::Random(s) => format!("random({s})"),
        }
    }

    /// Rough bytes per `advance`, to budget the work a split costs.
    fn average_chunk(self) -> usize {
        match self {
            Split::Whole => usize::MAX,
            Split::Fixed(n) => n,
            Split::Random(_) => 30,
        }
    }
}

fn clamp_size(cols: u16, rows: u16) -> (u16, u16) {
    (cols.clamp(2, MAX_COLS), rows.clamp(1, MAX_ROWS))
}

/// Replays `stream` on a fresh screen, cutting each run of bytes as `split`
/// says. With `verify`, the frame invariants are checked after every step.
fn play(
    cols: u16,
    rows: u16,
    scrollback: usize,
    stream: &[Tok],
    split: Split,
    verify: bool,
) -> Result<Screen, Fail> {
    let mut s = Screen::with_scrollback(cols, rows, scrollback);
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
                if verify {
                    check_frame(&s, scrollback, prev_seq)?;
                    prev_seq = s.seq();
                }
            }
            Tok::B(_) => {
                let start = i;
                while i < stream.len() && matches!(stream[i], Tok::B(_)) {
                    i += 1;
                }
                let run: Vec<u8> = stream[start..i]
                    .iter()
                    .map(|t| match t {
                        Tok::B(b) => *b,
                        Tok::Resize(..) => 0,
                    })
                    .collect();
                let mut at = 0;
                while at < run.len() {
                    let want = match split {
                        Split::Whole => run.len(),
                        Split::Fixed(n) => n,
                        Split::Random(_) => {
                            if rng.chance(10) {
                                rng.range(1, 5000)
                            } else {
                                rng.range(1, 64)
                            }
                        }
                    };
                    let n = want.max(1).min(run.len() - at);
                    s.advance(&run[at..at + n]);
                    at += n;
                    if verify {
                        check_frame(&s, scrollback, prev_seq)?;
                        prev_seq = s.seq();
                    }
                    if matches!(split, Split::Random(_)) && rng.chance(5) {
                        // An empty feed must change nothing.
                        s.advance(&[]);
                    }
                }
            }
        }
    }
    Ok(s)
}

fn check_frame(s: &Screen, scrollback: usize, prev_seq: u64) -> Result<(), Fail> {
    let bad = |m: String| Err(Fail::new("frame-invariant", m));
    let f = s.frame();
    let (cols, rows) = (s.cols(), s.rows());
    if !(2..=MAX_COLS).contains(&cols) || !(1..=MAX_ROWS).contains(&rows) {
        return bad(format!("size {cols}x{rows} outside the clamp"));
    }
    if (f.cols, f.rows) != (cols, rows) {
        return bad(format!(
            "frame {}x{} but screen {cols}x{rows}",
            f.cols, f.rows
        ));
    }
    if f.cells.len() != cols as usize * rows as usize {
        return bad(format!("{} cells for {cols}x{rows}", f.cells.len()));
    }
    if f.cursor.row >= rows || f.cursor.col >= cols {
        return bad(format!(
            "cursor {},{} outside {cols}x{rows}",
            f.cursor.row, f.cursor.col
        ));
    }
    if f.clusters.first().map_or(true, |c| !c.is_empty()) {
        return bad("cluster 0 is not the empty entry".to_string());
    }
    if f.clusters.len() > f.cells.len() + 1 {
        return bad(format!(
            "{} clusters for {} cells",
            f.clusters.len(),
            f.cells.len()
        ));
    }
    for (i, c) in f.clusters.iter().enumerate() {
        if c.chars().count() > MAX_CLUSTER_SCALARS {
            return bad(format!("cluster {i} holds {} scalars", c.chars().count()));
        }
    }
    for (i, cell) in f.cells.iter().enumerate() {
        let (r, c) = (i / cols as usize, i % cols as usize);
        if cell.cluster as usize >= f.clusters.len() {
            return bad(format!(
                "cell {r},{c} names missing cluster {}",
                cell.cluster
            ));
        }
        if cell.cluster != 0 && f.clusters[cell.cluster as usize].chars().next() != Some(cell.ch) {
            return bad(format!(
                "cell {r},{c}: ch is not the cluster's first scalar"
            ));
        }
        if cell.attrs.has(Attrs::WIDE_TAIL) && cell.ch != '\0' {
            return bad(format!("cell {r},{c}: wide tail with ch {:?}", cell.ch));
        }
    }
    if let Some(t) = &f.title {
        // A scalar started at the cap is finished, hence the slack.
        if t.len() > MAX_TITLE_BYTES + 4 {
            return bad(format!("title is {} bytes", t.len()));
        }
    }
    if f.seq < prev_seq {
        return bad(format!("seq went back from {prev_seq} to {}", f.seq));
    }
    if f.seq != s.seq() {
        return bad(format!("frame().seq {} != seq() {}", f.seq, s.seq()));
    }
    for since in [0, prev_seq, f.seq] {
        let d = s.damage_since(since);
        let mut last_end: Option<u16> = None;
        for &(a, b) in &d.rows {
            if a > b || b >= rows || last_end.is_some_and(|e| a <= e) {
                return bad(format!(
                    "damage_since({since}) range ({a},{b}) invalid for {rows} rows after {last_end:?}"
                ));
            }
            last_end = Some(b);
        }
    }
    let len = s.scrollback_len();
    if len > scrollback.min(MAX_SCROLLBACK) {
        return bad(format!("{len} scrollback lines past the cap {scrollback}"));
    }
    if s.scrollback_row(len).is_some() {
        return bad("scrollback_row past the end returned a row".to_string());
    }
    if len > 0 {
        for index in [0, len / 2, len - 1] {
            let Some(row) = s.scrollback_row(index) else {
                return bad(format!("scrollback_row({index}) of {len} is None"));
            };
            if row.cells.len() != cols as usize {
                return bad(format!(
                    "scrollback row is {} cells wide, screen is {cols}",
                    row.cells.len()
                ));
            }
            if row
                .cells
                .iter()
                .any(|c| c.cluster as usize >= row.clusters.len())
            {
                return bad("scrollback cell names a missing cluster".to_string());
            }
        }
    }
    Ok(())
}

/// The titles as a snapshot carries them: without control characters.
fn clean(t: &Option<String>) -> Option<String> {
    t.as_ref()
        .map(|t| t.chars().filter(|c| !c.is_control()).collect())
}

/// First difference between two screens' frames, ignoring `seq` and damage.
fn frame_diff(a: &Screen, b: &Screen, clean_titles: bool, cursor_row_free: bool) -> Option<String> {
    let (fa, fb) = (a.frame(), b.frame());
    if (fa.cols, fa.rows) != (fb.cols, fb.rows) {
        return Some(format!(
            "size {}x{} vs {}x{}",
            fa.cols, fa.rows, fb.cols, fb.rows
        ));
    }
    for (i, (x, y)) in fa.cells.iter().zip(&fb.cells).enumerate() {
        let (xt, yt) = (fa.text(x), fb.text(y));
        if xt != yt || x.fg != y.fg || x.bg != y.bg || x.attrs != y.attrs {
            return Some(format!(
                "cell row {} col {}: {:?} {:?} {:?} {:?} vs {:?} {:?} {:?} {:?}",
                i / fa.cols as usize,
                i % fa.cols as usize,
                xt,
                x.fg,
                x.bg,
                x.attrs,
                yt,
                y.fg,
                y.bg,
                y.attrs
            ));
        }
    }
    let mut cursor_b = fb.cursor;
    if cursor_row_free {
        cursor_b.row = fa.cursor.row;
    }
    if fa.cursor != cursor_b {
        return Some(format!("cursor {:?} vs {:?}", fa.cursor, fb.cursor));
    }
    if fa.modes != fb.modes {
        return Some(format!("modes {:?} vs {:?}", fa.modes, fb.modes));
    }
    if fa.alt_screen != fb.alt_screen {
        return Some("alt screen".to_string());
    }
    let (ta, tb) = if clean_titles {
        (clean(&fa.title), clean(&fb.title))
    } else {
        (fa.title.clone(), fb.title.clone())
    };
    if ta != tb {
        return Some(format!("title {ta:?} vs {tb:?}"));
    }
    None
}

/// Live screen against its restored copy. With origin mode on, a cursor
/// outside the scroll region comes back clamped into it (a documented
/// limit), so the row is not compared then.
fn snapshot_diff(live: &Screen, restored: &Screen, snap: &[u8]) -> Option<String> {
    let origin = snap.windows(5).any(|w| w == b"\x1b[?6h");
    frame_diff(live, restored, true, origin)
}

fn chunk_diff(a: &Screen, b: &Screen) -> Option<String> {
    if let Some(d) = frame_diff(a, b, false, false) {
        return Some(d);
    }
    if a.cursor_blinking() != b.cursor_blinking() {
        return Some("cursor blink".to_string());
    }
    if a.scrollback_len() != b.scrollback_len() {
        return Some(format!(
            "scrollback {} vs {} lines",
            a.scrollback_len(),
            b.scrollback_len()
        ));
    }
    let len = a.scrollback_len();
    if len > 0 {
        for index in [0, len - 1] {
            if a.scrollback_row(index) != b.scrollback_row(index) {
                return Some(format!("scrollback row {index}"));
            }
        }
    }
    None
}

/// The most cells the grid reaches over the stream.
fn max_cells(cols: u16, rows: u16, stream: &[Tok]) -> usize {
    let cells = |c: u16, r: u16| {
        let (c, r) = clamp_size(c, r);
        c as usize * r as usize
    };
    let mut most = cells(cols, rows);
    for t in stream {
        if let Tok::Resize(c, r) = *t {
            most = most.max(cells(c, r));
        }
    }
    most
}

fn splits_for(seed: u64, bytes: usize, cells: usize) -> Vec<Split> {
    let candidates = [
        Split::Fixed(1),
        Split::Fixed(3),
        Split::Fixed(251),
        Split::Random(seed ^ 0xA5A5),
        Split::Random(seed ^ 0x5A5A),
        Split::Fixed(65_536),
    ];
    let mut out = vec![];
    for sp in candidates {
        let chunk = sp.average_chunk().max(1);
        let redundant = matches!(sp, Split::Fixed(65_536)) && bytes <= 65_536;
        if bytes / chunk * cells <= 150_000_000 && !redundant {
            out.push(sp);
        }
    }
    out
}

fn check_inner(
    cols: u16,
    rows: u16,
    scrollback: usize,
    stream: &[Tok],
    seed: u64,
) -> Result<(), Fail> {
    let whole = play(cols, rows, scrollback, stream, Split::Whole, true)?;

    let cells = max_cells(cols, rows, stream);
    for sp in splits_for(seed, stream.len(), cells) {
        let verify = !matches!(sp, Split::Fixed(1 | 3));
        let other = play(cols, rows, scrollback, stream, sp, verify)?;
        if let Some(d) = chunk_diff(&whole, &other) {
            return Err(Fail::new(format!("chunking-{}", sp.label()), d));
        }
    }

    // Replies stay within the cap whatever was asked.
    let mut live = play(cols, rows, scrollback, stream, Split::Whole, false)?;
    let replies = live.take_replies();
    if replies.len() > MAX_PENDING_REPLIES * 256 {
        return Err(Fail::new(
            "replies",
            format!("{} reply bytes held", replies.len()),
        ));
    }
    if !live.take_replies().is_empty() {
        return Err(Fail::new("replies", "take_replies did not drain"));
    }

    // Snapshot, restore, snapshot.
    let snap = live.snapshot();
    let (sc, sr) = (live.cols(), live.rows());
    let bound = sc as usize * sr as usize * (64 + 4 * MAX_CLUSTER_SCALARS)
        + sr as usize * 16
        + 4 * MAX_TITLE_BYTES
        + 1024;
    if snap.len() > bound {
        return Err(Fail::new(
            "snapshot-size",
            format!("{} bytes > bound {bound}", snap.len()),
        ));
    }
    let mut restored = Screen::restore(sc, sr, &snap);
    check_frame(&restored, 10_000, 0)?;
    if let Some(d) = snapshot_diff(&live, &restored, &snap) {
        return Err(Fail::new("snapshot-frame", d));
    }
    if !restored.take_replies().is_empty() {
        return Err(Fail::new("snapshot-replies", "restore queued replies"));
    }
    let snap2 = restored.snapshot();
    if snap2 != snap {
        let at = snap
            .iter()
            .zip(&snap2)
            .position(|(a, b)| a != b)
            .unwrap_or(snap.len().min(snap2.len()));
        let from = at.saturating_sub(40);
        return Err(Fail::new(
            "snapshot-stable",
            format!(
                "first byte difference at {at} ({} vs {} bytes): {} | {}",
                snap.len(),
                snap2.len(),
                esc(&snap[from..(at + 40).min(snap.len())]),
                esc(&snap2[from..(at + 40).min(snap2.len())])
            ),
        ));
    }
    Ok(())
}

fn panic_text(p: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = p.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = p.downcast_ref::<String>() {
        s.clone()
    } else {
        "non-string panic".to_string()
    }
}

fn check_case(
    cols: u16,
    rows: u16,
    scrollback: usize,
    stream: &[Tok],
    seed: u64,
) -> Result<(), Fail> {
    match panic::catch_unwind(AssertUnwindSafe(|| {
        check_inner(cols, rows, scrollback, stream, seed)
    })) {
        Ok(r) => r,
        Err(p) => Err(Fail::new("panic", panic_text(p.as_ref()))),
    }
}

/// Deletes ranges of the stream while the same kind of failure remains.
fn shrink(
    cols: u16,
    rows: u16,
    scrollback: usize,
    stream: Vec<Tok>,
    kind: &str,
    seed: u64,
) -> Vec<Tok> {
    let mut cur = stream;
    let mut budget = 500;
    let mut n = cur.len() / 2;
    while n >= 1 && budget > 0 {
        let mut i = 0;
        while i < cur.len() && budget > 0 {
            let end = (i + n).min(cur.len());
            let mut cand = cur[..i].to_vec();
            cand.extend_from_slice(&cur[end..]);
            budget -= 1;
            let same = check_case(cols, rows, scrollback, &cand, seed)
                .err()
                .is_some_and(|f| f.kind == kind);
            if same {
                cur = cand;
            } else {
                i += n;
            }
        }
        if n == 1 {
            break;
        }
        n /= 2;
    }
    cur
}

/// Checks one case; on failure returns a report with a shrunk reproducer.
fn run_case(
    label: &str,
    cols: u16,
    rows: u16,
    scrollback: usize,
    stream: Vec<Tok>,
    seed: u64,
    shrink_up_to: usize,
) -> Option<Fail> {
    let fail = check_case(cols, rows, scrollback, &stream, seed).err()?;
    let (stream, how) = if stream.len() <= shrink_up_to {
        (
            shrink(cols, rows, scrollback, stream, &fail.kind, seed),
            "shrunk",
        )
    } else {
        (stream, "unshrunk")
    };
    let detail = check_case(cols, rows, scrollback, &stream, seed)
        .err()
        .map_or(fail.detail.clone(), |f| f.detail);
    Some(Fail::new(
        fail.kind.clone(),
        format!(
            "[{label}] {}\n    screen {cols}x{rows}, scrollback {scrollback}, {how} stream ({} steps): {}",
            detail,
            stream.len(),
            show(&stream)
        ),
    ))
}

/// Panics listing every distinct kind of failure collected.
fn report(name: &str, failures: Vec<Fail>) {
    if failures.is_empty() {
        return;
    }
    let mut msg = format!("{name}: {} kind(s) of failure\n", failures.len());
    for f in failures {
        msg.push_str(&format!("  * {}: {}\n", f.kind, f.detail));
    }
    panic!("{msg}");
}

// ---------------------------------------------------------------------------
// Stream generators
// ---------------------------------------------------------------------------

type Gen = fn(&mut Rng, &mut Vec<u8>);

fn num(rng: &mut Rng) -> String {
    match rng.below(10) {
        0 => String::new(),
        1 => "0".to_string(),
        2 => "1".to_string(),
        3..=5 => rng.range(1, 30).to_string(),
        6 => rng.range(1, 300).to_string(),
        7 => "65535".to_string(),
        8 => "65536".to_string(),
        _ => "99999999999999999999".to_string(),
    }
}

fn g_noise(rng: &mut Rng, out: &mut Vec<u8>) {
    for _ in 0..rng.range(1, 64) {
        out.push(rng.next() as u8);
    }
}

fn g_ascii(rng: &mut Rng, out: &mut Vec<u8>) {
    for _ in 0..rng.range(1, 24) {
        out.push(0x20 + rng.below(95) as u8);
    }
}

fn g_utf8(rng: &mut Rng, out: &mut Vec<u8>) {
    const SAMPLES: &[&str] = &[
        "é",
        "日",
        "本語",
        "😀",
        "e\u{301}",
        "a\u{308}\u{301}",
        "\u{200d}",
        "\u{fe0f}",
        "🇺🇸",
        "👨\u{200d}👩\u{200d}👧",
        "\u{301}",
        "\u{feff}",
        "\u{2028}",
        "\u{85}",
        "\u{9b}",
        "\u{ffff}",
        "\u{10ffff}",
    ];
    if rng.chance(70) {
        out.extend_from_slice(rng.pick(SAMPLES).as_bytes());
    } else {
        let c = rng.range(0x80, 0x2_FFFF) as u32;
        if let Some(c) = char::from_u32(c) {
            let mut b = [0u8; 4];
            out.extend_from_slice(c.encode_utf8(&mut b).as_bytes());
        }
    }
}

fn g_invalid(rng: &mut Rng, out: &mut Vec<u8>) {
    const BAD: &[&[u8]] = &[
        b"\x80",
        b"\xbf",
        b"\xc0\x80",
        b"\xc1\xbf",
        b"\xe0\x80\x80",
        b"\xed\xa0\x80",
        b"\xf0\x9f",
        b"\xf0\x9f\x98",
        b"\xf4\x90\x80\x80",
        b"\xf8\x88\x80\x80\x80",
        b"\xff",
        b"\xfe",
        b"\xe2\x82",
        b"\xc3",
    ];
    if rng.chance(70) {
        out.extend_from_slice(rng.pick(BAD));
    } else {
        out.push(0x80 + rng.below(128) as u8);
    }
}

fn g_ctl(rng: &mut Rng, out: &mut Vec<u8>) {
    const CTL: &[&[u8]] = &[
        b"\r", b"\n", b"\r\n", b"\t", b"\x08", b"\x07", b"\x0b", b"\x0c", b"\x0e", b"\x0f",
        b"\x00", b"\x7f", b"\x18", b"\x1a", b"\x1bM", b"\x1bD", b"\x1bE", b"\x1b7", b"\x1b8",
        b"\x1b=", b"\x1b>", b"\x1bc", b"\x1b#8", b"\x1b(0", b"\x1b(B", b"\x1bH", b"\x1b\\",
        b"\x1b",
    ];
    out.extend_from_slice(rng.pick(CTL));
}

fn g_csi(rng: &mut Rng, out: &mut Vec<u8>) {
    out.extend_from_slice(b"\x1b[");
    if rng.chance(25) {
        out.push(*rng.pick(b"?>=<!"));
    }
    for i in 0..rng.below(6) {
        if i > 0 {
            out.push(if rng.chance(10) { b':' } else { b';' });
        }
        out.extend_from_slice(num(rng).as_bytes());
    }
    if rng.chance(10) {
        out.push(*rng.pick(b" $'\"!"));
    }
    if rng.chance(90) {
        out.push(*rng.pick(b"@ABCDEFGHIJKLMPSTXZ`abcdefghlmnqrstu^dpx~"));
    } else {
        out.push(0x40 + rng.below(63) as u8);
    }
}

fn g_sgr(rng: &mut Rng, out: &mut Vec<u8>) {
    out.extend_from_slice(b"\x1b[");
    for i in 0..rng.range(1, 5) {
        if i > 0 {
            out.push(b';');
        }
        let s = match rng.below(8) {
            0 => format!("38;5;{}", rng.below(300)),
            1 => format!(
                "48;2;{};{};{}",
                rng.below(300),
                rng.below(300),
                rng.below(300)
            ),
            2 => format!(
                "38:2::{}:{}:{}",
                rng.below(256),
                rng.below(256),
                rng.below(256)
            ),
            3 => format!("{}", 30 + rng.below(8)),
            4 => format!("{}", 90 + rng.below(8)),
            5 => format!("{}", 40 + rng.below(8)),
            6 => format!("{}", rng.below(30)),
            _ => format!("{}", rng.below(400)),
        };
        out.extend_from_slice(s.as_bytes());
    }
    out.push(b'm');
}

fn g_mode(rng: &mut Rng, out: &mut Vec<u8>) {
    const MODES: &[u32] = &[
        1, 3, 5, 6, 7, 9, 12, 25, 47, 1000, 1002, 1003, 1004, 1005, 1006, 1007, 1015, 1047, 1048,
        1049, 2004, 2026, 2027, 9001,
    ];
    let on = if rng.chance(50) { 'h' } else { 'l' };
    if rng.chance(85) {
        let m = if rng.chance(90) {
            *rng.pick(MODES)
        } else {
            rng.below(3000) as u32
        };
        out.extend_from_slice(format!("\x1b[?{m}{on}").as_bytes());
    } else {
        let m = *rng.pick(&[4u32, 20, 2, 12]);
        out.extend_from_slice(format!("\x1b[{m}{on}").as_bytes());
    }
}

fn g_kitty(rng: &mut Rng, out: &mut Vec<u8>) {
    let flags = if rng.chance(80) {
        rng.below(32)
    } else {
        rng.below(70_000)
    };
    let s = match rng.below(8) {
        0 | 1 => format!("\x1b[>{flags}u"),
        2 => format!("\x1b[<{}u", num(rng)),
        3 => format!("\x1b[={flags};{}u", rng.below(5)),
        4 => "\x1b[?u".to_string(),
        5 => "\x1b[>u".to_string(),
        6 => "\x1b[<u".to_string(),
        _ => "\x1b[>1u".repeat(rng.range(2, 300)),
    };
    out.extend_from_slice(s.as_bytes());
}

fn g_region(rng: &mut Rng, out: &mut Vec<u8>) {
    let s = match rng.below(9) {
        0 => "\x1b[r".to_string(),
        1 => format!("\x1b[{};{}r", num(rng), num(rng)),
        2 | 3 => {
            let a = rng.range(1, 30);
            format!("\x1b[{a};{}r", a + rng.below(8))
        }
        4 => format!("\x1b[{}S", num(rng)),
        5 => format!("\x1b[{}T", num(rng)),
        6 => format!("\x1b[{}L\x1b[{}M", num(rng), num(rng)),
        7 => "\x1bM\x1bM\n\n\n".to_string(),
        _ => "\x1b[?6h\x1b[99999;99999H\x1b[1;1H".to_string(),
    };
    out.extend_from_slice(s.as_bytes());
}

fn g_cursor(rng: &mut Rng, out: &mut Vec<u8>) {
    let s = match rng.below(6) {
        0 => format!("\x1b[{};{}H", num(rng), num(rng)),
        1 => format!(
            "\x1b[{}{}",
            num(rng),
            rng.pick(&['A', 'B', 'C', 'D', 'E', 'F', 'G', 'd'])
        ),
        2 => format!(
            "\x1b[{}{}",
            num(rng),
            rng.pick(&['J', 'K', '@', 'P', 'X', 'I', 'Z'])
        ),
        3 => format!("a\x1b[{}b", num(rng)),
        4 => "\x1b7\x1b[5;5H\x1b8".to_string(),
        _ => "\x1b[s\x1b[u".to_string(),
    };
    out.extend_from_slice(s.as_bytes());
}

fn terminator(rng: &mut Rng, out: &mut Vec<u8>) {
    match rng.below(8) {
        0 | 1 | 2 => out.push(0x07),
        3 | 4 => out.extend_from_slice(b"\x1b\\"),
        5 => out.push(0x18),
        6 => out.push(0x1a),
        _ => {} // left open
    }
}

fn g_osc(rng: &mut Rng, out: &mut Vec<u8>) {
    const NUMS: &[u32] = &[
        0, 1, 2, 4, 7, 8, 10, 11, 12, 52, 104, 110, 111, 112, 133, 1337,
    ];
    out.extend_from_slice(b"\x1b]");
    let n = if rng.chance(90) {
        *rng.pick(NUMS)
    } else {
        rng.below(100_000) as u32
    };
    out.extend_from_slice(n.to_string().as_bytes());
    out.push(b';');
    let len = if rng.chance(3) {
        rng.range(5000, 9000)
    } else if rng.chance(1) {
        rng.range(70_000, 90_000)
    } else {
        rng.below(60)
    };
    for _ in 0..len {
        let b = match rng.below(12) {
            0 => b';',
            1 => b'?',
            2 => rng.next() as u8,
            3 => 0x80 + rng.below(128) as u8,
            _ => 0x20 + rng.below(95) as u8,
        };
        out.push(b);
    }
    terminator(rng, out);
}

fn g_string(rng: &mut Rng, out: &mut Vec<u8>) {
    const OPENERS: &[&[u8]] = &[
        b"\x1bP",
        b"\x1b_",
        b"\x1b^",
        b"\x1bX",
        b"\x1bP1$r",
        b"\x1bP=1s",
    ];
    out.extend_from_slice(rng.pick(OPENERS));
    for _ in 0..rng.below(80) {
        out.push(if rng.chance(10) {
            rng.next() as u8
        } else {
            0x20 + rng.below(95) as u8
        });
    }
    terminator(rng, out);
}

fn g_query(rng: &mut Rng, out: &mut Vec<u8>) {
    const Q: &[&str] = &[
        "\x1b[5n",
        "\x1b[6n",
        "\x1b[?6n",
        "\x1b[c",
        "\x1b[>c",
        "\x1b[?u",
        "\x1b]10;?\x07",
        "\x1b]11;?\x1b\\",
        "\x1b]4;1;?\x07",
        "\x1b[?2026$p",
        "\x1b[?1049$p",
        "\x1b[18t",
        "\x1b[14t",
        "\x1b[22;0t",
        "\x1b[23;0t",
        "\x1b[8;5;5t",
    ];
    let q = *rng.pick(Q);
    let times = if rng.chance(5) { rng.range(10, 300) } else { 1 };
    for _ in 0..times {
        out.extend_from_slice(q.as_bytes());
    }
}

#[derive(Clone, Copy)]
enum Profile {
    Noise,
    Text,
    Escapes,
    Modes,
    Utf8,
    Resizing,
}

const NOISE: &[Gen] = &[g_noise];
const TEXT: &[Gen] = &[g_ascii, g_ascii, g_utf8, g_ctl, g_ctl, g_cursor, g_sgr];
const ESCAPES: &[Gen] = &[
    g_ascii, g_ascii, g_utf8, g_ctl, g_csi, g_csi, g_csi, g_sgr, g_mode, g_kitty, g_region,
    g_cursor, g_osc, g_string, g_query, g_invalid,
];
const MODES: &[Gen] = &[
    g_ascii, g_ctl, g_mode, g_mode, g_kitty, g_kitty, g_region, g_region, g_cursor, g_sgr, g_query,
    g_utf8,
];
const UTF8: &[Gen] = &[
    g_ascii, g_utf8, g_utf8, g_utf8, g_invalid, g_invalid, g_ctl, g_osc, g_string, g_csi,
];

fn gens(p: Profile) -> &'static [Gen] {
    match p {
        Profile::Noise => NOISE,
        Profile::Text => TEXT,
        Profile::Escapes | Profile::Resizing => ESCAPES,
        Profile::Modes => MODES,
        Profile::Utf8 => UTF8,
    }
}

fn gen_stream(p: Profile, rng: &mut Rng, target: usize) -> Vec<Tok> {
    const RESIZES: &[(u16, u16)] = &[
        (1, 1),
        (2, 1),
        (1, 30),
        (3, 3),
        (5, 2),
        (10, 3),
        (40, 12),
        (80, 24),
        (200, 60),
        (0, 0),
    ];
    let table = gens(p);
    let mut out: Vec<Tok> = Vec::new();
    let mut piece = Vec::new();
    while out.len() < target {
        if matches!(p, Profile::Resizing) && rng.chance(4) {
            let (c, r) = *rng.pick(RESIZES);
            out.push(Tok::Resize(c, r));
        }
        piece.clear();
        (*rng.pick(table))(rng, &mut piece);
        out.extend(piece.iter().map(|&b| Tok::B(b)));
    }
    out
}

fn run_profile(name: &'static str, p: Profile, default_cases: u64, salt: u64) {
    let cases = env_num("CANOPY_FUZZ_CASES", default_cases);
    let base = env_num("CANOPY_FUZZ_SEED", 1) ^ salt;
    with_deadline(900, move || {
        const SIZES: &[(u16, u16)] = &[
            (2, 1),
            (1, 1),
            (3, 2),
            (5, 3),
            (10, 3),
            (20, 5),
            (40, 12),
            (80, 24),
            (7, 40),
            (120, 30),
            (0, 0),
        ];
        let mut failures: Vec<Fail> = Vec::new();
        for i in 0..cases {
            let seed = base.wrapping_add(i.wrapping_mul(0x9E37_79B9_7F4A_7C15));
            let mut rng = Rng::new(seed);
            let (cols, rows) = *rng.pick(SIZES);
            let scrollback = *rng.pick(&[0usize, 5, 100]);
            let target = rng.range(200, 2500);
            let stream = gen_stream(p, &mut rng, target);
            if let Some(f) = run_case(
                &format!("{name} seed {seed:#x}"),
                cols,
                rows,
                scrollback,
                stream,
                seed,
                12_000,
            ) {
                if !failures.iter().any(|g| g.kind == f.kind) {
                    failures.push(f);
                }
            }
        }
        report(name, failures);
    });
}

#[test]
fn random_noise_streams() {
    run_profile("noise", Profile::Noise, 100, 0x01);
}

#[test]
fn random_text_streams() {
    run_profile("text", Profile::Text, 100, 0x02);
}

#[test]
fn random_escape_streams() {
    run_profile("escapes", Profile::Escapes, 150, 0x03);
}

#[test]
fn random_mode_and_kitty_streams() {
    run_profile("modes", Profile::Modes, 150, 0x04);
}

#[test]
fn random_utf8_streams() {
    run_profile("utf8", Profile::Utf8, 100, 0x05);
}

#[test]
fn random_streams_with_resizes() {
    run_profile("resizing", Profile::Resizing, 150, 0x06);
}

// ---------------------------------------------------------------------------
// The nasty corpus
// ---------------------------------------------------------------------------

struct Corpus(Vec<(&'static str, Vec<Tok>)>);

impl Corpus {
    fn add(&mut self, name: &'static str, bytes: impl AsRef<[u8]>) {
        self.0.push((name, toks(bytes.as_ref())));
    }
}

/// Builds a stream of bytes and resizes.
#[derive(Default)]
struct Steps(Vec<Tok>);

impl Steps {
    fn bytes(mut self, b: impl AsRef<[u8]>) -> Self {
        self.0.extend(b.as_ref().iter().map(|&b| Tok::B(b)));
        self
    }
    fn resize(mut self, c: u16, r: u16) -> Self {
        self.0.push(Tok::Resize(c, r));
        self
    }
}

fn rep(s: &str, n: usize) -> String {
    s.repeat(n)
}

const WRAPPY: &str = "日本語 abc def ghi jkl mno pqr stu vwx yz\r\n\x1b[31;44mwide 日日日日日日日日日日日日\x1b[0m e\u{301}\u{301}x\r\n0123456789012345678901234567890123456789\r\n";

fn corpus() -> Vec<(&'static str, Vec<Tok>)> {
    let mut c = Corpus(Vec::new());

    // Huge and malformed CSI parameters.
    c.add(
        "csi parameter overflow",
        "\x1b[99999999999999999999;99999999999999999999Hx\x1b[4294967296;18446744073709551616H",
    );
    c.add("csi 1000 parameters", format!("\x1b[{}mx", rep("1;", 1000)));
    c.add("csi 100k digits", format!("\x1b[{}mx", rep("9", 100_000)));
    c.add("csi colon flood", format!("\x1b[{}mx", rep("1:", 5000)));
    c.add(
        "csi truncated and out-of-range colours",
        "\x1b[38;2;999;999;999m\x1b[38;5;999m\x1b[38;2m\x1b[38m\x1b[48:2:::1:2:3m\x1b[58;2;1;2;3m\x1b[38;5;m x\x1b[48;2;1;2m\x1b[38;2;;;m",
    );
    c.add(
        "csi counts at the u16 limit",
        "\x1b[65535@\x1b[65535P\x1b[65535X\x1b[65535L\x1b[65535M\x1b[65535S\x1b[65535T\x1b[65535I\x1b[65535Z\x1b[65535A\x1b[65535B\x1b[65535C\x1b[65535D\x1b[65535E\x1b[65535F\x1b[65535G\x1b[65535d\x1b[65535;65535H\x1b[65535;65535f\x1b[65536;65536H",
    );
    c.add("repeat storm", format!("a{}", rep("\x1b[65535b", 200)));
    c.add(
        "csi intermediates overflow",
        "\x1b[1 !\"#$%&'()*+,-./m\x1b ! \" # c\x1b[1;2;3 $ ' \"m",
    );
    c.add(
        "csi private marker after parameters",
        "\x1b[1?2;3h\x1b[?1?2h\x1b[?;;h\x1b[?1;2;3;4;5;6;7;8;9;10;11;12;13;14;15;16;17;18;19;20;21;22;23;24;25;26;27;28;29;30;31;32;33;2026h",
    );
    c.add(
        "c0 controls inside csi",
        "\x1b[1\r\n\x0b\x0c;2\x00H\x1b[3\x18mx\x1b[4\x1am\x1b[5\x1b[6mz",
    );
    c.add(
        "csi aborted by esc and reset",
        "\x1b[1;2\x1bc\x1b]2;t\x1bc\x1bP1\x1bc\x1b[?\x1bc",
    );

    // Unterminated strings.
    c.add(
        "unterminated osc title",
        format!("\x1b]2;{}", rep("a", 200_000)),
    );
    c.add(
        "unterminated osc 52",
        format!("\x1b]52;c;{}", rep("QUFB", 100_000)),
    );
    c.add(
        "osc with 100k parameters",
        format!("\x1b]2;{}\x07", rep("a;", 100_000)),
    );
    c.add(
        "osc invalid utf-8 title",
        &b"\x1b]2;\xff\xfe\xc0\x80ok\xed\xa0\x80\xf4\x90\x80\x80\x07"[..],
    );
    c.add(
        "osc control characters in the title",
        "\x1b]2;a\x7fb\u{85}c\u{9b}d\u{2028}e\x07",
    );
    c.add(
        "osc number overflow",
        "\x1b]99999999999999999999;x\x07\x1b]4294967296;x\x07\x1b];x\x07\x1b]\x07",
    );
    c.add(
        "osc colour queries",
        format!(
            "{}\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07\x1b]104\x07\x1b]4;300;?\x07",
            rep("\x1b]4;1;?\x07", 5000)
        ),
    );
    c.add(
        "osc aborted by can, sub and esc",
        "\x1b]2;abc\x18def\x1b]2;x\x1ayz\x1b]2;q\x1b[31mred\x1b]8;;http://x\x07link\x1b]8;;\x07",
    );
    c.add(
        "hyperlink flood",
        rep("\x1b]8;id=1;http://example.invalid\x07x\x1b]8;;\x07", 5000),
    );
    c.add("unterminated dcs", format!("\x1bP1$r{}", rep("x", 300_000)));
    c.add(
        "dcs sixel",
        format!("\x1bPq{}\x1b\\", rep("#0;2;0;0;0#0!1000~-", 1000)),
    );
    c.add(
        "synchronized update dcs",
        format!(
            "\x1bP=1s\x1b\\text\x1bP=2s\x1b\\{}\x1bP=1s\x1b\\x",
            rep("\x1bP=1s\x1b\\", 1000)
        ),
    );
    c.add(
        "synchronized update mode",
        format!("{}x{}", rep("\x1b[?2026h", 500), rep("\x1b[?2026l", 500)),
    );
    c.add(
        "unterminated apc",
        format!("\x1b_Gf=100,a=T;{}", rep("A", 300_000)),
    );
    c.add(
        "pm and sos",
        format!("\x1b^priv\x1bXsos{}\x1bXq\x1b\\x", rep("\x1b^", 1000)),
    );
    c.add(
        "strings aborted by esc",
        "\x1bP1;2|abc\x1b[31mred\x1b\\ \x1b_x\x1bP y\x1b]2;t\x07\x1bP\x18x\x1b_\x1a",
    );

    // Kitty keyboard stacks.
    c.add(
        "kitty push at the depth limit",
        format!(
            "{}\x1b[?u{}\x1b[?u",
            rep("\x1b[>1u", KITTY_STACK_MAX),
            rep("\x1b[>2u", KITTY_STACK_MAX + 1)
        ),
    );
    c.add(
        "kitty pop underflow",
        format!("\x1b[<65535u\x1b[<0u{}\x1b[?u", rep("\x1b[<u", 1000)),
    );
    c.add(
        "kitty set modes",
        "\x1b[=31;1u\x1b[=31;2u\x1b[=31;3u\x1b[=255;4u\x1b[=65535;2u\x1b[=;u\x1b[>65535u\x1b[>99999999999u\x1b[=1;99999u\x1b[?u",
    );
    c.add(
        "kitty across the alternate screen",
        rep(
            &format!(
                "{}\x1b[?1049h{}\x1b[?1049l\x1b[<5u",
                rep("\x1b[>1u", 300),
                rep("\x1b[>2u", 300)
            ),
            5,
        ),
    );
    c.add(
        "kitty deep stack then reset",
        format!("{}\x1bc\x1b[?u", rep("\x1b[>1u", 1000)),
    );

    // Scroll regions.
    c.add(
        "scroll region edges",
        "\x1b[1;1r\x1b[2;1r\x1b[0;0r\x1b[;r\x1b[65535;65535r\x1b[1;65535r\x1b[65535;1r\x1b[3;3r\nx\x1b[2;3r\n\n\n\x1bM\x1bM\x1bM",
    );
    let mut deep = String::new();
    for i in 1..=200 {
        let a = i % 30 + 1;
        deep.push_str(&format!(
            "\x1b[{a};{}r\x1b[{}S\x1b[{}T\x1b[L\x1b[M\x1bM\n\n\nline {i}\r\n",
            a + i % 7,
            i % 50,
            i % 40
        ));
    }
    c.add("deep scroll regions", deep);
    c.add(
        "region with origin mode",
        "\x1b[2;4r\x1b[?6h\x1b[99999;99999H*\x1b[1;1H\x1bM\x1bM\x1b[?6l\x1b[65535B\n\n\n\x1b[?6h\x1b[r\x1b[?6l",
    );
    c.add(
        "region, alternate screen and DECCOLM",
        "\x1b[2;3r\x1b[?1049h\x1b[?3h\x1b[?3l\x1b[?1049l\x1b[?1049h\x1b[r\x1b[?3h\x1b[2;3r\x1b[?3l",
    );
    c.add(
        "region with insert and delete lines",
        format!(
            "\x1b[2;3r{}",
            rep("\x1b[2;1H\x1b[65535L\x1b[65535M\x1b[1S\x1b[1T", 200)
        ),
    );

    // Invalid UTF-8.
    c.add(
        "lone continuation bytes",
        (0x80u8..=0xBF).chain(0x20..0x30).collect::<Vec<u8>>(),
    );
    c.add(
        "truncated multibyte sequences",
        &b"\xf0\x9fa\xe2\x82b\xc3c\xf0\x9f\x1b[31mred\xf0\x9f\x98\xe2\x82\xe2\x82\xac"[..],
    );
    c.add(
        "overlong and surrogate encodings",
        &b"\xc0\x80\xc1\xbf\xe0\x80\x80\xed\xa0\x80\xed\xbf\xbf\xf4\x90\x80\x80\xf5\x80\x80\x80\xff\xfe\xfd\xf8\x88\x80\x80\x80\xfc\x84\x80\x80\x80\x80"[..],
    );
    c.add(
        "invalid utf-8 inside strings",
        &b"\x1b]2;\xff\xfe\x07\x1bP\xff\xfe\x1b\\\x1b_\xc0\x80\x1b\\\x1b[\xff;\xfe m\x1b[1;\xf0\x9fm"[..],
    );
    c.add(
        "every byte value",
        (0u8..=255).cycle().take(256 * 50).collect::<Vec<u8>>(),
    );
    c.add(
        "c1 controls as single bytes",
        (0x80u8..=0x9F)
            .flat_map(|b| vec![b, b'x'])
            .collect::<Vec<u8>>(),
    );
    c.add("truncated utf-8 at the end", &b"abc\xe2\x82"[..]);

    // Wide characters, combining marks, clusters.
    c.add("wide on a tiny screen", rep("日本語", 1000));
    c.add("wide characters at the wrap edge", rep("a日", 500));
    c.add(
        "combining mark flood",
        format!("a{}\x1b[1;1Hb", rep("\u{301}", 100_000)),
    );
    c.add(
        "zero width joiner flood",
        format!("x{}", rep("\u{200d}", 50_000)),
    );
    c.add("regional indicators", rep("🇺", 10_000));
    c.add(
        "leading combining marks and selectors",
        "\u{301}x\u{fe0f}\u{200d}\u{20e3}\r\n\u{200d}\u{200d}a",
    );
    c.add(
        "emoji sequences",
        rep(
            "👨\u{200d}👩\u{200d}👧\u{200d}👦 👍🏽 🏳\u{fe0f}\u{200d}🌈 ",
            500,
        ),
    );

    // Modes and the rest of the repertoire.
    let modes: &[u64] = &[
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        12,
        25,
        40,
        45,
        47,
        66,
        69,
        80,
        95,
        1000,
        1001,
        1002,
        1003,
        1004,
        1005,
        1006,
        1007,
        1015,
        1016,
        1034,
        1035,
        1036,
        1039,
        1042,
        1047,
        1048,
        1049,
        2004,
        2026,
        2027,
        9001,
        65535,
        99_999_999_999,
    ];
    let mut soup = String::new();
    for _ in 0..3 {
        for &m in modes {
            soup.push_str(&format!("\x1b[?{m}hx"));
        }
        for &m in modes {
            soup.push_str(&format!("\x1b[?{m}ly"));
        }
    }
    c.add("mode soup", soup);
    c.add(
        "alternate screen flood",
        rep(
            "\x1b[?1049h\x1b[?47l\x1b[?1047h\x1b[?1048hx\x1b[?1049l\n",
            2000,
        ),
    );
    c.add(
        "title stack",
        format!(
            "{}{}\x1b]2;x\x07\x1b[22;2t\x1b[23;1t",
            rep("\x1b[22;0t", 5000),
            rep("\x1b[23;0t", 6000)
        ),
    );
    c.add(
        "window operations",
        "\x1b[8;1;1t\x1b[8;99999;99999t\x1b[4;1;1t\x1b[1t\x1b[2t\x1b[3;1;1t\x1b[18t\x1b[19t\x1b[14t\x1b[16t\x1b[20t\x1b[21t\x1b[8;;t",
    );
    c.add(
        "query flood",
        format!(
            "{}{}{}{}",
            rep("\x1b[5n", 5000),
            rep("\x1b[6n", 5000),
            rep("\x1b[c", 5000),
            rep("\x1b[?u", 5000)
        ),
    );
    c.add(
        "tabs",
        format!(
            "{}\x1b[65535I\x1b[65535Z\x1b[3g\x1b[0g\x1bH\x1bH\x1b[2g\t\t",
            rep("\t", 10_000)
        ),
    );
    c.add(
        "character sets",
        "\x1b(0lqk\x1b)0\x0e\x0flqk\x1b*A\x1b+B\x1bn\x1bo\x1b~\x1b(B\x1b(U\x1b(",
    );
    c.add(
        "decaln and line attributes",
        "\x1b#8\x1b#3\x1b#4\x1b#5\x1b#6\x1b#9",
    );
    c.add(
        "insert mode with wide characters",
        format!(
            "\x1b[4h{}\x1b[1;1H\x1b[65535@日\x1b[2P\x1b[?7l{}",
            rep("日a", 50),
            rep("日", 50)
        ),
    );
    let mut sgr = String::new();
    for n in 0..=200 {
        sgr.push_str(&format!("\x1b[{n}mx"));
    }
    c.add("every sgr number", sgr);
    c.add(
        "cursor save and restore",
        format!("{}\x1b[s\x1b[u\x1b8\x1b8", rep("\x1b7\x1b[2;2H\x1b8", 1000)),
    );
    c.add(
        "bell and backspace",
        format!("{}{}", rep("\x07\x08", 10_000), rep("\x08", 100_000)),
    );
    c.add("newline storm", rep("\n", 200_000));
    c.add(
        "mouse mode soup",
        "\x1b[?9h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1005h\x1b[?1006h\x1b[?1015h\x1b[?9l\x1b[?1000l\x1b[?9h\x1b[?1003l\x1b[?1002l\x1b[?1006l\x1b[?9l",
    );
    c.add(
        "erase and clear",
        "\x1b[3J\x1b[2J\x1b[1J\x1b[0J\x1b[1K\x1b[2K\x1b[0K\x1b[65535X\x1bc\x1b[3J",
    );

    // Resizes, in the middle of content and of sequences.
    let mut out = c.0;
    let mut add = |name: &'static str, s: Steps| out.push((name, s.0));
    add(
        "resize to 1x1 and back",
        Steps::default()
            .bytes(rep(WRAPPY, 4))
            .resize(1, 1)
            .bytes(WRAPPY)
            .resize(80, 24)
            .bytes(WRAPPY)
            .resize(1, 1)
            .resize(1, 1)
            .resize(2, 1),
    );
    add(
        "resize to the largest size",
        Steps::default()
            .bytes(WRAPPY)
            .resize(65535, 65535)
            .bytes(WRAPPY)
            .resize(1, 1)
            .resize(2000, 1000)
            .bytes("\x1b[999;999Hx\x1b[1;1H")
            .resize(2001, 1001)
            .resize(3, 3)
            .bytes(WRAPPY),
    );
    let mut osc = Steps::default();
    for i in 0..100u16 {
        let (c, r) = [(1, 1), (200, 60), (2, 1), (300, 3), (5, 40)][(i % 5) as usize];
        osc = osc.bytes(format!("{}{}\r\n", WRAPPY, i)).resize(c, r);
    }
    add("resize oscillation", osc);
    add(
        "resize in the alternate screen with a region",
        Steps::default()
            .bytes("main\r\n\x1b[?1049h\x1b[2;5r\x1b[?6h\x1b[3;3Hx")
            .resize(10, 2)
            .bytes("\n\n\nalt\x1b[?1049l")
            .resize(10, 30)
            .bytes("\x1b[?1049h")
            .resize(3, 3)
            .bytes("\x1b[r\x1b[?1049l"),
    );
    add(
        "resize inside sequences",
        Steps::default()
            .bytes("\x1b[1;2")
            .resize(5, 5)
            .bytes("3H\x1b]2;ti")
            .resize(40, 12)
            .bytes(b"tle\x07\xf0\x9f")
            .resize(2, 1)
            .bytes(b"\x98\x80\x1bP1")
            .resize(80, 24)
            .bytes("x\x1b\\ok"),
    );
    add(
        "resize with a region and scrolling",
        Steps::default()
            .bytes("\x1b[3;5r\n\n\n\n\n\n")
            .resize(10, 2)
            .bytes("\n\n\n\n")
            .resize(10, 30)
            .bytes("\x1b[2;29r\n\n\n\x1b[S\x1b[T")
            .resize(10, 4)
            .bytes("\n\n\n"),
    );
    add(
        "resize reflowing wide characters",
        Steps::default()
            .bytes(rep("日", 200))
            .resize(3, 5)
            .resize(4, 5)
            .resize(2, 1)
            .resize(7, 9)
            .bytes(rep("a日", 40))
            .resize(2, 3)
            .resize(80, 24),
    );
    add(
        "resize with combining marks and the cursor at the edge",
        Steps::default()
            .bytes("abcdefghij\u{301}\u{301}\u{301}\x1b[1;10H")
            .resize(5, 2)
            .bytes("x\u{301}")
            .resize(11, 4)
            .bytes("\x1b[4;11Hz")
            .resize(3, 1),
    );
    out
}

#[test]
fn nasty_corpus_holds_every_invariant() {
    with_deadline(900, || {
        let sizes: [(u16, u16); 4] = [(2, 1), (0, 0), (10, 3), (80, 24)];
        let mut failures: Vec<Fail> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for (name, stream) in corpus() {
            for (i, (cols, rows)) in sizes.into_iter().enumerate() {
                let seed = 0xC0DE + i as u64;
                if let Some(f) = run_case(name, cols, rows, 50, stream.clone(), seed, 2500) {
                    // One report per corpus entry and kind, not per size.
                    if seen.insert((name, f.kind.clone())) {
                        failures.push(f);
                    }
                }
            }
        }
        report("corpus", failures);
    });
}

// ---------------------------------------------------------------------------
// Targeted properties
// ---------------------------------------------------------------------------

fn text_of_row(s: &Screen, r: u16) -> String {
    let f = s.frame();
    let mut t = String::new();
    for c in 0..f.cols {
        let cell = f.cell(r, c).unwrap();
        if !cell.attrs.has(Attrs::WIDE_TAIL) {
            t.push_str(&f.text(cell));
        }
    }
    t.trim_end().to_string()
}

#[test]
fn unterminated_strings_are_bounded_and_end_cleanly() {
    with_deadline(300, || {
        // (opener, terminator that ends the string)
        let cases: &[(&str, &str)] = &[
            ("\x1b]0;", "\x07"),
            ("\x1b]1;", "\x1b\\"),
            ("\x1b]2;", "\x07"),
            ("\x1b]52;c;", "\x07"),
            ("\x1b]1337;File=", "\x1b\\"),
            ("\x1bP1$r", "\x1b\\"),
            ("\x1bPq", "\x1b\\"),
            ("\x1b_Gf=100;", "\x1b\\"),
            ("\x1b^", "\x1b\\"),
            ("\x1bX", "\x1b\\"),
        ];
        for &(opener, end) in cases {
            let (opener, end) = (opener.as_bytes(), end.as_bytes());
            let mut s = Screen::new(20, 4);
            s.advance(opener);
            let chunk = vec![b'A'; 64 * 1024];
            for _ in 0..64 {
                s.advance(&chunk); // 4 MiB with no terminator
            }
            check_frame(&s, 10_000, 0).unwrap_or_else(|f| panic!("{}: {}", esc(opener), f.detail));
            s.advance(end);
            s.advance(b"\x1b[H\x1b[2Jok");
            assert_eq!(
                text_of_row(&s, 0),
                "ok",
                "{}: text after the terminator",
                esc(opener)
            );
            if opener == b"\x1b]0;" || opener == b"\x1b]2;" {
                let t = s.frame().title.unwrap_or_default();
                assert_eq!(t.len(), MAX_TITLE_BYTES, "{}", esc(opener));
            }
            // Bounded however it was fed.
            let mut t = Screen::new(20, 4);
            t.advance(opener);
            for _ in 0..4096 {
                t.advance(&[b'A'; 1024]);
            }
            t.advance(end);
            t.advance(b"\x1b[H\x1b[2Jok");
            assert_eq!(text_of_row(&t, 0), "ok", "{} in 1 KiB feeds", esc(opener));
        }
    });
}

#[test]
fn kitty_stack_at_the_depth_limit() {
    with_deadline(120, || {
        for alt in [false, true] {
            let mut s = Screen::new(20, 4);
            if alt {
                s.advance(b"\x1b[?1049h");
            }
            let n = KITTY_STACK_MAX + 50;
            let flags = |i: usize| (i % 31 + 1) as u8;
            for i in 0..n {
                s.advance(format!("\x1b[>{}u", flags(i)).as_bytes());
                assert_eq!(s.frame().modes.kitty_keyboard, flags(i));
            }
            check_frame(&s, 10_000, 0).unwrap_or_else(|f| panic!("{}", f.detail));

            // The restored screen has the same flags on the same screen.
            let restored = Screen::restore(20, 4, &s.snapshot());
            assert_eq!(
                restored.frame().modes.kitty_keyboard,
                flags(n - 1),
                "alt {alt}"
            );
            assert_eq!(restored.frame().alt_screen, alt);

            // A pop returns to the previous entry; the oldest were dropped,
            // not the newest.
            s.advance(b"\x1b[<u");
            assert_eq!(s.frame().modes.kitty_keyboard, flags(n - 2), "alt {alt}");
            s.advance(b"\x1b[?u");
            assert_eq!(
                s.take_replies(),
                format!("\x1b[?{}u", flags(n - 2)).into_bytes()
            );

            // Popping more than is there empties the stack and stays at 0.
            s.advance(b"\x1b[<65535u\x1b[<u\x1b[<0u");
            assert_eq!(s.frame().modes.kitty_keyboard, 0);
            s.advance(b"\x1b[>5u");
            assert_eq!(s.frame().modes.kitty_keyboard, 5);

            // Flags are masked to the five defined bits.
            s.advance(b"\x1b[>65535u");
            assert!(s.frame().modes.kitty_keyboard <= 31);
            s.advance(b"\x1b[>99999999999999999999u\x1b[=255;1u");
            assert!(s.frame().modes.kitty_keyboard <= 31);

            // The two screens keep separate stacks.
            s.advance(if alt { b"\x1b[?1049l" } else { b"\x1b[?1049h" });
            s.advance(b"\x1b[>7u");
            assert_eq!(s.frame().modes.kitty_keyboard, 7);
            s.advance(if alt { b"\x1b[?1049h" } else { b"\x1b[?1049l" });
            assert!(s.frame().modes.kitty_keyboard <= 31);
            assert_ne!(s.frame().modes.kitty_keyboard, 7);
        }
    });
}

#[test]
fn resize_to_the_extremes_keeps_the_frame_consistent() {
    with_deadline(600, || {
        let sizes: &[(u16, u16)] = &[
            (1, 1),
            (0, 0),
            (2, 1),
            (1, 50),
            (3, 2),
            (65535, 65535),
            (2000, 1000),
            (2001, 1001),
            (1, 1),
            (80, 24),
            (65535, 1),
            (1, 65535),
            (2, 1),
        ];
        for alt in [false, true] {
            let mut s = Screen::with_scrollback(30, 8, 50);
            s.advance(WRAPPY.as_bytes());
            if alt {
                s.advance(b"\x1b[?1049h\x1b[2;4r\x1b[?6h");
            }
            let mut prev = s.seq();
            for &(c, r) in sizes {
                s.resize(c, r);
                let (ec, er) = clamp_size(c, r);
                assert_eq!((s.cols(), s.rows()), (ec, er), "resize {c}x{r}");
                check_frame(&s, 50, prev)
                    .unwrap_or_else(|f| panic!("after resize {c}x{r}: {}", f.detail));
                prev = s.seq();
                s.advance(WRAPPY.as_bytes());
                s.advance(b"\x1b[99999;99999Hx\x1b[1;1Hy\n\n\n\n");
                check_frame(&s, 50, prev)
                    .unwrap_or_else(|f| panic!("after content at {c}x{r}: {}", f.detail));
                prev = s.seq();
                let restored = Screen::restore(s.cols(), s.rows(), &s.snapshot());
                if let Some(d) = snapshot_diff(&s, &restored, &s.snapshot()) {
                    panic!("snapshot at {c}x{r} (alt {alt}): {d}");
                }
            }
        }
    });
}

#[test]
fn scrollback_never_exceeds_its_cap() {
    with_deadline(300, || {
        let lines = "x\r\n".repeat(50_000);
        for cap in [0usize, 1, 30, 10_000] {
            let mut s = Screen::with_scrollback(20, 5, cap);
            s.advance(lines.as_bytes());
            assert_eq!(s.scrollback_len(), cap, "cap {cap}");
            check_frame(&s, cap, 0).unwrap_or_else(|f| panic!("cap {cap}: {}", f.detail));
        }
        let mut s = Screen::with_scrollback(4, 2, usize::MAX);
        s.advance("x\r\n".repeat(1000).as_bytes());
        assert!(s.scrollback_len() <= MAX_SCROLLBACK);
        check_frame(&s, usize::MAX, 0).unwrap_or_else(|f| panic!("{}", f.detail));
    });
}

#[test]
fn replies_are_capped_whatever_is_asked() {
    with_deadline(300, || {
        let queries = [
            "\x1b[5n",
            "\x1b[6n",
            "\x1b[c",
            "\x1b[>c",
            "\x1b[?u",
            "\x1b]4;1;?\x07",
            "\x1b]10;?\x07",
        ];
        for q in queries {
            let mut s = Screen::new(10, 3);
            s.set_reply_colors(Some((1, 2, 3)), Some((4, 5, 6)), Some((7, 8, 9)));
            s.advance(q.repeat(20_000).as_bytes());
            let n = s.take_replies().len();
            assert!(
                n <= MAX_PENDING_REPLIES * 256,
                "{}: {n} reply bytes held",
                esc(q.as_bytes())
            );
            assert!(s.take_replies().is_empty());
        }
    });
}

#[test]
fn a_hostile_stream_costs_bounded_work() {
    // Every piece is big, none may take long. The deadline is what fails.
    with_deadline(300, || {
        let pieces: Vec<String> = vec![
            rep("\x1b[65535b", 500),
            rep("\x1b[65535S\x1b[65535T\x1b[65535L\x1b[65535M", 500),
            rep("\x1b[65535@\x1b[65535P\x1b[65535X", 500),
            rep("\x1b[1;1H\x1b[0J\x1b[3J", 5000),
            rep("\x1b[?1049h\x1b[?1049l", 5000),
            rep("\x1b[2;3r\n", 50_000),
            rep("a\u{301}", 100_000),
            rep("日", 100_000),
            rep("\x1b[>1u\x1b[<2u", 20_000),
        ];
        for sizes in [(2u16, 1u16), (80, 24), (300, 100)] {
            for p in &pieces {
                let mut s = Screen::with_scrollback(sizes.0, sizes.1, 100);
                s.advance(p.as_bytes());
                check_frame(&s, 100, 0).unwrap_or_else(|f| panic!("{}", f.detail));
            }
        }
    });
}
