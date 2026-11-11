//! The iroh transport: QUIC between devices, dialed by public key. A device's
//! identity is its endpoint key, proven by the TLS handshake. An allowlist of
//! device keys decides who is served.
//!
//! Shape. One QUIC link per peer, cached; every `connect` opens a new
//! bidirectional stream on it, so a control call costs a stream, not a
//! handshake. The contract is synchronous, so the transport owns a tokio
//! runtime and each stream half blocks on it.
//!
//! Refusal. The acceptor learns the dialer's key from the handshake. An unknown
//! key gets the link closed and `Refusal::UnknownPeer` queued; no stream is ever
//! accepted, so no session bytes are read from it. The allowlist is checked
//! again for every new stream on a live link, and a watcher re-checks every
//! live link each [`REVOCATION_INTERVAL`]: removing a key closes its link, and
//! with it every session already running over it, within about that interval.
//! Closing the link is abrupt by design (the peer's reads and writes fail); a
//! session protocol that wants a goodbye must send it before the key is removed.
//!
//! Stream preface. A QUIC stream is invisible to the acceptor until its opener
//! writes. `connect` therefore writes a four byte preface immediately and the
//! acceptor consumes it before yielding the connection, so `accept` returns
//! when the peer connects, not when it first speaks. The session protocol's own
//! hello/attach and spawn key travel after the preface, unchanged.

use crate::allowlist::{canonical_key, Allowlist};
use crate::{Connection, PeerIdentity, Refusal, Transport, TIMEOUT_KIND};
use iroh::endpoint::{presets, Connection as IrohConnection, RecvStream, SendStream};
use iroh::{Endpoint, EndpointAddr, EndpointId, SecretKey};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::runtime::{Handle, Runtime};

/// ALPN for the session protocol over iroh. Bump the trailing number for an
/// incompatible transport change; the session protocol versions itself inside.
pub const ALPN: &[u8] = b"canopy-term/session/1";
const PREFACE: &[u8; 4] = b"CTN1";
const PREFACE_TIMEOUT: Duration = Duration::from_secs(5);
/// Accepted streams waiting for `accept`. When full, new ones are dropped
/// (the peer sees the stream reset) rather than queued without bound.
const QUEUE: usize = 64;
/// Refusal notices waiting for `accept`, capped separately so strangers can
/// never crowd out admitted connections.
const MAX_PENDING_REFUSALS: usize = 8;
/// How often a live link is re-checked against the allowlist, so a removed key
/// ends its running sessions and not only its next stream.
pub const REVOCATION_INTERVAL: Duration = Duration::from_secs(1);
/// Incoming connections handled at once (handshaking or live). Past it a new
/// connection is refused at the handshake instead of spawning another task.
pub const MAX_LINKS: usize = 256;

/// One of the [`MAX_LINKS`] slots, released when dropped.
struct LinkSlot(Arc<AtomicUsize>);

impl LinkSlot {
    fn take(active: &Arc<AtomicUsize>, max: usize) -> Option<LinkSlot> {
        if active.fetch_add(1, Ordering::SeqCst) >= max {
            active.fetch_sub(1, Ordering::SeqCst);
            None
        } else {
            Some(LinkSlot(active.clone()))
        }
    }
}

impl Drop for LinkSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

type Item = Result<Box<dyn Connection>, Refusal>;

/// The bounded hand-off from the async side to `accept`.
struct Queue {
    tx: mpsc::SyncSender<Item>,
    pending_refusals: AtomicUsize,
}

impl Queue {
    fn admit(&self, c: Box<dyn Connection>) {
        // Never blocks a runtime thread; a full queue drops the stream.
        let _ = self.tx.try_send(Ok(c));
    }

