//! Team relay: a small TCP server one Canopy hosts and teammates join over
//! the LAN with a 7-digit code (TeamViewer-style, regenerable at any time).
//! The host relays presence, chat and commands ("review this PR") between
//! members; nothing touches any outside service. JSON-lines over plain TCP,
//! std::net threads — the same spawn-a-named-thread idiom as the monitor and
//! hook bridge, and no new dependency.
//!
//! Trust model: this is a same-team convenience on a network you already
//! share, not a security boundary. The code gates entry; frames from a peer
//! are re-stamped with the identity that joined, so a member can't speak as
//! someone else. Traffic is not encrypted — the panel says so.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

/// "CANOPY" on a phone keypad is 226679 — one digit too long for a port, so
/// the tail of it. Only a default; the host can pass any port.
pub const DEFAULT_PORT: u16 = 6679;
/// Dead-peer sweep: a vanished laptop would otherwise sit in the member list
/// until the next write to it happened to fail.
const PING_EVERY: Duration = Duration::from_secs(30);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Process-seeded randomness without a rand crate: RandomState is freshly
/// seeded per call. Session codes and member ids — not cryptography.
fn entropy() -> u64 {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut h = RandomState::new().build_hasher();
    h.write_u64(now_ms());
    h.finish()
}

fn new_code() -> String {
    format!("{:07}", entropy() % 10_000_000)
}

fn new_id() -> String {
    format!("{:012x}", entropy() & 0xffff_ffff_ffff)
}

// ---------- wire protocol (JSON lines, tagged by "type") ----------

