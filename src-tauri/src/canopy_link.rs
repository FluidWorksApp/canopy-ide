//! Canopy link: the portal reached at `https://<handle>.remote.canopyide.dev`
//! through Canopy's own edge, instead of a Cloudflare/ngrok/Tailscale tunnel.
//!
//! The desktop dials out (no port forward): it asks canopyide.dev for a
//! five-minute tunnel token with the account's device credential, opens one
//! WebSocket to the edge, and the edge multiplexes every browser connection
//! down it as a numbered stream. Each stream is one raw HTTP/1.1 connection,
//! served here by the portal's own axum router — so the portal needs no
//! special routes for this, and WebSocket upgrades work unchanged.
//!
//! Frames (binary): `[type:u8][stream:u32 BE][payload]` — OPEN 0x01 (edge →
//! here, JSON `{"auth":"owner"|"none"}`), DATA 0x02, END 0x03 (half-close),
//! RESET 0x04. A stream the edge opened as `owner` has already passed the
//! person's Canopy sign-in at the edge, so it carries `EdgeAuth { owner: true }`
//! and the portal skips its PIN. `/team/ws` arrives as `none`: it keeps its own
//! SPAKE2 join code. No per-stream flow control in v1 — WebSocket backpressure
//! only, so one slow stream can stall the others.

use crate::portal::EdgeAuth;
use crate::tunnel::TunnelState;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, WriteHalf};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, Message};

pub const PROVIDER: &str = "canopy";

const OPEN: u8 = 0x01;
const DATA: u8 = 0x02;
const END: u8 = 0x03;
const RESET: u8 = 0x04;
/// The edge closes an older connection for the same link with this code when
/// another computer signs in to it.
const REPLACED: u16 = 4001;
const STREAM_BUFFER: usize = 64 * 1024;
const READ_CHUNK: usize = 16 * 1024;
const PING_EVERY: Duration = Duration::from_secs(20);

