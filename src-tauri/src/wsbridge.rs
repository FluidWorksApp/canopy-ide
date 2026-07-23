#![allow(dead_code)] // wired into the host route + join dial in the next step
//! WebSocket transport for the team relay — the pipe that unifies Team sessions
//! and Canopy Remote onto one ingress.
//!
//! The relay crypto (`secure::handshake`, then per-frame ChaCha20-Poly1305) is
//! transport-agnostic: it reads and writes a reliable, ordered byte stream and
//! neither knows nor cares what carries it. TCP carried it on the LAN and QUIC
//! carried it over the internet. This module carries it over a WebSocket, which
//! matters because a WebSocket is what the app's *own* axum server already
//! speaks — so a team session can travel the exact endpoint Canopy Remote does
//! (the LAN URL, or the active Cloudflare / ngrok / Tailscale tunnel) instead of
//! a second listener with its own hole-punch. One endpoint, two PIN-gated routes.
//!
//! Like the old QUIC bridge, the relay runs in blocking threads while the
//! WebSocket is async, so each direction is bridged: a single pump task owns the
//! socket and shuttles bytes between it and two channels the sync world drains.
//! The pump also answers protocol Pings, so an idle session survives the
//! keepalives a tunnel or reverse proxy injects.
//!
//! TLS note: `wss://` through a tunnel gives real, publicly-rooted TLS — but as
//! with QUIC, that is transport encryption only. The REAL authentication is
//! unchanged: SPAKE2 from the join code, then ChaCha20-Poly1305, run END TO END
//! over this stream. A tunnel provider that terminates TLS still sees only relay
//! ciphertext.

use std::io::{self, Read, Write};
use std::sync::mpsc as std_mpsc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use crate::relay::secure::{BoxRead, BoxWrite};

/// The sync side of the send half: whatever the relay writes is queued onto an
/// unbounded channel the pump drains. Unbounded + a sync `send` means the
/// blocking caller never awaits.
struct ChanWrite(UnboundedSender<Vec<u8>>);

impl Write for ChanWrite {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0
            .send(buf.to_vec())
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "ws send closed"))?;
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The sync side of the recv half: the pump pushes each inbound binary message
/// onto a std channel; blocking `read` drains it, buffering the remainder of a
/// message that didn't fit the caller's buffer. Message boundaries don't matter
/// — the relay reassembles its own length-prefixed frames from the byte stream.
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

/// Breaks a WebSocket-backed channel so a thread blocked in `recv` wakes. Held
/// by the relay's `Closer`; aborting the pump drops both channel ends, which
/// surfaces to the sync side as EOF (read) / BrokenPipe (write) and closes the
/// underlying socket. Lock-free and callable from any thread.
pub struct WsCloser {
    abort: tokio::task::AbortHandle,
}

impl WsCloser {
    pub fn close(&self) {
        self.abort.abort();
    }
}

/// Wire the two sync halves onto a freshly-spawned pump `JoinHandle`. Shared by
/// both directions; the caller supplies the already-spawned pump.
fn halves(
    out_tx: UnboundedSender<Vec<u8>>,
    in_rx: std_mpsc::Receiver<Vec<u8>>,
    abort: tokio::task::AbortHandle,
) -> (BoxWrite, BoxRead, WsCloser) {
    let writer: BoxWrite = Box::new(ChanWrite(out_tx));
    let reader: BoxRead = Box::new(ChanRead { rx: in_rx, left: Vec::new(), pos: 0 });
    (writer, reader, WsCloser { abort })
}

/// Bridge an already-upgraded **axum** WebSocket (the host side, one joined team
/// peer) to the sync stream halves `secure::handshake` takes. Must be called on
/// the tokio runtime — it spawns the pump task. The blocking handshake +
/// `serve_peer` then run on a separate (blocking) thread, talking to this socket
/// only through the returned halves.
pub fn server_halves(ws: axum::extract::ws::WebSocket) -> (BoxWrite, BoxRead, WsCloser) {
    use axum::extract::ws::Message;
    let (out_tx, mut out_rx) = unbounded_channel::<Vec<u8>>();
    let (in_tx, in_rx) = std_mpsc::channel::<Vec<u8>>();
    let handle = tokio::spawn(async move {
        let mut ws = ws;
        loop {
            tokio::select! {
                queued = out_rx.recv() => match queued {
                    Some(chunk) => {
                        if ws.send(Message::Binary(chunk)).await.is_err() {
                            break;
                        }
                    }
                    // Relay closed its send half — flush a Close and stop.
                    None => {
                        let _ = ws.send(Message::Close(None)).await;
                        break;
                    }
                },
                inbound = ws.next() => match inbound {
                    Some(Ok(Message::Binary(b))) => {
                        if in_tx.send(b).is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(p))) => {
                        let _ = ws.send(Message::Pong(p)).await;
                    }
                    // Text / Pong are not part of the relay wire; ignore.
                    Some(Ok(_)) => {}
                    // Close, transport error, or end-of-stream: peer is gone.
                    Some(Err(_)) | None => break,
                },
            }
        }
    });
    let abort = handle.abort_handle();
    halves(out_tx, in_rx, abort)
}