#[derive(Serialize, Deserialize, Clone)]
pub struct Member {
    pub id: String,
    pub name: String,
    pub joined_ms: u64,
    pub is_host: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ChatMsg {
    pub id: String,
    pub from: String,
    pub from_name: String,
    /// None = everyone; Some(id) = a direct message.
    pub to: Option<String>,
    pub text: String,
    pub ts: u64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct CommandMsg {
    pub id: String,
    pub from: String,
    pub from_name: String,
    pub to: Option<String>,
    /// e.g. "open-pr" — the payload's shape belongs to the kind.
    pub kind: String,
    pub payload: Value,
    pub ts: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum Frame {
    /// `code` is legacy — the PAKE handshake already proved it, so the host
    /// ignores it. Kept so a join is a self-describing frame.
    Join { code: String, name: String },
    Welcome { self_id: String, members: Vec<Member> },
    Presence { members: Vec<Member> },
    Chat(ChatMsg),
    Command(CommandMsg),
    Ping,
    Pong,
}

/// Encrypt a frame and put it on a peer's channel. Every send goes through the
/// per-peer `Arc<Mutex<Sender>>`: the AEAD nonce is a send counter, so two
/// threads writing the same channel unserialised would reuse a nonce.
fn peer_send(sender: &Arc<Mutex<secure::Sender>>, frame: &Frame) -> bool {
    match serde_json::to_vec(frame) {
        Ok(bytes) => sender.lock().unwrap().send(&bytes),
        Err(_) => false,
    }
}

/// End-to-end encryption for the relay. The join code is a low-entropy secret,
/// so it can't be used as a key directly — a captured handshake would be
/// brute-forceable offline. SPAKE2 (a PAKE, the same construction
/// magic-wormhole uses) turns it into a strong, mutually-authenticated session
/// key: an attacker gets one online guess per connection (which the tarpit
/// throttles) and learns nothing from eavesdropping. HKDF splits that key
/// per-direction; ChaCha20-Poly1305 encrypts and authenticates every frame.
mod secure {
    use chacha20poly1305::aead::{Aead, KeyInit};
    use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
    use hkdf::Hkdf;
    use sha2::Sha256;
    use spake2::{Ed25519Group, Identity, Password, Spake2};
    use std::io::{BufReader, Read, Write};
    use std::net::{Shutdown, TcpStream};

    /// Ceiling on one encrypted frame. A larger length prefix is a broken or
    /// hostile peer; the connection drops rather than allocating it.
    const MAX_FRAME: usize = 2 * 1024 * 1024;

    /// 96-bit nonce = 4 zero bytes + a 64-bit counter. Unique per (key,
    /// direction) because each direction has its own key and a monotonic
    /// counter — the one thing ChaCha20-Poly1305 must never repeat.
    fn nonce_bytes(counter: u64) -> [u8; 12] {
        let mut n = [0u8; 12];
        n[4..].copy_from_slice(&counter.to_be_bytes());
        n
    }

    /// One 32-byte key from `key` for the labelled purpose/direction.
    pub fn derive(key: &[u8], info: &[u8]) -> [u8; 32] {
        let hk = Hkdf::<Sha256>::new(None, key);
        let mut okm = [0u8; 32];
        hk.expand(info, &mut okm).expect("hkdf expand into 32 bytes never fails");
        okm
    }

    fn write_prefixed(mut w: &TcpStream, data: &[u8]) -> std::io::Result<()> {
        w.write_all(&(data.len() as u32).to_be_bytes())?;
        w.write_all(data)?;
        w.flush()
    }

    fn read_prefixed(r: &mut impl Read) -> std::io::Result<Vec<u8>> {
        let mut lenb = [0u8; 4];
        r.read_exact(&mut lenb)?;
        let len = u32::from_be_bytes(lenb) as usize;
        if len > MAX_FRAME {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
        }
        let mut buf = vec![0u8; len];
        r.read_exact(&mut buf)?;
        Ok(buf)
    }

    /// The encrypting half of a channel. NOT internally synchronised — wrap it
    /// in a Mutex; the counter nonce demands serialised sends.
    pub struct Sender {
        cipher: ChaCha20Poly1305,
        counter: u64,
        stream: TcpStream,
    }

    impl Sender {
        pub fn send(&mut self, plaintext: &[u8]) -> bool {
            let nonce = nonce_bytes(self.counter);
            let Ok(ct) = self.cipher.encrypt(Nonce::from_slice(&nonce), plaintext) else {
                return false;
            };
            self.counter = self.counter.wrapping_add(1);
            write_prefixed(&self.stream, &ct).is_ok()
        }
    }

    /// The decrypting half. A failed decrypt (wrong key, tampering) or a short
    /// read yields None — the caller treats that as end-of-connection.
    pub struct Receiver {
        cipher: ChaCha20Poly1305,
        counter: u64,
        reader: BufReader<TcpStream>,
    }

    impl Receiver {
        pub fn recv(&mut self) -> Option<Vec<u8>> {
            let ct = read_prefixed(&mut self.reader).ok()?;
            let nonce = nonce_bytes(self.counter);
            let pt = self.cipher.decrypt(Nonce::from_slice(&nonce), ct.as_ref()).ok()?;
            self.counter = self.counter.wrapping_add(1);
            Some(pt)
        }
    }

    fn channel(stream: &TcpStream, send_key: [u8; 32], recv_key: [u8; 32]) -> Option<(Sender, Receiver)> {
        Some((
            Sender {
                cipher: ChaCha20Poly1305::new(Key::from_slice(&send_key)),
                counter: 0,
                stream: stream.try_clone().ok()?,
            },
            Receiver {
                cipher: ChaCha20Poly1305::new(Key::from_slice(&recv_key)),
                counter: 0,
                reader: BufReader::new(stream.try_clone().ok()?),
            },
        ))
    }

    /// SPAKE2 over the raw stream, keyed by `code`. The joining client is the
    /// initiator and writes first; the host responds. Both derive the same
    /// session key and split it per-direction. Returns None only if the socket
    /// dies mid-handshake — a WRONG code still returns channels here (SPAKE2
    /// always completes), but with a mismatched key, so the first real frame
    /// fails to decrypt. That is where a bad code is rejected.
    pub fn handshake(stream: &TcpStream, code: &str, initiator: bool) -> Option<(Sender, Receiver)> {
        let (state, mine) = Spake2::<Ed25519Group>::start_symmetric(
            &Password::new(code.as_bytes()),
            &Identity::new(b"canopy-relay"),
        );
        let theirs = if initiator {
            write_prefixed(stream, &mine).ok()?;
            read_prefixed(&mut { stream }).ok()?
        } else {
            let t = read_prefixed(&mut { stream }).ok()?;
            write_prefixed(stream, &mine).ok()?;
            t
        };
        let key = state.finish(&theirs).ok()?;
        let i2r = derive(&key, b"canopy-relay initiator->responder");
        let r2i = derive(&key, b"canopy-relay responder->initiator");
        if initiator {
            channel(stream, i2r, r2i)
        } else {
            channel(stream, r2i, i2r)
        }
    }

    /// Transfer channel keyed by the offer's 128-bit token (high-entropy, so
    /// no PAKE — the token is derived straight into keys). Bulk flows
    /// sender->receiver; the receiver's first frame authenticates it (only a
    /// holder of the token can produce a decryptable one).
    pub fn file_channel(stream: &TcpStream, token: &str, is_sender: bool) -> Option<(Sender, Receiver)> {
        let s2r = derive(token.as_bytes(), b"canopy-file sender->receiver");
        let r2s = derive(token.as_bytes(), b"canopy-file receiver->sender");
        if is_sender {
            channel(stream, s2r, r2s)
        } else {
            channel(stream, r2s, s2r)
        }
    }

    /// Break a channel's underlying socket so a blocked `recv` returns.
    pub fn shutdown(stream: &TcpStream) {
        let _ = stream.shutdown(Shutdown::Both);
    }
}

// ---------- state ----------

struct Peer {
    member: Member,
    /// Encrypted writer to this peer. Every fan-out (chat, presence, ping)
    /// locks it — the AEAD counter nonce forbids concurrent sends.
    sender: Arc<Mutex<secure::Sender>>,
    /// A bare clone of the socket, only for `shutdown` on teardown — lock-free
    /// so closing a dead peer can't block on a send in flight.
    shutdown: TcpStream,
}

struct Host {
    code: String,
    port: u16,
    self_id: String,
    name: String,
    /// "local" (LAN) or "public" (reachable over the internet — the listener
    /// binds all interfaces either way; this drives which address we surface
    /// and whether the public IP is looked up).
    visibility: String,
    /// Discovered when visibility is "public"; None when the lookup failed.
    public_ip: Option<String>,
    peers: HashMap<String, Peer>,
    /// Flips false on stop; the listener and every reader checks it before
    /// touching state, so threads of a stopped relay can't haunt the next one.
    alive: Arc<AtomicBool>,
}

struct Client {
    addr: String,
    self_id: String,
    name: String,
    members: Vec<Member>,
    /// Encrypted writer to the host (which relays onward).
    sender: Arc<Mutex<secure::Sender>>,
    shutdown: TcpStream,
    alive: Arc<AtomicBool>,
}

#[derive(Default)]
struct Inner {
    host: Option<Host>,
    client: Option<Client>,
    /// Live outgoing file offers by token — flipping the flag retires the
    /// one-shot listener serving that file.
    transfers: HashMap<String, Arc<AtomicBool>>,
}

#[derive(Default)]
pub struct RelayManager {
    inner: Arc<Mutex<Inner>>,
}

impl RelayManager {
    /// App exit: close everything so no socket outlives the window.
    pub fn shutdown(&self) {
        let mut inner = self.inner.lock().unwrap();
        stop_host(&mut inner);
        stop_client(&mut inner);
        for alive in inner.transfers.values() {
            alive.store(false, Ordering::SeqCst);
        }
        inner.transfers.clear();
    }
}

#[derive(Serialize, Clone)]
pub struct RelayStatus {
    /// "off" | "host" | "client"
    pub role: String,
    pub code: Option<String>,
    pub port: Option<u16>,
    /// Host only: LAN addresses teammates can reach us on.
    pub ips: Vec<String>,
    /// Client only: the host address we joined.
    pub addr: Option<String>,
    pub self_id: Option<String>,
    pub name: Option<String>,
    /// Host only: "local" | "public".
    pub visibility: Option<String>,
    /// Host only, public visibility: the internet-facing address teammates
    /// dial. None while unknown (lookup failed / local mode).
    pub public_ip: Option<String>,
    pub members: Vec<Member>,
}

/// The machine's outward-facing IP, via the UDP-connect trick: connecting a
/// datagram socket sends nothing but makes the OS pick the route (and thus
/// the local address) it would use. Works without any interface-enumeration
/// dependency; empty when there is no route at all.
fn local_ips() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = sock.local_addr() {
                out.push(addr.ip().to_string());
            }
        }
    }
    out
}