pub(crate) fn frame(kind: u8, stream: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.push(kind);
    out.extend_from_slice(&stream.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

pub(crate) fn parse(bytes: &[u8]) -> Option<(u8, u32, &[u8])> {
    if bytes.len() < 5 {
        return None;
    }
    let stream = u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
    Some((bytes[0], stream, &bytes[5..]))
}

/// Backoff before reconnect attempt `n` (0-based): 1s doubling to 30s, plus up
/// to a quarter of jitter so a fleet of laptops waking together spreads out.
pub(crate) fn backoff(n: u32, jitter: f64) -> Duration {
    let base = (1u64 << n.min(5)).min(30) as f64;
    Duration::from_secs_f64(base + base * 0.25 * jitter.clamp(0.0, 1.0))
}

/// What canopyide.dev answered for a tunnel token.
#[derive(Debug, PartialEq)]
pub(crate) struct Grant {
    pub url: String,
    pub tunnel: String,
    pub token: String,
}

pub(crate) fn grant_from(value: &Value) -> Result<Grant, String> {
    let field = |name: &str| {
        value
            .get(name)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    match (field("url"), field("tunnel"), field("token")) {
        (Some(url), Some(tunnel), Some(token))
            if url.starts_with("https://") && tunnel.starts_with("wss://") =>
        {
            Ok(Grant { url, tunnel, token })
        }
        _ => Err("Canopy returned an invalid remote link".into()),
    }
}

async fn fetch_grant() -> Result<Grant, String> {
    let value = crate::client_mode::canopy_account_request(
        "/api/remote".into(),
        Some(serde_json::json!({ "action": "tunnel-token" })),
        None,
    )
    .await?;
    grant_from(&value)
}

fn publish(
    app: &AppHandle,
    last: &Arc<Mutex<TunnelState>>,
    url: Option<String>,
    message: Option<String>,
    running: bool,
) {
    let state = TunnelState {
        running,
        provider: Some(PROVIDER.into()),
        url,
        message,
    };
    *last.lock().unwrap() = state.clone();
    let _ = app.emit("tunnel:state", state);
}

/// Keep the link up until `stop` flips: fetch a token, connect, serve, and on
/// any drop reconnect with backoff. A link taken over by another computer, or
/// an account that can't have one, ends the loop with the reason shown.
pub fn spawn(app: AppHandle, last: Arc<Mutex<TunnelState>>, mut stop: watch::Receiver<bool>) {
    tauri::async_runtime::spawn(async move {
        let mut attempt = 0u32;
        let mut url: Option<String> = None;
        loop {
            if *stop.borrow() {
                return;
            }
            let outcome = match fetch_grant().await {
                Ok(grant) => {
                    url = Some(grant.url.clone());
                    publish(&app, &last, url.clone(), Some("Connecting…".into()), true);
                    run_once(&app, &last, &grant, &mut stop, &mut attempt).await
                }
                Err(error) => Outcome::Fatal(error),
            };
            match outcome {
                Outcome::Stopped => return,
                Outcome::Fatal(message) => {
                    publish(&app, &last, None, Some(message), false);
                    return;
                }
                Outcome::Retry(message) => {
                    let wait = backoff(attempt, rand_unit());
                    attempt = attempt.saturating_add(1);
                    publish(&app, &last, url.clone(), Some(message), true);
                    tokio::select! {
                        _ = tokio::time::sleep(wait) => {}
                        _ = stop.changed() => return,
                    }
                }
            }
        }
    });
}

fn rand_unit() -> f64 {
    let mut b = [0u8; 2];
    let _ = getrandom::getrandom(&mut b);
    u16::from_le_bytes(b) as f64 / u16::MAX as f64
}

enum Outcome {
    Stopped,
    Retry(String),
    Fatal(String),
}

type Streams = Arc<Mutex<HashMap<u32, WriteHalf<DuplexStream>>>>;

async fn run_once(
    app: &AppHandle,
    last: &Arc<Mutex<TunnelState>>,
    grant: &Grant,
    stop: &mut watch::Receiver<bool>,
    attempt: &mut u32,
) -> Outcome {
    let Some(router) = crate::portal::portal_router(app) else {
        return Outcome::Fatal("Remote access is off.".into());
    };
    let mut request = match grant.tunnel.as_str().into_client_request() {
        Ok(request) => request,
        Err(_) => return Outcome::Fatal("Canopy returned an invalid remote link".into()),
    };
    let Ok(bearer) = format!("Bearer {}", grant.token).parse() else {
        return Outcome::Fatal("Canopy returned an invalid remote link".into());
    };
    request.headers_mut().insert("authorization", bearer);
    let socket = match tokio_tungstenite::connect_async(request).await {
        Ok((socket, _)) => socket,
        Err(tungstenite::Error::Http(response)) if response.status() == 401 => {
            return Outcome::Retry("Canopy's edge refused the link token. Trying again…".into())
        }
        Err(error) => {
            return Outcome::Retry(format!(
                "Can't reach Canopy's edge ({error}). Trying again…"
            ))
        }
    };
    *attempt = 0;
    publish(app, last, Some(grant.url.clone()), None, true);

    let (mut sink, mut source) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<Message>(256);
    let writer = tokio::spawn(async move {
        while let Some(message) = out_rx.recv().await {
            if sink.send(message).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    let streams: Streams = Default::default();
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await;

    let outcome = loop {
        tokio::select! {
            _ = stop.changed() => {
                if *stop.borrow() { break Outcome::Stopped; }
            }
            _ = ping.tick() => {
                if out_tx.send(Message::Ping(Vec::new())).await.is_err() {
                    break Outcome::Retry("Lost the connection to Canopy's edge. Reconnecting…".into());
                }
            }
            message = source.next() => match message {
                Some(Ok(Message::Binary(bytes))) => handle_frame(&bytes, &router, &streams, &out_tx).await,
                Some(Ok(Message::Close(Some(close)))) if u16::from(close.code) == REPLACED => {
                    break Outcome::Fatal("Another computer took over your Canopy link. Turn remote access on again here to take it back.".into());
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                    break Outcome::Retry("Lost the connection to Canopy's edge. Reconnecting…".into());
                }
                Some(Ok(_)) => {}
            }
        }
    };
    streams.lock().unwrap().clear();
    drop(out_tx);
    let _ = writer.await;
    outcome
}

async fn handle_frame(
    bytes: &[u8],
    router: &axum::Router,
    streams: &Streams,
    out: &mpsc::Sender<Message>,
) {
    let Some((kind, id, payload)) = parse(bytes) else {
        return;
    };
    match kind {
        OPEN => {
            let owner = serde_json::from_slice::<Value>(payload)
                .ok()
                .and_then(|v| v.get("auth").and_then(Value::as_str).map(|a| a == "owner"))
                .unwrap_or(false);
            open_stream(
                id,
                EdgeAuth { owner },
                router.clone(),
                streams.clone(),
                out.clone(),
            );
        }
        DATA => {
            // Take the writer out while writing so the lock never spans an await.
            let writer = streams.lock().unwrap().remove(&id);
            if let Some(mut writer) = writer {
                if writer.write_all(payload).await.is_ok() {
                    streams.lock().unwrap().insert(id, writer);
                } else {
                    let _ = out.send(Message::Binary(frame(RESET, id, &[]))).await;
                }
            }
        }
        END => {
            let writer = streams.lock().unwrap().remove(&id);
            if let Some(mut writer) = writer {
                let _ = writer.shutdown().await;
            }
        }
        RESET => {
            streams.lock().unwrap().remove(&id);
        }
        _ => {}
    }
}

/// One browser connection: an in-memory pipe whose far end is served by the
/// portal router, the near end pumped to and from the tunnel.
fn open_stream(
    id: u32,
    auth: EdgeAuth,
    router: axum::Router,
    streams: Streams,
    out: mpsc::Sender<Message>,
) {
    let (near, far) = tokio::io::duplex(STREAM_BUFFER);
    let (mut read, write) = tokio::io::split(near);
    streams.lock().unwrap().insert(id, write);

    tokio::spawn(async move {
        let service =
            hyper_util::service::TowerToHyperService::new(router.layer(axum::Extension(auth)));
        let _ = hyper::server::conn::http1::Builder::new()
            .serve_connection(hyper_util::rt::TokioIo::new(far), service)
            .with_upgrades()
            .await;
    });

    tokio::spawn(async move {
        let mut buf = vec![0u8; READ_CHUNK];
        loop {
            match read.read(&mut buf).await {
                Ok(0) => {
                    let _ = out.send(Message::Binary(frame(END, id, &[]))).await;
                    break;
                }
                Ok(n) => {
                    if out
                        .send(Message::Binary(frame(DATA, id, &buf[..n])))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => {
                    let _ = out.send(Message::Binary(frame(RESET, id, &[]))).await;
                    break;
                }
            }
        }
        streams.lock().unwrap().remove(&id);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        let bytes = frame(DATA, 7, b"hello");
        assert_eq!(bytes[..5], [DATA, 0, 0, 0, 7]);
        assert_eq!(parse(&bytes), Some((DATA, 7, &b"hello"[..])));
        assert_eq!(parse(&[1, 0, 0]), None);
        assert_eq!(
            parse(&frame(END, u32::MAX, &[])),
            Some((END, u32::MAX, &[][..]))
        );
    }

    #[test]
    fn backoff_grows_to_thirty_seconds_with_bounded_jitter() {
        assert_eq!(backoff(0, 0.0), Duration::from_secs(1));
        assert_eq!(backoff(1, 0.0), Duration::from_secs(2));
        assert_eq!(backoff(9, 0.0), Duration::from_secs(30));
        assert!(backoff(9, 1.0) <= Duration::from_secs_f64(37.5));
    }

    /// A browser request framed by the edge reaches the router with the
    /// stream's EdgeAuth attached, and its response comes back as DATA then END.
    #[tokio::test]
    async fn serves_a_framed_request_through_the_router() {
        use axum::routing::get;
        let router = axum::Router::new().route(
            "/who",
            get(|edge: Option<axum::Extension<EdgeAuth>>| async move {
                if edge.is_some_and(|e| e.owner) {
                    "owner"
                } else {
                    "anonymous"
                }
            }),
        );
        let streams: Streams = Default::default();
        let (out, mut frames) = mpsc::channel::<Message>(64);
        handle_frame(
            &frame(OPEN, 1, br#"{"auth":"owner"}"#),
            &router,
            &streams,
            &out,
        )
        .await;
        handle_frame(
            &frame(
                DATA,
                1,
                b"GET /who HTTP/1.1\r\nHost: vj.remote.test\r\nConnection: close\r\n\r\n",
            ),
            &router,
            &streams,
            &out,
        )
        .await;
        let mut body = Vec::new();
        let mut ended = false;
        while let Ok(Some(Message::Binary(bytes))) =
            tokio::time::timeout(Duration::from_secs(5), frames.recv()).await
        {
            let (kind, id, payload) = parse(&bytes).unwrap();
            assert_eq!(id, 1);
            match kind {
                DATA => body.extend_from_slice(payload),
                END => {
                    ended = true;
                    break;
                }
                other => panic!("unexpected frame {other}"),
            }
        }
        let text = String::from_utf8(body).unwrap();
        assert!(text.starts_with("HTTP/1.1 200"), "{text}");
        assert!(text.ends_with("owner"), "{text}");
        assert!(ended);
    }

    #[test]
    fn grants_need_https_and_wss() {
        let ok = serde_json::json!({"url":"https://vj.remote.canopyide.dev","tunnel":"wss://edge.remote.canopyide.dev/v1/tunnel","token":"t"});
        assert_eq!(
            grant_from(&ok).unwrap().url,
            "https://vj.remote.canopyide.dev"
        );
        let insecure = serde_json::json!({"url":"http://vj.remote.canopyide.dev","tunnel":"wss://edge/v1/tunnel","token":"t"});
        assert!(grant_from(&insecure).is_err());
        assert!(grant_from(&serde_json::json!({"url":"https://x","tunnel":"wss://y"})).is_err());
    }
}
