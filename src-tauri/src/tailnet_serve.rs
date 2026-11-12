//! The tailnet listener: lets machines on this machine's tailnet that the user
//! allowed list, read and type into this machine's terminals, while this app
//! runs.
//!
//! What exists, and when:
//! - The listener exists only while the installed Tailscale is `Running` AND at
//!   least one tailnet allowlist entry bound to this machine's own tailnet
//!   exists. Allow on enables it, the last Allow off drops it, and with no
//!   entries Canopy never even asks Tailscale for its status. Off by default.
//! - It is `TailnetTcp::bind`: the node's own tailnet addresses only (never
//!   `0.0.0.0`, never loopback) on the one fixed [`TAILNET_PORT`]. A busy port
//!   or a tailnet with no interface (userspace-mode daemon) is reported in the
//!   Settings row's status ([`ListenerStatus`]); nothing binds wider and there
//!   is no fallback port, because a client has to know the port.
//! - A peer is admitted by the transport before a byte of its stream is read:
//!   a stranger, or a machine whose entry is gone, is closed unread and never
//!   reaches the code below.
//! - An admitted connection speaks the session protocol
//!   (`canopy_term_net::session`), served by [`Handler`] over [`Terminals`]
//!   (implemented on `PtyManager`). The only operations are: list, attach
//!   (snapshot, then live output; input back), and resize. No spawn, kill, env,
//!   cwd or ring read exists on this path, and terminals that have no tab
//!   (`SessionKind::Detached`, background tasks) are neither listed nor
//!   attachable.
//! - Caps: 8 attached terminals per peer, 32 in total, and 16 / 64 open
//!   connections (control ones included) per peer / in total. Above a cap the
//!   connection or attach is refused.
//! - Revocation: Allow off removes the entry from the listener's in-memory
//!   allowlist at once, and the transport's sweep (every 250 ms) closes that
//!   machine's live connections; dropping the last entry shuts everything.
//!
//! This is full trust: an allowed machine can read every terminal here and type
//! into it, which is a shell as this user. There is no per-terminal scope or
//! view-only mode. Reachable only while the app runs.
//!
//! Nothing here logs a tailnet name, address, peer identity or key.

use crate::pty::{PtyEvent, PtyManager, SessionKind};
use crate::tailnet::{allowed_ids, installed_runner, load_allow, own_domain};
use canopy_term_net::allowlist::{canonical_tailnet_entry, Allowlist};
use canopy_term_net::session::{
    serve_connection, AttachedSession, SessionError, SessionHandler, SessionSummary,
};
use canopy_term_net::tailnet_tcp::{BindError, TailnetTcp};
use canopy_term_net::tailscale::{CliRunner, InstallProblem, TailnetState, Tailscale};
use canopy_term_net::{Connection, PeerIdentity, Transport};
use serde::Serialize;
use std::collections::BTreeSet;
use std::io;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::broadcast;

/// The one TCP port the listener uses on the tailnet interface. Clients dial
/// `<machine>:28617`, so it cannot be negotiated and is never auto-changed.
///
/// Chosen to be: above the registered range (so no installed service wants
/// it), below 32768 (the lowest dynamic range any supported OS hands out, so
/// an outgoing connection is never given it), different from Canopy's other
/// listeners (the phone portal is 6680), and not a port a well-known tool
/// uses. If something else holds it the Settings row says "port in use".
pub const TAILNET_PORT: u16 = 28617;

/// Attached terminals one allowed machine may hold open.
pub const MAX_SESSIONS_PER_PEER: usize = 8;
/// Attached terminals across every allowed machine.
pub const MAX_SESSIONS_TOTAL: usize = 32;
/// Open connections (one per attached terminal plus control connections) per
/// allowed machine, and in total. Each is a thread, so they are bounded.
pub const MAX_CONNECTIONS_PER_PEER: usize = 16;
pub const MAX_CONNECTIONS_TOTAL: usize = 64;
/// How often the listener re-checks that Tailscale is still running on the
/// same addresses (and retries after a busy port). Costs nothing with no
/// entries.
const TICK: Duration = Duration::from_secs(15);
/// Output chunks queued for one attached peer. A peer that falls this far
/// behind is detached (it re-attaches for a fresh snapshot) instead of making
/// this machine buffer without limit or slowing the terminal.
const OUTPUT_QUEUE: usize = 256;
/// How often an idle output bridge checks that its attach was closed.
const BRIDGE_POLL: Duration = Duration::from_millis(250);