fn host_members(host: &Host) -> Vec<Member> {
    let mut members = vec![Member {
        id: host.self_id.clone(),
        name: host.name.clone(),
        joined_ms: 0,
        is_host: true,
    }];
    let mut rest: Vec<Member> = host.peers.values().map(|p| p.member.clone()).collect();
    rest.sort_by_key(|m| m.joined_ms);
    members.extend(rest);
    members
}

fn status_of(inner: &Inner) -> RelayStatus {
    if let Some(host) = &inner.host {
        return RelayStatus {
            role: "host".into(),
            code: Some(host.code.clone()),
            port: Some(host.port),
            ips: local_ips(),
            addr: None,
            self_id: Some(host.self_id.clone()),
            name: Some(host.name.clone()),
            visibility: Some(host.visibility.clone()),
            public_ip: host.public_ip.clone(),
            members: host_members(host),
        };
    }
    if let Some(client) = &inner.client {
        return RelayStatus {
            role: "client".into(),
            code: None,
            port: None,
            ips: Vec::new(),
            addr: Some(client.addr.clone()),
            self_id: Some(client.self_id.clone()),
            name: Some(client.name.clone()),
            visibility: None,
            public_ip: None,
            members: client.members.clone(),
        };
    }
    RelayStatus {
        role: "off".into(),
        code: None,
        port: None,
        ips: Vec::new(),
        addr: None,
        self_id: None,
        name: None,
        visibility: None,
        public_ip: None,
        members: Vec::new(),
    }
}

/// The address the internet sees, asked of an IP echo service (curl, like the
/// Linear integration — no HTTP client dependency). Only called for a relay
/// the user explicitly made public; a local relay never phones anywhere.
fn fetch_public_ip() -> Option<String> {
    for url in ["https://api.ipify.org", "https://ifconfig.me/ip"] {
        let Ok(out) = std::process::Command::new("curl")
            .args(["-s", "--max-time", "4", url])
            .output()
        else {
            continue;
        };
        if out.status.success() {
            let ip = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if ip.parse::<std::net::IpAddr>().is_ok() {
                return Some(ip);
            }
        }
    }
    None
}

fn emit_state(app: &AppHandle, inner: &Inner) {
    let _ = app.emit("relay:state", status_of(inner));
}

/// Presence to every connected peer.
fn broadcast_presence(host: &Host) {
    let frame = Frame::Presence { members: host_members(host) };
    for peer in host.peers.values() {
        let _ = peer_send(&peer.sender, &frame);
    }
}

fn stop_host(inner: &mut Inner) {
    if let Some(host) = inner.host.take() {
        host.alive.store(false, Ordering::SeqCst);
        for peer in host.peers.values() {
            let _ = peer.shutdown.shutdown(Shutdown::Both);
        }
    }
}

fn stop_client(inner: &mut Inner) {
    if let Some(client) = inner.client.take() {
        client.alive.store(false, Ordering::SeqCst);
        let _ = client.shutdown.shutdown(Shutdown::Both);
    }
}

// ---------- host ----------

