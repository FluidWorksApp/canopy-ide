#![allow(dead_code)] // consumed by the host/join UDP wiring (task #7)
//! A reliable, ordered byte stream over a hole-punched UDP socket, via QUIC.
//!
//! `punch.rs` gets two peers exchanging UDP packets across CGNAT. But the relay
//! crypto counts nonces with a counter that assumes nothing is ever lost or
//! reordered — true over TCP, false over raw UDP, where a single dropped packet
//! desyncs the counter and every later frame fails to decrypt (which the relay
//! reads as "the peer hung up"). So we don't run the crypto over raw datagrams;
//! we run it over QUIC, which gives back TCP's guarantees — reliable, ordered,
//! a real stream — on top of the punched socket. Reimplementing that by hand
//! (retransmits, acks, a reassembly buffer, a replay window) is exactly the
//! "reimplement TCP badly" trap; quinn already does it correctly.
//!
//! The relay is written in blocking threads (`host_conn` per peer), and quinn
//! is async. Rather than rewrite the relay, this module bridges: a dedicated
//! thread runs a small tokio runtime that owns the QUIC connection and two pump
//! tasks, and exposes the connection to the sync world as the same boxed
//! `Write`/`Read` halves `secure::handshake` already takes. The crypto, the
//! framing, the whole existing relay loop run over it with no change — that is
//! the entire reason `secure` was made transport-agnostic first.
//!
//! TLS note: QUIC mandates TLS, so there are two encryption layers. The TLS one
//! uses a throwaway self-signed cert and a verifier that accepts anything —
//! it provides transport encryption and nothing we rely on for identity. The
//! REAL authentication stays exactly where it was: SPAKE2 from the join code,
//! then per-frame ChaCha20-Poly1305, run over the stream this hands back.

use std::io::{self, Read, Write};
use std::net::{SocketAddr, UdpSocket};
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::time::Duration;

use quinn::crypto::rustls::QuicClientConfig;
use quinn::{ClientConfig, Endpoint, EndpointConfig, ServerConfig, TokioRuntime};

use crate::relay::secure::{BoxRead, BoxWrite};

const ALPN: &[u8] = b"canopy-relay/1";
/// Chunk size the recv pump reads from the QUIC stream at a time.
const RECV_CHUNK: usize = 64 * 1024;

/// A rustls verifier that accepts any certificate. Safe here ONLY because the
/// application layer (SPAKE2 + ed25519 over this stream) is what authenticates
/// the peer; the QUIC/TLS layer exists purely for transport encryption, and the
/// two ends have no shared PKI to verify against.
#[derive(Debug)]
struct AcceptAny;

impl rustls::client::danger::ServerCertVerifier for AcceptAny {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

fn server_config() -> Result<ServerConfig, String> {
    let cert = rcgen::generate_simple_self_signed(vec!["canopy".into()])
        .map_err(|e| format!("cert gen: {e}"))?;
    let cert_der = cert.cert.der().clone();
    let key_der = rustls::pki_types::PrivatePkcs8KeyDer::from(cert.key_pair.serialize_der());
    // Build the rustls config by hand so ALPN can be set — it must match the
    // client's exactly or neither side offers it, so both ends set it here.
    let mut rustls_cfg = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert_der], key_der.into())
        .map_err(|e| format!("server tls: {e}"))?;
    rustls_cfg.alpn_protocols = vec![ALPN.to_vec()];
    let quic = quinn::crypto::rustls::QuicServerConfig::try_from(rustls_cfg)
        .map_err(|e| format!("server quic: {e}"))?;
    let mut cfg = ServerConfig::with_crypto(Arc::new(quic));
    // Punched mappings die if idle; keep the path warm well inside that window.
    cfg.transport_config(Arc::new(transport_config()));
    Ok(cfg)
}

