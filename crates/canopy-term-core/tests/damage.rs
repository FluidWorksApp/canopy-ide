//! The incremental frame update (only rows the engine reports as damaged are
//! converted) must be indistinguishable from rebuilding and diffing the whole
//! grid. Every test runs two screens side by side, one in each mode, and
//! compares the whole `Frame` (sequence number included), `damage_since` for
//! recent baselines, snapshots and replies after every step. Independently of
//! the reference mode, it also checks that no row whose content changed is
//! missing from the reported damage. Synthetic input only, seeded.

#[path = "engines/stream.rs"]
mod stream;

use canopy_term_core::frame::Frame;
use canopy_term_core::Screen;

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

fn row_differs(a: &Frame, b: &Frame, r: u16) -> bool {
    (0..a.cols).any(|c| {
        let (x, y) = (a.cell(r, c).unwrap(), b.cell(r, c).unwrap());
        x.ch != y.ch || x.fg != y.fg || x.bg != y.bg || x.attrs != y.attrs || a.text(x) != b.text(y)
    })
}

fn covered(rows: &[(u16, u16)], r: u16) -> bool {
    rows.iter().any(|&(lo, hi)| lo <= r && r <= hi)
}

/// A first difference, not two whole frames.
fn assert_frames_equal(a: &Frame, b: &Frame, what: &str) {
    if a == b {
        return;
    }
    assert_eq!(a.seq, b.seq, "{what}: seq");
    assert_eq!((a.cols, a.rows), (b.cols, b.rows), "{what}: size");
    for r in 0..a.rows {
        for c in 0..a.cols {
            let (x, y) = (a.cell(r, c).unwrap(), b.cell(r, c).unwrap());
            assert_eq!(
                (a.text(x), x.fg, x.bg, x.attrs),
                (b.text(y), y.fg, y.bg, y.attrs),
                "{what}: cell row {r} col {c}"
            );
            assert_eq!(
                x.cluster, y.cluster,
                "{what}: cluster index row {r} col {c}"
            );
        }
    }
    assert_eq!(a.clusters, b.clusters, "{what}: cluster table");
    assert_eq!(a.cursor, b.cursor, "{what}: cursor");
    assert_eq!(a.modes, b.modes, "{what}: modes");
    assert_eq!(a.alt_screen, b.alt_screen, "{what}: alt screen");
    assert_eq!(a.title, b.title, "{what}: title");
    panic!("{what}: frames differ in a field this helper does not name");
}

/// An incremental screen and a reference (full rebuild) screen fed the same
/// input, with the frames a consumer would remember as baselines.
struct Pair {
    inc: Screen,
    reference: Screen,
    history: Vec<Frame>,
}

impl Pair {
    fn new(cols: u16, rows: u16) -> Self {
        Self::wrap(Screen::new(cols, rows), Screen::new(cols, rows))
    }

    fn wrap(inc: Screen, mut reference: Screen) -> Self {
        reference.set_full_rebuild(true);
        let mut p = Pair {
            inc,
            reference,
            history: Vec::new(),
        };
        p.history.push(p.inc.frame());
        p.check("start");
        p
    }

    fn advance(&mut self, bytes: &[u8], what: &str) {
        self.inc.advance(bytes);
        self.reference.advance(bytes);
        self.check(what);
    }

    fn resize(&mut self, cols: u16, rows: u16, what: &str) {
        self.inc.resize(cols, rows);
        self.reference.resize(cols, rows);
        self.check(what);
    }

    fn check(&mut self, what: &str) {
        let cur = self.inc.frame();
        assert_frames_equal(&cur, &self.reference.frame(), what);
        assert_eq!(self.inc.seq(), self.reference.seq(), "{what}: seq()");
        assert_eq!(
            self.inc.snapshot(),
            self.reference.snapshot(),
            "{what}: snapshot"
        );
        assert_eq!(
            self.inc.take_replies(),
            self.reference.take_replies(),
            "{what}: replies"
        );
        assert_eq!(
            self.inc.damage_since(0),
            self.reference.damage_since(0),
            "{what}: damage_since(0)"
        );
        for base in &self.history {
            let (d, dr) = (
                self.inc.damage_since(base.seq),
                self.reference.damage_since(base.seq),
            );
            assert_eq!(d, dr, "{what}: damage_since({})", base.seq);
            if d.full {
                continue;
            }
            assert_eq!(
                (base.cols, base.rows),
                (cur.cols, cur.rows),
                "{what}: size change must be full"
            );
            assert_eq!(
                base.alt_screen, cur.alt_screen,
                "{what}: alt switch must be full"
            );
            for r in 0..cur.rows {
                if row_differs(base, &cur, r) {
                    assert!(
                        covered(&d.rows, r),
                        "{what}: row {r} changed since seq {} but is not in damage {:?}",
                        base.seq,
                        d.rows
                    );
                }
            }
            if base.cursor != cur.cursor {
                assert!(covered(&d.rows, base.cursor.row), "{what}: old cursor row");
                assert!(covered(&d.rows, cur.cursor.row), "{what}: new cursor row");
            }
        }
        if self.history.last().map(|f| f.seq) != Some(cur.seq) {
            self.history.push(cur);
            if self.history.len() > 12 {
                self.history.remove(0);
            }
        }
    }
}

