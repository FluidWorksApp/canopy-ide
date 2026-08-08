//! PTY management: spawn, stream, resize, kill.
//!
//! Design:
//! - One reader thread per session does blocking reads from the PTY master into a
//!   shared `pending` buffer.
//! - One flusher thread per session drains `pending` every FLUSH_INTERVAL (coalescing
//!   many small reads into one IPC message) and sends raw bytes over a `Channel`.
//! - One writer thread per session owns the master's write end and is the only
//!   thread that ever blocks in `write()`. Callers enqueue and return.
//! - Backpressure belongs to the current renderer attachment, not the process.
//!   Acks carry an attachment generation, so a late ack from a destroyed page
//!   cannot release a replacement page's window. While no renderer is attached,
//!   the PTY keeps draining into the bounded Rust scrollback ring instead of
//!   wedging the child behind an abandoned WebView channel.
//! - Teardown: kill the child's whole process group, reader hits EOF, flusher drains,
//!   reaps the child, removes the session, emits `pty:exit`. No zombies, no leaks.

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::broadcast;

const FLUSH_INTERVAL: Duration = Duration::from_millis(10);
const PENDING_ACK_BATCHES_MAX: usize = 256;
/// How long the flusher polls for the child's exit status once its output has
/// ended, before reporting the exit without one. Long enough for a normally
/// exiting process (the status is usually there on the first poll), short enough
/// that a process wedged mid-exit can't keep a dead terminal on screen.
const REAP_WAIT: Duration = Duration::from_millis(1000);
const READ_BUF_SIZE: usize = 64 * 1024;
/// One IPC/output-ring delivery. Time coalescing still happens every 10ms, but
/// a burst can never become one multi-megabyte allocation copied through Rust,
/// Tauri and JavaScript at once.
const OUTPUT_CHUNK_MAX: usize = 64 * 1024;
const DEFAULT_HIGH_WATER: usize = 2 * 1024 * 1024;
/// How much unwritten input a session may queue before writes are refused.
/// A child that has stopped reading its stdin fills the kernel's tty buffer in
/// about a kilobyte, after which every further byte just accumulates here — so
/// this is the point at which we say the terminal is not taking input rather
/// than buffering forever. Far above any realistic paste or agent prompt.
const INPUT_HIGH_WATER: usize = 1024 * 1024;
/// How often the writer thread re-checks for teardown while its queue is empty.
const WRITER_POLL: Duration = Duration::from_millis(250);
/// Per-session output retained for a remote (Canopy Remote) attach: a
/// late-joining browser gets this many recent bytes as a catch-up snapshot
/// before the live tail. The local WebView is unaffected and keeps its own
/// xterm scrollback — this ring exists only to seed remote viewers.
const SCROLLBACK_CAP: usize = 256 * 1024;
/// Bounded fan-out queue to remote subscribers. Lossy on lag by design: a slow
/// phone is dropped to a resync, never allowed to stall the agent.
const BROADCAST_CAP: usize = 512;
/// Raw desktop channel envelope: magic, flags, reserved bytes, absolute output
/// offset, then PTY bytes. The offset lets a hidden xterm detach and request
/// only what arrived after it stopped, preserving its older 5,000-line buffer.
const DESKTOP_CHUNK_HEADER: usize = 16;
const DESKTOP_CHUNK_MAGIC: &[u8; 4] = b"CPTY";
const DESKTOP_CHUNK_GAP: u8 = 1;

fn desktop_chunk(start: u64, gap: bool, data: &[u8]) -> Vec<u8> {
    let mut framed = Vec::with_capacity(DESKTOP_CHUNK_HEADER + data.len());
    framed.extend_from_slice(DESKTOP_CHUNK_MAGIC);
    framed.push(if gap { DESKTOP_CHUNK_GAP } else { 0 });
    framed.extend_from_slice(&[0, 0, 0]);
    framed.extend_from_slice(&start.to_le_bytes());
    framed.extend_from_slice(data);
    framed
}

/// What a remote subscriber receives off a session's fan-out: coalesced output
/// bytes, or a size change so a remote terminal can render the TUI at the same
/// grid the PTY is actually using (not the phone's width).
#[derive(Clone)]
pub enum PtyEvent {
    Data(Arc<[u8]>),
    Resize(u16, u16),
}
/// How long a terminal's process group gets to exit on SIGTERM before we force
/// it. Agent CLIs use this window to flush their conversation transcript and run
/// their stop hooks — the difference between a session you can resume later and
/// one whose history never existed. Long enough for that, short enough that
/// quitting the app never feels stuck.
const GRACE: Duration = Duration::from_millis(2500);

/// A tag unique to this app launch, stamped onto every terminal it spawns
/// (env `CANOPY_INSTANCE`) and recorded in each session digest. Pid distinguishes
/// concurrent instances; the launch timestamp distinguishes a restart that reuses
/// a pid. Used to pair a session digest with the terminal it actually belongs to,
/// since the pty id alone is not unique across instances or restarts.
pub fn instance_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| {
        let pid = std::process::id();
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!("{pid:x}-{ms:x}")
    })
}

/// This launch's instance tag, for the frontend to match against digests.
#[tauri::command]
pub fn instance_id() -> String {
    instance_token().to_string()
}

pub struct Session {
    pub id: u32,
    /// Rust-owned lifetime identity, independent of renderer and attachment
    /// generations. It never changes for this child process.
    pub session_generation: u64,
    pub pid: Option<u32>,
    pub kind: SessionKind,
    pub title: Mutex<String>,
    pub cwd: String,
    /// Input queued for the writer thread, and the signal that wakes it. The
    /// PTY master's write end lives on that thread and nowhere else, so a child
    /// that has stopped reading can only ever block the writer thread — never
    /// the caller, which for `pty_write` is the main/IPC thread.
    input: Mutex<Vec<u8>>,
    input_ready: Condvar,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    shutdown: AtomicBool,
    eof: AtomicBool,
    pending: Mutex<VecDeque<u8>>,
    /// The one desktop renderer currently consuming this session. Kept behind
    /// a replaceable attachment so a WebView reload can discard the old channel
    /// and its unacked-byte count without touching the child process.
    desktop: Mutex<Option<DesktopAttachment>>,
    next_attachment: AtomicU64,
    high_water: usize,
    /// Recent output kept for remote (Canopy Remote) attach — a catch-up
    /// snapshot only, independent of the WebView's own scrollback.
    scrollback: Mutex<VecDeque<u8>>,
    /// The PTY's current grid, so a remote viewer can size its terminal to match
    /// what the desktop set (the pty is the authority — see PtyGeometry).
    size: Mutex<(u16, u16)>,
    /// Fans output + resize events out to remote subscribers, alongside the
    /// WebView `Channel`. Bounded + lossy so remote lag never touches PTY
    /// backpressure.
    subscribers: broadcast::Sender<PtyEvent>,
    /// When this terminal last painted, and how much it has painted in total.
    ///
    /// The decisive signal for "is this agent working". A turn in flight is
    /// silent in hook events by construction — nothing fires between the last
    /// tool call and the end of the turn — and near-zero in CPU while the model
    /// responds, so the two signals the lifecycle used to lean on go quiet
    /// together over exactly the window that matters. A CLI redrawing a spinner
    /// is neither: it is writing bytes.
    ///
    /// Stamped in `record_remote`, which already runs on every flush with the
    /// bytes in hand, so this costs no syscall and no extra wakeup. The byte
    /// counter is here because a terminal repainting the same frame is still
    /// output — diffing rendered text would call that silence.
    last_output_ms: AtomicU64,
    output_bytes: AtomicU64,
    /// Bytes evicted from the front of the replay ring. A reattaching terminal
    /// gets an explicit marker instead of silently presenting a partial history
    /// as though it were complete.
    dropped_output_bytes: AtomicU64,
    /// Content-free delivery counters for soak tests and incident telemetry.
    /// These are cumulative for the PTY lifetime and never retain a chunk.
    desktop_delivery_chunks: AtomicU64,
    desktop_delivery_bytes: AtomicU64,
    desktop_acked_bytes: AtomicU64,
    desktop_delivery_chunk_bytes_max: AtomicU64,
    desktop_ack_latency_last_ms: AtomicU64,
    desktop_ack_latency_max_ms: AtomicU64,
    desktop_ack_latency_total_ms: AtomicU64,
    desktop_ack_latency_samples: AtomicU64,
    /// When the human last typed, so the CLI's echo of a keystroke is not read
    /// as the agent working.
    last_input_ms: AtomicU64,
}

struct DesktopAttachment {
    renderer_generation: u64,
    generation: u64,
    channel: Channel<InvokeResponseBody>,
    outstanding: usize,
    pending_acks: PendingAckLedger,
}

#[derive(Default)]
struct PendingAckLedger {
    batches: VecDeque<(usize, u64)>,
}

impl PendingAckLedger {
    fn record(&mut self, bytes: usize, sent_ms: u64) {
        if bytes == 0 {
            return;
        }
        if self.batches.len() >= PENDING_ACK_BATCHES_MAX {
            if let Some((pending, _oldest_sent_ms)) = self.batches.back_mut() {
                *pending = pending.saturating_add(bytes);
            }
        } else {
            self.batches.push_back((bytes, sent_ms));
        }
    }

    fn acknowledge(&mut self, bytes: usize, now_ms: u64) -> Option<u64> {
        if bytes == 0 {
            return None;
        }
        let latency = self
            .batches
            .front()
            .map(|(_, sent)| now_ms.saturating_sub(*sent))?;
        let mut remaining = bytes;
        while remaining > 0 {
            let Some((pending, _)) = self.batches.front_mut() else {
                break;
            };
            let consumed = remaining.min(*pending);
            *pending -= consumed;
            remaining -= consumed;
            if *pending == 0 {
                self.batches.pop_front();
            }
        }
        Some(latency)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.batches.len()
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    /// Spawned by a visible desktop tab. Recreate the tab after a renderer
    /// replacement and kill the process only when the user explicitly closes it.
    Desktop,
    /// Spawned by Canopy Remote. A desktop tab is only a viewer and closing it
    /// must leave the remotely-owned process alive.
    Remote,
    /// A task surface with no tab. Never manufacture a terminal tab for it.
    Detached,
}

struct DesktopSink {
    renderer_generation: u64,
    channel: Channel<InvokeResponseBody>,
}

#[derive(Clone, Copy)]
pub struct DesktopDeliveryMetrics {
    pub attached: bool,
    pub outstanding_bytes: u64,
    pub replay_bytes: u64,
    pub dropped_output_bytes: u64,
    pub delivery_chunks: u64,
    pub delivery_bytes: u64,
    pub acked_bytes: u64,
    pub delivery_chunk_bytes_max: u64,
    pub ack_latency_last_ms: u64,
    pub ack_latency_max_ms: u64,
    pub ack_latency_total_ms: u64,
    pub ack_latency_samples: u64,
}

/// Wall-clock milliseconds. Only ever differenced against itself.
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// How long an exited session's output stays readable, and how many such
/// sessions are kept. Bounded on both axes because this is memory held for
/// processes that are already gone: at SCROLLBACK_CAP each, the ceiling is
/// REAPED_SESSIONS × 256 KB.
const REAPED_TTL: Duration = Duration::from_secs(60);
const REAPED_SESSIONS: usize = 8;

type ReapedOutput = Arc<Mutex<VecDeque<(u32, Vec<u8>, std::time::Instant)>>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KillAllReport {
    pub requested: u64,
    pub force_signals: u64,
}

/// Keep an exited session's output readable for a short while. Called once,
/// immediately before the session leaves the live map.
fn reap_output(reaped: &ReapedOutput, id: u32, session: &Session) {
    let bytes: Vec<u8> = session.scrollback.lock().unwrap().iter().copied().collect();
    let mut reaped = reaped.lock().unwrap();
    reaped.push_back((id, bytes, std::time::Instant::now()));
    let now = std::time::Instant::now();
    while reaped
        .front()
        .is_some_and(|(_, _, at)| now.duration_since(*at) > REAPED_TTL)
    {
        reaped.pop_front();
    }
    while reaped.len() > REAPED_SESSIONS {
        reaped.pop_front();
    }
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<u32, Arc<Session>>>>,
    /// Output of sessions that have exited, kept briefly.
    ///
    /// Teardown removes the session and then emits `pty:exit`, so every
    /// consumer that waits for the exit and *then* reads the output — which is
    /// the only correct order, since output is not complete until the process
    /// is — used to find the session already gone and get nothing. That is how
    /// a one-shot check or a package install loses the very output it ran for.
    ///
    /// Emitting the event before the removal would only narrow the race, not
    /// close it, and would briefly advertise a live session that is not. So the
    /// bytes outlive the session instead.
    reaped: Arc<Mutex<VecDeque<(u32, Vec<u8>, std::time::Instant)>>>,
    next_id: AtomicU32,
    next_session_generation: AtomicU64,
    /// Monotonic identity of the currently authoritative JavaScript page.
    /// Registering a new page detaches every channel held by the previous one.
    renderer_generation: AtomicU64,
    /// Serializes the small generation-sensitive parts of register, attach and
    /// session insertion. Without it, a stale page could pass validation, pause,
    /// then insert its channel just after the replacement detached everything.
    renderer_gate: Mutex<()>,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self {
            sessions: Default::default(),
            reaped: Default::default(),
            next_id: AtomicU32::new(0),
            next_session_generation: AtomicU64::new(0),
            renderer_generation: AtomicU64::new(0),
            renderer_gate: Mutex::new(()),
        }
    }
}

