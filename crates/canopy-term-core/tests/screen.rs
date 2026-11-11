//! Must-prove behaviour of `Screen`. Synthetic fixtures only.

use canopy_term_core::event::{
    ClipboardPolicy, ClipboardTarget, Event, SemanticMark, MAX_CLIPBOARD_TEXT,
};
use canopy_term_core::frame::{
    Attrs, Color, CursorShape, Damage, Frame, MouseEncoding, MouseMode, RowMark,
};
use canopy_term_core::screen::{
    MAX_CLUSTER_SCALARS, MAX_FRAME_LINKS, MAX_OSC_BYTES, MAX_TITLE_BYTES, MAX_URI_BYTES,
    PALETTE_BACKGROUND, PALETTE_CURSOR, PALETTE_FOREGROUND,
};
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
    assert_eq!(a.links, b.links, "{what}: link table");
    assert_eq!(a.link_ids, b.link_ids, "{what}: link ids");
    assert_eq!(
        a.underline_colors, b.underline_colors,
        "{what}: underline colours"
    );
    assert_eq!(a.marks, b.marks, "{what}: marks");
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
        ("tabs", 30, 3, "a\tb\tc\r\n\x1b[41mx\ty"),
        ("soft wrap", 10, 4, "0123456789ABCDE\r\nnext"),
        ("soft wrap into a blank row", 5, 4, "abcde\r\n"),
        (
            "terminal modes",
            20,
            6,
            "\x1b[2;5r\x1b[?6h\x1b[4h\x1b[20h\x1b[?1007l\x1b[3;2Hx",
        ),
        (
            "both mouse encodings and X10",
            10,
            3,
            "\x1b[?1000h\x1b[?9h\x1b[?1005h\x1b[?1006h",
        ),
        ("blinking bar", 10, 3, "\x1b[5 q"),
        (
            "kitty on both screens",
            10,
            3,
            "\x1b[>1u\x1b[>3u\x1b[?1049h\x1b[>5u\x1b[=4;2u",
        ),
    ];
    for (name, cols, rows, input) in cases {
        let live = fed(*cols, *rows, input.as_bytes());
        let snap = live.snapshot();
        let restored = Screen::restore(*cols, *rows, &snap);
        assert_same(&live.frame(), &restored.frame(), name);
        assert_eq!(
            String::from_utf8_lossy(&restored.snapshot()),
            String::from_utf8_lossy(&snap),
            "{name}: snapshot of the restored screen"
        );
    }
}