#[tauri::command]
pub async fn relay_host_start(
    app: AppHandle,
    state: State<'_, RelayManager>,
    name: String,
    port: Option<u16>,
    visibility: Option<String>,
) -> Result<RelayStatus, String> {
    let inner_arc = state.inner.clone();
    {
        let inner = inner_arc.lock().unwrap();
        if inner.host.is_some() {
            return Err("Already hosting a relay.".into());
        }
        if inner.client.is_some() {
            return Err("Connected to another relay — disconnect first.".into());
        }
    }
    let want = port.unwrap_or(DEFAULT_PORT);
    // Requested port first; if the default is taken (another Canopy on this
    // machine, say) fall back to an ephemeral one rather than failing —
    // unless the user explicitly chose the port, in which case fail honestly.
    let listener = match TcpListener::bind(("0.0.0.0", want)) {
        Ok(l) => l,
        Err(e) if port.is_some() => return Err(format!("Couldn't bind port {want}: {e}")),
        Err(_) => TcpListener::bind(("0.0.0.0", 0)).map_err(|e| format!("Couldn't bind a port: {e}"))?,
    };
    let actual = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("listener setup failed: {e}"))?;

    let alive = Arc::new(AtomicBool::new(true));
    let name = if name.trim().is_empty() { "host".to_string() } else { name.trim().to_string() };
    let visibility = match visibility.as_deref() {
        Some("public") => "public".to_string(),
        _ => "local".to_string(),
    };
    // Blocking curl (≤8s worst case) before the relay reports ready — the
    // address is the thing the host exists to hand out, so "started but I
    // can't tell you where" would be a worse trade.
    let public_ip = if visibility == "public" { fetch_public_ip() } else { None };
    let host = Host {
        code: new_code(),
        port: actual,
        self_id: new_id(),
        name,
        visibility,
        public_ip,
        peers: HashMap::new(),
        alive: alive.clone(),
    };
    let status = {
        let mut inner = inner_arc.lock().unwrap();
        inner.host = Some(host);
        status_of(&inner)
    };

    let accept_app = app.clone();
    let accept_inner = inner_arc.clone();
    thread::Builder::new()
        .name("relay-host".into())
        .spawn(move || {
            let mut last_ping = Instant::now();
            loop {
                if !alive.load(Ordering::SeqCst) {
                    return;
                }
                match listener.accept() {
                    Ok((stream, _)) => {
                        let app = accept_app.clone();
                        let inner = accept_inner.clone();
                        let alive = alive.clone();
                        let _ = thread::Builder::new()
                            .name("relay-peer".into())
                            .spawn(move || host_conn(app, inner, stream, alive));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(200));
                    }
                    Err(_) => thread::sleep(Duration::from_millis(200)),
                }
                // Dead-peer sweep: a ping that can't be written is a peer that
                // is gone. Their reader thread does the actual removal when its
                // read fails after the shutdown below.
                if last_ping.elapsed() >= PING_EVERY {
                    last_ping = Instant::now();
                    let inner = accept_inner.lock().unwrap();
                    if let Some(host) = &inner.host {
                        for peer in host.peers.values() {
                            if !peer_send(&peer.sender, &Frame::Ping) {
                                let _ = peer.shutdown.shutdown(Shutdown::Both);
                            }
                        }
                    }
                }
            }
        })
        .map_err(|e| format!("couldn't spawn relay thread: {e}"))?;

    emit_state(&app, &inner_arc.lock().unwrap());
    Ok(status)
}

/// One joined connection, host side: secure handshake, authenticate, register,
/// then relay each frame until the peer hangs up.
fn host_conn(app: AppHandle, inner: Arc<Mutex<Inner>>, stream: TcpStream, alive: Arc<AtomicBool>) {
    // A join must arrive promptly; port-scanners and half-open connections
    // get dropped instead of parked forever.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));

    // SPAKE2 keyed by the code current at connect time — read it, then run the
    // handshake off-lock (it's ~100ms of pure CPU, not something to hold the
    // relay's mutex for).
    let code = {
        let guard = inner.lock().unwrap();
        let Some(host) = guard.host.as_ref() else { return };
        if !alive.load(Ordering::SeqCst) {
            return;
        }
        host.code.clone()
    };
    let Some((sender, mut receiver)) = secure::handshake(&stream, &code, false) else {
        secure::shutdown(&stream);
        return;
    };
    let sender = Arc::new(Mutex::new(sender));

    // The first encrypted frame must be the Join. A wrong code produced a
    // different session key on the far side, so this decrypt fails — that is
    // how a bad code is now rejected. Tarpit that case: two seconds per wrong
    // guess makes brute-forcing 10M codes a non-starter (a public relay gets
    // probed) while a mistyped code barely notices.
    let name = match receiver.recv().and_then(|b| serde_json::from_slice::<Frame>(&b).ok()) {
        Some(Frame::Join { name, .. }) => name,
        _ => {
            thread::sleep(Duration::from_secs(2));
            secure::shutdown(&stream);
            return;
        }
    };
    let Ok(shutdown) = stream.try_clone() else { return };

    // Register under the lock. Order matters on the new peer's wire: Welcome
    // must be its FIRST frame, so it goes out before the presence update —
    // which therefore skips the newcomer (Welcome already carries the list).
    let (my_id, my_name) = {
        let mut guard = inner.lock().unwrap();
        let Some(host) = guard.host.as_mut() else { return };
        if !alive.load(Ordering::SeqCst) {
            return;
        }
        let id = new_id();
        let name = if name.trim().is_empty() { format!("guest-{}", &id[..4]) } else { name.trim().to_string() };
        host.peers.insert(
            id.clone(),
            Peer {
                member: Member { id: id.clone(), name: name.clone(), joined_ms: now_ms(), is_host: false },
                sender: sender.clone(),
                shutdown,
            },
        );
        let members = host_members(host);
        if !peer_send(&sender, &Frame::Welcome { self_id: id.clone(), members: members.clone() }) {
            host.peers.remove(&id);
            return;
        }
        let presence = Frame::Presence { members };
        for (pid, peer) in &host.peers {
            if pid != &id {
                let _ = peer_send(&peer.sender, &presence);
            }
        }
        emit_state(&app, &guard);
        (id, name)
    };

    // Joined: reads now block until the peer speaks or disconnects.
    let _ = stream.set_read_timeout(None);
    loop {
        let Some(bytes) = receiver.recv() else { break };
        let Ok(frame) = serde_json::from_slice::<Frame>(&bytes) else { continue };
        let guard = inner.lock().unwrap();
        let Some(host) = guard.host.as_ref() else { break };
        if !alive.load(Ordering::SeqCst) || !host.peers.contains_key(&my_id) {
            break;
        }
        match frame {
            Frame::Chat(mut msg) => {
                // The connection is the identity — whatever the frame claimed.
                msg.from = my_id.clone();
                msg.from_name = my_name.clone();
                msg.ts = now_ms();
                if msg.id.is_empty() {
                    msg.id = new_id();
                }
                route(&app, host, &my_id, msg.to.clone(), Frame::Chat(msg.clone()), "relay:chat");
            }
            Frame::Command(mut msg) => {
                msg.from = my_id.clone();
                msg.from_name = my_name.clone();
                msg.ts = now_ms();
                if msg.id.is_empty() {
                    msg.id = new_id();
                }
                route(&app, host, &my_id, msg.to.clone(), Frame::Command(msg.clone()), "relay:command");
            }
            Frame::Ping => {
                if let Some(peer) = host.peers.get(&my_id) {
                    let _ = peer_send(&peer.sender, &Frame::Pong);
                }
            }
            _ => {}
        }
    }
    remove_peer(&app, &inner, &my_id);
}