    fn refuse(&self) {
        if self.pending_refusals.fetch_add(1, Ordering::SeqCst) < MAX_PENDING_REFUSALS {
            if self.tx.try_send(Err(Refusal::UnknownPeer)).is_err() {
                self.pending_refusals.fetch_sub(1, Ordering::SeqCst);
            }
        } else {
            self.pending_refusals.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

/// How to bind. `loopback` is for tests and same-machine use: no relay, no
/// address lookup, one IPv4 socket on 127.0.0.1.
pub struct IrohOptions {
    pub secret_key: SecretKey,
    pub allowlist: Allowlist,
    /// `Some(addr)` binds only that socket with relay and discovery off. `None`
    /// uses the n0 defaults (relay and DNS discovery).
    pub bind: Option<SocketAddr>,
}

impl IrohOptions {
    pub fn loopback(secret_key: SecretKey, allowlist: Allowlist) -> Self {
        Self {
            secret_key,
            allowlist,
            bind: Some(SocketAddr::from(([127, 0, 0, 1], 0))),
        }
    }
}

pub struct IrohTransport {
    rt: Runtime,
    endpoint: Endpoint,
    allow: Allowlist,
    links: Arc<Mutex<HashMap<EndpointId, IrohConnection>>>,
    queue: Arc<Queue>,
    incoming: Mutex<mpsc::Receiver<Item>>,
    listening: AtomicBool,
}

fn other<E: std::fmt::Display>(what: &str, e: E) -> io::Error {
    io::Error::other(format!("{what}: {e}"))
}

impl IrohTransport {
    pub fn bind(opts: IrohOptions) -> io::Result<Self> {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        let allow = opts.allowlist.clone();
        let (tx, rx) = mpsc::sync_channel(QUEUE);
        let endpoint = rt.block_on(async {
            let builder = match opts.bind {
                Some(addr) => Endpoint::builder(presets::Minimal)
                    .clear_ip_transports()
                    .bind_addr(addr)
                    .map_err(|e| other("bind address", e))?,
                None => Endpoint::builder(presets::N0),
            };
            // No ALPN yet: incoming connections are refused by the handshake
            // until `listen` is called. Dialing out works regardless.
            builder
                .secret_key(opts.secret_key)
                .bind()
                .await
                .map_err(|e| other("bind endpoint", e))
        })?;
        Ok(Self {
            rt,
            endpoint,
            allow,
            links: Arc::new(Mutex::new(HashMap::new())),
            queue: Arc::new(Queue {
                tx,
                pending_refusals: AtomicUsize::new(0),
            }),
            incoming: Mutex::new(rx),
            listening: AtomicBool::new(false),
        })
    }

    /// Start accepting: advertise the session ALPN and run the accept loop.
    /// Until this is called the endpoint only dials out. Calling it twice is
    /// harmless.
    pub fn listen(&self) -> io::Result<()> {
        if self.listening.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.endpoint.set_alpns(vec![ALPN.to_vec()]);
        let ep = self.endpoint.clone();
        let al = self.allow.clone();
        let queue = self.queue.clone();
        let active = Arc::new(AtomicUsize::new(0));
        self.rt.spawn(async move {
            while let Some(incoming) = ep.accept().await {
                // A bounded number of connections at once: past it the
                // handshake is refused, no task is spawned for it.
                let Some(slot) = LinkSlot::take(&active, MAX_LINKS) else {
                    incoming.refuse();
                    continue;
                };
                let al = al.clone();
                let queue = queue.clone();
                tokio::spawn(async move {
                    let _slot = slot;
                    let Ok(conn) = incoming.await else { return };
                    serve_link(conn, al, queue).await;
                });
            }
        });
        Ok(())
    }

    /// This device's identity: 64 lowercase hex characters.
    pub fn device_key(&self) -> String {
        self.endpoint.id().to_string()
    }

    /// The dialable address of this endpoint, `<key>@<ip:port>[,<ip:port>]`,
    /// from its bound sockets (loopback only for a `loopback` transport).
    pub fn address(&self) -> String {
        let socks: Vec<String> = self
            .endpoint
            .bound_sockets()
            .iter()
            .map(|s| s.to_string())
            .collect();
        format!("{}@{}", self.device_key(), socks.join(","))
    }

    pub fn allowlist(&self) -> &Allowlist {
        &self.allow
    }

    /// Live cached peer links (one per peer, however many streams).
    pub fn link_count(&self) -> usize {
        match self.links.lock() {
            Ok(links) => links
                .values()
                .filter(|c| c.close_reason().is_none())
                .count(),
            Err(_) => 0,
        }
    }

    /// Close every link and the endpoint, flushing queued close frames.
    pub fn close(self) {
        let Self { rt, endpoint, .. } = self;
        rt.block_on(endpoint.close());
    }
}

/// Parse `<hex key>[@ip:port[,ip:port...]]`.
fn parse_address(address: &str) -> io::Result<EndpointAddr> {
    let bad = |m: &str| io::Error::new(io::ErrorKind::InvalidInput, m.to_string());
    let (key, socks) = match address.split_once('@') {
        Some((k, s)) => (k, Some(s)),
        None => (address, None),
    };
    let key = canonical_key(key).ok_or_else(|| bad("not a device key"))?;
    let id: EndpointId = key.parse().map_err(|_| bad("not a device key"))?;
    let mut addr = EndpointAddr::new(id);
    if let Some(socks) = socks {
        for s in socks.split(',').filter(|s| !s.is_empty()) {
            let sock: SocketAddr = s.parse().map_err(|_| bad("bad socket address"))?;
            addr = addr.with_ip_addr(sock);
        }
    }
    Ok(addr)
}

/// Close `conn` once `peer` is no longer allowed, however many sessions run
/// over it. Ends when the link does. A poisoned allowlist reads as "not
/// allowed", so it closes the link too (fail closed).
///
/// The revocation is also queued as a refusal notice, like the per-stream one,
/// so an `accept` caller sees that the peer is no longer known.
fn watch_revocation(conn: IrohConnection, allow: Allowlist, peer: String, queue: Arc<Queue>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(REVOCATION_INTERVAL).await;
            if conn.close_reason().is_some() {
                return;
            }
            if !allow.contains(&peer) {
                conn.close(1u32.into(), b"revoked");
                queue.refuse();
                return;
            }
        }
    });
}

