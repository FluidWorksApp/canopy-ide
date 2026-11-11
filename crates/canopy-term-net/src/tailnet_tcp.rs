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
//! - Whois runs on a small worker pool fed by a bounded queue, so one slow
//!   lookup does not stall the listener; a full queue drops the connection.
//!   Answers are cached briefly (successes [`WHOIS_TTL`], failures
//!   [`NEGATIVE_TTL`]), and failed lookups plus refusals are rate limited per
//!   source address (admitted peers never count).
//! - Dialing resolves names from the status peer list (never system DNS), only
//!   to nodes the tailnet lists, and checks the allowlist before connecting.
//! - The CLI version is checked once, when the transport is created.
//!
//! No stream preface: a TCP connection is visible to the acceptor on connect,
//! so `accept` returns when a peer connects. The session protocol's hello and
//! spawn key travel on the stream unchanged.

use crate::allowlist::Allowlist;
use crate::tailscale::{
    CliRunner, NodeInfo, TailnetIdentity, TailnetState, TailnetStatus, Tailscale,
};
use crate::{Connection, PeerIdentity, Refusal, Transport, TIMEOUT_KIND};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{IpAddr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
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
/// Failed lookups plus refusals allowed per source address per [`RATE_WINDOW`].
pub const RATE_LIMIT: u32 = 20;
pub const RATE_WINDOW: Duration = Duration::from_secs(60);
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

#[derive(Default)]
struct GateState {
    positive: HashMap<IpAddr, (TailnetIdentity, Instant)>,
    negative: HashMap<IpAddr, Instant>,
    /// Count and window start per source address.
    rate: HashMap<IpAddr, (u32, Instant)>,
}

fn trim<V>(map: &mut HashMap<IpAddr, V>, keep: impl Fn(&V) -> bool) {
    if map.len() >= CACHE_LIMIT {
        map.retain(|_, v| keep(v));
        if map.len() >= CACHE_LIMIT {
            map.clear();
        }
    }
}

/// The authorisation decision and its caches, shared with the worker threads.
struct Gate {
    ts: Tailscale,
    allow: Allowlist,
    state: Mutex<GateState>,
    clock: Clock,
}

impl Gate {
    /// Count a lookup or refusal for `ip`; `false` once it is over the limit.
    fn charge(st: &mut GateState, ip: IpAddr, now: Instant) -> bool {
        trim(&mut st.rate, |(_, start)| now < *start + RATE_WINDOW);
        let e = st.rate.entry(ip).or_insert((0, now));
        if now >= e.1 + RATE_WINDOW {
            *e = (0, now);
        }
        e.0 = e.0.saturating_add(1);
        e.0 <= RATE_LIMIT
    }

    fn over_limit(st: &GateState, ip: IpAddr, now: Instant) -> bool {
        st.rate
            .get(&ip)
            .is_some_and(|(n, start)| now < *start + RATE_WINDOW && *n >= RATE_LIMIT)
    }

    /// From the peer's address alone: its identity entry if the tailnet vouches
    /// for it AND the allowlist holds it, else `None`. Any failure, including
    /// a poisoned lock, is `None`.
    fn authorize(&self, ip: IpAddr) -> Option<String> {
        let ip = ip.to_canonical();
        let now = (self.clock)();
        let cached = {
            let mut st = self.state.lock().ok()?;
            let hit = st.positive.get(&ip).map(|(id, exp)| (id.clone(), *exp));
            match hit {
                Some((id, exp)) if now < exp => Some(id),
                _ => {
                    st.positive.remove(&ip);
                    if st.negative.get(&ip).is_some_and(|exp| now < *exp) {
                        Gate::charge(&mut st, ip, now);
                        return None;
                    }
                    if Gate::over_limit(&st, ip, now) {
                        return None;
                    }
                    // The lookup itself is not charged (an allowlisted peer's
                    // periodic lookups must never use up its budget); its
                    // failure is.
                    None
                }
            }
        };
        let identity = match cached {
            Some(id) => id,
            None => {
                // The lock is not held while the CLI runs.
                let looked_up = self.ts.whois(ip);
                let mut st = self.state.lock().ok()?;
                match looked_up {
                    Ok(id) => {
                        trim(&mut st.positive, |(_, exp)| now < *exp);
                        st.positive.insert(ip, (id.clone(), now + WHOIS_TTL));
                        id
                    }
                    Err(_) => {
                        Gate::charge(&mut st, ip, now);
                        trim(&mut st.negative, |exp| now < *exp);
                        st.negative.insert(ip, now + NEGATIVE_TTL);
                        return None;
                    }
                }
            }
        };
        let entry = identity.allowlist_entry();
        if self.allow.contains(&entry) {
            Some(entry)
        } else {
            if let Ok(mut st) = self.state.lock() {
                Gate::charge(&mut st, ip, now);
            }
            None
        }
    }

    fn admit(&self, stream: TcpStream, peer: SocketAddr) -> Result<Box<dyn Connection>, Refusal> {
        // Nothing has been read from `stream`; the decision uses the address.
        let Some(entry) = self.authorize(peer.ip()) else {
            drop(stream);
            return Err(Refusal::UnknownPeer);
        };
        if stream.set_nonblocking(false).is_err() {
            return Err(Refusal::UnknownPeer);
        }
        let _ = stream.set_nodelay(true);
        Ok(Box::new(TcpConn {
            stream,
            peer: PeerIdentity::Device(entry),
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
    /// Stops the listener thread; the workers follow when its queue closes.
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
                clock,
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

    /// One listener thread feeding a bounded queue, and a few workers that run
    /// the (possibly slow) authorisation and post results for `accept`.
    fn start(&mut self, listeners: Vec<TcpListener>) {
        let (job_tx, job_rx) = mpsc::sync_channel::<(TcpStream, SocketAddr)>(QUEUE);
        let (res_tx, res_rx) = mpsc::channel::<Admitted>();
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
                if res_tx.send(gate.admit(stream, peer)).is_err() {
                    break;
                }
            });
        }
        let stop = self.stop.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                let mut busy = false;
                for l in &listeners {
                    if let Ok((stream, peer)) = l.accept() {
                        busy = true;
                        // A full queue drops the connection unread.
                        let _ = job_tx.try_send((stream, peer));
                    }
                }
                if !busy {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            // Dropping job_tx ends the workers.
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

/// Addresses for `host`, from the tailnet's own node list only.
fn resolve(status: &TailnetStatus, host: &Result<IpAddr, String>) -> io::Result<Vec<IpAddr>> {
    match host {
        Ok(ip) => {
            let ip = ip.to_canonical();
            if nodes(status).any(|n| n.addrs.iter().any(|a| a.to_canonical() == ip)) {
                Ok(vec![ip])
            } else {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "address is not a node on this tailnet",
                ))
            }
        }
        Err(name) => {
            let matches: Vec<&NodeInfo> = nodes(status)
                .filter(|n| {
                    n.dns_name == *name
                        || (!name.contains('.')
                            && n.dns_name.split('.').next() == Some(name.as_str()))
                })
                .collect();
            match matches.as_slice() {
                [] => Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "no such node on this tailnet",
                )),
                [one] => {
                    let mut addrs = one.addrs.clone();
                    addrs.sort_by_key(|a| a.is_ipv6());
                    if addrs.is_empty() {
                        Err(io::Error::new(
                            io::ErrorKind::NotFound,
                            "node has no address",
                        ))
                    } else {
                        Ok(addrs)
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
    /// short name or the full MagicDNS name. Only nodes in the tailnet's own
    /// status are dialed, and only if the allowlist holds their identity.
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
        for ip in resolve(&status, &host)? {
            // Identity and allowlist first: an unapproved node is never dialed.
            let Some(entry) = self.gate.authorize(ip) else {
                last = Some(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "peer is not allowlisted",
                ));
                continue;
            };
            match TcpStream::connect_timeout(&SocketAddr::new(ip, port), DIAL_TIMEOUT) {
                Ok(stream) => {
                    let _ = stream.set_nodelay(true);
                    return Ok(Box::new(TcpConn {
                        stream,
                        peer: PeerIdentity::Device(entry),
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
        // before the split still applies to the read half.
        let read = self.stream.try_clone().expect("dup tcp socket");
        (Box::new(ReadHalf(read)), Box::new(WriteHalf(self.stream)))
    }
}

struct ReadHalf(TcpStream);

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

struct WriteHalf(TcpStream);

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

    const ENTRY: &str = "tailnet:user/nPEERB1CNTRL/42";

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
        let r = Arc::new(FakeRunner::new(&status_running(&["127.0.0.1"], &[])));
        r.set_whois(loopback(), Ok(whois_tagged("nBOXC1CNTRL", &["tag:ws"])));
        // A user entry with the same stable id does not authorise a tagged node.
        let t = TailnetTcp::client(r.clone(), allow(&["tailnet:user/nBOXC1CNTRL/99"]));
        assert_eq!(t.authorize(loopback()), None);
        let t = TailnetTcp::client(r, allow(&["tailnet:tagged/nBOXC1CNTRL/tag:ws"]));
        assert_eq!(
            t.authorize(loopback()).as_deref(),
            Some("tailnet:tagged/nBOXC1CNTRL/tag:ws")
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
        let r = Arc::new(FakeRunner::new(&status_running(&["127.0.0.1"], &[])));
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
        let r = Arc::new(FakeRunner::new(&status_running(&["127.0.0.1"], &[])));
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
        let r = Arc::new(FakeRunner::new(&status_running(&["127.0.0.1"], &[])));
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
        let r = Arc::new(FakeRunner::new(&status_running(&["127.0.0.1"], &[])));
        r.set_whois(
            loopback(),
            Ok(
                r#"{"Node":{"StableID":"nRTR1CNTRL","Addresses":["127.0.0.1/32"],
                "AllowedIPs":["127.0.0.1/32","192.168.1.0/24"]},"UserProfile":{"ID":42}}"#
                    .to_string(),
            ),
        );
        let t = TailnetTcp::client(r, allow(&["tailnet:user/nRTR1CNTRL/42"]));
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
        let r = Arc::new(FakeRunner::new(&status_running(&["127.0.0.1"], &[])));
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
        let r = Arc::new(FakeRunner::new(&status_running(&["127.0.0.1"], &[])));
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
    fn dialing_an_unallowlisted_node_never_connects() {
        // Nothing listens on this port; reaching the allowlist check first
        // means the error is PermissionDenied, not a connection failure.
        let client = TailnetTcp::client(client_runner(), allow(&[]));
        assert_eq!(
            client.connect("node-b:1").err().unwrap().kind(),
            io::ErrorKind::PermissionDenied
        );
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
            "Peer":{"a":{"DNSName":"dup.one.example.ts.net.","TailscaleIPs":["100.64.0.2"]},
                    "b":{"DNSName":"dup.two.example.ts.net.","TailscaleIPs":["100.64.0.3"]}}}"#;
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
}
