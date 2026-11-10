//! The RPC socket to a saved T3 Code machine, opened and owned here.
//!
//! The webview cannot open it itself: Canopy's CSP allows `ws:` only to
//! loopback, and T3 machines on a LAN or tailnet speak plain `ws://`. So Rust
//! mints the ticket (t3_client.rs, which also re-checks the machine's
//! environment id), dials the socket, and passes text messages to the webview
//! over a Tauri channel. Neither the ticket nor the socket URL reaches JS.
//!
//! Channel payloads (src/t3connect/api.ts tauriTransport reads them):
//!   {"kind":"message","data":"<one WebSocket text message, unchanged>"}
//!   {"kind":"closed","code":1000,"reason":"…"}   always last, exactly once
//!
//! Each socket has one writer task fed by a bounded queue; a full queue makes
//! `t3_socket_send` fail rather than buffer without limit.

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::{self, Message};

/// Largest message either way. T3 splits big frames into parts
/// (packages/shared/src/socketFrameParts.ts), so this is far above normal use.
pub const MAX_MESSAGE_BYTES: usize = 16 << 20;
/// Sockets open at once, across all machines and views.
pub const MAX_SOCKETS: usize = 32;
/// Outgoing messages waiting for the writer, per socket.
pub const SEND_QUEUE: usize = 256;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Close codes (RFC 6455 §7.4.1) used in the closed event.
const NORMAL: u16 = 1000;
const NO_STATUS: u16 = 1005;
const ABNORMAL: u16 = 1006;
const INVALID_DATA: u16 = 1007;
const TOO_BIG: u16 = 1009;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SocketEvent {
    Message { data: String },
    Closed { code: u16, reason: String },
}

type CloseSignal = watch::Sender<Option<(u16, String)>>;

struct Entry {
    /// None while the socket is still connecting.
    out: Option<mpsc::Sender<Message>>,
    close: Arc<CloseSignal>,
}

#[derive(Default)]
struct Inner {
    next_id: u32,
    sockets: HashMap<u32, Entry>,
}

#[derive(Default, Clone)]
pub struct T3Sockets(Arc<Mutex<Inner>>);