/// Dial a team host's `wss://…/team/ws` (or `ws://` on the LAN) and hand back
/// the sync stream halves for `secure::handshake` (join side). Mirrors
/// `qstream::connect`: a dedicated thread owns a small runtime that holds the
/// connection and its pump for the session's life, so the returned halves are
/// usable straight from the relay's blocking `run_client`.
pub fn connect(url: &str, timeout: Duration) -> Result<(BoxWrite, BoxRead, WsCloser), String> {
    let url = url.to_string();
    let (ready_tx, ready_rx) =
        std_mpsc::channel::<Result<(BoxWrite, BoxRead, WsCloser), String>>();

    std::thread::Builder::new()
        .name("relay-ws".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("runtime: {e}")));
                    return;
                }
            };
            rt.block_on(async move {
                let dial = tokio_tungstenite::connect_async(&url);
                let ws = match tokio::time::timeout(timeout, dial).await {
                    Ok(Ok((ws, _resp))) => ws,
                    Ok(Err(e)) => {
                        let _ = ready_tx.send(Err(format!("couldn't reach the host: {e}")));
                        return;
                    }
                    Err(_) => {
                        let _ = ready_tx.send(Err("timed out reaching the host".into()));
                        return;
                    }
                };
                let (out_tx, out_rx) = unbounded_channel::<Vec<u8>>();
                let (in_tx, in_rx) = std_mpsc::channel::<Vec<u8>>();
                let handle = tokio::spawn(pump_client(ws, out_rx, in_tx));
                let abort = handle.abort_handle();
                let (w, r, closer) = halves(out_tx, in_rx, abort);
                let _ = ready_tx.send(Ok((w, r, closer)));
                // Hold the runtime (and thus the pump) alive for the session; the
                // pump ends when either side closes or the WsCloser aborts it.
                let _ = handle.await;
            });
        })
        .map_err(|e| format!("spawn ws thread: {e}"))?;

    ready_rx
        .recv()
        .map_err(|_| "ws thread died before connecting".to_string())?
}

/// The join-side pump: same shuttle as `server_halves`, over a tungstenite
/// WebSocket (its `Message` type differs from axum's, hence a second loop).
async fn pump_client(
    ws: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    mut out_rx: UnboundedReceiver<Vec<u8>>,
    in_tx: std_mpsc::Sender<Vec<u8>>,
) {
    use tokio_tungstenite::tungstenite::Message;
    let mut ws = ws;
    loop {
        tokio::select! {
            queued = out_rx.recv() => match queued {
                Some(chunk) => {
                    if ws.send(Message::Binary(chunk)).await.is_err() {
                        break;
                    }
                }
                None => {
                    let _ = ws.send(Message::Close(None)).await;
                    break;
                }
            },
            inbound = ws.next() => match inbound {
                Some(Ok(Message::Binary(b))) => {
                    if in_tx.send(b.to_vec()).is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Ping(p))) => {
                    let _ = ws.send(Message::Pong(p)).await;
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => break,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::secure;

    /// The real relay handshake (SPAKE2 keyed by a code) plus an encrypted frame
    /// each way, run over a live loopback WebSocket — the host side upgrades an
    /// axum socket, the join side dials it with the same tokio-tungstenite path
    /// production uses. If the crypto rides this bridge here, it rides it over a
    /// tunnel too (the tunnel is just a longer wire).
    #[test]
    fn handshake_and_frame_over_ws() {
        use axum::extract::ws::WebSocketUpgrade;
        use axum::routing::get;
        use axum::Router;
        use std::sync::mpsc;

        let (got_tx, got_rx) = mpsc::channel::<Vec<u8>>();
        let (addr_tx, addr_rx) = mpsc::channel::<std::net::SocketAddr>();

        // Host: an axum server on its own long-lived runtime thread (the crate's
        // tokio has no multi-thread feature, so we drive a current-thread runtime
        // that blocks on `serve` for the test's life). /team/ws upgrades to the
        // responder side of the relay handshake, run on a blocking task.
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async move {
                let handler = move |ws: WebSocketUpgrade| async move {
                    let got_tx = got_tx.clone();
                    ws.on_upgrade(move |socket| async move {
                        let (w, r, _closer) = server_halves(socket);
                        tokio::task::spawn_blocking(move || {
                            let (mut s, mut rx, _bind) =
                                secure::handshake(w, r, "1234567", false).expect("host handshake");
                            let msg = rx.recv().expect("host recv");
                            s.send(b"hello from host");
                            let _ = got_tx.send(msg);
                        })
                        .await
                        .ok();
                    })
                };
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                addr_tx.send(listener.local_addr().unwrap()).unwrap();
                let app = Router::new().route("/team/ws", get(handler));
                axum::serve(listener, app).await.ok();
            });
        });

        // Join: dial the host and run the initiator side.
        let addr = addr_rx.recv().unwrap();
        let url = format!("ws://{addr}/team/ws");
        let (w, r, _closer) = connect(&url, Duration::from_secs(10)).unwrap();
        let (mut s, mut rx, _bind) = secure::handshake(w, r, "1234567", true).unwrap();
        s.send(b"hello from joiner");
        let from_host = rx.recv().unwrap();

        let from_joiner = got_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(from_joiner, b"hello from joiner");
        assert_eq!(from_host, b"hello from host");
    }
}
