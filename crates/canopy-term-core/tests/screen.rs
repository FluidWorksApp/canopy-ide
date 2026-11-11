//! Must-prove behaviour of `Screen`. Synthetic fixtures only.

use canopy_term_core::frame::{Attrs, Color, Damage, Frame, MouseEncoding, MouseMode};
use canopy_term_core::Screen;

/// A frame with the per-observer fields cleared, so two screens in the same
/// state compare equal however they got there.
fn norm(mut f: Frame) -> Frame {
    f.seq = 0;
    f.damage = Damage::default();
    f
}

fn row_text(f: &Frame, r: u16) -> String {
    let mut s = String::new();
    for c in 0..f.cols {
        let cell = f.cell(r, c).unwrap();
        if cell.attrs.has(Attrs::WIDE_TAIL) {
            continue;
        }
        s.push_str(&f.text(cell));
    }
    s.trim_end().to_string()
}

fn screen_text(f: &Frame) -> Vec<String> {
    (0..f.rows).map(|r| row_text(f, r)).collect()
}

/// Panics with the first difference rather than dumping two whole frames.
fn assert_same(a: &Frame, b: &Frame, what: &str) {
    let (a, b) = (norm(a.clone()), norm(b.clone()));
    if a == b {
        return;
    }
    assert_eq!((a.cols, a.rows), (b.cols, b.rows), "{what}: size");
    assert_eq!(screen_text(&a), screen_text(&b), "{what}: text");
    for (i, (x, y)) in a.cells.iter().zip(&b.cells).enumerate() {
        let (r, c) = (i / a.cols as usize, i % a.cols as usize);
        let (xt, yt) = (a.text(x), b.text(y));
        assert_eq!(
            (xt, x.fg, x.bg, x.attrs),
            (yt, y.fg, y.bg, y.attrs),
            "{what}: cell at row {r} col {c}"
        );
    }
    assert_eq!(a.cursor, b.cursor, "{what}: cursor");
    assert_eq!(a.modes, b.modes, "{what}: modes");
    assert_eq!(a.alt_screen, b.alt_screen, "{what}: alt screen");
    assert_eq!(a.title, b.title, "{what}: title");
    assert_eq!(a.clusters, b.clusters, "{what}: cluster table");
    panic!("{what}: frames differ in a field this helper does not name");
}

fn fed(cols: u16, rows: u16, bytes: &[u8]) -> Screen {
    let mut s = Screen::new(cols, rows);
    s.advance(bytes);
    s
}

const MIXED: &str = "plain\r\n\
    \x1b[1;31mred bold\x1b[0m \x1b[38;2;10;20;30mrgb\x1b[0m \x1b[48;5;200mbg\x1b[0m\r\n\
    日本語 e\u{301}x a\u{308}\u{301}\r\n\
    \x1b[2mdim\x1b[0m \x1b[3mital\x1b[0m \x1b[4mul\x1b[0m \x1b[7minv\x1b[0m \x1b[9mstrike\x1b[0m \x1b[8mhid\x1b[0m\
    \x1b[6;10Hcursor here\x1b]2;a title\x07\x1b[1;34m\x1b[4;2H";

const ALL_MODES: &str =
    "\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?1h\x1b=\x1b[?1004h\x1b[?2026h\x1b[>5u";

#[test]
fn snapshot_round_trip_equals_the_live_frame() {
    let cases: &[(&str, u16, u16, &str)] = &[
        ("mixed content", 30, 8, MIXED),
        ("all modes", 30, 8, ALL_MODES),
        ("hidden cursor and shape", 20, 4, "hi\x1b[?25l\x1b[4 q"),
        ("wrap off", 10, 3, "\x1b[?7lAAAAAAAAAAAAAAA"),
        ("coloured blank cells", 12, 3, "\x1b[44m\x1b[2J\x1b[2;3Hx"),
        ("wide char at the right edge", 5, 3, "abcd日e"),
        (
            "alt screen",
            20,
            4,
            "main\x1b[?1049h\x1b[2J\x1b[Halt text\x1b[2;5H",
        ),
    ];
    for (name, cols, rows, input) in cases {
        let live = fed(*cols, *rows, input.as_bytes());
        let snap = live.snapshot();
        let restored = Screen::restore(*cols, *rows, &snap);
        assert_same(&live.frame(), &restored.frame(), name);
    }
}