/// Host-side fan-out for a member's frame: everyone (except the sender), one
/// peer, or the host itself — the last lands only in our own UI.
fn route(app: &AppHandle, host: &Host, sender: &str, to: Option<String>, frame: Frame, event: &str) {
    let emit_local = |frame: &Frame| match frame {
        Frame::Chat(m) => {
            let _ = app.emit(event, m.clone());
        }
        Frame::Command(m) => {
            let _ = app.emit(event, m.clone());
        }
        _ => {}
    };
    match to {
        None => {
            for (id, peer) in &host.peers {
                if id != sender {
                    let _ = peer_send(&peer.sender, &frame);
                }
            }
            emit_local(&frame);
        }
        Some(target) if target == host.self_id => emit_local(&frame),
        Some(target) => {
            if let Some(peer) = host.peers.get(&target) {
                let _ = peer_send(&peer.sender, &frame);
            }
        }
    }
}

fn remove_peer(app: &AppHandle, inner: &Arc<Mutex<Inner>>, id: &str) {
    let mut guard = inner.lock().unwrap();
    let Some(host) = guard.host.as_mut() else { return };
    if let Some(peer) = host.peers.remove(id) {
        let _ = peer.shutdown.shutdown(Shutdown::Both);
        broadcast_presence(host);
        emit_state(app, &guard);
    }
}

#[tauri::command]
pub async fn relay_host_stop(app: AppHandle, state: State<'_, RelayManager>) -> Result<RelayStatus, String> {
    let mut inner = state.inner.lock().unwrap();
    stop_host(&mut inner);
    emit_state(&app, &inner);
    Ok(status_of(&inner))
}

/// New code, effective immediately for NEW joins. Members already connected
/// stay — same as TeamViewer: the code is a door key, not a session key.
#[tauri::command]
pub async fn relay_regenerate_code(
    app: AppHandle,
    state: State<'_, RelayManager>,
) -> Result<RelayStatus, String> {
    let mut inner = state.inner.lock().unwrap();
    let host = inner.host.as_mut().ok_or("Not hosting.")?;
    host.code = new_code();
    emit_state(&app, &inner);
    Ok(status_of(&inner))
}

// ---------- client ----------