impl T3Sockets {
    /// Dials `url` and forwards what arrives to `on_event`. Returns the
    /// socket id once the handshake is done. The slot is taken before
    /// dialing, so the limit counts sockets still connecting.
    pub async fn open<F>(&self, url: &str, on_event: F) -> Result<u32, String>
    where
        F: Fn(SocketEvent) + Send + Sync + 'static,
    {
        if !(url.starts_with("ws://") || url.starts_with("wss://")) {
            return Err("A T3 socket address must be ws: or wss:.".into());
        }
        let (close_tx, mut close_rx) = watch::channel(None);
        let close = Arc::new(close_tx);
        let id = {
            let mut inner = self.0.lock().unwrap();
            if inner.sockets.len() >= MAX_SOCKETS {
                return Err(format!(
                    "Too many T3 connections are open (at most {MAX_SOCKETS}). Close one and try again."
                ));
            }
            inner.next_id = inner.next_id.wrapping_add(1).max(1);
            let id = inner.next_id;
            inner.sockets.insert(
                id,
                Entry {
                    out: None,
                    close: close.clone(),
                },
            );
            id
        };
        let config = WebSocketConfig {
            max_message_size: Some(MAX_MESSAGE_BYTES),
            max_frame_size: Some(MAX_MESSAGE_BYTES),
            ..Default::default()
        };
        let dial = tokio::time::timeout(
            CONNECT_TIMEOUT,
            tokio_tungstenite::connect_async_with_config(url, Some(config), true),
        );
        let connected = tokio::select! {
            result = dial => result,
            _ = close_rx.changed() => {
                self.forget(id);
                return Err("The T3 connection was closed while it opened.".into());
            }
        };
        let socket = match connected {
            Ok(Ok((socket, _))) => socket,
            Ok(Err(error)) => {
                self.forget(id);
                return Err(dial_error(&error));
            }
            Err(_) => {
                self.forget(id);
                return Err("The T3 machine did not open the connection in time.".into());
            }
        };

        let (mut sink, mut source) = socket.split();
        let (out_tx, mut out_rx) = mpsc::channel::<Message>(SEND_QUEUE);
        let registered = match self.0.lock().unwrap().sockets.get_mut(&id) {
            Some(entry) => {
                entry.out = Some(out_tx);
                true
            }
            None => false,
        };
        if !registered {
            // Closed (app exit) during the handshake.
            let _ = sink.close().await;
            return Err("The T3 connection was closed while it opened.".into());
        }

        // The writer: the queue in order, then a close frame when told to stop.
        let mut writer_close = close.subscribe();
        tokio::spawn(async move {
            let frame = loop {
                tokio::select! {
                    message = out_rx.recv() => match message {
                        Some(message) => {
                            if sink.send(message).await.is_err() {
                                return;
                            }
                        }
                        None => break None,
                    },
                    changed = writer_close.changed() => {
                        break if changed.is_ok() { writer_close.borrow().clone() } else { None };
                    }
                }
            };
            if let Some((code, reason)) = frame {
                let _ = sink
                    .send(Message::Close(Some(CloseFrame {
                        code: CloseCode::from(code),
                        reason: reason.into(),
                    })))
                    .await;
            }
            let _ = sink.close().await;
        });

        // The reader: every text message to `on_event`, then one closed event.
        let sockets = self.clone();
        tokio::spawn(async move {
            let (code, reason, tell_server) = loop {
                tokio::select! {
                    _ = close_rx.changed() => {
                        let (code, reason) = close_rx.borrow().clone().unwrap_or((NORMAL, String::new()));
                        break (code, reason, false);
                    }
                    message = source.next() => match message {
                        Some(Ok(Message::Text(data))) => on_event(SocketEvent::Message { data }),
                        // A browser socket hands binary over too; rpc.ts decodes it as text.
                        Some(Ok(Message::Binary(bytes))) => match String::from_utf8(bytes) {
                            Ok(data) => on_event(SocketEvent::Message { data }),
                            Err(_) => break (INVALID_DATA, "The T3 machine sent a message that is not text.".into(), true),
                        },
                        Some(Ok(Message::Close(frame))) => break match frame {
                            Some(frame) => (u16::from(frame.code), frame.reason.into_owned(), false),
                            None => (NO_STATUS, String::new(), false),
                        },
                        Some(Ok(_)) => {}
                        Some(Err(tungstenite::Error::Capacity(_))) => break (
                            TOO_BIG,
                            format!("The T3 machine sent a message larger than {} MiB.", MAX_MESSAGE_BYTES >> 20),
                            true,
                        ),
                        Some(Err(error)) => break (ABNORMAL, format!("The T3 connection failed: {error}"), false),
                        None => break (ABNORMAL, "The T3 connection dropped.".into(), false),
                    }
                }
            };
            if tell_server {
                let _ = close.send(Some((code, reason.clone())));
            }
            // Stops the writer (if the close signal did not) once it drains.
            sockets.forget(id);
            on_event(SocketEvent::Closed { code, reason });
        });
        Ok(id)
    }

    /// Queues one text message. Fails when the queue is full or the socket is gone.
    pub fn send(&self, id: u32, text: String) -> Result<(), String> {
        if text.len() > MAX_MESSAGE_BYTES {
            return Err(format!(
                "That message is larger than {} MiB.",
                MAX_MESSAGE_BYTES >> 20
            ));
        }
        let out = self
            .0
            .lock()
            .unwrap()
            .sockets
            .get(&id)
            .and_then(|entry| entry.out.clone())
            .ok_or_else(|| "That T3 connection is closed.".to_string())?;
        out.try_send(Message::Text(text))
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => {
                    "The T3 connection is not keeping up; the message was not sent.".to_string()
                }
                mpsc::error::TrySendError::Closed(_) => "That T3 connection is closed.".to_string(),
            })
    }

    /// Closes the socket; its channel then gets the closed event. Closing one
    /// that is already gone is not an error.
    pub fn close(&self, id: u32) {
        let entry = self.0.lock().unwrap().sockets.remove(&id);
        if let Some(entry) = entry {
            let _ = entry.close.send(Some((NORMAL, "Closed by Canopy".into())));
        }
    }

    pub fn shutdown_all(&self) {
        let entries: Vec<Entry> = self
            .0
            .lock()
            .unwrap()
            .sockets
            .drain()
            .map(|(_, e)| e)
            .collect();
        for entry in entries {
            let _ = entry.close.send(Some((1001, "Canopy is quitting".into())));
        }
    }

    #[cfg(test)]
    fn open_count(&self) -> usize {
        self.0.lock().unwrap().sockets.len()
    }

    fn forget(&self, id: u32) {
        self.0.lock().unwrap().sockets.remove(&id);
    }
}