// ---------------------------------------------------------------------------
// Status for the Settings row
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ListenState {
    /// Nothing listens: no allowed machine, or Tailscale is not running.
    Off,
    Listening,
    /// Another program holds the fixed port.
    PortInUse,
    /// Tailscale runs but has no network interface here (userspace mode).
    NoInterface,
    /// Could not listen for another reason.
    Unavailable,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListenerStatus {
    pub state: ListenState,
    /// The port in use (or wanted).
    pub port: u16,
}

impl ListenerStatus {
    pub fn off() -> Self {
        Self {
            state: ListenState::Off,
            port: TAILNET_PORT,
        }
    }
}

// ---------------------------------------------------------------------------
// The terminals this serves
// ---------------------------------------------------------------------------

/// A terminal that is not there (or is not one a peer may touch).
#[derive(Debug, PartialEq, Eq)]
pub enum TermError {
    Gone,
    Failed(String),
}

/// A live view of one terminal: its size, what it has shown so far, then the
/// live tail.
pub struct TerminalAttach {
    pub cols: u16,
    pub rows: u16,
    pub snapshot: Vec<u8>,
    pub events: broadcast::Receiver<PtyEvent>,
}

/// The only operations a peer can reach. Deliberately small.
pub trait Terminals: Send + Sync + 'static {
    fn list_terminals(&self) -> Vec<SessionSummary>;
    fn attach_terminal(&self, id: u32) -> Option<TerminalAttach>;
    fn write_terminal(&self, id: u32, bytes: &[u8]) -> Result<(), TermError>;
    fn resize_terminal(&self, id: u32, cols: u16, rows: u16) -> Result<(), TermError>;
}

impl PtyManager {
    /// Terminals with a tab. A background task's terminal has none and is not
    /// for a peer to see.
    fn peer_visible(&self, id: u32) -> bool {
        self.get(id)
            .is_some_and(|s| s.kind != SessionKind::Detached)
    }
}

impl Terminals for PtyManager {
    fn list_terminals(&self) -> Vec<SessionSummary> {
        self.summaries()
            .into_iter()
            .filter(|s| s.kind != SessionKind::Detached)
            .map(|s| SessionSummary {
                id: s.id,
                title: if s.title.trim().is_empty() {
                    s.name
                } else {
                    s.title
                },
                cwd: Some(s.cwd).filter(|c| !c.is_empty()),
                command: s.command.unwrap_or_default(),
                // Only live terminals are in the map.
                running: true,
                exit_code: None,
                in_use_here: None,
            })
            .collect()
    }

    fn attach_terminal(&self, id: u32) -> Option<TerminalAttach> {
        if !self.peer_visible(id) {
            return None;
        }
        let (cols, rows, snapshot, events) = self.attach(id)?;
        Some(TerminalAttach {
            cols,
            rows,
            snapshot,
            events,
        })
    }

    fn write_terminal(&self, id: u32, bytes: &[u8]) -> Result<(), TermError> {
        if !self.peer_visible(id) {
            return Err(TermError::Gone);
        }
        self.write_bytes(id, bytes).map_err(TermError::Failed)
    }

    fn resize_terminal(&self, id: u32, cols: u16, rows: u16) -> Result<(), TermError> {
        if !self.peer_visible(id) {
            return Err(TermError::Gone);
        }
        self.resize(id, cols, rows)
            .map(|_| ())
            .map_err(TermError::Failed)
    }
}

/// `PtyManager` lives in the app's managed state, not in an `Arc`.
struct AppTerminals(AppHandle);

impl Terminals for AppTerminals {
    fn list_terminals(&self) -> Vec<SessionSummary> {
        self.0.state::<PtyManager>().list_terminals()
    }
    fn attach_terminal(&self, id: u32) -> Option<TerminalAttach> {
        self.0.state::<PtyManager>().attach_terminal(id)
    }
    fn write_terminal(&self, id: u32, bytes: &[u8]) -> Result<(), TermError> {
        self.0.state::<PtyManager>().write_terminal(id, bytes)
    }
    fn resize_terminal(&self, id: u32, cols: u16, rows: u16) -> Result<(), TermError> {
        self.0.state::<PtyManager>().resize_terminal(id, cols, rows)
    }
}

// ---------------------------------------------------------------------------
// The session handler: caps and the bridge to a terminal
// ---------------------------------------------------------------------------

fn peer_key(peer: &PeerIdentity) -> String {
    match peer {
        PeerIdentity::Device(k) => k.clone(),
        PeerIdentity::LocalUser(u) => format!("local:{u}"),
    }
}

struct Open {
    peer: String,
    id: u32,
    /// Stops this attach's output bridge.
    stop: Arc<AtomicBool>,
}

/// Serves the session protocol's operations over [`Terminals`].
pub struct Handler {
    terms: Arc<dyn Terminals>,
    per_peer: usize,
    total: usize,
    open: Mutex<Vec<Open>>,
}

impl Handler {
    pub fn new(terms: Arc<dyn Terminals>) -> Self {
        Self::with_caps(terms, MAX_SESSIONS_PER_PEER, MAX_SESSIONS_TOTAL)
    }

    pub fn with_caps(terms: Arc<dyn Terminals>, per_peer: usize, total: usize) -> Self {
        Self {
            terms,
            per_peer,
            total,
            open: Mutex::new(Vec::new()),
        }
    }

    /// Attached terminals right now.
    #[cfg(test)]
    pub fn open_count(&self) -> usize {
        self.open.lock().map(|o| o.len()).unwrap_or(0)
    }

    fn release(&self, peer: &str, id: u32) {
        let Ok(mut open) = self.open.lock() else {
            return;
        };
        if let Some(at) = open.iter().position(|o| o.peer == peer && o.id == id) {
            open.remove(at).stop.store(true, Ordering::SeqCst);
        }
    }
}

impl SessionHandler for Handler {
    fn list(&self, _peer: &PeerIdentity) -> Vec<SessionSummary> {
        self.terms.list_terminals()
    }

