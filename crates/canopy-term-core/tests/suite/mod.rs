//! Shared test suites, written once and instantiated for each engine behind
//! `Screen`, so the two engines face exactly the same tests.
//!
//! `define!` is the behaviour suite (what used to be `tests/screen.rs`),
//! `conformance::define!` the 18 conformance fixtures at the `Screen` level,
//! and `fuzz::define!` the seeded robustness tests.
#![allow(dead_code, unused_macros, unused_imports)]

pub mod conformance;
pub mod fuzz;

/// Instantiate the behaviour suite as module `$m` for the `Screen` type
/// `$screen`. `$ghostty` is true for the libghostty-vt engine, for the few
/// places a test needs to say how the engines legitimately differ.
macro_rules! define {
    ($m:ident, $screen:ty, $ghostty:expr) => {
        mod $m {
            //! Must-prove behaviour of `Screen`. Synthetic fixtures only.

            use canopy_term_core::frame::{
                Attrs, Color, CursorShape, Damage, Frame, MouseEncoding, MouseMode,
            };
            use canopy_term_core::screen::{MAX_CLUSTER_SCALARS, MAX_OSC_BYTES, MAX_TITLE_BYTES};

            type Screen = $screen;
            #[allow(dead_code)]
            const GHOSTTY: bool = $ghostty;

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
                let bound = f.cells.len() * (64 + 4 * MAX_CLUSTER_SCALARS)
                    + rows as usize * 16
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
        }
    };
}
pub(crate) use define;