fn client_config() -> Result<ClientConfig, String> {
    let mut rustls_cfg = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAny))
        .with_no_client_auth();
    rustls_cfg.alpn_protocols = vec![ALPN.to_vec()];
    let quic = QuicClientConfig::try_from(rustls_cfg).map_err(|e| format!("client tls: {e}"))?;
    let mut cfg = ClientConfig::new(Arc::new(quic));
    cfg.transport_config(Arc::new(transport_config()));
    Ok(cfg)
}

fn transport_config() -> quinn::TransportConfig {
    let mut t = quinn::TransportConfig::default();
    // Keepalive under the NAT idle timeout; max idle a bit above so a brief
    // stall doesn't tear the connection down.
    t.keep_alive_interval(Some(Duration::from_secs(10)));
    t.max_idle_timeout(Some(Duration::from_secs(30).try_into().unwrap()));
    t
}

/// The sync side of the send half: whatever the relay writes is chunked onto an
/// unbounded channel the async pump drains. Unbounded + tokio's sync `send`
/// means the blocking caller never awaits.
struct ChanWrite(tokio::sync::mpsc::UnboundedSender<Vec<u8>>);

impl Write for ChanWrite {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0
            .send(buf.to_vec())
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "quic send closed"))?;
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The sync side of the recv half: the async pump pushes decrypted-transport
/// chunks onto a std channel; blocking `read` drains them, buffering the
/// remainder of a chunk that didn't fit the caller's buffer.
struct ChanRead {
    rx: std_mpsc::Receiver<Vec<u8>>,
    left: Vec<u8>,
    pos: usize,
}

impl Read for ChanRead {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.left.len() {
            match self.rx.recv() {
                Ok(chunk) => {
                    self.left = chunk;
                    self.pos = 0;
                }
                // Sender gone = clean EOF, which read_exact turns into the
                // UnexpectedEof the relay treats as end-of-connection.
                Err(_) => return Ok(0),
            }
        }
        let n = (self.left.len() - self.pos).min(buf.len());
        buf[..n].copy_from_slice(&self.left[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

/// Establish a QUIC connection over an ALREADY-punched socket and return the
/// boxed stream halves for `secure::handshake`.
///
/// `initiator` mirrors the SPAKE2 role: the joiner (initiator) is the QUIC
/// client and dials `peer`; the host (responder) is the QUIC server and
/// accepts. That alignment matters — the initiator writes the first SPAKE2
/// frame, and a QUIC bidi stream the client opens only reaches the server once
/// the client writes, so the ordering falls out correctly.
pub fn connect(
    sock: UdpSocket,
    peer: SocketAddr,
    initiator: bool,
    timeout: Duration,
) -> Result<(BoxWrite, BoxRead), String> {
    sock.set_nonblocking(true)
        .map_err(|e| format!("socket nonblocking: {e}"))?;
    let (ready_tx, ready_rx) = std_mpsc::channel::<Result<(BoxWrite, BoxRead), String>>();

    // The runtime — and thus the connection and its pumps — lives on this
    // thread until the connection closes. Detached on purpose: the returned
    // halves keep it working, and it self-terminates when they drop and the
    // connection goes idle.
    std::thread::Builder::new()
        .name("relay-quic".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("runtime: {e}")));
                    return;
                }
            };
            rt.block_on(async move {
                match establish(sock, peer, initiator, timeout).await {
                    Ok((conn, wr, rd)) => {
                        let _ = ready_tx.send(Ok((wr, rd)));
                        // Hold the connection open for the pumps' lifetime.
                        conn.closed().await;
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                    }
                }
            });
        })
        .map_err(|e| format!("spawn quic thread: {e}"))?;

    ready_rx
        .recv()
        .map_err(|_| "quic thread died before connecting".to_string())?
}