    fn attach(&self, peer: &PeerIdentity, id: u32) -> Result<AttachedSession, SessionError> {
        let key = peer_key(peer);
        let stop = Arc::new(AtomicBool::new(false));
        // Take the place first, so two racing attaches cannot both pass a cap.
        {
            let mut open = self
                .open
                .lock()
                .map_err(|_| SessionError::Failed("unavailable".into()))?;
            if open.len() >= self.total
                || open.iter().filter(|o| o.peer == key).count() >= self.per_peer
            {
                return Err(SessionError::Failed("too many open terminals".into()));
            }
            open.push(Open {
                peer: key.clone(),
                id,
                stop: stop.clone(),
            });
        }
        let Some(att) = self.terms.attach_terminal(id) else {
            self.release(&key, id);
            return Err(SessionError::NotFound);
        };
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(OUTPUT_QUEUE);
        let mut events = att.events;
        tauri::async_runtime::spawn(async move {
            while !stop.load(Ordering::SeqCst) {
                match tokio::time::timeout(BRIDGE_POLL, events.recv()).await {
                    // Idle: look at `stop` again.
                    Err(_) => {}
                    Ok(Ok(PtyEvent::Data(chunk))) => {
                        // Full or gone: end it. The peer re-attaches for a
                        // fresh snapshot rather than get a gap.
                        if tx.try_send(chunk.to_vec()).is_err() {
                            break;
                        }
                    }
                    // The wire has no resize event; the size travels in the
                    // attach reply.
                    Ok(Ok(PtyEvent::Resize(..))) => {}
                    Ok(Err(_)) => break,
                }
            }
            // Dropping `tx` is "session ended" to the server.
        });
        Ok(AttachedSession {
            cols: att.cols,
            rows: att.rows,
            snapshot: att.snapshot,
            output: rx,
        })
    }

    fn write(&self, id: u32, bytes: &[u8]) -> io::Result<()> {
        self.terms.write_terminal(id, bytes).map_err(|e| match e {
            TermError::Gone => io::Error::new(io::ErrorKind::NotFound, "no such terminal"),
            TermError::Failed(m) => io::Error::other(m),
        })
    }

    fn resize(
        &self,
        _peer: &PeerIdentity,
        id: u32,
        cols: u16,
        rows: u16,
    ) -> Result<(), SessionError> {
        self.terms
            .resize_terminal(id, cols, rows)
            .map_err(|e| match e {
                TermError::Gone => SessionError::NotFound,
                TermError::Failed(m) => SessionError::Failed(m),
            })
    }

    fn close(&self, peer: &PeerIdentity, id: u32) {
        self.release(&peer_key(peer), id);
    }
}

// ---------------------------------------------------------------------------
// Connection caps
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Counts {
    open: Mutex<Vec<String>>,
}

struct ConnGuard {
    counts: Arc<Counts>,
    peer: String,
}

