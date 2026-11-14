//! [`StreamLink`]: a [`SessionLink`] over a blocking byte stream (a unix
//! socket to the PTY host, later a pipe or a network stream).
//!
//! The session runs on the window's thread, where nothing may block, so the
//! blocking stream is served by three small threads and the link itself only
//! touches a few queues under one short lock:
//!
//! * a **reader** reads into one reused buffer and appends to a **bounded**
//!   input queue. When the queue is full it stops reading, so backpressure
//!   reaches the program through the socket instead of growing memory. It
//!   calls the waker only when the queue goes from drained to non-empty, so a
//!   burst of reads is one wakeup of the event loop.
//! * a **writer** swaps the queued input out and writes it. The queue is
//!   bounded too; `try_write` takes what fits and returns the count, so a
//!   stalled host shows up as "0 accepted", never as a blocked window.
//! * a **resizer** applies the newest requested size. Resizes are a
//!   request/response call to the host, so a drag over many sizes collapses
//!   into the latest one.
//!
//! The first `replay_bytes` bytes read are history (the host's ring) and are
//! reported as [`LinkRead::Replay`], followed by [`LinkRead::ReplayEnd`]; what
//! follows is live. In steady state nothing is allocated: the buffers reach
//! their working size once.

use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;

use canopy_term_session::{LinkRead, SessionLink, Waker};

/// Bytes of output queued for the session before the reader stops reading.
pub const DEFAULT_IN_CAP: usize = 1 << 20;
/// Bytes of input queued or in flight before `try_write` returns 0.
pub const DEFAULT_OUT_CAP: usize = 1 << 16;
/// Bytes the reader asks the stream for at a time.
pub const DEFAULT_READ_CHUNK: usize = 1 << 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub in_cap: usize,
    pub out_cap: usize,
    pub read_chunk: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            in_cap: DEFAULT_IN_CAP,
            out_cap: DEFAULT_OUT_CAP,
            read_chunk: DEFAULT_READ_CHUNK,
        }
    }
}

#[derive(Default)]
struct State {
    inq: VecDeque<u8>,
    /// Bytes of history the session has not read yet.
    replay_left: u64,
    replay_end_sent: bool,
    /// A wakeup was sent and the session has not drained the queue since.
    wake_sent: bool,
    /// The stream ended or failed; what is queued can still be read.
    eof: bool,

    outq: Vec<u8>,
    /// Bytes the writer has taken and is writing.
    out_inflight: usize,
    write_failed: bool,

    resize: Option<(u16, u16)>,
    /// `close` was called: everything stops.
    closed: bool,
}

struct Shared {
    state: Mutex<State>,
    /// The reader waits here for room in the input queue.
    space: Condvar,
    out_ready: Condvar,
    resize_ready: Condvar,
    waker: Mutex<Option<Waker>>,
    closer: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    limits: Limits,
}

fn relock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn wait<'a>(cv: &Condvar, guard: MutexGuard<'a, State>) -> MutexGuard<'a, State> {
    cv.wait(guard).unwrap_or_else(|e| e.into_inner())
}

impl Shared {
    fn wake(&self) {
        let waker = relock(&self.waker).clone();
        if let Some(w) = waker {
            w();
        }
    }

    /// Runs the closer once: it shuts the stream, which unblocks the reader
    /// and writer.
    fn run_closer(&self) {
        let closer = relock(&self.closer).take();
        if let Some(c) = closer {
            c();
        }
    }

    /// Appends output, waiting while the queue is full. False if the link
    /// was closed.
    fn push_in(&self, bytes: &[u8]) -> bool {
        let wake = {
            let mut st = relock(&self.state);
            loop {
                if st.closed {
                    return false;
                }
                // An empty queue always takes a chunk, so a chunk larger
                // than the cap cannot deadlock.
                if st.inq.is_empty() || st.inq.len() + bytes.len() <= self.limits.in_cap {
                    break;
                }
                st = wait(&self.space, st);
            }
            st.inq.extend(bytes);
            let wake = !st.wake_sent;
            st.wake_sent = true;
            wake
        };
        if wake {
            self.wake();
        }
        true
    }

    fn finish_in(&self) {
        {
            let mut st = relock(&self.state);
            st.eof = true;
            st.wake_sent = true;
        }
        self.wake();
    }

