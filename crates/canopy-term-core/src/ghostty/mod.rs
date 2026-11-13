//! `Screen` on libghostty-vt, the terminal engine.
//!
//! No libghostty-vt type appears in this module's public API.
//!
//! # Threading
//!
//! Every libghostty-vt handle is `!Send` and `!Sync` (the C library may keep
//! thread-local state and has no locking), so a `Terminal` cannot be moved into
//! a session that lives on another thread, and the old `Screen` was `Send`.
//! Documenting "single thread only" would push that rule onto every consumer
//! (sessions, windows and the renderer are on different threads), so instead
//! each [`Screen`] owns one dedicated thread that creates, uses and drops the
//! engine; the `Screen` handle itself is `Send + Sync` and talks to it over a
//! bounded channel:
//!
//! * [`Screen::advance`] copies the bytes and queues them, then returns, so
//!   the PTY reader is not held up by parsing (a full queue of 64 chunks of at
//!   most 64 KiB applies back-pressure);
//! * everything that reads state (`frame`, `snapshot`, `take_replies`, ...)
//!   ships a closure to the engine thread and waits for the result. The queue
//!   is FIFO, so a read always sees every earlier `advance`, exactly as with a
//!   single-threaded `Screen`;
//! * the [`Frame`] is built lazily, on the engine thread, by the first read
//!   that needs frame-derived state (`frame`, `seq`, `damage_since`,
//!   `snapshot`, `hyperlink_at`, `row_mark`, `cursor_blinking`) after one or
//!   more `advance`s. Several advances between two reads cost one build and
//!   count as one frame (one `seq` step) with the union of their damage;
//! * dropping the `Screen` closes the queue; the thread finishes what is queued,
//!   drops the engine on the thread that made it, and is joined.
//!
//! One OS thread per session costs a stack reservation and a context switch per
//! read; the alternative that avoids both (a pinned thread owning many engines)
//! would need a registry the consumers do not have. If the engine thread
//! panics, the next call panics with a clear message instead of returning stale
//! data.
//!
//! # What is the engine's and what is ours
//!
//! libghostty-vt parses, keeps the grid, scrollback, reflow, hyperlinks (OSC 8)
//! and prompt marks (OSC 133 rows), and answers device attributes, cursor
//! position and mode queries itself (the DA reply is set to `CSI ? 6 c`, as
//! before). It has no hook for colour queries, clipboard policy or reset
//! notification, so a small scanner (`scan.rs`) walks the same stream for OSC 52, 133, BEL and `ESC c`, and the host reacts at the exact byte
//! offset, keeping replies in stream order.
//!
//! # Replies, events and policy
//!
//! * [`Screen::take_replies`]: bytes to write to the PTY (DA, CPR, DECRQM,
//!   kitty flags, colour queries). Colour queries are answered from colours the
//!   program set, else from [`Screen::set_reply_colors`]; with neither there is
//!   no reply. Palette queries (OSC 4) are answered from the current palette, whose first
//!   16 entries [`Screen::set_default_palette`] sets.
//! * [`Screen::take_events`]: bell, OSC 52 clipboard writes, prompt marks
//!   (OSC 133). The core never reads or writes a clipboard. A write is only an
//!   event, capped at [`MAX_CLIPBOARD_BYTES`] (larger or malformed ones are
//!   dropped). A read request (`OSC 52 ; c ; ?`) is denied: it produces no
//!   reply and no event, unless the host opts in with
//!   [`Screen::set_clipboard_read_events`], and even then it is only an event,
//!   because the core cannot answer with clipboard contents.
//! * [`Screen::hyperlink_at`] and [`Screen::row_mark`] expose OSC 8 links and
//!   OSC 133 row marks without changing [`Frame`].
//!
//! # Snapshot
//!
//! libghostty-vt has a VT formatter, but it serialises the whole screen with
//! its scrollback, not the visible area, and does not keep soft wraps, so
//! [`Screen::snapshot`] is written from our own frame and the engine's
//! soft-wrap flags. Where the engine has an API for state the grid does not
//! show, the snapshot uses it:
//!
//! * the palette and the foreground, background and cursor colours come from
//!   the terminal's colour getters and are written as OSC 4, 10, 11 and 12 for
//!   whatever differs from the defaults;
//! * the scroll region, the tab stops and the G0 to G3 character sets with
//!   their shift state come from the engine's own VT formatter (it is asked
//!   about one cell and its output is parsed, because the terminal has no
//!   getter for them).
//!
//! The rest is replayed as VT: underline style (`4:n`) and colour (`58`) in the
//! SGR of every cell and of the pen, hyperlinks (OSC 8), prompt row marks (OSC
//! 133 `P`, `k=i` or `k=s`, written after the row's text so a wrap into the next
//! row is not marked), and two things the engine keeps on its cursor and does
//! not expose, so the host follows them in the stream: the cursor's prompt state
//! (`A`, `B`, `I` or output; `Semantic` in `engine.rs`), which decides how the
//! next line feed marks rows, and the OSC 8 link the program left open, which
//! the next text is given. A prompt state is written from a row already marked
//! the same way (marking is a side effect of writing it), so with no such row it
//! is not carried.
//!
//! The snapshot also carries a pending autowrap and every mode written
//! explicitly. It does not carry scrollback, the primary screen behind an
//! active alternate screen, saved cursor slots, the cell-level semantic content
//! (prompt, input or output text; only the row marks are read back), or a
//! pending single shift (`ESC N`, `ESC O`).
//!
//! # Scrollback
//!
//! The engine's cap is in bytes. [`Screen::with_scrollback`] converts lines to
//! a byte budget and `scrollback_len` enforces the line count itself.

