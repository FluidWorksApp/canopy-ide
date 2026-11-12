//! What only the libghostty-vt engine offers (events, hyperlinks, prompt marks,
//! clipboard policy) and what its threading promises. Synthetic input only.
#![cfg(feature = "ghostty")]

use canopy_term_core::frame::Attrs;
use canopy_term_core::ghostty::{
    Event, PromptKind, PromptMark, RowMark, MAX_CLIPBOARD_BYTES, MAX_OSC_BYTES,
};
use canopy_term_core::GhosttyScreen as Screen;

fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if c.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn row_text(s: &Screen, r: u16) -> String {
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
fn an_osc_52_write_is_an_event_and_nothing_else() {
    let mut s = Screen::new(20, 3);
    s.advance(b"\x1b]52;c;aGVsbG8=\x07ok");
    assert_eq!(
        s.take_events(),
        vec![Event::ClipboardWrite {
            selection: "c".into(),
            data: b"hello".to_vec()
        }]
    );
    assert!(s.take_replies().is_empty());
    assert_eq!(row_text(&s, 0), "ok");
    assert!(s.take_events().is_empty(), "drained");
}

#[test]
fn osc_52_split_across_feeds_and_with_st_is_one_event() {
    let mut s = Screen::new(20, 3);
    s.advance(b"\x1b]52;pc;aGVs");
    s.advance(b"bG8=\x1b");
    s.advance(b"\\");
    assert_eq!(
        s.take_events(),
        vec![Event::ClipboardWrite {
            selection: "pc".into(),
            data: b"hello".to_vec()
        }]
    );
}

#[test]
fn osc_52_read_requests_are_denied_by_default() {
    let mut s = Screen::new(20, 3);
    s.advance(b"\x1b]52;c;?\x07\x1b]52;c;?\x1b\\");
    assert!(s.take_events().is_empty());
    assert!(s.take_replies().is_empty(), "nothing is ever read back");

    // Opting in surfaces the request as an event; the core still never answers.
    s.set_clipboard_read_events(true);
    s.advance(b"\x1b]52;p;?\x07");
    assert_eq!(
        s.take_events(),
        vec![Event::ClipboardReadRequest {
            selection: "p".into()
        }]
    );
    assert!(s.take_replies().is_empty());
}

#[test]
fn osc_52_over_the_size_cap_or_malformed_is_dropped() {
    let mut s = Screen::new(20, 3);
    let big = b64(&vec![b'x'; MAX_CLIPBOARD_BYTES + 3]);
    s.advance(format!("\x1b]52;c;{big}\x07a").as_bytes());
    let huge = "A".repeat(2 * MAX_OSC_BYTES);
    s.advance(format!("\x1b]52;c;{huge}\x07b").as_bytes());
    s.advance(b"\x1b]52;c;not base64!\x07c\x1b]52;c\x07d");
    assert!(s.take_events().is_empty());
    assert_eq!(row_text(&s, 0), "abcd", "the stream carries on after each");

    let fits = b64(&vec![b'y'; MAX_CLIPBOARD_BYTES]);
    s.advance(format!("\x1b]52;c;{fits}\x07").as_bytes());
    match s.take_events().as_slice() {
        [Event::ClipboardWrite { data, .. }] => assert_eq!(data.len(), MAX_CLIPBOARD_BYTES),
        other => panic!("{} events", other.len()),
    }
}

#[test]
fn prompt_marks_are_events_and_rows() {
    let mut s = Screen::new(30, 6);
    s.advance(b"\x1b]133;A\x07$ \x1b]133;B\x07ls\r\n\x1b]133;C\x07out\r\n\x1b]133;D;3\x07");
    let mark = |kind, exit_code, row| {
        Event::PromptMark(PromptMark {
            kind,
            exit_code,
            row,
        })
    };
    assert_eq!(
        s.take_events(),
        vec![
            mark(PromptKind::PromptStart, None, 0),
            mark(PromptKind::PromptEnd, None, 0),
            mark(PromptKind::OutputStart, None, 1),
            mark(PromptKind::CommandEnd, Some(3), 2),
        ]
    );
    assert_eq!(s.row_mark(0), RowMark::Prompt);
    assert_eq!(s.row_mark(1), RowMark::None);
    assert_eq!(s.row_mark(99), RowMark::None);
}

#[test]
fn the_bell_is_an_event_only_outside_a_sequence() {
    let mut s = Screen::new(20, 3);
    s.advance(b"\x07\x1b]2;t\x07\x1bPabc\x07def\x1b\\\x07");
    assert_eq!(s.take_events(), vec![Event::Bell, Event::Bell]);
}

#[test]
fn hyperlinks_are_readable_and_survive_a_snapshot() {
    let url = "http://example.com/a?b=c";
    let mut s = Screen::new(30, 3);
    s.advance(format!("\x1b]8;;{url}\x07link\x1b]8;;\x07 plain").as_bytes());
    for c in 0..4 {
        assert_eq!(s.hyperlink_at(0, c).as_deref(), Some(url), "col {c}");
    }
    assert_eq!(s.hyperlink_at(0, 4), None);
    assert_eq!(s.hyperlink_at(0, 6), None);
    assert_eq!(s.hyperlink_at(9, 0), None);

    let restored = Screen::restore(30, 3, &s.snapshot());
    for c in 0..4 {
        assert_eq!(
            restored.hyperlink_at(0, c).as_deref(),
            Some(url),
            "restored col {c}"
        );
    }
    assert_eq!(restored.hyperlink_at(0, 5), None);
    assert_eq!(row_text(&restored, 0), "link plain");
}

#[test]
fn a_changed_link_is_damage_even_when_the_text_is_the_same() {
    let mut s = Screen::new(20, 3);
    s.advance(b"abc");
    let before = s.seq();
    s.advance(b"\x1b[1;1H\x1b]8;;http://x.example/\x07abc\x1b]8;;\x07");
    assert!(s.seq() > before);
    assert!(s.damage_since(before).rows.contains(&(0, 0)));
}

#[test]
fn advances_without_a_read_between_them_are_one_frame_with_all_their_damage() {
    // The frame is built when somebody reads, not on every advance, so three
    // advances before the next read must still show every row they touched.
    let mut s = Screen::new(20, 4);
    s.advance(b"zero");
    let before = s.seq();
    s.advance(b"\x1b[1;1Hone");
    s.advance(b"\x1b[2;1Htwo");
    s.advance(b"\x1b[3;1Hthree");
    assert!(s.seq() > before);
    let d = s.damage_since(before);
    assert!(!d.full);
    assert_eq!(d.rows, vec![(0, 2)]);
    assert_eq!(row_text(&s, 2), "three");
}

#[test]
fn colour_queries_use_the_programs_colours_then_the_themes() {
    let mut s = Screen::new(20, 3);
    s.advance(b"\x1b]10;?\x07\x1b]11;?\x07");
    assert!(s.take_replies().is_empty(), "no colour known, no reply");

    s.set_reply_colors(Some((0xee, 0xee, 0xee)), Some((0x10, 0x20, 0x30)), None);
    s.advance(b"\x1b]10;?\x1b\\\x1b]11;?\x07");
    assert_eq!(
        s.take_replies(),
        b"\x1b]10;rgb:eeee/eeee/eeee\x1b\\\x1b]11;rgb:1010/2020/3030\x07"
    );

    s.advance(b"\x1b]11;rgb:12/34/56\x07\x1b]11;?\x07");
    assert_eq!(s.take_replies(), b"\x1b]11;rgb:1212/3434/5656\x07");

    s.advance(b"\x1b]4;1;?\x07");
    let r = s.take_replies();
    assert!(
        r.starts_with(b"\x1b]4;1;rgb:") && r.ends_with(b"\x07"),
        "{r:?}"
    );
}

#[test]
fn decrqm_and_other_queries_are_answered_in_stream_order() {
    let mut s = Screen::new(20, 3);
    s.advance(b"x\x1b[?7$p\x1b[6n\x1b[?2004$p\x1b[?2004h\x1b[?2004$p");
    assert_eq!(
        s.take_replies(),
        b"\x1b[?7;1$y\x1b[1;2R\x1b[?2004;2$y\x1b[?2004;1$y".to_vec()
    );
}

#[test]
fn the_title_follows_osc_0_and_2_and_ignores_osc_1() {
    let mut s = Screen::new(20, 3);
    s.advance(b"\x1b]1;icon\x07");
    assert_eq!(s.frame().title, None);
    s.advance(b"\x1b]0;both\x07");
    assert_eq!(s.frame().title.as_deref(), Some("both"));
    s.advance(b"\x1b]2;win\x1b\\");
    assert_eq!(s.frame().title.as_deref(), Some("win"));
}

#[test]
fn a_screen_moves_between_threads_and_is_used_from_many() {
    let mut s = Screen::new(20, 3);
    s.advance(b"before");
    let s = std::thread::spawn(move || {
        let mut s = s;
        s.advance(b" and after");
        s
    })
    .join()
    .unwrap();
    let shared = std::sync::Arc::new(s);
    let handles: Vec<_> = (0..4)
        .map(|_| {
            let s = shared.clone();
            std::thread::spawn(move || {
                for _ in 0..50 {
                    assert_eq!(row_text(&s, 0), "before and after");
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
}

#[test]
fn dropping_a_screen_with_queued_work_does_not_hang() {
    for _ in 0..20 {
        let mut s = Screen::new(80, 24);
        for _ in 0..200 {
            s.advance("lorem ipsum \x1b[31mdolor\x1b[0m\r\n".repeat(50).as_bytes());
        }
        drop(s);
    }
}

#[test]
fn many_screens_run_side_by_side() {
    let mut all: Vec<Screen> = (0..16).map(|i| Screen::new(10 + i, 3)).collect();
    for (i, s) in all.iter_mut().enumerate() {
        s.advance(format!("screen {i}").as_bytes());
    }
    for (i, s) in all.iter().enumerate() {
        assert_eq!(row_text(s, 0), format!("screen {i}"));
    }
}

#[test]
fn scrollback_is_capped_in_lines_though_the_engine_counts_bytes() {
    let mut s = Screen::with_scrollback(10, 3, 5);
    for i in 0..200 {
        s.advance(format!("{i}\r\n").as_bytes());
    }
    assert_eq!(s.scrollback_len(), 5);
    let newest = s.scrollback_row(4).unwrap().text();
    assert_eq!(
        newest, "197",
        "the newest kept line is the one just above the screen"
    );
    assert!(s.scrollback_row(5).is_none());
}

/// Found by the split-at-every-byte tests: a combining mark that arrives in a
/// later `vt_write` than its base character is dropped by the engine. Real PTY
/// reads can split anywhere, so this is a gap to close (upstream, or by carrying
/// the last character across writes) before the engine becomes the default.
#[test]
#[ignore = "known gap: libghostty-vt drops a combining mark sent in a later write"]
fn a_combining_mark_in_a_later_write_is_kept() {
    let mut s = Screen::new(10, 2);
    s.advance(b"e");
    s.advance("\u{301}x".as_bytes());
    assert_eq!(row_text(&s, 0), "e\u{301}x");
}