#[derive(Serialize, Clone)]
pub struct PtyExit {
    pub id: u32,
    pub session_generation: u64,
    pub exit_code: Option<u32>,
    pub requested: bool,
}

/// Emitted (`pty:spawned`) when a headless PTY is opened remotely, so the
/// desktop can open a tab attached to it.
#[derive(Serialize, Clone)]
pub struct PtySpawned {
    pub id: u32,
    pub session_generation: u64,
    pub cwd: String,
    pub title: String,
    pub cols: u16,
    pub rows: u16,
}

/// A live PTY session, minimally: enough for a remote client to know which
/// agent digests are currently attachable (correlated by id == digest.surface).
#[derive(Serialize, Clone)]
pub struct PtySummary {
    pub id: u32,
    pub session_generation: u64,
    pub pid: Option<u32>,
    pub cwd: String,
    pub title: String,
    pub cols: u16,
    pub rows: u16,
    pub kind: SessionKind,
    pub replay_start: u64,
    pub replay_end: u64,
}

#[derive(Serialize, Clone)]
pub struct SpawnResult {
    pub id: u32,
    pub session_generation: u64,
    pub pid: Option<u32>,
    /// The size the pty was actually opened at — see PtyGeometry.
    pub cols: u16,
    pub rows: u16,
    /// Present only when output is attached to the desktop renderer.
    pub generation: Option<u64>,
}

/// The size a pty agreed to, which is not always the size that was asked for.
///
/// The pty is the authority here, not the webview. The shell lays out its line
/// against the winsize we set via TIOCSWINSZ, so a terminal rendering at a width
/// the pty never agreed to wraps every redraw against the wrong column and
/// smears the line. Callers set their grid from what the pty confirms.
#[derive(Serialize, Clone)]
pub struct PtyGeometry {
    pub cols: u16,
    pub rows: u16,
}

