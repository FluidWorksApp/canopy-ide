//! Preview proxy: the in-app browser's window onto a locally running server.
//!
//! The preview tab renders pages in an <iframe>, but a cross-origin iframe's
//! DOM is sealed off from the app — no element picker, no annotation overlay.
//! So instead of pointing the iframe at the dev server directly, each previewed
//! origin gets a tiny loopback reverse proxy that forwards everything to the
//! target and injects `preview_picker.js` into HTML responses. The injected
//! script runs *inside* the page, so it can highlight and describe any element,
//! and it talks to the app via `postMessage` — which crosses origins by design.
//!
//! WebSocket upgrades (Vite/webpack HMR) are tunnelled as raw bytes: the
//! client's own Sec-WebSocket-Key is forwarded upstream, so the upstream 101
//! response is valid for the client verbatim and no frame parsing is needed.
//!
//! One proxy per target origin, bound to 127.0.0.1 on an ephemeral port,
//! reused across tabs and torn down with the app.

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use axum::Router;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const PICKER_JS: &str = include_str!("preview_picker.js");
/// Path the injected <script> tag loads from — reserved, never proxied.
const PICKER_PATH: &str = "/__canopy__/picker.js";
/// Request bodies are buffered to forward; cap so a runaway upload can't OOM.
const MAX_BODY: usize = 64 * 1024 * 1024;

/// One proxied request, as the canopy_browser_network tool reports it.
type NetLog = Arc<Mutex<std::collections::VecDeque<serde_json::Value>>>;
/// Entries kept per origin; old ones roll off.
const NET_LOG_CAP: usize = 300;

struct ProxyCtx {
    /// Target origin, e.g. `http://localhost:5173` — scheme + authority only.
    origin: String,
    /// Just the authority (`localhost:5173`), for Host headers and TCP dials.
    authority: String,
    client: reqwest::Client,
    /// Rolling log of proxied requests — the proxy sees every request the page
    /// makes, so agents get a network tab without instrumenting the page.
    log: NetLog,
}

struct RunningProxy {
    port: u16,
    shutdown: tokio::sync::watch::Sender<bool>,
    log: NetLog,
}

#[derive(Default)]
pub struct PreviewManager {
    /// Keyed by target origin so two tabs previewing the same server share one
    /// proxy. Cheap enough to keep until app exit.
    proxies: Mutex<HashMap<String, RunningProxy>>,
}

impl PreviewManager {
    pub fn shutdown_all(&self) {
        for (_, p) in self.proxies.lock().unwrap().drain() {
            let _ = p.shutdown.send(true);
        }
    }

    /// The recent requests each running proxy forwarded, newest last. With an
    /// origin, just that origin's log (None if it has no proxy); without, every
    /// origin's. Serves the canopy_browser_network MCP tool.
    pub fn network_log(&self, origin: Option<&str>, limit: usize) -> Option<serde_json::Value> {
        let proxies = self.proxies.lock().unwrap();
        let mut origins: Vec<(&String, &RunningProxy)> = match origin {
            Some(o) => vec![proxies.get_key_value(o)?],
            None => proxies.iter().collect(),
        };
        origins.sort_by(|a, b| a.0.cmp(b.0));
        let out: Vec<serde_json::Value> = origins
            .into_iter()
            .map(|(origin, p)| {
                let log = p.log.lock().unwrap();
                let skip = log.len().saturating_sub(limit);
                serde_json::json!({
                    "origin": origin,
                    "requests": log.iter().skip(skip).collect::<Vec<_>>(),
                })
            })
            .collect();
        Some(serde_json::json!(out))
    }

    /// The origins that currently have a proxy running — for error messages.
    pub fn origins(&self) -> Vec<String> {
        let mut v: Vec<String> = self.proxies.lock().unwrap().keys().cloned().collect();
        v.sort();
        v
    }
}

#[derive(serde::Serialize, Clone)]
pub struct PreviewInfo {
    pub port: u16,
    pub origin: String,
}

/// `http://host:port[/...]` → (origin, authority). No url crate: the accepted
/// shapes are narrow enough that trimming is clearer than a dependency.
fn parse_target(target: &str) -> Result<(String, String), String> {
    let t = target.trim();
    let rest = t
        .strip_prefix("http://")
        .ok_or("Preview targets must be http:// URLs on this machine")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("").to_string();
    if authority.is_empty() {
        return Err(format!("Not a valid URL: {t}"));
    }
    Ok((format!("http://{authority}"), authority))
}