#[tauri::command]
pub async fn relay_connect(
    app: AppHandle,
    state: State<'_, RelayManager>,
    addr: String,
    code: String,
    name: String,
) -> Result<RelayStatus, String> {
    let inner_arc = state.inner.clone();
    {
        let inner = inner_arc.lock().unwrap();
        if inner.client.is_some() {
            return Err("Already connected to a relay.".into());
        }
        if inner.host.is_some() {
            return Err("You are hosting a relay — stop it before joining another.".into());
        }
    }
    // Bare IP/hostname gets the default port appended.
    let addr = addr.trim().to_string();
    let full = if addr.contains(':') { addr.clone() } else { format!("{addr}:{DEFAULT_PORT}") };
    let sock_addr = full
        .parse::<std::net::SocketAddr>()
        .or_else(|_| {
            use std::net::ToSocketAddrs;
            full.to_socket_addrs()
                .ok()
                .and_then(|mut a| a.next())
                .ok_or(std::net::AddrParseError::from(
                    // unreachable placeholder; mapped to a string below
                    "0".parse::<std::net::SocketAddr>().unwrap_err(),
                ))
        })
        .map_err(|_| format!("Not a valid address: {full}"))?;
    let stream = TcpStream::connect_timeout(&sock_addr, Duration::from_secs(5))
        .map_err(|e| format!("Couldn't reach {full}: {e}"))?;
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let name = if name.trim().is_empty() { "guest".to_string() } else { name.trim().to_string() };
    // SPAKE2 as the initiator, keyed by the code we were given.
    let Some((sender, mut receiver)) = secure::handshake(&stream, code.trim(), true) else {
        return Err("Couldn't establish a secure channel — check the address and that the relay is running.".into());
    };
    let sender = Arc::new(Mutex::new(sender));
    if !peer_send(&sender, &Frame::Join { code: String::new(), name: name.clone() }) {
        return Err("Couldn't talk to the relay.".into());
    }
    // Welcome is our first encrypted frame back. If the code was wrong, our
    // key doesn't match the host's and this fails to decrypt — reported as a
    // refused code rather than a mysterious hang.
    let (self_id, members) = match receiver.recv().and_then(|b| serde_json::from_slice::<Frame>(&b).ok()) {
        Some(Frame::Welcome { self_id, members }) => (self_id, members),
        _ => return Err("The relay refused the connection — wrong code, or it isn't reachable.".into()),
    };
    let _ = stream.set_read_timeout(None);

    let alive = Arc::new(AtomicBool::new(true));
    let client = Client {
        addr: full.clone(),
        self_id,
        name,
        members,
        sender: sender.clone(),
        shutdown: stream.try_clone().map_err(|e| e.to_string())?,
        alive: alive.clone(),
    };
    let status = {
        let mut inner = inner_arc.lock().unwrap();
        inner.client = Some(client);
        status_of(&inner)
    };
    emit_state(&app, &inner_arc.lock().unwrap());

    let reader_app = app.clone();
    let reader_inner = inner_arc.clone();
    let reader_sender = sender.clone();
    thread::Builder::new()
        .name("relay-client".into())
        .spawn(move || {
            loop {
                let Some(bytes) = receiver.recv() else { break };
                if !alive.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(frame) = serde_json::from_slice::<Frame>(&bytes) else { continue };
                match frame {
                    Frame::Presence { members } => {
                        let mut inner = reader_inner.lock().unwrap();
                        if let Some(client) = inner.client.as_mut() {
                            client.members = members;
                            emit_state(&reader_app, &inner);
                        }
                    }
                    Frame::Chat(msg) => {
                        let _ = reader_app.emit("relay:chat", msg);
                    }
                    Frame::Command(msg) => {
                        let _ = reader_app.emit("relay:command", msg);
                    }
                    Frame::Ping => {
                        let _ = peer_send(&reader_sender, &Frame::Pong);
                    }
                    _ => {}
                }
            }
            // The host hung up (or we were disconnected): clear state if this
            // connection is still the current one.
            if alive.load(Ordering::SeqCst) {
                let mut inner = reader_inner.lock().unwrap();
                let current = inner
                    .client
                    .as_ref()
                    .map(|c| Arc::ptr_eq(&c.alive, &alive))
                    .unwrap_or(false);
                if current {
                    stop_client(&mut inner);
                    emit_state(&reader_app, &inner);
                }
            }
        })
        .map_err(|e| format!("couldn't spawn relay reader: {e}"))?;

    Ok(status)
}

#[tauri::command]
pub async fn relay_disconnect(app: AppHandle, state: State<'_, RelayManager>) -> Result<RelayStatus, String> {
    let mut inner = state.inner.lock().unwrap();
    stop_client(&mut inner);
    emit_state(&app, &inner);
    Ok(status_of(&inner))
}

#[tauri::command]
pub async fn relay_status(state: State<'_, RelayManager>) -> Result<RelayStatus, String> {
    Ok(status_of(&state.inner.lock().unwrap()))
}

// ---------- sending (either role) ----------

/// Identity + a way to reach the wire, resolved from whichever role is live.
fn sender_context(inner: &Inner) -> Result<(String, String), String> {
    if let Some(host) = &inner.host {
        return Ok((host.self_id.clone(), host.name.clone()));
    }
    if let Some(client) = &inner.client {
        return Ok((client.self_id.clone(), client.name.clone()));
    }
    Err("Not connected to a relay.".into())
}

#[tauri::command]
pub async fn relay_send_chat(
    state: State<'_, RelayManager>,
    to: Option<String>,
    text: String,
) -> Result<ChatMsg, String> {
    let inner = state.inner.lock().unwrap();
    let (from, from_name) = sender_context(&inner)?;
    let msg = ChatMsg {
        id: new_id(),
        from,
        from_name,
        to: to.clone(),
        text,
        ts: now_ms(),
    };
    deliver(&inner, to, Frame::Chat(msg.clone()))?;
    Ok(msg)
}

#[tauri::command]
pub async fn relay_send_command(
    state: State<'_, RelayManager>,
    to: Option<String>,
    kind: String,
    payload: Value,
) -> Result<CommandMsg, String> {
    let inner = state.inner.lock().unwrap();
    let (from, from_name) = sender_context(&inner)?;
    let msg = CommandMsg {
        id: new_id(),
        from,
        from_name,
        to: to.clone(),
        kind,
        payload,
        ts: now_ms(),
    };
    deliver(&inner, to, Frame::Command(msg.clone()))?;
    Ok(msg)
}