    fn shutdown(&self) {
        {
            let mut st = relock(&self.state);
            st.closed = true;
            st.inq.clear();
            st.outq.clear();
            st.resize = None;
        }
        self.space.notify_all();
        self.out_ready.notify_all();
        self.resize_ready.notify_all();
        self.run_closer();
    }
}

fn reader_loop<R: Read>(shared: &Shared, mut reader: R) {
    let mut buf = vec![0u8; shared.limits.read_chunk.max(1)];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if !shared.push_in(&buf[..n]) {
                    break;
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    shared.finish_in();
}

fn writer_loop<W: Write>(shared: &Shared, mut writer: W) {
    let mut local: Vec<u8> = Vec::new();
    loop {
        {
            let mut st = relock(&shared.state);
            while st.outq.is_empty() && !st.closed {
                st = wait(&shared.out_ready, st);
            }
            if st.closed {
                return;
            }
            std::mem::swap(&mut st.outq, &mut local);
            st.out_inflight = local.len();
        }
        let result = writer.write_all(&local).and_then(|_| writer.flush());
        local.clear();
        let failed = {
            let mut st = relock(&shared.state);
            st.out_inflight = 0;
            if result.is_err() {
                st.write_failed = true;
            }
            result.is_err()
        };
        if failed {
            // The far end is gone for input; closing the stream lets the
            // reader see the end and the session finish.
            shared.run_closer();
            return;
        }
    }
}

fn resizer_loop(shared: &Shared, mut on_resize: impl FnMut(u16, u16)) {
    loop {
        let (cols, rows) = {
            let mut st = relock(&shared.state);
            loop {
                if st.closed {
                    return;
                }
                if let Some(size) = st.resize.take() {
                    break size;
                }
                st = wait(&shared.resize_ready, st);
            }
        };
        on_resize(cols, rows);
    }
}

/// What a resize does at the host. A redraw nudge (for a session that was
/// already running) first sets one row fewer, because a resize to the size a
/// terminal already has delivers no SIGWINCH and a full-screen program would
/// not repaint. Returns the optional first step and the final size; `nudge` is
/// cleared once used.
pub fn resize_plan(cols: u16, rows: u16, nudge: &mut bool) -> (Option<(u16, u16)>, (u16, u16)) {
    let first = if std::mem::take(nudge) && rows >= 2 {
        Some((cols, rows - 1))
    } else {
        None
    };
    (first, (cols, rows))
}

/// A session link over a blocking stream. See the module docs.
pub struct StreamLink {
    shared: Arc<Shared>,
}

impl StreamLink {
    /// `reader` and `writer` are the two halves of the stream, `replay_bytes`
    /// how many of the first bytes read are history, `on_resize` applies a
    /// size at the far end (runs on its own thread) and `on_close` shuts the
    /// stream (called once, from any thread).
    pub fn new<R, W>(
        reader: R,
        writer: W,
        replay_bytes: u64,
        limits: Limits,
        on_resize: impl FnMut(u16, u16) + Send + 'static,
        on_close: impl FnOnce() + Send + 'static,
    ) -> StreamLink
    where
        R: Read + Send + 'static,
        W: Write + Send + 'static,
    {
        let closer: Box<dyn FnOnce() + Send> = Box::new(on_close);
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                replay_left: replay_bytes,
                ..State::default()
            }),
            space: Condvar::new(),
            out_ready: Condvar::new(),
            resize_ready: Condvar::new(),
            waker: Mutex::new(None),
            closer: Mutex::new(Some(closer)),
            limits: Limits {
                in_cap: limits.in_cap.max(1),
                out_cap: limits.out_cap.max(1),
                read_chunk: limits.read_chunk.max(1),
            },
        });
        let s = shared.clone();
        thread::Builder::new()
            .name("term-link-read".into())
            .spawn(move || reader_loop(&s, reader))
            .ok();
        let s = shared.clone();
        thread::Builder::new()
            .name("term-link-write".into())
            .spawn(move || writer_loop(&s, writer))
            .ok();
        let s = shared.clone();
        thread::Builder::new()
            .name("term-link-resize".into())
            .spawn(move || resizer_loop(&s, on_resize))
            .ok();
        StreamLink { shared }
    }

    /// Asks the far end for this size, without blocking. Only the newest
    /// request is applied.
    pub fn request_resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        {
            let mut st = relock(&self.shared.state);
            if st.closed {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            st.resize = Some((cols, rows));
        }
        self.shared.resize_ready.notify_one();
        Ok(())
    }

    /// Output bytes queued and not yet read by the session.
    pub fn queued(&self) -> usize {
        relock(&self.shared.state).inq.len()
    }
}