#[tauri::command]
pub async fn preview_start(
    state: tauri::State<'_, PreviewManager>,
    target: String,
) -> Result<PreviewInfo, String> {
    let (origin, authority) = parse_target(&target)?;
    {
        let guard = state.proxies.lock().unwrap();
        if let Some(p) = guard.get(&origin) {
            return Ok(PreviewInfo {
                port: p.port,
                origin,
            });
        }
    }

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let log: NetLog = Arc::default();
    let ctx = Arc::new(ProxyCtx {
        origin: origin.clone(),
        authority,
        client,
        log: log.clone(),
    });

    let router = Router::new().fallback(proxy_handler).with_state(ctx);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("preview: cannot bind: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let (sd_tx, mut sd_rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        let shutdown = async move {
            while sd_rx.changed().await.is_ok() {
                if *sd_rx.borrow() {
                    break;
                }
            }
        };
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(shutdown)
            .await;
    });

    let mut guard = state.proxies.lock().unwrap();
    // Two tabs racing to start the same origin: keep the first, drop ours.
    if let Some(existing) = guard.get(&origin) {
        let _ = sd_tx.send(true);
        return Ok(PreviewInfo {
            port: existing.port,
            origin,
        });
    }
    guard.insert(
        origin.clone(),
        RunningProxy {
            port,
            shutdown: sd_tx,
            log,
        },
    );
    Ok(PreviewInfo { port, origin })
}

#[tauri::command]
pub async fn preview_stop(
    state: tauri::State<'_, PreviewManager>,
    origin: String,
) -> Result<(), String> {
    if let Some(p) = state.proxies.lock().unwrap().remove(&origin) {
        let _ = p.shutdown.send(true);
    }
    Ok(())
}

/// Hop-by-hop headers never forwarded in either direction (RFC 7230 §6.1),
/// plus the ones the proxy itself owns.
fn hop_by_hop(name: &str) -> bool {
    matches!(
        name,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

async fn proxy_handler(State(ctx): State<Arc<ProxyCtx>>, req: Request) -> Response {
    if req.uri().path() == PICKER_PATH {
        return Response::builder()
            .header(header::CONTENT_TYPE, "text/javascript; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(PICKER_JS))
            .unwrap();
    }
    let method = req.method().to_string();
    let path = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| "/".into());
    let started = std::time::Instant::now();
    if is_upgrade(req.headers()) {
        let resp = tunnel_upgrade(ctx.clone(), req).await.unwrap_or_else(|e| {
            plain(
                StatusCode::BAD_GATEWAY,
                format!("Canopy preview: websocket tunnel failed: {e}"),
            )
        });
        record_request(&ctx, &method, &path, &resp, started, true);
        return resp;
    }
    let resp = forward_http(ctx.clone(), req).await.unwrap_or_else(|e| {
        plain(
            StatusCode::BAD_GATEWAY,
            format!("Canopy preview: the server didn't answer: {e}\n\nIs it still running?"),
        )
    });
    record_request(&ctx, &method, &path, &resp, started, false);
    resp
}

/// Append one request to the origin's rolling network log.
fn record_request(
    ctx: &ProxyCtx,
    method: &str,
    path: &str,
    resp: &Response,
    started: std::time::Instant,
    websocket: bool,
) {
    let mut entry = serde_json::json!({
        "ts": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        "method": method,
        "path": path,
        "status": resp.status().as_u16(),
        "ms": started.elapsed().as_millis() as u64,
    });
    if websocket {
        entry["websocket"] = serde_json::json!(true);
    }
    if let Some(ct) = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
    {
        entry["contentType"] = serde_json::json!(ct.split(';').next().unwrap_or(ct));
    }
    if let Some(len) = resp
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
    {
        entry["bytes"] = serde_json::json!(len);
    }
    let mut log = ctx.log.lock().unwrap();
    log.push_back(entry);
    while log.len() > NET_LOG_CAP {
        log.pop_front();
    }
}

fn plain(status: StatusCode, msg: String) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(msg))
        .unwrap()
}

fn is_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