impl PtyManager {
    fn allocate_session_identity(&self) -> Result<(u32, u64), String> {
        let id = self
            .next_id
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                value.checked_add(1)
            })
            .map(|previous| previous + 1)
            .map_err(|_| "terminal session id space exhausted".to_string())?;
        let generation = self
            .next_session_generation
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                value.checked_add(1)
            })
            .map(|previous| previous + 1)
            .map_err(|_| "terminal session generation space exhausted".to_string())?;
        Ok((id, generation))
    }

    pub fn sessions(&self) -> Arc<Mutex<HashMap<u32, Arc<Session>>>> {
        self.sessions.clone()
    }

    /// Look up a live session by id.
    pub fn get(&self, id: u32) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(&id).cloned()
    }

    pub fn live_count(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }

    /// Every session live right now, so a remote client can determine which
    /// agents are attachable authoritatively — without waiting on (or trusting)
    /// the periodic `pty:stats` event.
    pub fn summaries(&self) -> Vec<PtySummary> {
        let mut summaries = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .map(|s| {
                let (cols, rows) = *s.size.lock().unwrap();
                PtySummary {
                    id: s.id,
                    session_generation: s.session_generation,
                    pid: s.pid,
                    cwd: s.cwd.clone(),
                    title: s.title.lock().unwrap().clone(),
                    cols,
                    rows,
                    kind: s.kind,
                    replay_start: s.dropped_output_bytes.load(Ordering::Relaxed),
                    replay_end: s.output_bytes.load(Ordering::Relaxed),
                }
            })
            .collect::<Vec<_>>();
        summaries.sort_by_key(|s| s.id);
        summaries
    }

    /// Make this JavaScript page authoritative and cut every stream still
    /// pointing at its predecessor. The PTYs themselves remain alive and keep
    /// draining into their bounded rings until this page reattaches.
    pub fn register_renderer(&self) -> RendererRegistration {
        let _gate = self.renderer_gate.lock().unwrap();
        let generation = self.renderer_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let sessions = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for session in sessions {
            session.detach_desktop();
        }
        RendererRegistration {
            generation,
            sessions: self.summaries(),
        }
    }

    fn require_renderer(&self, generation: u64) -> Result<(), String> {
        let current = self.renderer_generation.load(Ordering::SeqCst);
        if generation == 0 || generation != current {
            return Err(format!(
                "renderer generation {generation} is stale (current {current})"
            ));
        }
        Ok(())
    }

    fn attach_desktop(
        &self,
        id: u32,
        renderer_generation: u64,
        after: Option<u64>,
        channel: Channel<InvokeResponseBody>,
    ) -> Result<DesktopAttachResult, String> {
        let _gate = self.renderer_gate.lock().unwrap();
        self.require_renderer(renderer_generation)?;
        let session = self.get(id).ok_or_else(|| format!("no pty session {id}"))?;
        session.attach_desktop(renderer_generation, after, channel)
    }

    /// Queue bytes for a session's PTY stdin. Shared by the `pty_write` command
    /// and the remote portal so both drive agent input through one path.
    ///
    /// Returns once the bytes are queued, not once the child has taken them.
    /// That distinction is the whole point: `pty_write` is a synchronous Tauri
    /// command, so it runs on the main/IPC thread, and writing to the master
    /// there froze the entire app whenever a child stopped draining its stdin —
    /// the kernel tty buffer fills after ~1KB and `write(2)` sleeps until the
    /// child reads or dies. The blocking write now happens on the session's own
    /// writer thread; a child that never reads costs us a full queue and an
    /// error, not the UI.
    pub fn write(&self, id: u32, data: &str) -> Result<(), String> {
        let session = self.get(id).ok_or_else(|| format!("no pty session {id}"))?;
        session.enqueue_input(data.as_bytes())
    }

    /// Tear a session down (SIGTERM, grace, SIGKILL) on a detached thread, as
    /// `pty_kill` does. Shared with the remote portal's kill/restart controls.
    pub fn kill(&self, id: u32) -> Result<(), String> {
        let session = self.get(id).ok_or_else(|| format!("no pty session {id}"))?;
        // Mark intent before yielding to the teardown thread. A fast child can
        // exit in this gap; the pty:exit consumer must still know it was asked.
        session.shutdown.store(true, Ordering::SeqCst);
        thread::spawn(move || session.terminate());
        Ok(())
    }

    /// Attach a remote consumer (Canopy Remote): returns the current scrollback
    /// snapshot plus a live receiver of subsequent output chunks, or None if the
    /// session is gone. The subscribe and the snapshot are taken under the same
    /// scrollback lock that `record_remote` holds across its append+broadcast,
    /// so the snapshot and the receiver stream join with no gap and no overlap.
    /// The receiver is bounded and lossy — on `Lagged` the caller re-`attach`es
    /// for a fresh snapshot rather than expecting every byte.
    pub fn attach(&self, id: u32) -> Option<(u16, u16, Vec<u8>, broadcast::Receiver<PtyEvent>)> {
        let session = self.get(id)?;
        let ring = session.scrollback.lock().unwrap();
        let rx = session.subscribers.subscribe();
        let snapshot = ring.iter().copied().collect();
        drop(ring);
        let (cols, rows) = *session.size.lock().unwrap();
        Some((cols, rows, snapshot, rx))
    }

    /// The last `max` bytes of a session's scrollback ring, for the context
    /// bridge's server-output tool. None if the session is gone.
    pub fn scrollback_tail(&self, id: u32, max: usize) -> Option<Vec<u8>> {
        if let Some(session) = self.get(id) {
            let ring = session.scrollback.lock().unwrap();
            let skip = ring.len().saturating_sub(max);
            return Some(ring.iter().skip(skip).copied().collect());
        }
        // Gone from the live map, but it may have only just exited — and a
        // caller reading output *because* it exited is the expected order, not
        // an error.
        let reaped = self.reaped.lock().unwrap();
        let bytes = &reaped.iter().find(|(sid, _, _)| *sid == id)?.1;
        let skip = bytes.len().saturating_sub(max);
        Some(bytes[skip..].to_vec())
    }

    /// Stop every session; called on app exit so no child processes outlive us.
    ///
    /// Signals them all first and *then* waits once, rather than terminating them
    /// one at a time: the grace period is for agents to flush their transcripts,
    /// and serialising it would cost GRACE per terminal on every quit.
    pub fn kill_all(&self) -> KillAllReport {
        let sessions: Vec<Arc<Session>> = self.sessions.lock().unwrap().values().cloned().collect();
        for s in &sessions {
            s.request_stop();
        }
        let deadline = std::time::Instant::now() + GRACE;
        while std::time::Instant::now() < deadline {
            if sessions.iter().all(|s| !s.alive()) {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let mut force_signals = 0_u64;
        for session in &sessions {
            if session.alive() {
                force_signals += 1;
                session.force();
            }
        }
        KillAllReport {
            requested: sessions.len() as u64,
            force_signals,
        }
    }
}

#[derive(Serialize, Clone)]
pub struct DesktopAttachResult {
    pub cols: u16,
    pub rows: u16,
    pub generation: u64,
    pub replay_start: u64,
    pub replay_end: u64,
}

#[derive(Serialize, Clone)]
pub struct RendererRegistration {
    pub generation: u64,
    pub sessions: Vec<PtySummary>,
}

impl Session {
    fn detach_desktop(&self) {
        *self.desktop.lock().unwrap() = None;
    }

    fn desktop_outstanding(&self) -> usize {
        self.desktop
            .lock()
            .unwrap()
            .as_ref()
            .map(|attachment| attachment.outstanding)
            .unwrap_or(0)
    }

    /// Replace the desktop output stream and replay the bounded native ring.
    /// Lock ordering is scrollback -> desktop, matching the flusher's record +
    /// send order. That makes snapshot then live output gap-free without an
    /// unbounded handoff buffer.
    fn attach_desktop(
        &self,
        renderer_generation: u64,
        after: Option<u64>,
        channel: Channel<InvokeResponseBody>,
    ) -> Result<DesktopAttachResult, String> {
        let ring = self.scrollback.lock().unwrap();
        let generation = self.next_attachment.fetch_add(1, Ordering::SeqCst) + 1;
        let ring_start = self.dropped_output_bytes.load(Ordering::Relaxed);
        let ring_end = ring_start.saturating_add(ring.len() as u64);
        let (replay_start, gap) = match after {
            None => (ring_start, ring_start > 0),
            Some(cursor) if cursor >= ring_start && cursor <= ring_end => (cursor, false),
            Some(_) => (ring_start, true),
        };
        let skip = replay_start.saturating_sub(ring_start) as usize;
        let snapshot = ring.iter().skip(skip).copied().collect::<Vec<_>>();
        let mut desktop = self.desktop.lock().unwrap();
        *desktop = Some(DesktopAttachment {
            renderer_generation,
            generation,
            channel,
            outstanding: 0,
            pending_acks: PendingAckLedger::default(),
        });
        if !snapshot.is_empty() || gap {
            let attachment = desktop.as_mut().expect("attachment inserted");
            attachment.outstanding = snapshot.len();
            if attachment
                .channel
                .send(InvokeResponseBody::Raw(desktop_chunk(
                    replay_start,
                    gap,
                    &snapshot,
                )))
                .is_err()
            {
                *desktop = None;
                return Err("renderer closed while the terminal was reattaching".into());
            }
            self.record_desktop_delivery(attachment, snapshot.len());
        }
        drop(desktop);
        drop(ring);
        let (cols, rows) = *self.size.lock().unwrap();
        Ok(DesktopAttachResult {
            cols,
            rows,
            generation,
            replay_start,
            replay_end: ring_end,
        })
    }

    fn send_desktop(&self, start: u64, data: Vec<u8>) {
        let generation = {
            let mut desktop = self.desktop.lock().unwrap();
            let Some(attachment) = desktop.as_mut() else {
                return;
            };
            attachment.outstanding = attachment.outstanding.saturating_add(data.len());
            let generation = attachment.generation;
            if attachment
                .channel
                .send(InvokeResponseBody::Raw(desktop_chunk(start, false, &data)))
                .is_ok()
            {
                self.record_desktop_delivery(attachment, data.len());
                return;
            }
            generation
        };
        // A failed channel means only that renderer attachment is gone. Never
        // terminate the PTY: a new page can reattach to the same child.
        let mut desktop = self.desktop.lock().unwrap();
        if desktop
            .as_ref()
            .is_some_and(|attachment| attachment.generation == generation)
        {
            *desktop = None;
        }
    }

    fn acknowledge(&self, renderer_generation: u64, generation: u64, bytes: usize) {
        let mut desktop = self.desktop.lock().unwrap();
        let Some(attachment) = desktop.as_mut() else {
            return;
        };
        if attachment.renderer_generation != renderer_generation
            || attachment.generation != generation
        {
            return;
        }
        let acknowledged = bytes.min(attachment.outstanding);
        attachment.outstanding -= acknowledged;
        self.desktop_acked_bytes
            .fetch_add(acknowledged as u64, Ordering::Relaxed);
        if acknowledged > 0 {
            let latency = attachment
                .pending_acks
                .acknowledge(acknowledged, now_ms())
                .unwrap_or(0);
            self.desktop_ack_latency_last_ms
                .store(latency, Ordering::Relaxed);
            self.desktop_ack_latency_max_ms
                .fetch_max(latency, Ordering::Relaxed);
            self.desktop_ack_latency_total_ms
                .fetch_add(latency, Ordering::Relaxed);
            self.desktop_ack_latency_samples
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    fn detach_matching(&self, renderer_generation: u64, generation: u64) {
        let mut desktop = self.desktop.lock().unwrap();
        if desktop.as_ref().is_some_and(|attachment| {
            attachment.renderer_generation == renderer_generation
                && attachment.generation == generation
        }) {
            *desktop = None;
        }
    }

    fn record_desktop_delivery(&self, attachment: &mut DesktopAttachment, bytes: usize) {
        self.desktop_delivery_chunks.fetch_add(1, Ordering::Relaxed);
        self.desktop_delivery_bytes
            .fetch_add(bytes as u64, Ordering::Relaxed);
        self.desktop_delivery_chunk_bytes_max
            .fetch_max(bytes as u64, Ordering::Relaxed);
        attachment.pending_acks.record(bytes, now_ms());
    }

    /// The process the kernel currently has in this pty's foreground.
    ///
    /// This is the authoritative answer to "what is this terminal running",
    /// which no amount of scanning the process tree can reconstruct: children
    /// an agent spawns (MCP servers, git, ripgrep) share their parent's process
    /// group, so the leader stays the thing the user actually launched. The
    /// monitor uses it to pick one candidate to identify instead of hunting for
    /// an agent-looking name anywhere under the shell.
    ///
    /// Equal to the session's own pid when the shell is idle at its prompt.
    #[cfg(unix)]
    pub fn foreground_pid(&self) -> Option<u32> {
        let master = self.master.lock().ok()?;
        master
            .process_group_leader()
            .and_then(|pid| u32::try_from(pid).ok())
    }

    #[cfg(not(unix))]
    pub fn foreground_pid(&self) -> Option<u32> {
        None
    }

    /// Whether the foreground app has taken the tty out of canonical mode —
    /// i.e. something full-screen and interactive owns the terminal, rather
    /// than a command printing lines and exiting.
    ///
    /// Read straight off the pty because we own it. It is the one signal that
    /// separates an unrecognised *agent* from an unrecognised *script* without
    /// asking the user or sniffing anything private about the process.
    #[cfg(unix)]
    pub fn raw_mode(&self) -> bool {
        let Ok(master) = self.master.lock() else {
            return false;
        };
        let Some(fd) = master.as_raw_fd() else {
            return false;
        };
        // SAFETY: fd is owned by the master pty, which is alive for the
        // duration of the borrow; tcgetattr only writes the termios out-param.
        unsafe {
            let mut termios: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(fd, &mut termios) != 0 {
                return false;
            }
            termios.c_lflag & libc::ICANON == 0
        }
    }

    #[cfg(not(unix))]
    pub fn raw_mode(&self) -> bool {
        false
    }

    /// Hand bytes to the writer thread. Never blocks on the child: if the queue
    /// is already at its bound the child has stopped reading, and the honest
    /// answer is an error the caller can show rather than input that silently
    /// piles up in memory behind a terminal that will never take it.
    fn enqueue_input(&self, bytes: &[u8]) -> Result<(), String> {
        let mut queue = self.input.lock().unwrap();
        if queue.len() + bytes.len() > INPUT_HIGH_WATER {
            return Err(format!("terminal {} is not accepting input", self.id));
        }
        queue.extend_from_slice(bytes);
        self.last_input_ms.store(now_ms(), Ordering::Relaxed);
        self.input_ready.notify_one();
        Ok(())
    }

    /// Milliseconds since this terminal last painted, and since the human last
    /// typed into it. `None` before either has ever happened — an unanswered
    /// question, not a very long silence.
    pub fn quiet_ms(&self, now: u64) -> Option<u64> {
        let last = self.last_output_ms.load(Ordering::Relaxed);
        (last > 0).then(|| now.saturating_sub(last))
    }

    pub fn since_input_ms(&self, now: u64) -> Option<u64> {
        let last = self.last_input_ms.load(Ordering::Relaxed);
        (last > 0).then(|| now.saturating_sub(last))
    }

    pub fn output_bytes(&self) -> u64 {
        self.output_bytes.load(Ordering::Relaxed)
    }

    /// Bounded-state delivery diagnostics. Lock order matches attach so the
    /// process monitor can sample this without introducing a lifecycle race.
    pub fn desktop_delivery_metrics(&self) -> DesktopDeliveryMetrics {
        let replay_bytes = self.scrollback.lock().unwrap().len() as u64;
        let (attached, outstanding_bytes) = self
            .desktop
            .lock()
            .unwrap()
            .as_ref()
            .map(|a| (true, a.outstanding as u64))
            .unwrap_or((false, 0));
        DesktopDeliveryMetrics {
            attached,
            outstanding_bytes,
            replay_bytes,
            dropped_output_bytes: self.dropped_output_bytes.load(Ordering::Relaxed),
            delivery_chunks: self.desktop_delivery_chunks.load(Ordering::Relaxed),
            delivery_bytes: self.desktop_delivery_bytes.load(Ordering::Relaxed),
            acked_bytes: self.desktop_acked_bytes.load(Ordering::Relaxed),
            delivery_chunk_bytes_max: self
                .desktop_delivery_chunk_bytes_max
                .load(Ordering::Relaxed),
            ack_latency_last_ms: self.desktop_ack_latency_last_ms.load(Ordering::Relaxed),
            ack_latency_max_ms: self.desktop_ack_latency_max_ms.load(Ordering::Relaxed),
            ack_latency_total_ms: self.desktop_ack_latency_total_ms.load(Ordering::Relaxed),
            ack_latency_samples: self.desktop_ack_latency_samples.load(Ordering::Relaxed),
        }
    }

    /// Append a freshly-flushed chunk to the bounded scrollback and fan it out
    /// to remote subscribers. Callers hold `scrollback` across this helper.
    ///
    /// Also where the output clock is stamped. This runs on every flush for
    /// every pty, headless ones included, and the bytes are already in hand —
    /// so "when did this terminal last say anything" costs two relaxed stores.
    fn record_output_locked(&self, ring: &mut VecDeque<u8>, data: &[u8]) -> u64 {
        self.last_output_ms.store(now_ms(), Ordering::Relaxed);
        let start = self.output_bytes.load(Ordering::Relaxed);
        ring.extend(data.iter().copied());
        let overflow = ring.len().saturating_sub(SCROLLBACK_CAP);
        if overflow > 0 {
            ring.drain(0..overflow);
            self.dropped_output_bytes
                .fetch_add(overflow as u64, Ordering::Relaxed);
        }
        self.output_bytes
            .store(start.saturating_add(data.len() as u64), Ordering::Relaxed);
        // Err just means nobody is attached right now; ignore it.
        let _ = self.subscribers.send(PtyEvent::Data(Arc::from(data)));
        start
    }

    /// Record output for headless/test producers that do not have a desktop
    /// delivery to join atomically.
    #[cfg(test)]
    fn record_remote(&self, data: &[u8]) -> u64 {
        let mut ring = self.scrollback.lock().unwrap();
        self.record_output_locked(&mut ring, data)
    }

    /// Join ring append and desktop delivery under the same lock order used by
    /// attach (`scrollback -> desktop`). Without this, attach could snapshot a
    /// just-recorded chunk and then receive that same chunk again as live data.
    fn record_and_send_desktop(&self, data: Vec<u8>) {
        let mut ring = self.scrollback.lock().unwrap();
        let start = self.record_output_locked(&mut ring, &data);
        self.send_desktop(start, data);
    }

    /// Record a new grid size and tell remote subscribers, so a remote terminal
    /// re-sizes to the PTY's actual columns/rows instead of guessing.
    fn record_resize(&self, cols: u16, rows: u16) {
        *self.size.lock().unwrap() = (cols, rows);
        let _ = self.subscribers.send(PtyEvent::Resize(cols, rows));
    }

    /// Ask the process group to exit, and force it only if it refuses.
    ///
    /// This used to send SIGKILL outright. SIGKILL is uncatchable, so agent CLIs
    /// never got to shut down: Claude Code writes its conversation transcript and
    /// runs its Stop hook on the way out, and killing it dead meant a session with
    /// real work in it left *no transcript at all* — `claude --resume` on it
    /// answers "No conversation found". Closing a tab silently destroyed the
    /// conversation inside it.
    fn terminate(&self) {
        self.request_stop();
        self.await_exit(GRACE);
        self.force();
    }

    /// SIGTERM the whole process group. The shell is the PTY's session leader, so
    /// the signal reaches grandchildren — the agent — as well.
    fn request_stop(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
        #[cfg(unix)]
        for pgid in self.process_groups() {
            unsafe {
                libc::killpg(pgid as libc::pid_t, libc::SIGTERM);
            }
        }
    }

    /// Interactive shells put their foreground job in a different process
    /// group from the shell. Signal both groups: targeting only the launch
    /// shell can leave the agent that actually owns the terminal running.
    #[cfg(unix)]
    fn process_groups(&self) -> Vec<u32> {
        let mut groups = Vec::with_capacity(2);
        if let Some(root) = self.pid {
            groups.push(root);
        }
        if let Some(foreground) = self.foreground_pid() {
            if !groups.contains(&foreground) {
                groups.push(foreground);
            }
        }
        groups
    }

    /// Whether any process in the group is still alive. Signal 0 tests for
    /// existence without delivering anything.
    fn alive(&self) -> bool {
        #[cfg(unix)]
        {
            self.process_groups()
                .into_iter()
                .any(|pgid| unsafe { libc::killpg(pgid as libc::pid_t, 0) == 0 })
        }
        #[cfg(not(unix))]
        {
            false
        }
    }

    /// Poll for a clean exit for up to `grace`. Polling rather than waiting on the
    /// child keeps a wedged agent from hanging app shutdown.
    fn await_exit(&self, grace: Duration) {
        let deadline = std::time::Instant::now() + grace;
        while std::time::Instant::now() < deadline {
            if !self.alive() {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    /// Last resort, for a process group that ignored SIGTERM.
    fn force(&self) {
        #[cfg(unix)]
        for pgid in self.process_groups() {
            if unsafe { libc::killpg(pgid as libc::pid_t, 0) == 0 } {
                unsafe {
                    libc::killpg(pgid as libc::pid_t, libc::SIGKILL);
                }
            }
        }
        let _ = self.killer.lock().unwrap().kill();
    }
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyManager>,
    tasks: State<'_, crate::tasks::TaskStore>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    high_water: Option<usize>,
    run_command: Option<String>,
    // A run started inside a workspace carries that workspace's port lease, so
    // several checkouts of the same repo can serve at once instead of fighting
    // over one hard-coded port.
    env: Option<Vec<(String, String)>>,
    run_id: Option<String>,
    attempt_id: Option<String>,
    renderer_generation: u64,
    on_data: Channel<InvokeResponseBody>,
) -> Result<SpawnResult, String> {
    state.require_renderer(renderer_generation)?;
    let binding = tasks.spawn_binding(run_id.as_deref(), attempt_id.as_deref())?;
    let result = state.spawn(
        app,
        cols,
        rows,
        cwd,
        shell,
        high_water,
        run_command.map(RunSpec::Shell),
        SessionKind::Desktop,
        Some(DesktopSink {
            renderer_generation,
            channel: on_data,
        }),
        env,
        binding.clone(),
    );
    finish_task_spawn(&state, &tasks, binding.as_ref(), result)
}

/// Spawn a PTY that no tab owns, for a micro-task: the agent runs its one job in
/// the background and reports through `canopy_job_done`, so the Tasks panel is
/// the only surface it needs. Deliberately *not* `spawn_headless`, which
/// announces itself with `pty:spawned` — the desktop answers that by opening a
/// tab, which is the thing a micro-task is trying not to be.
///
/// `command` runs as the shell's argument (login + interactive, so the user's
/// PATH is there) and the shell exits with it, so the agent quitting settles the
/// run on its own. `env` is stamped onto the child rather than written as a
/// `VAR=1 cmd` prefix, which only a Bourne shell would understand.
#[tauri::command]
pub fn pty_spawn_detached(
    app: AppHandle,
    state: State<'_, PtyManager>,
    tasks: State<'_, crate::tasks::TaskStore>,
    cwd: Option<String>,
    command: String,
    env: Option<Vec<(String, String)>>,
    run_id: Option<String>,
    attempt_id: Option<String>,
) -> Result<SpawnResult, String> {
    let binding = tasks.spawn_binding(run_id.as_deref(), attempt_id.as_deref())?;
    let result = state.spawn(
        app,
        120,
        40,
        cwd,
        None,
        None,
        Some(RunSpec::Shell(command)),
        SessionKind::Detached,
        None,
        env,
        binding.clone(),
    );
    finish_task_spawn(&state, &tasks, binding.as_ref(), result)
}

/// Spawn a detached PTY from an argv array, never touching a shell.
///
/// This is the execution end of the managed abstractions — installing a
/// package, linking a service, publishing a site. Those plans are assembled
/// from things Canopy does not control: a package name a user typed, a version
/// string, a provider id. The planners already refuse anything that looks like
/// a flag or an illegal name, but refusing bad input is only half of it; the
/// other half is that even accepted input must never be *parsed* again on the
/// way to the process.
///
/// Deliberately a separate command from `pty_spawn_detached` rather than an
/// optional `argv` field on it. One command taking either form would need a
/// rule for what happens when both arrive, and every such rule eventually
/// resolves to joining argv into text.
#[tauri::command]
pub fn pty_spawn_argv(
    app: AppHandle,
    state: State<'_, PtyManager>,
    tasks: State<'_, crate::tasks::TaskStore>,
    cwd: Option<String>,
    argv: Vec<String>,
    env: Option<Vec<(String, String)>>,
    run_id: Option<String>,
    attempt_id: Option<String>,
) -> Result<SpawnResult, String> {
    // An empty first element is as unusable as no first element, and it would
    // otherwise reach CommandBuilder as a program named "" and surface as an
    // opaque spawn failure instead of this.
    if argv.first().map(|p| p.trim().is_empty()).unwrap_or(true) {
        return Err("argv must name a program".into());
    }
    let binding = tasks.spawn_binding(run_id.as_deref(), attempt_id.as_deref())?;
    let result = state.spawn(
        app,
        120,
        40,
        cwd,
        None,
        None,
        Some(RunSpec::Argv(argv)),
        SessionKind::Detached,
        None,
        env,
        binding.clone(),
    );
    finish_task_spawn(&state, &tasks, binding.as_ref(), result)
}

/// Spawn an argv-native run whose output is owned by a visible terminal tab.
/// Kept separate from `pty_spawn`: callers cannot accidentally supply both a
/// shell command and argv, and argv is never re-parsed into text.
#[tauri::command]
pub fn pty_spawn_attached_argv(
    app: AppHandle,
    state: State<'_, PtyManager>,
    tasks: State<'_, crate::tasks::TaskStore>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    high_water: Option<usize>,
    argv: Vec<String>,
    env: Option<Vec<(String, String)>>,
    run_id: Option<String>,
    attempt_id: Option<String>,
    renderer_generation: u64,
    on_data: Channel<InvokeResponseBody>,
) -> Result<SpawnResult, String> {
    if argv.first().map(|p| p.trim().is_empty()).unwrap_or(true) {
        return Err("argv must name a program".into());
    }
    state.require_renderer(renderer_generation)?;
    let binding = tasks.spawn_binding(run_id.as_deref(), attempt_id.as_deref())?;
    let result = state.spawn(
        app,
        cols,
        rows,
        cwd,
        None,
        high_water,
        Some(RunSpec::Argv(argv)),
        SessionKind::Desktop,
        Some(DesktopSink {
            renderer_generation,
            channel: on_data,
        }),
        env,
        binding.clone(),
    );
    finish_task_spawn(&state, &tasks, binding.as_ref(), result)
}

fn finish_task_spawn(
    ptys: &PtyManager,
    tasks: &crate::tasks::TaskStore,
    binding: Option<&crate::tasks::AttemptBinding>,
    result: Result<SpawnResult, String>,
) -> Result<SpawnResult, String> {
    match result {
        Err(error) => {
            if let Some(binding) = binding {
                tasks.mark_launch_failed(binding).map_err(|record_error| {
                    format!("{error}; failed to record task launch failure: {record_error}")
                })?;
            }
            Err(error)
        }
        Ok(spawned) => {
            if let Some(binding) = binding {
                if let Err(error) = tasks.mark_spawned(binding) {
                    let _ = ptys.kill(spawned.id);
                    let _ = tasks.mark_launch_failed(binding);
                    return Err(format!(
                        "spawned PTY but could not start task attempt: {error}"
                    ));
                }
            }
            Ok(spawned)
        }
    }
}

/// The tail of a PTY's output, for a run nobody is watching: a micro-task's
/// transcript has to be read off the session itself, there being no xterm buffer
/// to capture from. Raw bytes as the terminal emitted them (escape sequences and
/// all) — the caller replays them through a terminal parser to get text.
#[tauri::command]
pub fn pty_output(state: State<'_, PtyManager>, id: u32, max: Option<usize>) -> Option<String> {
    state
        .scrollback_tail(id, max.unwrap_or(64 * 1024))
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// What a PTY should run.
///
/// The two forms are kept apart at the type level on purpose. `Shell` is text
/// handed to the user's shell, which is what a terminal and a run tab want:
/// `npm run dev -- --port 3000` should parse as the user wrote it. `Argv`
/// bypasses the shell entirely — program and arguments cross as separate
/// strings, so nothing inside them can be read as syntax.
///
/// A caller holding argv must never be able to reach the shell path by joining
/// with spaces. That join is the whole vulnerability: a package name of
/// `x; rm -rf ~` is inert as an argument and a catastrophe as shell text.
pub enum RunSpec {
    Shell(String),
    Argv(Vec<String>),
}

impl PtyManager {
    /// Spawn a headless PTY (no WebView channel) that a remote client can attach
    /// to — used by Canopy Remote to open a new terminal / agent from a phone.
    /// Runs `command` (an agent CLI) in `cwd` if given. Returns the new PTY id.
    pub fn spawn_headless<R: tauri::Runtime>(
        &self,
        app: AppHandle<R>,
        cwd: Option<String>,
        command: Option<String>,
        account_override: Option<Vec<(String, String)>>,
    ) -> Result<u32, String> {
        // A remote launch uses the same account as a desktop one; this path
        // has no webview to ask, so it reads profiles::active.
        let account = account_override.or_else(|| {
            std::env::var("HOME")
                .ok()
                .zip(command.as_deref())
                .map(|(home, cmd)| crate::profiles::env_for_command(&home, cmd))
                .filter(|e| !e.is_empty())
        });
        let res = self.spawn(
            app.clone(),
            120,
            32,
            cwd,
            None,
            None,
            None,
            SessionKind::Remote,
            None,
            account,
            None,
        )?;
        if let Some(cmd) = command {
            let cmd = cmd.trim();
            if !cmd.is_empty() {
                // The PTY buffers stdin, so writing right after spawn is fine —
                // the shell reads it once it's up. Mirrors the desktop's
                // initial-command behaviour.
                let _ = self.write(res.id, &format!("{cmd}\r"));
            }
        }
        // Tell the desktop a new terminal/agent appeared so it can open a tab
        // attached to it (pty_attach). Best-effort.
        if let Some(s) = self.get(res.id) {
            let _ = app.emit(
                "pty:spawned",
                PtySpawned {
                    id: res.id,
                    session_generation: res.session_generation,
                    cwd: s.cwd.clone(),
                    title: s.title.lock().unwrap().clone(),
                    cols: res.cols,
                    rows: res.rows,
                },
            );
        }
        Ok(res.id)
    }

    /// The shared spawn core. `desktop` is the replaceable WebView streaming
    /// attachment when a desktop tab owns this PTY; headless and detached PTYs
    /// skip WebView backpressure so no absent renderer can stall their output.
    /// Generic over the runtime so it can be exercised with a mock app in tests.
    #[allow(clippy::too_many_arguments)]
    fn spawn<R: tauri::Runtime>(
        &self,
        app: AppHandle<R>,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        shell: Option<String>,
        high_water: Option<usize>,
        run: Option<RunSpec>,
        kind: SessionKind,
        desktop: Option<DesktopSink>,
        extra_env: Option<Vec<(String, String)>>,
        task_identity: Option<crate::tasks::AttemptBinding>,
    ) -> Result<SpawnResult, String> {
        let state = self;
        // Clamp for the same reason pty_resize does: a terminal spawned into a
        // hidden tab measures 0, and a zero-column pty is meaningless. 80x24 is the
        // conventional fallback, and the frontend corrects it the moment the tab is
        // shown and the resize round-trips.
        let cols = if cols == 0 { 80 } else { cols };
        let rows = if rows == 0 { 24 } else { rows };

        // Sample the host only to size this terminal's own starting allowance.
        // A previous host-wide admission gate refused every new terminal before
        // it had an id, so one busy project prevented an unrelated shell — and
        // Build's setup agent — from starting at all. Pressure shedding remains
        // host-wide, but allowance, measurement, grants and stop decisions begin
        // only after the new PTY has its own session identity below.
        let host = app
            .try_state::<crate::governor::TerminalGovernor>()
            .map(|_| crate::watchdog::memory_info());

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        // Allocated before spawn so the child can carry its own session id in env.
        let (id, session_generation) = state.allocate_session_identity()?;

        let shell = shell.unwrap_or_else(default_shell);
        let mut cmd = match &run {
            // No shell is involved at all: the program is the process, and each
            // argument stays one argument however it is spelled.
            Some(RunSpec::Argv(argv)) => {
                // Guarded here rather than only in the command wrapper: this is
                // the chokepoint every argv caller passes through, and a program
                // name of "" would otherwise reach CommandBuilder and surface as
                // an opaque spawn failure.
                let (program, rest) = argv
                    .split_first()
                    .filter(|(p, _)| !p.trim().is_empty())
                    .ok_or_else(|| "argv must name a program".to_string())?;
                let mut cmd = CommandBuilder::new(program);
                for a in rest {
                    cmd.arg(a);
                }
                cmd
            }
            // A run tab: the shell runs one command and exits with the command's own
            // status, so a one-shot build/install reports truthfully instead of
            // sitting at a prompt looking "running" forever. Passed as shell args
            // (not typed into the shell) so it's correct on cmd.exe / PowerShell /
            // POSIX alike — no `; exit $?` idiom that only parses in a Bourne shell.
            Some(RunSpec::Shell(command)) => {
                let mut cmd = CommandBuilder::new(&shell);
                for a in run_args(&shell, command) {
                    cmd.arg(a);
                }
                cmd
            }
            // A normal terminal: a login shell so the user's PATH / prompt setup
            // loads, matching a real terminal.
            None => {
                let mut cmd = CommandBuilder::new(&shell);
                #[cfg(unix)]
                cmd.args(["-l"]);
                cmd
            }
        };
        // The caller's own variables go on first, so Canopy's identity vars below
        // always win however a caller spells them.
        let extra_env = extra_env.unwrap_or_default();
        let caller_set_aider_read = extra_env.iter().any(|(k, _)| k == "AIDER_READ");
        for (k, v) in extra_env {
            if matches!(k.as_str(), "CANOPY_RUN_ID" | "CANOPY_ATTEMPT_ID") {
                continue;
            }
            cmd.env(k, v);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Agent CLI hooks inherit these and use them to (a) prove the event came
        // from a terminal we own and (b) name the tab it came from.
        cmd.env("CANOPY", "1");
        cmd.env("CANOPY_PTY", id.to_string());
        // Pty ids reset to 1 every app launch and every instance writes to the same
        // ~/.canopy/sessions, so the pty id alone can't tell one instance's "term
        // #5" from another's — which silently binds one agent's digest to another's
        // terminal in the panel. This tag makes the pairing unambiguous.
        cmd.env("CANOPY_INSTANCE", instance_token());
        // Aider has no MCP client or system-prompt hook. Its documented
        // AIDER_READ channel adds a read-only conventions file without
        // creating a fake opening user turn. Scope it to Canopy's PTYs and
        // preserve an explicit value from either the app caller or the user's
        // inherited environment.
        let home = dirs_home();
        if let Some(path) = canopy_aider_context(
            caller_set_aider_read,
            std::env::var_os("AIDER_READ").is_some(),
            home.as_deref(),
        ) {
            cmd.env("AIDER_READ", path);
        }
        if let Some(task) = &task_identity {
            // Reserved identity is stamped after caller env, alongside the
            // PTY/instance stamps. A surface cannot override or invent it.
            cmd.env("CANOPY_RUN_ID", &task.run_id);
            cmd.env("CANOPY_ATTEMPT_ID", &task.attempt_id);
        }
        let cwd = cwd
            .or_else(|| dirs_home())
            .unwrap_or_else(|| "/".to_string());
        // Where the context bridge answers (see context.rs): `canopy-hook --mcp`,
        // spawned by an agent CLI in this terminal, inherits these and gains the
        // Canopy context tools. try_state: tests' mock app doesn't manage it.
        //
        // The token is minted for this terminal alone, so the bridge can tell
        // which session is calling without taking its word for it. Every PTY
        // used to carry the same one, which left "who is asking" answerable
        // only from body fields the caller filled in itself.
        if let Some(ctx) = app.try_state::<crate::context::ContextBridge>() {
            if let Some((port, token)) = ctx.mint_agent(id, &cwd, task_identity.as_ref()) {
                cmd.env("CANOPY_CTX_PORT", port.to_string());
                cmd.env("CANOPY_CTX_TOKEN", token);
            }
        }
        cmd.cwd(&cwd);

        // Platform containment is prepared before spawn. A supported backend
        // may replace argv with a gate launcher, but it never changes the
        // command's environment, cwd, terminal geometry, or stdio contract.
        // Mock apps do not manage containment and therefore remain monitor-only.
        let prepared_containment =
            if let Some(containment) = app.try_state::<crate::containment::ContainmentManager>() {
                let host = host.expect("the production app manages both governor and containment");
                Some(containment.prepare(
                    id,
                    crate::governor::base_allowance(host.total_bytes),
                    &mut cmd,
                )?)
            } else {
                None
            };

        // The credential was minted before the child so it could be in its
        // environment from the first instruction. Every failure between there
        // and the session being registered has to hand it back: nothing is
        // watching for an exit yet, so a credential left behind names a
        // terminal that will never appear and never be swept — and on the paths
        // below the child is already running and already holding it.
        let retire = || {
            if let Some(ctx) = app.try_state::<crate::context::ContextBridge>() {
                ctx.retire_agent(id);
            }
        };
        let mut child = match pair.slave.spawn_command(cmd) {
            Ok(child) => child,
            Err(e) => {
                retire();
                return Err(e.to_string());
            }
        };
        let pid = child.process_id();
        if let Some(prepared) = prepared_containment {
            let containment = app.state::<crate::containment::ContainmentManager>();
            if let Err(failure) = containment.activate(id, pid, prepared) {
                retire();
                let _ = child.kill();
                let _ = child.wait();
                return Err(failure.cleanup_after_child_exit());
            }
        }
        drop(pair.slave);

        let (mut reader, mut writer) = match pair
            .master
            .try_clone_reader()
            .and_then(|r| pair.master.take_writer().map(|w| (r, w)))
        {
            Ok(pair) => pair,
            Err(e) => {
                retire();
                if let Some(containment) = app.try_state::<crate::containment::ContainmentManager>()
                {
                    containment.release(id);
                }
                // The command already exists and holds the task environment.
                // Returning a launch failure without terminating it would leave
                // real work running under an attempt recorded as failed.
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        };

        let killer = child.clone_killer();

        let desktop_renderer_generation = desktop.as_ref().map(|sink| sink.renderer_generation);
        let (desktop, generation) = match desktop {
            Some(sink) => (
                Some(DesktopAttachment {
                    renderer_generation: sink.renderer_generation,
                    generation: 1,
                    channel: sink.channel,
                    outstanding: 0,
                    pending_acks: PendingAckLedger::default(),
                }),
                Some(1),
            ),
            None => (None, None),
        };

        let session = Arc::new(Session {
            id,
            session_generation,
            pid,
            kind,
            title: Mutex::new(shell.clone()),
            cwd,
            input: Mutex::new(Vec::new()),
            input_ready: Condvar::new(),
            master: Mutex::new(pair.master),
            killer: Mutex::new(killer),
            child: Mutex::new(Some(child)),
            shutdown: AtomicBool::new(false),
            eof: AtomicBool::new(false),
            pending: Mutex::new(VecDeque::new()),
            desktop: Mutex::new(desktop),
            next_attachment: AtomicU64::new(generation.unwrap_or(0)),
            high_water: high_water.unwrap_or(DEFAULT_HIGH_WATER),
            scrollback: Mutex::new(VecDeque::new()),
            size: Mutex::new((cols, rows)),
            subscribers: broadcast::channel(BROADCAST_CAP).0,
            // Zero means "has never happened", which is why these are not
            // stamped with the spawn time: a terminal that has not painted yet
            // is an unanswered question, not a terminal that has been silent
            // since it started.
            last_output_ms: AtomicU64::new(0),
            output_bytes: AtomicU64::new(0),
            dropped_output_bytes: AtomicU64::new(0),
            desktop_delivery_chunks: AtomicU64::new(0),
            desktop_delivery_bytes: AtomicU64::new(0),
            desktop_acked_bytes: AtomicU64::new(0),
            desktop_delivery_chunk_bytes_max: AtomicU64::new(0),
            desktop_ack_latency_last_ms: AtomicU64::new(0),
            desktop_ack_latency_max_ms: AtomicU64::new(0),
            desktop_ack_latency_total_ms: AtomicU64::new(0),
            desktop_ack_latency_samples: AtomicU64::new(0),
            last_input_ms: AtomicU64::new(0),
        });

        // Commit a desktop session under the same gate as renderer replacement.
        // Validation at the command boundary is only an early refusal; this is
        // the race-closing check after process creation and immediately before
        // the channel becomes reachable by the flusher.
        let renderer_gate =
            desktop_renderer_generation.map(|_| state.renderer_gate.lock().unwrap());
        if let Some(renderer_generation) = desktop_renderer_generation {
            if let Err(error) = state.require_renderer(renderer_generation) {
                drop(renderer_gate);
                session.terminate();
                if let Some(mut child) = session.child.lock().unwrap().take() {
                    let _ = child.wait();
                }
                retire();
                if let Some(containment) = app.try_state::<crate::containment::ContainmentManager>()
                {
                    containment.release(id);
                }
                return Err(error);
            }
        }
        state.sessions.lock().unwrap().insert(id, session.clone());
        drop(renderer_gate);

        // Reader thread: blocking reads -> pending buffer, with backpressure.
        {
            let session = session.clone();
            thread::Builder::new()
                .name(format!("pty-reader-{id}"))
                .spawn(move || {
                    let mut buf = [0u8; READ_BUF_SIZE];
                    loop {
                        if session.shutdown.load(Ordering::SeqCst) {
                            break;
                        }
                        // Backpressure: stop reading while the WebView is behind. The
                        // kernel PTY buffer fills and the child blocks — bounded memory.
                        loop {
                            let queued = session.pending.lock().unwrap().len()
                                + session.desktop_outstanding();
                            if queued <= session.high_water
                                || session.shutdown.load(Ordering::SeqCst)
                            {
                                break;
                            }
                            thread::sleep(Duration::from_millis(5));
                        }
                        match reader.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                session
                                    .pending
                                    .lock()
                                    .unwrap()
                                    .extend(buf[..n].iter().copied());
                            }
                        }
                    }
                    session.eof.store(true, Ordering::SeqCst);
                })
                .expect("spawn pty reader thread");
        }

        // Writer thread: the only place a write to the PTY master happens, so the
        // one call that can sleep indefinitely — a child that has stopped reading
        // its stdin — sleeps here instead of on the caller's thread. Ends when the
        // session is torn down or the child's output has ended; a write that is
        // still blocked at that point returns EIO once the last slave fd closes.
        {
            let session = session.clone();
            thread::Builder::new()
                .name(format!("pty-writer-{id}"))
                .spawn(move || loop {
                    let chunk = {
                        let mut queue = session.input.lock().unwrap();
                        while queue.is_empty() {
                            if session.shutdown.load(Ordering::SeqCst)
                                || session.eof.load(Ordering::SeqCst)
                            {
                                return;
                            }
                            queue = session
                                .input_ready
                                .wait_timeout(queue, WRITER_POLL)
                                .unwrap()
                                .0;
                        }
                        std::mem::take(&mut *queue)
                    };
                    if writer.write_all(&chunk).is_err() {
                        break;
                    }
                })
                .expect("spawn pty writer thread");
        }

        // Flusher thread: coalesce pending bytes into batched IPC messages; on EOF,
        // drain, reap the child, clean up the session, emit pty:exit.
        {
            let session = session.clone();
            let sessions = state.sessions.clone();
            let reaped = state.reaped.clone();
            thread::Builder::new()
                .name(format!("pty-flush-{id}"))
                .spawn(move || {
                    loop {
                        thread::sleep(FLUSH_INTERVAL);
                        let chunk = {
                            let mut pending = session.pending.lock().unwrap();
                            if pending.is_empty() {
                                None
                            } else {
                                let take = pending.len().min(OUTPUT_CHUNK_MAX);
                                Some(pending.drain(..take).collect::<Vec<_>>())
                            }
                        };
                        match chunk {
                            Some(data) => {
                                // Append to the replay ring and deliver to the
                                // current desktop attachment as one ordered
                                // boundary. With no attachment, this still drains
                                // into the bounded ring for a replacement page.
                                session.record_and_send_desktop(data);
                            }
                            None => {
                                if session.eof.load(Ordering::SeqCst)
                                    || session.shutdown.load(Ordering::SeqCst)
                                {
                                    break;
                                }
                            }
                        }
                    }
                    // Reap the child so it never lingers as a zombie — but never
                    // let the tab's fate hang on it. A process can wedge partway
                    // through exit (macOS leaves it unreapable, and an agent CLI
                    // occasionally lands there on SIGTERM); a blocking wait()
                    // then holds back the pty:exit that closes a spent terminal
                    // and the session removal that frees the id — the terminal
                    // sits on screen forever, and a finished micro-task never
                    // closes itself. So poll for the status briefly, report the
                    // exit either way, and let a detached thread finish the reap.
                    let mut child = session.child.lock().unwrap().take();
                    let exit_code = child.as_mut().and_then(|c| {
                        let deadline = std::time::Instant::now() + REAP_WAIT;
                        loop {
                            match c.try_wait() {
                                Ok(Some(status)) => return Some(status.exit_code()),
                                Ok(None) if std::time::Instant::now() < deadline => {
                                    thread::sleep(Duration::from_millis(20));
                                }
                                _ => return None,
                            }
                        }
                    });
                    if exit_code.is_none() {
                        if let Some(mut c) = child {
                            thread::spawn(move || {
                                let _ = c.wait();
                            });
                        }
                    }
                    // Before the session leaves the map, so that a consumer
                    // woken by the pty:exit below can still read what ran.
                    reap_output(&reaped, session.id, &session);
                    sessions.lock().unwrap().remove(&session.id);
                    if let Some(containment) =
                        app.try_state::<crate::containment::ContainmentManager>()
                    {
                        containment.release(session.id);
                    }
                    // The terminal's bridge credential dies with it, and so do
                    // the advisory claims it was holding. Nothing used to watch
                    // for this: an agent that crashed mid-edit held its files
                    // against every other agent until a human noticed the row
                    // and pressed Release.
                    crate::context::release_claims_for_pty(&app, session.id);
                    let _ = app.emit(
                        "pty:exit",
                        PtyExit {
                            id: session.id,
                            session_generation: session.session_generation,
                            exit_code,
                            requested: session.shutdown.load(Ordering::SeqCst),
                        },
                    );
                })
                .expect("spawn pty flusher thread");
        }

        Ok(SpawnResult {
            id,
            session_generation,
            pid,
            cols,
            rows,
            generation,
        })
    }
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyManager>, id: u32, data: String) -> Result<(), String> {
    state.write(id, &data)
}

/// Attach the current desktop page to a PTY that survived its predecessor.
/// Unlike the remote viewer path above, this stream participates in bounded
/// backpressure and every ack is scoped to the returned attachment generation.
#[tauri::command]
pub fn pty_attach_desktop(
    state: State<'_, PtyManager>,
    id: u32,
    renderer_generation: u64,
    after: Option<u64>,
    on_data: Channel<InvokeResponseBody>,
) -> Result<DesktopAttachResult, String> {
    state.attach_desktop(id, renderer_generation, after, on_data)
}

/// Release a normal tab-close attachment without killing its remotely-owned
/// child. Generation matching prevents a late cleanup from an old component or
/// page from detaching the replacement stream.
#[tauri::command]
pub fn pty_detach_desktop(
    state: State<'_, PtyManager>,
    id: u32,
    renderer_generation: u64,
    generation: u64,
) -> Result<(), String> {
    if let Ok(session) = get_session(&state, id) {
        session.detach_matching(renderer_generation, generation);
    }
    Ok(())
}

/// First native handshake performed by each JavaScript page. It invalidates
/// the predecessor's PTY streams, closes browser child views whose React owners
/// disappeared with that page, and returns the live sessions to reconcile.
#[tauri::command]
pub fn pty_renderer_register(app: AppHandle, state: State<'_, PtyManager>) -> RendererRegistration {
    let registration = state.register_renderer();
    app.state::<crate::browser::BrowserManager>()
        .renderer_registered(&app, registration.generation);
    app.state::<Arc<crate::watchdog::WatchdogState>>()
        .renderer_registered(registration.generation);
    registration
}

/// Frontend ack after xterm.js consumes a chunk — releases backpressure.
#[tauri::command]
pub fn pty_ack(
    state: State<'_, PtyManager>,
    id: u32,
    renderer_generation: u64,
    generation: u64,
    bytes: usize,
) -> Result<(), String> {
    if let Ok(session) = get_session(&state, id) {
        session.acknowledge(renderer_generation, generation, bytes);
    }
    Ok(())
}

#[tauri::command]
/// Resize the pty, and report the size it actually took.
///
/// Sizes are clamped, not rejected: a hidden or zero-width container proposes 0
/// (or a NaN that arrives as 0), and a zero-column pty is meaningless — the
/// shell divides by it to lay out a line. Clamping keeps a tab that is resized
/// while hidden from poisoning the winsize.
pub fn pty_resize(
    state: State<'_, PtyManager>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<PtyGeometry, String> {
    let (cols, rows) = (cols.max(1), rows.max(1));
    let session = get_session(&state, id)?;
    session
        .master
        .lock()
        .unwrap()
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    // Mirror the new grid to any remote viewers so they re-size to match.
    session.record_resize(cols, rows);
    Ok(PtyGeometry { cols, rows })
}

/// Explicit development-only orphan reap. Normal renderer boot uses
/// `pty_renderer_register`, and release builds refuse this command so no UI path
/// can accidentally regain the old destructive blast radius.
#[tauri::command]
pub fn pty_dev_reap_all(state: State<'_, PtyManager>) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("PTY orphan reaping is available only in development builds".into());
    }
    state.kill_all();
    Ok(())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyManager>, id: u32) -> Result<(), String> {
    // Return at once and tear down on a detached thread. terminate() blocks for
    // up to GRACE (2.5s) waiting for the agent to flush its transcript before
    // the final SIGKILL — and this command runs on the main thread, so doing
    // that wait inline froze the whole UI on every tab close. The frontend
    // already drops the tab optimistically; the read loop still emits pty:exit
    // and reaps the session once the child actually exits. SIGTERM is delivered
    // synchronously inside terminate() before the grace poll, so the shell
    // starts shutting down immediately regardless of when this thread is
    // scheduled.
    state.kill(id)
}

#[tauri::command]
pub fn pty_set_title(state: State<'_, PtyManager>, id: u32, title: String) -> Result<(), String> {
    let session = get_session(&state, id)?;
    *session.title.lock().unwrap() = title;
    Ok(())
}

fn get_session(state: &State<'_, PtyManager>, id: u32) -> Result<Arc<Session>, String> {
    state
        .sessions
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no pty session {id}"))
}

fn default_shell() -> String {
    #[cfg(unix)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
}

/// Shell arguments that run a single command and make the shell exit with the
/// command's own status — the run-tab contract, expressed per shell rather than
/// with the Bourne-only `command; exit $?` idiom (which cmd.exe mis-parses,
/// handing `;`/`exit`/`$?` to the program as stray args). POSIX shells get
/// `-l -i -c` so the login + interactive env — PATH from `.zprofile`/`.zshrc`,
/// nvm, homebrew — matches a normal terminal; cmd.exe and PowerShell use their
/// own run-and-exit flags. The shell name is matched by file stem, so `cmd.exe`
/// and `pwsh.exe` resolve the same as bare `cmd` / `pwsh`.
fn run_args(shell: &str, command: &str) -> Vec<String> {
    let stem = std::path::Path::new(shell)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match stem.as_str() {
        "cmd" => vec!["/c".into(), command.into()],
        "powershell" | "pwsh" => {
            vec!["-NoLogo".into(), "-Command".into(), command.into()]
        }
        _ => vec!["-l".into(), "-i".into(), "-c".into(), command.into()],
    }
}

fn dirs_home() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
}

/// The read-only bootstrap Aider should inherit in a Canopy PTY. Explicit user
/// configuration always wins; a missing generated file means startup has not
/// installed it yet, so launching bare is safer than naming a nonexistent file.
fn canopy_aider_context(
    caller_set: bool,
    inherited: bool,
    home: Option<&str>,
) -> Option<std::path::PathBuf> {
    if caller_set || inherited {
        return None;
    }
    let path = crate::agent_instructions::context_path(home?);
    path.is_file().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn rust_owns_monotonic_session_ids_and_generations() {
        let manager = PtyManager::default();
        assert_eq!(manager.allocate_session_identity().unwrap(), (1, 1));
        assert_eq!(manager.allocate_session_identity().unwrap(), (2, 2));
        assert_eq!(manager.renderer_generation.load(Ordering::SeqCst), 0);
        manager.register_renderer();
        assert_eq!(manager.allocate_session_identity().unwrap(), (3, 3));
    }

    #[test]
    fn aider_gets_canopy_context_without_overriding_user_context() {
        let home =
            std::env::temp_dir().join(format!("canopy-aider-context-{}", std::process::id()));
        let path = crate::agent_instructions::install_context(&home).unwrap();
        let home_text = home.to_string_lossy();

        assert_eq!(
            canopy_aider_context(false, false, Some(&home_text)),
            Some(path.clone())
        );
        assert_eq!(canopy_aider_context(true, false, Some(&home_text)), None);
        assert_eq!(canopy_aider_context(false, true, Some(&home_text)), None);

        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(home.join(".canopy")).unwrap();
        std::fs::remove_dir(home).unwrap();
    }

    #[test]
    fn pending_ack_ledger_is_bounded_and_keeps_the_oldest_latency() {
        let mut ledger = PendingAckLedger::default();
        for sent in 0..(PENDING_ACK_BATCHES_MAX as u64 + 40) {
            ledger.record(1, sent);
        }
        assert_eq!(ledger.len(), PENDING_ACK_BATCHES_MAX);
        assert_eq!(ledger.acknowledge(1, 1_000), Some(1_000));
        assert_eq!(ledger.len(), PENDING_ACK_BATCHES_MAX - 1);

        let remaining = PENDING_ACK_BATCHES_MAX + 39;
        assert_eq!(ledger.acknowledge(remaining, 1_000), Some(999));
        assert_eq!(ledger.len(), 0);
        assert_eq!(ledger.acknowledge(1, 1_000), None);
    }

    /// Poll a session's scrollback until it contains `needle` or we time out.
    fn wait_for(pm: &PtyManager, id: u32, needle: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Some((_, _, snap, _)) = pm.attach(id) {
                if String::from_utf8_lossy(&snap).contains(needle) {
                    return true;
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
        false
    }

    // Regression: the whole output pipeline (spawn -> reader -> flusher ->
    // record_remote -> scrollback) must deliver a headless PTY's output, and a
    // headless PTY must not stall for lack of a WebView acker.
    #[test]
    fn spawn_headless_streams_output_and_does_not_stall() {
        let app = tauri::test::mock_app();
        let pm = PtyManager::default();
        let id = pm
            .spawn_headless(
                app.handle().clone(),
                Some("/tmp".into()),
                Some("echo REGRESS_MARKER".into()),
                None,
            )
            .expect("spawn");
        let seen = wait_for(&pm, id, "REGRESS_MARKER", Duration::from_secs(8));
        let _ = pm.kill(id);
        assert!(seen, "headless PTY output never reached the scrollback");
    }

    // A micro-task's PTY has no tab and no WebView channel, so the two things it
    // depends on are exactly these: the command runs with the env it was given
    // (CANOPY_MICRO_TASK is what marks the session one-shot), and its output is
    // readable afterwards from the session itself — that read is the only
    // transcript a task nobody watched ever gets.
    #[test]
    fn output_of_an_exited_session_is_still_readable() {
        // The order every one-shot consumer must use: wait for the process to
        // end, THEN read its output, because output is not complete until the
        // process is. Teardown removes the session before emitting pty:exit, so
        // that read used to land after the session was gone and return nothing
        // — a check or an install losing the output it ran for.
        let app = tauri::test::mock_app();
        let pm = PtyManager::default();
        let res = pm
            .spawn(
                app.handle().clone(),
                120,
                40,
                Some("/tmp".into()),
                None,
                None,
                Some(RunSpec::Argv(vec!["echo".into(), "REAPED_MARKER".into()])),
                SessionKind::Detached,
                None,
                None,
                None,
            )
            .expect("spawn");

        // Wait for the session to actually leave the live map, which is the
        // state the bug needed: reading while it is still alive proves nothing.
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        while pm.get(res.id).is_some() && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(pm.get(res.id).is_none(), "session never exited");

        let tail = pm
            .scrollback_tail(res.id, 64 * 1024)
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
        assert!(
            tail.contains("REAPED_MARKER"),
            "output was lost when the session was reaped. tail: {tail:?}"
        );
    }

    #[test]
    fn argv_spawn_never_lets_the_shell_see_its_arguments() {
        // The property the whole RunSpec::Argv branch exists for. A package name
        // or version reaching this boundary may contain anything; as an argument
        // it is inert, and as shell text `$HOME; whoami` would expand and then
        // run a second command. Asserting the LITERAL comes back is the only way
        // to tell those two apart from the outside.
        let app = tauri::test::mock_app();
        let pm = PtyManager::default();
        let hostile = "$HOME; whoami && echo pwned | tee /tmp/x";
        let res = pm
            .spawn(
                app.handle().clone(),
                120,
                40,
                Some("/tmp".into()),
                None,
                None,
                Some(RunSpec::Argv(vec![
                    "echo".into(),
                    format!("ARGV_{hostile}"),
                ])),
                SessionKind::Detached,
                None,
                None,
                None,
            )
            .expect("spawn");
        // `echo` exits immediately, so read after it has gone rather than
        // racing it — the retained output above is what makes that possible.
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        while pm.get(res.id).is_some() && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let tail = pm
            .scrollback_tail(res.id, 64 * 1024)
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
        let _ = pm.kill(res.id);
        // Exact equality, not `contains`. The hostile string necessarily
        // includes the word a shell would have printed, so "does pwned appear"
        // cannot distinguish the literal from an execution — it appears either
        // way. What DOES distinguish them is that a shell would have produced
        // MORE than this: `whoami`'s output, or a second echo. One line, equal
        // to the argument as written, is the whole property.
        assert_eq!(
            tail.trim_end_matches(['\r', '\n']),
            format!("ARGV_{hostile}"),
            "argv did not reach the process as one literal argument"
        );
    }

    #[test]
    fn argv_spawn_refuses_a_nameless_program() {
        // Goes through the real branch rather than re-checking the condition:
        // an assertion that restates the implementation proves only that it was
        // copied correctly.
        let app = tauri::test::mock_app();
        let pm = PtyManager::default();
        for argv in [Vec::<String>::new(), vec!["".into()]] {
            let result = pm.spawn(
                app.handle().clone(),
                120,
                40,
                Some("/tmp".into()),
                None,
                None,
                Some(RunSpec::Argv(argv.clone())),
                SessionKind::Detached,
                None,
                None,
                None,
            );
            if let Ok(res) = result {
                let _ = pm.kill(res.id);
                panic!("argv {argv:?} spawned a process instead of being refused");
            }
        }
    }

    #[test]
    fn detached_spawn_carries_env_and_its_output_is_readable() {
        let app = tauri::test::mock_app();
        let pm = PtyManager::default();
        let res = pm
            .spawn(
                app.handle().clone(),
                120,
                40,
                Some("/tmp".into()),
                None,
                None,
                // Prints, then stays up — an agent's shape, and the state the
                // tail is read in: a session that has exited is already gone
                // from the manager, scrollback and all.
                Some(RunSpec::Shell(
                    "echo DETACHED_$CANOPY_MICRO_TASK; sleep 20".into(),
                )),
                SessionKind::Detached,
                None,
                Some(vec![("CANOPY_MICRO_TASK".into(), "1".into())]),
                None,
            )
            .expect("spawn");
        let seen = wait_for(&pm, res.id, "DETACHED_1", Duration::from_secs(8));
        let tail = pm
            .scrollback_tail(res.id, 64 * 1024)
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
        let _ = pm.kill(res.id);
        assert!(
            seen,
            "detached PTY never ran its command with the given env"
        );
        assert!(tail.contains("DETACHED_1"), "tail was: {tail}");
    }

    #[test]
    fn reserved_task_identity_overrides_caller_env() {
        let app = tauri::test::mock_app();
        let pm = PtyManager::default();
        let res = pm
            .spawn(
                app.handle().clone(),
                120,
                40,
                Some("/tmp".into()),
                None,
                None,
                Some(RunSpec::Shell(
                    "echo TASK_${CANOPY_RUN_ID}_${CANOPY_ATTEMPT_ID}; sleep 20".into(),
                )),
                SessionKind::Detached,
                None,
                Some(vec![
                    ("CANOPY_RUN_ID".into(), "invented".into()),
                    ("CANOPY_ATTEMPT_ID".into(), "invented".into()),
                ]),
                Some(crate::tasks::AttemptBinding {
                    run_id: "run_reserved".into(),
                    attempt_id: "attempt_reserved".into(),
                }),
            )
            .expect("spawn");
        let seen = wait_for(
            &pm,
            res.id,
            "TASK_run_reserved_attempt_reserved",
            Duration::from_secs(8),
        );
        let _ = pm.kill(res.id);
        assert!(seen, "the reserved identity did not win over caller env");
    }

    // The question detaching a micro-task raises: an agent nobody is watching
    // may run for an hour and print megabytes, and it must not stall or die for
    // want of a viewer. A WebView-backed PTY applies backpressure and stops
    // reading once DEFAULT_HIGH_WATER (2MB) is outstanding and unacked; a
    // detached one has no acker, so that path must stay switched off for the
    // whole life of the run — not just at the start.
    //
    // Long by nature (a minute of real output), so it is not in the default run.
    // `cargo test -- --ignored detached_long_run` when the spawn path changes.
    #[test]
    #[ignore = "takes ~70s: a minute of real PTY output"]
    fn detached_long_run_keeps_streaming_past_the_high_water_mark() {
        let app = tauri::test::mock_app();
        let pm = PtyManager::default();
        // ~8KB every 100ms — past 2MB outstanding inside half a minute, which
        // is where a backpressured PTY would go quiet and the agent would wedge.
        let res = pm
            .spawn(
                app.handle().clone(),
                120,
                40,
                Some("/tmp".into()),
                None,
                None,
                Some(RunSpec::Shell(
                    "i=0; while [ $i -lt 600 ]; do i=$((i+1)); \
                     printf 'LINE_%s_%s\\n' $i \"$(head -c 8000 < /dev/zero | tr '\\0' 'x')\"; \
                     sleep 0.1; done"
                        .into(),
                )),
                SessionKind::Detached,
                None,
                Some(vec![("CANOPY_MICRO_TASK".into(), "1".into())]),
                None,
            )
            .expect("spawn");

        // Marker N is printed at roughly N/10 seconds in. Each wait starts from
        // now, so a stall anywhere along the way fails the step it stalled in
        // rather than being absorbed by an earlier one's slack.
        for (marker, secs) in [("LINE_50_", 15), ("LINE_250_", 30), ("LINE_550_", 40)] {
            assert!(
                wait_for(&pm, res.id, marker, Duration::from_secs(secs)),
                "detached PTY stopped producing output before {marker} \
                 (~{} bytes in)",
                marker.trim_start_matches("LINE_").trim_end_matches('_'),
            );
        }
        // Still readable at the end: this is what a finished task's transcript
        // is built from, and the ring keeps the tail rather than the head.
        let tail = pm
            .scrollback_tail(res.id, 8 * 1024)
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
        let _ = pm.kill(res.id);
        assert!(
            tail.contains("LINE_5"),
            "the tail should be recent output, got {} bytes",
            tail.len(),
        );
    }

    // Regression: input written to a PTY reaches the child (the desktop + remote
    // both drive input through PtyManager::write).
    #[test]
    fn write_reaches_the_child() {
        let app = tauri::test::mock_app();
        let pm = PtyManager::default();
        let id = pm
            .spawn_headless(app.handle().clone(), Some("/tmp".into()), None, None)
            .expect("spawn");
        thread::sleep(Duration::from_millis(400)); // let the shell come up
        pm.write(id, "echo WRITE_MARKER\r").expect("write");
        let seen = wait_for(&pm, id, "WRITE_MARKER", Duration::from_secs(8));
        let _ = pm.kill(id);
        assert!(seen, "written command output never appeared");
    }

    // Regression (hang, not crash): a child that has stopped reading its stdin
    // must not block the caller. `pty_write` is a synchronous Tauri command, so
    // the caller is the main/IPC thread — a blocking write to the master there
    // froze the whole app until the child read or died. Writes must return
    // promptly and eventually refuse, never sleep in the kernel.
    #[test]
    fn write_does_not_block_on_a_child_that_never_reads() {
        let app = tauri::test::mock_app();
        let pm = Arc::new(PtyManager::default());
        let id = pm
            .spawn_headless(app.handle().clone(), Some("/tmp".into()), None, None)
            .expect("spawn");
        thread::sleep(Duration::from_millis(400)); // let the shell come up

        // Foreground a process that reads nothing, with the tty in raw mode —
        // the state every agent CLI puts it in, and the one that matters: a
        // canonical-mode tty discards overflowing input, but a raw one applies
        // backpressure, so from here the buffer fills within about a kilobyte
        // and every further byte would block the writer.
        pm.write(id, "stty raw -echo; sleep 30\r").expect("write");
        thread::sleep(Duration::from_millis(400));

        // Off this thread, so a write that does block fails the test instead of
        // hanging it — and so the kill below can unwedge it either way.
        let (tx, rx) = std::sync::mpsc::channel();
        {
            let pm = pm.clone();
            thread::spawn(move || {
                let blob = "x".repeat(256 * 1024);
                // Ten times the queue bound: a session that keeps accepting this
                // is buffering without limit.
                for _ in 0..40 {
                    if pm.write(id, &blob).is_err() {
                        let _ = tx.send(true);
                        return;
                    }
                }
                let _ = tx.send(false);
            });
        }
        let outcome = rx.recv_timeout(Duration::from_secs(10));
        let _ = pm.kill(id);
        match outcome {
            Ok(true) => {}
            Ok(false) => panic!("queue grew without bound instead of refusing input"),
            Err(_) => panic!("pty write blocked — it is writing on the caller's thread"),
        }
    }

    // A fresh attach replays the scrollback so a late viewer sees prior output.
    #[test]
    fn attach_snapshot_carries_prior_output() {
        let app = tauri::test::mock_app();
        let pm = PtyManager::default();
        let id = pm
            .spawn_headless(
                app.handle().clone(),
                Some("/tmp".into()),
                Some("echo SNAPSHOT_MARKER".into()),
                None,
            )
            .expect("spawn");
        assert!(
            wait_for(&pm, id, "SNAPSHOT_MARKER", Duration::from_secs(8)),
            "no output"
        );
        // A brand-new attach (as pty_attach does) must still see it via snapshot.
        let (_c, _r, snap, _rx) = pm.attach(id).expect("attach");
        let _ = pm.kill(id);
        assert!(String::from_utf8_lossy(&snap).contains("SNAPSHOT_MARKER"));
    }

    #[test]
    fn renderer_replacement_preserves_process_and_scopes_acks_to_the_new_stream() {
        let app = tauri::test::mock_app();
        let pm = PtyManager::default();
        let first = pm.register_renderer();
        let first_bytes = Arc::new(Mutex::new(Vec::<u8>::new()));
        let first_sink = {
            let bytes = first_bytes.clone();
            Channel::new(move |body| {
                if let InvokeResponseBody::Raw(chunk) = body {
                    bytes.lock().unwrap().extend(chunk);
                }
                Ok(())
            })
        };
        let spawned = pm
            .spawn(
                app.handle().clone(),
                120,
                40,
                Some("/tmp".into()),
                None,
                Some(64 * 1024),
                None,
                SessionKind::Desktop,
                Some(DesktopSink {
                    renderer_generation: first.generation,
                    channel: first_sink,
                }),
                None,
                None,
            )
            .expect("desktop spawn");
        pm.write(spawned.id, "echo BEFORE_RELOAD\r")
            .expect("initial write");
        assert!(wait_for(
            &pm,
            spawned.id,
            "BEFORE_RELOAD",
            Duration::from_secs(8),
        ));
        let old_stream = spawned.generation.expect("desktop generation");

        let second = pm.register_renderer();
        let session = pm.get(spawned.id).expect("PTY survives renderer");
        assert!(session.desktop.lock().unwrap().is_none());
        assert_eq!(second.sessions.len(), 1);
        assert_eq!(second.sessions[0].kind, SessionKind::Desktop);

        // With no page attached, output still drains into the bounded native
        // ring instead of blocking at the old renderer's unacked window.
        pm.write(spawned.id, "echo AFTER_RELOAD\r")
            .expect("write after renderer loss");
        assert!(wait_for(
            &pm,
            spawned.id,
            "AFTER_RELOAD",
            Duration::from_secs(8),
        ));

        let replacement_bytes = Arc::new(Mutex::new(Vec::<u8>::new()));
        let replacement_sink = {
            let bytes = replacement_bytes.clone();
            Channel::new(move |body| {
                if let InvokeResponseBody::Raw(chunk) = body {
                    bytes.lock().unwrap().extend(chunk);
                }
                Ok(())
            })
        };
        let attached = pm
            .attach_desktop(spawned.id, second.generation, None, replacement_sink)
            .expect("replacement attach");
        assert!(
            String::from_utf8_lossy(&replacement_bytes.lock().unwrap()).contains("AFTER_RELOAD")
        );
        let before = session.desktop_outstanding();
        assert!(
            before > 0,
            "snapshot should await the replacement page's ack"
        );

        session.acknowledge(first.generation, old_stream, usize::MAX);
        assert_eq!(
            session.desktop_outstanding(),
            before,
            "stale page released the replacement page's backpressure"
        );
        session.acknowledge(second.generation, attached.generation, usize::MAX);
        assert_eq!(session.desktop_outstanding(), 0);

        // A second reload invalidates even a late attach attempt from page two.
        let third = pm.register_renderer();
        let stale = pm.attach_desktop(
            spawned.id,
            second.generation,
            None,
            Channel::new(|_| Ok(())),
        );
        assert!(stale.is_err());
        assert!(pm
            .attach_desktop(spawned.id, third.generation, None, Channel::new(|_| Ok(())),)
            .is_ok());
        let _ = pm.kill(spawned.id);
    }

    #[test]
    fn repeated_reload_navigation_and_failed_startup_keep_one_live_pty_identity() {
        let app = tauri::test::mock_app();
        let pm = PtyManager::default();
        let first = pm.register_renderer();
        let spawned = pm
            .spawn(
                app.handle().clone(),
                120,
                40,
                Some("/tmp".into()),
                None,
                Some(64 * 1024),
                None,
                SessionKind::Desktop,
                Some(DesktopSink {
                    renderer_generation: first.generation,
                    channel: Channel::new(|_| Ok(())),
                }),
                None,
                None,
            )
            .expect("desktop spawn");
        let original_pid = spawned.pid;
        let original_session_generation = spawned.session_generation;

        // Each registration represents a reload/navigation. Most intentionally
        // never attach, which is the renderer-startup-failure shape. Adjacent
        // registrations cover the double-reload race without real-time sleeps.
        let mut latest = first;
        for _ in 0..512 {
            latest = pm.register_renderer();
            let session = pm.get(spawned.id).expect("PTY survives every replacement");
            assert_eq!(session.pid, original_pid);
            assert_eq!(session.session_generation, original_session_generation);
            assert!(session.desktop.lock().unwrap().is_none());
            assert_eq!(latest.sessions.len(), 1);
            assert_eq!(latest.sessions[0].id, spawned.id);
            assert_eq!(
                latest.sessions[0].session_generation,
                original_session_generation
            );
        }

        pm.write(spawned.id, "echo REPLACEMENT_STRESS_MARKER\r")
            .expect("write while every renderer is detached");
        assert!(wait_for(
            &pm,
            spawned.id,
            "REPLACEMENT_STRESS_MARKER",
            Duration::from_secs(8),
        ));
        let replay = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink = {
            let replay = replay.clone();
            Channel::new(move |body| {
                if let InvokeResponseBody::Raw(chunk) = body {
                    replay.lock().unwrap().extend(chunk);
                }
                Ok(())
            })
        };
        pm.attach_desktop(spawned.id, latest.generation, None, sink)
            .expect("latest renderer reattaches");
        assert!(
            String::from_utf8_lossy(&replay.lock().unwrap()).contains("REPLACEMENT_STRESS_MARKER")
        );
        assert!(pm.get(spawned.id).is_some());
        let _ = pm.kill(spawned.id);
    }

    #[test]
    fn renderer_replacement_does_not_touch_remote_or_detached_sessions() {
        let app = tauri::test::mock_app();
        let pm = PtyManager::default();
        pm.register_renderer();
        let remote = pm
            .spawn_headless(app.handle().clone(), Some("/tmp".into()), None, None)
            .expect("remote spawn");
        let detached = pm
            .spawn(
                app.handle().clone(),
                120,
                40,
                Some("/tmp".into()),
                None,
                None,
                None,
                SessionKind::Detached,
                None,
                None,
                None,
            )
            .expect("detached spawn")
            .id;

        let replacement = pm.register_renderer();
        assert!(pm.get(remote).is_some());
        assert!(pm.get(detached).is_some());
        assert_eq!(
            replacement
                .sessions
                .iter()
                .find(|summary| summary.id == remote)
                .map(|summary| summary.kind),
            Some(SessionKind::Remote),
        );
        assert_eq!(
            replacement
                .sessions
                .iter()
                .find(|summary| summary.id == detached)
                .map(|summary| summary.kind),
            Some(SessionKind::Detached),
        );

        pm.write(remote, "echo REMOTE_AFTER_RELOAD\r").unwrap();
        pm.write(detached, "echo DETACHED_AFTER_RELOAD\r").unwrap();
        assert!(wait_for(
            &pm,
            remote,
            "REMOTE_AFTER_RELOAD",
            Duration::from_secs(8),
        ));
        assert!(wait_for(
            &pm,
            detached,
            "DETACHED_AFTER_RELOAD",
            Duration::from_secs(8),
        ));
        let _ = pm.kill(remote);
        let _ = pm.kill(detached);
    }

    #[test]
    fn truncated_replay_is_bounded_and_explicit() {
        let app = tauri::test::mock_app();
        let pm = PtyManager::default();
        let id = pm
            .spawn_headless(app.handle().clone(), Some("/tmp".into()), None, None)
            .expect("spawn");
        let session = pm.get(id).unwrap();
        session.record_remote(&vec![b'x'; SCROLLBACK_CAP + 37]);
        let registration = pm.register_renderer();
        let summary = registration
            .sessions
            .iter()
            .find(|summary| summary.id == id)
            .unwrap();
        assert!(summary.replay_start >= 37);
        assert_eq!(
            summary.replay_end - summary.replay_start,
            SCROLLBACK_CAP as u64
        );

        let replay = Arc::new(Mutex::new(Vec::new()));
        let sink = {
            let replay = replay.clone();
            Channel::new(move |body| {
                if let InvokeResponseBody::Raw(chunk) = body {
                    replay.lock().unwrap().extend(chunk);
                }
                Ok(())
            })
        };
        pm.attach_desktop(id, registration.generation, None, sink)
            .expect("attach");
        let replay = replay.lock().unwrap();
        assert!(replay.len() <= SCROLLBACK_CAP + DESKTOP_CHUNK_HEADER);
        assert_eq!(&replay[..4], DESKTOP_CHUNK_MAGIC);
        assert_ne!(replay[4] & DESKTOP_CHUNK_GAP, 0);
        assert_eq!(replay.len() - DESKTOP_CHUNK_HEADER, SCROLLBACK_CAP);
        let _ = pm.kill(id);
    }

    #[test]
    fn reattach_cursor_replays_only_bytes_received_while_hidden() {
        let app = tauri::test::mock_app();
        let pm = PtyManager::default();
        let id = pm
            .spawn(
                app.handle().clone(),
                120,
                40,
                Some("/tmp".into()),
                None,
                None,
                Some(RunSpec::Argv(vec!["sleep".into(), "20".into()])),
                SessionKind::Detached,
                None,
                None,
                None,
            )
            .expect("spawn")
            .id;
        let session = pm.get(id).unwrap();
        // Isolate the cursor contract from shell startup noise.
        {
            session.scrollback.lock().unwrap().clear();
            session.output_bytes.store(0, Ordering::Relaxed);
            session.dropped_output_bytes.store(0, Ordering::Relaxed);
        }
        session.record_remote(b"before-hidden-after");
        let registration = pm.register_renderer();
        let replay = Arc::new(Mutex::new(Vec::new()));
        let sink = {
            let replay = replay.clone();
            Channel::new(move |body| {
                if let InvokeResponseBody::Raw(chunk) = body {
                    replay.lock().unwrap().extend(chunk);
                }
                Ok(())
            })
        };
        pm.attach_desktop(id, registration.generation, Some(14), sink)
            .expect("incremental attach");
        let replay = replay.lock().unwrap();
        assert_eq!(&replay[..4], DESKTOP_CHUNK_MAGIC);
        assert_eq!(replay[4] & DESKTOP_CHUNK_GAP, 0);
        assert_eq!(u64::from_le_bytes(replay[8..16].try_into().unwrap()), 14);
        assert_eq!(&replay[DESKTOP_CHUNK_HEADER..], b"after");
        let _ = pm.kill(id);
    }

    #[test]
    fn attach_snapshot_and_live_boundary_has_no_gap_or_overlap() {
        use std::sync::Barrier;

        let app = tauri::test::mock_app();
        let pm = PtyManager::default();
        let id = pm
            .spawn(
                app.handle().clone(),
                120,
                40,
                Some("/tmp".into()),
                None,
                None,
                Some(RunSpec::Argv(vec!["sleep".into(), "20".into()])),
                SessionKind::Detached,
                None,
                None,
                None,
            )
            .expect("spawn")
            .id;
        let session = pm.get(id).unwrap();
        {
            session.scrollback.lock().unwrap().clear();
            session.output_bytes.store(0, Ordering::Relaxed);
            session.dropped_output_bytes.store(0, Ordering::Relaxed);
        }
        session.record_remote(b"seed");
        let registration = pm.register_renderer();
        let frames = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let sink = {
            let frames = frames.clone();
            Channel::new(move |body| {
                if let InvokeResponseBody::Raw(frame) = body {
                    frames.lock().unwrap().push(frame);
                }
                Ok(())
            })
        };

        let barrier = Arc::new(Barrier::new(2));
        let producer_session = session.clone();
        let producer_barrier = barrier.clone();
        let producer = thread::spawn(move || {
            producer_barrier.wait();
            for value in 0_u32..500 {
                producer_session.record_and_send_desktop(value.to_le_bytes().to_vec());
            }
        });
        barrier.wait();
        pm.attach_desktop(id, registration.generation, None, sink)
            .expect("attach at producer boundary");
        producer.join().unwrap();

        let mut expected = b"seed".to_vec();
        for value in 0_u32..500 {
            expected.extend_from_slice(&value.to_le_bytes());
        }
        let mut actual = Vec::new();
        let mut cursor = 0_u64;
        for frame in frames.lock().unwrap().iter() {
            assert_eq!(&frame[..4], DESKTOP_CHUNK_MAGIC);
            let start = u64::from_le_bytes(frame[8..16].try_into().unwrap());
            assert_eq!(start, cursor, "frame range overlapped or skipped output");
            let payload = &frame[DESKTOP_CHUNK_HEADER..];
            actual.extend_from_slice(payload);
            cursor += payload.len() as u64;
        }
        assert_eq!(actual, expected);
        let _ = pm.kill(id);
    }

    // Regression: kill tears the session down (no leaked child / map entry).
    #[test]
    fn kill_removes_the_session() {
        let app = tauri::test::mock_app();
        let pm = PtyManager::default();
        let id = pm
            .spawn_headless(app.handle().clone(), Some("/tmp".into()), None, None)
            .expect("spawn");
        assert!(pm.get(id).is_some());
        pm.kill(id).expect("kill");
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline && pm.get(id).is_some() {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(pm.get(id).is_none(), "session not removed after kill");
    }

    #[test]
    fn kill_marks_exit_requested_before_teardown_thread_runs() {
        let app = tauri::test::mock_app();
        let pm = PtyManager::default();
        let id = pm
            .spawn_headless(app.handle().clone(), Some("/tmp".into()), None, None)
            .expect("spawn");
        let session = pm.get(id).expect("session");
        pm.kill(id).expect("kill");
        assert!(session.shutdown.load(Ordering::SeqCst));
    }
}