impl SessionLink for StreamLink {
    fn try_read(&mut self, buf: &mut [u8]) -> io::Result<LinkRead> {
        let shared = &*self.shared;
        let mut st = relock(&shared.state);
        if st.closed {
            return Ok(LinkRead::Closed);
        }
        if st.replay_left == 0 && !st.replay_end_sent {
            st.replay_end_sent = true;
            return Ok(LinkRead::ReplayEnd);
        }
        if st.inq.is_empty() {
            if st.eof {
                return Ok(LinkRead::Closed);
            }
            // Drained: the next push owes a wakeup.
            st.wake_sent = false;
            return Ok(LinkRead::Empty);
        }
        let replay = st.replay_left > 0;
        let mut n = buf.len().min(st.inq.len());
        if replay {
            // Never mix history and live bytes in one read.
            n = n.min(usize::try_from(st.replay_left).unwrap_or(usize::MAX));
        }
        if n == 0 {
            return Ok(LinkRead::Empty);
        }
        {
            let (a, b) = st.inq.as_slices();
            let first = n.min(a.len());
            buf[..first].copy_from_slice(&a[..first]);
            if n > first {
                buf[first..n].copy_from_slice(&b[..n - first]);
            }
        }
        st.inq.drain(..n);
        if replay {
            st.replay_left -= n as u64;
        }
        if st.inq.is_empty() {
            st.wake_sent = false;
        }
        drop(st);
        shared.space.notify_one();
        Ok(if replay {
            LinkRead::Replay(n)
        } else {
            LinkRead::Data(n)
        })
    }

    fn try_write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let shared = &*self.shared;
        let n = {
            let mut st = relock(&shared.state);
            if st.closed || st.write_failed {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            let used = st.outq.len() + st.out_inflight;
            let n = bytes.len().min(shared.limits.out_cap.saturating_sub(used));
            if n > 0 {
                st.outq.extend_from_slice(&bytes[..n]);
            }
            n
        };
        if n > 0 {
            shared.out_ready.notify_one();
        }
        Ok(n)
    }

    fn resize(&mut self, cols: u16, rows: u16) -> io::Result<()> {
        self.request_resize(cols, rows)
    }

    fn close(&mut self) {
        self.shared.shutdown();
    }

    fn set_waker(&mut self, waker: Waker) {
        *relock(&self.shared.waker) = Some(waker);
        // Output that arrived before the waker was installed.
        let pending = {
            let st = relock(&self.shared.state);
            !st.inq.is_empty() || st.eof
        };
        if pending {
            self.shared.wake();
        }
    }
}

