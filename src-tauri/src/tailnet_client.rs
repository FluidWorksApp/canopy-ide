//! Terminals on another machine of this tailnet, opened here as ordinary tabs.
//!
//! The webview only ever sends a stable node id. This side turns it into a
//! machine through the Tailscale status, dials it with `TailnetTcp::connect`
//! (which whois-pins the node by name; the answer is pinned again by stable id
//! here) and speaks the session protocol (`canopy_term_net::session`) to the
//! other machine's Canopy app, which is the side that listens.
//!
//! An opened terminal is a *proxy session* in the local `PtyManager`: a
//! `MasterPty` that is not a local tty (the same pattern `pty_hosted` uses with
//! `HostMaster`), a reader fed by the attached connection and a writer that
//! sends keystrokes back. `Term.tsx` attaches to it like to any pty. It has no
//! local process (`pid` is None), so no signal is ever sent from here, the
//! process monitor skips it, and killing it only lets go of the link.
//!
//! A connection is either control or attached (see the session module), so a
//! second, control connection carries resize, dialled lazily and redialled
//! when the host's idle limit closes it.
//!
//! A dropped attached connection is retried with a 1/2/4/8/16/30 s backoff and
//! given up after five minutes (state `lost`, `tailnet_remote_reconnect`
//! restarts it). Typing is dropped, not queued, while the link is down. Every
//! reattach starts with a terminal reset and then the host's snapshot, so the
//! tab shows what the host still holds instead of the old scrollback with the
//! snapshot pasted after it.
//!
//! What a failure may say: only `tailscale_off`, `older_canopy` or `refused`
//! ever reaches the webview. A peer that does not answer, does not listen or
//! turned us away are all `refused`, so a stranger learns nothing about whether
//! Allow is on over there.

use crate::pty::{ProxyLink, ProxyParts, PtyManager};
use canopy_term_net::allowlist::{valid_stable_id, Allowlist};
use canopy_term_net::session::{AttachedStream, SessionClient, SessionError, SessionSummary};
use canopy_term_net::tailnet_tcp::TailnetTcp;
use canopy_term_net::tailscale::{CliRunner, Tailscale};
use canopy_term_net::{Connection, PeerIdentity, Transport};
use portable_pty::{Child, ChildKiller, ExitStatus, MasterPty, PtySize};
use serde::Serialize;
use std::collections::BTreeSet;
use std::io::{self, Read, Write};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// The port the other machine's app listens on, shared with the listener.
pub const SESSION_PORT: u16 = crate::tailnet::TAILNET_SESSION_PORT;

/// The event the webview listens to (`TailnetRemoteState` in `ipc.ts`).
pub const STATE_EVENT: &str = "tailnet:remote_state";

/// Written to the proxy's output before the host's snapshot on every reattach:
/// a full terminal reset, so the snapshot replaces the old screen and
/// scrollback instead of being appended to it.
pub const RESET: &[u8] = b"\x1bc";

/// Output chunks waiting between the attached connection and the session's
/// reader thread. When full the connection is not read, so a busy remote
/// terminal waits in TCP, as a local one waits in its kernel buffer.
const OUTPUT_CHUNKS: usize = 64;

/// How long the resize worker waits before it dials again after a failure.
const RESIZE_REDIAL: Duration = Duration::from_secs(2);

// ---------------------------------------------------------------------------
// Errors

/// Why a call failed, as far as the webview may know.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientError {
    /// Tailscale is not installed, not running or not usable here.
    TailscaleOff,
    /// The other machine's Canopy speaks an older session protocol.
    OlderCanopy,
    /// Anything else: no listener, a refusal, a silent peer, a gone terminal.
    Refused,
}

impl ClientError {
    /// The rejection string `ipc.ts` maps to a state.
    pub fn code(self) -> &'static str {
        match self {
            ClientError::TailscaleOff => "tailscale_off",
            ClientError::OlderCanopy => "older_canopy",
            ClientError::Refused => "refused",
        }
    }
}

/// How one connection attempt failed, with the detail a live link needs and a
/// first connect must not show.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Failure {
    Off,
    Older,
    /// The peer took the connection and closed it without a word: what a
    /// listener does with a machine it will not serve.
    Silent,
    Other,
}

impl Failure {
    fn into_error(self) -> ClientError {
        match self {
            Failure::Off => ClientError::TailscaleOff,
            Failure::Older => ClientError::OlderCanopy,
            Failure::Silent | Failure::Other => ClientError::Refused,
        }
    }
}

// ---------------------------------------------------------------------------
// Reaching a machine

/// A machine of this tailnet, as the Tailscale status lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Remote {
    pub stable_id: String,
    /// Display name, for tab titles.
    pub name: String,
    pub dns_name: String,
}

/// Turns a stable id into a machine and dials it. A trait so tests can reach a
/// loopback server and sever the route on demand.
pub trait Dial: Send + Sync {
    fn resolve(&self, stable_id: &str) -> Result<Remote, ClientError>;
    fn dial(&self, remote: &Remote) -> io::Result<Box<dyn Connection>>;
}

/// The real route: the installed Tailscale's own status and whois, through
/// `TailnetTcp`.
pub struct TailnetDial {
    runner: Arc<dyn CliRunner>,
    port: u16,
}

impl TailnetDial {
    pub fn new(runner: Arc<dyn CliRunner>, port: u16) -> Self {
        Self { runner, port }
    }

    /// With the Tailscale installed on this machine; none means it is off.
    pub fn installed(port: u16) -> Result<Self, ClientError> {
        crate::tailnet::installed_runner()
            .map(|runner| Self::new(runner, port))
            .map_err(|_| ClientError::TailscaleOff)
    }
}

impl Dial for TailnetDial {
    fn resolve(&self, stable_id: &str) -> Result<Remote, ClientError> {
        if !valid_stable_id(stable_id) {
            return Err(ClientError::Refused);
        }
        let status = Tailscale::new(self.runner.clone())
            .running_status()
            .map_err(|_| ClientError::TailscaleOff)?;
        let domain = crate::tailnet::own_domain(&status);
        let peer = status
            .peers
            .iter()
            .filter(|p| crate::tailnet::in_tailnet(p, domain.as_deref()))
            .find(|p| p.stable_id.as_deref() == Some(stable_id))
            .ok_or(ClientError::Refused)?;
        Ok(Remote {
            stable_id: stable_id.to_string(),
            name: crate::tailnet::machine(peer, &BTreeSet::new()).name,
            dns_name: peer.dns_name.clone(),
        })
    }

    fn dial(&self, remote: &Remote) -> io::Result<Box<dyn Connection>> {
        let transport = TailnetTcp::client(self.runner.clone(), Allowlist::new());
        let conn = transport.connect(&format!("{}:{}", remote.dns_name, self.port))?;
        // The transport pins the node by the name it was given; the name could
        // have moved to another node between the status read above and its
        // own, so the node it vouched for is checked against the id asked for.
        let pinned = matches!(
            conn.peer(),
            PeerIdentity::Device(entry)
                if crate::tailnet::entry_stable_id(entry).as_deref()
                    == Some(remote.stable_id.as_str())
        );
        if pinned {
            Ok(conn)
        } else {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the node dialled is not the one asked for",
            ))
        }
    }
}