async fn forward_http(ctx: Arc<ProxyCtx>, req: Request) -> Result<Response, String> {
    let (parts, body) = req.into_parts();
    let pq = parts
        .uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/");
    let url = format!("{}{}", ctx.origin, pq);

    let method =
        reqwest::Method::from_bytes(parts.method.as_str().as_bytes()).map_err(|e| e.to_string())?;
    let mut rb = ctx.client.request(method, &url);
    for (name, value) in parts.headers.iter() {
        let n = name.as_str();
        // accept-encoding is dropped so the upstream answers uncompressed and
        // HTML is injectable without a gzip stack. host is rewritten.
        if hop_by_hop(n) || n == "host" || n == "accept-encoding" || n == "content-length" {
            continue;
        }
        rb = rb.header(name, value);
    }
    if parts.method != Method::GET && parts.method != Method::HEAD {
        let bytes = axum::body::to_bytes(body, MAX_BODY)
            .await
            .map_err(|e| e.to_string())?;
        rb = rb.body(bytes);
    }

    let upstream = rb.send().await.map_err(|e| e.to_string())?;
    let status = upstream.status();
    let mut builder = Response::builder().status(status.as_u16());
    let is_html = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains("text/html"));
    for (name, value) in upstream.headers().iter() {
        let n = name.as_str();
        // The page must be embeddable and the injected script must run: the
        // frame/CSP headers a dev server sends are dropped on the proxied copy.
        if hop_by_hop(n)
            || n == "content-security-policy"
            || n == "content-security-policy-report-only"
            || n == "x-frame-options"
            || (is_html && n == "content-length")
        {
            continue;
        }
        builder = builder.header(name, value);
    }

    if is_html {
        let bytes = upstream.bytes().await.map_err(|e| e.to_string())?;
        let html = inject_picker(&bytes);
        return builder.body(Body::from(html)).map_err(|e| e.to_string());
    }
    builder
        .body(Body::from_stream(upstream.bytes_stream()))
        .map_err(|e| e.to_string())
}

/// Add the picker <script> to an HTML document — right after <head> opens, so
/// its console capture is ahead of the app's own (deferred/module) scripts in
/// the execution order; else before </head> / </body>, else appended (fragment
/// responses).
fn inject_picker(bytes: &[u8]) -> Vec<u8> {
    let tag = format!(r#"<script src="{PICKER_PATH}" defer></script>"#);
    let html = String::from_utf8_lossy(bytes);
    let lower = html.to_lowercase();
    // After the `>` of the opening <head ...> tag, if there is one.
    let head_open = lower.find("<head").and_then(|i| {
        let close = lower[i..].find('>')?;
        // Not </head> or <header>: the char after "<head" must end the tag or
        // start an attribute list.
        match lower.as_bytes().get(i + 5) {
            Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r') => {
                Some(i + close + 1)
            }
            _ => None,
        }
    });
    let insert_at = head_open
        .or_else(|| lower.find("</head>"))
        .or_else(|| lower.find("</body>"));
    let mut out = String::with_capacity(html.len() + tag.len());
    match insert_at {
        Some(i) => {
            out.push_str(&html[..i]);
            out.push_str(&tag);
            out.push_str(&html[i..]);
        }
        None => {
            out.push_str(&html);
            out.push_str(&tag);
        }
    }
    out.into_bytes()
}