/// Put a frame of ours on the wire. Host: straight to the target peer(s) —
/// we ARE the relay. Client: to the host, which routes it. The sender's own
/// UI appends the returned message; nothing is echoed back.
fn deliver(inner: &Inner, to: Option<String>, frame: Frame) -> Result<(), String> {
    if let Some(host) = &inner.host {
        match to {
            None => {
                for peer in host.peers.values() {
                    let _ = peer_send(&peer.sender, &frame);
                }
            }
            Some(target) => {
                let peer = host.peers.get(&target).ok_or("That member is no longer connected.")?;
                if !peer_send(&peer.sender, &frame) {
                    return Err("Couldn't reach that member.".into());
                }
            }
        }
        return Ok(());
    }
    if let Some(client) = &inner.client {
        if peer_send(&client.sender, &frame) {
            return Ok(());
        }
        return Err("Lost the relay connection.".into());
    }
    Err("Not connected to a relay.".into())
}

// ---------- file transfer (direct peer-to-peer) ----------
//
// The relay carries only the OFFER (name, size, hash, where to fetch, a
// one-time token); the bytes go straight from sender to receiver on an
// ephemeral one-shot listener. The token is high-entropy, so it derives the
// ChaCha20-Poly1305 keys directly — the stream is encrypted and authenticated
// end-to-end, and SHA-256 confirms the whole file matches the offer.

#[derive(Serialize, Clone)]
pub struct TransferEvent {
    /// "in" (receiving) | "out" (sending)
    pub direction: String,
    pub name: String,
    pub ok: bool,
    /// in+ok: the saved path; out+ok: the receiver's name; !ok: what failed.
    pub detail: String,
}

fn emit_transfer(app: &AppHandle, direction: &str, name: &str, ok: bool, detail: String) {
    let _ = app.emit(
        "relay:transfer",
        TransferEvent { direction: direction.into(), name: name.into(), ok, detail },
    );
}

fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).map_err(|e| format!("Can't read that file: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buf[..n]),
            Err(e) => return Err(format!("Can't read that file: {e}")),
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn is_private_addr(host: &str) -> bool {
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        Ok(std::net::IpAddr::V6(v6)) => v6.is_loopback(),
        // A hostname — assume it resolves publicly.
        Err(_) => false,
    }
}

/// Public IP for offers made from an internet-facing member; fetched once per
/// run (it costs up to 8s of curl) and reused.
fn cached_public_ip() -> Option<String> {
    static CACHE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    CACHE.get_or_init(fetch_public_ip).clone()
}

/// How long a file offer stays claimable before its listener retires.
const OFFER_TTL: Duration = Duration::from_secs(600);

#[tauri::command]
pub async fn relay_offer_file(
    app: AppHandle,
    state: State<'_, RelayManager>,
    to: String,
    path: String,
) -> Result<(), String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("Can't read that file: {e}"))?;
    if !meta.is_file() {
        return Err("Only single files can be sent (zip a folder first).".into());
    }
    let size = meta.len();
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let sha256 = sha256_file(std::path::Path::new(&path))?;

    let listener =
        TcpListener::bind("0.0.0.0:0").map_err(|e| format!("Couldn't open a transfer port: {e}"))?;
    let tport = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let token = format!("{:016x}{:016x}", entropy(), entropy());

    // Who we're sending to (for the toast) and whether this side is
    // internet-facing (host in public mode, or a client that dialed a
    // non-private address). Decided under the lock; the slow public-IP fetch
    // happens after it's released.
    let (to_name, internet_facing) = {
        let inner = state.inner.lock().unwrap();
        let (to_name, facing) = if let Some(host) = &inner.host {
            (
                host.peers.get(&to).map(|p| p.member.name.clone()),
                host.visibility == "public",
            )
        } else if let Some(client) = &inner.client {
            (
                client.members.iter().find(|m| m.id == to).map(|m| m.name.clone()),
                !is_private_addr(client.addr.split(':').next().unwrap_or("")),
            )
        } else {
            return Err("Not connected to a relay.".into());
        };
        (to_name.ok_or("That member is no longer connected.")?, facing)
    };

    // Addresses the receiver tries in order: LAN first (same office = same
    // subnet), then the public address for teammates across the internet.
    let mut addrs: Vec<String> =
        local_ips().into_iter().map(|ip| format!("{ip}:{tport}")).collect();
    if internet_facing {
        if let Some(ip) = cached_public_ip() {
            addrs.push(format!("{ip}:{tport}"));
        }
    }
    if addrs.is_empty() {
        return Err("No reachable address to serve the file from.".into());
    }

    let alive = Arc::new(AtomicBool::new(true));
    {
        let mut inner = state.inner.lock().unwrap();
        inner.transfers.insert(token.clone(), alive.clone());
        let (from, from_name) = sender_context(&inner)?;
        let msg = CommandMsg {
            id: new_id(),
            from,
            from_name,
            to: Some(to.clone()),
            kind: "file-offer".into(),
            payload: serde_json::json!({
                "name": name, "size": size, "sha256": sha256,
                "addrs": addrs, "token": token,
            }),
            ts: now_ms(),
        };
        deliver(&inner, Some(to), Frame::Command(msg))?;
    }

    let inner_arc = state.inner.clone();
    thread::Builder::new()
        .name("relay-send-file".into())
        .spawn(move || {
            serve_file(&app, listener, &path, &name, &token, &alive, &to_name);
            alive.store(false, Ordering::SeqCst);
            inner_arc.lock().unwrap().transfers.remove(&token);
        })
        .map_err(|e| format!("couldn't spawn transfer thread: {e}"))?;
    Ok(())
}

