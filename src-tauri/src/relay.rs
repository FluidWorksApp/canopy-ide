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
use tauri::{AppHandle, Emitter, Manager, State};

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
/// seeded per call. Display ids only — not cryptography.
fn entropy() -> u64 {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut h = RandomState::new().build_hasher();
    h.write_u64(now_ms());
    h.finish()
}

/// Randomness from the OS CSPRNG, for values an attacker must not be able to
/// predict. SPAKE2 makes a short join code safe against OFFLINE attack — an
/// eavesdropper cannot brute-force the code from a captured handshake — but it
/// assumes the code itself is unguessable. Derived from `entropy()` it was
/// not: SipHash of a per-thread seed and a millisecond timestamp, correlated
/// across successive calls, and explicitly disclaimed as non-cryptographic by
/// its own doc comment. Predict the code and the whole PAKE is bypassed
/// legitimately — you just run the protocol with the right password.
fn secure_u64() -> u64 {
    let mut b = [0u8; 8];
    getrandom::getrandom(&mut b).expect("OS randomness unavailable");
    u64::from_le_bytes(b)
}

fn new_code() -> String {
    // The modulo bias here is ~2^-40 — immaterial against a 7-digit space.
    format!("{:07}", secure_u64() % 10_000_000)
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
    /// Ed25519 identity public key (hex) this member proved possession of on
    /// its direct link. None for members only relayed to us by the host, whose
    /// keys we can't independently verify.
    #[serde(default)]
    pub key: Option<String>,
    /// Trust-on-first-use verdict for `key`, computed by the observer against
    /// its own pin store: "self" | "new" | "known" | "changed" | "relayed".
    #[serde(default)]
    pub trust: String,
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

/// One text operation in the collaborative-editing stream. Offsets are UTF-16
/// code units so they land in Monaco's coordinate space without a conversion
/// layer on either side.
#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum CollabOp {
    Retain { n: u32 },
    Insert { s: String },
    Delete { n: u32 },
}

/// What a collab frame is saying about a document. Typed rather than a free
/// `Value` (the way `CommandMsg::payload` is) so a malformed body is refused at
/// the relay instead of being fanned out to every peer for the frontend to
/// puzzle over — the collab path runs at one frame per keystroke, so it is the
/// last place to be forgiving.
#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CollabBody {
    /// Owner -> peer: "I am sharing a file live." `name` is a BASENAME FOR
    /// DISPLAY ONLY and is re-sanitised on the receiving side. A path never
    /// crosses this wire — see docs/collab-editing.md §5, invariant COLLAB-1.
    Offer { name: String, lang: Option<String> },
    /// Peer -> owner: "let me in." Refused unless the sender was offered it.
    Open,
    /// Owner -> peer: the whole document at `rev`, on open or on resync.
    Snapshot { rev: u64, text: String },
    /// The edit stream. Peer -> owner: `rev` is the base the ops were composed
    /// against. Owner -> everyone: `rev` is the new authoritative revision and
    /// `author` is whose op it is, so the author recognises its own ack.
    Ops {
        rev: u64,
        ops: Vec<CollabOp>,
        #[serde(default)]
        author: String,
        /// Owner's document hash at `rev`, sent every few revisions. A peer
        /// that computes a different one has diverged and asks to resync,
        /// which is what keeps a transform bug from becoming silent corruption.
        #[serde(default)]
        hash: Option<String>,
    },
    /// Peer -> owner: "I disagree with you about the document, send it again."
    Resync { reason: String },
    /// Owner unshares, or a peer leaves the document.
    Close { reason: String },
    /// Presence. Unsequenced and droppable; `rev` lets a stale one be
    /// transformed into place rather than drawn in the wrong spot.
    Cursor { anchor: u32, head: u32, rev: u64 },
    /// Owner -> peer: "I am sharing my whole project live." `name` is a display
    /// label; the project's files are requested and opened one at a time.
    ProjectOffer { name: String },
    /// Owner -> peer: the project's file list, as paths RELATIVE to the shared
    /// root — never an absolute path (COLLAB-1). Sent when the peer accepts.
    ProjectTree { paths: Vec<String> },
    /// Peer -> owner: "open this file for me." `path` is one of the relative
    /// paths from the tree; the owner resolves it inside the shared root and
    /// shares it as an ordinary live document.
    ProjectOpen { path: String },
}

