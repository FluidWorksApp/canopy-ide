//! [`Session`]: a [`Screen`] fed from a [`SessionLink`], publishing
//! [`Frame`]s and turning input events into bytes for the link.

use std::collections::VecDeque;
use std::io;
use std::time::{Duration, Instant};

use canopy_term_core::frame::{Damage, Frame, Modes};
use canopy_term_core::screen::DEFAULT_SCROLLBACK;
use canopy_term_core::Screen;
use canopy_term_input::{
    encode_focus, encode_key, encode_mouse, encode_paste, encode_text, KeyEvent, MouseEvent,
};

use crate::link::{LinkRead, SessionLink};
use crate::source::{FrameSource, Waker};

/// Output bytes read and parsed per tick by default. The same figure as
/// alacritty's read buffer: one tick of a `cat` of a large file costs one
/// screen update, and memory stays at about twice this (this buffer plus the
/// emulator's filtered copy of it).
pub const DEFAULT_TICK_BUDGET: usize = 1 << 20;

/// Smallest per-tick budget accepted; smaller values are raised to this.
pub const MIN_TICK_BUDGET: usize = 4096;

/// Largest per-tick budget accepted (the read buffer is allocated at this
/// size); larger values are lowered to this.
pub const MAX_TICK_BUDGET: usize = 64 << 20;

/// How long after input the link refused before the session wants another
/// tick to offer it again ([`Tick::write_pending`], [`Session::deadline`]).
pub const DEFAULT_WRITE_RETRY: Duration = Duration::from_millis(10);

/// How long synchronized output (mode 2026) may hold a frame back, the same
/// bound alacritty uses. A program that sets 2026 and never clears it gets its
/// frames published after this.
pub const DEFAULT_SYNC_TIMEOUT: Duration = Duration::from_millis(150);

/// Bytes for the program held while the link is not accepting them. Input
/// that would take the queue past this is refused whole (the input methods
/// return false), so one input larger than this is never accepted; a caller
/// with more splits it. Terminal replies queued behind a full queue have
/// their own bound of the same size.
pub const DEFAULT_MAX_PENDING_WRITE: usize = 1 << 20;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionConfig {
    pub cols: u16,
    pub rows: u16,
    /// Scrollback lines kept by the screen.
    pub scrollback: usize,
    /// Most output bytes read and parsed in one tick.
    pub tick_budget: usize,
    pub sync_timeout: Duration,
    pub max_pending_write: usize,
    /// How soon to offer refused input to the link again.
    pub write_retry: Duration,
    /// Start in replay: publish nothing until the link sends
    /// [`LinkRead::ReplayEnd`] or live data. Set this when attaching to a
    /// host that sends history first, so the blank screen is never shown and
    /// no early read can be taken for live.
    pub starts_with_replay: bool,
}

impl Default for SessionConfig {
    fn default() -> Self {
        SessionConfig {
            cols: 80,
            rows: 24,
            scrollback: DEFAULT_SCROLLBACK,
            tick_budget: DEFAULT_TICK_BUDGET,
            sync_timeout: DEFAULT_SYNC_TIMEOUT,
            max_pending_write: DEFAULT_MAX_PENDING_WRITE,
            write_retry: DEFAULT_WRITE_RETRY,
            starts_with_replay: false,
        }
    }
}

/// What one [`Session::tick`] did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Tick {
    /// A new frame was published.
    pub published: bool,
    /// The budget ran out with output possibly still waiting: tick again soon
    /// (a link's waker may be edge-triggered and will not fire again for
    /// bytes it already announced).
    pub more: bool,
    /// Input is still waiting for the link to take it: tick again at
    /// `deadline` (a link has no wake for "writable").
    pub write_pending: bool,
    /// Tick again at this time even without a wake (end of a sync hold, or
    /// the next attempt to write waiting input).
    pub deadline: Option<Instant>,
}