/// Raw byte tunnel for WebSocket upgrades. The original request — client key
/// and subprotocols included — is replayed upstream verbatim, the upstream 101
/// is replayed back verbatim, then both sockets are spliced. The proxy never
/// parses a WS frame, so any subprotocol (vite-hmr, socket.io, ...) survives.
async fn tunnel_upgrade(ctx: Arc<ProxyCtx>, mut req: Request) -> Result<Response, String> {
    let on_upgrade = req
        .extensions_mut()
        .remove::<hyper::upgrade::OnUpgrade>()
        .ok_or("no upgrade extension")?;

    let pq = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/")
        .to_string();
    let mut head = format!("GET {pq} HTTP/1.1\r\nHost: {}\r\n", ctx.authority);
    for (name, value) in req.headers() {
        if name.as_str() == "host" {
            continue;
        }
        if let Ok(v) = value.to_str() {
            head.push_str(&format!("{name}: {v}\r\n"));
        }
    }
    head.push_str("\r\n");

    let mut upstream = tokio::net::TcpStream::connect(&ctx.authority)
        .await
        .map_err(|e| e.to_string())?;
    upstream
        .write_all(head.as_bytes())
        .await
        .map_err(|e| e.to_string())?;

    // Read the upstream response head (through the blank line); anything past
    // it is already websocket payload and must reach the client first.
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    while !buf.ends_with(b"\r\n\r\n") {
        let n = upstream.read(&mut byte).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("upstream closed during handshake".into());
        }
        buf.push(byte[0]);
        if buf.len() > 64 * 1024 {
            return Err("oversized upstream handshake".into());
        }
    }
    let head_text = String::from_utf8_lossy(&buf);
    let mut lines = head_text.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or("bad upstream status line")?;
    if status != 101 {
        return Err(format!("upstream refused upgrade: {status_line}"));
    }

    let mut builder = Response::builder().status(StatusCode::SWITCHING_PROTOCOLS);
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if let Ok(v) = HeaderValue::from_str(value.trim()) {
                builder = builder.header(name.trim(), v);
            }
        }
    }

    tokio::spawn(async move {
        let Ok(upgraded) = on_upgrade.await else {
            return;
        };
        let mut client = hyper_util::rt::TokioIo::new(upgraded);
        let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
    });

    builder.body(Body::empty()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_target_accepts_origin_and_paths() {
        assert_eq!(
            parse_target("http://localhost:5173").unwrap(),
            ("http://localhost:5173".into(), "localhost:5173".into())
        );
        assert_eq!(
            parse_target(" http://127.0.0.1:3000/app?x=1 ").unwrap().0,
            "http://127.0.0.1:3000"
        );
        assert!(parse_target("https://example.com").is_err());
        assert!(parse_target("localhost:3000").is_err());
        assert!(parse_target("http://").is_err());
    }

    #[test]
    fn inject_prefers_head_start_then_body_then_appends() {
        // At the top of <head>: the console hook must beat the app's scripts.
        let head = inject_picker(b"<html><head><title>t</title></head><body></body></html>");
        let head = String::from_utf8(head).unwrap();
        assert!(head.contains(&format!(
            r#"<head><script src="{PICKER_PATH}" defer></script><title>"#
        )));

        let attrs = inject_picker(b"<html><head data-x=\"1\"><script>app()</script></head></html>");
        let attrs = String::from_utf8(attrs).unwrap();
        assert!(attrs.contains(&format!(
            r#"<head data-x="1"><script src="{PICKER_PATH}" defer></script><script>app()"#
        )));

        let body = inject_picker(b"<html><body>hi</body></html>");
        let body = String::from_utf8(body).unwrap();
        assert!(body.contains(r#"defer></script></body>"#));

        // <header> alone must not fool the head-open matcher.
        let hdr = String::from_utf8(inject_picker(b"<header>x</header>")).unwrap();
        assert!(hdr.starts_with("<header>x</header>"));
        assert!(hdr.ends_with("</script>"));

        let frag = String::from_utf8(inject_picker(b"<div>x</div>")).unwrap();
        assert!(frag.ends_with("</script>"));
        assert!(frag.starts_with("<div>"));
    }

    #[test]
    fn hop_by_hop_headers_are_stripped() {
        assert!(hop_by_hop("transfer-encoding"));
        assert!(hop_by_hop("connection"));
        assert!(!hop_by_hop("content-type"));
        assert!(!hop_by_hop("set-cookie"));
    }

    /// Full loop: a real upstream server behind a real proxy router. HTML gets
    /// the picker injected and its frame-blocking headers dropped; non-HTML
    /// streams through untouched; the picker path serves the script itself.
    #[tokio::test]
    async fn proxies_and_injects_against_live_upstream() {
        use axum::routing::get;

        let upstream = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let upstream_port = upstream.local_addr().unwrap().port();
        let app = Router::new()
            .route(
                "/",
                get(|| async {
                    Response::builder()
                        .header("content-type", "text/html")
                        .header("x-frame-options", "DENY")
                        .header("content-security-policy", "frame-ancestors 'none'")
                        .body(Body::from("<html><head></head><body>hi</body></html>"))
                        .unwrap()
                }),
            )
            .route("/data", get(|| async { r#"{"ok":true}"# }));
        tokio::spawn(async move { axum::serve(upstream, app).await.unwrap() });

        let ctx = Arc::new(ProxyCtx {
            origin: format!("http://127.0.0.1:{upstream_port}"),
            authority: format!("127.0.0.1:{upstream_port}"),
            client: reqwest::Client::new(),
            log: NetLog::default(),
        });
        let net_log = ctx.log.clone();
        let proxy = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let proxy_port = proxy.local_addr().unwrap().port();
        let router = Router::new().fallback(proxy_handler).with_state(ctx);
        tokio::spawn(async move { axum::serve(proxy, router).await.unwrap() });

        let client = reqwest::Client::new();
        let base = format!("http://127.0.0.1:{proxy_port}");

        let html = client.get(&base).send().await.unwrap();
        assert!(html.headers().get("x-frame-options").is_none());
        assert!(html.headers().get("content-security-policy").is_none());
        let body = html.text().await.unwrap();
        assert!(body.contains(PICKER_PATH), "picker not injected: {body}");

        let data = client.get(format!("{base}/data")).send().await.unwrap();
        assert_eq!(data.text().await.unwrap(), r#"{"ok":true}"#);

        let picker = client
            .get(format!("{base}{PICKER_PATH}"))
            .send()
            .await
            .unwrap();
        assert!(picker.text().await.unwrap().contains("__canopyPicker"));

        let missing = client.get(format!("{base}/nope")).send().await.unwrap();
        assert_eq!(missing.status(), 404);

        // Every proxied request landed in the network log; the picker's own
        // script fetch did not.
        let log = net_log.lock().unwrap();
        let paths: Vec<&str> = log.iter().filter_map(|e| e["path"].as_str()).collect();
        assert_eq!(paths, vec!["/", "/data", "/nope"]);
        assert_eq!(log[1]["status"], 200);
        assert_eq!(log[2]["status"], 404);
        assert!(log[0]["ms"].is_u64());
    }
}