/// Never echoes the URL: it carries the ticket.
fn dial_error(error: &tungstenite::Error) -> String {
    match error {
        tungstenite::Error::Http(response) => format!(
            "The T3 machine refused the connection (HTTP {}).",
            response.status().as_u16()
        ),
        tungstenite::Error::Io(io) => format!("Cannot reach the T3 machine ({}).", io.kind()),
        tungstenite::Error::Tls(_) => "The T3 machine's TLS certificate was not accepted.".into(),
        _ => "Cannot open the connection to the T3 machine.".into(),
    }
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

/// Mints a ticket for a saved machine (checking it is still the same
/// machine), opens the RPC socket, and returns its id.
#[tauri::command]
pub async fn t3_socket_open(
    sockets: tauri::State<'_, T3Sockets>,
    id: String,
    on_frame: tauri::ipc::Channel<SocketEvent>,
) -> Result<u32, String> {
    let saved = crate::client_mode::blocking_store(move || crate::t3_client::find(&id)).await?;
    let ticket =
        crate::t3_client::mint_socket_url(crate::t3_client::http_client()?, &saved).await?;
    sockets
        .open(&ticket.url, move |event| {
            let _ = on_frame.send(event);
        })
        .await
}

#[tauri::command]
pub fn t3_socket_send(
    sockets: tauri::State<'_, T3Sockets>,
    socket_id: u32,
    text: String,
) -> Result<(), String> {
    sockets.send(socket_id, text)
}

#[tauri::command]
pub fn t3_socket_close(sockets: tauri::State<'_, T3Sockets>, socket_id: u32) {
    sockets.close(socket_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::UnboundedReceiver;

    /// Echoes text; "big" answers with a message over the cap; "bye" closes
    /// with 4001; "flood" never reads again (so writes back up).
    async fn echo_server() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/ws?wsTicket=t", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let config = WebSocketConfig {
                        max_message_size: Some(64 << 20),
                        max_frame_size: Some(64 << 20),
                        ..Default::default()
                    };
                    let Ok(mut ws) =
                        tokio_tungstenite::accept_async_with_config(stream, Some(config)).await
                    else {
                        return;
                    };
                    while let Some(Ok(message)) = ws.next().await {
                        match message {
                            Message::Text(text) if text == "big" => {
                                let _ = ws
                                    .send(Message::Text("x".repeat(MAX_MESSAGE_BYTES + 1)))
                                    .await;
                            }
                            Message::Text(text) if text == "bye" => {
                                let _ = ws
                                    .send(Message::Close(Some(CloseFrame {
                                        code: CloseCode::from(4001),
                                        reason: "done".into(),
                                    })))
                                    .await;
                            }
                            Message::Text(text) if text == "flood" => {
                                std::future::pending::<()>().await;
                            }
                            Message::Text(text) => {
                                let _ = ws.send(Message::Text(text)).await;
                            }
                            _ => {}
                        }
                    }
                });
            }
        });
        url
    }

    fn collector() -> (
        impl Fn(SocketEvent) + Send + Sync + 'static,
        UnboundedReceiver<SocketEvent>,
    ) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            move |event| {
                let _ = tx.send(event);
            },
            rx,
        )
    }

    async fn next(rx: &mut UnboundedReceiver<SocketEvent>) -> SocketEvent {
        tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("an event in time")
            .expect("the channel is open")
    }

    fn closed_code(event: &SocketEvent) -> u16 {
        match event {
            SocketEvent::Closed { code, .. } => *code,
            other => panic!("expected closed, got {other:?}"),
        }
    }

    #[test]
    fn t3_socket_events_have_distinct_envelopes() {
        let data = serde_json::to_value(SocketEvent::Message {
            data: r#"{"kind":"closed"}"#.into(),
        })
        .unwrap();
        assert_eq!(
            data,
            serde_json::json!({"kind":"message","data":"{\"kind\":\"closed\"}"})
        );
        let closed = serde_json::to_value(SocketEvent::Closed {
            code: 1000,
            reason: "r".into(),
        })
        .unwrap();
        assert_eq!(
            closed,
            serde_json::json!({"kind":"closed","code":1000,"reason":"r"})
        );
    }

    #[tokio::test]
    async fn t3_socket_forwards_sends_and_closes() {
        let url = echo_server().await;
        let sockets = T3Sockets::default();
        let (on_event, mut rx) = collector();
        let id = sockets.open(&url, on_event).await.unwrap();
        assert_eq!(sockets.open_count(), 1);
        sockets.send(id, r#"{"_tag":"Ping"}"#.into()).unwrap();
        sockets.send(id, "second".into()).unwrap();
        assert_eq!(
            next(&mut rx).await,
            SocketEvent::Message {
                data: r#"{"_tag":"Ping"}"#.into()
            }
        );
        assert_eq!(
            next(&mut rx).await,
            SocketEvent::Message {
                data: "second".into()
            }
        );
        sockets.close(id);
        assert_eq!(
            next(&mut rx).await,
            SocketEvent::Closed {
                code: 1000,
                reason: "Closed by Canopy".into()
            }
        );
        assert_eq!(sockets.open_count(), 0);
        assert!(sockets.send(id, "late".into()).is_err());
        // Nothing after the closed event.
        assert!(tokio::time::timeout(Duration::from_millis(200), rx.recv())
            .await
            .map_or(true, |event| event.is_none()),);
    }

    #[tokio::test]
    async fn t3_socket_reports_the_server_close() {
        let url = echo_server().await;
        let sockets = T3Sockets::default();
        let (on_event, mut rx) = collector();
        let id = sockets.open(&url, on_event).await.unwrap();
        sockets.send(id, "bye".into()).unwrap();
        assert_eq!(
            next(&mut rx).await,
            SocketEvent::Closed {
                code: 4001,
                reason: "done".into()
            }
        );
        assert_eq!(sockets.open_count(), 0);
    }

    #[tokio::test]
    async fn t3_socket_caps_message_size() {
        let url = echo_server().await;
        let sockets = T3Sockets::default();
        let (on_event, mut rx) = collector();
        let id = sockets.open(&url, on_event).await.unwrap();
        assert!(sockets.send(id, "y".repeat(MAX_MESSAGE_BYTES + 1)).is_err());
        sockets.send(id, "big".into()).unwrap();
        assert_eq!(closed_code(&next(&mut rx).await), TOO_BIG);
        assert_eq!(sockets.open_count(), 0);
    }

    #[tokio::test]
    async fn t3_socket_limits_open_sockets() {
        let url = echo_server().await;
        let sockets = T3Sockets::default();
        let mut ids = Vec::new();
        let mut receivers = Vec::new();
        for _ in 0..MAX_SOCKETS {
            let (on_event, rx) = collector();
            ids.push(sockets.open(&url, on_event).await.unwrap());
            receivers.push(rx);
        }
        let (on_event, _rx) = collector();
        let refused = sockets.open(&url, on_event).await.unwrap_err();
        assert!(refused.contains("Too many"), "{refused}");
        sockets.close(ids[0]);
        let (on_event, _rx) = collector();
        sockets.open(&url, on_event).await.unwrap();
        sockets.shutdown_all();
        assert_eq!(sockets.open_count(), 0);
        assert_eq!(closed_code(&next(&mut receivers[1]).await), 1001);
    }

    #[tokio::test]
    async fn t3_socket_send_fails_when_the_queue_is_full() {
        let url = echo_server().await;
        let sockets = T3Sockets::default();
        let (on_event, _rx) = collector();
        let id = sockets.open(&url, on_event).await.unwrap();
        sockets.send(id, "flood".into()).unwrap();
        // The server stops reading; TCP buffers fill, then the queue does.
        let chunk = "z".repeat(1 << 20);
        let mut refused = None;
        for _ in 0..(SEND_QUEUE * 64) {
            if let Err(error) = sockets.send(id, chunk.clone()) {
                refused = Some(error);
                break;
            }
            tokio::task::yield_now().await;
        }
        let refused = refused.expect("the queue fills");
        assert!(refused.contains("not keeping up"), "{refused}");
        sockets.close(id);
    }

    #[tokio::test]
    async fn t3_socket_refuses_other_schemes_and_hides_the_url() {
        let sockets = T3Sockets::default();
        let (on_event, _rx) = collector();
        assert!(sockets.open("http://127.0.0.1:1/", on_event).await.is_err());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let (on_event, _rx) = collector();
        let error = sockets
            .open(
                &format!("ws://127.0.0.1:{port}/ws?wsTicket=secret-ticket"),
                on_event,
            )
            .await
            .unwrap_err();
        assert!(!error.contains("secret-ticket"), "{error}");
        assert_eq!(sockets.open_count(), 0);
    }
}