impl Counts {
    fn enter(self: &Arc<Self>, peer: &str) -> Option<ConnGuard> {
        let mut open = self.open.lock().ok()?;
        if open.len() >= MAX_CONNECTIONS_TOTAL
            || open.iter().filter(|p| *p == peer).count() >= MAX_CONNECTIONS_PER_PEER
        {
            return None;
        }
        open.push(peer.to_string());
        Some(ConnGuard {
            counts: self.clone(),
            peer: peer.to_string(),
        })
    }
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        if let Ok(mut open) = self.counts.open.lock() {
            if let Some(at) = open.iter().position(|p| *p == self.peer) {
                open.remove(at);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The listener's lifecycle
// ---------------------------------------------------------------------------

type RunnerFn = dyn Fn() -> Result<Arc<dyn CliRunner>, InstallProblem> + Send + Sync;
type BindFn =
    dyn Fn(Arc<dyn CliRunner>, Allowlist, u16) -> Result<TailnetTcp, BindError> + Send + Sync;

/// Everything the listener takes from outside, so tests can run a real
/// loopback listener against a fake CLI.
pub struct Config {
    pub allow_path: PathBuf,
    pub runner: Arc<RunnerFn>,
    pub bind: Arc<BindFn>,
    pub port: u16,
    pub terminals: Arc<dyn Terminals>,
}

struct Running {
    transport: Arc<TailnetTcp>,
    /// The node addresses it was bound for; a change rebinds.
    addrs: BTreeSet<IpAddr>,
}

pub struct TailnetServe {
    cfg: Config,
    /// The listener's own in-memory allowlist, shared with its transport. The
    /// file is the truth; [`sync_allow`](Self::sync_allow) copies it here.
    live_allow: Allowlist,
    sync: Mutex<()>,
    run: Mutex<Option<Running>>,
    status: Mutex<ListenerStatus>,
    handler: Arc<Handler>,
    counts: Arc<Counts>,
    stopped: AtomicBool,
}

/// Whether an entry is bound to a tailnet at all (`...@<domain>`). An unbound
/// entry never admits anyone, so it does not turn the listener on.
fn has_bound_entry(list: &Allowlist) -> bool {
    list.keys()
        .iter()
        .any(|k| canonical_tailnet_entry(k).is_some_and(|c| c.contains('@')))
}

impl TailnetServe {
    /// The real thing: the installed Tailscale, the app's terminals, the real
    /// bind, the fixed port.
    pub fn production(app: AppHandle, allow_path: PathBuf) -> Arc<Self> {
        Self::new(Config {
            allow_path,
            runner: Arc::new(installed_runner),
            bind: Arc::new(TailnetTcp::bind),
            port: TAILNET_PORT,
            terminals: Arc::new(AppTerminals(app)),
        })
    }

    pub fn new(cfg: Config) -> Arc<Self> {
        let handler = Arc::new(Handler::new(cfg.terminals.clone()));
        Self::with_handler(cfg, handler)
    }

    pub fn with_handler(cfg: Config, handler: Arc<Handler>) -> Arc<Self> {
        let port = cfg.port;
        Arc::new(Self {
            cfg,
            live_allow: Allowlist::new(),
            sync: Mutex::new(()),
            run: Mutex::new(None),
            status: Mutex::new(ListenerStatus {
                state: ListenState::Off,
                port,
            }),
            handler,
            counts: Arc::new(Counts::default()),
            stopped: AtomicBool::new(false),
        })
    }

    /// Check now and then every [`TICK`], on a background thread. Returns at
    /// once; startup never waits on Tailscale.
    pub fn start(self: &Arc<Self>) {
        let me = Arc::downgrade(self);
        let _ = std::thread::Builder::new()
            .name("tailnet-serve".into())
            .spawn(move || loop {
                let Some(this) = me.upgrade() else { return };
                if this.stopped.load(Ordering::SeqCst) {
                    return;
                }
                this.reconcile();
                drop(this);
                let mut waited = Duration::ZERO;
                while waited < TICK {
                    std::thread::sleep(Duration::from_millis(250));
                    waited += Duration::from_millis(250);
                    match me.upgrade() {
                        Some(t) if !t.stopped.load(Ordering::SeqCst) => {}
                        _ => return,
                    }
                }
            });
    }

    pub fn status(&self) -> ListenerStatus {
        self.status
            .lock()
            .map(|s| *s)
            .unwrap_or_else(|_| ListenerStatus::off())
    }

    /// Stop for good (app exit): close the listener and every connection.
    pub fn shutdown(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.sync_allow_to(&Allowlist::new());
        let mut run = self.run.lock().unwrap_or_else(|e| e.into_inner());
        self.unbind(&mut run, ListenState::Off);
    }

    /// The Allow switch changed the file: apply it at once.
    pub fn allow_changed(&self) {
        self.reconcile();
    }

    /// Make the listener's allowlist equal `new`. Removals first: a revoked
    /// machine's live connections end within the transport's sweep interval.
    fn sync_allow_to(&self, new: &Allowlist) {
        let _g = self.sync.lock().unwrap_or_else(|e| e.into_inner());
        let want: BTreeSet<String> = new.keys().into_iter().collect();
        let have: BTreeSet<String> = self.live_allow.keys().into_iter().collect();
        for k in have.difference(&want) {
            self.live_allow.remove(k);
        }
        for k in want.difference(&have) {
            let _ = self.live_allow.add(k);
        }
    }

    /// An unreadable file is an empty list: nothing is admitted.
    fn sync_allow(&self) {
        let list = load_allow(&self.cfg.allow_path).unwrap_or_default();
        self.sync_allow_to(&list);
    }

    fn set_status(&self, state: ListenState, port: u16) {
        if let Ok(mut s) = self.status.lock() {
            *s = ListenerStatus { state, port };
        }
    }

    fn unbind(&self, run: &mut Option<Running>, state: ListenState) {
        if let Some(r) = run.take() {
            r.transport.shutdown();
        }
        self.set_status(state, self.cfg.port);
    }

    /// Bring the listener in line with the allowlist file and Tailscale.
    pub fn reconcile(&self) {
        // The allowlist first, and outside the lifecycle lock: a revocation
        // must not wait behind a slow Tailscale call.
        self.sync_allow();
        let mut run = self.run.lock().unwrap_or_else(|e| e.into_inner());
        if self.stopped.load(Ordering::SeqCst) || !has_bound_entry(&self.live_allow) {
            // No entry: Tailscale is not even asked.
            self.unbind(&mut run, ListenState::Off);
            return;
        }
        let Ok(runner) = (self.cfg.runner)() else {
            self.unbind(&mut run, ListenState::Off);
            return;
        };
        let probe = Tailscale::new(runner.clone()).probe();
        let (TailnetState::Running, Some(status)) = (&probe.state, &probe.status) else {
            self.unbind(&mut run, ListenState::Off);
            return;
        };
        let admits =
            own_domain(status).is_some_and(|d| !allowed_ids(&self.live_allow, &d).is_empty());
        if !admits {
            self.unbind(&mut run, ListenState::Off);
            return;
        }
        let addrs: BTreeSet<IpAddr> = status
            .self_node
            .as_ref()
            .map(|n| n.addrs.iter().map(|a| a.to_canonical()).collect())
            .unwrap_or_default();
        if let Some(r) = run.as_ref() {
            if !r.transport.is_shut_down() && r.addrs == addrs {
                return;
            }
            self.unbind(&mut run, ListenState::Off);
        }
        match (self.cfg.bind)(runner, self.live_allow.clone(), self.cfg.port) {
            Ok(t) => {
                let port = t
                    .local_addrs()
                    .first()
                    .map(|a| a.port())
                    .unwrap_or(self.cfg.port);
                let transport = Arc::new(t);
                let (handler, counts) = (self.handler.clone(), self.counts.clone());
                let tr = transport.clone();
                let spawned = std::thread::Builder::new()
                    .name("tailnet-accept".into())
                    .spawn(move || accept_loop(tr, handler, counts));
                if spawned.is_err() {
                    transport.shutdown();
                    self.set_status(ListenState::Unavailable, self.cfg.port);
                    return;
                }
                *run = Some(Running { transport, addrs });
                self.set_status(ListenState::Listening, port);
            }
            Err(e) => {
                let state = match e {
                    BindError::NoTailnetInterface(io::ErrorKind::AddrInUse) => {
                        ListenState::PortInUse
                    }
                    BindError::NoTailnetInterface(_) => ListenState::NoInterface,
                    BindError::NotRunning(_) => ListenState::Off,
                    _ => ListenState::Unavailable,
                };
                self.set_status(state, self.cfg.port);
            }
        }
    }
}

/// Admit, cap and serve. A peer the transport refuses is `Err(Refusal)` with
/// nothing read from it and is simply dropped here.
fn accept_loop(transport: Arc<TailnetTcp>, handler: Arc<Handler>, counts: Arc<Counts>) {
    loop {
        let Ok(admitted) = transport.accept() else {
            return;
        };
        if transport.is_shut_down() {
            return;
        }
        let Ok(conn) = admitted else { continue };
        let Some(guard) = counts.enter(&peer_key(conn.peer())) else {
            // Over its cap: closed without a byte read.
            drop(conn);
            continue;
        };
        let handler = handler.clone();
        // If the thread cannot start, the closure (and the connection in it)
        // is dropped, which closes it.
        let _ = std::thread::Builder::new()
            .name("tailnet-session".into())
            .spawn(move || {
                let _guard = guard;
                // Ok or Err only says why it ended; neither goes to the peer
                // beyond the protocol's own replies, nor to a log.
                let _ = serve_connection(conn, handler);
            });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_term_net::session::SessionClient;
    use canopy_term_net::tailscale::fake::{status_running, whois_user, FakeRunner};
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::sync::atomic::AtomicUsize;

    const PEER: &str = "nPEERB1CNTRL";
    const ENTRY: &str = "tailnet:user/nPEERB1CNTRL/42@example.ts.net";
    const OTHER_ENTRY: &str = "tailnet:user/nOTHER1CNTRL/7@example.ts.net";

    /// Run `f` on a thread and fail, not hang, if it takes too long.
    fn within<T: Send + 'static>(secs: u64, f: impl FnOnce() -> T + Send + 'static) -> T {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(f());
        });
        rx.recv_timeout(Duration::from_secs(secs))
            .expect("timed out")
    }

    fn loopback() -> IpAddr {
        "127.0.0.1".parse().unwrap()
    }

    fn server_runner() -> Arc<FakeRunner> {
        let r = Arc::new(FakeRunner::new(&status_running(&["127.0.0.1"], &[])));
        r.set_whois(loopback(), Ok(whois_user(PEER, 42)));
        r
    }

    fn client_runner() -> Arc<FakeRunner> {
        let r = Arc::new(FakeRunner::new(&status_running(
            &["100.64.0.1"],
            &["127.0.0.1"],
        )));
        r.set_whois(loopback(), Ok(whois_user(PEER, 42)));
        r
    }

    fn temp_file(name: &str, entries: &[&str]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "canopy-tailnet-serve-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tailnet-allow.txt");
        let list = Allowlist::new();
        for e in entries {
            list.add(e).unwrap();
        }
        list.save(&path).unwrap();
        path
    }