mod engine;
mod scan;

use crate::frame::{Damage, Frame};
use crate::shared::clamp_size;
use engine::Engine;
#[cfg(not(target_arch = "wasm32"))]
use std::sync::mpsc::{self, SyncSender};
#[cfg(not(target_arch = "wasm32"))]
use std::sync::Mutex;
#[cfg(not(target_arch = "wasm32"))]
use std::thread::{self, JoinHandle};

pub use crate::shared::{
    Row, DEFAULT_SCROLLBACK, MAX_CLUSTER_SCALARS, MAX_COLS, MAX_OSC_BYTES, MAX_PENDING_REPLIES,
    MAX_ROWS, MAX_SCROLLBACK, MAX_TITLE_BYTES,
};

/// Most OSC 52 payload accepted, in decoded bytes.
pub const MAX_CLIPBOARD_BYTES: usize = 32 * 1024;
/// Most events held for the owner; the oldest are dropped past this.
pub const MAX_PENDING_EVENTS: usize = 1024;

/// What a prompt mark (OSC 133) says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptKind {
    /// `A`: the prompt starts.
    PromptStart,
    /// `B`: the prompt ends, user input starts.
    PromptEnd,
    /// `C`: the command's output starts.
    OutputStart,
    /// `D`: the command finished (see `exit_code`).
    CommandEnd,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PromptMark {
    pub kind: PromptKind,
    /// Exit status of a `CommandEnd`, when the shell sent one.
    pub exit_code: Option<i32>,
    /// The cursor's row on screen when the mark arrived.
    pub row: u16,
}

/// Whether a screen row is a prompt row (OSC 133), as the engine records it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RowMark {
    #[default]
    None,
    Prompt,
    PromptContinuation,
}

/// Something the program did that the host may want to act on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// BEL outside any sequence.
    Bell,
    /// OSC 52 write. `selection` is the target letters the program named
    /// (`c`, `p`, `s`, `0`..`7`; `s0` when it named none); `data` is decoded.
    /// Empty `data` asks to clear the clipboard. Never applied by the core.
    ClipboardWrite {
        selection: String,
        data: Vec<u8>,
    },
    /// OSC 52 read request. Only produced after
    /// [`Screen::set_clipboard_read_events`]; the core never answers it.
    ClipboardReadRequest {
        selection: String,
    },
    PromptMark(PromptMark),
}

type Cmd = Box<dyn FnOnce(&mut Engine) + Send>;

/// Chunks queued ahead of the engine thread before `advance` waits.
#[cfg(not(target_arch = "wasm32"))]
const QUEUE: usize = 64;
/// One queued chunk; a larger `advance` is split (any split is equivalent).
#[cfg(not(target_arch = "wasm32"))]
const CHUNK: usize = 64 * 1024;

#[cfg(not(target_arch = "wasm32"))]
pub struct Screen {
    tx: Option<SyncSender<Cmd>>,
    /// Bytes from `advance` not yet queued. They go to the engine thread as one
    /// message when they reach [`CHUNK`], or before any other call (read,
    /// resize, drop), so the engine thread sees the stream in order and every
    /// read sees every earlier `advance`. Behind a mutex only because reads
    /// take `&self` and must flush it.
    staged: Mutex<Vec<u8>>,
    thread: Option<JoinHandle<()>>,
    cols: u16,
    rows: u16,
}

/// On wasm32 there are no threads: the engine lives in the handle and every
/// call runs on the caller's thread (the page's, or a worker's). Same public
/// API and the same results; only the native build moves the engine off the
/// caller's thread.
#[cfg(target_arch = "wasm32")]
pub struct Screen {
    engine: std::cell::RefCell<Engine>,
    cols: u16,
    rows: u16,
}

#[cfg(not(target_arch = "wasm32"))]
fn dead() -> ! {
    panic!("the terminal engine thread has stopped (it panicked); this Screen is unusable")
}

