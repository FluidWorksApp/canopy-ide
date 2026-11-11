//! TCP over the installed Tailscale. The tailnet carries and encrypts the
//! packets; this transport adds the part the tailnet does not decide, who may
//! open a session.
//!
//! - The listener binds ONLY the node's own tailnet addresses, as the CLI's
//!   status reports them, only while the backend is running, and only if each
//!   address is inside Tailscale's ranges (100.64.0.0/10 or fd7a:115c:a1e0::/48):
//!   the status is not trusted enough to pick an arbitrary address. If no
//!   tailnet interface exists (a userspace-mode tailscaled has none) the bind
//!   fails with a typed error; it never widens to another address.
//! - A peer's identity comes from `whois --json <its address>`, keyed on the
//!   stable node id and user id (or tags), never on names. It identifies a
//!   MACHINE, not a person. A node that routes more than its own addresses
//!   (subnet router, exit node) is refused, as is an address routed through a
//!   node rather than owned by it.
//! - Tailnet membership is NOT authorisation: the identity must also be in the
//!   [`Allowlist`]. The decision takes only the peer's socket address, so no
//!   byte of the stream is read before it, by construction. A whois failure,
//!   timeout or empty answer is a refusal (fail closed).
//! - An entry is bound to the tailnet it was approved on (`@<domain>`, see
//!   [`canonical_tailnet_entry`](crate::allowlist::canonical_tailnet_entry)).
//!   The accept side takes this machine's own tailnet from the status (cached
//!   [`STATUS_TTL`]) and admits a peer only if whois places the peer in that
//!   same tailnet, so a stable id and user id reused on another tailnet or
//!   control server, or a node shared in from another tailnet, never match. If
//!   this machine's tailnet cannot be read, everything is refused. A source
//!   that is this machine (its own tailnet address, or whois naming this node)
//!   is refused too.
//! - A removed entry ends its live connections, not only its next one: a
//!   background sweep every [`REVOCATION_POLL`] shuts down any admitted
//!   connection whose entry has left the allowlist, or whose tailnet is no
//!   longer this machine's. Shutdown is abrupt (the peer's reads and writes
//!   fail), within about that interval. What is NOT re-checked mid-connection
//!   is the tailnet's own view of the peer (a retag, or the node being deleted):
//!   that is decided at admission; the tailnet itself stops carrying the
//!   packets if its ACLs forbid them.
//! - Whois runs on a small worker pool fed by a bounded queue, so one slow
//!   lookup does not stall the listener; a full queue drops the connection.
//!   At most [`PENDING_PER_SOURCE`] connections per source address wait in that
//!   queue, so one address cannot fill it. Answers are cached briefly
//!   (successes [`WHOIS_TTL`], failures [`NEGATIVE_TTL`]).
//! - Lookup budgets are separate lanes, each [`RATE_WINDOW`] long, so a flood
//!   on one cannot starve another: peers the status lists whose stable id is in
//!   the allowlist (known) have their own budget; every other source shares the
//!   unknown budget; dialing has its own. Failed lookups and refusals are rate
//!   limited per source address, except for known peers, who never count. When
//!   a cache is full the OLDEST entry is evicted; a flood of addresses never
//!   resets the others' counters.
//! - Only tailnet source addresses are considered on accept: a connection from
//!   any other address is refused before any lookup runs.
//! - Dialing needs no allowlist entry (connecting out is the user's own act).
//!   It resolves names from the status peer list (never system DNS), only to
//!   nodes in THIS machine's tailnet (a node shared in from another tailnet is
//!   never matched, by short name, full name or address), refuses this
//!   machine's own addresses, and checks with `whois` that the address belongs
//!   to the node the status listed (same stable node id, same tailnet) before
//!   connecting. The allowlist governs inbound only.
//! - Every channel and queue is bounded; whois spawns are limited per lane
//!   and per source.
//! - The CLI version is checked once, when the transport is created.
//!
//! No stream preface: a TCP connection is visible to the acceptor on connect,
//! so `accept` returns when a peer connects. The session protocol's hello and
//! spawn key travel on the stream unchanged.

use crate::allowlist::{tailnet_domain_of, Allowlist};
use crate::tailscale::{
    CliRunner, NodeInfo, TailnetIdentity, TailnetState, TailnetStatus, Tailscale,
};
use crate::{Connection, FailedHalf, PeerIdentity, Refusal, Transport, TIMEOUT_KIND};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{IpAddr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

/// How long a successful whois answer is reused. Short, because a cached
/// identity outlives a retag or a node handing its address to another; the
/// cost of shortening it is one CLI spawn per expiry on a busy peer. The
/// allowlist itself is consulted on every use, so removing an entry is
/// immediate regardless.
pub const WHOIS_TTL: Duration = Duration::from_secs(10);
/// How long a failed whois is remembered, so a stranger cannot make every
/// connection spawn the CLI.
pub const NEGATIVE_TTL: Duration = Duration::from_secs(5);
/// Refusals (and failed lookups) allowed per source address per
/// [`RATE_WINDOW`]. Known peers never count.
pub const RATE_LIMIT: u32 = 20;
pub const RATE_WINDOW: Duration = Duration::from_secs(60);
/// Whois spawns per [`RATE_WINDOW`] for sources that are not known peers. Past
/// it a new lookup for such a source is refused (fail closed), so many tailnet
/// addresses together cannot make this process spawn the CLI without bound.
pub const LOOKUP_LIMIT_UNKNOWN: u32 = 60;
/// Whois spawns per [`RATE_WINDOW`] reserved for known peers (listed in the
/// status with a stable id the allowlist holds): unknown sources cannot use it.
pub const LOOKUP_LIMIT_KNOWN: u32 = 60;
/// Whois spawns per [`RATE_WINDOW`] reserved for dialing, which is the user's
/// own act and must not be starved by inbound strangers.
pub const LOOKUP_LIMIT_DIAL: u32 = 60;
/// Connections per source address allowed to wait for a decision at once.
/// Small next to the queue (64), so one address cannot fill it, yet enough for
/// a peer opening several control connections in a burst.
pub const PENDING_PER_SOURCE: u32 = 8;
/// How long this machine's own view of the tailnet (its addresses, node id and
/// tailnet, and the peer list) is reused. After an account switch the old
/// tailnet is still believed for at most this long.
pub const STATUS_TTL: Duration = Duration::from_secs(10);
/// How often live connections are checked against the allowlist.
pub const REVOCATION_POLL: Duration = Duration::from_millis(250);
/// Admitted connections tracked at once; past it a new one is refused.
pub const MAX_LIVE: usize = 1024;
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);
const CACHE_LIMIT: usize = 256;
const WORKERS: usize = 4;
const QUEUE: usize = 64;

pub type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

/// Why a listener could not be bound.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindError {
    /// Tailscale is not running, too old, or not installed.
    NotRunning(TailnetState),
    /// The status lists no address for this node.
    NoTailnetAddress,
    /// An address that must never be bound (unspecified or multicast).
    UnsafeAddress(IpAddr),
    /// An address outside Tailscale's ranges.
    NotTailnetAddress(IpAddr),
    /// None of the node's tailnet addresses could be bound: no tailnet
    /// interface, as with a userspace-mode daemon. Not widened.
    NoTailnetInterface(io::ErrorKind),
}

impl std::fmt::Display for BindError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BindError::NotRunning(s) => write!(f, "tailscale is not usable ({s:?})"),
            BindError::NoTailnetAddress => write!(f, "no tailnet address for this node"),
            BindError::UnsafeAddress(a) => write!(f, "refusing to bind {a}"),
            BindError::NotTailnetAddress(a) => write!(f, "{a} is not a tailnet address"),
            BindError::NoTailnetInterface(k) => {
                write!(f, "no tailnet interface to bind ({k:?})")
            }
        }
    }
}

impl std::error::Error for BindError {}

/// Inside Tailscale's address ranges: 100.64.0.0/10 or fd7a:115c:a1e0::/48.
pub fn is_tailnet_addr(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 100 && (o[1] & 0xC0) == 64
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0
        }
    }
}

/// Which lookup budget a whois spawn is charged to.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Lane {
    /// Accept, source not a known peer.
    Unknown = 0,
    /// Accept, source is a known peer.
    Known = 1,
    /// Dialing out.
    Dial = 2,
}

/// This machine's own view of the tailnet, from one status.
struct NetView {
    /// This node's stable id.
    stable_id: Option<String>,
    /// This machine's tailnet (DNS domain); `None` if the status names none.
    domain: Option<String>,
    /// This machine's own tailnet addresses.
    addrs: Vec<IpAddr>,
    /// Each listed peer address and the stable id of its node.
    peers: HashMap<IpAddr, String>,
}

impl NetView {
    fn from_status(s: &TailnetStatus) -> Option<NetView> {
        let me = s.self_node.as_ref()?;
        let mut peers = HashMap::new();
        for p in &s.peers {
            if let Some(id) = &p.stable_id {
                for a in &p.addrs {
                    peers.insert(a.to_canonical(), id.clone());
                }
            }
        }
        Some(NetView {
            stable_id: me.stable_id.clone(),
            domain: tailnet_domain_of(&me.dns_name),
            addrs: me.addrs.iter().map(|a| a.to_canonical()).collect(),
            peers,
        })
    }
}

#[derive(Default)]
struct GateState {
    positive: HashMap<IpAddr, (TailnetIdentity, Instant)>,
    negative: HashMap<IpAddr, Instant>,
    /// Count and window start per source address.
    rate: HashMap<IpAddr, (u32, Instant)>,
    /// Count and window start per [`Lane`].
    lanes: [Option<(u32, Instant)>; 3],
    /// Connections per source waiting for a decision.
    pending: HashMap<IpAddr, u32>,
    /// The cached view and when it expires; `None` inside is a cached failure.
    view: Option<(Option<Arc<NetView>>, Instant)>,
}