    #[derive(Default)]
    struct FakeTerms {
        sessions: Mutex<Vec<SessionSummary>>,
        events: Mutex<HashMap<u32, broadcast::Sender<PtyEvent>>>,
        written: Mutex<Vec<(u32, Vec<u8>)>>,
        resized: Mutex<Vec<(u32, u16, u16)>>,
        lists: AtomicUsize,
        attaches: AtomicUsize,
    }

    impl FakeTerms {
        fn with_session(id: u32) -> Arc<Self> {
            let t = Arc::new(Self::default());
            t.sessions.lock().unwrap().push(SessionSummary {
                id,
                title: "zsh".into(),
                cwd: Some("/work".into()),
                command: "zsh".into(),
                running: true,
                exit_code: None,
                in_use_here: None,
            });
            t.events
                .lock()
                .unwrap()
                .insert(id, broadcast::channel(16).0);
            t
        }
        fn emit(&self, id: u32, bytes: &[u8]) {
            let _ = self.events.lock().unwrap()[&id].send(PtyEvent::Data(Arc::from(bytes)));
        }
        fn touched(&self) -> usize {
            self.lists.load(Ordering::SeqCst)
                + self.attaches.load(Ordering::SeqCst)
                + self.written.lock().unwrap().len()
                + self.resized.lock().unwrap().len()
        }
    }