/// Serve one authenticated link: check the key, then hand out its streams.
async fn serve_link(conn: IrohConnection, allow: Allowlist, queue: Arc<Queue>) {
    let peer = conn.remote_id().to_string();
    if !allow.contains(&peer) {
        conn.close(1u32.into(), b"unknown peer");
        queue.refuse();
        return;
    }
    watch_revocation(conn.clone(), allow.clone(), peer.clone(), queue.clone());
    loop {
        let Ok((send, mut recv)) = conn.accept_bi().await else {
            return;
        };
        // Revocation: a key removed after the link came up gets no new stream.
        if !allow.contains(&peer) {
            conn.close(1u32.into(), b"unknown peer");
            queue.refuse();
            return;
        }
        let queue = queue.clone();
        let allow = allow.clone();
        let conn = conn.clone();
        let peer = peer.clone();
        tokio::spawn(async move {
            let mut preface = [0u8; 4];
            let read = tokio::time::timeout(PREFACE_TIMEOUT, recv.read_exact(&mut preface)).await;
            if !matches!(read, Ok(Ok(()))) || &preface != PREFACE {
                return;
            }
            // Checked again after the preface wait: a key revoked meanwhile
            // gets nothing, and its link is closed.
            if !allow.contains(&peer) {
                conn.close(1u32.into(), b"unknown peer");
                queue.refuse();
                return;
            }
            let c: Box<dyn Connection> = Box::new(IrohConn {
                rt: Handle::current(),
                peer: PeerIdentity::Device(peer),
                send,
                recv,
                link: conn,
                deadline: None,
            });
            queue.admit(c);
        });
    }
}

impl Transport for IrohTransport {
    /// `address` is `<key>[@ip:port,...]`. The first `connect` to a peer dials
    /// it; later ones reuse the link and open a stream.
    fn connect(&self, address: &str) -> io::Result<Box<dyn Connection>> {
        let target = parse_address(address)?;
        let id = target.id;
        let (send, recv, link) = self.rt.block_on(async {
            let mut last: Option<io::Error> = None;
            // Cached link first; if its stream cannot be opened the link is
            // dead, so drop it and dial once.
            for attempt in 0..2 {
                let cached = if attempt == 0 {
                    self.links.lock().ok().and_then(|l| l.get(&id).cloned())
                } else {
                    None
                };
                let link = match cached {
                    Some(l) => l,
                    None => {
                        let l = self
                            .endpoint
                            .connect(target.clone(), ALPN)
                            .await
                            .map_err(|e| other("dial", e))?;
                        if let Ok(mut links) = self.links.lock() {
                            links.insert(id, l.clone());
                        }
                        l
                    }
                };
                match link.open_bi().await {
                    Ok((mut send, recv)) => match send.write_all(PREFACE).await {
                        Ok(()) => return Ok((send, recv, link)),
                        Err(e) => last = Some(other("preface", e)),
                    },
                    Err(e) => last = Some(other("open stream", e)),
                }
                if let Ok(mut links) = self.links.lock() {
                    links.remove(&id);
                }
            }
            Err(last.unwrap_or_else(|| io::Error::other("connect failed")))
        })?;
        Ok(Box::new(IrohConn {
            rt: self.rt.handle().clone(),
            peer: PeerIdentity::Device(id.to_string()),
            send,
            recv,
            link,
            deadline: None,
        }))
    }

