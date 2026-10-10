//! HTTP/1.1 over Unix sockets: serving the admin and agent routers, plus the
//! small clients the service and its tests need.

use axum::body::Bytes;
use axum::Router;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper_util::rt::TokioIo;
use hyper_util::service::TowerToHyperService;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::watch;
use tokio::task::{JoinHandle, JoinSet};

/// One listening socket. Closing it stops accepting, drops every open
/// connection (an agent blocked in an ask sees its socket close) and removes
/// the socket file — never its directory, which containers bind.
pub struct SocketServer {
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
    path: PathBuf,
}

impl SocketServer {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn close(self) {
        let _ = self.shutdown.send(true);
        let _ = self.task.await;
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Bind a socket at `path`, replacing only a stale socket file left by a
/// previous run. Anything else at that path is an error, not a casualty.
pub fn bind_unix(path: &Path, mode: u32) -> std::io::Result<UnixListener> {
    use std::os::unix::fs::FileTypeExt;
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if meta.file_type().is_socket() {
            std::fs::remove_file(path)?;
        } else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!("{} exists and is not a socket", path.display()),
            ));
        }
    }
    let listener = UnixListener::bind(path)?;
    crate::util::set_mode(path, mode)?;
    Ok(listener)
}

pub fn serve(listener: UnixListener, path: PathBuf, router: Router) -> SocketServer {
    let (shutdown, mut stop) = watch::channel(false);
    let task = tokio::spawn(async move {
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                _ = stop.changed() => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { continue };
                    let service = TowerToHyperService::new(router.clone());
                    connections.spawn(async move {
                        let _ = hyper::server::conn::http1::Builder::new()
                            .serve_connection(TokioIo::new(stream), service)
                            .await;
                    });
                }
                Some(_) = connections.join_next(), if !connections.is_empty() => {}
            }
        }
        connections.abort_all();
        while connections.join_next().await.is_some() {}
    });
    SocketServer {
        shutdown,
        task,
        path,
    }
}

/// Send one request over a Unix socket and return the response head with its
/// still-streaming body (the SSE stream is read this way).
pub async fn unix_open(
    socket: &Path,
    method: &str,
    uri: &str,
    headers: &[(&str, &str)],
    body: Option<Vec<u8>>,
) -> Result<hyper::Response<Incoming>, String> {
    let stream = UnixStream::connect(socket)
        .await
        .map_err(|e| format!("connect {}: {e}", socket.display()))?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|e| e.to_string())?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let mut request = hyper::Request::builder()
        .method(method)
        .uri(uri)
        .header("host", "localhost");
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    if body.is_some() {
        request = request.header("content-type", "application/json");
    }
    let request = request
        .body(Full::new(Bytes::from(body.unwrap_or_default())))
        .map_err(|e| e.to_string())?;
    sender
        .send_request(request)
        .await
        .map_err(|e| e.to_string())
}

pub async fn unix_request(
    socket: &Path,
    method: &str,
    uri: &str,
    headers: &[(&str, &str)],
    body: Option<Vec<u8>>,
) -> Result<(u16, Vec<u8>), String> {
    let response = unix_open(socket, method, uri, headers, body).await?;
    let status = response.status().as_u16();
    let bytes = response
        .into_body()
        .collect()
        .await
        .map_err(|e| e.to_string())?
        .to_bytes();
    Ok((status, bytes.to_vec()))
}

/// A blocking JSON POST over plain HTTP. Terminal writes go through the sync
/// `canopy_core::terminals::Terminals` contract, so they cannot await; the
/// runner is a host-local `http://` endpoint and every call is deadline-bound.
pub fn blocking_post(
    base: &str,
    path: &str,
    token: Option<&str>,
    body: &[u8],
    timeout: Duration,
) -> Result<(u16, String), String> {
    use std::io::{Read, Write};
    let rest = base
        .strip_prefix("http://")
        .ok_or_else(|| format!("runner url {base} is not http://"))?;
    let (authority, prefix) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].trim_end_matches('/')),
        None => (rest, ""),
    };
    let address = if authority.contains(':') {
        authority.to_string()
    } else {
        format!("{authority}:80")
    };
    let socket = std::net::ToSocketAddrs::to_socket_addrs(&address)
        .map_err(|e| e.to_string())?
        .next()
        .ok_or("runner address did not resolve")?;
    let mut stream =
        std::net::TcpStream::connect_timeout(&socket, timeout).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(timeout))
        .and_then(|_| stream.set_write_timeout(Some(timeout)))
        .map_err(|e| e.to_string())?;
    let mut head = format!(
        "POST {prefix}{path} HTTP/1.1\r\nHost: {authority}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    if let Some(token) = token {
        head.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    head.push_str("\r\n");
    stream
        .write_all(head.as_bytes())
        .and_then(|_| stream.write_all(body))
        .map_err(|e| e.to_string())?;
    let mut response = Vec::new();
    stream
        .take(1024 * 1024)
        .read_to_end(&mut response)
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&response);
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or("runner sent no HTTP status")?;
    let payload = text
        .split_once("\r\n\r\n")
        .map(|(_, rest)| rest.to_string())
        .unwrap_or_default();
    Ok((status, payload))
}