    impl Terminals for FakeTerms {
        fn list_terminals(&self) -> Vec<SessionSummary> {
            self.lists.fetch_add(1, Ordering::SeqCst);
            self.sessions.lock().unwrap().clone()
        }
        fn attach_terminal(&self, id: u32) -> Option<TerminalAttach> {
            self.attaches.fetch_add(1, Ordering::SeqCst);
            let events = self.events.lock().unwrap().get(&id)?.subscribe();
            Some(TerminalAttach {
                cols: 100,
                rows: 30,
                snapshot: b"snap".to_vec(),
                events,
            })
        }
        fn write_terminal(&self, id: u32, bytes: &[u8]) -> Result<(), TermError> {
            self.written.lock().unwrap().push((id, bytes.to_vec()));
            Ok(())
        }
        fn resize_terminal(&self, id: u32, cols: u16, rows: u16) -> Result<(), TermError> {
            self.resized.lock().unwrap().push((id, cols, rows));
            Ok(())
        }
    }

    struct Fixture {
        serve: Arc<TailnetServe>,
        terms: Arc<FakeTerms>,
        server: Arc<FakeRunner>,
        path: PathBuf,
        binds: Arc<AtomicUsize>,
        client: Arc<FakeRunner>,
    }

    fn fixture(name: &str, entries: &[&str]) -> Fixture {
        fixture_on(name, entries, 0)
    }

    fn fixture_on(name: &str, entries: &[&str], port: u16) -> Fixture {
        let path = temp_file(name, entries);
        let terms = FakeTerms::with_session(1);
        let server = server_runner();
        let binds = Arc::new(AtomicUsize::new(0));
        let (r, b) = (server.clone(), binds.clone());
        let serve = TailnetServe::new(Config {
            allow_path: path.clone(),
            runner: Arc::new(move || Ok::<_, InstallProblem>(r.clone() as Arc<dyn CliRunner>)),
            bind: Arc::new(move |runner, allow, port| {
                b.fetch_add(1, Ordering::SeqCst);
                TailnetTcp::bind_for_test(runner, allow, port)
            }),
            port,
            terminals: terms.clone(),
        });
        Fixture {
            serve,
            terms,
            server,
            path,
            binds,
            client: client_runner(),
        }
    }

    impl Fixture {
        fn dial(&self) -> std::io::Result<Box<dyn Connection>> {
            let port = self.serve.status().port;
            TailnetTcp::client(self.client.clone(), Allowlist::new())
                .connect(&format!("node-b:{port}"))
        }
        fn session(&self) -> Result<SessionClient, SessionError> {
            SessionClient::connect(self.dial().map_err(SessionError::Io)?)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.serve.shutdown();
            let _ = std::fs::remove_dir_all(self.path.parent().unwrap());
        }
    }