async fn establish(
    sock: UdpSocket,
    peer: SocketAddr,
    initiator: bool,
    timeout: Duration,
) -> Result<(quinn::Connection, BoxWrite, BoxRead), String> {
    let runtime = Arc::new(TokioRuntime);
    let conn = if initiator {
        // QUIC client: dial the host's punched address.
        let mut ep = Endpoint::new(EndpointConfig::default(), None, sock, runtime)
            .map_err(|e| format!("client endpoint: {e}"))?;
        ep.set_default_client_config(client_config()?);
        let connecting = ep
            .connect(peer, "canopy")
            .map_err(|e| format!("connect: {e}"))?;
        tokio::time::timeout(timeout, connecting)
            .await
            .map_err(|_| "timed out establishing the encrypted connection".to_string())?
            .map_err(|e| format!("quic handshake: {e}"))?
    } else {
        // QUIC server: accept the joiner's connection on the punched socket.
        let ep = Endpoint::new(
            EndpointConfig::default(),
            Some(server_config()?),
            sock,
            runtime,
        )
        .map_err(|e| format!("server endpoint: {e}"))?;
        let incoming = tokio::time::timeout(timeout, ep.accept())
            .await
            .map_err(|_| "timed out waiting for the peer to connect".to_string())?
            .ok_or("endpoint closed before a peer connected")?;
        incoming.await.map_err(|e| format!("quic accept: {e}"))?
    };

    // One bidirectional stream carries the relay session. The initiator opens
    // it and writes first (matching SPAKE2); the responder accepts it.
    let (send, recv) = if initiator {
        conn.open_bi().await.map_err(|e| format!("open stream: {e}"))?
    } else {
        conn.accept_bi().await.map_err(|e| format!("accept stream: {e}"))?
    };

    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let (in_tx, in_rx) = std_mpsc::channel::<Vec<u8>>();

    // Send pump: relay writes -> QUIC stream.
    let mut send = send;
    tokio::spawn(async move {
        while let Some(chunk) = out_rx.recv().await {
            if send.write_all(&chunk).await.is_err() {
                break;
            }
        }
        let _ = send.finish();
    });
    // Recv pump: QUIC stream -> relay reads.
    let mut recv = recv;
    tokio::spawn(async move {
        let mut buf = vec![0u8; RECV_CHUNK];
        loop {
            match recv.read(&mut buf).await {
                Ok(Some(n)) if n > 0 => {
                    if in_tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                // None = clean finish, Ok(Some(0)) = nothing, Err = reset.
                _ => break,
            }
        }
    });

    let writer: BoxWrite = Box::new(ChanWrite(out_tx));
    let reader: BoxRead = Box::new(ChanRead {
        rx: in_rx,
        left: Vec::new(),
        pos: 0,
    });
    Ok((conn, writer, reader))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::secure;

    /// The whole reliable stack over loopback: two UDP sockets, QUIC on each,
    /// then the REAL relay handshake (SPAKE2 keyed by a code) over the bridge,
    /// then an encrypted frame each way. This is everything the internet path
    /// does except the hole punch — if the crypto rides the QUIC bridge here,
    /// it rides it over a punched socket too.
    #[test]
    fn handshake_and_frame_over_quic() {
        let host_sock = UdpSocket::bind("127.0.0.1:0").unwrap();
        let join_sock = UdpSocket::bind("127.0.0.1:0").unwrap();
        let host_addr = host_sock.local_addr().unwrap();
        let join_addr = join_sock.local_addr().unwrap();
        let code = "1234567";

        // Host = QUIC server / SPAKE2 responder.
        let h = std::thread::spawn(move || {
            let (w, r) = connect(host_sock, join_addr, false, Duration::from_secs(10))?;
            let (mut s, mut rx, _bind) =
                secure::handshake(w, r, code, false).ok_or("host handshake")?;
            let got = rx.recv().ok_or("host recv")?;
            s.send(b"hello from host");
            Ok::<_, String>(got)
        });

        // Joiner = QUIC client / SPAKE2 initiator.
        let (w, r) = connect(join_sock, host_addr, true, Duration::from_secs(10)).unwrap();
        let (mut s, mut rx, _bind) = secure::handshake(w, r, code, true).unwrap();
        s.send(b"hello from joiner");
        let from_host = rx.recv().unwrap();

        let from_joiner = h.join().unwrap().unwrap();
        assert_eq!(from_joiner, b"hello from joiner");
        assert_eq!(from_host, b"hello from host");
    }
}
