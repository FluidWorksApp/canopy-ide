//! An in-memory [`SessionLink`] for tests and demos: the test plays the
//! program through a [`MemoryPeer`].

use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::link::{LinkRead, SessionLink};
use crate::source::Waker;

enum Item {
    Live(Vec<u8>),
    Replay(Vec<u8>),
    ReplayEnd,
    Closed,
}

#[derive(Default)]
struct Inner {
    queue: VecDeque<Item>,
    /// Bytes of the front item already read.
    offset: usize,
    /// Output queued and not yet read, in bytes.
    queued: usize,
    written: Vec<u8>,
    write_capacity: Option<usize>,
    /// Writes fail with `BrokenPipe` (the program's input side is gone).
    fail_writes: bool,
    /// Reads and writes that fail with `Interrupted` before working.
    read_interrupts: u32,
    write_interrupts: u32,
    resizes: Vec<(u16, u16)>,
    closed_by_session: bool,
    waker: Option<Waker>,
}

fn lock(m: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The session's end of an in-memory link.
pub struct MemoryLink {
    inner: Arc<Mutex<Inner>>,
}

/// The program's end of an in-memory link.
#[derive(Clone)]
pub struct MemoryPeer {
    inner: Arc<Mutex<Inner>>,
}

impl MemoryLink {
    /// A connected link and peer.
    pub fn pair() -> (MemoryLink, MemoryPeer) {
        let inner = Arc::new(Mutex::new(Inner::default()));
        (
            MemoryLink {
                inner: inner.clone(),
            },
            MemoryPeer { inner },
        )
    }
}

impl MemoryPeer {
    fn push(&self, item: Item, len: usize) {
        let waker = {
            let mut g = lock(&self.inner);
            g.queue.push_back(item);
            g.queued += len;
            g.waker.clone()
        };
        if let Some(w) = waker {
            w();
        }
    }

    /// Live output from the program.
    pub fn send_output(&self, bytes: &[u8]) {
        if !bytes.is_empty() {
            self.push(Item::Live(bytes.to_vec()), bytes.len());
        }
    }

    /// History replayed on attach.
    pub fn send_replay(&self, bytes: &[u8]) {
        if !bytes.is_empty() {
            self.push(Item::Replay(bytes.to_vec()), bytes.len());
        }
    }

    /// The end of the history.
    pub fn end_replay(&self) {
        self.push(Item::ReplayEnd, 0);
    }

    /// The program exits (after the session has read what is queued).
    pub fn close(&self) {
        self.push(Item::Closed, 0);
    }

    /// Everything the session wrote, emptying the record.
    pub fn take_written(&self) -> Vec<u8> {
        std::mem::take(&mut lock(&self.inner).written)
    }

    /// Caps how many written bytes the link holds before `take_written`
    /// (`None`: unlimited), to test a slow reader.
    pub fn set_write_capacity(&self, capacity: Option<usize>) {
        lock(&self.inner).write_capacity = capacity;
    }

    /// Makes every write fail with `BrokenPipe` while output can still be
    /// read, like a program that closed its input and is about to exit.
    pub fn fail_writes(&self, fail: bool) {
        lock(&self.inner).fail_writes = fail;
    }

    /// The next `n` reads fail with `Interrupted`.
    pub fn interrupt_reads(&self, n: u32) {
        lock(&self.inner).read_interrupts = n;
    }

    /// The next `n` writes fail with `Interrupted`.
    pub fn interrupt_writes(&self, n: u32) {
        lock(&self.inner).write_interrupts = n;
    }

    /// Every resize the session sent, in order.
    pub fn resizes(&self) -> Vec<(u16, u16)> {
        lock(&self.inner).resizes.clone()
    }

    /// Output bytes queued and not yet read by the session.
    pub fn unread(&self) -> usize {
        lock(&self.inner).queued
    }

    /// True once the session closed the link.
    pub fn closed_by_session(&self) -> bool {
        lock(&self.inner).closed_by_session
    }
}

/// Copies what is left of `v` after `offset` into `buf`: (bytes copied,
/// replay, whether that finished `v`).
fn copy_out(v: &[u8], offset: usize, buf: &mut [u8], replay: bool) -> (usize, bool, bool) {
    let rest = &v[offset..];
    let n = rest.len().min(buf.len());
    buf[..n].copy_from_slice(&rest[..n]);
    (n, replay, n == rest.len())
}

impl SessionLink for MemoryLink {
    fn try_read(&mut self, buf: &mut [u8]) -> io::Result<LinkRead> {
        let mut g = lock(&self.inner);
        let inner = &mut *g;
        if inner.closed_by_session {
            return Ok(LinkRead::Closed);
        }
        if inner.read_interrupts > 0 {
            inner.read_interrupts -= 1;
            return Err(io::ErrorKind::Interrupted.into());
        }
        loop {
            let (n, replay, whole) = match inner.queue.front() {
                None => return Ok(LinkRead::Empty),
                Some(Item::Closed) => return Ok(LinkRead::Closed),
                Some(Item::ReplayEnd) => (0, true, true),
                Some(Item::Live(v)) => copy_out(v, inner.offset, buf, false),
                Some(Item::Replay(v)) => copy_out(v, inner.offset, buf, true),
            };
            let end_marker = matches!(inner.queue.front(), Some(Item::ReplayEnd));
            if end_marker {
                inner.queue.pop_front();
                return Ok(LinkRead::ReplayEnd);
            }
            if whole {
                inner.queue.pop_front();
                inner.offset = 0;
            } else {
                inner.offset += n;
            }
            if n == 0 && whole {
                continue;
            }
            inner.queued -= n;
            return Ok(if replay {
                LinkRead::Replay(n)
            } else {
                LinkRead::Data(n)
            });
        }
    }

    fn try_write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let mut g = lock(&self.inner);
        if g.closed_by_session {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        if g.write_interrupts > 0 {
            g.write_interrupts -= 1;
            return Err(io::ErrorKind::Interrupted.into());
        }
        if g.fail_writes {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        let n = match g.write_capacity {
            Some(cap) => bytes.len().min(cap.saturating_sub(g.written.len())),
            None => bytes.len(),
        };
        g.written.extend_from_slice(&bytes[..n]);
        Ok(n)
    }

    fn resize(&mut self, cols: u16, rows: u16) -> io::Result<()> {
        lock(&self.inner).resizes.push((cols, rows));
        Ok(())
    }

    fn close(&mut self) {
        lock(&self.inner).closed_by_session = true;
    }

    fn set_waker(&mut self, waker: Waker) {
        lock(&self.inner).waker = Some(waker);
    }
}