const MIXED: &str = "plain\r\n\
    \x1b[1;31mred bold\x1b[0m \x1b[38;2;10;20;30mrgb\x1b[0m \x1b[48;5;200mbg\x1b[0m\r\n\
    日本語 e\u{301}x a\u{308}\u{301}\r\n\
    \x1b[2mdim\x1b[0m \x1b[3mital\x1b[0m \x1b[4mul\x1b[0m \x1b[7minv\x1b[0m \x1b[9mstrike\x1b[0m \x1b[8mhid\x1b[0m\
    \x1b[6;10Hcursor here\x1b]2;a title\x07\x1b[1;34m\x1b[4;2H";

const ALL_MODES: &str =
    "\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?1h\x1b=\x1b[?1004h\x1b[?2026h\x1b[>5u";

/// Fixture inputs: (name, cols, rows, bytes).
fn fixtures() -> Vec<(&'static str, u16, u16, Vec<u8>)> {
    let f = |n: &'static str, c: u16, r: u16, s: &str| (n, c, r, s.as_bytes().to_vec());
    vec![
        f("mixed content", 30, 8, MIXED),
        f("all modes", 30, 8, ALL_MODES),
        f("plain text and CRLF", 20, 4, "hello\r\nworld"),
        f("hidden cursor and shape", 20, 4, "hi\x1b[?25l\x1b[4 q"),
        f("wrap off", 10, 3, "\x1b[?7lAAAAAAAAAAAAAAA"),
        f("coloured blank cells", 12, 3, "\x1b[44m\x1b[2J\x1b[2;3Hx"),
        f("wide char at the right edge", 5, 3, "abcd日e"),
        f("soft wrap", 10, 4, "0123456789ABCDEFGHIJ\r\nx"),
        f("tabs", 20, 2, "a\tb\tc"),
        f("scroll off the top", 10, 3, "1\r\n2\r\n3\r\n4\r\n5\r\n"),
        f("scroll region", 10, 6, "\x1b[2;4r\x1b[4;1Ha\nb\nc\nd\x1b[r"),
        f(
            "alt screen",
            10,
            4,
            "main\x1b[?1049hALT\x1b[2J\x1b[?1049lback",
        ),
        f("insert mode", 10, 2, "abcdef\x1b[1;3H\x1b[4hXY\x1b[4l"),
        f(
            "erase and delete chars",
            10,
            2,
            "abcdefghij\x1b[1;3H\x1b[2P\x1b[3@\x1b[2X",
        ),
        f(
            "line insert delete",
            8,
            5,
            "1\r\n2\r\n3\r\n4\x1b[2;1H\x1b[2L\x1b[M",
        ),
        f("reset", 10, 3, "abc\x1b]2;t\x07\x1bcdef"),
        f("decaln", 6, 3, "\x1b#8x"),
        f("combining marks", 10, 2, "e\u{301}\u{302}\u{303}a\u{308} b"),
        f("title", 10, 2, "\x1b]2;one\x07x\x1b]2;two\x07"),
    ]
}

#[test]
fn fixtures_match_the_full_rebuild_whole_and_split_at_every_byte() {
    for (name, cols, rows, bytes) in fixtures() {
        let mut whole = Pair::new(cols, rows);
        whole.advance(&bytes, name);

        let mut split = Pair::new(cols, rows);
        for (i, b) in bytes.iter().enumerate() {
            split.advance(&[*b], &format!("{name}, byte {i}"));
        }
        assert_frames_equal(
            &{
                let mut f = whole.inc.frame();
                f.seq = 0;
                f
            },
            &{
                let mut f = split.inc.frame();
                f.seq = 0;
                f
            },
            &format!("{name}: whole vs byte by byte"),
        );
    }
}