/// A connection to `remote` with the hello done.
fn connect_to(dial: &dyn Dial, remote: &Remote) -> Result<SessionClient, Failure> {
    let conn = dial.dial(remote).map_err(|e| {
        if e.kind() == io::ErrorKind::NotConnected {
            Failure::Off
        } else {
            Failure::Other
        }
    })?;
    SessionClient::connect(conn).map_err(|e| match e {
        // Only a peer older than this build is "older"; a newer one has no
        // approved text, so it reads as any other refusal.
        SessionError::VersionMismatch { local, remote } if remote < local => Failure::Older,
        SessionError::Closed => Failure::Silent,
        // A listener that turns a machine away closes with the hello unread,
        // which the dialler can see as a reset as well as a plain close.
        SessionError::Io(e)
            if matches!(
                e.kind(),
                io::ErrorKind::ConnectionReset
                    | io::ErrorKind::ConnectionAborted
                    | io::ErrorKind::BrokenPipe
                    | io::ErrorKind::UnexpectedEof
            ) =>
        {
            Failure::Silent
        }
        _ => Failure::Other,
    })
}

fn connect_client(dial: &dyn Dial, stable_id: &str) -> Result<SessionClient, Failure> {
    let remote = dial.resolve(stable_id).map_err(|e| match e {
        ClientError::TailscaleOff => Failure::Off,
        _ => Failure::Other,
    })?;
    connect_to(dial, &remote)
}

// ---------------------------------------------------------------------------
// What the webview sees

/// One row of `tailnet_remote_list` (`TailnetRemoteTerminal` in `ipc.ts`).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTerminal {
    pub remote_id: u32,
    pub title: String,
    pub cwd: String,
    pub command: Option<String>,
    pub status: &'static str,
    pub exit_code: Option<i32>,
}

impl From<SessionSummary> for RemoteTerminal {
    fn from(s: SessionSummary) -> Self {
        RemoteTerminal {
            remote_id: s.id,
            title: s.title,
            cwd: s.cwd.unwrap_or_default(),
            command: (!s.command.is_empty()).then_some(s.command),
            status: if s.running { "running" } else { "exited" },
            exit_code: s.exit_code,
        }
    }
}

/// The result of `tailnet_remote_open` (`TailnetRemoteOpened` in `ipc.ts`).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub pty_id: u32,
    pub session_generation: u64,
    pub cwd: String,
    /// The remote terminal's own title. The tab strip puts `<machine>:` in
    /// front; the session's title in the local `PtyManager` already has it.
    pub title: String,
    pub machine: String,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Connected,
    Reconnecting,
    Lost,
    Revoked,
    Ended,
}

/// The payload of `tailnet:remote_state` (`TailnetRemoteState` in `ipc.ts`).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StateEvent {
    pub pty_id: u32,
    pub stable_id: String,
    pub state: State,
    pub attempt: Option<u32>,
    pub exit_code: Option<i32>,
}

type Sink = Arc<dyn Fn(StateEvent) + Send + Sync>;

// ---------------------------------------------------------------------------
// The link

/// How patient a link is. The defaults are the contract; tests shrink them.
#[derive(Clone, Debug)]
pub struct Timing {
    /// Wait before reconnect attempt n (the last entry repeats).
    pub backoff: Vec<Duration>,
    /// How long after a drop the link keeps trying before it is `lost`.
    pub give_up: Duration,
    /// Minimum spacing of resizes sent to the host (it rate limits at 100 ms).
    pub resize_pace: Duration,
    /// Consecutive attempts the peer must answer with silence before the link
    /// is `revoked`. More than one, so a hiccup of the other app is not read
    /// as having been turned away, which closes the tab.
    pub silent_to_revoke: u32,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            backoff: [1, 2, 4, 8, 16, 30]
                .iter()
                .map(|s| Duration::from_secs(*s))
                .collect(),
            give_up: Duration::from_secs(5 * 60),
            resize_pace: Duration::from_millis(110),
            silent_to_revoke: 2,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Connected,
    Reconnecting,
    Lost,
}

struct Inner {
    phase: Phase,
    /// The link is over (closed, ended or revoked); nothing more is sent.
    finished: bool,
    exit_code: Option<u32>,
    want_reconnect: bool,
    /// The grid last asked for (or opened with).
    size: (u16, u16),
    /// Set once the user's window has asked for a size.
    size_asked: bool,
    /// Counts attachments, so a size is sent again after a reattach.
    attach_gen: u64,
}

/// The current attachment's writer. Shared, so a write stuck on a dead
/// connection holds only that connection's lock, never the slot.
type WriterSlot = Mutex<Option<Arc<Mutex<Box<dyn Write + Send>>>>>;

pub struct Link {
    pty_id: u32,
    stable_id: String,
    remote_id: u32,
    /// What the remote terminal runs, to tell it from another one that took
    /// its id after the other app restarted.
    command: String,
    dial: Arc<dyn Dial>,
    sink: Sink,
    timing: Timing,
    inner: Mutex<Inner>,
    cv: Condvar,
    writer: WriterSlot,
}

impl std::fmt::Debug for Link {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The machine is deliberately not printed.
        write!(f, "Link({})", self.pty_id)
    }
}

enum Attempt {
    Attached(AttachedStream),
    Gone(Option<i32>),
    Silent,
    Retry,
}

enum Recovery {
    Attached(AttachedStream),
    Gone(Option<i32>),
    Revoked,
    Closed,
}