/// Make room for `key` in a bounded cache: drop what has expired, and if it is
/// still full evict the single oldest entry. Never clears the map, so a flood
/// of distinct addresses cannot reset what other addresses have accumulated.
fn make_room<V>(
    map: &mut HashMap<IpAddr, V>,
    key: &IpAddr,
    expired: impl Fn(&V) -> bool,
    age: impl Fn(&V) -> Instant,
) {
    if map.len() < CACHE_LIMIT || map.contains_key(key) {
        return;
    }
    map.retain(|_, v| !expired(v));
    if map.len() >= CACHE_LIMIT {
        let oldest = map.iter().min_by_key(|(_, v)| age(v)).map(|(k, _)| *k);
        if let Some(k) = oldest {
            map.remove(&k);
        }
    }
}

/// An admitted connection the revocation sweep watches.
struct Live {
    entry: String,
    /// The tailnet it was admitted on.
    domain: String,
    /// A handle to the same socket, to shut it down.
    stream: TcpStream,
    /// Dead once every half of the connection has been dropped.
    alive: Weak<()>,
}

/// The authorisation decision and its caches, shared with the worker threads.
struct Gate {
    ts: Tailscale,
    allow: Allowlist,
    state: Mutex<GateState>,
    /// Held while the status is fetched, so concurrent callers share one spawn.
    refresh: Mutex<()>,
    live: Mutex<Vec<Live>>,
    clock: Clock,
    /// Test only: also treat loopback as an acceptable source, and allow the
    /// source to be this machine's own address (a loopback test server cannot
    /// have a different address from its client).
    loopback_ok: AtomicBool,
}

impl Gate {
    /// Count a refusal or failed lookup for `ip`; `false` once it is over the
    /// limit.
    fn charge(st: &mut GateState, ip: IpAddr, now: Instant) -> bool {
        make_room(
            &mut st.rate,
            &ip,
            |(_, start)| now >= *start + RATE_WINDOW,
            |(_, start)| *start,
        );
        let e = st.rate.entry(ip).or_insert((0, now));
        if now >= e.1 + RATE_WINDOW {
            *e = (0, now);
        }
        e.0 = e.0.saturating_add(1);
        e.0 <= RATE_LIMIT
    }

    /// Count one whois spawn against `lane`; `false` once over its budget.
    fn lane_ok(st: &mut GateState, lane: Lane, now: Instant) -> bool {
        let limit = match lane {
            Lane::Unknown => LOOKUP_LIMIT_UNKNOWN,
            Lane::Known => LOOKUP_LIMIT_KNOWN,
            Lane::Dial => LOOKUP_LIMIT_DIAL,
        };
        let e = st.lanes[lane as usize].get_or_insert((0, now));
        if now >= e.1 + RATE_WINDOW {
            *e = (0, now);
        }
        e.0 = e.0.saturating_add(1);
        e.0 <= limit
    }

    fn over_limit(st: &GateState, ip: IpAddr, now: Instant) -> bool {
        st.rate
            .get(&ip)
            .is_some_and(|(n, start)| now < *start + RATE_WINDOW && *n >= RATE_LIMIT)
    }

    /// Reserve one of `ip`'s [`PENDING_PER_SOURCE`] places in the queue.
    fn enter(&self, ip: IpAddr) -> bool {
        let ip = ip.to_canonical();
        let Ok(mut st) = self.state.lock() else {
            return false;
        };
        let n = st.pending.entry(ip).or_insert(0);
        if *n >= PENDING_PER_SOURCE {
            return false;
        }
        *n += 1;
        true
    }

    /// Give a place back, whether the connection was decided or dropped.
    fn leave(&self, ip: IpAddr) {
        let ip = ip.to_canonical();
        if let Ok(mut st) = self.state.lock() {
            let gone = match st.pending.get_mut(&ip) {
                Some(n) => {
                    *n = n.saturating_sub(1);
                    *n == 0
                }
                None => false,
            };
            if gone {
                st.pending.remove(&ip);
            }
        }
    }

    fn cached_view(&self) -> Option<Option<Arc<NetView>>> {
        let st = self.state.lock().ok()?;
        let now = (self.clock)();
        match &st.view {
            Some((v, exp)) if now < *exp => Some(v.clone()),
            _ => None,
        }
    }

    /// This machine's own view of the tailnet: cached [`STATUS_TTL`] (a failure
    /// [`NEGATIVE_TTL`]), one status spawn at a time. `None` if it cannot be
    /// read, which callers treat as a refusal.
    fn view(&self) -> Option<Arc<NetView>> {
        if let Some(v) = self.cached_view() {
            return v;
        }
        let _single = self.refresh.lock().ok()?;
        // Another caller may have refreshed it while this one waited.
        if let Some(v) = self.cached_view() {
            return v;
        }
        let now = (self.clock)();
        let built = self
            .ts
            .running_status()
            .ok()
            .and_then(|s| NetView::from_status(&s))
            .map(Arc::new);
        let ttl = if built.is_some() {
            STATUS_TTL
        } else {
            NEGATIVE_TTL
        };
        let mut st = self.state.lock().ok()?;
        st.view = Some((built.clone(), now + ttl));
        built
    }

    /// Who the tailnet says owns `ip`, from the cache or a fresh whois charged
    /// to `lane`. With `charge`, failures and cache hits on a failure count
    /// against `ip`'s own limit. Any failure, a limit hit, or a poisoned lock
    /// is `None`.
    fn identify(&self, ip: IpAddr, lane: Lane, charge: bool) -> Option<TailnetIdentity> {
        let ip = ip.to_canonical();
        let now = (self.clock)();
        {
            let mut st = self.state.lock().ok()?;
            if let Some((id, exp)) = st.positive.get(&ip) {
                if now < *exp {
                    return Some(id.clone());
                }
            }
            st.positive.remove(&ip);
            if st.negative.get(&ip).is_some_and(|exp| now < *exp) {
                if charge {
                    Gate::charge(&mut st, ip, now);
                }
                return None;
            }
            if charge && Gate::over_limit(&st, ip, now) {
                return None;
            }
            if !Gate::lane_ok(&mut st, lane, now) {
                return None;
            }
        }
        // The lock is not held while the CLI runs.
        let looked_up = self.ts.whois(ip);
        let mut st = self.state.lock().ok()?;
        match looked_up {
            Ok(id) => {
                make_room(&mut st.positive, &ip, |(_, e)| now >= *e, |(_, e)| *e);
                st.positive.insert(ip, (id.clone(), now + WHOIS_TTL));
                Some(id)
            }
            Err(_) => {
                if charge {
                    Gate::charge(&mut st, ip, now);
                }
                make_room(&mut st.negative, &ip, |e| now >= *e, |e| *e);
                st.negative.insert(ip, now + NEGATIVE_TTL);
                None
            }
        }
    }

    /// Count a refusal against `ip`, unless it is a known peer.
    fn penalize(&self, ip: IpAddr, now: Instant, known: bool) {
        if known {
            return;
        }
        if let Ok(mut st) = self.state.lock() {
            Gate::charge(&mut st, ip, now);
        }
    }

    /// From the peer's address alone: its identity entry if the tailnet vouches
    /// for it AND it is in this machine's own tailnet AND the allowlist holds
    /// it, else `None`. Any failure, including a poisoned lock or an unreadable
    /// status, is `None`. The entry returned carries the tailnet (`@<domain>`).
    fn authorize(&self, ip: IpAddr) -> Option<String> {
        let ip = ip.to_canonical();
        let now = (self.clock)();
        // Who this machine is and which tailnet it is on: without it nothing
        // about the peer can be checked.
        let view = self.view()?;
        // This machine's own address is never a peer (another local process
        // reaching the listener through the tailnet address would otherwise be
        // identified as this node).
        if !self.loopback_ok.load(Ordering::SeqCst) && view.addrs.contains(&ip) {
            return None;
        }
        let known = view
            .peers
            .get(&ip)
            .is_some_and(|sid| self.allow.has_stable_id(sid));
        let lane = if known { Lane::Known } else { Lane::Unknown };
        let identity = self.identify(ip, lane, !known)?;
        // whois naming this very node is this machine, not a peer.
        if view.stable_id.as_deref() == Some(identity.stable_id()) {
            return None;
        }
        let same_tailnet = match (identity.tailnet(), view.domain.as_deref()) {
            (Some(peer), Some(own)) => peer == own,
            _ => false,
        };
        if !same_tailnet {
            self.penalize(ip, now, known);
            return None;
        }
        let entry = identity.allowlist_entry();
        if self.allow.contains(&entry) {
            Some(entry)
        } else {
            self.penalize(ip, now, known);
            None
        }
    }

    /// Track an admitted connection for the revocation sweep. The returned
    /// token lives as long as the connection's halves.
    fn register(&self, entry: &str, domain: &str, stream: &TcpStream) -> Option<Arc<()>> {
        let handle = stream.try_clone().ok()?;
        let token = Arc::new(());
        let mut live = self.live.lock().ok()?;
        live.retain(|l| l.alive.strong_count() > 0);
        if live.len() >= MAX_LIVE {
            return None;
        }
        live.push(Live {
            entry: entry.to_string(),
            domain: domain.to_string(),
            stream: handle,
            alive: Arc::downgrade(&token),
        });
        Some(token)
    }

