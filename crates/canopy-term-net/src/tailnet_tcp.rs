//! TCP over the installed Tailscale. The tailnet carries and encrypts the
//! packets; this transport adds the part the tailnet does not decide, who may
//! open a session.
//!
//! - The listener binds ONLY the node's own tailnet addresses, as the CLI's
//!   status reports them, and only while the backend is running. An unspecified
//!   address (0.0.0.0, ::) is refused outright. If no tailnet interface exists
//!   (a userspace-mode tailscaled has none) the bind fails with a typed error;
//!   it never widens to another address.
//! - A peer's identity comes from `whois --json <its address>`, keyed on the
//!   stable node id and user id (or tags), never on names.
//! - Tailnet membership is NOT authorisation: the identity must also be in the
//!   [`Allowlist`]. The decision takes only the peer's socket address, so no
//!   byte of the stream is read before it, by construction. A whois failure,
//!   timeout or empty answer is a refusal (fail closed).
//! - Dialing resolves names from the status peer list (never system DNS), only
//!   to nodes the tailnet lists, and checks the allowlist before connecting.
//!
//! No stream preface: a TCP connection is visible to the acceptor on connect,
//! so `accept` returns when a peer connects. The session protocol's hello and
//! spawn key travel on the stream unchanged.

use crate::allowlist::Allowlist;
use crate::tailscale::{CliRunner, NodeInfo, TailnetState, TailnetStatus, Tailscale};
use crate::{Connection, PeerIdentity, Refusal, Transport, TIMEOUT_KIND};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{IpAddr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long an address's whois answer is reused. Only successes are cached,
/// and the allowlist is checked afresh every time, so removing an entry takes
/// effect at once.
pub const WHOIS_TTL: Duration = Duration::from_secs(30);
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);
const CACHE_LIMIT: usize = 256;

/// Why a listener could not be bound.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindError {
    /// Tailscale is not in the running state.
    NotRunning(TailnetState),
    /// The status lists no address for this node.
    NoTailnetAddress,
    /// An address that must never be bound (unspecified or multicast).
    UnsafeAddress(IpAddr),
    /// None of the node's tailnet addresses could be bound: no tailnet
    /// interface, as with a userspace-mode daemon. Not widened.
    NoTailnetInterface(io::ErrorKind),
}

impl std::fmt::Display for BindError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BindError::NotRunning(s) => write!(f, "tailscale is not running ({s:?})"),
            BindError::NoTailnetAddress => write!(f, "no tailnet address for this node"),
            BindError::UnsafeAddress(a) => write!(f, "refusing to bind {a}"),
            BindError::NoTailnetInterface(k) => {
                write!(f, "no tailnet interface to bind ({k:?})")
            }
        }
    }
}

impl std::error::Error for BindError {}

pub struct TailnetTcp {
    ts: Tailscale,
    allow: Allowlist,
    listeners: Vec<TcpListener>,
    cache: Mutex<HashMap<IpAddr, (crate::tailscale::TailnetIdentity, Instant)>>,
    clock: Arc<dyn Fn() -> Instant + Send + Sync>,
}

impl TailnetTcp {
    /// A dial-only transport.
    pub fn client(runner: Arc<dyn CliRunner>, allow: Allowlist) -> Self {
        Self {
            ts: Tailscale::new(runner),
            allow,
            listeners: Vec::new(),
            cache: Mutex::new(HashMap::new()),
            clock: Arc::new(Instant::now),
        }
    }

    /// Listen on the node's tailnet addresses at `port`. With port 0 each
    /// address gets its own port (see [`local_addrs`](Self::local_addrs)).
    pub fn bind(
        runner: Arc<dyn CliRunner>,
        allow: Allowlist,
        port: u16,
    ) -> Result<Self, BindError> {
        let mut t = Self::client(runner, allow);
        let status = t.ts.running_status().map_err(BindError::NotRunning)?;
        let addrs = status.self_node.map(|n| n.addrs).unwrap_or_default();
        if addrs.is_empty() {
            return Err(BindError::NoTailnetAddress);
        }
        if let Some(bad) = addrs
            .iter()
            .find(|a| a.is_unspecified() || a.is_multicast())
        {
            return Err(BindError::UnsafeAddress(*bad));
        }
        let mut last = io::ErrorKind::Other;
        for a in addrs {
            match TcpListener::bind(SocketAddr::new(a, port)) {
                Ok(l) => match l.set_nonblocking(true) {
                    Ok(()) => t.listeners.push(l),
                    Err(e) => last = e.kind(),
                },
                Err(e) => last = e.kind(),
            }
        }
        if t.listeners.is_empty() {
            return Err(BindError::NoTailnetInterface(last));
        }
        Ok(t)
    }

    /// Replace the clock (tests).
    pub fn with_clock(mut self, clock: Arc<dyn Fn() -> Instant + Send + Sync>) -> Self {
        self.clock = clock;
        self
    }

    /// The addresses actually bound.
    pub fn local_addrs(&self) -> Vec<SocketAddr> {
        self.listeners
            .iter()
            .filter_map(|l| l.local_addr().ok())
            .collect()
    }

    pub fn allowlist(&self) -> &Allowlist {
        &self.allow
    }