impl Link {
    #[allow(clippy::too_many_arguments)]
    fn new(
        pty_id: u32,
        stable_id: &str,
        remote_id: u32,
        command: String,
        dial: Arc<dyn Dial>,
        sink: Sink,
        timing: Timing,
        size: (u16, u16),
    ) -> Self {
        Link {
            pty_id,
            stable_id: stable_id.to_string(),
            remote_id,
            command,
            dial,
            sink,
            timing,
            inner: Mutex::new(Inner {
                phase: Phase::Connected,
                finished: false,
                exit_code: None,
                want_reconnect: false,
                size,
                size_asked: false,
                attach_gen: 0,
            }),
            cv: Condvar::new(),
            writer: Mutex::new(None),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn emit(&self, state: State, attempt: Option<u32>, exit_code: Option<i32>) {
        (self.sink)(StateEvent {
            pty_id: self.pty_id,
            stable_id: self.stable_id.clone(),
            state,
            attempt,
            exit_code,
        });
    }

    fn phase(&self) -> Phase {
        self.lock().phase
    }

    fn is_finished(&self) -> bool {
        self.lock().finished
    }

    /// End the link. The first call wins; later ones change nothing.
    fn finish(&self, exit_code: Option<u32>) {
        {
            let mut g = self.lock();
            if g.finished {
                return;
            }
            g.finished = true;
            g.exit_code = exit_code;
        }
        // Let go of the attached connection: the host sees our input end and
        // closes its side, which ends the pump's read.
        *self.writer.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.cv.notify_all();
    }

    fn exit_status(&self) -> Option<ExitStatus> {
        let g = self.lock();
        g.finished
            .then(|| ExitStatus::with_exit_code(g.exit_code.unwrap_or(0)))
    }

    /// Sleep up to `d`; true when the link finished meanwhile.
    fn sleep(&self, d: Duration) -> bool {
        let deadline = Instant::now() + d;
        let mut g = self.lock();
        loop {
            if g.finished {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            g = self
                .cv
                .wait_timeout(g, deadline - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    /// Wait until a reconnect is asked for (true) or the link finishes (false).
    fn wait_reconnect(&self) -> bool {
        let mut g = self.lock();
        loop {
            if g.finished {
                return false;
            }
            if g.want_reconnect {
                g.want_reconnect = false;
                return true;
            }
            g = self.cv.wait(g).unwrap_or_else(|e| e.into_inner());
        }
    }

    fn set_phase(&self, phase: Phase) {
        self.lock().phase = phase;
        self.cv.notify_all();
    }

    /// A fresh attached connection: input flows again.
    fn install(&self, writer: Box<dyn Write + Send>) {
        if self.is_finished() {
            return;
        }
        *self.writer.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(Mutex::new(writer)));
        {
            let mut g = self.lock();
            g.phase = Phase::Connected;
            g.attach_gen += 1;
        }
        self.cv.notify_all();
    }

    fn clear_writer(&self) {
        *self.writer.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// The window asked for a grid.
    fn ask_size(&self, cols: u16, rows: u16) {
        {
            let mut g = self.lock();
            g.size = (cols, rows);
            g.size_asked = true;
        }
        self.cv.notify_all();
    }

    fn size(&self) -> (u16, u16) {
        self.lock().size
    }

    /// One try at reaching the terminal again.
    fn attempt(&self) -> Attempt {
        let remote = match self.dial.resolve(&self.stable_id) {
            Ok(r) => r,
            Err(_) => return Attempt::Retry,
        };
        let mut client = match connect_to(&*self.dial, &remote) {
            Ok(c) => c,
            Err(Failure::Silent) => return Attempt::Silent,
            Err(_) => return Attempt::Retry,
        };
        let listed = match client.list() {
            Ok(l) => l,
            Err(_) => return Attempt::Retry,
        };
        // The id alone is not an identity: after the other app restarted its
        // terminals are numbered again. The command is the one thing that does
        // not change over a terminal's life; a different one is a different
        // terminal.
        match listed.iter().find(|s| s.id == self.remote_id) {
            None => return Attempt::Gone(None),
            Some(s) if s.command != self.command => return Attempt::Gone(None),
            Some(s) if !s.running => return Attempt::Gone(s.exit_code),
            Some(_) => {}
        }
        match client.attach(self.remote_id) {
            Ok(stream) => Attempt::Attached(stream),
            Err(SessionError::NotFound) => Attempt::Gone(None),
            Err(_) => Attempt::Retry,
        }
    }

    /// The attached connection ended: find out whether the terminal did, or
    /// the link, and in that case win it back, with the backoff and the give-up
    /// the contract names. Returns when there is an answer or the link is over.
    fn recover(&self) -> Recovery {
        let mut silent: u32 = 0;
        // The first look is immediate and silent: a remote process that just
        // exited should read as ended, not as a flash of "reconnecting".
        if let Some(done) = self.judge(self.attempt(), &mut silent) {
            return done;
        }
        loop {
            let started = Instant::now();
            let mut failed: usize = 0;
            loop {
                if self.is_finished() {
                    return Recovery::Closed;
                }
                let attempt_no = failed as u32 + 1;
                self.set_phase(Phase::Reconnecting);
                self.emit(State::Reconnecting, Some(attempt_no), None);
                let remaining = self.timing.give_up.saturating_sub(started.elapsed());
                if remaining.is_zero() {
                    break;
                }
                let last = self.timing.backoff.len().saturating_sub(1);
                let wait = self
                    .timing
                    .backoff
                    .get(failed.min(last))
                    .copied()
                    .unwrap_or(Duration::from_secs(30));
                if self.sleep(wait.min(remaining)) {
                    return Recovery::Closed;
                }
                if started.elapsed() >= self.timing.give_up {
                    break;
                }
                if let Some(done) = self.judge(self.attempt(), &mut silent) {
                    return done;
                }
                failed += 1;
            }
            // Out of patience: say so and wait to be asked again.
            self.set_phase(Phase::Lost);
            self.emit(State::Lost, None, None);
            if !self.wait_reconnect() {
                return Recovery::Closed;
            }
            silent = 0;
        }
    }

    fn judge(&self, attempt: Attempt, silent: &mut u32) -> Option<Recovery> {
        match attempt {
            Attempt::Attached(stream) => Some(Recovery::Attached(stream)),
            Attempt::Gone(code) => Some(Recovery::Gone(code)),
            Attempt::Silent => {
                *silent += 1;
                (*silent >= self.timing.silent_to_revoke).then_some(Recovery::Revoked)
            }
            Attempt::Retry => {
                *silent = 0;
                None
            }
        }
    }
}

impl ProxyLink for Link {
    fn close(&self) {
        self.finish(None);
    }

    fn reconnect(&self) {
        {
            let mut g = self.lock();
            if g.finished || g.phase != Phase::Lost {
                return;
            }
            g.want_reconnect = true;
        }
        self.cv.notify_all();
    }
}

/// Ends the link however the pump thread ends, a panic included, so the
/// session never hangs waiting for an exit that cannot come.
struct FinishOnDrop(Arc<Link>);

impl Drop for FinishOnDrop {
    fn drop(&mut self) {
        self.0.finish(None);
    }
}

/// Carries one attached connection after another into the session's output.
fn pump(link: Arc<Link>, first: AttachedStream, tx: mpsc::SyncSender<Vec<u8>>) {
    let _finish = FinishOnDrop(link.clone());
    let mut stream = first;
    let mut reattached = false;
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let AttachedStream {
            mut reader, writer, ..
        } = stream;
        link.install(writer);
        if reattached {
            // The snapshot that follows replaces the screen, it is not added
            // to it. Typing flows again from here.
            if tx.send(RESET.to_vec()).is_err() {
                return;
            }
            link.emit(State::Connected, None, None);
        }
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if link.is_finished() {
                        return;
                    }
                    if tx.send(buf[..n].to_vec()).is_err() {
                        return;
                    }
                }
            }
        }
        drop(reader);
        link.clear_writer();
        if link.is_finished() {
            return;
        }
        match link.recover() {
            Recovery::Attached(next) => {
                stream = next;
                reattached = true;
            }
            Recovery::Gone(code) => {
                // The exit code is known to the host only while the terminal
                // is listed; it is passed on when it is.
                link.finish(code.map(|c| c.max(0) as u32));
                link.emit(State::Ended, None, code);
                return;
            }
            Recovery::Revoked => {
                link.finish(None);
                link.emit(State::Revoked, None, None);
                return;
            }
            Recovery::Closed => return,
        }
    }
}

/// Sends the window's size to the host over a control connection, coalescing:
/// only the latest size is ever sent, no faster than the host accepts.
fn resize_worker(link: Arc<Link>) {
    let mut control: Option<SessionClient> = None;
    // What the host was last told, and on which attachment.
    let mut sent: Option<((u16, u16), u64)> = None;
    loop {
        let (size, generation) = {
            let mut g = link.lock();
            loop {
                if g.finished {
                    return;
                }
                if g.size_asked
                    && g.phase == Phase::Connected
                    && sent != Some((g.size, g.attach_gen))
                {
                    break (g.size, g.attach_gen);
                }
                g = link.cv.wait(g).unwrap_or_else(|e| e.into_inner());
            }
        };
        if control.is_none() {
            match connect_client(&*link.dial, &link.stable_id) {
                Ok(c) => control = Some(c),
                Err(_) => {
                    if link.sleep(RESIZE_REDIAL) {
                        return;
                    }
                    continue;
                }
            }
        }
        let result = match control.as_mut() {
            Some(c) => c.resize(link.remote_id, size.0, size.1),
            None => continue,
        };
        match result {
            Ok(()) | Err(SessionError::NotFound) => {
                sent = Some((size, generation));
                if link.sleep(link.timing.resize_pace) {
                    return;
                }
            }
            Err(SessionError::RateLimited) => {
                if link.sleep(link.timing.resize_pace) {
                    return;
                }
            }
            Err(_) => {
                // The host closes an idle control connection; dial again.
                control = None;
                if link.sleep(link.timing.resize_pace) {
                    return;
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The proxy pty

/// The session's reader: whatever the pump delivers, until the link is over.
///
/// It also ends when the link is finished, whether or not the pump has noticed
/// yet: closing a tab must not wait for the other machine to hang up. What the
/// pump already queued is still delivered first.
struct ProxyReader {
    link: Arc<Link>,
    rx: mpsc::Receiver<Vec<u8>>,
    buf: Vec<u8>,
    pos: usize,
}

impl Read for ProxyReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        while self.pos >= self.buf.len() {
            let next = match self.rx.recv_timeout(Duration::from_millis(100)) {
                Ok(chunk) => Some(chunk),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if self.link.is_finished() {
                        // Whatever is still queued, then the end.
                        match self.rx.try_recv() {
                            Ok(chunk) => Some(chunk),
                            Err(_) => return Ok(0),
                        }
                    } else {
                        None
                    }
                }
                // The pump is gone and so is the link: end of output.
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(0),
            };
            if let Some(chunk) = next {
                self.buf = chunk;
                self.pos = 0;
            }
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

/// The session's writer. It never fails: the session's writer thread ends for
/// good on the first error, and a link that is down is not an error to the
/// terminal. Input arriving while the link is down is dropped, not queued, so
/// nothing typed minutes ago is sent to a shell when the link returns.
struct ProxyWriter {
    link: Arc<Link>,
}

impl Write for ProxyWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.link.phase() != Phase::Connected {
            return Ok(buf.len());
        }
        let current = self
            .link
            .writer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(writer) = current {
            let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
            // A failure means the link dropped; the pump notices on its read.
            let _ = w.write_all(buf).and_then(|_| w.flush());
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A master that is not a local tty. It has no fd, no process group and no
/// termios, which is what keeps every local-process feature (signals, the
/// foreground job, raw-mode sniffing) away from it.
struct ProxyMaster {
    link: Arc<Link>,
}

impl MasterPty for ProxyMaster {
    fn resize(&self, size: PtySize) -> anyhow::Result<()> {
        self.link.ask_size(size.cols, size.rows);
        Ok(())
    }

    fn get_size(&self) -> anyhow::Result<PtySize> {
        let (cols, rows) = self.link.size();
        Ok(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
    }

    fn try_clone_reader(&self) -> anyhow::Result<Box<dyn Read + Send>> {
        Err(anyhow::anyhow!(
            "a remote terminal's reader is fixed at creation"
        ))
    }

    fn take_writer(&self) -> anyhow::Result<Box<dyn Write + Send>> {
        Err(anyhow::anyhow!(
            "a remote terminal's writer is fixed at creation"
        ))
    }

    #[cfg(unix)]
    fn process_group_leader(&self) -> Option<libc::pid_t> {
        None
    }

    #[cfg(unix)]
    fn as_raw_fd(&self) -> Option<std::os::unix::io::RawFd> {
        None
    }

    #[cfg(unix)]
    fn tty_name(&self) -> Option<std::path::PathBuf> {
        None
    }
}

/// Killing a proxy lets go of the link and nothing else.
#[derive(Debug)]
struct ProxyKiller {
    link: Arc<Link>,
}

impl ChildKiller for ProxyKiller {
    fn kill(&mut self) -> io::Result<()> {
        self.link.finish(None);
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(ProxyKiller {
            link: self.link.clone(),
        })
    }
}

#[derive(Debug)]
struct ProxyChild {
    link: Arc<Link>,
}

impl ChildKiller for ProxyChild {
    fn kill(&mut self) -> io::Result<()> {
        self.link.finish(None);
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(ProxyKiller {
            link: self.link.clone(),
        })
    }
}

impl Child for ProxyChild {
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        Ok(self.link.exit_status())
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        loop {
            if let Some(status) = self.link.exit_status() {
                return Ok(status);
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn process_id(&self) -> Option<u32> {
        None
    }

    #[cfg(windows)]
    fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        None
    }
}

// ---------------------------------------------------------------------------
// Operations

/// The other machine's terminals, for the Settings row.
pub fn list_remote(dial: &dyn Dial, stable_id: &str) -> Result<Vec<RemoteTerminal>, ClientError> {
    let mut client = connect_client(dial, stable_id).map_err(Failure::into_error)?;
    let listed = client.list().map_err(|_| ClientError::Refused)?;
    Ok(listed.into_iter().map(RemoteTerminal::from).collect())
}

/// Open one of the other machine's terminals as a proxy session in `pty`.
pub fn open<R: tauri::Runtime>(
    app: &AppHandle<R>,
    pty: &PtyManager,
    dial: Arc<dyn Dial>,
    stable_id: &str,
    remote_id: u32,
) -> Result<Opened, ClientError> {
    let events = app.clone();
    let sink: Sink = Arc::new(move |event: StateEvent| {
        let _ = events.emit(STATE_EVENT, event);
    });
    open_with(
        app,
        pty,
        dial,
        Timing::default(),
        sink,
        stable_id,
        remote_id,
    )
    .map(|(opened, _)| opened)
}

/// `open` with its patience and event sink given, returning the link too.
fn open_with<R: tauri::Runtime>(
    app: &AppHandle<R>,
    pty: &PtyManager,
    dial: Arc<dyn Dial>,
    timing: Timing,
    sink: Sink,
    stable_id: &str,
    remote_id: u32,
) -> Result<(Opened, Arc<Link>), ClientError> {
    let remote = dial.resolve(stable_id)?;
    let mut client = connect_to(&*dial, &remote).map_err(Failure::into_error)?;
    let listed = client.list().map_err(|_| ClientError::Refused)?;
    let found = listed
        .into_iter()
        .find(|s| s.id == remote_id && s.running)
        .ok_or(ClientError::Refused)?;
    // One connection lists and then becomes the attached stream; resize gets
    // its own, later.
    let stream = client.attach(remote_id).map_err(|_| ClientError::Refused)?;
    let (cols, rows) = (stream.cols.max(1), stream.rows.max(1));

    let plain_title = if !found.title.is_empty() {
        found.title.clone()
    } else if !found.command.is_empty() {
        found.command.clone()
    } else {
        "terminal".to_string()
    };
    let cwd = found.cwd.clone().unwrap_or_default();
    let (id, generation) = pty
        .allocate_proxy_identity()
        .map_err(|_| ClientError::Refused)?;
    let link = Arc::new(Link::new(
        id,
        stable_id,
        remote_id,
        found.command.clone(),
        dial,
        sink,
        timing,
        (cols, rows),
    ));
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(OUTPUT_CHUNKS);
    let parts = ProxyParts {
        child: Box::new(ProxyChild { link: link.clone() }),
        master: Box::new(ProxyMaster { link: link.clone() }),
        reader: Box::new(ProxyReader {
            link: link.clone(),
            rx,
            buf: Vec::new(),
            pos: 0,
        }),
        writer: Box::new(ProxyWriter { link: link.clone() }),
        link: link.clone(),
        cols,
        rows,
        cwd: cwd.clone(),
        title: format!("{}: {}", remote.name, plain_title),
    };
    if pty
        .start_proxy_session(app.clone(), id, generation, parts)
        .is_err()
    {
        link.finish(None);
        return Err(ClientError::Refused);
    }
    let pump_link = link.clone();
    let pumped = thread::Builder::new()
        .name(format!("tailnet-pump-{id}"))
        .spawn(move || pump(pump_link, stream, tx));
    let resize_link = link.clone();
    let resizing = thread::Builder::new()
        .name(format!("tailnet-resize-{id}"))
        .spawn(move || resize_worker(resize_link));
    if pumped.is_err() || resizing.is_err() {
        link.finish(None);
        return Err(ClientError::Refused);
    }
    Ok((
        Opened {
            pty_id: id,
            session_generation: generation,
            cwd,
            title: plain_title,
            machine: remote.name,
        },
        link,
    ))
}

// ---------------------------------------------------------------------------
// Commands

fn production_dial() -> Result<TailnetDial, String> {
    TailnetDial::installed(SESSION_PORT).map_err(|e| e.code().to_string())
}

#[tauri::command]
pub async fn tailnet_remote_list(stable_id: String) -> Result<Vec<RemoteTerminal>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dial = production_dial()?;
        list_remote(&dial, &stable_id).map_err(|e| e.code().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tailnet_remote_open(
    app: AppHandle,
    stable_id: String,
    remote_id: u32,
) -> Result<Opened, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dial = production_dial()?;
        let pty = app.state::<PtyManager>();
        open(&app, &pty, Arc::new(dial), &stable_id, remote_id).map_err(|e| e.code().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Lets go of the link. Never ends the process on the other machine, and is
/// fine for an id that is not (or no longer) a link.
#[tauri::command]
pub fn tailnet_remote_close(
    state: tauri::State<'_, PtyManager>,
    pty_id: u32,
) -> Result<(), String> {
    if let Some(link) = state.proxy(pty_id) {
        link.close();
    }
    Ok(())
}

/// Restarts a link that gave up.
#[tauri::command]
pub fn tailnet_remote_reconnect(
    state: tauri::State<'_, PtyManager>,
    pty_id: u32,
) -> Result<(), String> {
    if let Some(link) = state.proxy(pty_id) {
        link.reconnect();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_term_net::session::{
        serve_connection, AttachedSession, ErrorCode, Response, SessionHandler,
    };
    use canopy_term_net::tailscale::fake::{status_running, whois_user, FakeRunner};
    use std::io::{BufRead, BufReader};
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    const PEER_ID: &str = "nPEERB1CNTRL";

    fn loopback() -> std::net::IpAddr {
        "127.0.0.1".parse().unwrap()
    }

    /// A fake CLI: this node on a tailnet address, the other at loopback.
    fn fake_cli() -> Arc<FakeRunner> {
        let r = Arc::new(FakeRunner::new(&status_running(
            &["100.64.0.1"],
            &["127.0.0.1"],
        )));
        r.set_whois(loopback(), Ok(whois_user(PEER_ID, 42)));
        r
    }

    // ---- a session server over loopback ----

    struct HalfRead(TcpStream);
    impl Read for HalfRead {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.0.read(buf).map_err(|e| {
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) {
                    io::Error::new(canopy_term_net::TIMEOUT_KIND, "read deadline")
                } else {
                    e
                }
            })
        }
    }
    struct HalfWrite(TcpStream);
    impl Write for HalfWrite {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.write(buf)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }
    impl Drop for HalfWrite {
        fn drop(&mut self) {
            let _ = self.0.shutdown(Shutdown::Write);
        }
    }
    struct TcpConn {
        stream: TcpStream,
        peer: PeerIdentity,
    }
    impl Connection for TcpConn {
        fn peer(&self) -> &PeerIdentity {
            &self.peer
        }
        fn set_read_deadline(&mut self, d: Option<Duration>) -> io::Result<()> {
            self.stream
                .set_read_timeout(d.map(|d| d.max(Duration::from_millis(1))))
        }
        fn split(self: Box<Self>) -> (Box<dyn Read + Send>, Box<dyn Write + Send>) {
            let read = self.stream.try_clone().expect("clone");
            (Box::new(HalfRead(read)), Box::new(HalfWrite(self.stream)))
        }
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Mode {
        /// Serve the session protocol.
        Serve,
        /// Close every connection without a byte, like a listener turning a
        /// machine away.
        Refuse,
        /// Answer hello with "your version is too old for me" (host is older).
        Older,
        /// Answer hello with a host far newer than this build.
        Newer,
    }

    #[derive(Default)]
    struct Host {
        sessions: Mutex<Vec<SessionSummary>>,
        snapshot: Mutex<Vec<u8>>,
        written: Mutex<Vec<u8>>,
        resizes: Mutex<Vec<(u32, u16, u16)>>,
        outputs: Mutex<Vec<mpsc::Sender<Vec<u8>>>>,
        attaches: AtomicUsize,
    }

    impl SessionHandler for Host {
        fn list(&self, _peer: &PeerIdentity) -> Vec<SessionSummary> {
            self.sessions.lock().unwrap().clone()
        }
        fn attach(&self, _peer: &PeerIdentity, id: u32) -> Result<AttachedSession, SessionError> {
            if !self.sessions.lock().unwrap().iter().any(|s| s.id == id) {
                return Err(SessionError::NotFound);
            }
            let (tx, rx) = mpsc::channel();
            self.outputs.lock().unwrap().push(tx);
            self.attaches.fetch_add(1, Ordering::SeqCst);
            Ok(AttachedSession {
                cols: 100,
                rows: 30,
                snapshot: self.snapshot.lock().unwrap().clone(),
                output: rx,
            })
        }
        fn write(&self, _id: u32, bytes: &[u8]) -> io::Result<()> {
            self.written.lock().unwrap().extend_from_slice(bytes);
            Ok(())
        }
        fn resize(
            &self,
            _peer: &PeerIdentity,
            id: u32,
            cols: u16,
            rows: u16,
        ) -> Result<(), SessionError> {
            self.resizes.lock().unwrap().push((id, cols, rows));
            Ok(())
        }
        fn close(&self, _peer: &PeerIdentity, _id: u32) {}
    }

    struct Server {
        host: Arc<Host>,
        port: u16,
        mode: Arc<Mutex<Mode>>,
        conns: Arc<Mutex<Vec<TcpStream>>>,
        stop: Arc<AtomicBool>,
    }

    impl Server {
        fn start(mode: Mode) -> Server {
            let host = Arc::new(Host::default());
            host.sessions.lock().unwrap().push(SessionSummary {
                id: 1,
                title: "zsh".into(),
                cwd: Some("/remote/code".into()),
                command: "zsh".into(),
                running: true,
                exit_code: None,
                in_use_here: None,
            });
            *host.snapshot.lock().unwrap() = b"snapshot-1\r\n".to_vec();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = Server {
                host: host.clone(),
                port,
                mode: Arc::new(Mutex::new(mode)),
                conns: Arc::new(Mutex::new(Vec::new())),
                stop: Arc::new(AtomicBool::new(false)),
            };
            let (mode, conns, stop) = (
                server.mode.clone(),
                server.conns.clone(),
                server.stop.clone(),
            );
            thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    let stream = match listener.accept() {
                        Ok((s, _)) => s,
                        Err(_) => {
                            thread::sleep(Duration::from_millis(5));
                            continue;
                        }
                    };
                    let _ = stream.set_nonblocking(false);
                    let current = *mode.lock().unwrap();
                    if let Ok(clone) = stream.try_clone() {
                        conns.lock().unwrap().push(clone);
                    }
                    let host = host.clone();
                    thread::spawn(move || match current {
                        Mode::Serve => {
                            let conn = TcpConn {
                                stream,
                                peer: PeerIdentity::Device("test".into()),
                            };
                            let _ = serve_connection(Box::new(conn), host);
                        }
                        Mode::Refuse => drop(stream),
                        Mode::Older | Mode::Newer => {
                            let mut line = String::new();
                            let _ =
                                BufReader::new(stream.try_clone().unwrap()).read_line(&mut line);
                            let reply = if current == Mode::Older {
                                Response::Error {
                                    code: ErrorCode::VersionMismatch,
                                    message: "old".into(),
                                    version: Some(0),
                                }
                            } else {
                                Response::Hello {
                                    version: 7,
                                    min_client: 5,
                                }
                            };
                            let mut stream = stream;
                            let _ = stream.write_all(format!("{}\n", reply.to_line()).as_bytes());
                            // Keep it open long enough to be read.
                            thread::sleep(Duration::from_millis(200));
                        }
                    });
                }
            });
            server
        }

        fn set_mode(&self, mode: Mode) {
            *self.mode.lock().unwrap() = mode;
        }

        /// Cut every connection, as a dropped link does.
        fn sever(&self) {
            for c in self.conns.lock().unwrap().drain(..) {
                let _ = c.shutdown(Shutdown::Both);
            }
        }

        fn output(&self, bytes: &[u8]) {
            for tx in self.host.outputs.lock().unwrap().iter() {
                let _ = tx.send(bytes.to_vec());
            }
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            self.sever();
        }
    }

    /// The real dialler, with the route cut on demand and attempts counted.
    struct Route {
        inner: TailnetDial,
        down: AtomicBool,
        dials: AtomicUsize,
    }

    impl Route {
        fn new(port: u16) -> Arc<Route> {
            Arc::new(Route {
                inner: TailnetDial::new(fake_cli(), port),
                down: AtomicBool::new(false),
                dials: AtomicUsize::new(0),
            })
        }
    }

    impl Dial for Route {
        fn resolve(&self, stable_id: &str) -> Result<Remote, ClientError> {
            self.inner.resolve(stable_id)
        }
        fn dial(&self, remote: &Remote) -> io::Result<Box<dyn Connection>> {
            self.dials.fetch_add(1, Ordering::SeqCst);
            if self.down.load(Ordering::SeqCst) {
                return Err(io::Error::new(io::ErrorKind::ConnectionRefused, "down"));
            }
            self.inner.dial(remote)
        }
    }

    fn fast() -> Timing {
        Timing {
            backoff: vec![
                Duration::from_millis(20),
                Duration::from_millis(40),
                Duration::from_millis(80),
            ],
            give_up: Duration::from_secs(60),
            resize_pace: Duration::from_millis(5),
            silent_to_revoke: 2,
        }
    }

    type Events = Arc<Mutex<Vec<StateEvent>>>;

    fn collecting() -> (Sink, Events) {
        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let e = events.clone();
        (
            Arc::new(move |ev: StateEvent| e.lock().unwrap().push(ev)),
            events,
        )
    }

    fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if f() {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("timed out waiting for {what}");
    }

    fn screen(pm: &PtyManager, id: u32) -> String {
        String::from_utf8_lossy(&pm.scrollback_tail(id, 1 << 20).unwrap_or_default()).to_string()
    }

    #[allow(dead_code)]
    struct Rig {
        server: Server,
        route: Arc<Route>,
        pm: PtyManager,
        app: tauri::App<tauri::test::MockRuntime>,
        events: Events,
        link: Arc<Link>,
        opened: Opened,
    }

    fn rig() -> Rig {
        let server = Server::start(Mode::Serve);
        let route = Route::new(server.port);
        let pm = PtyManager::default();
        let app = tauri::test::mock_app();
        let (sink, events) = collecting();
        let (opened, link) =
            open_with(app.handle(), &pm, route.clone(), fast(), sink, PEER_ID, 1).expect("open");
        Rig {
            server,
            route,
            pm,
            app,
            events,
            link,
            opened,
        }
    }

    fn states(events: &Events) -> Vec<(State, Option<u32>)> {
        events
            .lock()
            .unwrap()
            .iter()
            .map(|e| (e.state, e.attempt))
            .collect()
    }

    // ---- tests ----

    #[test]
    fn list_shows_the_hosts_terminals() {
        let server = Server::start(Mode::Serve);
        let route = Route::new(server.port);
        let rows = list_remote(&*route, PEER_ID).expect("list");
        assert_eq!(
            rows,
            vec![RemoteTerminal {
                remote_id: 1,
                title: "zsh".into(),
                cwd: "/remote/code".into(),
                command: Some("zsh".into()),
                status: "running",
                exit_code: None,
            }]
        );
        let json = serde_json::to_value(&rows[0]).unwrap();
        assert_eq!(json["remoteId"], 1);
        assert_eq!(json["status"], "running");
        assert!(json["exitCode"].is_null());
    }

    #[test]
    fn open_attaches_and_registers_a_proxy_session() {
        let r = rig();
        let id = r.opened.pty_id;
        assert_eq!(r.opened.cwd, "/remote/code");
        assert_eq!(r.opened.title, "zsh");
        assert_eq!(r.opened.machine, "node-b");
        let json = serde_json::to_value(&r.opened).unwrap();
        assert!(json["ptyId"].is_number() && json["sessionGeneration"].is_number());

        // The host's snapshot, then live output, reach the local session.
        wait_for("the snapshot", || screen(&r.pm, id).contains("snapshot-1"));
        r.server.output(b"live-output\r\n");
        wait_for("live output", || screen(&r.pm, id).contains("live-output"));

        // It is a session of the local manager under a local id, titled with
        // the machine, and it has no local process.
        let session = r.pm.get(id).expect("registered");
        assert_eq!(*session.title.lock().unwrap(), "node-b: zsh");
        assert_eq!(session.pid, None);
        #[cfg(unix)]
        {
            assert_eq!(session.foreground_pid(), None);
            assert!(!session.raw_mode());
        }
        assert!(!r.pm.foreground_running(id));
        assert!(r.pm.stop_foreground(id).is_err());
        // Never offered as one of this machine's own terminals.
        assert!(r.pm.is_proxy(id));
        assert!(r.pm.summaries().iter().all(|s| s.id != id));
        assert!(r.pm.live_cwds().iter().all(|c| c != "/remote/code"));
        assert!(r.pm.attach(id).is_none());
    }

    #[test]
    fn typing_reaches_the_host_and_resize_is_coalesced() {
        let r = rig();
        let id = r.opened.pty_id;
        wait_for("the snapshot", || screen(&r.pm, id).contains("snapshot-1"));
        r.pm.write(id, "ls\r").unwrap();
        wait_for("input", || {
            *r.server.host.written.lock().unwrap() == b"ls\r"
        });

        // A window drag: many sizes, and the host ends with the last one.
        for cols in 80..=90u16 {
            r.link.ask_size(cols, 24);
        }
        wait_for("the last size", || {
            r.server.host.resizes.lock().unwrap().last() == Some(&(1, 90, 24))
        });
        // Faster than the host's limit would be refused; this never was.
        assert!(r.server.host.resizes.lock().unwrap().len() <= 11);
    }

    #[test]
    fn a_drop_backs_off_then_reattaches_with_a_fresh_snapshot() {
        let r = rig();
        let id = r.opened.pty_id;
        wait_for("the snapshot", || screen(&r.pm, id).contains("snapshot-1"));
        r.server.output(b"before-drop\r\n");
        wait_for("output", || screen(&r.pm, id).contains("before-drop"));

        // The route goes, then the connection.
        r.route.down.store(true, Ordering::SeqCst);
        r.server.sever();
        wait_for("attempt 3", || {
            states(&r.events).contains(&(State::Reconnecting, Some(3)))
        });
        let seen = states(&r.events);
        assert!(seen.contains(&(State::Reconnecting, Some(1))), "{seen:?}");
        assert!(seen.contains(&(State::Reconnecting, Some(2))), "{seen:?}");
        assert!(!seen.iter().any(|(s, _)| *s == State::Lost), "{seen:?}");

        // Typing while the link is down is dropped, not queued.
        r.pm.write(id, "typed-while-down\r").unwrap();
        thread::sleep(Duration::from_millis(100));

        // The host snapshot changed while we were away.
        *r.server.host.snapshot.lock().unwrap() = b"snapshot-2\r\n".to_vec();
        r.route.down.store(false, Ordering::SeqCst);
        wait_for("connected again", || {
            states(&r.events)
                .iter()
                .any(|(s, _)| *s == State::Connected)
        });
        wait_for("fresh snapshot", || {
            screen(&r.pm, id).contains("snapshot-2")
        });
        // A terminal reset sits between the old output and the new snapshot.
        let shown = screen(&r.pm, id);
        let reset_at = shown.rfind('\u{1b}').expect("reset");
        assert!(shown[..reset_at].contains("before-drop"));
        assert!(shown[reset_at..].contains("snapshot-2"));

        // Nothing typed while down arrived; typing works again.
        assert!(
            !String::from_utf8_lossy(&r.server.host.written.lock().unwrap())
                .contains("typed-while-down")
        );
        r.pm.write(id, "back\r").unwrap();
        wait_for("input after reattach", || {
            String::from_utf8_lossy(&r.server.host.written.lock().unwrap()).contains("back")
        });
        assert_eq!(r.server.host.attaches.load(Ordering::SeqCst), 2);
        // The size is sent again to the new attachment once the window asked.
        r.link.ask_size(120, 40);
        wait_for("size", || {
            r.server.host.resizes.lock().unwrap().last() == Some(&(1, 120, 40))
        });
    }

    #[test]
    fn it_gives_up_after_the_budget_and_reconnects_when_asked() {
        let server = Server::start(Mode::Serve);
        let route = Route::new(server.port);
        let pm = PtyManager::default();
        let app = tauri::test::mock_app();
        let (sink, events) = collecting();
        let timing = Timing {
            give_up: Duration::from_millis(200),
            ..fast()
        };
        let (opened, link) =
            open_with(app.handle(), &pm, route.clone(), timing, sink, PEER_ID, 1).expect("open");
        route.down.store(true, Ordering::SeqCst);
        server.sever();
        wait_for("lost", || {
            states(&events).iter().any(|(s, _)| *s == State::Lost)
        });
        // No more attempts while lost.
        let dials = route.dials.load(Ordering::SeqCst);
        thread::sleep(Duration::from_millis(150));
        assert_eq!(route.dials.load(Ordering::SeqCst), dials);
        // The session is still there, waiting.
        assert!(pm.get(opened.pty_id).is_some());

        route.down.store(false, Ordering::SeqCst);
        link.reconnect();
        wait_for("connected", || {
            states(&events).iter().any(|(s, _)| *s == State::Connected)
        });
        // Asking when nothing is lost does nothing.
        link.reconnect();
        drop(app);
    }

    #[test]
    fn a_host_that_turns_us_away_mid_session_revokes_the_link() {
        let r = rig();
        let id = r.opened.pty_id;
        wait_for("the snapshot", || screen(&r.pm, id).contains("snapshot-1"));
        r.server.set_mode(Mode::Refuse);
        r.server.sever();
        wait_for("revoked", || {
            states(&r.events).iter().any(|(s, _)| *s == State::Revoked)
        });
        // The session goes with it.
        wait_for("session gone", || r.pm.get(id).is_none());
        assert!(!r.pm.is_proxy(id));
    }

    #[test]
    fn the_remote_terminal_exiting_ends_the_link_with_its_code() {
        let r = rig();
        let id = r.opened.pty_id;
        wait_for("the snapshot", || screen(&r.pm, id).contains("snapshot-1"));
        r.server.output(b"bye\r\n");
        wait_for("output", || screen(&r.pm, id).contains("bye"));
        {
            let mut sessions = r.server.host.sessions.lock().unwrap();
            sessions[0].running = false;
            sessions[0].exit_code = Some(3);
        }
        // The host ends the attached connection when its session ends.
        r.server.host.outputs.lock().unwrap().clear();
        r.server.sever();
        wait_for("ended", || {
            r.events
                .lock()
                .unwrap()
                .iter()
                .any(|e| e.state == State::Ended && e.exit_code == Some(3))
        });
        // No flash of reconnecting for a process that simply exited.
        assert!(!states(&r.events)
            .iter()
            .any(|(s, _)| *s == State::Reconnecting));
        wait_for("session gone", || r.pm.get(id).is_none());
    }

    #[test]
    fn a_terminal_that_reused_the_id_is_not_ours() {
        let r = rig();
        let id = r.opened.pty_id;
        wait_for("the snapshot", || screen(&r.pm, id).contains("snapshot-1"));
        // The other app restarted: id 1 is a different terminal now.
        r.server.host.sessions.lock().unwrap()[0].command = "claude".into();
        r.server.host.outputs.lock().unwrap().clear();
        r.server.sever();
        wait_for("ended", || {
            states(&r.events).iter().any(|(s, _)| *s == State::Ended)
        });
        assert_eq!(r.server.host.attaches.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn closing_and_killing_let_go_without_touching_the_host() {
        let r = rig();
        let id = r.opened.pty_id;
        wait_for("the snapshot", || screen(&r.pm, id).contains("snapshot-1"));
        // Same path as closing the tab.
        r.pm.kill(id).unwrap();
        wait_for("session gone", || r.pm.get(id).is_none());
        // The host's terminal is as it was, and nobody was told it ended.
        assert!(r.server.host.sessions.lock().unwrap()[0].running);
        assert!(!states(&r.events).iter().any(|(s, _)| *s == State::Ended));
        // A second close is fine.
        r.link.close();
    }

    #[test]
    fn closing_all_proxies_lets_go_of_every_link() {
        let r = rig();
        let id = r.opened.pty_id;
        wait_for("the snapshot", || screen(&r.pm, id).contains("snapshot-1"));
        r.pm.close_proxies();
        wait_for("session gone", || r.pm.get(id).is_none());
    }

    #[test]
    fn a_host_that_refuses_gets_the_one_generic_answer() {
        let server = Server::start(Mode::Refuse);
        let route = Route::new(server.port);
        assert_eq!(list_remote(&*route, PEER_ID), Err(ClientError::Refused));
        let pm = PtyManager::default();
        let app = tauri::test::mock_app();
        let (sink, _) = collecting();
        let err = open_with(app.handle(), &pm, route.clone(), fast(), sink, PEER_ID, 1)
            .err()
            .expect("refused");
        assert_eq!(err, ClientError::Refused);
        assert_eq!(err.code(), "refused");
        // Nothing was registered.
        assert_eq!(pm.live_count(), 0);

        // So does a machine that is not listening at all, and one that is not
        // on the tailnet, and a terminal that is not there.
        route.down.store(true, Ordering::SeqCst);
        assert_eq!(list_remote(&*route, PEER_ID), Err(ClientError::Refused));
        assert_eq!(
            list_remote(&*route, "nNOTLISTED1CNTRL"),
            Err(ClientError::Refused)
        );
        let live = Server::start(Mode::Serve);
        let route = Route::new(live.port);
        let (sink, _) = collecting();
        assert_eq!(
            open_with(app.handle(), &pm, route, fast(), sink, PEER_ID, 99)
                .err()
                .expect("no such terminal"),
            ClientError::Refused
        );
    }

    #[test]
    fn version_skew_maps_to_the_older_canopy_state_only_when_the_host_is_older() {
        let old = Server::start(Mode::Older);
        let route = Route::new(old.port);
        let err = list_remote(&*route, PEER_ID).unwrap_err();
        assert_eq!(err, ClientError::OlderCanopy);
        assert_eq!(err.code(), "older_canopy");
        let pm = PtyManager::default();
        let app = tauri::test::mock_app();
        let (sink, _) = collecting();
        assert_eq!(
            open_with(app.handle(), &pm, route, fast(), sink, PEER_ID, 1)
                .err()
                .expect("older"),
            ClientError::OlderCanopy
        );

        // A host newer than this build has no approved text of its own.
        let new = Server::start(Mode::Newer);
        let route = Route::new(new.port);
        assert_eq!(list_remote(&*route, PEER_ID), Err(ClientError::Refused));
    }

    #[test]
    fn tailscale_off_is_its_own_answer() {
        let runner = Arc::new(FakeRunner::new(r#"{"BackendState":"Stopped"}"#));
        let dial = TailnetDial::new(runner, SESSION_PORT);
        let err = list_remote(&dial, PEER_ID).unwrap_err();
        assert_eq!(err, ClientError::TailscaleOff);
        assert_eq!(err.code(), "tailscale_off");
        // A stable id that is not one is refused before anything runs.
        assert_eq!(dial.resolve("../x"), Err(ClientError::Refused));
    }

    #[test]
    fn a_node_that_is_not_the_one_asked_for_is_never_dialled() {
        let server = Server::start(Mode::Serve);
        // The tailnet answers for the address as another node.
        let runner = fake_cli();
        runner.set_whois(loopback(), Ok(whois_user("nSOMEONE1CNTRL", 42)));
        let dial = TailnetDial::new(runner, server.port);
        assert_eq!(list_remote(&dial, PEER_ID), Err(ClientError::Refused));
        assert!(server.conns.lock().unwrap().is_empty());
    }

    #[test]
    fn events_serialise_the_way_the_webview_reads_them() {
        let e = StateEvent {
            pty_id: 7,
            stable_id: "nX1CNTRL".into(),
            state: State::Reconnecting,
            attempt: Some(3),
            exit_code: None,
        };
        let j = serde_json::to_value(&e).unwrap();
        assert_eq!(j["ptyId"], 7);
        assert_eq!(j["stableId"], "nX1CNTRL");
        assert_eq!(j["state"], "reconnecting");
        assert_eq!(j["attempt"], 3);
        assert!(j["exitCode"].is_null());
        for (s, name) in [
            (State::Connected, "connected"),
            (State::Lost, "lost"),
            (State::Revoked, "revoked"),
            (State::Ended, "ended"),
        ] {
            assert_eq!(serde_json::to_value(s).unwrap(), name);
        }
    }

    #[test]
    fn the_default_patience_is_the_contract() {
        let t = Timing::default();
        let secs: Vec<u64> = t.backoff.iter().map(|d| d.as_secs()).collect();
        assert_eq!(secs, vec![1, 2, 4, 8, 16, 30]);
        assert_eq!(t.give_up, Duration::from_secs(300));
        assert!(t.silent_to_revoke >= 2);
    }

    #[test]
    fn the_reader_ends_when_the_pump_is_gone_and_the_writer_never_fails() {
        let (sink, _) = collecting();
        let link = Arc::new(Link::new(
            1,
            PEER_ID,
            1,
            String::new(),
            Route::new(1),
            sink,
            fast(),
            (80, 24),
        ));
        let (tx, rx) = mpsc::sync_channel(4);
        let mut reader = ProxyReader {
            link: link.clone(),
            rx,
            buf: Vec::new(),
            pos: 0,
        };
        tx.send(b"abcdef".to_vec()).unwrap();
        let mut two = [0u8; 2];
        assert_eq!(reader.read(&mut two).unwrap(), 2);
        assert_eq!(&two, b"ab");
        let mut rest = [0u8; 16];
        assert_eq!(reader.read(&mut rest).unwrap(), 4);
        drop(tx);
        assert_eq!(reader.read(&mut rest).unwrap(), 0);

        // A finished link ends the output even while the pump is still alive,
        // after what it already queued.
        let (tx, rx) = mpsc::sync_channel(4);
        let mut reader = ProxyReader {
            link: link.clone(),
            rx,
            buf: Vec::new(),
            pos: 0,
        };
        tx.send(b"tail".to_vec()).unwrap();
        link.finish(None);
        assert_eq!(reader.read(&mut rest).unwrap(), 4);
        assert_eq!(reader.read(&mut rest).unwrap(), 0);
        drop(tx);

        // With no attached connection, writing is a quiet no-op.
        let link = Arc::new(Link::new(
            2,
            PEER_ID,
            1,
            String::new(),
            Route::new(1),
            collecting().0,
            fast(),
            (80, 24),
        ));
        let mut writer = ProxyWriter { link: link.clone() };
        assert_eq!(writer.write(b"x").unwrap(), 1);
        link.set_phase(Phase::Reconnecting);
        assert_eq!(writer.write(b"y").unwrap(), 1);
    }
}