    /// Shut down every live connection whose entry is no longer in the
    /// allowlist, or whose tailnet is no longer this machine's. An unreadable
    /// status is not evidence of a change, so it closes nothing.
    fn sweep(&self) {
        let any = match self.live.lock() {
            Ok(mut live) => {
                live.retain(|l| l.alive.strong_count() > 0);
                !live.is_empty()
            }
            Err(_) => return,
        };
        if !any {
            return;
        }
        // Outside the live lock: the status may spawn the CLI.
        let current = self.view().and_then(|v| v.domain.clone());
        let Ok(mut live) = self.live.lock() else {
            return;
        };
        live.retain(|l| {
            let revoked = !self.allow.contains(&l.entry);
            let moved = current.as_deref().is_some_and(|d| d != l.domain);
            if revoked || moved {
                let _ = l.stream.shutdown(Shutdown::Both);
                false
            } else {
                true
            }
        });
    }

    fn admit(&self, stream: TcpStream, peer: SocketAddr) -> Result<Box<dyn Connection>, Refusal> {
        // Nothing has been read from `stream`; the decision uses the address.
        // Only tailnet addresses are looked up at all.
        let ip = peer.ip().to_canonical();
        if !(is_tailnet_addr(ip) || (ip.is_loopback() && self.loopback_ok.load(Ordering::SeqCst))) {
            drop(stream);
            return Err(Refusal::UnknownPeer);
        }
        let Some(entry) = self.authorize(peer.ip()) else {
            drop(stream);
            return Err(Refusal::UnknownPeer);
        };
        if stream.set_nonblocking(false).is_err() {
            return Err(Refusal::UnknownPeer);
        }
        let domain = entry
            .rsplit_once('@')
            .map(|(_, d)| d.to_string())
            .unwrap_or_default();
        let Some(live) = self.register(&entry, &domain, &stream) else {
            return Err(Refusal::UnknownPeer);
        };
        let _ = stream.set_nodelay(true);
        Ok(Box::new(TcpConn {
            stream,
            peer: PeerIdentity::Device(entry),
            live: Some(live),
        }))
    }
}

type Admitted = Result<Box<dyn Connection>, Refusal>;

pub struct TailnetTcp {
    gate: Arc<Gate>,
    /// The CLI version verdict, taken once at creation.
    version: Result<(), TailnetState>,
    local: Vec<SocketAddr>,
    results: Option<Mutex<mpsc::Receiver<Admitted>>>,
    stop: Arc<AtomicBool>,
}

impl Drop for TailnetTcp {
    /// Stops the listener and revocation threads; the workers follow when the
    /// queue closes.
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl TailnetTcp {
    /// A dial-only transport.
    pub fn client(runner: Arc<dyn CliRunner>, allow: Allowlist) -> Self {
        Self::client_with_clock(runner, allow, Arc::new(Instant::now))
    }

    /// A dial-only transport with an injected clock (tests).
    pub fn client_with_clock(runner: Arc<dyn CliRunner>, allow: Allowlist, clock: Clock) -> Self {
        let ts = Tailscale::new(runner);
        let version = ts.check_version();
        Self {
            gate: Arc::new(Gate {
                ts,
                allow,
                state: Mutex::new(GateState::default()),
                refresh: Mutex::new(()),
                live: Mutex::new(Vec::new()),
                clock,
                loopback_ok: AtomicBool::new(false),
            }),
            version,
            local: Vec::new(),
            results: None,
            stop: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Listen on the node's tailnet addresses at `port`. With port 0 each
    /// address gets its own port (see [`local_addrs`](Self::local_addrs)).
    pub fn bind(
        runner: Arc<dyn CliRunner>,
        allow: Allowlist,
        port: u16,
    ) -> Result<Self, BindError> {
        Self::bind_inner(runner, allow, port, Arc::new(Instant::now), false)
    }

    /// Test only: also accepts loopback, so CI can run a real listener.
    #[cfg(test)]
    pub(crate) fn bind_for_test(
        runner: Arc<dyn CliRunner>,
        allow: Allowlist,
        port: u16,
    ) -> Result<Self, BindError> {
        Self::bind_inner(runner, allow, port, Arc::new(Instant::now), true)
    }

    fn bind_inner(
        runner: Arc<dyn CliRunner>,
        allow: Allowlist,
        port: u16,
        clock: Clock,
        allow_loopback: bool,
    ) -> Result<Self, BindError> {
        let mut t = Self::client_with_clock(runner, allow, clock);
        t.gate.loopback_ok.store(allow_loopback, Ordering::SeqCst);
        let probe = t.gate.ts.probe();
        if probe.state != TailnetState::Running {
            return Err(BindError::NotRunning(probe.state));
        }
        let addrs: Vec<IpAddr> = probe
            .status
            .and_then(|s| s.self_node)
            .map(|n| n.addrs)
            .unwrap_or_default()
            .into_iter()
            .map(|a| a.to_canonical())
            .collect();
        if addrs.is_empty() {
            return Err(BindError::NoTailnetAddress);
        }
        for a in &addrs {
            if a.is_unspecified() || a.is_multicast() {
                return Err(BindError::UnsafeAddress(*a));
            }
            if !(is_tailnet_addr(*a) || (allow_loopback && a.is_loopback())) {
                return Err(BindError::NotTailnetAddress(*a));
            }
        }
        let mut listeners = Vec::new();
        let mut last = io::ErrorKind::Other;
        for a in addrs {
            match TcpListener::bind(SocketAddr::new(a, port)) {
                Ok(l) => match l.set_nonblocking(true) {
                    Ok(()) => listeners.push(l),
                    Err(e) => last = e.kind(),
                },
                Err(e) => last = e.kind(),
            }
        }
        if listeners.is_empty() {
            return Err(BindError::NoTailnetInterface(last));
        }
        t.local = listeners
            .iter()
            .filter_map(|l| l.local_addr().ok())
            .collect();
        t.start(listeners);
        Ok(t)
    }

    /// One listener thread feeding a bounded queue, a few workers that run the
    /// (possibly slow) authorisation and post results for `accept`, and a
    /// sweep thread that ends connections whose entry was removed.
    fn start(&mut self, listeners: Vec<TcpListener>) {
        let (job_tx, job_rx) = mpsc::sync_channel::<(TcpStream, SocketAddr)>(QUEUE);
        let (res_tx, res_rx) = mpsc::sync_channel::<Admitted>(QUEUE);
        let job_rx = Arc::new(Mutex::new(job_rx));
        for _ in 0..WORKERS {
            let job_rx = job_rx.clone();
            let res_tx = res_tx.clone();
            let gate = self.gate.clone();
            std::thread::spawn(move || loop {
                let job = match job_rx.lock() {
                    Ok(rx) => rx.recv(),
                    Err(_) => break,
                };
                let Ok((stream, peer)) = job else { break };
                let source = peer.ip();
                let decided = gate.admit(stream, peer);
                gate.leave(source);
                if res_tx.send(decided).is_err() {
                    break;
                }
            });
        }
        let stop = self.stop.clone();
        let gate = self.gate.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                let mut busy = false;
                for l in &listeners {
                    if let Ok((stream, peer)) = l.accept() {
                        busy = true;
                        // A source with its places taken, or a full queue,
                        // drops the connection unread.
                        let source = peer.ip();
                        if gate.enter(source) && job_tx.try_send((stream, peer)).is_err() {
                            gate.leave(source);
                        }
                    }
                }
                if !busy {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            // Dropping job_tx ends the workers.
        });
        let stop = self.stop.clone();
        let gate = self.gate.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                std::thread::sleep(REVOCATION_POLL);
                gate.sweep();
            }
        });
        self.results = Some(Mutex::new(res_rx));
    }

    /// The addresses actually bound.
    pub fn local_addrs(&self) -> Vec<SocketAddr> {
        self.local.clone()
    }

    pub fn allowlist(&self) -> &Allowlist {
        &self.gate.allow
    }

    #[cfg(test)]
    pub(crate) fn authorize(&self, ip: IpAddr) -> Option<String> {
        self.gate.authorize(ip)
    }
}

/// Split `host:port`, `1.2.3.4:port` or `[v6]:port`.
fn split_host_port(address: &str) -> io::Result<(Result<IpAddr, String>, u16)> {
    let bad = |m: &str| io::Error::new(io::ErrorKind::InvalidInput, m.to_string());
    if let Ok(sa) = address.parse::<SocketAddr>() {
        return Ok((Ok(sa.ip()), sa.port()));
    }
    let (host, port) = address
        .rsplit_once(':')
        .ok_or_else(|| bad("expected host:port"))?;
    let port: u16 = port.parse().map_err(|_| bad("bad port"))?;
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() || host.contains(['/', ' ', '[', ']']) {
        return Err(bad("bad host"));
    }
    Ok((Err(host), port))
}

fn nodes(status: &TailnetStatus) -> impl Iterator<Item = &NodeInfo> {
    status.peers.iter().chain(status.self_node.iter())
}

/// The node a dial name or address resolved to.
struct Resolved {
    /// The stable node id the status lists for it, checked against whois.
    stable_id: Option<String>,
    addrs: Vec<IpAddr>,
    /// This machine's tailnet, which the node must be in and whois must agree.
    domain: String,
}

fn own_addresses(status: &TailnetStatus) -> Vec<IpAddr> {
    status
        .self_node
        .iter()
        .flat_map(|n| n.addrs.iter().map(|a| a.to_canonical()))
        .collect()
}

fn refuse_own() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "refusing to dial this machine's own address",
    )
}