impl Screen {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self::with_scrollback(cols, rows, DEFAULT_SCROLLBACK)
    }

    pub fn cols(&self) -> u16 {
        self.cols
    }

    pub fn rows(&self) -> u16 {
        self.rows
    }

    /// Feed bytes from the PTY. Any split of the same stream gives the same
    /// screen. Returns once the bytes are copied into a staging buffer of at
    /// most 64 KiB; that buffer is queued when full or before any other call,
    /// and the next read waits for everything.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn advance(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let mut rest = bytes;
        while !rest.is_empty() {
            let full = {
                let mut st = self.staged.lock().unwrap_or_else(|e| e.into_inner());
                if st.capacity() == 0 {
                    st.reserve_exact(CHUNK);
                }
                let n = rest.len().min(CHUNK - st.len());
                st.extend_from_slice(&rest[..n]);
                rest = &rest[n..];
                if st.len() == CHUNK {
                    Some(std::mem::take(&mut *st))
                } else {
                    None
                }
            };
            if let Some(data) = full {
                self.send_raw(Box::new(move |e| e.feed(&data)));
            }
        }
    }

    /// Feed bytes from the PTY. Any split of the same stream gives the same
    /// screen.
    #[cfg(target_arch = "wasm32")]
    pub fn advance(&mut self, bytes: &[u8]) {
        if !bytes.is_empty() {
            self.engine.get_mut().feed(bytes);
        }
    }

    /// Bytes the program asked to have written back to it (answers to its
    /// queries), in order. Drains the queue (at most
    /// [`crate::shared::MAX_PENDING_REPLIES`] are held; drain after every
    /// `advance`).
    pub fn take_replies(&mut self) -> Vec<u8> {
        self.call(|e| e.take_replies())
    }

    /// Bell, clipboard writes and prompt marks since the last call, in order.
    pub fn take_events(&mut self) -> Vec<Event> {
        self.call(|e| e.take_events())
    }

    /// Default foreground, background and cursor colours used to answer
    /// colour queries the program has not overridden. The renderer knows the
    /// theme; until it says, those queries get no reply.
    pub fn set_reply_colors(
        &mut self,
        fg: Option<(u8, u8, u8)>,
        bg: Option<(u8, u8, u8)>,
        cursor: Option<(u8, u8, u8)>,
    ) {
        self.send(Box::new(move |e| e.set_reply_colors(fg, bg, cursor)));
    }

    /// The 16 ANSI colours (indices 0 to 15) a program's OSC 4 queries are
    /// answered with, unless it changed them itself. The renderer's palette
    /// goes here so a program sees the colours it is drawn in.
    pub fn set_default_palette(&mut self, colors: [(u8, u8, u8); 16]) {
        self.send(Box::new(move |e| e.set_default_palette(colors)));
    }

    /// Surface OSC 52 read requests as [`Event::ClipboardReadRequest`] (off by
    /// default: they are then dropped without a trace). The core never answers.
    pub fn set_clipboard_read_events(&mut self, on: bool) {
        self.send(Box::new(move |e| e.set_clipboard_read_events(on)));
    }

    /// Resize the grid. The engine reflows wrapped lines on the primary screen.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        let (cols, rows) = clamp_size(cols, rows);
        self.cols = cols;
        self.rows = rows;
        self.send(Box::new(move |e| e.resize(cols, rows)));
    }

    /// The current screen. Damage is full (no baseline); use
    /// [`Screen::damage_since`] with a remembered `seq` for incremental updates.
    pub fn frame(&self) -> Frame {
        self.call(|e| e.frame())
    }

    /// Frame sequence number of the current screen.
    pub fn seq(&self) -> u64 {
        self.call(|e| e.seq())
    }

    /// Whether the cursor blinks (not part of the frame contract).
    pub fn cursor_blinking(&self) -> bool {
        self.call(|e| e.cursor_blinking())
    }

    /// Rows changed since the consumer's frame `since`. Full when `since` is 0,
    /// from the future, or older than the last resize / alternate-screen
    /// switch.
    pub fn damage_since(&self, since: u64) -> Damage {
        self.call(move |e| e.damage_since(since))
    }

    /// Lines of scrollback currently held. 0 on the alternate screen.
    pub fn scrollback_len(&self) -> usize {
        self.call(|e| e.scrollback_len())
    }

    /// A scrollback line; index 0 is the oldest. Not part of the snapshot.
    pub fn scrollback_row(&self, index: usize) -> Option<Row> {
        self.call(move |e| e.scrollback_row(index))
    }

    /// Up to `count` scrollback lines from index `start` (0 is the oldest), in
    /// one engine round trip. Fewer when the history ends first.
    pub fn scrollback_rows(&self, start: usize, count: usize) -> Vec<Row> {
        self.call(move |e| {
            (start..start.saturating_add(count))
                .map_while(|i| e.scrollback_row(i))
                .collect()
        })
    }

    /// The target of the OSC 8 hyperlink on a visible cell, if any.
    pub fn hyperlink_at(&self, row: u16, col: u16) -> Option<String> {
        self.call(move |e| e.hyperlink_at(row, col))
    }

    /// Whether a visible row is a prompt row (OSC 133).
    pub fn row_mark(&self, row: u16) -> RowMark {
        self.call(move |e| e.row_mark(row))
    }

    /// Escape sequences that bring a fresh `Screen` of the same size to this
    /// screen's visible grid, cursor, pen, title and modes. See the module
    /// docs. Scrollback is not carried.
    pub fn snapshot(&self) -> Vec<u8> {
        self.call(|e| e.snapshot())
    }

    /// A fresh screen brought to the state a snapshot describes.
    pub fn restore(cols: u16, rows: u16, snapshot: &[u8]) -> Screen {
        let mut s = Screen::new(cols, rows);
        s.advance(snapshot);
        s.call(|e| e.discard_pending());
        s
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Screen {
    pub fn with_scrollback(cols: u16, rows: u16, scrollback: usize) -> Self {
        let (cols, rows) = clamp_size(cols, rows);
        let (tx, rx) = mpsc::sync_channel::<Cmd>(QUEUE);
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let thread = thread::Builder::new()
            .name("canopy-term-engine".into())
            // Virtual reservation only; the parser is not deeply recursive but
            // this is cheap insurance against a stack overflow in native code.
            .stack_size(8 << 20)
            .spawn(move || {
                let mut engine = match Engine::new(cols, rows, scrollback) {
                    Ok(e) => {
                        let _ = ready_tx.send(Ok(()));
                        e
                    }
                    Err(m) => {
                        let _ = ready_tx.send(Err(m));
                        return;
                    }
                };
                while let Ok(cmd) = rx.recv() {
                    cmd(&mut engine);
                }
                // `engine` drops here, on the thread that created it.
            })
            .expect("spawn the terminal engine thread");
        match ready_rx.recv() {
            Ok(Ok(())) => {}
            Ok(Err(m)) => panic!("libghostty-vt could not start: {m}"),
            Err(_) => dead(),
        }
        Screen {
            tx: Some(tx),
            staged: Mutex::new(Vec::new()),
            thread: Some(thread),
            cols,
            rows,
        }
    }

    /// Queue staged bytes (if any) for the engine thread.
    fn flush(&self) {
        let data = {
            let mut st = self.staged.lock().unwrap_or_else(|e| e.into_inner());
            if st.is_empty() {
                return;
            }
            std::mem::take(&mut *st)
        };
        self.send_raw(Box::new(move |e| e.feed(&data)));
    }

    /// Queue a command behind everything `advance`d so far.
    fn send(&self, cmd: Cmd) {
        self.flush();
        self.send_raw(cmd);
    }

    fn send_raw(&self, cmd: Cmd) {
        match &self.tx {
            Some(tx) => {
                if tx.send(cmd).is_err() {
                    dead()
                }
            }
            None => dead(),
        }
    }

    /// Run `f` on the engine thread and wait for its result.
    fn call<R: Send + 'static>(&self, f: impl FnOnce(&mut Engine) -> R + Send + 'static) -> R {
        let (rtx, rrx) = mpsc::sync_channel(1);
        self.send(Box::new(move |e| {
            let _ = rtx.send(f(e));
        }));
        rrx.recv().unwrap_or_else(|_| dead())
    }
}

#[cfg(target_arch = "wasm32")]
impl Screen {
    pub fn with_scrollback(cols: u16, rows: u16, scrollback: usize) -> Self {
        let (cols, rows) = clamp_size(cols, rows);
        let engine = Engine::new(cols, rows, scrollback)
            .unwrap_or_else(|m| panic!("libghostty-vt could not start: {m}"));
        Screen {
            engine: std::cell::RefCell::new(engine),
            cols,
            rows,
        }
    }

    fn send(&self, cmd: Cmd) {
        cmd(&mut self.engine.borrow_mut());
    }

    fn call<R>(&self, f: impl FnOnce(&mut Engine) -> R) -> R {
        f(&mut self.engine.borrow_mut())
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Drop for Screen {
    fn drop(&mut self) {
        // Closing the queue ends the thread's loop after the queued work.
        self.flush();
        drop(self.tx.take());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl std::fmt::Debug for Screen {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Screen")
            .field("engine", &"libghostty-vt")
            .field("cols", &self.cols)
            .field("rows", &self.rows)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn the_handle_is_send_and_sync_though_the_engine_is_not() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Screen>();
    }
}
