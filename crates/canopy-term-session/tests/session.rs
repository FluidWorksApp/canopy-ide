use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use canopy_term_session::frame::{Attrs, Frame};
use canopy_term_session::input::{Key, KeyEvent, Mods, MouseButton, MouseEvent, MouseEventKind};
use canopy_term_session::{
    FrameSource, MemoryLink, MemoryPeer, Session, SessionConfig, DEFAULT_SYNC_TIMEOUT,
    DEFAULT_WRITE_RETRY,
};

fn session_with(config: SessionConfig) -> (Session<MemoryLink>, MemoryPeer) {
    let (link, peer) = MemoryLink::pair();
    (Session::new(link, config), peer)
}

fn session(cols: u16, rows: u16) -> (Session<MemoryLink>, MemoryPeer) {
    session_with(SessionConfig {
        cols,
        rows,
        ..SessionConfig::default()
    })
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

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

#[test]
fn bytes_become_frame_contents() {
    let (mut s, peer) = session(20, 5);
    let t = Instant::now();
    peer.send_output(b"hello\r\n");
    peer.send_output(b"\x1b[1mworld");
    let f = s.frame_since_at(0, t).expect("first frame");
    assert!(f.damage.full);
    assert_eq!((f.cols, f.rows), (20, 5));
    assert_eq!(row_text(&f, 0), "hello");
    assert_eq!(row_text(&f, 1), "world");
    assert!(f.cell(1, 0).unwrap().attrs.has(Attrs::BOLD));
    assert_eq!((f.cursor.row, f.cursor.col), (1, 5));
    // Nothing new: nothing to hand out.
    assert_eq!(s.frame_since_at(f.seq, t), None);
}

#[test]
fn a_hyperlink_is_readable_through_the_frame_source() {
    let (mut s, peer) = session(30, 3);
    let t = Instant::now();
    peer.send_output(b"\x1b]8;;https://example.com/a\x07link\x1b]8;;\x07 text");
    s.frame_since_at(0, t).expect("frame");
    assert_eq!(
        FrameSource::hyperlink_at(&s, 0, 1).as_deref(),
        Some("https://example.com/a")
    );
    assert_eq!(FrameSource::hyperlink_at(&s, 0, 6), None);
    assert_eq!(FrameSource::hyperlink_at(&s, 9, 0), None);
}

#[test]
fn a_blank_screen_is_published_before_any_output() {
    let (mut s, _peer) = session(10, 3);
    let f = s.frame_since_at(0, Instant::now()).expect("blank frame");
    assert!(f.damage.full);
    assert_eq!(row_text(&f, 0), "");
}

#[test]
fn many_small_reads_are_parsed_once_and_published_once() {
    let (mut s, peer) = session(40, 5);
    for i in 0..50 {
        peer.send_output(format!("{}", i % 10).as_bytes());
    }
    let tick = s.tick(Instant::now());
    assert!(tick.published);
    assert!(!tick.more);
    assert_eq!(
        s.stats().advances,
        1,
        "one emulator pass for the whole batch"
    );
    assert_eq!(s.stats().frames, 1);
    assert_eq!(s.stats().live_bytes, 50);
    let f = s.take_frame(0).unwrap();
    assert_eq!(&row_text(&f, 0)[..10], "0123456789");
    assert_eq!(row_text(&f, 1).len(), 10, "40 columns, 50 digits: wrapped");
}

#[test]
fn damage_names_only_changed_rows() {
    let (mut s, peer) = session(20, 6);
    let t = Instant::now();
    peer.send_output(b"a\r\nb\r\nc");
    let f1 = s.frame_since_at(0, t).unwrap();
    // The cursor stays on row 2, so only row 2 changes.
    peer.send_output(b"d");
    let f2 = s.frame_since_at(f1.seq, t).unwrap();
    assert!(f2.seq > f1.seq);
    assert!(!f2.damage.full);
    assert_eq!(f2.damage.since, f1.seq);
    assert_eq!(f2.damage.rows, vec![(2, 2)]);
    assert_eq!(row_text(&f2, 2), "cd");

    // Each viewer has its own baseline: an older one gets the union.
    peer.send_output(b"\x1b[5;1Hz");
    let f3 = s.frame_since_at(f2.seq, t).unwrap();
    assert!(!f3.damage.full);
    // Row 2 (old cursor row) and row 4 (written, new cursor row).
    assert_eq!(f3.damage.rows, vec![(2, 2), (4, 4)]);
    let older = s.take_frame(f1.seq).unwrap();
    assert_eq!(older.seq, f3.seq);
    assert_eq!(older.damage.rows, vec![(2, 2), (4, 4)]);
    // No baseline: full.
    assert!(s.take_frame(0).unwrap().damage.full);
}

#[test]
fn take_frame_into_reuses_the_viewer_frame() {
    let (mut s, peer) = session(20, 4);
    let t = Instant::now();
    peer.send_output(b"one");
    s.tick(t);
    let mut out = Frame::default();
    assert!(s.take_frame_into(0, &mut out));
    assert_eq!(row_text(&out, 0), "one");
    assert!(out.damage.full);
    let seq = out.seq;
    assert!(!s.take_frame_into(seq, &mut out));
    peer.send_output(b" two");
    s.tick(t);
    assert!(s.take_frame_into(seq, &mut out));
    assert_eq!(row_text(&out, 0), "one two");
    assert_eq!(out.damage.rows, vec![(0, 0)]);
    assert_eq!(out, s.take_frame(seq).unwrap());
}

#[test]
fn frame_into_ticks_and_fills_the_viewer_frame() {
    let (mut s, peer) = session(20, 5);
    let mut mine = Frame::default();
    peer.send_output(b"hi");
    assert!(FrameSource::frame_into(&mut s, 0, &mut mine));
    assert_eq!(row_text(&mine, 0), "hi");
    // Nothing newer: false, and the frame is left alone.
    let seq = mine.seq;
    assert!(!FrameSource::frame_into(&mut s, seq, &mut mine));
    assert_eq!(mine.seq, seq);
    peer.send_output(b"!");
    assert!(FrameSource::frame_into(&mut s, seq, &mut mine));
    assert_eq!(row_text(&mine, 0), "hi!");
    assert!(!mine.damage.full);
}

#[test]
fn synchronized_output_holds_then_releases() {
    let (mut s, peer) = session(20, 5);
    let t0 = Instant::now();
    let f0 = s.frame_since_at(0, t0).unwrap();

    peer.send_output(b"\x1b[?2026hone");
    assert_eq!(s.frame_since_at(f0.seq, t0), None, "held while 2026 is set");
    assert_eq!(s.deadline(), Some(t0 + DEFAULT_SYNC_TIMEOUT));
    assert!(s.modes().sync_output);

    peer.send_output(b" two\x1b[?2026l");
    let f1 = s
        .frame_since_at(f0.seq, t0 + ms(5))
        .expect("released on 2026l");
    assert_eq!(row_text(&f1, 0), "one two");
    assert!(!f1.modes.sync_output);
    assert_eq!(s.deadline(), None);

    // A hold that is never cleared ends at the timeout.
    let t1 = t0 + ms(10);
    peer.send_output(b"\r\n\x1b[?2026hthree");
    assert_eq!(s.frame_since_at(f1.seq, t1), None);
    assert_eq!(s.frame_since_at(f1.seq, t1 + ms(100)), None);
    let f2 = s
        .frame_since_at(f1.seq, t1 + DEFAULT_SYNC_TIMEOUT)
        .expect("released at the timeout");
    assert_eq!(row_text(&f2, 1), "three");
    assert!(f2.modes.sync_output);
    assert_eq!(s.deadline(), None);

    // Still set but timed out: frames flow until it is seen cleared.
    peer.send_output(b" four");
    let f3 = s
        .frame_since_at(f2.seq, t1 + DEFAULT_SYNC_TIMEOUT + ms(1))
        .unwrap();
    assert_eq!(row_text(&f3, 1), "three four");

    // Cleared, then set again: a new hold.
    let t2 = t1 + ms(1000);
    peer.send_output(b"\x1b[?2026l");
    let f4 = s.frame_since_at(f3.seq, t2).unwrap();
    peer.send_output(b"\x1b[?2026hfive");
    assert_eq!(s.frame_since_at(f4.seq, t2 + ms(1)), None);
    assert_eq!(s.deadline(), Some(t2 + ms(1) + DEFAULT_SYNC_TIMEOUT));
}

#[test]
fn a_set_and_clear_inside_one_batch_publishes_normally() {
    let (mut s, peer) = session(20, 5);
    let t = Instant::now();
    let f0 = s.frame_since_at(0, t).unwrap();
    peer.send_output(b"\x1b[?2026hframe\x1b[?2026l");
    let f1 = s.frame_since_at(f0.seq, t).unwrap();
    assert_eq!(row_text(&f1, 0), "frame");
}

#[test]
fn resize_publishes_through_a_sync_hold() {
    let (mut s, peer) = session(20, 5);
    let t = Instant::now();
    let f0 = s.frame_since_at(0, t).unwrap();
    peer.send_output(b"\x1b[?2026hx");
    assert_eq!(s.frame_since_at(f0.seq, t), None);
    s.resize(30, 6);
    let f1 = s.frame_since_at(f0.seq, t).expect("resize is not held");
    assert_eq!((f1.cols, f1.rows), (30, 6));
    assert!(f1.damage.full);
}

#[test]
fn replies_during_replay_are_dropped_and_later_ones_sent() {
    let (mut s, peer) = session(20, 5);
    let t = Instant::now();
    // History asks for a status report and device attributes.
    peer.send_replay(b"old\x1b[5n\x1b[c");
    assert_eq!(s.frame_since_at(0, t), None, "nothing shown mid-replay");
    assert!(s.replaying());
    assert!(peer.take_written().is_empty());
    assert!(s.stats().dropped_reply_bytes > 0);

    peer.send_replay(b" history");
    peer.end_replay();
    peer.send_output(b"\x1b[5n");
    let f = s.frame_since_at(0, t).expect("published after replay");
    assert!(!s.replaying());
    assert_eq!(row_text(&f, 0), "old history");
    assert_eq!(peer.take_written(), b"\x1b[0n", "only the live query");
}

#[test]
fn replay_and_live_in_one_tick_are_kept_apart() {
    let (mut s, peer) = session(20, 5);
    peer.send_replay(b"\x1b[5nA");
    peer.end_replay();
    peer.send_output(b"\x1b[5nB");
    s.tick(Instant::now());
    assert_eq!(s.stats().advances, 2, "one pass each side of the boundary");
    assert_eq!(peer.take_written(), b"\x1b[0n");
    assert_eq!(row_text(&s.take_frame(0).unwrap(), 0), "AB");
}

#[test]
fn live_output_ends_a_replay_without_an_end_marker() {
    let (mut s, peer) = session(20, 5);
    peer.send_replay(b"\x1b[5nA");
    s.tick(Instant::now());
    assert!(s.replaying());
    peer.send_output(b"\x1b[5nB");
    let f = s.frame_since_at(0, Instant::now()).unwrap();
    assert_eq!(row_text(&f, 0), "AB");
    assert_eq!(peer.take_written(), b"\x1b[0n");
}

#[test]
fn an_explicit_replay_drops_its_replies() {
    let (mut s, peer) = session(20, 5);
    s.replay(b"snap\x1b[5n\x1b[6n");
    peer.send_output(b"\x1b[5n");
    let f = s.frame_since_at(0, Instant::now()).unwrap();
    assert_eq!(row_text(&f, 0), "snap");
    assert_eq!(peer.take_written(), b"\x1b[0n");
}

#[test]
fn starting_in_replay_shows_nothing_until_it_ends() {
    let (mut s, peer) = session_with(SessionConfig {
        cols: 20,
        rows: 5,
        starts_with_replay: true,
        ..SessionConfig::default()
    });
    let t = Instant::now();
    assert_eq!(s.frame_since_at(0, t), None);
    peer.send_replay(b"$ ");
    assert_eq!(s.frame_since_at(0, t), None);
    peer.end_replay();
    let f = s.frame_since_at(0, t).expect("published at the end marker");
    assert_eq!(row_text(&f, 0), "$");
}

#[test]
fn arrow_keys_follow_decckm_through_the_link() {
    let (mut s, peer) = session(20, 5);
    let t = Instant::now();
    s.frame_since_at(0, t);
    assert!(s.key(&KeyEvent::new(Key::Up)));
    assert_eq!(peer.take_written(), b"\x1b[A");

    peer.send_output(b"\x1b[?1h");
    let f = s.frame_since_at(0, t).unwrap();
    assert!(f.modes.app_cursor_keys);
    assert!(s.key(&KeyEvent::new(Key::Up)));
    assert!(s.key(&KeyEvent::new(Key::Left)));
    assert_eq!(peer.take_written(), b"\x1bOA\x1bOD");

    peer.send_output(b"\x1b[?1l");
    s.frame_since_at(f.seq, t);
    assert!(s.key(&KeyEvent::new(Key::Up)));
    assert_eq!(peer.take_written(), b"\x1b[A");

    let ctrl_c = KeyEvent::new(Key::Char('c')).with_mods(Mods::CTRL);
    assert!(s.key(&ctrl_c));
    assert_eq!(peer.take_written(), b"\x03");
}

#[test]
fn keys_use_modes_newer_than_a_held_frame() {
    let (mut s, peer) = session(20, 5);
    let t = Instant::now();
    let f0 = s.frame_since_at(0, t).unwrap();
    peer.send_output(b"\x1b[?2026h\x1b[?1h");
    assert_eq!(s.frame_since_at(f0.seq, t), None);
    assert!(s.key(&KeyEvent::new(Key::Up)));
    assert_eq!(peer.take_written(), b"\x1bOA");
}

#[test]
fn paste_focus_text_and_mouse_follow_modes() {
    let (mut s, peer) = session(20, 5);
    let t = Instant::now();
    s.frame_since_at(0, t);
    assert!(s.paste("a\nb"));
    assert!(!s.focus(true), "focus reports are off");
    let click = MouseEvent {
        kind: MouseEventKind::Press(MouseButton::Left),
        col: 2,
        row: 1,
        mods: Mods::NONE,
    };
    assert!(!s.mouse(&click), "mouse reports are off");
    assert!(s.text("é"));
    assert_eq!(peer.take_written(), "a\rbé".as_bytes());

    peer.send_output(b"\x1b[?2004h\x1b[?1004h\x1b[?1000h\x1b[?1006h");
    s.frame_since_at(0, t);
    assert!(s.paste("x"));
    assert!(s.focus(false));
    assert!(s.mouse(&click));
    assert_eq!(
        peer.take_written(),
        b"\x1b[200~x\x1b[201~\x1b[O\x1b[<0;3;2M"
    );
}

#[test]
fn resize_reaches_screen_and_link() {
    let (mut s, peer) = session(20, 5);
    let t = Instant::now();
    peer.send_output(b"text");
    let f0 = s.frame_since_at(0, t).unwrap();
    s.resize(30, 8);
    assert_eq!(peer.resizes(), vec![(30, 8)]);
    let f1 = s.frame_since_at(f0.seq, t).unwrap();
    assert_eq!((f1.cols, f1.rows), (30, 8));
    assert!(f1.damage.full);
    assert_eq!(row_text(&f1, 0), "text");
    assert_eq!((s.screen().cols(), s.screen().rows()), (30, 8));
    // The same size again is not sent again.
    s.resize(30, 8);
    assert_eq!(peer.resizes().len(), 1);
}

#[test]
fn unconsumed_frames_stop_reading() {
    let budget = 8 * 1024;
    let (mut s, peer) = session_with(SessionConfig {
        cols: 80,
        rows: 24,
        tick_budget: budget,
        ..SessionConfig::default()
    });
    let line = [b'x'; 79];
    let mut chunk = Vec::new();
    for _ in 0..1000 {
        chunk.extend_from_slice(&line);
        chunk.extend_from_slice(b"\r\n");
    }
    peer.send_output(&chunk);
    let total = chunk.len();
    let t = Instant::now();

    let first = s.tick(t);
    assert!(first.published);
    assert!(first.more, "budget ran out with output waiting");
    assert_eq!(s.stats().live_bytes, budget as u64);
    // Nobody takes the frame: nothing more is read, however often it ticks.
    for _ in 0..10 {
        assert!(!s.tick(t).published);
    }
    assert_eq!(s.stats().live_bytes, budget as u64);
    assert_eq!(peer.unread(), total - budget);

    // Taking it lets the next tick read one more budget.
    let f = s.take_frame(0).unwrap();
    s.tick(t);
    assert_eq!(s.stats().live_bytes, 2 * budget as u64);
    // Draining through frame_since_at finishes, one budget per frame.
    let mut seq = f.seq;
    let mut frames = 0;
    while peer.unread() > 0 {
        if let Some(f) = s.frame_since_at(seq, t) {
            seq = f.seq;
        }
        frames += 1;
        assert!(frames < 1000);
    }
    assert_eq!(s.stats().live_bytes, total as u64);
    assert!(frames <= total / budget + 2);
}

#[test]
fn writes_the_link_cannot_take_wait_and_are_capped() {
    let (mut s, peer) = session_with(SessionConfig {
        cols: 20,
        rows: 5,
        max_pending_write: 8,
        ..SessionConfig::default()
    });
    peer.set_write_capacity(Some(4));
    assert!(s.send(b"abcdef"));
    assert_eq!(peer.take_written(), b"abcd");
    assert_eq!(s.pending_write(), 2);
    // Over the cap while something waits: refused whole.
    assert!(!s.send(b"0123456789"));
    assert_eq!(s.stats().refused_writes, 1);
    s.tick(Instant::now());
    assert_eq!(peer.take_written(), b"ef");
    assert_eq!(s.pending_write(), 0);
}

#[test]
fn the_program_exiting_closes_the_session() {
    let (mut s, peer) = session(20, 5);
    let t = Instant::now();
    peer.send_output(b"bye");
    peer.close();
    let f = s.frame_since_at(0, t).expect("last frame");
    assert_eq!(row_text(&f, 0), "bye");
    assert!(s.closed());
    assert!(!s.send(b"x"));
    assert!(peer.take_written().is_empty());
}

#[test]
fn closing_the_session_closes_the_link() {
    let (mut s, peer) = session(20, 5);
    s.close();
    assert!(peer.closed_by_session());
    assert!(!s.closed(), "the final frame has not been taken yet");
    assert!(s.frame_since_at(0, Instant::now()).is_some());
    assert!(s.closed());
}

#[test]
fn the_waker_fires_on_output_and_when_more_is_waiting() {
    let (mut s, peer) = session_with(SessionConfig {
        cols: 80,
        rows: 24,
        tick_budget: 4096,
        ..SessionConfig::default()
    });
    let wakes = Arc::new(AtomicUsize::new(0));
    let w = wakes.clone();
    s.set_waker(Arc::new(move || {
        w.fetch_add(1, Ordering::SeqCst);
    }));
    peer.send_output(&[b'a'; 10_000]);
    assert_eq!(wakes.load(Ordering::SeqCst), 1, "the link woke the viewer");
    let f = s.frame_since(0).unwrap();
    assert_eq!(
        wakes.load(Ordering::SeqCst),
        2,
        "budget ran out: wake again"
    );
    s.frame_since(f.seq);
    s.frame_since(f.seq + 1);
    assert_eq!(s.stats().live_bytes, 10_000);
}

// ---- review fixes ----

#[test]
fn a_failed_write_does_not_drop_the_programs_last_output() {
    let (mut s, peer) = session(20, 5);
    let t = Instant::now();
    let f0 = s.frame_since_at(0, t).unwrap();
    // The shell has closed its input and is about to print and exit.
    peer.fail_writes(true);
    assert!(s.text("x"), "accepted, then the link failed");
    assert!(!s.closed(), "a write error does not end the session");
    assert!(!peer.closed_by_session());
    assert!(!s.send(b"y"), "nothing more is written");
    assert_eq!(s.pending_write(), 0);

    peer.send_output(b"final words\r\n");
    let f1 = s.frame_since_at(f0.seq, t).expect("output is still read");
    assert_eq!(row_text(&f1, 0), "final words");
    assert!(!s.closed());

    peer.close();
    s.frame_since_at(f1.seq, t);
    assert!(s.closed(), "ends when the link says Closed");
    assert!(peer.closed_by_session(), "and the link is closed once");
}

#[test]
fn closed_waits_for_the_final_frame_and_resets_sync() {
    let (mut s, peer) = session(20, 5);
    let t = Instant::now();
    let f0 = s.frame_since_at(0, t).unwrap();
    peer.send_output(b"\x1b[?2026hlast");
    assert_eq!(s.frame_since_at(f0.seq, t), None, "held");
    peer.close();
    s.tick(t);
    assert!(!s.closed(), "the final frame is published but not taken");
    assert_eq!(s.deadline(), None, "no sync hold left after close");
    let f1 = s.take_frame(f0.seq).expect("final frame through the hold");
    assert_eq!(row_text(&f1, 0), "last");
    assert!(s.closed());
}

#[test]
fn refused_input_asks_for_another_tick() {
    let (mut s, peer) = session(20, 5);
    let t = Instant::now();
    peer.set_write_capacity(Some(4));
    assert!(s.send(b"abcdef"));
    let tick = s.tick(t);
    assert!(tick.write_pending);
    let retry = t + DEFAULT_WRITE_RETRY;
    assert_eq!(tick.deadline, Some(retry));
    assert_eq!(s.deadline(), Some(retry));

    // Still full at the retry: asks again.
    let tick = s.tick(retry);
    assert!(tick.write_pending);
    assert_eq!(tick.deadline, Some(retry + DEFAULT_WRITE_RETRY));

    peer.take_written();
    let tick = s.tick(retry + DEFAULT_WRITE_RETRY);
    assert!(!tick.write_pending);
    assert_eq!(tick.deadline, None);
    assert_eq!(peer.take_written(), b"ef");
}

#[test]
fn replies_behind_a_full_write_queue_are_kept_not_dropped() {
    let (mut s, peer) = session_with(SessionConfig {
        cols: 20,
        rows: 5,
        max_pending_write: 16,
        ..SessionConfig::default()
    });
    let t = Instant::now();
    peer.set_write_capacity(Some(0));
    assert!(s.send(b"0123456789abcd"));
    // 14 queued; the 4-byte reply to a status query does not fit behind it.
    peer.send_output(b"\x1b[5n");
    s.tick(t);
    assert_eq!(s.stats().reply_bytes, 4);
    assert_eq!(s.stats().overflowed_reply_bytes, 0);
    assert_eq!(s.pending_write(), 18);
    // Input cannot jump the queue past the cap.
    assert!(!s.send(b"zzz"));

    peer.set_write_capacity(None);
    s.tick(t + ms(20));
    assert_eq!(peer.take_written(), b"0123456789abcd\x1b[0n");
    assert_eq!(s.pending_write(), 0);
}

#[test]
fn replies_past_their_own_bound_are_counted_as_dropped() {
    let (mut s, peer) = session_with(SessionConfig {
        cols: 20,
        rows: 5,
        max_pending_write: 8,
        ..SessionConfig::default()
    });
    let t = Instant::now();
    peer.set_write_capacity(Some(0));
    assert!(s.send(b"01234567"));
    // Each reply is 4 bytes: two fit in the reply queue, the third does not.
    for _ in 0..3 {
        peer.send_output(b"\x1b[5n");
        s.tick(t);
        let _ = s.take_frame(0);
    }
    assert_eq!(s.stats().reply_bytes, 8);
    assert_eq!(s.stats().overflowed_reply_bytes, 4);
}

#[test]
fn steady_sync_frames_after_a_timeout_are_not_shown_half_drawn() {
    let (mut s, peer) = session(20, 5);
    let t0 = Instant::now();
    let f0 = s.frame_since_at(0, t0).unwrap();
    peer.send_output(b"\x1b[?2026hA");
    assert_eq!(s.frame_since_at(f0.seq, t0), None);
    let f1 = s
        .frame_since_at(f0.seq, t0 + DEFAULT_SYNC_TIMEOUT)
        .expect("released at the timeout");
    assert_eq!(row_text(&f1, 0), "A");

    // From here on the program sends whole frames, each ending 2026l and the
    // next starting 2026h in the same read. Each is shown complete, none
    // half drawn, and each starts a fresh hold.
    let mut seen = f1.seq;
    let mut now = t0 + DEFAULT_SYNC_TIMEOUT;
    let mut expect = String::from("A");
    for i in 0..3u8 {
        now += ms(200);
        let word = (b'b' + i) as char;
        peer.send_output(format!("{word}\x1b[?2026l\x1b[?2026hp").as_bytes());
        expect.push(word);
        let f = s
            .frame_since_at(seen, now)
            .expect("the finished frame is published");
        assert_eq!(row_text(&f, 0), expect, "frame {i} is whole");
        seen = f.seq;
        assert_eq!(
            s.deadline(),
            Some(now + DEFAULT_SYNC_TIMEOUT),
            "a fresh hold started for the next frame"
        );
        // The rest of the frame arrives later and completes it.
        peer.send_output(b"r\x1b[?2026l\x1b[?2026h");
        let g = s.frame_since_at(seen, now + ms(10)).unwrap();
        assert_eq!(row_text(&g, 0), format!("{expect}pr"));
        seen = g.seq;
        // Next iteration's text continues after the longer line.
        expect = format!("{expect}pr");
    }
}

#[test]
fn a_2026l_split_across_reads_is_still_seen() {
    let (mut s, peer) = session(20, 5);
    let t = Instant::now();
    let f0 = s.frame_since_at(0, t).unwrap();
    peer.send_output(b"\x1b[?2026hone");
    assert_eq!(s.frame_since_at(f0.seq, t), None);
    peer.send_output(b"\x1b[?20");
    s.tick(t);
    peer.send_output(b"26l\x1b[?2026hmore");
    let f = s.frame_since_at(f0.seq, t).expect("frame at the 2026l");
    assert_eq!(row_text(&f, 0), "one");
}

#[test]
fn an_interrupted_read_is_retried_in_the_same_tick() {
    let (mut s, peer) = session(20, 5);
    let t = Instant::now();
    peer.send_output(b"hello");
    peer.interrupt_reads(2);
    let f = s.frame_since_at(0, t).unwrap();
    assert_eq!(row_text(&f, 0), "hello");
    assert!(!s.closed());
}

#[test]
fn an_interrupted_write_is_retried() {
    let (mut s, peer) = session(20, 5);
    peer.interrupt_writes(2);
    assert!(s.send(b"abc"));
    assert_eq!(peer.take_written(), b"abc");
    assert_eq!(s.pending_write(), 0);
}

#[test]
fn one_input_larger_than_the_cap_is_refused() {
    let (mut s, peer) = session_with(SessionConfig {
        cols: 20,
        rows: 5,
        max_pending_write: 8,
        ..SessionConfig::default()
    });
    assert!(!s.send(b"0123456789"));
    assert_eq!(s.stats().refused_writes, 1);
    assert!(peer.take_written().is_empty());
    assert!(s.send(b"01234567"));
}

#[test]
fn the_tick_budget_is_clamped() {
    let (s, _peer) = session_with(SessionConfig {
        tick_budget: usize::MAX,
        ..SessionConfig::default()
    });
    assert_eq!(s.config().tick_budget, canopy_term_session::MAX_TICK_BUDGET);
}