/// Counters for tests and diagnostics.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    /// Live output bytes parsed.
    pub live_bytes: u64,
    /// History bytes parsed (replay).
    pub replay_bytes: u64,
    /// Calls into the emulator (`Screen::advance`). Each rebuilds the frame,
    /// so at most one per tick in steady state.
    pub advances: u64,
    /// Frames published.
    pub frames: u64,
    /// Reply bytes queued for the program.
    pub reply_bytes: u64,
    /// Reply bytes dropped because they were produced during replay.
    pub dropped_reply_bytes: u64,
    /// Reply bytes dropped because the reply queue behind a stalled link was
    /// full, or the link could no longer be written to.
    pub overflowed_reply_bytes: u64,
    /// Writes refused because too much was already waiting.
    pub refused_writes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Segment {
    Live,
    Replay,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SyncState {
    /// Synchronized output is off (or not yet seen).
    Off,
    /// The program set 2026: hold frames until it clears it or this time.
    Holding(Instant),
    /// The hold timed out while 2026 is still set: publish freely until it is
    /// seen cleared, then a new hold can start.
    Released,
}

/// A terminal session without a window: bytes from a [`SessionLink`] go
/// through a [`Screen`] into [`Frame`]s; key, text, paste, mouse and focus
/// events are encoded with the program's current modes and written to the
/// link.
///
/// Driven from one thread by calling [`Session::tick`] (or
/// [`FrameSource::frame_since`], which ticks) whenever the link's waker fires
/// or a deadline passes, typically from the window's event loop:
///
/// * **Batching.** A tick drains what the link has, up to
///   [`SessionConfig::tick_budget`] bytes, into one reused buffer, advances
///   the screen once, and publishes at most one frame. Nothing is allocated
///   per byte or per read.
/// * **Backpressure.** Once a frame is published, the session reads nothing
///   more until a viewer has taken it (during a sync hold or a replay it keeps
///   reading, since those end only on more output). Unread output stays in
///   the link, whose bounded queue stops the program. This is one session-wide
///   count: a frame counts as taken when any viewer takes it, so with several
///   viewers the fastest sets the pace and a slower one skips frames (its
///   damage is computed against its own `since`, so it still draws correctly).
/// * **Synchronized output (2026).** While the program has it set, frames are
///   held (the screen still advances) for at most
///   [`SessionConfig::sync_timeout`]. Resize and close publish through a hold.
///   The session sees the mode at the end of each batch, so a `2026l` followed
///   by a `2026h` inside one batch is seen: the frame as of the `2026l` is
///   published and a fresh hold starts, so a program drawing steady
///   `2026h`..`2026l` frames is never shown half drawn.
/// * **Replay.** History bytes ([`LinkRead::Replay`] or [`Session::replay`])
///   are parsed with every terminal reply they produce dropped, and nothing is
///   published until the replay ends. Input sent during a replay is encoded
///   with the modes replayed so far and written at once. A resize during a
///   replay applies to the screen at once, so history still to come is parsed
///   at the new size: size the session (`SessionConfig::cols`/`rows`) before
///   attaching instead.
/// * **Closing.** A failed write stops writing but not reading: output the
///   program produced just before it exited (`cmd; exit`) is still read. The
///   session ends when the link reports [`LinkRead::Closed`] (or a read
///   fails, or [`Session::close`] is called); [`FrameSource::closed`] turns
///   true once the final frame has been taken.
pub struct Session<L: SessionLink> {
    screen: Screen,
    link: L,
    config: SessionConfig,
    /// Read buffer, grown once to the tick budget and reused.
    buf: Vec<u8>,
    /// Bytes for the program the link has not accepted yet.
    pending: VecDeque<u8>,
    /// Terminal replies waiting for room in `pending`, bounded by
    /// `max_pending_write`. Moved over whole, so a reply is never split by
    /// input queued in between.
    replies: Vec<u8>,
    /// The link refused a write or resize with a hard error: nothing more is
    /// written, but output is still read until the link says `Closed`.
    write_dead: bool,
    /// When to offer waiting input to the link again.
    retry_at: Option<Instant>,
    /// Finds `2026l` in live output.
    sync_scan: SyncScan,
    /// A `2026l` was in the live bytes of this batch.
    esu_seen: bool,
    /// The frame as of the last `2026l` inside this batch, when more output
    /// followed it in the same batch.
    boundary: Option<Frame>,
    /// Encoder output, reused.
    scratch: Vec<u8>,
    published: Option<Frame>,
    /// Highest published sequence a viewer has taken.
    taken: u64,
    /// Screen sequence `modes` was read at.
    modes_seq: u64,
    modes: Modes,
    sync: SyncState,
    /// Publish through a sync hold (resize, close).
    force: bool,
    replaying: bool,
    closed: bool,
    waker: Option<Waker>,
    stats: Stats,
}

fn interrupted(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::Interrupted
}

fn would_block(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::WouldBlock
}

/// Retries of an `Interrupted` call within one read batch or flush before
/// giving up until the next tick.
const MAX_INTERRUPTS: u32 = 8;

/// Encoder output buffers larger than this are dropped after use, so one huge
/// paste does not pin its memory for the life of the session.
const SCRATCH_KEEP: usize = 64 << 10;

/// Finds `ESC [ ? 2 0 2 6 l` (end of synchronized output) across reads.
#[derive(Default)]
struct SyncScan {
    /// Bytes of `ESC [ ? 2 0 2 6` matched so far (0..=7).
    matched: usize,
}

impl SyncScan {
    const PREFIX: &'static [u8; 7] = b"\x1b[?2026";

    fn reset(&mut self) {
        self.matched = 0;
    }

    /// Offset just past the last `2026l` that ends inside `data`.
    fn scan(&mut self, data: &[u8]) -> Option<usize> {
        let mut end = None;
        let mut i = 0;
        while i < data.len() {
            if self.matched == 0 {
                match data[i..].iter().position(|&b| b == 0x1b) {
                    Some(at) => i += at,
                    None => break,
                }
            }
            let b = data[i];
            if self.matched < Self::PREFIX.len() {
                self.matched = if b == Self::PREFIX[self.matched] {
                    self.matched + 1
                } else if b == 0x1b {
                    1
                } else {
                    0
                };
            } else {
                if b == b'l' {
                    end = Some(i + 1);
                }
                self.matched = usize::from(b == 0x1b);
            }
            i += 1;
        }
        end
    }
}

impl<L: SessionLink> Session<L> {
    pub fn new(link: L, config: SessionConfig) -> Self {
        let mut config = config;
        config.tick_budget = config.tick_budget.clamp(MIN_TICK_BUDGET, MAX_TICK_BUDGET);
        let screen = Screen::with_scrollback(config.cols, config.rows, config.scrollback);
        let replaying = config.starts_with_replay;
        Session {
            screen,
            link,
            config,
            buf: Vec::new(),
            pending: VecDeque::new(),
            replies: Vec::new(),
            write_dead: false,
            retry_at: None,
            sync_scan: SyncScan::default(),
            esu_seen: false,
            boundary: None,
            scratch: Vec::new(),
            published: None,
            taken: 0,
            modes_seq: 0,
            modes: Modes::default(),
            sync: SyncState::Off,
            force: false,
            replaying,
            closed: false,
            waker: None,
            stats: Stats::default(),
        }
    }

    /// The screen, for what frames do not carry (scrollback, snapshot).
    pub fn screen(&self) -> &Screen {
        &self.screen
    }

    pub fn link(&self) -> &L {
        &self.link
    }

    pub fn link_mut(&mut self) -> &mut L {
        &mut self.link
    }

    pub fn config(&self) -> &SessionConfig {
        &self.config
    }

    pub fn stats(&self) -> Stats {
        self.stats
    }

    /// True while history is being replayed.
    pub fn replaying(&self) -> bool {
        self.replaying
    }

    /// Colours used to answer OSC 10/11/12 queries the program has not
    /// overridden (the renderer's theme). Without them those get no reply.
    pub fn set_reply_colors(
        &mut self,
        fg: Option<(u8, u8, u8)>,
        bg: Option<(u8, u8, u8)>,
        cursor: Option<(u8, u8, u8)>,
    ) {
        self.screen.set_reply_colors(fg, bg, cursor);
    }

    /// Parses history before going live: every reply it produces is dropped
    /// and nothing is published for it on its own. Call before the first tick,
    /// with bytes that came from the same program (the host's ring, or a
    /// `Screen::snapshot` of the same size). Fed in tick-budget slices, so the
    /// emulator's buffers stay bounded however long the history is.
    pub fn replay(&mut self, history: &[u8]) {
        for chunk in history.chunks(self.config.tick_budget) {
            self.screen.advance(chunk);
            self.stats.advances += 1;
            self.stats.replay_bytes += chunk.len() as u64;
            self.stats.dropped_reply_bytes += self.screen.take_replies().len() as u64;
        }
        let _ = self.refresh_modes();
    }

    /// One step: flush waiting input, read and parse up to the tick budget,
    /// write any replies, and publish a frame if the screen changed and
    /// nothing holds it back.
    ///
    /// While a published frame has not been taken (see
    /// [`Session::take_frame`]) nothing is read and `more` is false: tick again
    /// after taking a frame. [`FrameSource::frame_since`] does both.
    pub fn tick(&mut self, now: Instant) -> Tick {
        self.flush();
        let mut more = false;
        if self.may_read() {
            more = self.read_batch();
        }
        let candidate = self.refresh_modes();
        // A frame ended inside the batch: whatever hold or timeout covered
        // the one before is over, and if the mode is set again a new frame
        // began, which gets a fresh hold.
        let esu = std::mem::take(&mut self.esu_seen);
        let boundary = self.boundary.take();
        if esu {
            self.sync = SyncState::Off;
        }
        self.update_sync(now);
        let mut published = false;
        let holding = matches!(self.sync, SyncState::Holding(_));
        if !self.replaying && holding && !self.force {
            // Show the frame as of the last `2026l` rather than nothing: the
            // screen is already partway into the next one.
            if let Some(b) = boundary {
                if self.published.as_ref().is_none_or(|p| p.seq < b.seq) {
                    self.published = Some(b);
                    self.stats.frames += 1;
                    published = true;
                }
            }
        } else if !self.replaying {
            let seq = self.screen.seq();
            let stale = self.published.as_ref().is_none_or(|p| p.seq != seq);
            if stale {
                let frame = match candidate {
                    Some(f) if f.seq == seq => f,
                    _ => self.screen.frame(),
                };
                self.published = Some(frame);
                self.stats.frames += 1;
                published = true;
            }
            self.force = false;
        }
        self.flush();
        self.retry_at = self
            .write_waiting()
            .then(|| now.checked_add(self.config.write_retry).unwrap_or(now));
        Tick {
            published,
            more,
            write_pending: self.write_waiting(),
            deadline: self.deadline_at(),
        }
    }

    /// [`Session::tick`] at `now`, then the newest frame relative to `since`
    /// (see [`FrameSource::frame_since`], which is this at `Instant::now()`).
    pub fn frame_since_at(&mut self, since: u64, now: Instant) -> Option<Frame> {
        self.tick(now);
        self.take_frame(since)
    }

    /// The newest published frame relative to `since`, without ticking.
    /// `None` before the first frame and when `since` is already the newest.
    ///
    /// Damage is from the screen's row record, so during a hold it can name
    /// rows that changed after the published frame. That is a superset, which
    /// only costs a redraw of unchanged rows.
    pub fn take_frame(&mut self, since: u64) -> Option<Frame> {
        let p = self.published.as_ref()?;
        let seq = p.seq;
        if since == seq {
            // The viewer already has it, so it counts as taken.
            self.taken = self.taken.max(seq);
            return None;
        }
        let mut frame = p.clone();
        frame.damage = self.damage_for(since, seq);
        self.taken = self.taken.max(seq);
        Some(frame)
    }

    /// Like [`Session::take_frame`], but copies into a viewer-owned frame,
    /// reusing its buffers: no allocation once `out` has grown to the grid.
    /// Returns false (leaving `out` alone) when there is nothing newer.
    pub fn take_frame_into(&mut self, since: u64, out: &mut Frame) -> bool {
        let Some(p) = self.published.as_ref() else {
            return false;
        };
        if since == p.seq {
            self.taken = self.taken.max(since);
            return false;
        }
        // Exhaustive, so a field added to `Frame` fails to compile here
        // instead of being silently left stale.
        let Frame {
            seq,
            cols,
            rows,
            cells,
            clusters,
            cursor,
            modes,
            damage: _,
            alt_screen,
            title,
        } = p;
        out.seq = *seq;
        out.cols = *cols;
        out.rows = *rows;
        out.cells.clone_from(cells);
        out.clusters.clone_from(clusters);
        out.cursor = *cursor;
        out.modes = *modes;
        out.alt_screen = *alt_screen;
        out.title.clone_from(title);
        let seq = *seq;
        out.damage = self.damage_for(since, seq);
        self.taken = self.taken.max(seq);
        true
    }

    /// Queues bytes for the program and offers them to the link. False if
    /// refused: the session is closed, or more than
    /// [`SessionConfig::max_pending_write`] is already waiting.
    pub fn send(&mut self, bytes: &[u8]) -> bool {
        if self.closed || self.write_dead {
            return false;
        }
        if bytes.is_empty() {
            return true;
        }
        if self.pending.len() + bytes.len() > self.config.max_pending_write {
            self.stats.refused_writes += 1;
            return false;
        }
        self.pending.extend(bytes);
        self.flush();
        if self.write_waiting() && self.retry_at.is_none() {
            let now = Instant::now();
            self.retry_at = Some(now.checked_add(self.config.write_retry).unwrap_or(now));
        }
        true
    }

    /// Bytes for the program the link has not accepted yet (input and queued
    /// replies).
    pub fn pending_write(&self) -> usize {
        self.pending.len() + self.replies.len()
    }

    fn write_waiting(&self) -> bool {
        !self.write_dead && !(self.pending.is_empty() && self.replies.is_empty())
    }

    /// Stops writing (the link failed a write or resize) but keeps reading,
    /// so the program's last output is not lost.
    fn kill_writes(&mut self) {
        self.write_dead = true;
        self.pending.clear();
        self.replies.clear();
        self.retry_at = None;
    }

    /// Closes the link. The last frame stays available.
    pub fn close(&mut self) {
        self.mark_closed();
    }

    /// The session is over: reading stops, the link is closed (once), and
    /// the final frame is published through any hold or replay.
    fn mark_closed(&mut self) {
        if !self.closed {
            self.closed = true;
            self.link.close();
        }
        self.force = true;
        // A link that breaks mid-replay still shows what was replayed.
        self.replaying = false;
        self.sync = SyncState::Off;
        self.kill_writes();
    }

    /// Closed and the final frame is out and taken.
    fn finished(&self) -> bool {
        self.closed
            && self
                .published
                .as_ref()
                .is_some_and(|p| p.seq == self.screen.seq() && self.taken >= p.seq)
    }

    fn may_read(&self) -> bool {
        if self.closed {
            return false;
        }
        if self.replaying || matches!(self.sync, SyncState::Holding(_)) {
            return true;
        }
        self.published.as_ref().is_none_or(|p| self.taken >= p.seq)
    }

    /// Reads up to the tick budget and parses it, one `advance` per run of
    /// live or replay bytes (a batch never spans the end of a replay).
    /// Returns true if the budget ran out.
    fn read_batch(&mut self) -> bool {
        let budget = self.config.tick_budget;
        if self.buf.len() < budget {
            self.buf.resize(budget, 0);
        }
        let mut filled = 0usize;
        let mut kind = Segment::Live;
        let mut interrupts = 0;
        let mut gave_up = false;
        loop {
            if filled >= budget {
                break;
            }
            let read = self.link.try_read(&mut self.buf[filled..budget]);
            match read {
                Ok(LinkRead::Data(n)) | Ok(LinkRead::Replay(n)) if n == 0 => break,
                Ok(LinkRead::Data(n)) => {
                    let n = n.min(budget - filled);
                    if kind == Segment::Replay && filled > 0 {
                        self.feed(Segment::Replay, filled);
                        self.buf.copy_within(filled..filled + n, 0);
                        filled = 0;
                    }
                    if self.replaying {
                        self.replaying = false;
                    }
                    kind = Segment::Live;
                    filled += n;
                }
                Ok(LinkRead::Replay(n)) => {
                    let n = n.min(budget - filled);
                    if kind == Segment::Live && filled > 0 {
                        self.feed(Segment::Live, filled);
                        self.buf.copy_within(filled..filled + n, 0);
                        filled = 0;
                    }
                    self.replaying = true;
                    kind = Segment::Replay;
                    filled += n;
                }
                Ok(LinkRead::ReplayEnd) => {
                    if kind == Segment::Replay {
                        self.feed(Segment::Replay, filled);
                        filled = 0;
                    }
                    self.replaying = false;
                    kind = Segment::Live;
                }
                Ok(LinkRead::Empty) => break,
                Err(e) if interrupted(&e) => {
                    interrupts += 1;
                    if interrupts > MAX_INTERRUPTS {
                        gave_up = true;
                        break;
                    }
                }
                Err(e) if would_block(&e) => break,
                Ok(LinkRead::Closed) | Err(_) => {
                    self.feed(kind, filled);
                    self.mark_closed();
                    return false;
                }
            }
        }
        self.feed(kind, filled);
        filled >= budget || gave_up
    }

    /// Advances the screen over `buf[..len]` and routes its replies: written
    /// for live bytes, dropped for replay. Live bytes are split after the last
    /// `2026l` when more follows it, to keep the frame as of that point.
    fn feed(&mut self, kind: Segment, len: usize) {
        if len == 0 {
            return;
        }
        match kind {
            Segment::Replay => {
                self.sync_scan.reset();
                self.run(kind, 0, len);
            }
            Segment::Live => match self.sync_scan.scan(&self.buf[..len]) {
                Some(end) if end < len => {
                    self.esu_seen = true;
                    self.run(kind, 0, end);
                    self.boundary = Some(self.screen.frame());
                    self.run(kind, end, len);
                }
                Some(_) => {
                    self.esu_seen = true;
                    self.boundary = None;
                    self.run(kind, 0, len);
                }
                None => self.run(kind, 0, len),
            },
        }
    }

    fn run(&mut self, kind: Segment, from: usize, to: usize) {
        self.screen.advance(&self.buf[from..to]);
        self.stats.advances += 1;
        let replies = self.screen.take_replies();
        let n = (to - from) as u64;
        match kind {
            Segment::Replay => {
                self.stats.replay_bytes += n;
                self.stats.dropped_reply_bytes += replies.len() as u64;
            }
            Segment::Live => {
                self.stats.live_bytes += n;
                self.queue_replies(&replies);
            }
        }
    }

    /// Queues a terminal reply: straight to `pending` when it fits, behind it
    /// in `replies` (own bound) when input is filling `pending`, dropped only
    /// past that or when nothing can be written any more.
    fn queue_replies(&mut self, replies: &[u8]) {
        if replies.is_empty() {
            return;
        }
        let cap = self.config.max_pending_write;
        if self.closed || self.write_dead {
            self.stats.overflowed_reply_bytes += replies.len() as u64;
        } else if self.replies.is_empty() && self.pending.len() + replies.len() <= cap {
            self.stats.reply_bytes += replies.len() as u64;
            self.pending.extend(replies);
        } else if self.replies.len() + replies.len() <= cap {
            self.stats.reply_bytes += replies.len() as u64;
            self.replies.extend_from_slice(replies);
        } else {
            self.stats.overflowed_reply_bytes += replies.len() as u64;
        }
    }

    /// Re-reads the program's modes when the screen changed, returning the
    /// frame it cloned to do so (the screen has no cheaper accessor yet), so
    /// a publish in the same tick reuses it.
    fn refresh_modes(&mut self) -> Option<Frame> {
        let seq = self.screen.seq();
        if seq == self.modes_seq {
            return None;
        }
        let frame = self.screen.frame();
        self.modes = frame.modes;
        self.modes_seq = seq;
        Some(frame)
    }

    fn update_sync(&mut self, now: Instant) {
        if self.closed || self.replaying || !self.modes.sync_output {
            self.sync = SyncState::Off;
            return;
        }
        if self.sync == SyncState::Off {
            let until = now.checked_add(self.config.sync_timeout).unwrap_or(now);
            self.sync = SyncState::Holding(until);
        }
        if let SyncState::Holding(until) = self.sync {
            if now >= until {
                self.sync = SyncState::Released;
            }
        }
    }

    fn deadline_at(&self) -> Option<Instant> {
        let hold = match self.sync {
            SyncState::Holding(until) => Some(until),
            _ => None,
        };
        match (hold, self.retry_at) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    fn damage_for(&self, since: u64, seq: u64) -> Damage {
        if since == 0 || since > seq {
            return Damage {
                since,
                full: true,
                rows: Vec::new(),
            };
        }
        let mut damage = self.screen.damage_since(since);
        damage.since = since;
        damage
    }

    /// Offers waiting bytes to the link until it stops accepting them. A hard
    /// error stops writing (see `kill_writes`) but not reading.
    fn flush(&mut self) {
        if self.write_dead {
            return;
        }
        let mut interrupts = 0;
        loop {
            if self.pending.is_empty() {
                if self.replies.is_empty() {
                    break;
                }
                self.pending.extend(self.replies.drain(..));
            }
            let front = self.pending.as_slices().0;
            let len = front.len();
            match self.link.try_write(front) {
                Ok(0) => break,
                Ok(n) => {
                    drop(self.pending.drain(..n.min(len)));
                }
                Err(e) if interrupted(&e) => {
                    interrupts += 1;
                    if interrupts > MAX_INTERRUPTS {
                        break;
                    }
                }
                Err(e) if would_block(&e) => break,
                Err(_) => {
                    self.kill_writes();
                    return;
                }
            }
        }
    }

    fn resize_grid(&mut self, cols: u16, rows: u16) {
        let before = (self.screen.cols(), self.screen.rows());
        self.screen.resize(cols, rows);
        let after = (self.screen.cols(), self.screen.rows());
        if after == before {
            return;
        }
        self.force = true;
        if !self.closed && !self.write_dead && self.link.resize(after.0, after.1).is_err() {
            self.kill_writes();
        }
    }

    fn encode(&mut self, encode: impl FnOnce(Modes, &mut Vec<u8>) -> bool) -> bool {
        let mut out = std::mem::take(&mut self.scratch);
        out.clear();
        let sent = encode(self.modes, &mut out) && self.send(&out);
        self.scratch = if out.capacity() > SCRATCH_KEEP {
            Vec::new()
        } else {
            out
        };
        sent
    }
}

impl<L: SessionLink> FrameSource for Session<L> {
    fn frame_since(&mut self, since: u64) -> Option<Frame> {
        let tick = self.tick(Instant::now());
        let frame = self.take_frame(since);
        if tick.more {
            if let Some(w) = &self.waker {
                w();
            }
        }
        frame
    }

    fn resize(&mut self, cols: u16, rows: u16) {
        self.resize_grid(cols, rows);
    }

    fn write(&mut self, bytes: &[u8]) {
        let _ = self.send(bytes);
    }

    fn set_waker(&mut self, waker: Waker) {
        self.link.set_waker(waker.clone());
        self.waker = Some(waker);
    }

    fn closed(&self) -> bool {
        self.finished()
    }

    fn deadline(&self) -> Option<Instant> {
        self.deadline_at()
    }

    fn modes(&self) -> Modes {
        self.modes
    }

    fn key(&mut self, ev: &KeyEvent<'_>) -> bool {
        self.encode(|modes, out| encode_key(ev, modes, out))
    }

    fn text(&mut self, text: &str) -> bool {
        self.encode(|modes, out| encode_text(text, modes, out))
    }

    fn paste(&mut self, text: &str) -> bool {
        self.encode(|modes, out| encode_paste(text, modes, out))
    }

    fn mouse(&mut self, ev: &MouseEvent) -> bool {
        self.encode(|modes, out| encode_mouse(ev, modes, out))
    }

    fn focus(&mut self, focused: bool) -> bool {
        self.encode(|modes, out| encode_focus(focused, modes, out))
    }
}