impl Drop for StreamLink {
    fn drop(&mut self) {
        self.shared.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::time::{Duration, Instant};

    use canopy_term_session::frame::{Attrs, Frame};
    use canopy_term_session::{FrameSource, Session, SessionConfig};

    /// A blocking reader fed from a channel; the stream ends when every
    /// sender is dropped. Counts the bytes it has handed out.
    struct ChanReader {
        rx: Receiver<Vec<u8>>,
        rest: Vec<u8>,
        pos: usize,
        consumed: Arc<AtomicUsize>,
    }

    impl Read for ChanReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.pos == self.rest.len() {
                match self.rx.recv() {
                    Ok(v) => {
                        self.rest = v;
                        self.pos = 0;
                    }
                    Err(_) => return Ok(0),
                }
            }
            let n = buf.len().min(self.rest.len() - self.pos);
            buf[..n].copy_from_slice(&self.rest[self.pos..self.pos + n]);
            self.pos += n;
            self.consumed.fetch_add(n, Ordering::SeqCst);
            Ok(n)
        }
    }

    /// Records what is written, and can be held shut or made to fail.
    #[derive(Clone, Default)]
    struct TestWriter {
        got: Arc<Mutex<Vec<u8>>>,
        gate: Arc<(Mutex<bool>, Condvar)>,
        fail: Arc<AtomicBool>,
    }

    impl TestWriter {
        fn held() -> Self {
            let w = TestWriter::default();
            *w.gate.0.lock().unwrap() = true;
            w
        }
        fn release(&self) {
            *self.gate.0.lock().unwrap() = false;
            self.gate.1.notify_all();
        }
        fn text(&self) -> Vec<u8> {
            self.got.lock().unwrap().clone()
        }
    }

    impl Write for TestWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let mut held = self.gate.0.lock().unwrap();
            while *held {
                held = self.gate.1.wait(held).unwrap();
            }
            drop(held);
            if self.fail.load(Ordering::SeqCst) {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            self.got.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct Rig {
        link: StreamLink,
        tx: Sender<Vec<u8>>,
        consumed: Arc<AtomicUsize>,
        writer: TestWriter,
        resizes: Arc<Mutex<Vec<(u16, u16)>>>,
        closes: Arc<AtomicUsize>,
        wakes: Arc<AtomicUsize>,
    }

    fn rig(replay: u64, limits: Limits, writer: TestWriter) -> Rig {
        let (tx, rx) = channel();
        let consumed = Arc::new(AtomicUsize::new(0));
        let resizes = Arc::new(Mutex::new(Vec::new()));
        let closes = Arc::new(AtomicUsize::new(0));
        let wakes = Arc::new(AtomicUsize::new(0));
        let reader = ChanReader {
            rx,
            rest: Vec::new(),
            pos: 0,
            consumed: consumed.clone(),
        };
        let (r, c) = (resizes.clone(), closes.clone());
        let mut link = StreamLink::new(
            reader,
            writer.clone(),
            replay,
            limits,
            move |cols, rows| r.lock().unwrap().push((cols, rows)),
            move || {
                c.fetch_add(1, Ordering::SeqCst);
            },
        );
        let w = wakes.clone();
        link.set_waker(Arc::new(move || {
            w.fetch_add(1, Ordering::SeqCst);
        }));
        Rig {
            link,
            tx,
            consumed,
            writer,
            resizes,
            closes,
            wakes,
        }
    }

    fn plain() -> Rig {
        rig(0, Limits::default(), TestWriter::default())
    }

    fn until(mut done: impl FnMut() -> bool) {
        let start = Instant::now();
        while !done() {
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "timed out waiting"
            );
            thread::sleep(Duration::from_millis(2));
        }
    }

    fn read(link: &mut StreamLink, cap: usize) -> (LinkRead, Vec<u8>) {
        let mut buf = vec![0u8; cap];
        let r = link.try_read(&mut buf).unwrap();
        let n = match r {
            LinkRead::Data(n) | LinkRead::Replay(n) => n,
            _ => 0,
        };
        buf.truncate(n);
        (r, buf)
    }

    #[test]
    fn history_is_replay_then_an_end_marker_then_live() {
        let mut rig = rig(5, Limits::default(), TestWriter::default());
        rig.tx.send(b"hello".to_vec()).unwrap();
        rig.tx.send(b"world".to_vec()).unwrap();
        until(|| rig.link.queued() == 10);
        assert_eq!(
            read(&mut rig.link, 64),
            (LinkRead::Replay(5), b"hello".to_vec())
        );
        assert_eq!(read(&mut rig.link, 64).0, LinkRead::ReplayEnd);
        assert_eq!(
            read(&mut rig.link, 64),
            (LinkRead::Data(5), b"world".to_vec())
        );
        assert_eq!(read(&mut rig.link, 64).0, LinkRead::Empty);
    }

    #[test]
    fn a_read_never_mixes_history_and_live_bytes() {
        let mut rig = rig(3, Limits::default(), TestWriter::default());
        rig.tx.send(b"abcdef".to_vec()).unwrap();
        until(|| rig.link.queued() == 6);
        assert_eq!(
            read(&mut rig.link, 64),
            (LinkRead::Replay(3), b"abc".to_vec())
        );
        assert_eq!(read(&mut rig.link, 64).0, LinkRead::ReplayEnd);
        assert_eq!(read(&mut rig.link, 2), (LinkRead::Data(2), b"de".to_vec()));
        assert_eq!(read(&mut rig.link, 2), (LinkRead::Data(1), b"f".to_vec()));
    }

    #[test]
    fn no_history_still_reports_the_end_of_it_first() {
        let mut rig = plain();
        assert_eq!(read(&mut rig.link, 8).0, LinkRead::ReplayEnd);
        assert_eq!(read(&mut rig.link, 8).0, LinkRead::Empty);
    }

    #[test]
    fn a_burst_of_reads_is_one_wakeup() {
        let mut rig = plain();
        for _ in 0..50 {
            rig.tx.send(b"x".to_vec()).unwrap();
        }
        until(|| rig.link.queued() == 50);
        // The queue fills before the reader thread calls the waker, so wait
        // for the wake; the burst must still have produced exactly one.
        until(|| rig.wakes.load(Ordering::SeqCst) >= 1);
        assert_eq!(rig.wakes.load(Ordering::SeqCst), 1);
        // Drained, so the next output wakes again.
        assert_eq!(read(&mut rig.link, 8).0, LinkRead::ReplayEnd);
        assert_eq!(
            read(&mut rig.link, 64),
            (LinkRead::Data(50), vec![b'x'; 50])
        );
        rig.tx.send(b"y".to_vec()).unwrap();
        until(|| rig.link.queued() == 1);
        until(|| rig.wakes.load(Ordering::SeqCst) >= 2);
        assert_eq!(rig.wakes.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn output_before_the_waker_wakes_when_it_is_installed() {
        let (tx, rx) = channel();
        let reader = ChanReader {
            rx,
            rest: Vec::new(),
            pos: 0,
            consumed: Arc::new(AtomicUsize::new(0)),
        };
        let mut link = StreamLink::new(
            reader,
            TestWriter::default(),
            0,
            Limits::default(),
            |_, _| {},
            || {},
        );
        tx.send(b"early".to_vec()).unwrap();
        until(|| link.queued() == 5);
        let wakes = Arc::new(AtomicUsize::new(0));
        let w = wakes.clone();
        link.set_waker(Arc::new(move || {
            w.fetch_add(1, Ordering::SeqCst);
        }));
        assert_eq!(wakes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_full_queue_stops_the_reader_and_loses_nothing() {
        let limits = Limits {
            in_cap: 8,
            out_cap: 8,
            read_chunk: 4,
        };
        let mut rig = rig(0, limits, TestWriter::default());
        for i in 0..6u8 {
            rig.tx.send(vec![b'a' + i; 4]).unwrap();
        }
        // Two chunks fill the queue; the third is read and then held.
        until(|| rig.consumed.load(Ordering::SeqCst) >= 12);
        thread::sleep(Duration::from_millis(50));
        assert_eq!(rig.consumed.load(Ordering::SeqCst), 12);
        assert_eq!(rig.link.queued(), 8);

        let mut got = Vec::new();
        let start = Instant::now();
        while got.len() < 24 {
            assert!(start.elapsed() < Duration::from_secs(10), "timed out");
            let (r, bytes) = read(&mut rig.link, 4);
            if matches!(r, LinkRead::Data(_)) {
                got.extend(bytes);
            } else {
                thread::sleep(Duration::from_millis(2));
            }
        }
        let expect: Vec<u8> = (0..6u8).flat_map(|i| vec![b'a' + i; 4]).collect();
        assert_eq!(got, expect);
    }

    #[test]
    fn the_end_of_the_stream_is_a_sticky_close_after_the_queue_drains() {
        let rig = plain();
        rig.tx.send(b"bye".to_vec()).unwrap();
        until(|| rig.link.queued() == 3);
        let Rig { mut link, tx, .. } = rig;
        drop(tx);
        let mut got = Vec::new();
        let start = Instant::now();
        loop {
            assert!(start.elapsed() < Duration::from_secs(10), "timed out");
            match read(&mut link, 16) {
                (LinkRead::Closed, _) => break,
                (LinkRead::Data(_), bytes) => got.extend(bytes),
                _ => thread::sleep(Duration::from_millis(2)),
            }
        }
        assert_eq!(got, b"bye");
        assert_eq!(read(&mut link, 16).0, LinkRead::Closed);
    }

    #[test]
    fn input_reaches_the_stream() {
        let mut rig = plain();
        assert_eq!(rig.link.try_write(b"abc").unwrap(), 3);
        assert_eq!(rig.link.try_write(b"def").unwrap(), 3);
        until(|| rig.writer.text() == b"abcdef");
    }

    #[test]
    fn a_stalled_stream_fills_the_input_queue_and_never_blocks() {
        let limits = Limits {
            in_cap: 64,
            out_cap: 4,
            read_chunk: 16,
        };
        let writer = TestWriter::held();
        let mut rig = rig(0, limits, writer.clone());
        assert_eq!(rig.link.try_write(b"abcdef").unwrap(), 4);
        // Whether or not the writer has taken them yet, the four count.
        assert_eq!(rig.link.try_write(b"e").unwrap(), 0);
        writer.release();
        until(|| writer.text() == b"abcd");
        until(|| rig.link.try_write(b"e").unwrap() == 1);
        until(|| writer.text() == b"abcde");
    }

    #[test]
    fn a_failed_write_is_reported_and_closes_the_stream() {
        let writer = TestWriter::default();
        writer.fail.store(true, Ordering::SeqCst);
        let mut rig = rig(0, Limits::default(), writer);
        assert_eq!(rig.link.try_write(b"x").unwrap(), 1);
        until(|| rig.link.try_write(b"x").is_err());
        until(|| rig.closes.load(Ordering::SeqCst) == 1);
    }

    #[test]
    fn resizes_collapse_to_the_newest() {
        let mut rig = plain();
        for i in 0..200u16 {
            rig.link.resize(80 + i, 24).unwrap();
        }
        until(|| rig.resizes.lock().unwrap().last() == Some(&(279, 24)));
        let seen = rig.resizes.lock().unwrap().len();
        assert!(seen <= 200);
    }

    #[test]
    fn close_stops_everything_and_closes_the_stream_once() {
        let mut rig = plain();
        rig.link.close();
        assert_eq!(read(&mut rig.link, 8).0, LinkRead::Closed);
        assert!(rig.link.try_write(b"x").is_err());
        assert!(rig.link.resize(1, 1).is_err());
        let closes = rig.closes.clone();
        drop(rig);
        assert_eq!(closes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_nudge_sets_one_row_fewer_first_and_only_once() {
        let mut nudge = true;
        assert_eq!(resize_plan(80, 24, &mut nudge), (Some((80, 23)), (80, 24)));
        assert!(!nudge);
        assert_eq!(resize_plan(81, 24, &mut nudge), (None, (81, 24)));
        let mut nudge = true;
        assert_eq!(resize_plan(80, 1, &mut nudge), (None, (80, 1)));
    }

    fn row_text(f: &Frame, row: u16) -> String {
        let mut s = String::new();
        for col in 0..f.cols {
            if let Some(cell) = f.cell(row, col) {
                if !cell.attrs.has(Attrs::WIDE_TAIL) {
                    s.push_str(&f.text(cell));
                }
            }
        }
        s.trim_end().to_string()
    }

    /// The whole headless path the window uses: stream, link, session, frames
    /// out and input back, with only the stream faked.
    #[test]
    fn a_session_over_the_link_shows_history_takes_input_resizes_and_ends() {
        let rig = rig(7, Limits::default(), TestWriter::default());
        let Rig {
            link,
            tx,
            writer,
            resizes,
            wakes,
            ..
        } = rig;
        let mut session = Session::new(
            link,
            SessionConfig {
                cols: 20,
                rows: 5,
                starts_with_replay: true,
                ..SessionConfig::default()
            },
        );
        // History, then live output that turns on bracketed paste.
        tx.send(b"hello\r\n".to_vec()).unwrap();
        tx.send(b"\x1b[?2004h$ ".to_vec()).unwrap();
        let mut frame = Frame::default();
        let mut seq = 0;
        until(|| {
            if FrameSource::frame_into(&mut session, seq, &mut frame) {
                seq = frame.seq;
            }
            row_text(&frame, 0) == "hello" && session.modes().bracketed_paste
        });
        assert_eq!(row_text(&frame, 1), "$");
        assert!(wakes.load(Ordering::SeqCst) >= 1);

        // Typed text and a bracketed paste reach the stream, in order.
        assert!(FrameSource::text(&mut session, "ls"));
        assert!(FrameSource::paste(&mut session, "a b"));
        until(|| {
            let got = writer.text();
            got.starts_with(b"ls\x1b[200~a b") && got.ends_with(b"\x1b[201~")
        });

        // A resize reaches the far end.
        FrameSource::resize(&mut session, 40, 10);
        until(|| resizes.lock().unwrap().last() == Some(&(40, 10)));

        // The program exits: the stream ends and the session finishes.
        drop(tx);
        until(|| {
            let _ = FrameSource::frame_into(&mut session, seq, &mut frame);
            FrameSource::closed(&session)
        });
    }
}