#[test]
fn full_redraws_are_still_full() {
    for (name, cols, rows, bytes) in fixtures() {
        let mut p = Pair::new(cols, rows);
        p.advance(&bytes, name);

        let before = p.inc.seq();
        p.resize(cols + 3, rows + 1, "resize");
        assert!(p.inc.damage_since(before).full, "{name}: resize is full");
        p.resize(cols, rows, "resize back");

        let before = p.inc.seq();
        p.advance(b"\x1b[?1049h", "enter alt");
        assert!(p.inc.damage_since(before).full, "{name}: alt enter is full");
        p.advance(b"X\x1b[?1049l", "leave alt");
        assert!(p.inc.damage_since(before).full, "{name}: alt leave is full");

        // A snapshot restore is a fresh screen: no baseline, full.
        let snap = p.inc.snapshot();
        let restored = Screen::restore(cols, rows, &snap);
        assert!(restored.damage_since(0).full, "{name}: restore is full");
        let mut q = Pair::wrap(
            Screen::restore(cols, rows, &snap),
            Screen::restore(cols, rows, &snap),
        );
        q.advance(
            b"\x1b[1;1Hmore\r\nlines\r\n",
            &format!("{name}: after restore"),
        );
    }
}

#[test]
fn scroll_and_cursor_changes_damage_the_rows_that_changed() {
    let mut p = Pair::new(10, 5);
    p.advance(b"\x1b[2;1Hab", "place");
    let before = p.inc.seq();
    p.advance(b"\x1b[4;1H", "cursor only");
    let d = p.inc.damage_since(before);
    assert!(!d.full);
    assert_eq!(d.rows, vec![(1, 1), (3, 3)], "old and new cursor rows");

    p.advance(b"\x1b[5;1H", "to bottom");
    let before = p.inc.seq();
    p.advance(b"\n", "scroll");
    let d = p.inc.damage_since(before);
    assert!(!d.full, "a scroll is not a full redraw, only changed rows");
    assert!(
        covered(&d.rows, 0),
        "text moved up out of row 1 into row 0 region"
    );
}

#[test]
fn a_write_the_screen_already_shows_is_not_new_damage() {
    let mut p = Pair::new(10, 3);
    p.advance(b"abc", "first");
    let before = p.inc.seq();
    p.advance(b"\r", "cr");
    p.advance(b"abc", "rewrite same text");
    // Cursor ends where it began, so nothing observable changed overall.
    assert_eq!(p.inc.frame().cursor.col, 3);
    let d = p.inc.damage_since(before);
    assert!(d.rows.iter().all(|&(lo, hi)| lo == 0 && hi == 0));
}

#[test]
fn the_synthetic_stream_matches_the_full_rebuild() {
    let data = stream::synthetic_stream(256 * 1024);
    for (cols, rows, chunk) in [(80u16, 24u16, 4096usize), (17, 5, 61), (200, 50, 1000)] {
        let mut p = Pair::new(cols, rows);
        for (i, c) in data.chunks(chunk).enumerate() {
            p.advance(c, &format!("{cols}x{rows} chunk {i}"));
        }
    }
}

const WORDS: &[&str] = &[
    "alpha",
    "beta",
    "x",
    "日本",
    "e\u{301}",
    "\u{1F600}",
    "a\u{308}\u{301}\u{302}",
    " ",
    "  ",
];