/// The node for `host`, from the tailnet's own node list only, and only among
/// nodes in this machine's own tailnet: a node shared in from another tailnet
/// is never matched, so it can neither be reached by a name that collides with
/// a local one nor make a local name ambiguous. This machine's own addresses
/// are refused.
fn resolve(status: &TailnetStatus, host: &Result<IpAddr, String>) -> io::Result<Resolved> {
    let own = own_addresses(status);
    let Some(domain) = status
        .self_node
        .as_ref()
        .and_then(|n| tailnet_domain_of(&n.dns_name))
    else {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "this machine's tailnet cannot be determined",
        ));
    };
    let in_tailnet =
        |n: &NodeInfo| tailnet_domain_of(&n.dns_name).as_deref() == Some(domain.as_str());
    match host {
        Ok(ip) => {
            let ip = ip.to_canonical();
            if own.contains(&ip) {
                return Err(refuse_own());
            }
            match nodes(status)
                .find(|n| in_tailnet(*n) && n.addrs.iter().any(|a| a.to_canonical() == ip))
            {
                Some(n) => Ok(Resolved {
                    stable_id: n.stable_id.clone(),
                    addrs: vec![ip],
                    domain,
                }),
                None => Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "address is not a node of this machine's tailnet",
                )),
            }
        }
        Err(name) => {
            let matches: Vec<&NodeInfo> = nodes(status)
                .filter(|n| {
                    in_tailnet(*n)
                        && (n.dns_name == *name
                            || (!name.contains('.')
                                && n.dns_name.split('.').next() == Some(name.as_str())))
                })
                .collect();
            match matches.as_slice() {
                [] => Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "no such node on this tailnet",
                )),
                [one] => {
                    let is_self = status
                        .self_node
                        .as_ref()
                        .is_some_and(|s| std::ptr::eq(s, *one))
                        || one.addrs.iter().any(|a| own.contains(&a.to_canonical()));
                    if is_self {
                        return Err(refuse_own());
                    }
                    let mut addrs = one.addrs.clone();
                    addrs.sort_by_key(|a| a.is_ipv6());
                    if addrs.is_empty() {
                        Err(io::Error::new(
                            io::ErrorKind::NotFound,
                            "node has no address",
                        ))
                    } else {
                        Ok(Resolved {
                            stable_id: one.stable_id.clone(),
                            addrs,
                            domain,
                        })
                    }
                }
                _ => Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "name matches more than one node",
                )),
            }
        }
    }
}

impl Transport for TailnetTcp {
    /// `address` is `<node name or tailnet ip>:<port>`. The name may be the
    /// short name or the full MagicDNS name. Only nodes of this machine's own
    /// tailnet in the tailnet's own status are dialed, never this machine, and
    /// only after `whois` confirms the address belongs to the node the status
    /// listed (same stable id, same tailnet). No allowlist entry is needed to
    /// dial out.
    fn connect(&self, address: &str) -> io::Result<Box<dyn Connection>> {
        if let Err(s) = &self.version {
            return Err(io::Error::new(
                io::ErrorKind::NotConnected,
                format!("tailscale is not usable: {s:?}"),
            ));
        }
        let (host, port) = split_host_port(address)?;
        let status = self.gate.ts.running_status().map_err(|s| {
            io::Error::new(
                io::ErrorKind::NotConnected,
                format!("tailnet not running: {s:?}"),
            )
        })?;
        let mut last: Option<io::Error> = None;
        let target = resolve(&status, &host)?;
        let Some(want) = target.stable_id.as_deref() else {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the tailnet lists no stable id for this node",
            ));
        };
        for ip in target.addrs {
            // Identity first: an address whose owner is not the listed node
            // is never dialed.
            let Some(identity) = self.gate.identify(ip, Lane::Dial, false) else {
                last = Some(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "the tailnet does not vouch for this address",
                ));
                continue;
            };
            if identity.stable_id() != want {
                last = Some(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "the address belongs to a different node than listed",
                ));
                continue;
            }
            if identity.tailnet().as_deref() != Some(target.domain.as_str()) {
                last = Some(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "the node is not in this machine's tailnet",
                ));
                continue;
            }
            let entry = identity.allowlist_entry();
            match TcpStream::connect_timeout(&SocketAddr::new(ip, port), DIAL_TIMEOUT) {
                Ok(stream) => {
                    let _ = stream.set_nodelay(true);
                    return Ok(Box::new(TcpConn {
                        stream,
                        peer: PeerIdentity::Device(entry),
                        live: None,
                    }));
                }
                Err(e) => last = Some(e),
            }
        }
        Err(last.unwrap_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no address")))
    }

    /// Blocks until a peer has been decided. An unknown peer yields
    /// `Ok(Err(Refusal::UnknownPeer))` with nothing read from it.
    fn accept(&self) -> io::Result<Result<Box<dyn Connection>, Refusal>> {
        let Some(results) = &self.results else {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "dial-only transport cannot accept",
            ));
        };
        let rx = results
            .lock()
            .map_err(|_| io::Error::other("transport state poisoned"))?;
        rx.recv()
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "transport closed"))
    }
}

struct TcpConn {
    stream: TcpStream,
    peer: PeerIdentity,
    /// Keeps an accepted connection visible to the revocation sweep until its
    /// last half is dropped. `None` for a connection this side dialed.
    live: Option<Arc<()>>,
}

impl Connection for TcpConn {
    fn peer(&self) -> &PeerIdentity {
        &self.peer
    }

    fn set_read_deadline(&mut self, deadline: Option<Duration>) -> io::Result<()> {
        // A zero timeout is an error for the OS call; the shortest real bound.
        let d = deadline.map(|d| d.max(Duration::from_millis(1)));
        self.stream.set_read_timeout(d)
    }

    fn split(self: Box<Self>) -> (Box<dyn Read + Send>, Box<dyn Write + Send>) {
        // The read timeout belongs to the shared socket, so a deadline set
        // before the split still applies to the read half. If the dup fails
        // (out of descriptors) both halves report that error.
        let TcpConn { stream, live, .. } = *self;
        match stream.try_clone() {
            Ok(read) => (
                Box::new(ReadHalf(read, live.clone())),
                Box::new(WriteHalf(stream, live)),
            ),
            Err(e) => {
                let kind = e.kind();
                (Box::new(FailedHalf(kind)), Box::new(FailedHalf(kind)))
            }
        }
    }
}

/// The second field keeps the connection registered with the revocation sweep.
struct ReadHalf(TcpStream, #[allow(dead_code)] Option<Arc<()>>);

impl Read for ReadHalf {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf).map_err(|e| {
            // WouldBlock on unix, TimedOut on Windows: one kind for callers.
            if matches!(
                e.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
            ) {
                io::Error::new(TIMEOUT_KIND, "read deadline")
            } else {
                e
            }
        })
    }
}