    /// The authorisation decision, from the peer's address alone: its identity
    /// entry if the tailnet vouches for it AND the allowlist holds it, else
    /// `None`. Any failure is `None`.
    pub(crate) fn authorize(&self, ip: IpAddr) -> Option<String> {
        let ip = ip.to_canonical();
        let now = (self.clock)();
        let cached = {
            // A poisoned cache refuses (fail closed) rather than panicking on
            // the accept path.
            let cache = self.cache.lock().ok()?;
            cache
                .get(&ip)
                .filter(|(_, expires)| now < *expires)
                .map(|(id, _)| id.clone())
        };
        let identity = match cached {
            Some(id) => id,
            None => {
                // Failures are not cached: a later success must be seen.
                let id = self.ts.whois(ip).ok()?;
                let mut cache = self.cache.lock().ok()?;
                if cache.len() >= CACHE_LIMIT {
                    cache.retain(|_, (_, expires)| now < *expires);
                    if cache.len() >= CACHE_LIMIT {
                        cache.clear();
                    }
                }
                cache.insert(ip, (id.clone(), now + WHOIS_TTL));
                id
            }
        };
        let entry = identity.allowlist_entry();
        self.allow.contains(&entry).then_some(entry)
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
        let (host, port) = split_host_port(address)?;
        let status = self.ts.running_status().map_err(|s| {
            io::Error::new(
                io::ErrorKind::NotConnected,
                format!("tailnet not running: {s:?}"),
            )
        })?;
        let mut last: Option<io::Error> = None;
        for ip in resolve(&status, &host)? {
            // Identity and allowlist first: an unapproved node is never dialed.
            let Some(entry) = self.authorize(ip) else {
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

    /// Blocks until an allowlisted peer connects. Unknown peers yield
    /// `Ok(Err(Refusal::UnknownPeer))` with nothing read from them.
    fn accept(&self) -> io::Result<Result<Box<dyn Connection>, Refusal>> {
        if self.listeners.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "dial-only transport cannot accept",
            ));
        }
        loop {
            for l in &self.listeners {
                match l.accept() {
                    Ok((stream, peer)) => return Ok(self.admit(stream, peer)),
                    Err(e)
                        if matches!(
                            e.kind(),
                            io::ErrorKind::WouldBlock
                                | io::ErrorKind::Interrupted
                                | io::ErrorKind::ConnectionAborted
                                | io::ErrorKind::ConnectionReset
                        ) => {}
                    Err(e) => return Err(e),
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
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
            TailnetTcp::bind(r, allow(&[]), 0).err().unwrap(),
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
        // 192.0.2.1 (TEST-NET-1) is on no interface here, like the tailnet
        // address of a userspace-mode daemon.
        let r = Arc::new(FakeRunner::new(&status_running(&["192.0.2.1"], &[])));
        let e = TailnetTcp::bind(r, allow(&[]), 0).err().unwrap();
        assert!(matches!(e, BindError::NoTailnetInterface(_)), "{e:?}");
    }

    #[test]
    fn listener_binds_only_the_reported_address() {
        let t = TailnetTcp::bind(server_runner(), allow(&[]), 0).unwrap();
        let addrs = t.local_addrs();
        assert_eq!(addrs.len(), 1);
        assert_eq!(addrs[0].ip(), loopback());
        assert!(!addrs[0].ip().is_unspecified());
    }

    #[test]
    fn allowlisted_peer_connects_and_echoes() {
        watchdog(60, || {
            let server = Arc::new(TailnetTcp::bind(server_runner(), allow(&[ENTRY]), 0).unwrap());
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
            let server = Arc::new(TailnetTcp::bind(server_runner(), allow(&[ENTRY]), 0).unwrap());
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
            let server = Arc::new(TailnetTcp::bind(server_runner(), allow(&[]), 0).unwrap());
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
            let server = Arc::new(TailnetTcp::bind(r, allow(&[ENTRY]), 0).unwrap());
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

    #[test]
    fn whois_is_cached_briefly_failures_are_not_and_removal_is_immediate() {
        let r = Arc::new(FakeRunner::new(&status_running(&["127.0.0.1"], &[])));
        let base = Instant::now();
        let offset = Arc::new(Mutex::new(Duration::ZERO));
        let o = offset.clone();
        let t = TailnetTcp::client(r.clone(), allow(&[ENTRY]))
            .with_clock(Arc::new(move || base + *o.lock().unwrap()));
        // A failure is not cached: the next attempt asks again and succeeds.
        r.set_whois(loopback(), Err(crate::tailscale::CliError::TimedOut));
        assert_eq!(t.authorize(loopback()), None);
        r.set_whois(loopback(), Ok(whois_user("nPEERB1CNTRL", 42)));
        assert_eq!(t.authorize(loopback()).as_deref(), Some(ENTRY));
        assert_eq!(r.whois_calls(), 2);
        // Within the TTL the answer is reused.
        assert_eq!(t.authorize(loopback()).as_deref(), Some(ENTRY));
        assert_eq!(r.whois_calls(), 2);
        // The allowlist is still consulted every time.
        t.allowlist().remove(ENTRY);
        assert_eq!(t.authorize(loopback()), None);
        assert_eq!(r.whois_calls(), 2);
        t.allowlist().add(ENTRY).unwrap();
        // Past the TTL it asks again.
        *offset.lock().unwrap() = WHOIS_TTL + Duration::from_secs(1);
        assert_eq!(t.authorize(loopback()).as_deref(), Some(ENTRY));
        assert_eq!(r.whois_calls(), 3);
    }

    #[test]
    fn a_poisoned_cache_refuses_instead_of_panicking() {
        let r = Arc::new(FakeRunner::new(&status_running(&["127.0.0.1"], &[])));
        r.set_whois(loopback(), Ok(whois_user("nPEERB1CNTRL", 42)));
        let t = Arc::new(TailnetTcp::client(r, allow(&[ENTRY])));
        assert_eq!(t.authorize(loopback()).as_deref(), Some(ENTRY));
        let t2 = t.clone();
        let _ = std::thread::spawn(move || {
            let _guard = t2.cache.lock().unwrap();
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
            let server = Arc::new(TailnetTcp::bind(server_runner(), allow(&[ENTRY]), 0).unwrap());
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