#[test]
fn restored_screen_continues_identically() {
    // A plain round trip passes even if the pen, wrap mode or scrolling were
    // not restored; feeding more output to both would expose that.
    let extra = "Z\r\nl1\r\nl2\r\nl3\r\nl4\r\nl5\r\nl6\r\nl7\r\n\x1b[2Kend\x1b[1;1Hhome";
    for (name, input) in [("mixed", MIXED), ("modes", ALL_MODES)] {
        let mut live = fed(30, 8, input.as_bytes());
        let mut restored = Screen::restore(30, 8, &live.snapshot());
        live.advance(extra.as_bytes());
        restored.advance(extra.as_bytes());
        assert_same(&live.frame(), &restored.frame(), name);
    }
}

#[test]
fn snapshot_split_at_every_byte_restores_the_same_screen() {
    let live = fed(30, 8, MIXED.as_bytes());
    let snap = live.snapshot();
    for i in 1..snap.len() {
        let mut s = Screen::new(30, 8);
        s.advance(&snap[..i]);
        s.advance(&snap[i..]);
        assert_same(&live.frame(), &s.frame(), &format!("snapshot split at {i}"));
    }
}

#[test]
fn input_split_at_every_byte_gives_identical_frames() {
    let inputs = [
        MIXED,
        ALL_MODES,
        "ab\x1b[?1049hx\x1b[2;3Hy\x1b[?1049lz",
        "\x1b[?1004h\x1bc\x1b[?1004h",
        "\x1b[?1004h\x1bc",
        "q\x1b]2;t\x07\x1bcr\x1b]2;u\x1b\\",
        "日本e\u{301}\x1b[?9h\x1b[>3u\x1b[<u\x1b[>9u",
    ];
    for input in inputs {
        let bytes = input.as_bytes();
        let whole = fed(20, 5, bytes);
        for i in 1..bytes.len() {
            let mut s = Screen::new(20, 5);
            s.advance(&bytes[..i]);
            s.advance(&bytes[i..]);
            assert_same(
                &whole.frame(),
                &s.frame(),
                &format!("{input:?} split at {i}"),
            );
        }
    }
}

#[test]
fn alt_screen_enter_and_leave() {
    let mut s = fed(20, 4, b"main text");
    assert!(!s.frame().alt_screen);
    s.advance(b"\x1b[?1049h\x1b[2J\x1b[Halt text");
    let f = s.frame();
    assert!(f.alt_screen);
    assert_eq!(row_text(&f, 0), "alt text");
    s.advance(b"\x1b[?1049l");
    let f = s.frame();
    assert!(!f.alt_screen);
    assert_eq!(row_text(&f, 0), "main text");
}

#[test]
fn snapshot_of_the_alt_screen_does_not_carry_the_primary_screen_behind_it() {
    // Known gap, pinned so it is not forgotten: the engine does not expose the
    // inactive grid, so a client attached on the alt screen sees a blank
    // primary screen after the program leaves it.
    let live = fed(20, 4, b"main text\x1b[?1049h\x1b[2J\x1b[Halt");
    let mut restored = Screen::restore(20, 4, &live.snapshot());
    assert_same(&live.frame(), &restored.frame(), "while on alt");
    let mut live = live;
    live.advance(b"\x1b[?1049l");
    restored.advance(b"\x1b[?1049l");
    assert_eq!(row_text(&live.frame(), 0), "main text");
    assert_eq!(row_text(&restored.frame(), 0), "");
}

#[test]
fn wide_chars_and_combining_marks_use_the_cluster_table() {
    let f = fed(20, 3, "a日b e\u{301}x".as_bytes()).frame();
    assert_eq!(f.cell(0, 0).unwrap().ch, 'a');
    assert_eq!(f.cell(0, 1).unwrap().ch, '日');
    let tail = f.cell(0, 2).unwrap();
    assert!(tail.attrs.has(Attrs::WIDE_TAIL));
    assert_eq!(tail.ch, '\0');
    assert_eq!(f.cell(0, 3).unwrap().ch, 'b');
    let e = f.cell(0, 5).unwrap();
    assert_eq!(e.ch, 'e', "ch stays the first scalar");
    assert_ne!(e.cluster, 0);
    assert_eq!(f.text(e), "e\u{301}");
    assert_eq!(f.clusters.len(), 2, "index 0 unused plus one cluster");
    assert_eq!(f.cell(0, 6).unwrap().ch, 'x');
    assert_eq!(f.cursor.col, 7);
}