    /// Blocks until a peer connects. An unknown peer yields
    /// `Ok(Err(Refusal::UnknownPeer))`; the peer never got a stream. An error
    /// until [`IrohTransport::listen`] has been called.
    fn accept(&self) -> io::Result<Result<Box<dyn Connection>, Refusal>> {
        if !self.listening.load(Ordering::SeqCst) {
            return Err(io::Error::new(
                io::ErrorKind::NotConnected,
                "call listen() before accept()",
            ));
        }
        // A poisoned lock is an error, never a panic and never a connection.
        let incoming = self
            .incoming
            .lock()
            .map_err(|_| io::Error::other("transport state poisoned"))?;
        let item = incoming
            .recv()
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "transport closed"))?;
        if item.is_err() {
            self.queue.pending_refusals.fetch_sub(1, Ordering::SeqCst);
        }
        Ok(item)
    }
}

struct IrohConn {
    rt: Handle,
    peer: PeerIdentity,
    send: SendStream,
    recv: RecvStream,
    /// Keeps the link alive while the stream is in use.
    link: IrohConnection,
    deadline: Option<Duration>,
}

impl Connection for IrohConn {
    fn peer(&self) -> &PeerIdentity {
        &self.peer
    }

    fn set_read_deadline(&mut self, deadline: Option<Duration>) -> io::Result<()> {
        self.deadline = deadline;
        Ok(())
    }

    fn split(self: Box<Self>) -> (Box<dyn Read + Send>, Box<dyn Write + Send>) {
        let c = *self;
        (
            Box::new(RecvHalf {
                rt: c.rt.clone(),
                recv: c.recv,
                deadline: c.deadline,
                _link: c.link.clone(),
            }),
            Box::new(SendHalf {
                rt: c.rt,
                send: c.send,
                _link: c.link,
            }),
        )
    }
}

struct RecvHalf {
    rt: Handle,
    recv: RecvStream,
    deadline: Option<Duration>,
    _link: IrohConnection,
}

impl Read for RecvHalf {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let deadline = self.deadline;
        let recv = &mut self.recv;
        // QuicStream::read is cancel-safe: a timed-out read consumed nothing.
        let res = self.rt.block_on(async {
            match deadline {
                Some(d) => tokio::time::timeout(d, recv.read(buf))
                    .await
                    .map_err(|_| io::Error::new(TIMEOUT_KIND, "read deadline")),
                None => Ok(recv.read(buf).await),
            }
        })?;
        match res {
            Ok(Some(n)) => Ok(n),
            Ok(None) => Ok(0),
            Err(e) => Err(io::Error::from(e)),
        }
    }
}

struct SendHalf {
    rt: Handle,
    send: SendStream,
    _link: IrohConnection,
}