#[derive(Serialize, Deserialize, Clone)]
pub struct CollabMsg {
    pub id: String,
    pub from: String,
    pub from_name: String,
    pub to: Option<String>,
    /// The document. Opaque 128-bit CSPRNG token minted by the owner; the only
    /// way any peer can name a document, and it resolves to a path in exactly
    /// one process (the owner's) and only via an explicit local share.
    pub doc: String,
    pub body: CollabBody,
    pub ts: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum Frame {
    /// `code` is legacy — the PAKE handshake already proved it, so the host
    /// ignores it. Kept so a join is a self-describing frame.
    /// First frame after the handshake, both directions: proves possession of
    /// a long-term identity key, bound to this session so it can't be replayed.
    Identity { pubkey: String, sig: String },
    Join { code: String, name: String },
    Welcome { self_id: String, members: Vec<Member> },
    Presence { members: Vec<Member> },
    Chat(ChatMsg),
    Command(CommandMsg),
    /// Live collaborative editing. Deliberately its own variant rather than a
    /// `Command` kind: commands land in the Team panel's inbox and raise a
    /// notification, which is right for "review this PR" and catastrophic for
    /// a frame per keystroke.
    Collab(CollabMsg),
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
pub(crate) mod secure {
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

    /// One 32-byte key from `key` for the labelled purpose/direction, with an
    /// optional salt. A per-session salt is what makes counter-from-0 nonces
    /// safe when the input `key` is otherwise static (the file token) — without
    /// it, two sessions under the same token would share a keystream.
    pub fn derive(key: &[u8], salt: Option<&[u8]>, info: &[u8]) -> [u8; 32] {
        let hk = Hkdf::<Sha256>::new(salt, key);
        let mut okm = [0u8; 32];
        hk.expand(info, &mut okm).expect("hkdf expand into 32 bytes never fails");
        okm
    }

    /// 16 fresh bytes from the OS CSPRNG, used as a per-transfer HKDF salt.
    fn random_salt() -> [u8; 16] {
        let mut salt = [0u8; 16];
        // getrandom only fails on platforms without an RNG source, which none
        // of Canopy's targets are; treat an error as fatal for this transfer
        // rather than risk a predictable/duplicate salt.
        getrandom::getrandom(&mut salt).expect("OS randomness unavailable");
        salt
    }

    fn write_prefixed(w: &mut dyn Write, data: &[u8]) -> std::io::Result<()> {
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

    /// A duplex byte pipe the secure layer runs over. Boxed rather than generic
    /// so `Sender`/`Receiver` stay concrete types and don't ripple type
    /// parameters through `Host`/`Client`/`Peer`. TCP supplies two cloned
    /// halves of one socket; the UDP transport supplies its own reliable-stream
    /// halves. The crypto neither knows nor cares which — the whole point of
    /// this split (see punch.rs) is that the pipe under it changed from a TCP
    /// listener CGNAT blocks to a hole-punched UDP path it doesn't.
    pub type BoxWrite = Box<dyn Write + Send>;
    pub type BoxRead = Box<dyn Read + Send>;

    /// The encrypting half of a channel. NOT internally synchronised — wrap it
    /// in a Mutex; the counter nonce demands serialised sends, and the counter
    /// only stays in step because the pipe below is reliable and ordered.
    pub struct Sender {
        cipher: ChaCha20Poly1305,
        counter: u64,
        writer: BoxWrite,
    }

    impl Sender {
        pub fn send(&mut self, plaintext: &[u8]) -> bool {
            let nonce = nonce_bytes(self.counter);
            let Ok(ct) = self.cipher.encrypt(Nonce::from_slice(&nonce), plaintext) else {
                return false;
            };
            self.counter = self.counter.wrapping_add(1);
            write_prefixed(&mut self.writer, &ct).is_ok()
        }
    }

    /// The decrypting half. A failed decrypt (wrong key, tampering) or a short
    /// read yields None — the caller treats that as end-of-connection.
    pub struct Receiver {
        cipher: ChaCha20Poly1305,
        counter: u64,
        reader: BufReader<BoxRead>,
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

    /// Build the two halves from an ALREADY-wrapped reader (the handshake reads
    /// through the same BufReader it hands on, so buffered bytes aren't lost).
    fn channel(
        writer: BoxWrite,
        reader: BufReader<BoxRead>,
        send_key: [u8; 32],
        recv_key: [u8; 32],
    ) -> (Sender, Receiver) {
        (
            Sender {
                cipher: ChaCha20Poly1305::new(Key::from_slice(&send_key)),
                counter: 0,
                writer,
            },
            Receiver {
                cipher: ChaCha20Poly1305::new(Key::from_slice(&recv_key)),
                counter: 0,
                reader,
            },
        )
    }

    /// SPAKE2 over the raw stream, keyed by `code`. The joining client is the
    /// initiator and writes first; the host responds. Both derive the same
    /// session key and split it per-direction. Returns None only if the socket
    /// dies mid-handshake — a WRONG code still returns channels here (SPAKE2
    /// always completes), but with a mismatched key, so the first real frame
    /// fails to decrypt. That is where a bad code is rejected.
    pub fn handshake(
        mut writer: BoxWrite,
        reader: BoxRead,
        code: &str,
        initiator: bool,
    ) -> Option<(Sender, Receiver, [u8; 32])> {
        // The SAME BufReader is used for the handshake read and then handed to
        // the Receiver — a fresh one could strand bytes the first read buffered.
        let mut br = BufReader::new(reader);
        let (state, mine) = Spake2::<Ed25519Group>::start_symmetric(
            &Password::new(code.as_bytes()),
            &Identity::new(b"canopy-relay"),
        );
        let theirs = if initiator {
            write_prefixed(&mut writer, &mine).ok()?;
            read_prefixed(&mut br).ok()?
        } else {
            let t = read_prefixed(&mut br).ok()?;
            write_prefixed(&mut writer, &mine).ok()?;
            t
        };
        let key = state.finish(&theirs).ok()?;
        // The SPAKE2 key is already fresh per connection (OS-random ephemeral
        // scalars), so no extra salt is needed here.
        let i2r = derive(&key, None, b"canopy-relay initiator->responder");
        let r2i = derive(&key, None, b"canopy-relay responder->initiator");
        // A per-connection binding for the identity signatures, unforgeable
        // without the code (it comes from the SPAKE2 key) and unique per
        // session (so an identity frame can't be replayed).
        let binding = derive(&key, None, b"canopy-relay identity-binding");
        let (send_key, recv_key) = if initiator { (i2r, r2i) } else { (r2i, i2r) };
        let (sender, receiver) = channel(writer, br, send_key, recv_key);
        Some((sender, receiver, binding))
    }

    /// Transfer channel keyed by the offer's 128-bit token. The token is static
    /// for the offer's lifetime and `serve_file` re-serves the same file on
    /// retries, so keying straight off the token would restart the nonce
    /// counter at 0 under an identical key every attempt — a two-time pad. A
    /// fresh random salt per connection, exchanged in the clear before any
    /// ciphertext (the salt is not secret; the token is), makes each session's
    /// keys unique so counter-from-0 nonces are safe. Bulk flows
    /// sender->receiver; the receiver's first frame authenticates it (only a
    /// holder of the token can produce a decryptable one).
    pub fn file_channel(
        mut writer: BoxWrite,
        reader: BoxRead,
        token: &str,
        is_sender: bool,
    ) -> Option<(Sender, Receiver)> {
        let mut br = BufReader::new(reader);
        // The sender picks the salt and sends it first; the receiver reads it.
        let salt = if is_sender {
            let salt = random_salt();
            write_prefixed(&mut writer, &salt).ok()?;
            salt
        } else {
            let got = read_prefixed(&mut br).ok()?;
            if got.len() != 16 {
                return None;
            }
            let mut salt = [0u8; 16];
            salt.copy_from_slice(&got);
            salt
        };
        let s2r = derive(token.as_bytes(), Some(&salt), b"canopy-file sender->receiver");
        let r2s = derive(token.as_bytes(), Some(&salt), b"canopy-file receiver->sender");
        let (send_key, recv_key) = if is_sender { (s2r, r2s) } else { (r2s, s2r) };
        Some(channel(writer, br, send_key, recv_key))
    }

    /// Break a channel's underlying socket so a blocked `recv` returns.
    pub fn shutdown(stream: &TcpStream) {
        let _ = stream.shutdown(Shutdown::Both);
    }

    /// TCP convenience: clone the socket into the two boxed halves the generic
    /// `handshake` now takes. Keeps the LAN callers a one-word change while the
    /// UDP transport builds its own halves and calls `handshake` directly.
    pub fn handshake_tcp(
        stream: &TcpStream,
        code: &str,
        initiator: bool,
    ) -> Option<(Sender, Receiver, [u8; 32])> {
        let w: BoxWrite = Box::new(stream.try_clone().ok()?);
        let r: BoxRead = Box::new(stream.try_clone().ok()?);
        handshake(w, r, code, initiator)
    }

    pub fn file_channel_tcp(stream: &TcpStream, token: &str, is_sender: bool) -> Option<(Sender, Receiver)> {
        let w: BoxWrite = Box::new(stream.try_clone().ok()?);
        let r: BoxRead = Box::new(stream.try_clone().ok()?);
        file_channel(w, r, token, is_sender)
    }
}

/// Trust-on-first-use identity. SPAKE2 already proves both ends hold the join
/// code, but the code is reused and shared, so it can't tell one holder from
/// another across sessions. Each Canopy has a long-term Ed25519 key it signs
/// the session with; the counterpart pins (name -> key) on first sight and is
/// warned if that name later shows up with a different key — catching a reused
/// code being used to impersonate a teammate.
mod identity {
    use super::secure;
    use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};

    fn canopy_dir() -> Option<PathBuf> {
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
        Some(PathBuf::from(home).join(".canopy"))
    }

    pub struct Local {
        signing: SigningKey,
        pub pubkey_hex: String,
    }

    /// This machine's identity key, generated once and persisted. The private
    /// seed lives in ~/.canopy/relay-identity — same trust level as the rest
    /// of that directory (projects, hook digests).
    pub fn local() -> &'static Local {
        static LOCAL: OnceLock<Local> = OnceLock::new();
        LOCAL.get_or_init(|| {
            let path = canopy_dir().map(|d| d.join("relay-identity"));
            // Load an existing 32-byte hex seed, else make one.
            let seed = path
                .as_ref()
                .and_then(|p| std::fs::read_to_string(p).ok())
                .and_then(|s| hex::decode(s.trim()).ok())
                .filter(|b| b.len() == 32)
                .and_then(|b| <[u8; 32]>::try_from(b).ok())
                .unwrap_or_else(|| {
                    let mut seed = [0u8; 32];
                    getrandom::getrandom(&mut seed).expect("OS randomness unavailable");
                    if let Some(p) = &path {
                        if let Some(dir) = p.parent() {
                            let _ = std::fs::create_dir_all(dir);
                        }
                        let _ = std::fs::write(p, hex::encode(seed));
                    }
                    seed
                });
            let signing = SigningKey::from_bytes(&seed);
            let pubkey_hex = hex::encode(signing.verifying_key().to_bytes());
            Local { signing, pubkey_hex }
        })
    }

    /// The message both sides sign: the session binding (derived from the
    /// SPAKE2 key, so unique per connection and unforgeable without the code)
    /// domain-separated by role, so an identity frame can't be reflected.
    fn signed_msg(binding: &[u8; 32], role: &str) -> Vec<u8> {
        let mut m = b"canopy-identity:".to_vec();
        m.extend_from_slice(role.as_bytes());
        m.push(b':');
        m.extend_from_slice(binding);
        m
    }

    /// Exchange and verify identity frames over the freshly-established channel.
    /// Returns the peer's verified public key (hex), or None if the peer failed
    /// to prove possession. `initiator` (the client) sends first.
    pub fn exchange(
        sender: &mut secure::Sender,
        receiver: &mut secure::Receiver,
        binding: &[u8; 32],
        initiator: bool,
    ) -> Option<String> {
        let me = local();
        let (my_role, peer_role) = if initiator { ("initiator", "responder") } else { ("responder", "initiator") };
        let sig = me.signing.sign(&signed_msg(binding, my_role));
        let mine = serde_json::to_vec(&super::Frame::Identity {
            pubkey: me.pubkey_hex.clone(),
            sig: hex::encode(sig.to_bytes()),
        })
        .ok()?;

        // Order mirrors the Join/Welcome sequencing: initiator speaks first.
        let peer = if initiator {
            if !sender.send(&mine) {
                return None;
            }
            receiver.recv()?
        } else {
            let peer = receiver.recv()?;
            if !sender.send(&mine) {
                return None;
            }
            peer
        };
        let (pubkey, sig) = match serde_json::from_slice::<super::Frame>(&peer).ok()? {
            super::Frame::Identity { pubkey, sig } => (pubkey, sig),
            _ => return None,
        };
        // Verify the peer actually holds the private key for the pubkey it
        // presented, over THIS session's binding.
        let pk_bytes: [u8; 32] = hex::decode(&pubkey).ok()?.try_into().ok()?;
        let sig_bytes: [u8; 64] = hex::decode(&sig).ok()?.try_into().ok()?;
        let vk = VerifyingKey::from_bytes(&pk_bytes).ok()?;
        vk.verify(&signed_msg(binding, peer_role), &Signature::from_bytes(&sig_bytes))
            .ok()?;
        Some(pubkey)
    }

    fn pin_path() -> Option<PathBuf> {
        canopy_dir().map(|d| d.join("relay-known-peers.json"))
    }

    fn pin_guard() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    /// TOFU verdict for a (name, key) pair against the on-disk pin store, and
    /// pin it if new. First-seen key for a name wins and is NOT overwritten on
    /// a mismatch, so the "changed" warning persists until the user resolves it.
    pub fn trust(name: &str, key_hex: &str) -> String {
        let _g = pin_guard().lock().unwrap();
        let Some(path) = pin_path() else { return "new".into() };
        let mut map: std::collections::HashMap<String, String> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let verdict = match map.get(name) {
            Some(seen) if seen == key_hex => "known",
            Some(_) => "changed",
            None => {
                map.insert(name.to_string(), key_hex.to_string());
                if let Some(dir) = path.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                if let Ok(json) = serde_json::to_string_pretty(&map) {
                    // Write via a temp file so a crash mid-write can't corrupt
                    // the pin store into "everyone is suddenly unknown".
                    let tmp = path.with_extension("json.tmp");
                    if std::fs::File::create(&tmp)
                        .and_then(|mut f| f.write_all(json.as_bytes()).and_then(|_| f.flush()))
                        .is_ok()
                    {
                        let _ = std::fs::rename(&tmp, &path);
                    }
                }
                "new"
            }
        };
        verdict.to_string()
    }

    /// Re-affirm a trust verdict without mutating the store — used to render a
    /// peer's current standing on demand. Kept minimal; `trust` does the write.
    #[allow(dead_code)]
    pub fn read_verdict(name: &str, key_hex: &str) -> String {
        let _g = pin_guard().lock().unwrap();
        let Some(path) = pin_path() else { return "new".into() };
        let map: std::collections::HashMap<String, String> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        match map.get(name) {
            Some(seen) if seen == key_hex => "known".into(),
            Some(_) => "changed".into(),
            None => "new".into(),
        }
    }
}

// ---------- state ----------

/// How to forcibly break a peer's connection so a thread blocked in `recv`
/// wakes up. TCP shuts the socket down; QUIC closes the connection. Kept
/// lock-free (no `secure::Sender` mutex) so closing a dead peer can't block on
/// a send still in flight.
enum Closer {
    Tcp(TcpStream),
    /// WebSocket peer (the internet path): aborting the bridge pump drops both
    /// channel ends, which EOFs the sync reader and closes the underlying socket.
    Ws(crate::wsbridge::WsCloser),
}

impl Closer {
    fn close(&self) {
        match self {
            Closer::Tcp(s) => {
                let _ = s.shutdown(Shutdown::Both);
            }
            Closer::Ws(w) => w.close(),
        }
    }
}

struct Peer {
    member: Member,
    /// Encrypted writer to this peer. Every fan-out (chat, presence, ping)
    /// locks it — the AEAD counter nonce forbids concurrent sends.
    sender: Arc<Mutex<secure::Sender>>,
    /// Teardown handle, transport-agnostic — see `Closer`.
    shutdown: Closer,
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
    /// The host's identity key we verified on our direct link, and our own
    /// TOFU verdict for it — the client only directly authenticates the host,
    /// so other members' keys are shown as relayed.
    host_key: String,
    host_trust: String,
    /// Encrypted writer to the host (which relays onward).
    sender: Arc<Mutex<secure::Sender>>,
    shutdown: Closer,
    alive: Arc<AtomicBool>,
}

#[derive(Default)]
struct Inner {
    host: Option<Host>,
    client: Option<Client>,
    /// Live outgoing file offers by token — flipping the flag retires the
    /// one-shot listener serving that file.
    transfers: HashMap<String, Arc<AtomicBool>>,
    /// Sender-side offer context by token, kept so a `file-pull` (the receiver
    /// couldn't reach us directly) can stream the same file over the relay.
    offers_out: HashMap<String, OfferOut>,
    /// Receiver-side reassembly pipes by token: the relay reader thread decodes
    /// each `file-data` frame and pushes the plaintext to the transfer thread.
    tunnel_pipes: HashMap<String, TunnelPipe>,
}

/// What a sender needs to serve a file over the relay when the direct path is
/// blocked. Mirrors the arguments the direct `serve_file` already holds.
struct OfferOut {
    path: String,
    name: String,
    size: u64,
    /// The member the offer was made to — the only peer we'll stream to, so a
    /// sniffed `file-pull` from anyone else can't redirect the bytes.
    to_id: String,
    /// UI correlation id for this send (shared with the direct path).
    id: String,
    /// Shared with the direct one-shot server: flipping it retires both.
    alive: Arc<AtomicBool>,
    /// A `file-pull` only starts one stream; a duplicate is ignored.
    started: bool,
}

/// One plaintext chunk (or a decode/decrypt failure) on its way from the relay
/// reader thread to the transfer thread draining a tunnelled receive.
enum TunnelEvent {
    Data(Vec<u8>),
    Fail,
}

/// Receiver-side reassembly state for one tunnelled transfer. `next_seq` and
/// `key` are only ever touched from the single reader thread that owns this
/// connection, under the `Inner` lock, so no per-pipe lock is needed.
struct TunnelPipe {
    tx: std::sync::mpsc::SyncSender<TunnelEvent>,
    /// Derived once `file-begin` supplies the per-transfer salt.
    key: Option<[u8; 32]>,
    /// Next chunk index expected — the AEAD nonce and an ordering check.
    next_seq: u64,
    /// The sender we asked; frames claiming this token from anyone else are dropped.
    from_id: Option<String>,
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
        key: Some(identity::local().pubkey_hex.clone()),
        trust: "self".into(),
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
        // Re-cast trust from OUR perspective: we directly verified only the
        // host, so the host row carries our own TOFU verdict, our own row is
        // "self", and everyone else is "relayed" (asserted by the host, not
        // verified by us).
        let members = client
            .members
            .iter()
            .map(|m| {
                let mut m = m.clone();
                if m.is_host {
                    m.key = Some(client.host_key.clone());
                    m.trust = client.host_trust.clone();
                } else if m.id == client.self_id {
                    m.trust = "self".into();
                } else {
                    m.trust = "relayed".into();
                }
                m
            })
            .collect();
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
            members,
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

/// Stop serving any in-flight file offers. These outlived both stop_host and
/// stop_client — only app exit retired them — so "Stop hosting" left listeners
/// on open ports still handing bytes to anyone holding the token.
fn retire_transfers(inner: &mut Inner) {
    for alive in inner.transfers.values() {
        alive.store(false, Ordering::SeqCst);
    }
    inner.transfers.clear();
    inner.offers_out.clear();
    // Dropping each pipe closes its channel, so any in-flight tunnelled receive
    // wakes, finds the file short, and fails cleanly instead of hanging.
    inner.tunnel_pipes.clear();
}

fn stop_host(inner: &mut Inner) {
    retire_transfers(inner);
    if let Some(host) = inner.host.take() {
        host.alive.store(false, Ordering::SeqCst);
        for peer in host.peers.values() {
            let _ = peer.shutdown.close();
        }
    }
}

fn stop_client(inner: &mut Inner) {
    retire_transfers(inner);
    if let Some(client) = inner.client.take() {
        client.alive.store(false, Ordering::SeqCst);
        let _ = client.shutdown.close();
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
    let alive = Arc::new(AtomicBool::new(true));
    let name = if name.trim().is_empty() { "host".to_string() } else { name.trim().to_string() };
    let visibility = match visibility.as_deref() {
        Some("public") => "public".to_string(),
        _ => "local".to_string(),
    };

    // "Public" means over the internet, which in practice means carrier NAT,
    // which a TCP listener cannot traverse (an inbound SYN to an unopened port
    // is dropped — every internet join timed out this way). So public hosting
    // takes the UDP + STUN + hole-punch + QUIC path; local network stays TCP,
    // untouched, since a LAN has no wall in the way.
    if visibility == "public" {
        return host_public(app, inner_arc, name, alive);
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
    let public_ip = None;
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
                                let _ = peer.shutdown.close();
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

/// Host over the internet. Unlike the LAN path, this opens NO listener of its
/// own: internet joiners arrive over the shared axum server's `/team/ws` route,
/// which the active tunnel forwards. So hosting here just registers us as the
/// host and lets that route admit peers (the old UDP + STUN + hole-punch + QUIC
/// path is retired). The shareable address is the tunnel URL — the front-end
/// combines it with the join code — so nothing here needs to discover or hold
/// open a public address, which also removes the NAT-idle staleness the punch
/// path suffered.
///
/// It does require the shared server + tunnel to be running (the unified
/// "internet sharing" switch starts them); until they are, the `/team/ws` route
/// simply has nothing to forward. A sweep thread pings peers to reap ones that
/// vanished — the job the TCP accept loop folds in inline.
fn host_public(
    app: AppHandle,
    inner_arc: Arc<Mutex<Inner>>,
    name: String,
    alive: Arc<AtomicBool>,
) -> Result<RelayStatus, String> {
    let host = Host {
        code: new_code(),
        // Internet joiners use the tunnel URL, not a port; DEFAULT_PORT is a
        // nominal placeholder the public UI doesn't surface.
        port: DEFAULT_PORT,
        self_id: new_id(),
        name,
        visibility: "public".to_string(),
        public_ip: None,
        peers: HashMap::new(),
        alive: alive.clone(),
    };
    let status = {
        let mut inner = inner_arc.lock().unwrap();
        inner.host = Some(host);
        status_of(&inner)
    };
    spawn_ping_sweep(inner_arc.clone(), alive);
    emit_state(&app, &inner_arc.lock().unwrap());
    Ok(status)
}

/// Ping every peer on an interval; a ping that can't be written is a peer that's
/// gone, so close it (its reader thread then removes it). Runs until `alive`
/// clears. Used by the internet host, which — unlike the TCP accept loop — has
/// no accept poll to fold the sweep into.
fn spawn_ping_sweep(inner: Arc<Mutex<Inner>>, alive: Arc<AtomicBool>) {
    let _ = thread::Builder::new()
        .name("relay-ping-sweep".into())
        .spawn(move || {
            while alive.load(Ordering::SeqCst) {
                thread::sleep(PING_EVERY);
                if !alive.load(Ordering::SeqCst) {
                    return;
                }
                let guard = inner.lock().unwrap();
                if let Some(host) = &guard.host {
                    for peer in host.peers.values() {
                        if !peer_send(&peer.sender, &Frame::Ping) {
                            let _ = peer.shutdown.close();
                        }
                    }
                }
            }
        });
}

/// Whether we're currently hosting a team relay (host set and not stopped) —
/// the gate the shared axum server checks before upgrading a `/team/ws` request.
pub fn is_hosting(app: &AppHandle) -> bool {
    let state = app.state::<RelayManager>();
    let guard = state.inner.lock().unwrap();
    guard
        .host
        .as_ref()
        .map(|h| h.alive.load(Ordering::SeqCst))
        .unwrap_or(false)
}

/// Host-side ingress for a team peer arriving over the shared axum server's
/// `/team/ws` route — the internet path, where the tunnel forwards here instead
/// of a UDP hole-punch. The WebSocket-vs-TCP-vs-QUIC choice is the only thing
/// that differs: bridge the socket to the sync stream halves, then run the same
/// code-keyed SPAKE2 handshake and `serve_peer` loop on a dedicated thread
/// (like the TCP/QUIC accepts). `server_halves` spawns the async pump, so this
/// must be awaited on the runtime; it returns as soon as the peer is handed off.
pub async fn accept_ws_peer(app: AppHandle, ws: axum::extract::ws::WebSocket) {
    // Snapshot the code + liveness current at connect time, so New Code stops
    // admitting new joiners just as the TCP/QUIC paths do.
    let (code, alive, inner) = {
        let state = app.state::<RelayManager>();
        let guard = state.inner.lock().unwrap();
        match guard.host.as_ref() {
            Some(h) if h.alive.load(Ordering::SeqCst) => {
                (h.code.clone(), h.alive.clone(), state.inner.clone())
            }
            // Not hosting (or stopped): drop the socket, nothing to serve.
            _ => return,
        }
    };
    let (writer, reader, closer) = crate::wsbridge::server_halves(ws);
    // The handshake and serve_peer loop are blocking and long-lived; give each
    // peer its own thread, matching host_conn / host_conn_quic.
    let _ = thread::Builder::new().name("relay-peer-ws".into()).spawn(move || {
        match secure::handshake(writer, reader, &code, false) {
            Some((sender, receiver, binding)) => {
                serve_peer(app, inner, sender, receiver, binding, alive, Closer::Ws(closer), || {});
            }
            None => closer.close(),
        }
    });
}

/// One joined connection, host side: secure handshake, authenticate, register,
/// then relay each frame until the peer hangs up.
fn host_conn(app: AppHandle, inner: Arc<Mutex<Inner>>, stream: TcpStream, alive: Arc<AtomicBool>) {
    // The listener is non-blocking so the accept loop can poll `alive`, and on
    // BSD-derived platforms — macOS included — accept() hands back a socket
    // that INHERITED that flag. Linux does not, which is why this only ever
    // broke on a Mac.
    //
    // It has to be cleared before the timeouts below, because a timeout is
    // silently ignored on a non-blocking socket: the first handshake read
    // returns WouldBlock immediately, recv() maps that to None via `.ok()?`,
    // and the host reads "the peer hung up" and drops a connection that had
    // only just arrived. Every join on macOS failed this way, local and
    // public alike, and the swallowed error left nothing to diagnose it by.
    // The file-transfer accept path already does this; this one was missed.
    let _ = stream.set_nonblocking(false);
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
    let Some((sender, receiver, binding)) = secure::handshake_tcp(&stream, &code, false) else {
        secure::shutdown(&stream);
        return;
    };
    let Ok(dup) = stream.try_clone() else {
        secure::shutdown(&stream);
        return;
    };
    // TCP reads must block once the peer has joined: the join arrives promptly
    // under the timeout set above, but conversation may then pause for minutes.
    // (QUIC blocks natively, so its caller passes a no-op.)
    let block = stream.try_clone().ok();
    serve_peer(app, inner, sender, receiver, binding, alive, Closer::Tcp(dup), move || {
        if let Some(s) = block {
            let _ = s.set_read_timeout(None);
        }
    });
}

/// The transport-agnostic half of hosting one peer: identity exchange, register
/// under the lock (Welcome then Presence), then relay each frame until the peer
/// leaves. Shared by the TCP accept loop (`host_conn`) and the QUIC accept loop
/// — each hands over an already-established secure channel plus a `Closer` to
/// break it, and an `on_joined` hook to flip the transport to blocking reads.
#[allow(clippy::too_many_arguments)]
fn serve_peer(
    app: AppHandle,
    inner: Arc<Mutex<Inner>>,
    mut sender: secure::Sender,
    mut receiver: secure::Receiver,
    binding: [u8; 32],
    alive: Arc<AtomicBool>,
    closer: Closer,
    on_joined: impl FnOnce(),
) {
    // Identity exchange (peer proves possession of its long-term key, bound to
    // this session) then the Join frame. A wrong code produced a different
    // session key, so both fail to decrypt — that is how a bad code is now
    // rejected. Tarpit that case: two seconds per wrong guess makes
    // brute-forcing 10M codes a non-starter (a public relay gets probed) while
    // a mistyped code barely notices.
    let Some(peer_key) = identity::exchange(&mut sender, &mut receiver, &binding, false) else {
        thread::sleep(Duration::from_secs(2));
        closer.close();
        return;
    };
    let name = match receiver.recv().and_then(|b| serde_json::from_slice::<Frame>(&b).ok()) {
        Some(Frame::Join { name, .. }) => name,
        _ => {
            closer.close();
            return;
        }
    };
    let sender = Arc::new(Mutex::new(sender));

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
        // TOFU verdict for this (name, key) against our pin store.
        let trust = identity::trust(&name, &peer_key);
        host.peers.insert(
            id.clone(),
            Peer {
                member: Member {
                    id: id.clone(),
                    name: name.clone(),
                    joined_ms: now_ms(),
                    is_host: false,
                    key: Some(peer_key.clone()),
                    trust,
                },
                sender: sender.clone(),
                shutdown: closer,
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
    on_joined();
    loop {
        let Some(bytes) = receiver.recv() else { break };
        let Ok(frame) = serde_json::from_slice::<Frame>(&bytes) else { continue };
        // Decide everything that needs the lock, then drop it before writing a
        // single byte to a socket.
        let plan: Option<(Vec<Arc<Mutex<secure::Sender>>>, bool, Frame, &str)> = {
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
                    let (targets, local) = route_targets(host, &my_id, &msg.to);
                    Some((targets, local, Frame::Chat(msg), "relay:chat"))
                }
                Frame::Command(mut msg) => {
                    msg.from = my_id.clone();
                    msg.from_name = my_name.clone();
                    msg.ts = now_ms();
                    if msg.id.is_empty() {
                        msg.id = new_id();
                    }
                    let (targets, local) = route_targets(host, &my_id, &msg.to);
                    Some((targets, local, Frame::Command(msg), "relay:command"))
                }
                Frame::Collab(mut msg) => {
                    msg.from = my_id.clone();
                    msg.from_name = my_name.clone();
                    msg.ts = now_ms();
                    if msg.id.is_empty() {
                        msg.id = new_id();
                    }
                    let (targets, local) = route_targets(host, &my_id, &msg.to);
                    Some((targets, local, Frame::Collab(msg), "relay:collab"))
                }
                Frame::Ping => host
                    .peers
                    .get(&my_id)
                    .map(|p| (vec![p.sender.clone()], false, Frame::Pong, "")),
                _ => None,
            }
        };
        if let Some((targets, emit_local, frame, event)) = plan {
            deliver_frame(&app, &inner, &targets, &frame, event, emit_local);
        }
    }
    remove_peer(&app, &inner, &my_id);
}

fn remove_peer(app: &AppHandle, inner: &Arc<Mutex<Inner>>, id: &str) {
    let mut guard = inner.lock().unwrap();
    let Some(host) = guard.host.as_mut() else { return };
    if let Some(peer) = host.peers.remove(id) {
        let _ = peer.shutdown.close();
        broadcast_presence(host);
        emit_state(app, &guard);
    }
}

/// Host-side fan-out, phase 1: work out who a frame goes to.
///
/// Split from the sending half deliberately. This is pure and runs under the
/// global lock; `deliver` does the blocking socket writes and must NOT. Fusing
/// them meant one unresponsive peer held the whole relay's mutex for up to the
/// 5s write timeout — per peer — and every unrelated operation (status polls,
/// other members' messages, joins, stopping the relay) queued behind it.
///
/// Returns the senders to write to, and whether the frame also belongs in our
/// own UI.
fn route_targets(
    host: &Host,
    sender: &str,
    to: &Option<String>,
) -> (Vec<Arc<Mutex<secure::Sender>>>, bool) {
    match to {
        None => (
            host.peers
                .iter()
                .filter(|(id, _)| id.as_str() != sender)
                .map(|(_, p)| p.sender.clone())
                .collect(),
            true,
        ),
        Some(target) if *target == host.self_id => (Vec::new(), true),
        Some(target) => (
            host.peers.get(target).map(|p| p.sender.clone()).into_iter().collect(),
            false,
        ),
    }
}

/// Host-side fan-out, phase 2: the blocking part. Call with NO lock held.
fn deliver_frame(
    app: &AppHandle,
    inner: &Arc<Mutex<Inner>>,
    targets: &[Arc<Mutex<secure::Sender>>],
    frame: &Frame,
    event: &str,
    emit_local: bool,
) {
    for sender in targets {
        let _ = peer_send(sender, frame);
    }
    if emit_local {
        match frame {
            Frame::Chat(m) => {
                let _ = app.emit(event, m.clone());
            }
            Frame::Command(m) => {
                // A file-tunnel frame addressed to us (the host is the transfer
                // endpoint) drives the transfer instead of hitting the UI. A
                // client<->client tunnel frame is relayed above with
                // emit_local=false, so the host never assembles it.
                if !handle_file_tunnel(app, inner, m) {
                    let _ = app.emit(event, m.clone());
                }
            }
            Frame::Collab(m) => {
                let _ = app.emit(event, m.clone());
            }
            _ => {}
        }
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
    let addr = addr.trim().to_string();
    let name = if name.trim().is_empty() { "guest".to_string() } else { name.trim().to_string() };

    // Two ways to join, by what the host shared. A URL is the host's tunnel
    // address (an internet session): dial it over a WebSocket to /team/ws — the
    // same ingress the host exposes on its shared server, so the tunnel carries
    // the whole relay. Anything else is a bare host:port on the LAN, reached
    // directly over TCP. (The old public UDP-hole-punch + QUIC path is retired —
    // "internet" now means the tunnel, so a joiner never opens a UDP socket.)
    // Either way the SPAKE2 handshake and the relay logic on top are identical.
    if let Some(url) = team_ws_url(&addr) {
        let (writer, reader, closer) = crate::wsbridge::connect(&url, Duration::from_secs(12))
            .map_err(|e| format!("Couldn't reach the host: {e}"))?;
        let Some((sender, receiver, binding)) = secure::handshake(writer, reader, code.trim(), true) else {
            closer.close();
            return Err("Couldn't establish a secure channel — check the link and code, and that the host is sharing.".into());
        };
        return run_client(app, inner_arc, sender, receiver, binding, Closer::Ws(closer), name, addr, || {});
    }

    // LAN: a bare IP/hostname gets the default relay port appended, then a direct
    // TCP connection — no wall in the way on a local network.
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
    let Some((sender, receiver, binding)) = secure::handshake_tcp(&stream, code.trim(), true) else {
        return Err("Couldn't establish a secure channel — check the address and that the relay is running.".into());
    };
    let closer = Closer::Tcp(stream.try_clone().map_err(|e| e.to_string())?);
    let block = stream.try_clone().ok();
    run_client(app, inner_arc, sender, receiver, binding, closer, name, full, move || {
        if let Some(s) = block {
            let _ = s.set_read_timeout(None);
        }
    })
}

/// The transport-agnostic half of joining a relay: identity exchange, Join,
/// Welcome, register as the client, then read frames until the host hangs up.
/// Shared by the TCP (LAN) and QUIC (internet) join paths; `on_welcome` flips
/// TCP to blocking reads once joined (QUIC blocks natively, so a no-op).
#[allow(clippy::too_many_arguments)]
fn run_client(
    app: AppHandle,
    inner_arc: Arc<Mutex<Inner>>,
    mut sender: secure::Sender,
    mut receiver: secure::Receiver,
    binding: [u8; 32],
    closer: Closer,
    name: String,
    full: String,
    on_welcome: impl FnOnce(),
) -> Result<RelayStatus, String> {
    // Prove our identity and verify the host's, bound to this session. A wrong
    // code yields a mismatched key, so this fails — reported as a refused code.
    let Some(host_key) = identity::exchange(&mut sender, &mut receiver, &binding, true) else {
        closer.close();
        return Err("The relay refused the connection — wrong code, or it isn't reachable.".into());
    };
    let sender = Arc::new(Mutex::new(sender));
    if !peer_send(&sender, &Frame::Join { code: String::new(), name: name.clone() }) {
        closer.close();
        return Err("Couldn't talk to the relay.".into());
    }
    // Welcome is our first encrypted frame back.
    let (self_id, members) = match receiver.recv().and_then(|b| serde_json::from_slice::<Frame>(&b).ok()) {
        Some(Frame::Welcome { self_id, members }) => (self_id, members),
        _ => {
            closer.close();
            return Err("The relay refused the connection — wrong code, or it isn't reachable.".into());
        }
    };
    on_welcome();
    // Pin the host under its advertised name; a changed key for a name we've
    // joined before is the warning TOFU exists to raise.
    let host_name = members
        .iter()
        .find(|m| m.is_host)
        .map(|m| m.name.clone())
        .unwrap_or_else(|| full.clone());
    let host_trust = identity::trust(&host_name, &host_key);

    let alive = Arc::new(AtomicBool::new(true));
    let client = Client {
        addr: full,
        self_id,
        name,
        members,
        host_key,
        host_trust,
        sender: sender.clone(),
        shutdown: closer,
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
                        // File-tunnel frames drive a transfer in the backend and
                        // must never surface as Team-panel commands.
                        if !handle_file_tunnel(&reader_app, &reader_inner, &msg) {
                            let _ = reader_app.emit("relay:command", msg);
                        }
                    }
                    Frame::Collab(msg) => {
                        let _ = reader_app.emit("relay:collab", msg);
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

/// Put a collab frame of ours on the wire. Same split as the host-side relay
/// path: everything that needs the relay mutex happens first and yields plain
/// data, then the lock is dropped and only then does a socket get written. At a
/// frame per keystroke this is the difference between a lock held for
/// nanoseconds and one held for a network round-trip.
///
/// Note this carries no path and mints no document: `doc` is a token the
/// frontend already holds, and the backend never learns what file it means.
#[tauri::command]
pub async fn relay_send_collab(
    state: State<'_, RelayManager>,
    to: Option<String>,
    doc: String,
    body: CollabBody,
) -> Result<(), String> {
    let (frame, targets, upstream) = {
        let inner = state.inner.lock().unwrap();
        let (from, from_name) = sender_context(&inner)?;
        let msg = CollabMsg {
            id: new_id(),
            from,
            from_name,
            to: to.clone(),
            doc,
            body,
            ts: now_ms(),
        };
        let frame = Frame::Collab(msg);
        if let Some(host) = &inner.host {
            let targets = route_targets(host, &host.self_id, &to).0;
            if targets.is_empty() && to.is_some() {
                return Err("That member is no longer connected.".into());
            }
            (frame, targets, None)
        } else if let Some(client) = &inner.client {
            (frame, Vec::new(), Some(client.sender.clone()))
        } else {
            return Err("Not connected to a relay.".into());
        }
    };
    if let Some(sender) = upstream {
        return if peer_send(&sender, &frame) {
            Ok(())
        } else {
            Err("Lost the relay connection.".into())
        };
    }
    for target in targets {
        let _ = peer_send(&target, &frame);
    }
    Ok(())
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

// ---------- file transfer ----------
//
// The relay carries the OFFER (name, size, hash, where to fetch, a one-time
// token). The receiver first tries the DIRECT path: dial the sender's ephemeral
// one-shot listener and pull the bytes peer-to-peer. That stays fully
// end-to-end (the relay never sees a byte) and is what runs on a LAN or between
// reachable peers.
//
// When the direct dial fails — a firewall or NAT between the two, which is the
// common internet case — the receiver falls back to TUNNELLING the bytes over
// the relay connection it already holds (`file-pull`/`begin`/`data`/`end`
// command frames). Each chunk is sealed under a key derived from the offer
// token, so a relaying host forwarding client<->client traffic sees only
// ciphertext; when one endpoint IS the host, the hop is the transfer and stays
// end-to-end. SHA-256 confirms the whole file matches the offer either way.

/// Plaintext bytes per tunnelled chunk. Base64 (~1.33x) plus the JSON command
/// envelope must stay under the secure channel's 2 MiB frame ceiling; 1 MiB in
/// leaves comfortable headroom.
const TUNNEL_CHUNK: usize = 1024 * 1024;

/// Per-transfer AEAD key: the offer token keyed by a fresh random salt (sent in
/// the clear in `file-begin`) so counter-from-zero nonces never repeat across
/// transfers sharing a token. Mirrors `secure::file_channel`'s construction.
fn tunnel_key(token: &str, salt: &[u8]) -> [u8; 32] {
    secure::derive(token.as_bytes(), Some(salt), b"canopy-file-relay")
}

/// 12-byte ChaCha20-Poly1305 nonce from a chunk index: 4 zero bytes + 64-bit BE
/// counter, unique per (key) because each transfer's salt makes the key unique.
fn tunnel_nonce(seq: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[4..].copy_from_slice(&seq.to_be_bytes());
    n
}

fn tunnel_seal(key: &[u8; 32], seq: u64, plaintext: &[u8]) -> Option<Vec<u8>> {
    use chacha20poly1305::aead::{Aead, KeyInit};
    use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    cipher.encrypt(Nonce::from_slice(&tunnel_nonce(seq)), plaintext).ok()
}

fn tunnel_open(key: &[u8; 32], seq: u64, ciphertext: &[u8]) -> Option<Vec<u8>> {
    use chacha20poly1305::aead::{Aead, KeyInit};
    use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    cipher.decrypt(Nonce::from_slice(&tunnel_nonce(seq)), ciphertext).ok()
}

fn b64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

/// Build one of our own file-tunnel command frames. `from`/`from_name` are the
/// authenticated identity the host will stamp anyway; setting them keeps a
/// client's upstream frame self-consistent.
fn file_command(from: &str, from_name: &str, to: &str, kind: &str, payload: Value) -> Frame {
    Frame::Command(CommandMsg {
        id: new_id(),
        from: from.to_string(),
        from_name: from_name.to_string(),
        to: Some(to.to_string()),
        kind: kind.to_string(),
        payload,
        ts: now_ms(),
    })
}

/// Intercept the internal file-tunnel command kinds so they drive the transfer
/// instead of surfacing in the Team panel. Returns true if it was one of ours
/// (and was handled here), false for every user-facing command.
fn handle_file_tunnel(app: &AppHandle, inner: &Arc<Mutex<Inner>>, msg: &CommandMsg) -> bool {
    match msg.kind.as_str() {
        "file-pull" => {
            start_tunnel_send(app, inner, msg);
            true
        }
        "file-begin" => {
            tunnel_begin(inner, msg);
            true
        }
        "file-data" => {
            tunnel_data(inner, msg);
            true
        }
        "file-end" => {
            tunnel_end(inner, msg);
            true
        }
        _ => false,
    }
}

/// Sender side: the receiver couldn't reach us directly and asked us to stream
/// over the relay. Serve the same file the offer named, to the member it named.
fn start_tunnel_send(app: &AppHandle, inner: &Arc<Mutex<Inner>>, msg: &CommandMsg) {
    let Some(token) = msg.payload.get("token").and_then(|v| v.as_str()).map(str::to_string) else {
        return;
    };
    // Everything the stream needs, resolved under one brief lock; the blocking
    // sends happen off-lock so the relay mutex isn't held across the network.
    let plan = {
        let mut guard = inner.lock().unwrap();
        let (from, from_name) = match sender_context(&guard) {
            Ok(v) => v,
            Err(_) => return,
        };
        let Some(offer) = guard.offers_out.get(&token) else { return };
        // Only stream to the member the offer was for — never to whoever's
        // `file-pull` this happened to be.
        if offer.started || offer.to_id != msg.from {
            return;
        }
        let sender = match &guard.host {
            Some(host) => host.peers.get(&offer.to_id).map(|p| p.sender.clone()),
            None => guard.client.as_ref().map(|c| c.sender.clone()),
        };
        let Some(sender) = sender else { return };
        let ctx = (
            sender,
            offer.path.clone(),
            offer.name.clone(),
            offer.size,
            offer.to_id.clone(),
            offer.id.clone(),
            offer.alive.clone(),
            from,
            from_name,
        );
        guard.offers_out.get_mut(&token).unwrap().started = true;
        ctx
    };
    let (sender, path, name, size, to_id, id, alive, from, from_name) = plan;
    let app = app.clone();
    let inner = inner.clone();
    let _ = thread::Builder::new().name("relay-send-file-tunnel".into()).spawn(move || {
        let done_ok = stream_file_over_relay(
            &app, &sender, &path, &name, size, &token, &id, &to_id, &alive, &from, &from_name,
        );
        // Retire the direct one-shot server too (it's still parked in accept);
        // its cleanup closure clears `transfers`/`offers_out`.
        alive.store(false, Ordering::SeqCst);
        inner.lock().unwrap().offers_out.remove(&token);
        let _ = done_ok;
    });
}

/// Read `path` and push it to `to_id` as sealed `file-data` chunks. Returns
/// whether the whole file went out.
#[allow(clippy::too_many_arguments)]
fn stream_file_over_relay(
    app: &AppHandle,
    sender: &Arc<Mutex<secure::Sender>>,
    path: &str,
    name: &str,
    size: u64,
    token: &str,
    id: &str,
    to_id: &str,
    alive: &Arc<AtomicBool>,
    from: &str,
    from_name: &str,
) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        emit_transfer(app, id, "out", name, size, false, "The file vanished before it was sent.".into(), Some(to_id));
        return false;
    };
    let salt = {
        let mut s = [0u8; 16];
        s[..8].copy_from_slice(&secure_u64().to_be_bytes());
        s[8..].copy_from_slice(&secure_u64().to_be_bytes());
        s
    };
    let key = tunnel_key(token, &salt);
    let begin = file_command(from, from_name, to_id, "file-begin", serde_json::json!({
        "token": token, "salt": b64_encode(&salt), "size": size,
    }));
    if !peer_send(sender, &begin) {
        emit_transfer(app, id, "out", name, size, false, "Lost the relay connection.".into(), Some(to_id));
        return false;
    }
    emit_progress(app, id, "out", name, 0, size);
    let mut buf = vec![0u8; TUNNEL_CHUNK];
    let mut seq: u64 = 0;
    let mut done: u64 = 0;
    let mut marked: u64 = 0;
    loop {
        if !alive.load(Ordering::SeqCst) {
            return false;
        }
        let n = match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => {
                emit_transfer(app, id, "out", name, size, false, "Reading the file failed mid-send.".into(), Some(to_id));
                return false;
            }
        };
        let Some(ct) = tunnel_seal(&key, seq, &buf[..n]) else { return false };
        let frame = file_command(from, from_name, to_id, "file-data", serde_json::json!({
            "token": token, "seq": seq, "data": b64_encode(&ct),
        }));
        if !peer_send(sender, &frame) {
            emit_transfer(app, id, "out", name, size, false, "The relay connection dropped mid-send.".into(), Some(to_id));
            return false;
        }
        seq += 1;
        done += n as u64;
        if done - marked >= PROGRESS_STEP {
            marked = done;
            emit_progress(app, id, "out", name, done, size);
        }
    }
    let end = file_command(from, from_name, to_id, "file-end", serde_json::json!({ "token": token }));
    let _ = peer_send(sender, &end);
    emit_progress(app, id, "out", name, size, size);
    emit_transfer(app, id, "out", name, size, true, name.to_string(), Some(to_id));
    true
}

/// Receiver side: the sender is about to stream. Derive this transfer's key
/// from the salt it chose.
fn tunnel_begin(inner: &Arc<Mutex<Inner>>, msg: &CommandMsg) {
    let Some(token) = msg.payload.get("token").and_then(|v| v.as_str()) else { return };
    let Some(salt) = msg.payload.get("salt").and_then(|v| v.as_str()).and_then(b64_decode) else {
        return;
    };
    let mut guard = inner.lock().unwrap();
    let Some(pipe) = guard.tunnel_pipes.get_mut(token) else { return };
    if pipe.from_id.as_deref() != Some(msg.from.as_str()) {
        return;
    }
    pipe.key = Some(tunnel_key(token, &salt));
    pipe.next_seq = 0;
}

/// Receiver side: decode one chunk and hand it to the transfer thread. Decode
/// and decrypt run here (cheap, off the transfer's disk path); the bounded
/// channel applies backpressure so a slow disk throttles the network.
fn tunnel_data(inner: &Arc<Mutex<Inner>>, msg: &CommandMsg) {
    let Some(token) = msg.payload.get("token").and_then(|v| v.as_str()).map(str::to_string) else {
        return;
    };
    let seq = msg.payload.get("seq").and_then(|v| v.as_u64());
    let data = msg.payload.get("data").and_then(|v| v.as_str()).map(str::to_string);
    // Pull what we need out from under the lock; never send on the (possibly
    // full, hence blocking) channel while holding the relay mutex.
    let taken = {
        let mut guard = inner.lock().unwrap();
        let Some(pipe) = guard.tunnel_pipes.get_mut(&token) else { return };
        if pipe.from_id.as_deref() != Some(msg.from.as_str()) {
            return;
        }
        let Some(key) = pipe.key else { return };
        let expected = pipe.next_seq;
        pipe.next_seq += 1;
        (pipe.tx.clone(), key, expected)
    };
    let (tx, key, expected) = taken;
    let event = match (seq, data) {
        (Some(seq), Some(data)) if seq == expected => match b64_decode(&data)
            .and_then(|ct| tunnel_open(&key, seq, &ct))
        {
            Some(pt) => TunnelEvent::Data(pt),
            None => TunnelEvent::Fail,
        },
        _ => TunnelEvent::Fail,
    };
    let _ = tx.send(event);
}

/// Receiver side: the sender finished. Dropping the pipe closes the channel, so
/// the transfer thread wakes, finalizes, and verifies the hash.
fn tunnel_end(inner: &Arc<Mutex<Inner>>, msg: &CommandMsg) {
    let Some(token) = msg.payload.get("token").and_then(|v| v.as_str()) else { return };
    let mut guard = inner.lock().unwrap();
    if let Some(pipe) = guard.tunnel_pipes.get(token) {
        if pipe.from_id.as_deref() != Some(msg.from.as_str()) {
            return;
        }
    }
    guard.tunnel_pipes.remove(token);
}


#[derive(Serialize, Clone)]
pub struct TransferEvent {
    /// Correlates the progress stream with this terminal event. Non-secret
    /// (never the token) so it is safe to hand the UI.
    pub id: String,
    /// "in" (receiving) | "out" (sending)
    pub direction: String,
    pub name: String,
    pub total: u64,
    pub ok: bool,
    /// in+ok: the saved path; out+ok: the receiver's name; !ok: what failed.
    pub detail: String,
    /// The member on the other end, so a completed transfer can be filed into
    /// that conversation's history instead of only flashing past as a toast.
    pub peer: Option<String>,
}

#[derive(Serialize, Clone)]
struct TransferProgress {
    id: String,
    direction: String,
    name: String,
    done: u64,
    total: u64,
}

#[allow(clippy::too_many_arguments)]
fn emit_transfer(app: &AppHandle, id: &str, direction: &str, name: &str, total: u64, ok: bool, detail: String, peer: Option<&str>) {
    let _ = app.emit(
        "relay:transfer",
        TransferEvent {
            id: id.into(),
            direction: direction.into(),
            name: name.into(),
            total,
            ok,
            detail,
            peer: peer.map(str::to_string),
        },
    );
}

fn emit_progress(app: &AppHandle, id: &str, direction: &str, name: &str, done: u64, total: u64) {
    let _ = app.emit(
        "relay:transfer-progress",
        TransferProgress {
            id: id.into(),
            direction: direction.into(),
            name: name.into(),
            done,
            total,
        },
    );
}

/// Emit a progress tick at most ~6×/second so a fast local transfer doesn't
/// flood the event bus. Returns the new "last emitted" byte mark.
const PROGRESS_STEP: u64 = 512 * 1024;

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

/// A file offer's `addrs` are chosen by the remote sender, and on accept we
/// dial each one — so a malicious member could point them at internal
/// infrastructure (cloud metadata at 169.254.169.254, a link-local device) and
/// use the receiver as an outbound-connect primitive. Loopback and private
/// LAN stay allowed (legitimate same-machine / same-office transfers); the
/// dangerous special-use ranges are refused.
fn safe_dial_addr(sa: &std::net::SocketAddr) -> bool {
    match sa.ip() {
        std::net::IpAddr::V4(v4) => {
            !(v4.is_link_local() || v4.is_multicast() || v4.is_broadcast() || v4.is_unspecified())
        }
        std::net::IpAddr::V6(v6) => {
            // Reject unspecified, multicast, and link-local (fe80::/10).
            !(v6.is_unspecified()
                || v6.is_multicast()
                || (v6.segments()[0] & 0xffc0) == 0xfe80)
        }
    }
}

fn is_private_addr(host: &str) -> bool {
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        Ok(std::net::IpAddr::V6(v6)) => v6.is_loopback(),
        // A hostname — assume it resolves publicly.
        Err(_) => false,
    }
}

/// If `s` is an http(s)/ws(s) URL — what a host sharing over the internet hands
/// out (its tunnel address) — normalise it to the WebSocket team endpoint:
/// scheme mapped to ws/wss, and the path forced to `/team/ws` regardless of what
/// the user pasted (so copying the `/remote` portal link still joins the team).
/// Returns None for a bare host:port, which the caller reaches over TCP instead.
fn team_ws_url(s: &str) -> Option<String> {
    let s = s.trim();
    let (scheme, rest) = if let Some(r) = s.strip_prefix("https://") {
        ("wss", r)
    } else if let Some(r) = s.strip_prefix("http://") {
        ("ws", r)
    } else if let Some(r) = s.strip_prefix("wss://") {
        ("wss", r)
    } else if let Some(r) = s.strip_prefix("ws://") {
        ("ws", r)
    } else {
        return None;
    };
    // Keep only the authority (host[:port]); drop any path/query/fragment.
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    if host.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{host}/team/ws"))
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
    let to_id = to.clone();
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
    // Feeds the AEAD keys for the transfer channel — must be CSPRNG.
    let token = format!("{:016x}{:016x}", secure_u64(), secure_u64());

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
    // A non-secret id for the UI to track this send by — distinct from the
    // token, which never leaves the encrypted channel.
    let transfer_id = new_id();
    {
        let mut inner = state.inner.lock().unwrap();
        inner.transfers.insert(token.clone(), alive.clone());
        // Keep the offer's context so a `file-pull` (the receiver couldn't
        // reach the listener) can stream the same file over the relay instead.
        inner.offers_out.insert(token.clone(), OfferOut {
            path: path.clone(),
            name: name.clone(),
            size,
            to_id: to_id.clone(),
            id: transfer_id.clone(),
            alive: alive.clone(),
            started: false,
        });
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
            serve_file(&app, &transfer_id, listener, &path, &name, size, &token, &alive, &to_name, &to_id);
            alive.store(false, Ordering::SeqCst);
            let mut inner = inner_arc.lock().unwrap();
            inner.transfers.remove(&token);
            inner.offers_out.remove(&token);
        })
        .map_err(|e| format!("couldn't spawn transfer thread: {e}"))?;
    Ok(())
}

/// One-shot file server: whoever presents the token gets the bytes, once.
/// Survives a dropped attempt so the receiver can retry until the TTL.
#[allow(clippy::too_many_arguments)]
fn serve_file(
    app: &AppHandle,
    id: &str,
    listener: TcpListener,
    path: &str,
    name: &str,
    size: u64,
    token: &str,
    alive: &Arc<AtomicBool>,
    to_name: &str,
    to_id: &str,
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
        let Some((mut sender, mut receiver)) = secure::file_channel_tcp(&stream, token, true) else {
            let _ = stream.shutdown(Shutdown::Both);
            continue;
        };
        if receiver.recv().is_none() {
            let _ = stream.shutdown(Shutdown::Both);
            continue;
        }
        let Ok(mut file) = std::fs::File::open(path) else {
            emit_transfer(app, id, "out", name, size, false, "The file vanished before it was picked up.".into(), Some(to_id));
            return;
        };
        emit_progress(app, id, "out", name, 0, size);
        let mut buf = [0u8; 65536];
        let mut sent_ok = true;
        let mut done: u64 = 0;
        let mut marked: u64 = 0;
        loop {
            match file.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if !sender.send(&buf[..n]) {
                        sent_ok = false;
                        break;
                    }
                    done += n as u64;
                    if done - marked >= PROGRESS_STEP {
                        marked = done;
                        emit_progress(app, id, "out", name, done, size);
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
            emit_progress(app, id, "out", name, size, size);
            emit_transfer(app, id, "out", name, size, true, to_name.to_string(), Some(to_id));
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
    state: State<'_, RelayManager>,
    name: String,
    size: u64,
    sha256: String,
    addrs: Vec<String>,
    token: String,
    dest: String,
    // Who offered it — carried through so the finished transfer lands in their
    // conversation rather than only in a toast that scrolls away.
    from: Option<String>,
) -> Result<(), String> {
    let id = new_id();
    let from_id = from;
    let inner_arc = state.inner.clone();
    thread::Builder::new()
        .name("relay-receive-file".into())
        .spawn(move || {
            use sha2::{Digest, Sha256};
            let mut stream = None;
            for a in &addrs {
                // Only dial well-formed addresses that aren't pointed at
                // internal/special-use ranges — the sender chose these, so a
                // hostile one could aim them at metadata/link-local hosts.
                if let Ok(sa) = a.parse::<std::net::SocketAddr>() {
                    if !safe_dial_addr(&sa) {
                        continue;
                    }
                    if let Ok(s) = TcpStream::connect_timeout(&sa, Duration::from_secs(4)) {
                        stream = Some(s);
                        break;
                    }
                }
            }
            let Some(stream) = stream else {
                // Direct dial blocked (firewall/NAT). Fall back to pulling the
                // bytes over the relay connection we already hold, if we know
                // who to ask.
                let Some(from_peer) = from_id.clone() else {
                    emit_transfer(
                        &app, &id, "in", &name, size, false,
                        "Couldn't reach the sender directly — a firewall or NAT between you is blocking the peer-to-peer connection.".into(),
                        from_id.as_deref(),
                    );
                    return;
                };
                receive_over_relay(&app, &inner_arc, &id, &name, size, &sha256, &token, &dest, &from_peer);
                return;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
            let Some((mut sender, mut receiver)) = secure::file_channel_tcp(&stream, &token, false) else {
                emit_transfer(&app, &id, "in", &name, size, false, "Couldn't set up the secure channel.".into(), from_id.as_deref());
                return;
            };
            // Authenticate to the sender: only we (holding the token) can send
            // a frame that decrypts under the token-derived key.
            if !sender.send(b"canopy-file") {
                emit_transfer(&app, &id, "in", &name, size, false, "Handshake with the sender failed.".into(), from_id.as_deref());
                return;
            }
            // Receive into a sibling temp file and rename onto `dest` only
            // once the hash checks out. Creating `dest` directly truncated it
            // before a single byte arrived, and every failure path below then
            // deleted it — so accepting a file that overwrites one of your own
            // and losing the connection destroyed YOUR file, which was never
            // part of the transfer. Rename within a directory is atomic, so
            // `dest` either stays untouched or becomes the complete file.
            let part = format!("{dest}.canopy-part");
            let Ok(mut out) = std::fs::File::create(&part) else {
                emit_transfer(&app, &id, "in", &name, size, false, format!("Can't write to {dest}."), from_id.as_deref());
                return;
            };
            emit_progress(&app, &id, "in", &name, 0, size);
            let mut hasher = Sha256::new();
            let mut got = 0u64;
            let mut marked = 0u64;
            while got < size {
                let Some(chunk) = receiver.recv() else { break };
                hasher.update(&chunk);
                if out.write_all(&chunk).is_err() {
                    drop(out);
                    let _ = std::fs::remove_file(&part);
                    emit_transfer(&app, &id, "in", &name, size, false, format!("Writing {dest} failed — disk full?"), from_id.as_deref());
                    return;
                }
                got += chunk.len() as u64;
                if got - marked >= PROGRESS_STEP {
                    marked = got;
                    emit_progress(&app, &id, "in", &name, got, size);
                }
            }
            drop(out);
            if got < size {
                let _ = std::fs::remove_file(&part);
                emit_transfer(&app, &id, "in", &name, size, false, "The connection dropped before the whole file arrived.".into(), from_id.as_deref());
                return;
            }
            let digest = format!("{:x}", hasher.finalize());
            if digest != sha256.to_lowercase() {
                let _ = std::fs::remove_file(&part);
                emit_transfer(&app, &id, "in", &name, size, false, "Integrity check failed — the received bytes don't match the offer. Nothing was kept.".into(), from_id.as_deref());
                return;
            }
            if let Err(e) = std::fs::rename(&part, &dest) {
                let _ = std::fs::remove_file(&part);
                emit_transfer(&app, &id, "in", &name, size, false, format!("Couldn't save to {dest}: {e}"), from_id.as_deref());
                return;
            }
            emit_progress(&app, &id, "in", &name, size, size);
            emit_transfer(&app, &id, "in", &name, size, true, dest.clone(), from_id.as_deref());
        })
        .map_err(|e| format!("couldn't spawn transfer thread: {e}"))?;
    Ok(())
}

/// Receiver side of the relay tunnel: register a reassembly pipe, ask the
/// sender to stream (`file-pull`), then drain plaintext chunks the reader
/// thread decodes into it — writing, hashing, and finalising exactly as the
/// direct path does. Blocks until the transfer ends, so it runs on the
/// `relay-receive-file` thread the direct path already spawned.
#[allow(clippy::too_many_arguments)]
fn receive_over_relay(
    app: &AppHandle,
    inner: &Arc<Mutex<Inner>>,
    id: &str,
    name: &str,
    size: u64,
    sha256: &str,
    token: &str,
    dest: &str,
    from_peer: &str,
) {
    use sha2::{Digest, Sha256};
    // Bounded so a slow disk throttles the reader thread (and thus the network)
    // rather than letting chunks pile up in memory.
    let (tx, rx) = std::sync::mpsc::sync_channel::<TunnelEvent>(4);
    {
        let mut guard = inner.lock().unwrap();
        let (from, from_name) = match sender_context(&guard) {
            Ok(v) => v,
            Err(e) => {
                emit_transfer(app, id, "in", name, size, false, e, Some(from_peer));
                return;
            }
        };
        // Register the pipe and send the pull under one lock, so the sender's
        // reply can never race ahead of the pipe that receives it.
        guard.tunnel_pipes.insert(token.to_string(), TunnelPipe {
            tx,
            key: None,
            next_seq: 0,
            from_id: Some(from_peer.to_string()),
        });
        let frame = file_command(&from, &from_name, from_peer, "file-pull", serde_json::json!({ "token": token }));
        if let Err(e) = deliver(&guard, Some(from_peer.to_string()), frame) {
            guard.tunnel_pipes.remove(token);
            drop(guard);
            emit_transfer(app, id, "in", name, size, false, e, Some(from_peer));
            return;
        }
    }

    let clear_pipe = || {
        inner.lock().unwrap().tunnel_pipes.remove(token);
    };
    let part = format!("{dest}.canopy-part");
    let Ok(mut out) = std::fs::File::create(&part) else {
        clear_pipe();
        emit_transfer(app, id, "in", name, size, false, format!("Can't write to {dest}."), Some(from_peer));
        return;
    };
    emit_progress(app, id, "in", name, 0, size);
    let mut hasher = Sha256::new();
    let mut got = 0u64;
    let mut marked = 0u64;
    let mut failed = false;
    loop {
        match rx.recv() {
            Ok(TunnelEvent::Data(chunk)) => {
                hasher.update(&chunk);
                if out.write_all(&chunk).is_err() {
                    drop(out);
                    let _ = std::fs::remove_file(&part);
                    clear_pipe();
                    emit_transfer(app, id, "in", name, size, false, format!("Writing {dest} failed — disk full?"), Some(from_peer));
                    return;
                }
                got += chunk.len() as u64;
                if got - marked >= PROGRESS_STEP {
                    marked = got;
                    emit_progress(app, id, "in", name, got, size);
                }
            }
            Ok(TunnelEvent::Fail) => {
                failed = true;
                break;
            }
            // Channel closed: `file-end` (whole file arrived) or the relay link
            // dropped (partial). The size/hash checks below tell the two apart.
            Err(_) => break,
        }
    }
    drop(out);
    clear_pipe();
    if failed {
        let _ = std::fs::remove_file(&part);
        emit_transfer(app, id, "in", name, size, false, "The transfer was corrupted in flight — nothing was kept.".into(), Some(from_peer));
        return;
    }
    if got < size {
        let _ = std::fs::remove_file(&part);
        emit_transfer(app, id, "in", name, size, false, "The connection dropped before the whole file arrived.".into(), Some(from_peer));
        return;
    }
    let digest = format!("{:x}", hasher.finalize());
    if digest != sha256.to_lowercase() {
        let _ = std::fs::remove_file(&part);
        emit_transfer(app, id, "in", name, size, false, "Integrity check failed — the received bytes don't match the offer. Nothing was kept.".into(), Some(from_peer));
        return;
    }
    if let Err(e) = std::fs::rename(&part, dest) {
        let _ = std::fs::remove_file(&part);
        emit_transfer(app, id, "in", name, size, false, format!("Couldn't save to {dest}: {e}"), Some(from_peer));
        return;
    }
    emit_progress(app, id, "in", name, size, size);
    emit_transfer(app, id, "in", name, size, true, dest.to_string(), Some(from_peer));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};

    /// A pasted tunnel link (any scheme, any path the user copied) becomes the
    /// ws/wss `/team/ws` endpoint; a bare host:port stays None (the TCP path).
    #[test]
    fn team_ws_url_normalises_tunnel_links() {
        assert_eq!(
            team_ws_url("https://foo.trycloudflare.com"),
            Some("wss://foo.trycloudflare.com/team/ws".into())
        );
        // Copying the /remote portal link still joins the team route.
        assert_eq!(
            team_ws_url("https://foo.ngrok.app/remote"),
            Some("wss://foo.ngrok.app/team/ws".into())
        );
        assert_eq!(
            team_ws_url("http://host.local:6680"),
            Some("ws://host.local:6680/team/ws".into())
        );
        assert_eq!(
            team_ws_url("ws://1.2.3.4:9000/x?y#z"),
            Some("ws://1.2.3.4:9000/team/ws".into())
        );
        // Bare host:port and plain IPs are LAN TCP targets, not URLs.
        assert_eq!(team_ws_url("192.168.1.5:6679"), None);
        assert_eq!(team_ws_url("host.local"), None);
        assert_eq!(team_ws_url("https://"), None);
    }

    /// The frontend composes these bodies by hand in TypeScript, so the two
    /// definitions are only kept honest by something that parses the exact
    /// shape the frontend emits. A silent tag mismatch here would present as
    /// "collaborative editing does nothing", with no error anywhere.
    #[test]
    fn parses_the_bodies_the_frontend_sends() {
        let cases = [
            r#"{"kind":"offer","name":"relay.rs","lang":"rust"}"#,
            r#"{"kind":"open"}"#,
            r#"{"kind":"snapshot","rev":7,"text":"hello"}"#,
            r#"{"kind":"ops","rev":8,"ops":[{"op":"retain","n":3},{"op":"insert","s":"x"},{"op":"delete","n":2}],"author":"abc","hash":null}"#,
            r#"{"kind":"resync","reason":"hash"}"#,
            r#"{"kind":"close","reason":"left"}"#,
            r#"{"kind":"cursor","anchor":1,"head":4,"rev":8}"#,
            r#"{"kind":"project-offer","name":"canopy"}"#,
            r#"{"kind":"project-tree","paths":["src/main.rs","README.md"]}"#,
            r#"{"kind":"project-open","path":"src/main.rs"}"#,
        ];
        for c in cases {
            serde_json::from_str::<CollabBody>(c).unwrap_or_else(|e| panic!("{c}: {e}"));
        }
    }

    /// Tunnelled chunks must round-trip under the token+salt key, and a wrong
    /// chunk index (a reorder or a tamper) must fail to open — the ordering
    /// check and the AEAD together are what keep a relayed transfer honest.
    #[test]
    fn tunnel_chunks_seal_and_open() {
        let key = tunnel_key("0123456789abcdef0123456789abcdef", b"salty-salt-16byt");
        let plain = b"the quick brown fox jumps over the lazy dog";
        let sealed0 = tunnel_seal(&key, 0, plain).unwrap();
        let sealed1 = tunnel_seal(&key, 1, plain).unwrap();
        // Same plaintext, different seq -> different ciphertext (nonce differs).
        assert_ne!(sealed0, sealed1);
        assert_eq!(tunnel_open(&key, 0, &sealed0).unwrap(), plain);
        assert_eq!(tunnel_open(&key, 1, &sealed1).unwrap(), plain);
        // A chunk opened at the wrong index is rejected, not silently accepted.
        assert!(tunnel_open(&key, 1, &sealed0).is_none());
        // A different salt yields a different key, so nothing decrypts.
        let other = tunnel_key("0123456789abcdef0123456789abcdef", b"different-16bytes");
        assert!(tunnel_open(&other, 0, &sealed0).is_none());
    }

    /// The base64 hop the tunnel puts chunks through for JSON transport must be
    /// lossless for arbitrary bytes.
    #[test]
    fn tunnel_base64_round_trips() {
        let bytes: Vec<u8> = (0..=255u8).cycle().take(4096).collect();
        assert_eq!(b64_decode(&b64_encode(&bytes)).unwrap(), bytes);
    }

    /// A collab frame has to survive the same encode/decode the relay does to
    /// every other frame, and land back as `Collab` rather than being eaten by
    /// an earlier variant's tag.
    #[test]
    fn collab_frame_round_trips() {
        let frame = Frame::Collab(CollabMsg {
            id: "i".into(),
            from: "f".into(),
            from_name: "n".into(),
            to: None,
            doc: "d".into(),
            body: CollabBody::Ops {
                rev: 1,
                ops: vec![CollabOp::Retain { n: 2 }, CollabOp::Insert { s: "hi".into() }],
                author: "f".into(),
                hash: Some("deadbeef".into()),
            },
            ts: 0,
        });
        let bytes = serde_json::to_vec(&frame).unwrap();
        assert!(matches!(
            serde_json::from_slice::<Frame>(&bytes).unwrap(),
            Frame::Collab(_)
        ));
    }

    /// Fan-out must skip the sender — echoing an operation back to its author
    /// would have the guest apply its own edit twice.
    #[test]
    fn broadcast_targets_exclude_the_sender() {
        // Constructing a Peer needs a live socket, so this checks the routing
        // decision the only way that stays a unit test: an empty peer table
        // still yields the right shape for both addressing modes.
        let host = Host {
            code: "0000000".into(),
            port: 0,
            self_id: "host".into(),
            name: "h".into(),
            visibility: "local".into(),
            public_ip: None,
            peers: HashMap::new(),
            alive: Arc::new(AtomicBool::new(true)),
        };
        assert!(route_targets(&host, "someone", &None).0.is_empty());
        assert!(route_targets(&host, "someone", &Some("nobody".into())).0.is_empty());
    }

    /// Accept the way relay_host_start's loop does: a non-blocking listener,
    /// polled. `apply_fix` mirrors host_conn clearing the inherited flag.
    fn host_side(listener: &TcpListener, code: &str, apply_fix: bool) -> bool {
        let stream = loop {
            match listener.accept() {
                Ok((s, _)) => break s,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20))
                }
                Err(_) => return false,
            }
        };
        if apply_fix {
            let _ = stream.set_nonblocking(false);
        }
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        let Some((mut s, mut r, binding)) = secure::handshake_tcp(&stream, code, false) else {
            return false;
        };
        identity::exchange(&mut s, &mut r, &binding, true).is_some()
    }

    fn client_side(addr: std::net::SocketAddr, code: &str) -> bool {
        let Ok(stream) = TcpStream::connect(addr) else { return false };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        let Some((mut s, mut r, binding)) = secure::handshake_tcp(&stream, code, true) else {
            return false;
        };
        identity::exchange(&mut s, &mut r, &binding, false).is_some()
    }

    fn run_join(apply_fix: bool) -> (bool, bool) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let code = new_code();
        let c = code.clone();
        let client = thread::spawn(move || client_side(addr, &c));
        let host_ok = host_side(&listener, &code, apply_fix);
        (host_ok, client.join().unwrap_or(false))
    }

    /// A join completes end to end: SPAKE2 over a real socket, then the
    /// signed identity exchange, against a socket from a non-blocking listener.
    #[test]
    fn join_completes_over_accepted_socket() {
        let (host_ok, client_ok) = run_join(true);
        assert!(host_ok, "host side of the handshake failed");
        assert!(client_ok, "client side of the handshake failed");
    }

    /// The regression guard. Without clearing the inherited non-blocking flag
    /// the host's first handshake read returns WouldBlock instantly and the
    /// join dies — which is exactly what shipped in 0.2.1 on macOS. If this
    /// ever starts passing on a BSD-derived platform the fix has been undone.
    #[test]
    #[cfg(target_vendor = "apple")]
    fn join_fails_without_clearing_inherited_nonblocking() {
        let (host_ok, _) = run_join(false);
        assert!(!host_ok, "expected the unfixed accept path to fail on macOS");
    }
}