#[test]
fn modes_survive_a_snapshot() {
    let live = fed(30, 8, ALL_MODES.as_bytes());
    let m = live.frame().modes;
    assert_eq!(m.mouse, MouseMode::Drag);
    assert_eq!(m.mouse_encoding, MouseEncoding::Sgr);
    assert!(m.bracketed_paste);
    assert!(m.app_cursor_keys);
    assert!(m.app_keypad);
    assert!(m.focus_events);
    assert!(m.sync_output);
    assert_eq!(m.kitty_keyboard, 5);
    let snap = live.snapshot();
    assert!(
        snap.ends_with(b"\x1b[?2026h"),
        "synchronized output must be the last thing a restore sets"
    );
    assert_eq!(Screen::restore(30, 8, &snap).frame().modes, m);
}

#[test]
fn every_mouse_mode_and_encoding_survives_a_snapshot() {
    for (seq, mode) in [
        ("\x1b[?9h", MouseMode::Press),
        ("\x1b[?1000h", MouseMode::Normal),
        ("\x1b[?1002h", MouseMode::Drag),
        ("\x1b[?1003h", MouseMode::Any),
    ] {
        let live = fed(10, 3, seq.as_bytes());
        assert_eq!(live.frame().modes.mouse, mode, "{seq:?}");
        let restored = Screen::restore(10, 3, &live.snapshot());
        assert_eq!(restored.frame().modes.mouse, mode, "{seq:?} restored");
    }
    let live = fed(10, 3, b"\x1b[?1000h\x1b[?1005h");
    assert_eq!(live.frame().modes.mouse_encoding, MouseEncoding::Utf8);
    let restored = Screen::restore(10, 3, &live.snapshot());
    assert_eq!(restored.frame().modes.mouse_encoding, MouseEncoding::Utf8);
}

#[test]
fn text_sent_during_synchronized_output_reaches_the_grid_at_once() {
    // The frame says "hold" (sync_output); the grid is never behind the bytes,
    // so a snapshot taken mid-update is complete.
    let mut s = fed(10, 2, b"\x1b[?2026hX");
    assert!(s.frame().modes.sync_output);
    assert_eq!(row_text(&s.frame(), 0), "X");
    s.advance(b"\x1b[?2026l");
    assert!(!s.frame().modes.sync_output);
}

#[test]
fn reset_clears_tracked_modes_and_title_in_stream_order() {
    let s = fed(
        10,
        3,
        b"junk\x1b[?1004h\x1b[?2004h\x1b[?9h\x1b[?2026h\x1b[>5u\x1b]2;t\x07\x1bc",
    );
    let f = s.frame();
    assert_eq!(f.modes, Default::default());
    assert_eq!(f.title, None);
    assert_eq!(screen_text(&f), vec!["", "", ""]);

    // A mode set after the reset in the same chunk survives it, and a title
    // set after a reset is not wiped by it.
    let f = fed(10, 3, b"\x1b[?1004h\x1bc\x1b[?1004h").frame();
    assert!(f.modes.focus_events);
    let f = fed(10, 3, b"\x1b]2;a\x07\x1bc\x1b]2;b\x07").frame();
    assert_eq!(f.title.as_deref(), Some("b"));

    // ESC and c delivered in separate calls are still a reset.
    let mut s = fed(10, 3, b"x\x1b[?1004h\x1b");
    s.advance(b"c");
    assert!(!s.frame().modes.focus_events);
    assert_eq!(row_text(&s.frame(), 0), "");
}

#[test]
fn title_survives_a_snapshot() {
    let live = fed(20, 3, b"\x1b]2;my title\x07hi");
    assert_eq!(live.frame().title.as_deref(), Some("my title"));
    assert_eq!(
        Screen::restore(20, 3, &live.snapshot())
            .frame()
            .title
            .as_deref(),
        Some("my title")
    );
}