impl Write for SendHalf {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let send = &mut self.send;
        self.rt
            .block_on(send.write(buf))
            .map_err(|e| io::Error::new(io::ErrorKind::BrokenPipe, e))
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for SendHalf {
    /// Finishing the stream is EOF for the peer's reader.
    fn drop(&mut self) {
        let _ = self.send.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{skip, watchdog};
    use std::sync::Arc;

    struct Node {
        t: Arc<IrohTransport>,
        key: String,
        allow: Allowlist,
    }

    /// Bind a loopback node. `None` (with a printed reason) only when the
    /// sandbox cannot bind a UDP socket; any other failure is a test failure.
    fn node() -> Option<Node> {
        let secret = SecretKey::generate();
        let key = secret.public().to_string();
        let allow = Allowlist::new();
        match IrohTransport::bind(IrohOptions::loopback(secret, allow.clone())) {
            Ok(t) => Some(Node {
                t: Arc::new(t),
                key,
                allow,
            }),
            Err(e) => {
                let s = e.to_string();
                // On CI a bind failure is a real failure, so a green run means
                // the transport was proven; elsewhere it is a printed skip.
                if std::env::var_os("CI").is_none() {
                    skip(&format!("iroh loopback endpoint cannot bind here: {s}"));
                    None
                } else {
                    panic!("unexpected iroh bind failure: {s}");
                }
            }
        }
    }

    fn echo_server(server: Arc<IrohTransport>) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let conn = server.accept().unwrap().unwrap();
            let (mut r, mut w) = conn.split();
            std::io::copy(&mut r, &mut w).unwrap();
        })
    }

    #[test]
    fn allowed_peer_connects_and_echoes() {
        watchdog(60, || {
            let (Some(server), Some(client)) = (node(), node()) else {
                return;
            };
            server.allow.add(&client.key).unwrap();
            server.t.listen().unwrap();
            let t = echo_server(server.t.clone());
            let conn = client.t.connect(&server.t.address()).unwrap();
            assert_eq!(conn.peer(), &PeerIdentity::Device(server.key.clone()));
            let (mut r, mut w) = conn.split();
            w.write_all(b"hello over iroh").unwrap();
            let mut out = [0u8; 15];
            r.read_exact(&mut out).unwrap();
            assert_eq!(&out, b"hello over iroh");
            drop(w);
            t.join().unwrap();
        });
    }

    #[test]
    fn acceptor_sees_the_dialers_device_key() {
        watchdog(60, || {
            let (Some(server), Some(client)) = (node(), node()) else {
                return;
            };
            server.allow.add(&client.key).unwrap();
            server.t.listen().unwrap();
            let s = server.t.clone();
            let t = std::thread::spawn(move || s.accept().unwrap().unwrap().peer().clone());
            let _conn = client.t.connect(&server.t.address()).unwrap();
            assert_eq!(t.join().unwrap(), PeerIdentity::Device(client.key.clone()));
        });
    }

    #[test]
    fn split_halves_work_concurrently() {
        watchdog(90, || {
            let (Some(server), Some(client)) = (node(), node()) else {
                return;
            };
            server.allow.add(&client.key).unwrap();
            server.t.listen().unwrap();
            let t = echo_server(server.t.clone());
            let conn = client.t.connect(&server.t.address()).unwrap();
            let (mut r, mut w) = conn.split();
            // Larger than any single window, so reader and writer must overlap.
            let payload: Vec<u8> = (0..1_500_000u32).map(|i| (i % 251) as u8).collect();
            let expect = payload.clone();
            let writer = std::thread::spawn(move || {
                w.write_all(&payload).unwrap();
                // dropping `w` finishes the stream
            });
            let mut got = vec![0u8; expect.len()];
            r.read_exact(&mut got).unwrap();
            writer.join().unwrap();
            assert!(got == expect, "echoed bytes differ");
            t.join().unwrap();
        });
    }

    #[test]
    fn read_deadline_times_out_a_silent_peer_and_loses_nothing() {
        watchdog(60, || {
            let (Some(server), Some(client)) = (node(), node()) else {
                return;
            };
            server.allow.add(&client.key).unwrap();
            server.t.listen().unwrap();
            let s = server.t.clone();
            let t = std::thread::spawn(move || {
                let conn = s.accept().unwrap().unwrap();
                let (mut r, mut w) = conn.split();
                // Silent until the client has seen its timeout.
                let mut b = [0u8; 1];
                r.read_exact(&mut b).unwrap();
                w.write_all(b"late").unwrap();
            });
            let mut conn = client.t.connect(&server.t.address()).unwrap();
            conn.set_read_deadline(Some(Duration::from_millis(300)))
                .unwrap();
            // The deadline set before the split carries into the read half.
            let (mut r, mut w) = conn.split();
            let mut buf = [0u8; 4];
            let err = r.read(&mut buf).unwrap_err();
            assert_eq!(err.kind(), TIMEOUT_KIND);
            w.write_all(b"x").unwrap();
            r.read_exact(&mut buf).unwrap();
            assert_eq!(&buf, b"late");
            t.join().unwrap();
        });
    }

    #[test]
    fn unknown_peer_is_refused_before_any_session_bytes() {
        watchdog(60, || {
            let (Some(server), Some(client)) = (node(), node()) else {
                return;
            };
            // The server's allowlist is empty: the client is a stranger.
            server.t.listen().unwrap();
            let s = server.t.clone();
            let t = std::thread::spawn(move || s.accept().unwrap());
            let dialed = client.t.connect(&server.t.address());
            let accepted = t.join().unwrap();
            assert!(matches!(accepted, Err(Refusal::UnknownPeer)));
            if let Ok(conn) = dialed {
                // The handshake can finish before the close lands, but the
                // stranger must never get a byte of session or an open stream.
                let (mut r, mut w) = conn.split();
                let _ = w.write_all(b"sneaky session bytes");
                let mut buf = [0u8; 8];
                match r.read(&mut buf) {
                    Ok(0) | Err(_) => {}
                    Ok(n) => panic!("a refused peer received {n} bytes"),
                }
            }
        });
    }

    #[test]
    fn removing_a_key_stops_its_next_stream() {
        watchdog(60, || {
            let (Some(server), Some(client)) = (node(), node()) else {
                return;
            };
            server.allow.add(&client.key).unwrap();
            server.t.listen().unwrap();
            let s = server.t.clone();
            let first = std::thread::spawn(move || s.accept().unwrap().is_ok());
            let _c1 = client.t.connect(&server.t.address()).unwrap();
            assert!(first.join().unwrap());
            server.allow.remove(&client.key);
            let s = server.t.clone();
            let second = std::thread::spawn(move || s.accept().unwrap());
            let _ = client.t.connect(&server.t.address());
            assert!(matches!(second.join().unwrap(), Err(Refusal::UnknownPeer)));
        });
    }

    #[test]
    fn removing_a_key_ends_its_live_session() {
        watchdog(60, || {
            let (Some(server), Some(client)) = (node(), node()) else {
                return;
            };
            server.allow.add(&client.key).unwrap();
            server.t.listen().unwrap();
            let s = server.t.clone();
            let echo = std::thread::spawn(move || {
                let conn = s.accept().unwrap().unwrap();
                let (mut r, mut w) = conn.split();
                // Ends with an error or EOF once the link is closed.
                let _ = std::io::copy(&mut r, &mut w);
            });
            let conn = client.t.connect(&server.t.address()).unwrap();
            let (mut r, mut w) = conn.split();
            w.write_all(b"ping").unwrap();
            let mut out = [0u8; 4];
            r.read_exact(&mut out).unwrap();
            assert_eq!(&out, b"ping");
            // The session is live and idle. Removing the key must end it.
            server.allow.remove(&client.key);
            let mut buf = [0u8; 8];
            match r.read(&mut buf) {
                Ok(0) | Err(_) => {}
                Ok(n) => panic!("a revoked peer received {n} bytes"),
            }
            echo.join().unwrap();
        });
    }

    #[test]
    fn link_slots_are_capped_and_released() {
        let active = Arc::new(AtomicUsize::new(0));
        let a = LinkSlot::take(&active, 2).unwrap();
        let _b = LinkSlot::take(&active, 2).unwrap();
        assert!(LinkSlot::take(&active, 2).is_none());
        assert_eq!(active.load(Ordering::SeqCst), 2);
        drop(a);
        assert!(LinkSlot::take(&active, 2).is_some());
    }

    #[test]
    fn connects_to_one_peer_share_one_link() {
        watchdog(60, || {
            let (Some(server), Some(client)) = (node(), node()) else {
                return;
            };
            server.allow.add(&client.key).unwrap();
            server.t.listen().unwrap();
            let s = server.t.clone();
            let t = std::thread::spawn(move || {
                let a = s.accept().unwrap().unwrap();
                let b = s.accept().unwrap().unwrap();
                (a, b)
            });
            let _a = client.t.connect(&server.t.address()).unwrap();
            let _b = client.t.connect(&server.t.address()).unwrap();
            let _held = t.join().unwrap();
            assert_eq!(client.t.link_count(), 1);
        });
    }

    #[test]
    fn nothing_is_accepted_before_listen() {
        watchdog(60, || {
            let (Some(server), Some(client)) = (node(), node()) else {
                return;
            };
            server.allow.add(&client.key).unwrap();
            // accept() without listen() is an error, not a hang.
            assert_eq!(
                server.t.accept().err().unwrap().kind(),
                io::ErrorKind::NotConnected
            );
            // The endpoint advertises no ALPN yet, so a dial fails.
            assert!(client.t.connect(&server.t.address()).is_err());
            // After listen() the same peer gets in.
            server.t.listen().unwrap();
            server.t.listen().unwrap();
            let s = server.t.clone();
            let t = std::thread::spawn(move || s.accept().unwrap().is_ok());
            let _c = client.t.connect(&server.t.address()).unwrap();
            assert!(t.join().unwrap());
        });
    }

    #[test]
    fn address_parsing() {
        let k = SecretKey::generate().public().to_string();
        assert!(parse_address(&k).is_ok());
        assert!(parse_address(&format!("{k}@127.0.0.1:9,[::1]:10")).is_ok());
        assert!(parse_address("nope").is_err());
        assert!(parse_address(&format!("{k}@not-an-addr")).is_err());
    }
}