#[test]
fn restored_screen_continues_identically() {
    // A plain round trip passes even if the pen, wrap mode or scrolling were
    // not restored; feeding more output to both would expose that.
    let extra = "\ttab\r\nZ\r\nl1\r\nl2\r\nl3\r\nl4\r\nl5\r\nl6\r\nl7\r\n\x1b[2Kend\x1b[1;1Hhome";
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
        "a\tb\tc\x1b[?9h\x1b[?1000h\x1b[?1000l",
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
        // And one byte at a time, which exercises the ESC carry on every byte.
        let mut s = Screen::new(20, 5);
        for b in bytes {
            s.advance(std::slice::from_ref(b));
        }
        assert_same(
            &whole.frame(),
            &s.frame(),
            &format!("{input:?} byte by byte"),
        );
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
fn a_later_mouse_mode_supersedes_x10() {
    let live = fed(10, 3, b"\x1b[?9h\x1b[?1000h\x1b[?1000l");
    assert_eq!(live.frame().modes.mouse, MouseMode::Off);
    let restored = Screen::restore(10, 3, &live.snapshot());
    assert_eq!(restored.frame().modes.mouse, MouseMode::Off);
}

#[test]
fn tabs_move_the_cursor_and_leave_blanks() {
    let f = fed(20, 2, b"a\tb").frame();
    assert_eq!(f.cell(0, 0).unwrap().ch, 'a');
    assert_eq!(f.cell(0, 1).unwrap().ch, ' ', "no TAB character in a cell");
    assert_eq!(f.cell(0, 8).unwrap().ch, 'b', "default tab stop every 8");
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

#[test]
fn scroll_region_survives_a_snapshot() {
    // Rows 2..=4 scroll; rows 1 and 5 stay put. The restored screen must
    // scroll the same rows when more output arrives.
    let input = "\x1b[2;4r\x1b[1;1Htop\x1b[5;1Hbottom\x1b[2;1Hr1\r\nr2\r\nr3";
    let extra = "\r\nX\r\nY";
    let mut live = fed(20, 6, input.as_bytes());
    let mut restored = Screen::restore(20, 6, &live.snapshot());
    assert_same(&live.frame(), &restored.frame(), "before scrolling");
    live.advance(extra.as_bytes());
    restored.advance(extra.as_bytes());
    assert_eq!(
        screen_text(&live.frame()),
        vec!["top", "r3", "X", "Y", "bottom", ""],
        "the region scrolled, the rows outside it did not"
    );
    assert_same(&live.frame(), &restored.frame(), "after scrolling");

    // Reset to the whole screen, and the snapshot carries that too.
    let mut live = fed(20, 6, format!("{input}\x1b[r").as_bytes());
    let mut restored = Screen::restore(20, 6, &live.snapshot());
    live.advance(b"\x1b[6;1H\r\nZ");
    restored.advance(b"\x1b[6;1H\r\nZ");
    assert_same(&live.frame(), &restored.frame(), "region reset");
}

#[test]
fn cursor_style_survives_a_snapshot() {
    for (seq, shape) in [
        ("\x1b[2 q", CursorShape::Block),
        ("\x1b[4 q", CursorShape::Underline),
        ("\x1b[6 q", CursorShape::Bar),
        ("\x1b[5 q", CursorShape::Bar),
    ] {
        let live = fed(10, 3, seq.as_bytes());
        assert_eq!(live.frame().cursor.shape, shape, "{seq:?}");
        let restored = Screen::restore(10, 3, &live.snapshot());
        assert_eq!(restored.frame().cursor.shape, shape, "{seq:?} restored");
    }
}

/// Deterministic noise biased towards escape-sequence bytes.
fn hostile_bytes(len: usize) -> Vec<u8> {
    let mut x: u64 = 0x0bad_5eed;
    let alphabet = b"\x1b[]?;0123456789mHJKrhlqu>c\x07\\ PX\r\n\t";
    (0..len)
        .map(|_| {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let r = (x >> 33) as usize;
            if r % 4 == 0 {
                (r >> 8) as u8
            } else {
                alphabet[(r >> 8) % alphabet.len()]
            }
        })
        .collect()
}

#[test]
fn hostile_input_stays_bounded() {
    let (cols, rows) = (40u16, 10u16);
    let mut s = Screen::new(cols, rows);

    // Out-of-range parameters are clamped, never panic or resize.
    s.advance(b"\x1b[99999;99999HX\x1b[65535L\x1b[65535M\x1b[65535@\x1b[65535P");
    s.advance(b"\x1b[65535X\x1b[65535S\x1b[65535T\x1b[65535;65535r\x1b[0;0r\x1b[9;2r");
    s.advance(b"a\x1b[65535b\x1b[65535C\x1b[65535B");
    let f = s.frame();
    assert_eq!((f.cols, f.rows), (cols, rows));
    assert!(f.cursor.row < rows && f.cursor.col < cols);

    // A huge title is cut to the bound in the frame and the snapshot.
    let mut title = b"\x1b]2;".to_vec();
    title.extend(std::iter::repeat_n(b't', 1 << 20));
    title.push(0x07);
    s.advance(&title);
    let t = s.frame().title.unwrap_or_default();
    assert_eq!(t.chars().count(), MAX_TITLE_BYTES);

    // Thousands of combining marks on one cell: the cluster is bounded.
    let mut marks = "\x1b[Hq".to_string();
    marks.extend(std::iter::repeat_n('\u{301}', 10_000));
    s.advance(marks.as_bytes());
    let f = s.frame();
    let q = f.cell(0, 0).unwrap();
    assert_eq!(f.text(q).chars().count(), MAX_CLUSTER_SCALARS);

    // Kitty keyboard pushes far beyond any sane depth.
    s.advance("\x1b[>1u".repeat(10_000).as_bytes());
    assert_eq!(s.frame().modes.kitty_keyboard, 1);

    // Noise: no panic, frame and snapshot stay within fixed bounds, and the
    // snapshot restores without panicking.
    let noise = hostile_bytes(512 * 1024);
    for chunk in noise.chunks(997) {
        s.advance(chunk);
    }
    let f = s.frame();
    assert_eq!(f.cells.len(), cols as usize * rows as usize);
    assert!(f.clusters.len() <= f.cells.len() + 1);
    let snap = s.snapshot();
    // Per cell: one full SGR (under 64 bytes) plus a maximal cluster; per row a
    // cursor move; plus title and modes.
    // Per linked cell: an OSC 8 with a whole URI, and its end.
    let linked = f.link_ids.iter().filter(|&&id| id != 0).count();
    let bound = f.cells.len() * (96 + 4 * MAX_CLUSTER_SCALARS)
        + linked * (2 * MAX_URI_BYTES + 128)
        + rows as usize * 16
        + f.marks.len() * 48
        + f.cols as usize * 12
        + 4 * MAX_TITLE_BYTES
        + 1024;
    assert!(
        snap.len() <= bound,
        "snapshot {} > bound {bound}",
        snap.len()
    );
    let restored = Screen::restore(cols, rows, &snap);
    assert_eq!(restored.frame().cells.len(), f.cells.len());
}

#[test]
fn degenerate_sizes_are_clamped() {
    let mut s = Screen::new(0, 0);
    assert_eq!((s.cols(), s.rows()), (2, 1));
    s.advance("日本語 wide on a tiny screen\r\n\x1b[?1049h".as_bytes());
    s.resize(0, 0);
    let f = s.frame();
    assert_eq!((f.cols, f.rows), (2, 1));
    assert_eq!(f.cells.len(), 2);
    let restored = Screen::restore(0, 0, &s.snapshot());
    assert_same(&s.frame(), &restored.frame(), "tiny screen");
}

#[test]
fn terminal_modes_continue_identically_after_restore() {
    // DECSTBM, DECOM, IRM and LNM all change what the next bytes do.
    let input = "top\x1b[6;1Hbottom\x1b[2;5r\x1b[?6h\x1b[4h\x1b[20h\x1b[2;1Habc\x1b[1;1H";
    let extra = "XY\nZ\n1\n2\n3\n4\x1b[1;1Hins";
    let mut live = fed(20, 6, input.as_bytes());
    let mut restored = Screen::restore(20, 6, &live.snapshot());
    assert_same(&live.frame(), &restored.frame(), "before");
    live.advance(extra.as_bytes());
    restored.advance(extra.as_bytes());
    let f = live.frame();
    assert_eq!(row_text(&f, 0), "top", "row outside the region untouched");
    assert_eq!(
        row_text(&f, 5),
        "bottom",
        "row outside the region untouched"
    );
    assert_same(&f, &restored.frame(), "after");
}

#[test]
fn cursor_blink_survives_a_snapshot() {
    for (seq, blink) in [("\x1b[5 q", true), ("\x1b[6 q", false), ("\x1b[1 q", true)] {
        let live = fed(10, 3, seq.as_bytes());
        assert_eq!(live.cursor_blinking(), blink, "{seq:?}");
        let restored = Screen::restore(10, 3, &live.snapshot());
        assert_eq!(restored.cursor_blinking(), blink, "{seq:?} restored");
    }
}

#[test]
fn kitty_flags_of_both_screens_survive_a_snapshot() {
    let mut live = fed(10, 3, b"\x1b[>1u\x1b[?1049h\x1b[>5u");
    assert_eq!(live.frame().modes.kitty_keyboard, 5);
    let mut restored = Screen::restore(10, 3, &live.snapshot());
    assert_eq!(restored.frame().modes.kitty_keyboard, 5);
    live.advance(b"\x1b[?1049l");
    restored.advance(b"\x1b[?1049l");
    assert_eq!(live.frame().modes.kitty_keyboard, 1, "main screen's flags");
    assert_eq!(restored.frame().modes.kitty_keyboard, 1);
}

#[test]
fn soft_wraps_survive_a_snapshot_and_reflow_the_same() {
    let mut live = fed(10, 4, b"0123456789ABCDE");
    let mut restored = Screen::restore(10, 4, &live.snapshot());
    live.resize(20, 4);
    restored.resize(20, 4);
    assert_eq!(row_text(&live.frame(), 0), "0123456789ABCDE");
    assert_same(&live.frame(), &restored.frame(), "after reflow");
}

#[test]
fn queries_are_answered_in_order() {
    let mut s = fed(20, 3, b"ab\x1b[6n");
    assert_eq!(s.take_replies(), b"\x1b[1;3R");
    assert!(s.take_replies().is_empty(), "drained");

    s.advance(b"\x1b[c");
    assert_eq!(s.take_replies(), b"\x1b[?6c");

    // Engine replies and the kitty reply (answered here) keep stream order.
    s.advance(b"\x1b[>5u\x1b[6n\x1b[?u\x1b[5n");
    assert_eq!(s.take_replies(), b"\x1b[1;3R\x1b[?5u\x1b[0n");
}

#[test]
fn colour_queries_are_answered_only_when_colours_are_known() {
    let mut s = fed(10, 2, b"\x1b]11;?\x07");
    assert!(s.take_replies().is_empty(), "no theme known, no reply");
    s.set_reply_colors(Some((0xee, 0xee, 0xee)), Some((0x10, 0x20, 0x30)), None);
    s.advance(b"\x1b]11;?\x07");
    assert_eq!(s.take_replies(), b"\x1b]11;rgb:1010/2020/3030\x07");
    s.advance(b"\x1b]10;?\x1b\\");
    assert_eq!(s.take_replies(), b"\x1b]10;rgb:eeee/eeee/eeee\x1b\\");
}

#[test]
fn restoring_a_snapshot_sends_no_replies() {
    let live = fed(30, 8, format!("{MIXED}{ALL_MODES}").as_bytes());
    let mut restored = Screen::restore(30, 8, &live.snapshot());
    assert!(restored.take_replies().is_empty());
}

#[test]
fn long_osc_bodies_are_cut_before_the_engine() {
    let mut s = Screen::new(20, 3);
    let mut osc = b"\x1b]52;c;".to_vec();
    osc.extend(std::iter::repeat_n(b'A', 4 * MAX_OSC_BYTES));
    osc.extend_from_slice(b"\x07ok");
    for chunk in osc.chunks(4096) {
        s.advance(chunk);
    }
    assert_eq!(
        row_text(&s.frame(), 0),
        "ok",
        "the terminator still ends it"
    );
}

#[test]
fn combining_marks_cannot_grow_one_cell_by_moving_the_cursor() {
    // Each round prints a new base character next to `a` and moves back, so a
    // per-burst limit alone would let `a` collect marks without end.
    let mut s = fed(20, 2, b"a");
    let round = format!("{}b\x1b[D", "\u{301}".repeat(15));
    for _ in 0..200 {
        s.advance(round.as_bytes());
    }
    let f = s.frame();
    let a = f.cell(0, 0).unwrap();
    assert_eq!(f.text(a).chars().count(), MAX_CLUSTER_SCALARS);
}

#[test]
fn sizes_are_capped() {
    let s = Screen::with_scrollback(u16::MAX, u16::MAX, usize::MAX);
    assert_eq!(
        (s.cols(), s.rows()),
        (
            canopy_term_core::screen::MAX_COLS,
            canopy_term_core::screen::MAX_ROWS
        )
    );
}

// ---- hyperlinks, underlines, palette, tab stops, charsets, marks ----

/// Feeds `input`, snapshots, restores, checks the restored screen is the same
/// in every way a client could see, then feeds `more` to both and checks
/// they still are.
fn round_trip(name: &str, cols: u16, rows: u16, input: &str, more: &str) -> (Screen, Screen) {
    let mut live = fed(cols, rows, input.as_bytes());
    let snap = live.snapshot();
    let mut restored = Screen::restore(cols, rows, &snap);
    assert_same(&live.frame(), &restored.frame(), name);
    assert_eq!(
        String::from_utf8_lossy(&restored.snapshot()),
        String::from_utf8_lossy(&snap),
        "{name}: snapshot of the restored screen"
    );
    assert_eq!(
        live.palette_overrides(),
        restored.palette_overrides(),
        "{name}: palette"
    );
    assert_eq!(live.tab_stops(), restored.tab_stops(), "{name}: tab stops");
    assert!(
        restored.take_events().is_empty(),
        "{name}: restoring raises no events"
    );
    assert!(restored.take_replies().is_empty(), "{name}: no replies");
    live.advance(more.as_bytes());
    restored.advance(more.as_bytes());
    assert_same(
        &live.frame(),
        &restored.frame(),
        &format!("{name}: continued"),
    );
    assert_eq!(
        live.tab_stops(),
        restored.tab_stops(),
        "{name}: tab stops after"
    );
    (live, restored)
}

#[test]
fn hyperlinks_are_in_the_frame() {
    let s = fed(
        30,
        3,
        b"\x1b]8;id=x;https://example.com/a\x1b\\click\x1b]8;;\x1b\\ \x1b]8;;https://example.org/b\x07two\x1b]8;;\x07!",
    );
    let f = s.frame();
    let a = f.link_at(0, 0).expect("link on c");
    assert_eq!(
        (a.id.as_str(), a.uri.as_str()),
        ("x", "https://example.com/a")
    );
    assert_eq!(f.link_at(0, 4), Some(a), "same link across the run");
    assert!(f.link_at(0, 5).is_none(), "the gap");
    let b = f.link_at(0, 6).expect("second link");
    assert_eq!(b.uri, "https://example.org/b");
    assert!(!b.id.is_empty(), "a link without an id gets one");
    assert!(f.link_at(0, 9).is_none(), "after the link ended");
    assert_eq!(f.links.len(), 3, "placeholder and two links");
    assert_eq!(f.link_ids.len(), f.cells.len());
    assert!(fed(10, 2, b"plain").frame().link_ids.is_empty());
}

#[test]
fn a_link_with_one_id_spans_rows_and_shares_an_entry() {
    let s = fed(
        10,
        3,
        b"\x1b]8;id=w;https://example.com/\x07abcdefghijklmno\x1b]8;;\x07",
    );
    let f = s.frame();
    assert_eq!(f.link_at(0, 0), f.link_at(1, 4));
    assert_eq!(f.links.len(), 2);
}

#[test]
fn unsafe_and_oversized_link_uris_are_not_exposed() {
    // Control character (DEL passes the parser) and over the length cap.
    let mut input = b"\x1b]8;;http://a\x7fb\x07ctl\x1b]8;;\x07 ".to_vec();
    input.extend_from_slice(b"\x1b]8;;http://");
    input.extend(std::iter::repeat_n(b'a', 2 * MAX_URI_BYTES));
    input.extend_from_slice(b"\x07long\x1b]8;;\x07 ");
    input.extend_from_slice(b"\x1b]8;;http://ok\x07fine");
    let f = fed(40, 2, &input).frame();
    assert!(f.link_at(0, 0).is_none(), "control character");
    assert!(f.link_at(0, 4).is_none(), "over the cap");
    let ok = (0..40).find_map(|c| f.link_at(0, c)).expect("the good one");
    assert_eq!(ok.uri, "http://ok");
    assert_eq!(f.links.len(), 2);

    // A URI exactly at the cap is exposed whole.
    let uri = format!("h:{}", "b".repeat(MAX_URI_BYTES - 2));
    let input = format!("\x1b]8;;{uri}\x07x");
    let f = fed(10, 2, input.as_bytes()).frame();
    assert_eq!(f.link_at(0, 0).unwrap().uri, uri);
}

#[test]
fn the_link_table_is_bounded() {
    let (cols, rows) = (100u16, 60u16);
    let mut s = Screen::new(cols, rows);
    let mut input = String::new();
    for i in 0..(cols as usize * rows as usize) {
        input.push_str(&format!("\x1b]8;;http://e/{i}\x07x"));
    }
    s.advance(input.as_bytes());
    let f = s.frame();
    assert!(f.links.len() <= MAX_FRAME_LINKS + 1);
    assert!(f.links.len() > MAX_FRAME_LINKS, "the table filled");
    assert!(
        f.link_at(rows - 1, cols - 1).is_none(),
        "past the bound: none"
    );
    assert!(f.link_at(0, 0).is_some());
}

#[test]
fn hyperlinks_survive_a_snapshot() {
    let (live, restored) = round_trip(
        "links",
        30,
        4,
        "\x1b]8;id=x;https://example.com/a\x1b\\click\x1b]8;;\x1b\\ \x1b]8;;https://example.org/b\x07two\x1b]8;;\x07\r\n\x1b[2;3Hmore",
        "\x1b]8;id=x;https://example.com/a\x07again\x1b]8;;\x07 end",
    );
    for s in [&live, &restored] {
        let f = s.frame();
        assert_eq!(f.link_at(0, 0).unwrap().id, "x");
        assert_eq!(f.link_at(0, 0), f.link_at(1, 6), "one link, two rows");
    }
}

#[test]
fn a_link_the_program_is_in_the_middle_of_survives_a_snapshot() {
    let (_, restored) = round_trip(
        "open link",
        20,
        3,
        "\x1b]8;id=p;https://example.com/pen\x07abc",
        "def",
    );
    let f = restored.frame();
    assert_eq!(f.link_at(0, 3).unwrap().uri, "https://example.com/pen");
    assert_eq!(f.link_at(0, 5), f.link_at(0, 0));
}

#[test]
fn links_and_underlines_on_wide_and_combined_cells_survive_a_snapshot() {
    round_trip(
        "wide link",
        20,
        3,
        "\x1b]8;;https://example.com/\x07日e\u{301}x\x1b]8;;\x07\x1b[4:3;58;2;9;8;7m日",
        "\x1b[0mz",
    );
}

#[test]
fn underline_styles_and_colours_are_in_the_frame_and_survive_a_snapshot() {
    let input = "\x1b[4:3;58;2;255;0;0mcurl\x1b[0m \x1b[4:2;58;5;9mdbl\x1b[4:4mdot\x1b[4:5mdash\x1b[0mplain\x1b[4mone";
    let (live, _) = round_trip(
        "underlines",
        40,
        2,
        input,
        "\x1b[4:3;58;2;1;2;3m\x1b[1;30Hpen",
    );
    let f = live.frame();
    let at = |c: u16| *f.cell(0, c).unwrap();
    let curl = at(0);
    assert!(curl.attrs.has(Attrs::UNDERLINE) && curl.attrs.has(Attrs::UNDERLINE_CURLY));
    assert_eq!(f.underline_color_at(0, 0), Some(Color::Rgb(255, 0, 0)));
    assert!(!at(4).attrs.has(Attrs::UNDERLINE), "reset ends it");
    assert_eq!(f.underline_color_at(0, 4), None);
    assert!(at(5).attrs.has(Attrs::UNDERLINE_DOUBLE));
    assert_eq!(f.underline_color_at(0, 5), Some(Color::Indexed(9)));
    assert!(at(8).attrs.has(Attrs::UNDERLINE_DOTTED));
    assert!(at(11).attrs.has(Attrs::UNDERLINE_DASHED));
    assert!(!at(15).attrs.has(Attrs::UNDERLINE));
    let one = at(20);
    assert!(one.attrs.has(Attrs::UNDERLINE));
    assert_eq!(
        one.attrs.0 & Attrs::UNDERLINE_STYLES,
        0,
        "a plain underline"
    );
    assert_eq!(f.underline_color_at(0, 20), None);
    // The pen's colour and style carried into the next text.
    let g = live.frame();
    assert!(g.cell(0, 29).unwrap().attrs.has(Attrs::UNDERLINE_CURLY));
    assert_eq!(g.underline_color_at(0, 29), Some(Color::Rgb(1, 2, 3)));
}

#[test]
fn a_changed_link_or_underline_colour_is_damage_even_if_the_text_is_not() {
    let mut s = fed(20, 3, b"abc\r\ndef");
    let before = s.seq();
    s.advance(b"\x1b[1;1H\x1b]8;;https://example.com/\x07abc\x1b]8;;\x07\x1b[2;4H");
    assert!(s.seq() > before, "linking existing text changes the frame");
    assert_eq!(s.damage_since(before).rows, vec![(0, 0)]);
    let before = s.seq();
    s.advance(b"\x1b[2;1H\x1b[4;58;5;1mdef\x1b[0m\x1b[2;4H");
    assert_eq!(s.damage_since(before).rows, vec![(1, 1)]);
    let before = s.seq();
    s.advance(b"\x1b[2;1H\x1b[4;58;5;2mdef\x1b[0m\x1b[2;4H");
    assert!(s.seq() > before, "only the underline colour changed");
    assert_eq!(s.damage_since(before).rows, vec![(1, 1)]);
}

#[test]
fn palette_overrides_survive_a_snapshot() {
    let input = "\x1b]4;1;rgb:12/34/56\x1b\\\x1b]4;200;#abcdef\x07\x1b]10;rgb:aa/bb/cc\x07\x1b]11;rgb:00/11/22\x07\x1b]12;rgb:ff/00/ff\x07";
    let (mut live, mut restored) = round_trip("palette", 20, 3, input, "x");
    assert_eq!(
        live.palette_overrides(),
        vec![
            (1, (0x12, 0x34, 0x56)),
            (200, (0xab, 0xcd, 0xef)),
            (PALETTE_FOREGROUND, (0xaa, 0xbb, 0xcc)),
            (PALETTE_BACKGROUND, (0x00, 0x11, 0x22)),
            (PALETTE_CURSOR, (0xff, 0x00, 0xff)),
        ]
    );
    // The restored screen answers colour queries from what was set.
    for q in ["\x1b]4;1;?\x07", "\x1b]10;?\x07", "\x1b]4;200;?\x07"] {
        live.advance(q.as_bytes());
        restored.advance(q.as_bytes());
        let (a, b) = (live.take_replies(), restored.take_replies());
        assert!(!a.is_empty());
        assert_eq!(a, b, "reply to {q:?}");
    }
    // A reset the program sends after the snapshot applies to the restored one.
    restored.advance(b"\x1b]104;1\x07\x1b]110\x07");
    assert_eq!(restored.palette_overrides().len(), 3);
    assert!(Screen::new(10, 2).palette_overrides().is_empty());
}

#[test]
fn tab_stops_are_mirrored_and_survive_a_snapshot() {
    let s = Screen::new(20, 2);
    assert_eq!(s.tab_stops(), vec![0, 8, 16]);

    let input = "\x1b[3g\x1b[1;5H\x1bH\x1b[1;12H\x1bH\x1b[1;1H";
    let (live, _) = round_trip("custom tabs", 30, 3, input, "\ta\tb\tc");
    assert_eq!(live.tab_stops(), vec![4, 11]);

    let (live, _) = round_trip("cleared tabs", 30, 3, "\x1b[3g", "a\tb");
    assert!(live.tab_stops().is_empty());

    let (live, _) = round_trip("one cleared", 30, 3, "\x1b[1;9H\x1b[0g\x1b[1;1H", "\t\tx");
    assert_eq!(live.tab_stops(), vec![0, 16, 24]);

    let (live, _) = round_trip("reset", 30, 3, "\x1b[3g\x1bc", "\tx");
    assert_eq!(live.tab_stops(), vec![0, 8, 16, 24]);
}

/// Walking right with TAB lands on each mirrored stop in turn.
fn assert_tabs_match_the_engine(s: &mut Screen) {
    let stops = s.tab_stops();
    s.advance(b"\x1b[1;1H");
    for want in stops.iter().skip(1) {
        s.advance(b"\t");
        assert_eq!(s.frame().cursor.col, *want, "stops {stops:?}");
    }
}

#[test]
fn the_tab_mirror_matches_the_engine_through_resizes() {
    let mut s = Screen::new(10, 3);
    assert_tabs_match_the_engine(&mut s);
    s.resize(30, 3);
    assert_eq!(s.tab_stops(), vec![0, 8, 16, 24]);
    assert_tabs_match_the_engine(&mut s);
    s.advance(b"\x1b[1;5H\x1bH\x1b[1;9H\x1b[g");
    assert_tabs_match_the_engine(&mut s);
    s.resize(6, 3);
    assert_eq!(s.tab_stops(), vec![0, 4]);
    assert_tabs_match_the_engine(&mut s);
    s.resize(20, 3);
    assert_eq!(s.tab_stops(), vec![0, 4, 8, 16]);
    assert_tabs_match_the_engine(&mut s);
}

#[test]
fn character_sets_survive_a_snapshot() {
    // G0 drawing left active.
    let (live, restored) = round_trip("g0 drawing", 20, 3, "abc\x1b(0lqk\x1b[1;1H", "qqxx\x1b(Bqq");
    assert_eq!(live.frame().cell(0, 0).unwrap().ch, '─');
    assert_eq!(restored.frame().cell(0, 0).unwrap().ch, '─');
    // G1 designated and shifted out; G2 and G3 designated (state only).
    round_trip(
        "g1 shifted out",
        20,
        3,
        "\x1b)0\x0eqq\x1b*0\x1b+0",
        "lqk\x0fqq\x0eqq",
    );
    // Designated but shifted back in.
    round_trip("g1 not active", 20, 3, "\x1b)0\x0e\x0fqq", "\x0eqq\x0fqq");
    // The plain case still has nothing to carry.
    let snap = fed(20, 3, b"q").snapshot();
    assert!(!snap.contains(&0x0e) && !snap.windows(3).any(|w| w == b"\x1b(0"));
}

fn clipboard_screen(policy: ClipboardPolicy) -> Screen {
    let mut s = Screen::new(20, 3);
    s.set_clipboard_policy(policy);
    s
}

#[test]
fn clipboard_sets_are_off_by_default() {
    let mut s = Screen::new(20, 3);
    assert_eq!(s.clipboard_policy(), ClipboardPolicy::Off);
    s.advance(b"\x1b]52;c;aGVsbG8=\x07shown");
    assert!(s.take_events().is_empty(), "no event, nothing to write");
    assert_eq!(row_text(&s.frame(), 0), "shown", "and nothing printed");
    assert!(s.take_replies().is_empty());
}

#[test]
fn clipboard_sets_become_events_under_the_policy() {
    let mut s = clipboard_screen(ClipboardPolicy::Set);
    s.advance(b"\x1b]52;c;aGVsbG8=\x07\x1b]52;p;d29ybGQ\x1b\\\x1b]52;;aGk=\x07");
    assert_eq!(
        s.take_events(),
        vec![
            Event::ClipboardSet {
                target: ClipboardTarget::Clipboard,
                text: "hello".into()
            },
            Event::ClipboardSet {
                target: ClipboardTarget::Selection,
                text: "world".into()
            },
            Event::ClipboardSet {
                target: ClipboardTarget::Clipboard,
                text: "hi".into()
            },
        ]
    );
    assert!(s.take_events().is_empty(), "taken once");
}

#[test]
fn clipboard_reads_are_never_answered() {
    for policy in [ClipboardPolicy::Off, ClipboardPolicy::Set] {
        let mut s = clipboard_screen(policy);
        s.advance(b"\x1b]52;c;?\x07\x1b]52;p;?\x1b\\");
        assert!(s.take_replies().is_empty(), "{policy:?}: no reply");
        assert_eq!(
            s.take_events(),
            vec![
                Event::ClipboardReadDenied {
                    target: ClipboardTarget::Clipboard
                },
                Event::ClipboardReadDenied {
                    target: ClipboardTarget::Selection
                },
            ],
            "{policy:?}: reported"
        );
    }
}

#[test]
fn bad_oversized_or_cancelled_clipboard_sets_are_dropped_whole() {
    let mut s = clipboard_screen(ClipboardPolicy::Set);
    // Not base64, not UTF-8, cancelled by CAN, and a cut buffer.
    s.advance(b"\x1b]52;c;a$k=\x07\x1b]52;c;/w==\x07\x1b]52;c;aGk=\x18\x1b]52;0;aGk=\x07");
    assert!(s.take_events().is_empty());

    // Just within the cap, then just over: the larger is dropped, not cut.
    let b64 = |n: usize| {
        let mut v = b"\x1b]52;c;".to_vec();
        v.extend(std::iter::repeat_n(b'Q', n / 3 * 4));
        v.push(0x07);
        v
    };
    s.advance(&b64(MAX_CLIPBOARD_TEXT));
    match s.take_events().as_slice() {
        [Event::ClipboardSet { text, .. }] => assert_eq!(text.len(), MAX_CLIPBOARD_TEXT / 3 * 3),
        other => panic!("expected one set, got {other:?}"),
    }
    s.advance(&b64(MAX_CLIPBOARD_TEXT + 3000));
    assert!(s.take_events().is_empty(), "over the cap");
    s.advance(&b64(8 * MAX_CLIPBOARD_TEXT));
    assert!(s.take_events().is_empty(), "far over the cap");
    assert_eq!(row_text(&s.frame(), 0), "", "and the screen is untouched");
}

#[test]
fn clipboard_events_do_not_depend_on_how_the_bytes_are_split() {
    let input = b"a\x1b]52;c;aGk=\x07b\x1b]133;A\x1b\\c\x1b]52;c;?\x07";
    let mut whole = clipboard_screen(ClipboardPolicy::Set);
    whole.advance(input);
    let want = whole.take_events();
    assert_eq!(want.len(), 3);
    for i in 1..input.len() {
        let mut s = clipboard_screen(ClipboardPolicy::Set);
        s.advance(&input[..i]);
        s.advance(&input[i..]);
        assert_eq!(s.take_events(), want, "split at {i}");
    }
}

#[test]
fn unread_events_are_bounded() {
    let mut s = Screen::new(20, 3);
    s.advance("\x1b]52;c;?\x07".repeat(5000).as_bytes());
    assert_eq!(
        s.take_events().len(),
        canopy_term_core::event::MAX_PENDING_EVENTS
    );
}

const PROMPT_SESSION: &str =
    "\x1b]133;A\x07$ \x1b]133;B\x07ls\r\n\x1b]133;C\x07out\r\n\x1b]133;D;3\x07\x1b]133;A\x07$ ";

#[test]
fn prompt_marks_are_events_and_in_the_frame() {
    let mut s = Screen::new(20, 6);
    s.advance(PROMPT_SESSION.as_bytes());
    use SemanticMark::*;
    assert_eq!(
        s.take_events(),
        [
            (PromptStart, 0),
            (CommandStart, 0),
            (OutputStart, 1),
            (CommandFinished(Some(3)), 2),
            (PromptStart, 2),
        ]
        .map(|(kind, line)| Event::Mark { kind, line })
    );
    let f = s.frame();
    assert_eq!(
        f.marks,
        [
            (0, PromptStart),
            (0, CommandStart),
            (1, OutputStart),
            (2, CommandFinished(Some(3))),
            (2, PromptStart),
        ]
        .map(|(row, kind)| RowMark { row, kind })
    );
    // The frame changed because of the marks alone.
    let before = s.seq();
    s.advance(b"\x1b]133;B\x07");
    assert!(s.seq() > before);
    // Exit code absent or garbled is just no code.
    s.advance(b"\x1b]133;D\x07\x1b]133;D;x\x07");
    assert_eq!(
        s.take_events().iter().skip(1).count(),
        2,
        "two more finished marks"
    );
}

#[test]
fn marks_follow_their_rows_into_scrollback() {
    let mut s = Screen::with_scrollback(20, 4, 100);
    s.advance(b"\x1b]133;A\x07$ ls\r\n");
    for i in 0..10 {
        s.advance(format!("l{i}\r\n").as_bytes());
    }
    s.advance(b"\x1b]133;A\x07$ ");
    assert!(
        s.frame().marks.iter().all(|m| m.row == 3),
        "only the new one"
    );
    let marks = s.marks();
    assert_eq!(marks.len(), 2);
    assert!(marks[0].index < s.scrollback_len());
    assert_eq!(s.scrollback_row(marks[0].index).unwrap().text(), "$ ls");
    assert_eq!(marks[0].line, 0);
    assert_eq!(marks[1].index, s.scrollback_len() + 3);
}

fn text_at(s: &Screen, index: usize) -> String {
    let len = s.scrollback_len();
    if index < len {
        s.scrollback_row(index).unwrap().text()
    } else {
        row_text(&s.frame(), (index - len) as u16)
    }
}

#[test]
fn marks_stay_exact_once_the_history_is_full() {
    let mut s = Screen::with_scrollback(20, 4, 5);
    s.advance(b"\x1b]133;A\x07first\r\n");
    for i in 0..30 {
        s.advance(format!("x{i}\r\n").as_bytes());
    }
    assert!(s.marks().is_empty(), "the first prompt left the history");
    s.advance(b"\x1b]133;A\x07second\r\n");
    for i in 0..2 {
        s.advance(format!("y{i}\r\n").as_bytes());
    }
    let marks = s.marks();
    assert_eq!(marks.len(), 1);
    assert_eq!(text_at(&s, marks[0].index), "second");
    // And again, a few lines at a time inside one advance.
    s.advance(b"\x1b]133;A\x07third\r\n");
    s.advance(b"p\r\nq\r\nr\r\n");
    let marks = s.marks();
    assert_eq!(marks.len(), 2);
    assert_eq!(text_at(&s, marks[1].index), "third");
}

#[test]
fn marks_lost_to_a_bulk_scroll_are_dropped_not_misplaced() {
    let mut s = Screen::with_scrollback(20, 4, 5);
    s.advance(b"\x1b]133;A\x07marked\r\n");
    // More lines in one advance than the history holds.
    s.advance("z\r\n".repeat(50).as_bytes());
    assert!(s.marks().is_empty());
    s.advance(b"\x1b]133;A\x07fresh");
    let marks = s.marks();
    assert_eq!(marks.len(), 1);
    assert_eq!(text_at(&s, marks[0].index), "fresh");
}

#[test]
fn marks_survive_the_alternate_screen_and_are_not_taken_on_it() {
    let mut s = Screen::with_scrollback(20, 4, 50);
    s.advance(b"\x1b]133;A\x07$ vim\r\n");
    let before = s.marks();
    assert_eq!(before.len(), 1);
    s.take_events();
    // A full-screen program: lots of output, and its own marks (ignored).
    s.advance(b"\x1b[?1049h\x1b]133;A\x07");
    s.advance("full screen\r\n".repeat(30).as_bytes());
    assert!(s.marks().is_empty() && s.frame().marks.is_empty());
    assert!(s.take_events().is_empty(), "not reported on the alt screen");
    s.advance(b"\x1b[?1049l");
    assert_eq!(s.marks(), before);
    assert_eq!(s.frame().marks.len(), 1);
}

#[test]
fn marks_that_cannot_be_followed_are_dropped() {
    // Resize reflows lines.
    let mut s = Screen::with_scrollback(20, 4, 50);
    s.advance(b"\x1b]133;A\x07x");
    s.resize(10, 4);
    assert!(s.marks().is_empty());
    // Reset.
    s.advance(b"\x1b]133;A\x07x\x1bc");
    assert!(s.marks().is_empty());
    // Clearing the scrollback.
    s.advance("\x1b]133;A\x07m\r\n".as_bytes());
    s.advance("l\r\n".repeat(8).as_bytes());
    assert!(!s.marks().is_empty());
    s.advance(b"\x1b[3J");
    assert!(s.marks().is_empty());
    // Reverse scrolling moves the visible rows: those marks go, history stays.
    let mut s = Screen::with_scrollback(20, 4, 50);
    s.advance(b"\x1b]133;A\x07old\r\n");
    s.advance("l\r\n".repeat(6).as_bytes());
    s.advance(b"\x1b]133;A\x07$ \x1b[1;1H\x1bM");
    let marks = s.marks();
    assert_eq!(marks.len(), 1);
    assert_eq!(text_at(&s, marks[0].index), "old");
    // No scrollback, no marks.
    let mut s = Screen::with_scrollback(20, 4, 0);
    s.advance(b"\x1b]133;A\x07x");
    assert!(s.marks().is_empty() && s.take_events().is_empty());
}

#[test]
fn prompt_marks_survive_a_snapshot() {
    let (live, restored) = round_trip(
        "marks",
        20,
        6,
        PROMPT_SESSION,
        "ls\r\n\x1b]133;C\x07\x1b]133;D;0\x07",
    );
    assert_eq!(live.frame().marks.len(), 7);
    assert_eq!(live.frame().marks, restored.frame().marks);
    assert_eq!(live.marks().len(), restored.marks().len());
}

#[test]
fn marks_do_not_change_what_is_drawn() {
    let a = fed(20, 3, b"abc\r\ndef");
    let b = fed(20, 3, b"a\x1b]133;A\x07bc\r\nd\x1b]133;D;0\x1b\\ef");
    let (fa, fb) = (a.frame(), b.frame());
    assert_eq!(fa.cells, fb.cells);
    assert_eq!(fa.cursor, fb.cursor);
}

#[test]
fn hostile_osc_input_does_not_break_the_new_state() {
    let mut s = Screen::with_scrollback(30, 6, 20);
    s.set_clipboard_policy(ClipboardPolicy::Set);
    let mut bytes = Vec::new();
    for i in 0..400u32 {
        bytes.extend_from_slice(
            format!(
                "\x1b]133;{}\x07",
                ["A", "B", "C", "D;1", "Z", ""][i as usize % 6]
            )
            .as_bytes(),
        );
        bytes.extend_from_slice(
            format!("\x1b]8;id={i};http://h/{i}\x07t{i}\x1b]8;;\x07\r\n").as_bytes(),
        );
        bytes.extend_from_slice(
            b"\x1b]52;c;QQ==\x07\x1bH\x1b[g\x1b[3g\x1bM\x1b[2L\x1b[?1049h\x1b]133;A\x07\x1b[?1049l",
        );
    }
    bytes.extend(hostile_bytes(64 * 1024));
    for chunk in bytes.chunks(509) {
        s.advance(chunk);
        let _ = s.take_events();
    }
    let f = s.frame();
    assert_eq!(f.cells.len(), 30 * 6);
    assert!(f.link_ids.is_empty() || f.link_ids.len() == f.cells.len());
    assert!(f.marks.iter().all(|m| m.row < 6));
    let restored = Screen::restore(30, 6, &s.snapshot());
    assert_eq!(restored.frame().cells.len(), f.cells.len());
    for m in s.marks() {
        assert!(m.index < s.scrollback_len() + 6);
    }
}