#[test]
fn scrollback_is_not_in_the_snapshot_but_can_be_read() {
    let mut s = Screen::with_scrollback(10, 3, 100);
    s.advance(b"1\r\n2\r\n3\r\n4\r\n5\r\n6");
    assert_eq!(s.scrollback_len(), 3);
    assert_eq!(s.scrollback_row(0).unwrap().text(), "1", "0 is the oldest");
    assert_eq!(s.scrollback_row(2).unwrap().text(), "3");
    assert!(s.scrollback_row(3).is_none());
    assert_eq!(screen_text(&s.frame()), vec!["4", "5", "6"]);

    let restored = Screen::restore(10, 3, &s.snapshot());
    assert_eq!(restored.scrollback_len(), 0, "scrollback is not restored");
    assert!(restored.scrollback_row(0).is_none());
    assert_eq!(screen_text(&restored.frame()), vec!["4", "5", "6"]);
}

#[test]
fn resize_reflows_wrapped_lines() {
    // Documented behaviour: widening rejoins a line that was wrapped, and
    // shrinking the height pushes the top rows into scrollback.
    let mut s = fed(10, 4, b"0123456789ABCDE");
    assert_eq!(screen_text(&s.frame()), vec!["0123456789", "ABCDE", "", ""]);
    s.resize(20, 4);
    let f = s.frame();
    assert_eq!((f.cols, f.rows), (20, 4));
    assert_eq!(row_text(&f, 0), "0123456789ABCDE");
    assert_eq!(row_text(&f, 1), "");

    let mut s = fed(10, 4, b"a\r\nb\r\nc\r\nd");
    s.resize(10, 2);
    assert_eq!(screen_text(&s.frame()), vec!["c", "d"]);
    assert_eq!(s.scrollback_len(), 2);
}

#[test]
fn damage_is_relative_to_the_consumers_sequence() {
    let mut s = Screen::new(10, 4);
    let first = s.seq();
    assert!(s.damage_since(0).full, "no baseline means full");

    s.advance(b"hi");
    let after_hi = s.seq();
    assert!(after_hi > first);
    assert_eq!(
        s.damage_since(first),
        Damage {
            since: first,
            full: false,
            rows: vec![(0, 0)]
        }
    );

    s.advance(b"\x1b[3;1Hx");
    // Row 0 (cursor left it), row 2 (text and cursor).
    assert_eq!(s.damage_since(after_hi).rows, vec![(0, 0), (2, 2)]);
    assert_eq!(s.damage_since(first).rows, vec![(0, 0), (2, 2)]);
    assert!(s.damage_since(s.seq()).rows.is_empty());
    assert!(
        s.damage_since(s.seq() + 5).full,
        "future baseline is unknown"
    );

    let before = s.seq();
    s.advance(b"\x1b[?25h");
    s.advance(b"");
    assert_eq!(s.seq(), before, "no change, no new sequence");

    s.advance(b"\x1b[?2004h");
    assert!(s.seq() > before, "a mode change is a change");
    let d = s.damage_since(before);
    assert!(!d.full && d.rows.is_empty(), "but it damages no rows");

    let before = s.seq();
    s.resize(12, 5);
    assert!(s.damage_since(before).full, "resize is a full redraw");
    let before = s.seq();
    s.advance(b"\x1b[?1049h");
    assert!(s.damage_since(before).full, "alt screen switch is full");
}

#[test]
fn colours_and_attributes_reach_the_frame() {
    let f = fed(
        20,
        2,
        b"\x1b[1;31mR\x1b[0m\x1b[38;2;1;2;3mT\x1b[48;5;9mU\x1b[0m",
    )
    .frame();
    let r = f.cell(0, 0).unwrap();
    assert!(r.attrs.has(Attrs::BOLD));
    assert_eq!(r.fg, Color::Indexed(1));
    assert_eq!(f.cell(0, 1).unwrap().fg, Color::Rgb(1, 2, 3));
    assert_eq!(f.cell(0, 2).unwrap().bg, Color::Indexed(9));
    let a = fed(20, 2, b"\x1b[9ms\x1b[8mh").frame();
    assert!(a.cell(0, 0).unwrap().attrs.has(Attrs::STRIKE));
    assert!(a.cell(0, 1).unwrap().attrs.has(Attrs::HIDDEN));
}