    #[test]
    fn no_entries_means_no_listener_and_tailscale_is_never_asked() {
        let f = fixture("no-entries", &[]);
        f.serve.reconcile();
        assert_eq!(f.serve.status().state, ListenState::Off);
        assert_eq!(f.binds.load(Ordering::SeqCst), 0);
        assert!(f.server.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn an_entry_not_bound_to_a_tailnet_does_not_turn_it_on() {
        let f = fixture("unbound-entry", &["tailnet:user/nPEERB1CNTRL/42"]);
        f.serve.reconcile();
        assert_eq!(f.serve.status().state, ListenState::Off);
        assert_eq!(f.binds.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn an_entry_for_another_tailnet_does_not_turn_it_on() {
        let f = fixture(
            "other-tailnet",
            &["tailnet:user/nPEERB1CNTRL/42@other.example.net"],
        );
        f.serve.reconcile();
        assert_eq!(f.serve.status().state, ListenState::Off);
        assert_eq!(f.binds.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn no_listener_while_tailscale_is_not_running() {
        let f = fixture("not-running", &[ENTRY]);
        *f.server.status.lock().unwrap() = Ok(r#"{"BackendState":"Stopped"}"#.to_string());
        f.serve.reconcile();
        assert_eq!(f.serve.status().state, ListenState::Off);
        assert_eq!(f.binds.load(Ordering::SeqCst), 0);
        // It comes up when Tailscale does, and goes when Tailscale stops.
        *f.server.status.lock().unwrap() = Ok(status_running(&["127.0.0.1"], &[]));
        f.serve.reconcile();
        assert_eq!(f.serve.status().state, ListenState::Listening);
        let port = f.serve.status().port;
        *f.server.status.lock().unwrap() = Ok(r#"{"BackendState":"NeedsLogin"}"#.to_string());
        f.serve.reconcile();
        assert_eq!(f.serve.status().state, ListenState::Off);
        std::thread::sleep(Duration::from_millis(100));
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err());
    }

    #[test]
    fn an_allowed_machine_lists_and_attaches_and_types() {
        let f = fixture("allowed", &[ENTRY]);
        f.serve.reconcile();
        assert_eq!(f.serve.status().state, ListenState::Listening);
        let terms = f.terms.clone();
        let mut client = f.session().unwrap();
        let list = client.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!((list[0].id, list[0].title.as_str()), (1, "zsh"));
        client.resize(1, 120, 40).unwrap();
        assert_eq!(*terms.resized.lock().unwrap(), vec![(1, 120, 40)]);
        let stream = f.session().unwrap().attach(1).unwrap();
        assert_eq!((stream.cols, stream.rows), (100, 30));
        let (t2, mut r, mut w) = (terms.clone(), stream.reader, stream.writer);
        within(5, move || {
            let mut got = Vec::new();
            let mut buf = [0u8; 64];
            while !got.ends_with(b"snap") {
                let n = r.read(&mut buf).unwrap();
                assert!(n > 0);
                got.extend_from_slice(&buf[..n]);
            }
            t2.emit(1, b"live");
            let mut live = Vec::new();
            while live.len() < 4 {
                let n = r.read(&mut buf).unwrap();
                assert!(n > 0);
                live.extend_from_slice(&buf[..n]);
            }
            assert_eq!(live, b"live");
            w.write_all(b"ls\r").unwrap();
            w.flush().unwrap();
            let end = std::time::Instant::now() + Duration::from_secs(3);
            while t2.written.lock().unwrap().is_empty() && std::time::Instant::now() < end {
                std::thread::sleep(Duration::from_millis(20));
            }
            let typed: Vec<u8> = t2
                .written
                .lock()
                .unwrap()
                .iter()
                .flat_map(|(id, b)| {
                    assert_eq!(*id, 1);
                    b.clone()
                })
                .collect();
            assert_eq!(typed, b"ls\r");
        });
        // A terminal that does not exist is just not found.
        assert!(matches!(
            f.session().unwrap().attach(99),
            Err(SessionError::NotFound)
        ));
    }

    #[test]
    fn an_unknown_peer_is_closed_unread_and_reaches_nothing() {
        // The list has an entry (so the listener exists), just not this peer's.
        let f = fixture("unknown", &[OTHER_ENTRY]);
        f.serve.reconcile();
        assert_eq!(f.serve.status().state, ListenState::Listening);
        let mut conn = f.dial().unwrap();
        conn.set_read_deadline(Some(Duration::from_secs(3)))
            .unwrap();
        let (mut r, mut w) = conn.split();
        // Whatever it sends is never read, and nothing is ever sent back.
        let _ = w.write_all(b"{\"op\":\"hello\",\"version\":1}\n");
        let mut buf = [0u8; 16];
        match r.read(&mut buf) {
            Ok(n) => assert_eq!(n, 0, "a refused peer got bytes"),
            Err(e) => assert_ne!(e.kind(), io::ErrorKind::TimedOut, "left open, not closed"),
        }
        assert!(f.session().is_err());
        assert_eq!(f.terms.touched(), 0);
    }

    #[test]
    fn per_peer_cap_is_eight_attached_terminals() {
        let f = fixture("cap-peer", &[ENTRY]);
        f.serve.reconcile();
        let mut held = Vec::new();
        for _ in 0..MAX_SESSIONS_PER_PEER {
            held.push(f.session().unwrap().attach(1).unwrap());
        }
        assert!(f.session().unwrap().attach(1).is_err());
        assert_eq!(f.serve.handler.open_count(), MAX_SESSIONS_PER_PEER);
        // Detaching frees a place.
        drop(held.pop());
        let end = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(c) = f.session() {
                if let Ok(s) = c.attach(1) {
                    held.push(s);
                    break;
                }
            }
            assert!(std::time::Instant::now() < end, "slot never freed");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn total_cap_is_thirty_two_across_peers_and_close_frees_a_place() {
        let terms = FakeTerms::with_session(1);
        let h = Handler::new(terms.clone());
        let peer = |n: usize| PeerIdentity::Device(format!("p{n}"));
        let mut kept = Vec::new();
        for (p, n) in [(1, 8), (2, 8), (3, 8), (4, 8)] {
            for _ in 0..n {
                kept.push(h.attach(&peer(p), 1).ok().expect("under both caps"));
            }
        }
        assert_eq!(h.open_count(), MAX_SESSIONS_TOTAL);
        // A fifth peer has room per peer but not in total.
        assert!(h.attach(&peer(5), 1).is_err());
        // The same peer is over its own cap even when total had room.
        h.close(&peer(4), 1);
        assert!(h.attach(&peer(1), 1).is_err());
        assert!(h.attach(&peer(5), 1).is_ok());
    }

    #[test]
    fn a_failed_attach_does_not_keep_its_place() {
        let h = Handler::new(FakeTerms::with_session(1));
        let p = PeerIdentity::Device("p".into());
        for _ in 0..(MAX_SESSIONS_PER_PEER * 3) {
            assert!(matches!(h.attach(&p, 99), Err(SessionError::NotFound)));
        }
        assert_eq!(h.open_count(), 0);
    }

    #[test]
    fn connection_caps_hold_per_peer_and_in_total() {
        let c = Arc::new(Counts::default());
        let mut guards = Vec::new();
        for _ in 0..MAX_CONNECTIONS_PER_PEER {
            guards.push(c.enter("a").unwrap());
        }
        assert!(c.enter("a").is_none());
        drop(guards.pop());
        guards.push(c.enter("a").unwrap());
        for i in 0..(MAX_CONNECTIONS_TOTAL - MAX_CONNECTIONS_PER_PEER) {
            guards.push(
                c.enter(&format!("b{}", i / MAX_CONNECTIONS_PER_PEER))
                    .unwrap(),
            );
        }
        assert!(c.enter("zz").is_none());
    }

    #[test]
    fn allow_off_closes_a_live_connection_and_the_last_one_drops_the_listener() {
        let f = fixture("revoke", &[ENTRY]);
        f.serve.reconcile();
        let port = f.serve.status().port;
        let stream = f.session().unwrap().attach(1).unwrap();
        let mut r = stream.reader;
        let _w = stream.writer;
        let reader = std::thread::spawn(move || {
            let mut buf = [0u8; 64];
            loop {
                match r.read(&mut buf) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {}
                }
            }
        });
        // The same path the Allow switch takes.
        crate::tailnet::set_allowed_at(&f.path, None, PEER, false).unwrap();
        f.serve.allow_changed();
        assert_eq!(f.serve.status().state, ListenState::Off);
        within(5, move || reader.join().unwrap());
        std::thread::sleep(Duration::from_millis(100));
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err());
        let end = std::time::Instant::now() + Duration::from_secs(3);
        while f.serve.handler.open_count() > 0 && std::time::Instant::now() < end {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(f.serve.handler.open_count(), 0);
    }

    #[test]
    fn revoking_one_machine_closes_its_connection_by_sweep_and_keeps_the_listener() {
        let f = fixture("revoke-one", &[ENTRY, OTHER_ENTRY]);
        f.serve.reconcile();
        assert_eq!(f.serve.status().state, ListenState::Listening);
        let stream = f.session().unwrap().attach(1).unwrap();
        let mut r = stream.reader;
        let _w = stream.writer;
        let reader = std::thread::spawn(move || {
            let mut buf = [0u8; 64];
            loop {
                match r.read(&mut buf) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {}
                }
            }
        });
        crate::tailnet::set_allowed_at(&f.path, None, PEER, false).unwrap();
        f.serve.allow_changed();
        // Another machine is still allowed, so it stays up, unrebound ...
        assert_eq!(f.serve.status().state, ListenState::Listening);
        assert_eq!(f.binds.load(Ordering::SeqCst), 1);
        // ... and the revoked one's live connection is cut by the sweep.
        within(5, move || reader.join().unwrap());
        assert!(f.session().is_err());
        assert_eq!(f.terms.touched(), 1, "only the earlier attach");
    }

    #[test]
    fn a_busy_port_is_reported_and_nothing_else_is_tried() {
        let squatter = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = squatter.local_addr().unwrap().port();
        let f = fixture_on("busy", &[ENTRY], port);
        f.serve.reconcile();
        assert_eq!(
            f.serve.status(),
            ListenerStatus {
                state: ListenState::PortInUse,
                port
            }
        );
        // Freed: the next check takes it.
        drop(squatter);
        f.serve.reconcile();
        assert_eq!(f.serve.status().state, ListenState::Listening);
        assert_eq!(f.serve.status().port, port);
    }

    #[test]
    fn a_daemon_with_no_interface_is_reported_and_binds_nothing() {
        let f = fixture("no-iface", &[ENTRY]);
        // In-range tailnet addresses that are on no interface here.
        *f.server.status.lock().unwrap() = Ok(status_running(&["100.64.0.77"], &[]));
        f.serve.reconcile();
        assert_eq!(f.serve.status().state, ListenState::NoInterface);
    }

    #[test]
    fn the_status_serialises_in_the_shape_the_row_reads() {
        let j = serde_json::to_value(ListenerStatus {
            state: ListenState::PortInUse,
            port: TAILNET_PORT,
        })
        .unwrap();
        assert_eq!(j["state"], "portInUse");
        assert_eq!(j["port"], TAILNET_PORT);
        assert_eq!(
            serde_json::to_value(ListenState::NoInterface).unwrap(),
            "noInterface"
        );
    }

    #[test]
    fn the_port_is_fixed_and_outside_the_dynamic_ranges() {
        assert!((1024..32768).contains(&TAILNET_PORT));
        assert_ne!(TAILNET_PORT, 6680);
    }

    /// The real `PtyManager` behind the trait: a terminal with a tab is
    /// listed and attachable; a background task's is neither.
    #[cfg(unix)]
    #[test]
    fn the_pty_manager_hides_terminals_that_have_no_tab() {
        use crate::pty::RunSpec;
        let app = tauri::test::mock_app();
        let pm = PtyManager::default();
        let spawn = |kind| {
            pm.spawn(
                app.handle().clone(),
                80,
                24,
                Some("/tmp".into()),
                None,
                None,
                Some(RunSpec::Argv(vec!["sleep".into(), "30".into()])),
                kind,
                None,
                None,
                None,
            )
            .expect("spawn")
            .id
        };
        let visible = spawn(SessionKind::Remote);
        let hidden = spawn(SessionKind::Detached);
        let ids: Vec<u32> = pm.list_terminals().iter().map(|s| s.id).collect();
        assert_eq!(ids, vec![visible]);
        assert!(pm.attach_terminal(visible).is_some());
        assert!(pm.attach_terminal(hidden).is_none());
        assert_eq!(pm.write_terminal(hidden, b"x"), Err(TermError::Gone));
        assert_eq!(pm.resize_terminal(hidden, 10, 10), Err(TermError::Gone));
        assert_eq!(pm.write_terminal(9999, b"x"), Err(TermError::Gone));
        assert!(pm.resize_terminal(visible, 100, 30).is_ok());
        assert_eq!(pm.list_terminals()[0].running, true);
        let _ = pm.kill(visible);
        let _ = pm.kill(hidden);
    }
}