/// One random step of a plausible byte stream.
fn random_piece(rng: &mut Lcg, rows: u64, cols: u64, out: &mut Vec<u8>) {
    let n = |rng: &mut Lcg, m: u64| 1 + rng.below(m);
    match rng.below(34) {
        0..=7 => out.extend_from_slice(WORDS[rng.below(WORDS.len() as u64) as usize].as_bytes()),
        8 => out.extend_from_slice(b"\r\n"),
        9 => out.push(b'\r'),
        10 => out.push(b'\n'),
        11 => out.push(b'\t'),
        12 => out.push(8),
        13 => out.extend_from_slice(
            format!("\x1b[{};{}H", n(rng, rows + 2), n(rng, cols + 2)).as_bytes(),
        ),
        14 => out.extend_from_slice(
            format!(
                "\x1b[{}{}",
                n(rng, 6),
                ['A', 'B', 'C', 'D'][rng.below(4) as usize]
            )
            .as_bytes(),
        ),
        15 => out.extend_from_slice(format!("\x1b[{}K", rng.below(3)).as_bytes()),
        16 => out.extend_from_slice(format!("\x1b[{}J", rng.below(4)).as_bytes()),
        17 => out.extend_from_slice(
            format!(
                "\x1b[{}{}",
                n(rng, 5),
                ['X', 'P', '@', 'L', 'M'][rng.below(5) as usize]
            )
            .as_bytes(),
        ),
        18 => out.extend_from_slice(
            format!("\x1b[{}{}", n(rng, 4), ['S', 'T'][rng.below(2) as usize]).as_bytes(),
        ),
        19 => {
            let top = n(rng, rows);
            let bottom = top + rng.below(rows);
            out.extend_from_slice(format!("\x1b[{top};{bottom}r").as_bytes());
        }
        20 => out.extend_from_slice(b"\x1b[r"),
        21 => out
            .extend_from_slice(format!("\x1b[{};{}m", rng.below(10), 30 + rng.below(8)).as_bytes()),
        22 => out.extend_from_slice(
            format!(
                "\x1b[38;5;{};48;2;{};{};{}m",
                rng.below(256),
                rng.below(256),
                rng.below(256),
                rng.below(256)
            )
            .as_bytes(),
        ),
        23 => out.extend_from_slice(b"\x1b[0m"),
        24 => out.extend_from_slice(
            [
                &b"\x1b[?1049h"[..],
                b"\x1b[?1049l",
                b"\x1b[?47h",
                b"\x1b[?47l",
            ][rng.below(4) as usize],
        ),
        25 => out.extend_from_slice(
            [
                &b"\x1b[4h"[..],
                b"\x1b[4l",
                b"\x1b[?7l",
                b"\x1b[?7h",
                b"\x1b[?6h",
                b"\x1b[?6l",
            ][rng.below(6) as usize],
        ),
        26 => out.extend_from_slice(
            [
                &b"\x1b[?25l"[..],
                b"\x1b[?25h",
                b"\x1b[3 q",
                b"\x1b[?2004h",
                b"\x1b[?1002h",
                b"\x1b[?1006h",
            ][rng.below(6) as usize],
        ),
        27 => out.extend_from_slice(format!("\x1b]2;title {}\x07", rng.below(5)).as_bytes()),
        28 => out.extend_from_slice(
            [
                &b"\x1bM"[..],
                b"\x1bD",
                b"\x1bE",
                b"\x1b7",
                b"\x1b8",
                b"\x1b#8",
            ][rng.below(6) as usize],
        ),
        29 => out.extend_from_slice(b"\x1bc"),
        30 => out.extend_from_slice(b"\x1b[5n\x1b[6n\x1b[c"),
        31 => out.extend_from_slice("\u{301}".repeat(1 + rng.below(20) as usize).as_bytes()),
        32 => out.extend_from_slice(format!("\x1b[{}b", n(rng, 8)).as_bytes()),
        _ => {
            // Raw bytes, valid UTF-8 or not.
            for _ in 0..(1 + rng.below(6)) {
                out.push(rng.below(256) as u8);
            }
        }
    }
}

#[test]
fn randomized_streams_match_the_full_rebuild() {
    for (seed, (cols, rows)) in [(5u16, 3u16), (12, 4), (20, 6), (33, 9), (80, 24)]
        .into_iter()
        .enumerate()
    {
        for round in 0..3u64 {
            let mut rng = Lcg(0xC0FFEE ^ (seed as u64 * 7919 + round * 104729 + 1));
            let (mut c, mut r) = (cols, rows);
            let mut p = Pair::new(c, r);
            for step in 0..300 {
                let mut bytes = Vec::new();
                for _ in 0..(1 + rng.below(8)) {
                    random_piece(&mut rng, r as u64, c as u64, &mut bytes);
                }
                let what = format!("seed {seed} round {round} step {step} ({c}x{r})");
                match rng.below(40) {
                    0 => {
                        c = 2 + rng.below(40) as u16;
                        r = 1 + rng.below(12) as u16;
                        p.resize(c, r, &what);
                    }
                    1 => {
                        // Snapshot restore mid-stream, then keep going.
                        let snap = p.inc.snapshot();
                        p = Pair::wrap(Screen::restore(c, r, &snap), Screen::restore(c, r, &snap));
                    }
                    _ => {
                        // Random split points, including single bytes.
                        let mut at = 0;
                        while at < bytes.len() {
                            let take = (1 + rng.below(9) as usize).min(bytes.len() - at);
                            p.advance(&bytes[at..at + take], &what);
                            at += take;
                        }
                    }
                }
            }
        }
    }
}