/// One-shot file server: whoever presents the token gets the bytes, once.
/// Survives a dropped attempt so the receiver can retry until the TTL.
fn serve_file(
    app: &AppHandle,
    listener: TcpListener,
    path: &str,
    name: &str,
    token: &str,
    alive: &Arc<AtomicBool>,
    to_name: &str,
) {
    let deadline = Instant::now() + OFFER_TTL;
    loop {
        if !alive.load(Ordering::SeqCst) || Instant::now() > deadline {
            return;
        }
        let (stream, _) = match listener.accept() {
            Ok(pair) => pair,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(300));
                continue;
            }
            Err(_) => {
                thread::sleep(Duration::from_millis(300));
                continue;
            }
        };
        // The accepted socket inherits non-blocking on some platforms; the
        // transfer wants plain blocking IO with timeouts.
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
        // Token-keyed AEAD. The receiver's first frame must decrypt under the
        // token-derived key — only a holder of the offer's token can produce
        // one, so a successful decrypt IS the authentication.
        let Some((mut sender, mut receiver)) = secure::file_channel(&stream, token, true) else {
            let _ = stream.shutdown(Shutdown::Both);
            continue;
        };
        if receiver.recv().is_none() {
            let _ = stream.shutdown(Shutdown::Both);
            continue;
        }
        let Ok(mut file) = std::fs::File::open(path) else {
            emit_transfer(app, "out", name, false, "The file vanished before it was picked up.".into());
            return;
        };
        let mut buf = [0u8; 65536];
        let mut sent_ok = true;
        loop {
            match file.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if !sender.send(&buf[..n]) {
                        sent_ok = false;
                        break;
                    }
                }
                Err(_) => {
                    sent_ok = false;
                    break;
                }
            }
        }
        let _ = stream.shutdown(Shutdown::Both);
        if sent_ok {
            emit_transfer(app, "out", name, true, to_name.to_string());
            return;
        }
        // Receiver dropped mid-pull — keep the offer alive for a retry.
    }
}

/// Accept an offer: dial the sender directly, authenticate with the token,
/// stream to `dest`, verify the hash. Runs in its own thread; the outcome
/// arrives as a relay:transfer event, so the UI is never held hostage by a
/// slow link.
#[tauri::command]
pub async fn relay_accept_file(
    app: AppHandle,
    name: String,
    size: u64,
    sha256: String,
    addrs: Vec<String>,
    token: String,
    dest: String,
) -> Result<(), String> {
    thread::Builder::new()
        .name("relay-receive-file".into())
        .spawn(move || {
            use sha2::{Digest, Sha256};
            let mut stream = None;
            for a in &addrs {
                if let Ok(sa) = a.parse::<std::net::SocketAddr>() {
                    if let Ok(s) = TcpStream::connect_timeout(&sa, Duration::from_secs(4)) {
                        stream = Some(s);
                        break;
                    }
                }
            }
            let Some(stream) = stream else {
                emit_transfer(
                    &app, "in", &name, false,
                    "Couldn't reach the sender directly — a firewall or NAT between you is blocking the peer-to-peer connection.".into(),
                );
                return;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
            let Some((mut sender, mut receiver)) = secure::file_channel(&stream, &token, false) else {
                emit_transfer(&app, "in", &name, false, "Couldn't set up the secure channel.".into());
                return;
            };
            // Authenticate to the sender: only we (holding the token) can send
            // a frame that decrypts under the token-derived key.
            if !sender.send(b"canopy-file") {
                emit_transfer(&app, "in", &name, false, "Handshake with the sender failed.".into());
                return;
            }
            let Ok(mut out) = std::fs::File::create(&dest) else {
                emit_transfer(&app, "in", &name, false, format!("Can't write to {dest}."));
                return;
            };
            let mut hasher = Sha256::new();
            let mut got = 0u64;
            while got < size {
                let Some(chunk) = receiver.recv() else { break };
                hasher.update(&chunk);
                if out.write_all(&chunk).is_err() {
                    drop(out);
                    let _ = std::fs::remove_file(&dest);
                    emit_transfer(&app, "in", &name, false, format!("Writing {dest} failed — disk full?"));
                    return;
                }
                got += chunk.len() as u64;
            }
            drop(out);
            if got < size {
                let _ = std::fs::remove_file(&dest);
                emit_transfer(&app, "in", &name, false, "The connection dropped before the whole file arrived.".into());
                return;
            }
            let got = format!("{:x}", hasher.finalize());
            if got != sha256.to_lowercase() {
                let _ = std::fs::remove_file(&dest);
                emit_transfer(&app, "in", &name, false, "Integrity check failed — the received bytes don't match the offer. Nothing was kept.".into());
                return;
            }
            emit_transfer(&app, "in", &name, true, dest.clone());
        })
        .map_err(|e| format!("couldn't spawn transfer thread: {e}"))?;
    Ok(())
}