struct WriteHalf(TcpStream, #[allow(dead_code)] Option<Arc<()>>);

impl Write for WriteHalf {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

impl Drop for WriteHalf {
    /// Closing the write half is EOF for the peer's reader.
    fn drop(&mut self) {
        let _ = self.0.shutdown(Shutdown::Write);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tailscale::fake::*;
    use crate::watchdog;

    const ENTRY: &str = "tailnet:user/nPEERB1CNTRL/42@example.ts.net";

    fn loopback() -> IpAddr {
        "127.0.0.1".parse().unwrap()
    }

    /// A server node on 127.0.0.1 whose whois says every caller is the user
    /// behind ENTRY.
    fn server_runner() -> Arc<FakeRunner> {
        let r = Arc::new(FakeRunner::new(&status_running(&["127.0.0.1"], &[])));
        r.set_whois(loopback(), Ok(whois_user("nPEERB1CNTRL", 42)));
        r
    }

    /// A client whose tailnet lists the server as node-b at 127.0.0.1.
    fn client_runner() -> Arc<FakeRunner> {
        let r = Arc::new(FakeRunner::new(&status_running(
            &["100.64.0.1"],
            &["127.0.0.1"],
        )));
        r.set_whois(loopback(), Ok(whois_user("nPEERB1CNTRL", 42)));
        r
    }

    fn allow(entries: &[&str]) -> Allowlist {
        let a = Allowlist::new();
        for e in entries {
            a.add(e).unwrap();
        }
        a
    }

    fn port_of(t: &TailnetTcp) -> u16 {
        t.local_addrs()[0].port()
    }

    #[test]
    fn bind_needs_a_running_tailnet() {
        let r = Arc::new(FakeRunner::new(r#"{"BackendState":"NeedsLogin"}"#));
        let e = TailnetTcp::bind(r, allow(&[]), 0).err().unwrap();
        assert_eq!(e, BindError::NotRunning(TailnetState::NeedsLogin));
        let r = Arc::new(FakeRunner::new(r#"{"BackendState":"Weird"}"#));
        let e = TailnetTcp::bind(r, allow(&[]), 0).err().unwrap();
        assert_eq!(
            e,
            BindError::NotRunning(TailnetState::Unknown("Weird".into()))
        );
    }

    #[test]
    fn bind_refuses_unspecified_and_missing_addresses() {
        let r = Arc::new(FakeRunner::new(&status_running(&["0.0.0.0"], &[])));
        assert_eq!(
            TailnetTcp::bind(r, allow(&[]), 0).err().unwrap(),
            BindError::UnsafeAddress("0.0.0.0".parse().unwrap())
        );
        let r = Arc::new(FakeRunner::new(&status_running(&["127.0.0.1", "::"], &[])));
        assert_eq!(
            TailnetTcp::bind_for_test(r, allow(&[]), 0).err().unwrap(),
            BindError::UnsafeAddress("::".parse().unwrap())
        );
        let r = Arc::new(FakeRunner::new(&status_running(&[], &[])));
        assert_eq!(
            TailnetTcp::bind(r, allow(&[]), 0).err().unwrap(),
            BindError::NoTailnetAddress
        );
    }

    #[test]
    fn bind_without_a_tailnet_interface_fails_and_never_widens() {
        // In-range tailnet addresses that are on no interface here, like the
        // tailnet addresses of a userspace-mode daemon.
        let r = Arc::new(FakeRunner::new(&status_running(
            &["100.64.0.77", "fd7a:115c:a1e0::77"],
            &[],
        )));
        let e = TailnetTcp::bind(r, allow(&[]), 0).err().unwrap();
        assert!(matches!(e, BindError::NoTailnetInterface(_)), "{e:?}");
    }

    #[test]
    fn listener_binds_only_the_reported_address() {
        let t = TailnetTcp::bind_for_test(server_runner(), allow(&[]), 0).unwrap();
        let addrs = t.local_addrs();
        assert_eq!(addrs.len(), 1);
        assert_eq!(addrs[0].ip(), loopback());
        assert!(!addrs[0].ip().is_unspecified());
    }

    #[test]
    fn allowlisted_peer_connects_and_echoes() {
        watchdog(60, || {
            let server =
                Arc::new(TailnetTcp::bind_for_test(server_runner(), allow(&[ENTRY]), 0).unwrap());
            let port = port_of(&server);
            let s = server.clone();
            let t = std::thread::spawn(move || {
                let conn = s.accept().unwrap().unwrap();
                assert_eq!(conn.peer(), &PeerIdentity::Device(ENTRY.to_string()));
                let (mut r, mut w) = conn.split();
                std::io::copy(&mut r, &mut w).unwrap();
            });
            let client = TailnetTcp::client(client_runner(), allow(&[ENTRY]));
            let conn = client.connect(&format!("127.0.0.1:{port}")).unwrap();
            assert_eq!(conn.peer(), &PeerIdentity::Device(ENTRY.to_string()));
            let (mut r, mut w) = conn.split();
            w.write_all(b"hello tailnet").unwrap();
            let mut out = [0u8; 13];
            r.read_exact(&mut out).unwrap();
            assert_eq!(&out, b"hello tailnet");
            drop(w);
            t.join().unwrap();
        });
    }

    #[test]
    fn short_name_full_name_and_address_reach_the_same_node() {
        watchdog(60, || {
            let server =
                Arc::new(TailnetTcp::bind_for_test(server_runner(), allow(&[ENTRY]), 0).unwrap());
            let port = port_of(&server);
            let s = server.clone();
            let t = std::thread::spawn(move || {
                (0..3)
                    .map(|_| s.accept().unwrap().unwrap())
                    .collect::<Vec<_>>()
            });
            let client = TailnetTcp::client(client_runner(), allow(&[ENTRY]));
            let held: Vec<_> = ["node-b", "node-b.example.ts.net", "127.0.0.1"]
                .iter()
                .map(|h| client.connect(&format!("{h}:{port}")).unwrap())
                .collect();
            for c in &held {
                assert_eq!(c.peer(), &PeerIdentity::Device(ENTRY.to_string()));
            }
            for c in t.join().unwrap() {
                assert_eq!(c.peer(), &PeerIdentity::Device(ENTRY.to_string()));
            }
        });
    }

    #[test]
    fn unknown_peer_is_refused_with_nothing_read() {
        watchdog(60, || {
            // The server's allowlist is empty: the tailnet vouches for the
            // caller but the allowlist does not.
            let server =
                Arc::new(TailnetTcp::bind_for_test(server_runner(), allow(&[]), 0).unwrap());
            let port = port_of(&server);
            let s = server.clone();
            let t = std::thread::spawn(move || s.accept().unwrap());
            let client = TailnetTcp::client(client_runner(), allow(&[ENTRY]));
            let conn = client.connect(&format!("node-b:{port}")).unwrap();
            let (mut r, mut w) = conn.split();
            let _ = w.write_all(b"sneaky session bytes");
            assert!(matches!(t.join().unwrap(), Err(Refusal::UnknownPeer)));
            let mut buf = [0u8; 8];
            match r.read(&mut buf) {
                Ok(0) | Err(_) => {}
                Ok(n) => panic!("a refused peer received {n} bytes"),
            }
        });
    }

    #[test]
    fn whois_failure_is_a_refusal() {
        watchdog(60, || {
            // Allowlisted identity exists, but this server's whois cannot answer.
            let r = Arc::new(FakeRunner::new(&status_running(&["127.0.0.1"], &[])));
            r.set_whois(loopback(), Err(crate::tailscale::CliError::TimedOut));
            let server = Arc::new(TailnetTcp::bind_for_test(r, allow(&[ENTRY]), 0).unwrap());
            let port = port_of(&server);
            let s = server.clone();
            let t = std::thread::spawn(move || s.accept().unwrap());
            let client = TailnetTcp::client(client_runner(), allow(&[ENTRY]));
            let _conn = client.connect(&format!("node-b:{port}")).unwrap();
            assert!(matches!(t.join().unwrap(), Err(Refusal::UnknownPeer)));
        });
    }

    #[test]
    fn tagged_nodes_need_their_own_entry() {
        let r = Arc::new(FakeRunner::new(&status_running(&["100.64.0.1"], &[])));
        r.set_whois(loopback(), Ok(whois_tagged("nBOXC1CNTRL", &["tag:ws"])));
        // A user entry with the same stable id does not authorise a tagged node.
        let t = TailnetTcp::client(
            r.clone(),
            allow(&["tailnet:user/nBOXC1CNTRL/99@example.ts.net"]),
        );
        assert_eq!(t.authorize(loopback()), None);
        let t = TailnetTcp::client(
            r,
            allow(&["tailnet:tagged/nBOXC1CNTRL/tag:ws@example.ts.net"]),
        );
        assert_eq!(
            t.authorize(loopback()).as_deref(),
            Some("tailnet:tagged/nBOXC1CNTRL/tag:ws@example.ts.net")
        );
    }

    fn clocked(r: Arc<FakeRunner>, entries: &[&str]) -> (TailnetTcp, Arc<Mutex<Duration>>) {
        let base = Instant::now();
        let offset = Arc::new(Mutex::new(Duration::ZERO));
        let o = offset.clone();
        let t = TailnetTcp::client_with_clock(
            r,
            allow(entries),
            Arc::new(move || base + *o.lock().unwrap()),
        );
        (t, offset)
    }

    #[test]
    fn whois_answers_are_cached_briefly_and_removal_is_immediate() {
        let r = Arc::new(FakeRunner::new(&status_running(&["100.64.0.1"], &[])));
        let (t, offset) = clocked(r.clone(), &[ENTRY]);
        // A failure is remembered for NEGATIVE_TTL: no second CLI spawn.
        r.set_whois(loopback(), Err(crate::tailscale::CliError::TimedOut));
        assert_eq!(t.authorize(loopback()), None);
        r.set_whois(loopback(), Ok(whois_user("nPEERB1CNTRL", 42)));
        assert_eq!(t.authorize(loopback()), None);
        assert_eq!(r.whois_calls(), 1);
        // After it, the lookup runs again and succeeds.
        let t1 = NEGATIVE_TTL + Duration::from_secs(1);
        *offset.lock().unwrap() = t1;
        assert_eq!(t.authorize(loopback()).as_deref(), Some(ENTRY));
        assert_eq!(r.whois_calls(), 2);
        // Within WHOIS_TTL the answer is reused.
        assert_eq!(t.authorize(loopback()).as_deref(), Some(ENTRY));
        assert_eq!(r.whois_calls(), 2);
        // The allowlist is still consulted every time.
        t.allowlist().remove(ENTRY);
        assert_eq!(t.authorize(loopback()), None);
        assert_eq!(r.whois_calls(), 2);
        t.allowlist().add(ENTRY).unwrap();
        // Past WHOIS_TTL it asks again.
        *offset.lock().unwrap() = t1 + WHOIS_TTL + Duration::from_secs(1);
        assert_eq!(t.authorize(loopback()).as_deref(), Some(ENTRY));
        assert_eq!(r.whois_calls(), 3);
    }

    #[test]
    fn lookups_and_refusals_are_rate_limited_per_source() {
        // The tailnet vouches for the caller, the allowlist does not.
        let r = Arc::new(FakeRunner::new(&status_running(&["100.64.0.1"], &[])));
        r.set_whois(loopback(), Ok(whois_user("nPEERB1CNTRL", 42)));
        let (t, offset) = clocked(r.clone(), &[]);
        for _ in 0..(RATE_LIMIT * 2) {
            assert_eq!(t.authorize(loopback()), None);
        }
        assert_eq!(r.whois_calls(), 1);
        // The cached answer expires inside the window: over the limit, no new
        // lookup is spawned.
        *offset.lock().unwrap() = WHOIS_TTL + Duration::from_secs(1);
        assert_eq!(t.authorize(loopback()), None);
        assert_eq!(r.whois_calls(), 1);
        // A new window allows lookups again.
        *offset.lock().unwrap() = RATE_WINDOW + Duration::from_secs(1);
        assert_eq!(t.authorize(loopback()), None);
        assert_eq!(r.whois_calls(), 2);
    }

    #[test]
    fn admitted_peers_never_count_against_the_limit() {
        let r = Arc::new(FakeRunner::new(&status_running(&["100.64.0.1"], &[])));
        r.set_whois(loopback(), Ok(whois_user("nPEERB1CNTRL", 42)));
        let (t, offset) = clocked(r.clone(), &[ENTRY]);
        for _ in 0..(RATE_LIMIT * 5) {
            assert_eq!(t.authorize(loopback()).as_deref(), Some(ENTRY));
        }
        // Many control connections later, a lookup after expiry still runs.
        *offset.lock().unwrap() = WHOIS_TTL + Duration::from_secs(1);
        assert_eq!(t.authorize(loopback()).as_deref(), Some(ENTRY));
        assert_eq!(r.whois_calls(), 2);
        // Nothing was charged to this address.
        assert!(!t.gate.state.lock().unwrap().rate.contains_key(&loopback()));
    }

    #[test]
    fn subnet_routers_are_refused() {
        let r = Arc::new(FakeRunner::new(&status_running(&["100.64.0.1"], &[])));
        r.set_whois(
            loopback(),
            Ok(
                r#"{"Node":{"StableID":"nRTR1CNTRL","Addresses":["127.0.0.1/32"],
                "AllowedIPs":["127.0.0.1/32","192.168.1.0/24"]},"UserProfile":{"ID":42}}"#
                    .to_string(),
            ),
        );
        let t = TailnetTcp::client(r, allow(&["tailnet:user/nRTR1CNTRL/42@example.ts.net"]));
        assert_eq!(t.authorize(loopback()), None);
    }

    #[test]
    fn public_bind_refuses_addresses_outside_tailnet_ranges() {
        for addr in ["127.0.0.1", "192.0.2.1", "100.128.0.1", "fd7a:115c:a1e1::1"] {
            let r = Arc::new(FakeRunner::new(&status_running(&[addr], &[])));
            assert_eq!(
                TailnetTcp::bind(r, allow(&[]), 0).err().unwrap(),
                BindError::NotTailnetAddress(addr.parse().unwrap()),
                "{addr}"
            );
        }
    }

    #[test]
    fn tailnet_range_boundaries() {
        let yes = |s: &str| is_tailnet_addr(s.parse().unwrap());
        assert!(yes("100.64.0.0"));
        assert!(yes("100.100.100.100"));
        assert!(yes("100.127.255.255"));
        assert!(!yes("100.63.255.255"));
        assert!(!yes("100.128.0.0"));
        assert!(!yes("10.0.0.1"));
        assert!(yes("fd7a:115c:a1e0::"));
        assert!(yes("fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff"));
        assert!(!yes("fd7a:115c:a1e1::"));
        assert!(!yes("fd7a:115c:a1df:ffff::"));
        assert!(yes("::ffff:100.64.0.1"));
        assert!(!yes("::ffff:127.0.0.1"));
    }

    #[test]
    fn a_too_old_cli_is_refused_at_creation() {
        let r = FakeRunner::new(&status_running(&["100.64.0.1"], &["127.0.0.1"]));
        *r.version.lock().unwrap() = Ok("1.40.0".into());
        let r = Arc::new(r);
        assert_eq!(
            TailnetTcp::bind(r.clone(), allow(&[]), 0).err().unwrap(),
            BindError::NotRunning(TailnetState::TooOld("1.40.0".into()))
        );
        let client = TailnetTcp::client(r, allow(&[ENTRY]));
        assert_eq!(
            client.connect("node-b:1").err().unwrap().kind(),
            io::ErrorKind::NotConnected
        );
    }

    #[test]
    fn a_poisoned_cache_refuses_instead_of_panicking() {
        let r = Arc::new(FakeRunner::new(&status_running(&["100.64.0.1"], &[])));
        r.set_whois(loopback(), Ok(whois_user("nPEERB1CNTRL", 42)));
        let t = Arc::new(TailnetTcp::client(r, allow(&[ENTRY])));
        assert_eq!(t.authorize(loopback()).as_deref(), Some(ENTRY));
        let t2 = t.clone();
        let _ = std::thread::spawn(move || {
            let _guard = t2.gate.state.lock().unwrap();
            panic!("poison the cache");
        })
        .join();
        assert_eq!(t.authorize(loopback()), None);
    }

    #[test]
    fn v4_mapped_addresses_are_canonicalised() {
        let r = Arc::new(FakeRunner::new(&status_running(&["100.64.0.1"], &[])));
        r.set_whois(loopback(), Ok(whois_user("nPEERB1CNTRL", 42)));
        let t = TailnetTcp::client(r, allow(&[ENTRY]));
        let mapped: IpAddr = "::ffff:127.0.0.1".parse().unwrap();
        assert_eq!(t.authorize(mapped).as_deref(), Some(ENTRY));
    }

    #[test]
    fn dialing_only_reaches_nodes_the_tailnet_lists() {
        let client = TailnetTcp::client(client_runner(), allow(&[ENTRY]));
        let kind = |a: &str| client.connect(a).err().unwrap().kind();
        // An address that is not a node, and names that match nothing.
        assert_eq!(kind("203.0.113.9:7000"), io::ErrorKind::PermissionDenied);
        assert_eq!(kind("nobody:7000"), io::ErrorKind::NotFound);
        assert_eq!(kind("nobody.example.com:7000"), io::ErrorKind::NotFound);
        assert_eq!(kind("no-port"), io::ErrorKind::InvalidInput);
        assert_eq!(kind("node-b:notaport"), io::ErrorKind::InvalidInput);
        assert_eq!(kind("bad/host:7000"), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn dialing_needs_no_allowlist_entry() {
        watchdog(60, || {
            let server =
                Arc::new(TailnetTcp::bind_for_test(server_runner(), allow(&[ENTRY]), 0).unwrap());
            let port = port_of(&server);
            let s = server.clone();
            let t = std::thread::spawn(move || s.accept().unwrap().is_ok());
            // The dialer's own allowlist is empty.
            let client = TailnetTcp::client(client_runner(), allow(&[]));
            let conn = client.connect(&format!("node-b:{port}")).unwrap();
            assert_eq!(conn.peer(), &PeerIdentity::Device(ENTRY.to_string()));
            assert!(t.join().unwrap());
        });
    }

    #[test]
    fn dialing_refuses_an_address_owned_by_a_different_node() {
        // The status lists node-b as nPEERB1CNTRL, but whois says the address
        // belongs to another node: never dialed (nothing listens on port 1,
        // so a connect attempt would be a different error).
        let r = client_runner();
        r.set_whois(loopback(), Ok(whois_user("nOTHERX1CNTRL", 42)));
        let client = TailnetTcp::client(r, allow(&[ENTRY]));
        assert_eq!(
            client.connect("node-b:1").err().unwrap().kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn dialing_refuses_when_whois_fails() {
        let r = client_runner();
        r.set_whois(loopback(), Err(crate::tailscale::CliError::TimedOut));
        let client = TailnetTcp::client(r, allow(&[ENTRY]));
        assert_eq!(
            client.connect("node-b:1").err().unwrap().kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn dialing_this_machine_is_refused() {
        let client = TailnetTcp::client(client_runner(), allow(&[ENTRY]));
        for a in ["100.64.0.1:1", "node-a:1", "node-a.example.ts.net:1"] {
            assert_eq!(
                client.connect(a).err().unwrap().kind(),
                io::ErrorKind::PermissionDenied,
                "{a}"
            );
        }
    }

    #[test]
    fn a_non_tailnet_source_is_refused_before_any_lookup() {
        let r = server_runner();
        let gate_t = TailnetTcp::client(r.clone(), allow(&[ENTRY]));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let _c = TcpStream::connect(addr).unwrap();
        let (stream, peer) = listener.accept().unwrap();
        // Loopback is not a tailnet address and loopback_ok is off here.
        assert!(matches!(
            gate_t.gate.admit(stream, peer),
            Err(Refusal::UnknownPeer)
        ));
        assert_eq!(r.whois_calls(), 0);
    }

    #[test]
    fn dialing_needs_a_running_tailnet() {
        let r = Arc::new(FakeRunner::new(r#"{"BackendState":"Stopped"}"#));
        let client = TailnetTcp::client(r, allow(&[ENTRY]));
        assert_eq!(
            client.connect("node-b:1").err().unwrap().kind(),
            io::ErrorKind::NotConnected
        );
    }

    #[test]
    fn ambiguous_short_names_are_refused() {
        let status = r#"{"BackendState":"Running","Self":{"DNSName":"me.example.ts.net.","TailscaleIPs":["100.64.0.1"]},
            "Peer":{"a":{"ID":"nDUPA1CNTRL","DNSName":"dup.example.ts.net.","TailscaleIPs":["100.64.0.2"]},
                    "b":{"ID":"nDUPB1CNTRL","DNSName":"dup.example.ts.net.","TailscaleIPs":["100.64.0.3"]}}}"#;
        let client = TailnetTcp::client(Arc::new(FakeRunner::new(status)), allow(&[ENTRY]));
        assert_eq!(
            client.connect("dup:1").err().unwrap().kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn accept_needs_a_listener() {
        let client = TailnetTcp::client(client_runner(), allow(&[]));
        assert_eq!(
            client.accept().err().unwrap().kind(),
            io::ErrorKind::Unsupported
        );
    }

    #[test]
    fn read_deadline_times_out_a_silent_peer_and_loses_nothing() {
        watchdog(60, || {
            let server =
                Arc::new(TailnetTcp::bind_for_test(server_runner(), allow(&[ENTRY]), 0).unwrap());
            let port = port_of(&server);
            let s = server.clone();
            let t = std::thread::spawn(move || {
                let conn = s.accept().unwrap().unwrap();
                let (mut r, mut w) = conn.split();
                let mut b = [0u8; 1];
                r.read_exact(&mut b).unwrap();
                w.write_all(b"late").unwrap();
            });
            let client = TailnetTcp::client(client_runner(), allow(&[ENTRY]));
            let mut conn = client.connect(&format!("node-b:{port}")).unwrap();
            conn.set_read_deadline(Some(Duration::from_millis(200)))
                .unwrap();
            let (mut r, mut w) = conn.split();
            let mut buf = [0u8; 4];
            assert_eq!(r.read(&mut buf).unwrap_err().kind(), TIMEOUT_KIND);
            w.write_all(b"x").unwrap();
            r.read_exact(&mut buf).unwrap();
            assert_eq!(&buf, b"late");
            t.join().unwrap();
        });
    }

    #[test]
    fn host_port_parsing() {
        assert_eq!(
            split_host_port("100.64.0.2:22").unwrap(),
            (Ok("100.64.0.2".parse().unwrap()), 22)
        );
        assert_eq!(
            split_host_port("[fd7a:115c:a1e0::2]:22").unwrap(),
            (Ok("fd7a:115c:a1e0::2".parse().unwrap()), 22)
        );
        assert_eq!(
            split_host_port("Node-B.Example.ts.net.:22").unwrap(),
            (Err("node-b.example.ts.net".to_string()), 22)
        );
        assert!(split_host_port(":22").is_err());
        assert!(split_host_port("host:99999").is_err());
    }

    // ---- revocation ----

    fn tcp_pair() -> (TcpStream, TcpStream) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let c = TcpStream::connect(l.local_addr().unwrap()).unwrap();
        let (s, _) = l.accept().unwrap();
        (s, c)
    }

    fn is_open(peer_end: &mut TcpStream) -> bool {
        peer_end
            .set_read_timeout(Some(Duration::from_millis(200)))
            .unwrap();
        let mut b = [0u8; 1];
        // An idle open socket times out; a shut down one reads EOF or errors.
        matches!(
            peer_end.read(&mut b),
            Err(ref e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut)
        )
    }

    #[test]
    fn removing_an_entry_ends_its_live_connection() {
        watchdog(60, || {
            let server =
                Arc::new(TailnetTcp::bind_for_test(server_runner(), allow(&[ENTRY]), 0).unwrap());
            let port = port_of(&server);
            let s = server.clone();
            let echo = std::thread::spawn(move || {
                let conn = s.accept().unwrap().unwrap();
                let (mut r, mut w) = conn.split();
                // Ends with an error or EOF once the connection is shut down.
                let _ = std::io::copy(&mut r, &mut w);
            });
            let client = TailnetTcp::client(client_runner(), allow(&[]));
            let conn = client.connect(&format!("node-b:{port}")).unwrap();
            let (mut r, mut w) = conn.split();
            w.write_all(b"ping").unwrap();
            let mut out = [0u8; 4];
            r.read_exact(&mut out).unwrap();
            assert_eq!(&out, b"ping");
            // Live and idle: removing the entry must end it, not just the next one.
            server.allowlist().remove(ENTRY);
            let mut buf = [0u8; 8];
            match r.read(&mut buf) {
                Ok(0) | Err(_) => {}
                Ok(n) => panic!("a revoked peer received {n} bytes"),
            }
            echo.join().unwrap();
        });
    }

    #[test]
    fn the_sweep_closes_removed_entries_and_keeps_the_rest() {
        let r = Arc::new(FakeRunner::new(&status_running(&["100.64.0.1"], &[])));
        let (t, _offset) = clocked(r, &[ENTRY]);
        let (a, mut a_peer) = tcp_pair();
        let (b, mut b_peer) = tcp_pair();
        let other = "tailnet:user/nOTHERX1CNTRL/7@example.ts.net";
        t.allowlist().add(other).unwrap();
        let _ta = t.gate.register(ENTRY, "example.ts.net", &a).unwrap();
        let _tb = t.gate.register(other, "example.ts.net", &b).unwrap();
        t.gate.sweep();
        assert!(is_open(&mut a_peer));
        assert!(is_open(&mut b_peer));
        t.allowlist().remove(ENTRY);
        t.gate.sweep();
        // The removed entry's connection is shut down; the other is untouched.
        let mut buf = [0u8; 1];
        a_peer
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        assert!(matches!(a_peer.read(&mut buf), Ok(0) | Err(_)));
        assert!(is_open(&mut b_peer));
    }

    #[test]
    fn a_dropped_connection_leaves_the_sweep() {
        let r = Arc::new(FakeRunner::new(&status_running(&["100.64.0.1"], &[])));
        let (t, _offset) = clocked(r, &[ENTRY]);
        let (a, _a_peer) = tcp_pair();
        let token = t.gate.register(ENTRY, "example.ts.net", &a).unwrap();
        assert_eq!(t.gate.live.lock().unwrap().len(), 1);
        drop(token);
        t.gate.sweep();
        assert!(t.gate.live.lock().unwrap().is_empty());
    }

    #[test]
    fn switching_tailnet_closes_live_connections() {
        let r = Arc::new(FakeRunner::new(&status_running(&["100.64.0.1"], &[])));
        let (t, offset) = clocked(r.clone(), &[ENTRY]);
        let (a, mut a_peer) = tcp_pair();
        let _token = t.gate.register(ENTRY, "example.ts.net", &a).unwrap();
        t.gate.sweep();
        assert!(is_open(&mut a_peer));
        // The machine moves to another tailnet; once the cached view expires the
        // connection admitted on the old one is shut down.
        *r.status.lock().unwrap() = Ok(status_running(&["100.64.0.1"], &[])
            .replace("node-a.example.ts.net", "node-a.other.ts.net"));
        *offset.lock().unwrap() = STATUS_TTL + Duration::from_secs(1);
        t.gate.sweep();
        let mut buf = [0u8; 1];
        a_peer
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        assert!(matches!(a_peer.read(&mut buf), Ok(0) | Err(_)));
    }

    #[test]
    fn an_unreadable_status_closes_nothing() {
        let r = Arc::new(FakeRunner::new(&status_running(&["100.64.0.1"], &[])));
        let (t, offset) = clocked(r.clone(), &[ENTRY]);
        let (a, mut a_peer) = tcp_pair();
        let _token = t.gate.register(ENTRY, "example.ts.net", &a).unwrap();
        *r.status.lock().unwrap() = Err(crate::tailscale::CliError::TimedOut);
        *offset.lock().unwrap() = STATUS_TTL + Duration::from_secs(1);
        t.gate.sweep();
        assert!(is_open(&mut a_peer));
    }

    // ---- tailnet binding ----

    #[test]
    fn an_entry_for_another_tailnet_never_matches() {
        let r = Arc::new(FakeRunner::new(&status_running(&["100.64.0.1"], &[])));
        r.set_whois(loopback(), Ok(whois_user("nPEERB1CNTRL", 42)));
        // Same stable id and user id, recorded on another tailnet, and unbound.
        for entry in [
            "tailnet:user/nPEERB1CNTRL/42@other.ts.net",
            "tailnet:user/nPEERB1CNTRL/42",
        ] {
            let t = TailnetTcp::client(r.clone(), allow(&[entry]));
            assert_eq!(t.authorize(loopback()), None, "{entry}");
        }
        let t = TailnetTcp::client(r, allow(&[ENTRY]));
        assert_eq!(t.authorize(loopback()).as_deref(), Some(ENTRY));
    }

    #[test]
    fn a_machine_that_moved_tailnets_refuses_the_old_entries() {
        // The entry was approved on example.ts.net; this machine is now on
        // another tailnet whose peer happens to reuse the same ids.
        let status = status_running(&["100.64.0.1"], &[])
            .replace("node-a.example.ts.net", "node-a.other.ts.net");
        let r = Arc::new(FakeRunner::new(&status));
        r.set_whois(loopback(), Ok(whois_user("nPEERB1CNTRL", 42)));
        let t = TailnetTcp::client(r.clone(), allow(&[ENTRY]));
        // The peer's own tailnet (example.ts.net) is not this machine's.
        assert_eq!(t.authorize(loopback()), None);
        // Even with an entry recorded for the new tailnet: the peer is not in it.
        let t = TailnetTcp::client(r, allow(&["tailnet:user/nPEERB1CNTRL/42@other.ts.net"]));
        assert_eq!(t.authorize(loopback()), None);
    }

    #[test]
    fn a_peer_from_another_tailnet_is_refused() {
        // A node shared in carries its own tailnet's domain in whois.
        let r = Arc::new(FakeRunner::new(&status_running(&["100.64.0.1"], &[])));
        let shared = whois_user("nPEERB1CNTRL", 42)
            .replace("node-b.example.ts.net", "node-b.elsewhere.ts.net");
        r.set_whois(loopback(), Ok(shared));
        let t = TailnetTcp::client(
            r,
            allow(&[ENTRY, "tailnet:user/nPEERB1CNTRL/42@elsewhere.ts.net"]),
        );
        assert_eq!(t.authorize(loopback()), None);
    }

    #[test]
    fn nothing_is_admitted_when_this_machines_tailnet_is_unknown() {
        // No DNS name for this node: its tailnet cannot be determined.
        let status =
            status_running(&["100.64.0.1"], &[]).replace("node-a.example.ts.net.", "node-a.");
        let r = Arc::new(FakeRunner::new(&status));
        r.set_whois(loopback(), Ok(whois_user("nPEERB1CNTRL", 42)));
        let t = TailnetTcp::client(r.clone(), allow(&[ENTRY]));
        assert_eq!(t.authorize(loopback()), None);
        // And an unreadable status is a refusal, with no whois spawned.
        let r2 = Arc::new(FakeRunner::new(r#"{"BackendState":"Stopped"}"#));
        r2.set_whois(loopback(), Ok(whois_user("nPEERB1CNTRL", 42)));
        let t = TailnetTcp::client(r2.clone(), allow(&[ENTRY]));
        assert_eq!(t.authorize(loopback()), None);
        assert_eq!(r2.whois_calls(), 0);
    }

    // ---- this machine as a source ----

    #[test]
    fn this_machine_is_never_a_peer() {
        let r = Arc::new(FakeRunner::new(&status_running(&["100.64.0.1"], &[])));
        r.set_whois(loopback(), Ok(whois_user("nPEERB1CNTRL", 42)));
        r.set_whois(
            "100.64.0.1".parse().unwrap(),
            Ok(whois_user("nPEERB1CNTRL", 42)),
        );
        let t = TailnetTcp::client(r.clone(), allow(&[ENTRY]));
        // A source equal to this machine's own tailnet address: refused before
        // any lookup.
        assert_eq!(t.authorize("100.64.0.1".parse().unwrap()), None);
        assert_eq!(r.whois_calls(), 0);
        // whois naming this very node (its stable id is this machine's).
        let r = Arc::new(FakeRunner::new(&status_running(&["100.64.0.1"], &[])));
        r.set_whois(loopback(), Ok(whois_user("nSELFA1CNTRL", 1)));
        let me = "tailnet:user/nSELFA1CNTRL/1@example.ts.net";
        let t = TailnetTcp::client(r.clone(), allow(&[me]));
        assert_eq!(t.authorize(loopback()), None);
        assert_eq!(r.whois_calls(), 1);
    }

    // ---- budgets ----

    #[test]
    fn a_flood_of_strangers_cannot_starve_a_known_peer_or_a_dial() {
        // The peer node-b (100.64.0.2) is listed and its node id is in the allowlist.
        let r = Arc::new(FakeRunner::new(&status_running(
            &["100.64.0.1"],
            &["100.64.0.2"],
        )));
        r.set_whois(
            "100.64.0.2".parse().unwrap(),
            Ok(whois_user("nPEERB1CNTRL", 42)),
        );
        r.set_whois(loopback(), Ok(whois_user("nPEERB1CNTRL", 42)));
        let (t, offset) = clocked(r.clone(), &[ENTRY]);
        let n = LOOKUP_LIMIT_UNKNOWN + 10;
        for i in 0..n {
            let ip: IpAddr = format!("100.64.{}.{}", 1 + i / 200, 1 + i % 200)
                .parse()
                .unwrap();
            assert_eq!(t.authorize(ip), None);
        }
        // Each stranger's lookup failed, but only the unknown budget ever spawned.
        assert_eq!(r.whois_calls() as u32, LOOKUP_LIMIT_UNKNOWN);
        // The known peer still gets in through its own budget.
        assert_eq!(
            t.authorize("100.64.0.2".parse().unwrap()).as_deref(),
            Some(ENTRY)
        );
        // And dialing is unaffected.
        assert!(t.gate.identify(loopback(), Lane::Dial, false).is_some());
        // A stranger's budget is back in a new window.
        *offset.lock().unwrap() = RATE_WINDOW + Duration::from_secs(1);
        let ip: IpAddr = "100.64.9.9".parse().unwrap();
        let before = r.whois_calls();
        assert_eq!(t.authorize(ip), None);
        assert_eq!(r.whois_calls(), before + 1);
    }

    #[test]
    fn known_peers_are_never_rate_limited() {
        // The tailnet keeps failing for a known peer: it is never locked out.
        let r = Arc::new(FakeRunner::new(&status_running(
            &["100.64.0.1"],
            &["100.64.0.2"],
        )));
        let (t, offset) = clocked(r.clone(), &[ENTRY]);
        let ip: IpAddr = "100.64.0.2".parse().unwrap();
        for _ in 0..(RATE_LIMIT * 2) {
            assert_eq!(t.authorize(ip), None);
        }
        assert!(!t.gate.state.lock().unwrap().rate.contains_key(&ip));
        // The tailnet recovers: the peer is admitted at once after the negative
        // answer expires, with no lockout to wait out.
        r.set_whois(ip, Ok(whois_user("nPEERB1CNTRL", 42)));
        *offset.lock().unwrap() = NEGATIVE_TTL + Duration::from_secs(1);
        assert_eq!(t.authorize(ip).as_deref(), Some(ENTRY));
    }

    #[test]
    fn a_source_has_a_few_places_in_the_queue() {
        let r = Arc::new(FakeRunner::new(&status_running(&["100.64.0.1"], &[])));
        let t = TailnetTcp::client(r, allow(&[]));
        let a: IpAddr = "100.64.0.7".parse().unwrap();
        let b: IpAddr = "100.64.0.8".parse().unwrap();
        for _ in 0..PENDING_PER_SOURCE {
            assert!(t.gate.enter(a));
        }
        assert!(!t.gate.enter(a));
        // Another source is unaffected, and a v4-mapped spelling is the same source.
        assert!(t.gate.enter(b));
        assert!(!t.gate.enter("::ffff:100.64.0.7".parse().unwrap()));
        t.gate.leave(a);
        assert!(t.gate.enter(a));
        // Leaving everything empties the map.
        for _ in 0..PENDING_PER_SOURCE {
            t.gate.leave(a);
        }
        t.gate.leave(b);
        assert!(t.gate.state.lock().unwrap().pending.is_empty());
    }

    #[test]
    fn a_full_cache_evicts_the_oldest_and_never_clears() {
        let base = Instant::now();
        let mut m: HashMap<IpAddr, (u32, Instant)> = HashMap::new();
        for i in 0..CACHE_LIMIT {
            let ip: IpAddr = format!("100.64.{}.{}", i / 200, 1 + i % 200)
                .parse()
                .unwrap();
            m.insert(ip, (1, base + Duration::from_secs(i as u64)));
        }
        assert_eq!(m.len(), CACHE_LIMIT);
        let newcomer: IpAddr = "100.65.0.1".parse().unwrap();
        make_room(&mut m, &newcomer, |_| false, |(_, s)| *s);
        // One slot freed: the oldest is gone, everything else kept.
        assert_eq!(m.len(), CACHE_LIMIT - 1);
        assert!(!m.contains_key(&"100.64.0.1".parse::<IpAddr>().unwrap()));
        assert!(m.contains_key(&"100.64.0.2".parse::<IpAddr>().unwrap()));
        // An existing key needs no room.
        let existing: IpAddr = "100.64.0.2".parse().unwrap();
        make_room(&mut m, &existing, |_| false, |(_, s)| *s);
        assert_eq!(m.len(), CACHE_LIMIT - 1);
    }

    #[test]
    fn a_flood_of_addresses_never_clears_the_rate_table() {
        let r = Arc::new(FakeRunner::new(&status_running(&["100.64.0.1"], &[])));
        let (t, _offset) = clocked(r, &[]);
        let now = (t.gate.clock)();
        let addr = |i: usize| -> IpAddr {
            format!("100.66.{}.{}", i / 200, 1 + i % 200)
                .parse()
                .unwrap()
        };
        let mut st = t.gate.state.lock().unwrap();
        let total = CACHE_LIMIT * 2;
        for i in 0..total {
            Gate::charge(&mut st, addr(i), now + Duration::from_millis(1 + i as u64));
        }
        // Full, not emptied: each newcomer evicted exactly one older entry, and
        // the newest sources are still counted.
        assert_eq!(st.rate.len(), CACHE_LIMIT);
        assert!(st.rate.contains_key(&addr(total - 1)));
        assert!(!st.rate.contains_key(&addr(0)));
    }

    // ---- dialing ----

    #[test]
    fn dialing_never_reaches_a_node_shared_in_from_another_tailnet() {
        let status = r#"{"BackendState":"Running","Self":{"ID":"nSELFA1CNTRL","DNSName":"me.example.ts.net.","TailscaleIPs":["100.64.0.1"]},
            "Peer":{"a":{"ID":"nLOCAL1CNTRL","DNSName":"box.example.ts.net.","TailscaleIPs":["100.64.0.2"]},
                    "b":{"ID":"nSHARED1CNTRL","DNSName":"box.elsewhere.ts.net.","TailscaleIPs":["100.64.0.3"]},
                    "c":{"ID":"nSHARED2CNTRL","DNSName":"only-there.elsewhere.ts.net.","TailscaleIPs":["100.64.0.4"]}}}"#;
        let client = TailnetTcp::client(Arc::new(FakeRunner::new(status)), allow(&[]));
        let kind = |a: &str| client.connect(a).err().unwrap().kind();
        // The short name resolves to the local node only: not ambiguous (which
        // would be InvalidInput), and the shared-in one is never chosen. The
        // fake knows no whois, so it stops at "the tailnet does not vouch".
        assert_eq!(kind("box:1"), io::ErrorKind::PermissionDenied);
        // A node that exists only in another tailnet is not found by any name,
        // and not reachable by address.
        assert_eq!(kind("only-there:1"), io::ErrorKind::NotFound);
        assert_eq!(
            kind("only-there.elsewhere.ts.net:1"),
            io::ErrorKind::NotFound
        );
        assert_eq!(kind("box.elsewhere.ts.net:1"), io::ErrorKind::NotFound);
        assert_eq!(kind("100.64.0.4:1"), io::ErrorKind::PermissionDenied);
        assert_eq!(kind("100.64.0.3:1"), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn dialing_needs_to_know_this_machines_tailnet() {
        let status = status_running(&["100.64.0.1"], &["127.0.0.1"])
            .replace("node-a.example.ts.net.", "node-a.");
        let client = TailnetTcp::client(Arc::new(FakeRunner::new(&status)), allow(&[]));
        assert_eq!(
            client.connect("node-b:1").err().unwrap().kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn dialing_refuses_a_whois_answer_from_another_tailnet() {
        let r = client_runner();
        let other = whois_user("nPEERB1CNTRL", 42)
            .replace("node-b.example.ts.net", "node-b.elsewhere.ts.net");
        r.set_whois(loopback(), Ok(other));
        let client = TailnetTcp::client(r, allow(&[]));
        assert_eq!(
            client.connect("node-b:1").err().unwrap().kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn split_failure_halves_report_errors() {
        // The error halves are what a failed descriptor dup produces.
        let mut r: Box<dyn Read + Send> = Box::new(FailedHalf(io::ErrorKind::Other));
        let mut w: Box<dyn Write + Send> = Box::new(FailedHalf(io::ErrorKind::Other));
        assert!(r.read(&mut [0u8; 1]).is_err());
        assert!(w.write(b"x").is_err());
    }
}
