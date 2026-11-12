//! Session protocol v1: what rides on an authenticated [`Connection`] once a
//! transport has proved who the peer is.
//!
//! Framing is the pty-host's: one JSON line, then (after `attach` only) raw
//! bytes both ways. A connection starts with `hello`, which checks the protocol
//! version both ways, and then either stays a *control* connection (`list`,
//! `resize`, any number of them, one reply line each) or becomes an *attached*
//! connection with `attach{id}`: the reply line, then the terminal's output
//! (its snapshot first, then live bytes) one way and the peer's keystrokes the
//! other. `resize` cannot travel on an attached connection (it carries raw
//! bytes), so a client resizes over a control connection.
//!
//! Deliberately absent: spawn, kill, environment, working directory and ring
//! reads. A peer can see and type into terminals that already exist and nothing
//! else. (Typing into a shell is still a shell as the host user, so the
//! transport's allowlist is the real gate, see DESIGN.md.)
//!
//! The crate has no JSON dependency: requests and replies are encoded by hand
//! here and decoded with the crate's strict parser. Unknown fields are ignored
//! so a newer peer can add fields without a version bump.
//!
//! Server side: implement [`SessionHandler`] and run [`serve_connection`] on one
//! thread per accepted connection. Client side: [`SessionClient::connect`] on a
//! dialed connection. Every bound is in [`ServeLimits`] or a constant below.

use crate::json::{self, Json};
use crate::{Connection, PeerIdentity};
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

/// The version this build speaks. Bumped when the wire changes in a way an old
/// peer would misread.
pub const PROTOCOL_VERSION: u32 = 1;
/// The oldest peer this build will serve (as server) or use (as client).
pub const MIN_PEER_VERSION: u32 = 1;
/// Longest request or reply line, in bytes, same as the pty-host's.
pub const MAX_LINE: usize = 1024 * 1024;
/// How long a new connection has to send a complete `hello`.
pub const HELLO_DEADLINE: Duration = Duration::from_secs(5);
/// How long a control connection may sit with no request.
pub const IDLE_DEADLINE: Duration = Duration::from_secs(60);
/// Minimum spacing of accepted `resize` requests on one connection.
pub const RESIZE_INTERVAL: Duration = Duration::from_millis(100);
/// Input chunks queued between the socket and the handler. Past this the server
/// stops reading the socket, so a flood waits in the peer's TCP buffer.
pub const INPUT_QUEUE: usize = 32;
/// Largest input chunk handed to [`SessionHandler::write`].
pub const INPUT_CHUNK: usize = 16 * 1024;
/// Most sessions one `list` reply carries. With [`MAX_TEXT_CHARS`] this keeps a
/// worst-case reply well inside [`MAX_LINE`].
pub const MAX_LISTED: usize = 256;
/// Longest title, cwd or command in a `list` reply, in characters. Longer values
/// are cut.
pub const MAX_TEXT_CHARS: usize = 160;
/// How long a client waits for each reply line.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(5);

/// How long the server waits for a peer to take a write before it drops the
/// connection. A peer that stops reading would otherwise pin its attach slot
/// (and the output queued for it) for good.
pub const WRITE_DEADLINE: Duration = Duration::from_secs(30);

/// Largest terminal dimension accepted in `resize`.
const MAX_DIM: u16 = 1_000;
/// Read granularity: every blocking read wakes this often to check deadlines
/// and the stop flag, so deadlines are enforced to within one tick.
const POLL: Duration = Duration::from_millis(100);

/// The version numbers a side uses. Separate from the constants so tests can
/// stand up an older or newer peer.
#[derive(Clone, Copy)]
struct Versions {
    version: u32,
    min_peer: u32,
}

const CURRENT: Versions = Versions {
    version: PROTOCOL_VERSION,
    min_peer: MIN_PEER_VERSION,
};

// ---------------------------------------------------------------------------
// Types

/// One terminal as a peer sees it in `list`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionSummary {
    pub id: u32,
    pub title: String,
    pub cwd: Option<String>,
    pub command: String,
    pub running: bool,
    pub exit_code: Option<i32>,
    /// Whether the host's own user is looking at it. `None` when unknown;
    /// omitted from the wire then.
    pub in_use_here: Option<bool>,
}

/// The machine-readable kind of a refused request, as sent on the wire. An
/// unknown code from a newer peer reads as [`ErrorCode::Failed`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    VersionMismatch,
    HelloRequired,
    BadRequest,
    NotFound,
    RateLimited,
    TooLarge,
    Failed,
}

impl ErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            ErrorCode::VersionMismatch => "version_mismatch",
            ErrorCode::HelloRequired => "hello_required",
            ErrorCode::BadRequest => "bad_request",
            ErrorCode::NotFound => "not_found",
            ErrorCode::RateLimited => "rate_limited",
            ErrorCode::TooLarge => "too_large",
            ErrorCode::Failed => "failed",
        }
    }

    fn from_wire(s: &str) -> Self {
        match s {
            "version_mismatch" => ErrorCode::VersionMismatch,
            "hello_required" => ErrorCode::HelloRequired,
            "bad_request" => ErrorCode::BadRequest,
            "not_found" => ErrorCode::NotFound,
            "rate_limited" => ErrorCode::RateLimited,
            "too_large" => ErrorCode::TooLarge,
            _ => ErrorCode::Failed,
        }
    }
}

/// A request line, client to server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    /// First line of every connection. A missing `version` reads as 0.
    Hello {
        version: u32,
    },
    List,
    /// Turns this connection into the raw byte stream of session `id`.
    Attach {
        id: u32,
    },
    Resize {
        id: u32,
        cols: u16,
        rows: u16,
    },
}

/// A reply line, server to client.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Response {
    Hello {
        version: u32,
        min_client: u32,
    },
    Sessions(Vec<SessionSummary>),
    /// After this line the connection carries raw bytes: the snapshot, then
    /// live output.
    Attached {
        cols: u16,
        rows: u16,
    },
    Ok,
    Error {
        code: ErrorCode,
        message: String,
        /// The sender's protocol version, set with `VersionMismatch`.
        version: Option<u32>,
    },
}

/// Why a session operation failed, on either side.
#[derive(Debug)]
pub enum SessionError {
    /// The peers cannot talk. `local` is this side's version, `remote` the
    /// other's (0 if it did not say).
    VersionMismatch {
        local: u32,
        remote: u32,
    },
    /// No such session.
    NotFound,
    /// Resizes came faster than [`RESIZE_INTERVAL`]. Retry later.
    RateLimited,
    /// A line exceeded the cap.
    TooLarge,
    /// A deadline passed.
    TimedOut,
    /// The peer closed the connection mid-exchange.
    Closed,
    /// Something that is not valid protocol, or arrived out of order.
    Protocol(String),
    /// The operation failed on the host.
    Failed(String),
    Io(io::Error),
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::VersionMismatch { local, remote } => write!(
                f,
                "incompatible protocol versions (this side {local}, peer {remote})"
            ),
            SessionError::NotFound => write!(f, "no such session"),
            SessionError::RateLimited => write!(f, "too many requests"),
            SessionError::TooLarge => write!(f, "line too long"),
            SessionError::TimedOut => write!(f, "timed out"),
            SessionError::Closed => write!(f, "connection closed"),
            SessionError::Protocol(m) => write!(f, "protocol error: {m}"),
            SessionError::Failed(m) => write!(f, "{m}"),
            SessionError::Io(e) => write!(f, "i/o error: {e}"),
        }
    }
}

impl std::error::Error for SessionError {}

impl From<io::Error> for SessionError {
    fn from(e: io::Error) -> Self {
        SessionError::Io(e)
    }
}

impl SessionError {
    fn code(&self) -> ErrorCode {
        match self {
            SessionError::VersionMismatch { .. } => ErrorCode::VersionMismatch,
            SessionError::NotFound => ErrorCode::NotFound,
            SessionError::RateLimited => ErrorCode::RateLimited,
            SessionError::TooLarge => ErrorCode::TooLarge,
            SessionError::Protocol(_) => ErrorCode::BadRequest,
            _ => ErrorCode::Failed,
        }
    }

    /// The error reply for this failure.
    pub fn to_response(&self) -> Response {
        Response::Error {
            code: self.code(),
            message: self.to_string(),
            version: match self {
                SessionError::VersionMismatch { local, .. } => Some(*local),
                _ => None,
            },
        }
    }

    fn from_wire(code: ErrorCode, message: String, version: Option<u32>, local: u32) -> Self {
        match code {
            ErrorCode::VersionMismatch => SessionError::VersionMismatch {
                local,
                remote: version.unwrap_or(0),
            },
            ErrorCode::NotFound => SessionError::NotFound,
            ErrorCode::RateLimited => SessionError::RateLimited,
            ErrorCode::TooLarge => SessionError::TooLarge,
            ErrorCode::HelloRequired | ErrorCode::BadRequest => SessionError::Protocol(message),
            ErrorCode::Failed => SessionError::Failed(message),
        }
    }
}

fn protocol(message: impl Into<String>) -> SessionError {
    SessionError::Protocol(message.into())
}

// ---------------------------------------------------------------------------
// Encoding and decoding

fn push_json_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn get_u32(v: &Json, key: &str) -> Result<u32, SessionError> {
    v.get(key)
        .and_then(Json::as_i64)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| protocol(format!("missing or invalid `{key}`")))
}

fn get_u16(v: &Json, key: &str) -> Result<u16, SessionError> {
    get_u32(v, key)
        .and_then(|n| u16::try_from(n).map_err(|_| protocol(format!("`{key}` out of range"))))
}

/// A numeric field that older peers may omit.
fn get_u32_or_zero(v: &Json, key: &str) -> u32 {
    v.get(key)
        .and_then(Json::as_i64)
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(0)
}

fn opt_string(v: &Json, key: &str) -> Option<String> {
    v.get(key).and_then(Json::as_str).map(str::to_string)
}

fn parse_object(line: &str) -> Result<Json, SessionError> {
    let v = json::parse(line).map_err(|e| protocol(format!("bad json: {}", e.0)))?;
    match v {
        Json::Obj(_) => Ok(v),
        _ => Err(protocol("not an object")),
    }
}

impl SessionSummary {
    fn write_json(&self, out: &mut String) {
        out.push_str(&format!(r#"{{"id":{},"title":"#, self.id));
        push_json_str(out, &self.title);
        if let Some(cwd) = &self.cwd {
            out.push_str(r#","cwd":"#);
            push_json_str(out, cwd);
        }
        out.push_str(r#","command":"#);
        push_json_str(out, &self.command);
        out.push_str(&format!(r#","running":{}"#, self.running));
        if let Some(code) = self.exit_code {
            out.push_str(&format!(r#","exit_code":{code}"#));
        }
        if let Some(b) = self.in_use_here {
            out.push_str(&format!(r#","in_use_here":{b}"#));
        }
        out.push('}');
    }

    fn from_json(v: &Json) -> Result<Self, SessionError> {
        Ok(SessionSummary {
            id: get_u32(v, "id")?,
            title: opt_string(v, "title").unwrap_or_default(),
            cwd: opt_string(v, "cwd"),
            command: opt_string(v, "command").unwrap_or_default(),
            running: v.get("running").and_then(Json::as_bool).unwrap_or(false),
            exit_code: v
                .get("exit_code")
                .and_then(Json::as_i64)
                .and_then(|n| i32::try_from(n).ok()),
            in_use_here: v.get("in_use_here").and_then(Json::as_bool),
        })
    }

    /// The summary as it goes on the wire: text cut to [`MAX_TEXT_CHARS`].
    fn clamped(mut self) -> Self {
        let cut = |s: &str| -> String { s.chars().take(MAX_TEXT_CHARS).collect() };
        self.title = cut(&self.title);
        self.command = cut(&self.command);
        self.cwd = self.cwd.as_deref().map(cut);
        self
    }
}

impl Request {
    /// The request as one line, without the newline.
    pub fn to_line(&self) -> String {
        match self {
            Request::Hello { version } => format!(r#"{{"op":"hello","version":{version}}}"#),
            Request::List => r#"{"op":"list"}"#.to_string(),
            Request::Attach { id } => format!(r#"{{"op":"attach","id":{id}}}"#),
            Request::Resize { id, cols, rows } => {
                format!(r#"{{"op":"resize","id":{id},"cols":{cols},"rows":{rows}}}"#)
            }
        }
    }

    /// Parses one line. Unknown fields are ignored; an unknown op is an error.
    pub fn parse(line: &str) -> Result<Self, SessionError> {
        let v = parse_object(line)?;
        let op = v
            .get("op")
            .and_then(Json::as_str)
            .ok_or_else(|| protocol("missing `op`"))?;
        match op {
            "hello" => Ok(Request::Hello {
                version: get_u32_or_zero(&v, "version"),
            }),
            "list" => Ok(Request::List),
            "attach" => Ok(Request::Attach {
                id: get_u32(&v, "id")?,
            }),
            "resize" => Ok(Request::Resize {
                id: get_u32(&v, "id")?,
                cols: get_u16(&v, "cols")?,
                rows: get_u16(&v, "rows")?,
            }),
            _ => Err(protocol("unknown op")),
        }
    }
}

impl Response {
    /// The reply as one line, without the newline.
    pub fn to_line(&self) -> String {
        match self {
            Response::Hello {
                version,
                min_client,
            } => format!(
                r#"{{"ok":true,"kind":"hello","version":{version},"min_client":{min_client}}}"#
            ),
            Response::Sessions(list) => {
                let mut out = String::from(r#"{"ok":true,"kind":"sessions","sessions":["#);
                for (i, s) in list.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    s.write_json(&mut out);
                }
                out.push_str("]}");
                out
            }
            Response::Attached { cols, rows } => {
                format!(r#"{{"ok":true,"kind":"attached","cols":{cols},"rows":{rows}}}"#)
            }
            Response::Ok => r#"{"ok":true,"kind":"ok"}"#.to_string(),
            Response::Error {
                code,
                message,
                version,
            } => {
                let mut out = format!(r#"{{"ok":false,"error":"{}","message":"#, code.as_str());
                push_json_str(&mut out, message);
                if let Some(v) = version {
                    out.push_str(&format!(r#","version":{v}"#));
                }
                out.push('}');
                out
            }
        }
    }

    /// Parses one line. Unknown fields are ignored.
    pub fn parse(line: &str) -> Result<Self, SessionError> {
        let v = parse_object(line)?;
        let ok = v
            .get("ok")
            .and_then(Json::as_bool)
            .ok_or_else(|| protocol("missing `ok`"))?;
        if !ok {
            let code = v
                .get("error")
                .and_then(Json::as_str)
                .map(ErrorCode::from_wire)
                .unwrap_or(ErrorCode::Failed);
            return Ok(Response::Error {
                code,
                message: opt_string(&v, "message").unwrap_or_default(),
                version: v
                    .get("version")
                    .and_then(Json::as_i64)
                    .and_then(|n| u32::try_from(n).ok()),
            });
        }
        let kind = v
            .get("kind")
            .and_then(Json::as_str)
            .ok_or_else(|| protocol("missing `kind`"))?;
        match kind {
            "hello" => Ok(Response::Hello {
                version: get_u32_or_zero(&v, "version"),
                min_client: get_u32_or_zero(&v, "min_client"),
            }),
            "sessions" => {
                let items = v
                    .get("sessions")
                    .and_then(Json::as_array)
                    .ok_or_else(|| protocol("missing `sessions`"))?;
                items
                    .iter()
                    .map(SessionSummary::from_json)
                    .collect::<Result<Vec<_>, _>>()
                    .map(Response::Sessions)
            }
            "attached" => Ok(Response::Attached {
                cols: get_u16(&v, "cols")?,
                rows: get_u16(&v, "rows")?,
            }),
            "ok" => Ok(Response::Ok),
            _ => Err(protocol("unknown reply kind")),
        }
    }
}

// ---------------------------------------------------------------------------
// Line I/O

fn is_timeout(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    )
}

/// Reads one line, a byte at a time because the bytes after an `attach` reply
/// belong to the caller. `Ok(None)` is a clean EOF before any byte. The reader
/// must have a short read deadline (see `POLL`): `deadline` is enforced
/// whenever a read times out and after every byte, so a peer dribbling bytes
/// cannot stretch it.
fn read_line(
    r: &mut dyn Read,
    max: usize,
    deadline: Instant,
) -> Result<Option<String>, SessionError> {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match r.read(&mut byte) {
            Ok(0) => {
                return if line.is_empty() {
                    Ok(None)
                } else {
                    Err(SessionError::Closed)
                }
            }
            Ok(_) => {
                if byte[0] == b'\n' {
                    break;
                }
                line.push(byte[0]);
                if line.len() > max {
                    return Err(SessionError::TooLarge);
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) if is_timeout(&e) => {}
            Err(e) => return Err(SessionError::Io(e)),
        }
        if Instant::now() >= deadline {
            return Err(SessionError::TimedOut);
        }
    }
    String::from_utf8(line)
        .map(Some)
        .map_err(|_| protocol("line is not utf-8"))
}

fn write_line(w: &mut dyn Write, line: &str) -> Result<(), SessionError> {
    let mut buf = Vec::with_capacity(line.len() + 1);
    buf.extend_from_slice(line.as_bytes());
    buf.push(b'\n');
    w.write_all(&buf)?;
    w.flush()?;
    Ok(())
}

fn write_response(w: &mut dyn Write, r: &Response) -> Result<(), SessionError> {
    write_line(w, &r.to_line())
}

// ---------------------------------------------------------------------------
// Server

/// What the host application provides. The server calls it from connection
/// threads, so it must be shareable. `peer` is the identity the transport
/// proved; use it for per-peer accounting (a cap on live sessions per peer).
pub trait SessionHandler: Send + Sync {
    /// Terminals this peer may see. Truncated to [`MAX_LISTED`] by the server.
    fn list(&self, peer: &PeerIdentity) -> Vec<SessionSummary>;

    /// Start streaming session `id` to `peer`. Every `Ok` is followed by exactly
    /// one [`close`](Self::close), whatever ends the stream.
    fn attach(&self, peer: &PeerIdentity, id: u32) -> Result<AttachedSession, SessionError>;

    /// Peer input for an attached session, in order. May block (a full pty); the
    /// server queues at most [`ServeLimits::input_queue`] chunks behind it. May
    /// still be called briefly after `close`; it should then fail.
    fn write(&self, id: u32, bytes: &[u8]) -> io::Result<()>;

    fn resize(
        &self,
        peer: &PeerIdentity,
        id: u32,
        cols: u16,
        rows: u16,
    ) -> Result<(), SessionError>;

    /// The attached stream for `id` ended (peer left, session exited, or an
    /// error). Release whatever `attach` took.
    ///
    /// `token` is the one [`AttachedSession::token`] carried for this attach, so
    /// two attaches of the same id by one peer stay distinguishable.
    fn close(&self, peer: &PeerIdentity, id: u32, token: u64);
}

/// What [`SessionHandler::attach`] returns.
pub struct AttachedSession {
    /// Identifies this attach to the handler's `close`. Unique per attach; the
    /// server only hands it back.
    pub token: u64,
    pub cols: u16,
    pub rows: u16,
    /// Sent first, before any live output.
    pub snapshot: Vec<u8>,
    /// Live output. The server ends the stream when the channel disconnects (the
    /// session ended); chunks already queued are still delivered.
    pub output: mpsc::Receiver<Vec<u8>>,
}

/// The bounds [`serve_connection`] enforces. `Default` is the v1 contract; tests
/// shrink them.
#[derive(Clone, Debug)]
pub struct ServeLimits {
    /// Time allowed to send a complete `hello`. Default [`HELLO_DEADLINE`].
    pub hello_deadline: Duration,
    /// Longest request line. Default [`MAX_LINE`].
    pub max_line: usize,
    /// Longest wait for the next request on a control connection. Default
    /// [`IDLE_DEADLINE`].
    pub idle: Duration,
    /// Longest an attached connection may send no input before it is closed.
    /// `None` (the default): never. A person reading output sends nothing.
    pub attached_idle: Option<Duration>,
    /// Minimum spacing of accepted resizes per connection. Default
    /// [`RESIZE_INTERVAL`].
    pub resize_interval: Duration,
    /// Queued input chunks. Default [`INPUT_QUEUE`].
    pub input_queue: usize,
    /// Largest input chunk. Default [`INPUT_CHUNK`].
    pub input_chunk: usize,
    /// Most sessions in a `list` reply. Default [`MAX_LISTED`].
    pub max_listed: usize,
    /// Longest a write to the peer may stall before the connection is dropped.
    /// Default [`WRITE_DEADLINE`].
    pub write_deadline: Duration,
}

impl Default for ServeLimits {
    fn default() -> Self {
        ServeLimits {
            hello_deadline: HELLO_DEADLINE,
            max_line: MAX_LINE,
            idle: IDLE_DEADLINE,
            attached_idle: None,
            resize_interval: RESIZE_INTERVAL,
            input_queue: INPUT_QUEUE,
            input_chunk: INPUT_CHUNK,
            max_listed: MAX_LISTED,
            write_deadline: WRITE_DEADLINE,
        }
    }
}

/// Serves one accepted connection to its end with the default limits. Blocks;
/// run it on a thread per connection. `Ok` is a normal end (peer left, session
/// exited, idle attach closed); `Err` says why the connection was dropped, for
/// logging. A protocol error is answered with an error line first where that is
/// safe; a timeout or I/O failure is not answered.
///
/// Connection caps (per peer, total) are the caller's: this limits one
/// connection, not how many exist.
pub fn serve_connection(
    conn: Box<dyn Connection>,
    handler: Arc<dyn SessionHandler>,
) -> Result<(), SessionError> {
    serve_connection_with(conn, handler, &ServeLimits::default())
}

/// [`serve_connection`] with explicit limits.
pub fn serve_connection_with(
    conn: Box<dyn Connection>,
    handler: Arc<dyn SessionHandler>,
    limits: &ServeLimits,
) -> Result<(), SessionError> {
    serve_inner(conn, handler, limits, CURRENT)
}

/// Sends an error line when the peer can still use one, and passes the error on.
fn refuse(w: &mut dyn Write, e: SessionError) -> SessionError {
    if !matches!(
        e,
        SessionError::Io(_) | SessionError::Closed | SessionError::TimedOut
    ) {
        let _ = write_response(w, &e.to_response());
    }
    e
}

fn serve_inner(
    mut conn: Box<dyn Connection>,
    handler: Arc<dyn SessionHandler>,
    limits: &ServeLimits,
    ver: Versions,
) -> Result<(), SessionError> {
    let peer = conn.peer().clone();
    conn.set_read_deadline(Some(POLL))?;
    conn.set_write_deadline(Some(limits.write_deadline))?;
    let (mut r, mut w) = conn.split();

    // hello
    let line = match read_line(
        &mut *r,
        limits.max_line,
        Instant::now() + limits.hello_deadline,
    ) {
        Ok(Some(l)) => l,
        Ok(None) => return Ok(()),
        Err(e) => return Err(refuse(&mut *w, e)),
    };
    match Request::parse(&line) {
        Ok(Request::Hello { version }) => {
            if version < ver.min_peer {
                let e = SessionError::VersionMismatch {
                    local: ver.version,
                    remote: version,
                };
                return Err(refuse(&mut *w, e));
            }
            write_response(
                &mut *w,
                &Response::Hello {
                    version: ver.version,
                    min_client: ver.min_peer,
                },
            )?;
        }
        Ok(_) => {
            let _ = write_response(
                &mut *w,
                &Response::Error {
                    code: ErrorCode::HelloRequired,
                    message: "hello required".into(),
                    version: None,
                },
            );
            return Err(protocol("first request was not hello"));
        }
        Err(e) => return Err(refuse(&mut *w, e)),
    }

    // requests
    let mut last_resize: Option<Instant> = None;
    loop {
        let line = match read_line(&mut *r, limits.max_line, Instant::now() + limits.idle) {
            Ok(Some(l)) => l,
            Ok(None) => return Ok(()),
            Err(e) => return Err(refuse(&mut *w, e)),
        };
        let req = match Request::parse(&line) {
            Ok(q) => q,
            Err(e) => return Err(refuse(&mut *w, e)),
        };
        match req {
            Request::Hello { .. } => {
                return Err(refuse(&mut *w, protocol("hello sent twice")));
            }
            Request::List => {
                let mut list = handler.list(&peer);
                list.truncate(limits.max_listed);
                let list: Vec<SessionSummary> =
                    list.into_iter().map(SessionSummary::clamped).collect();
                write_response(&mut *w, &Response::Sessions(list))?;
            }
            Request::Resize { id, cols, rows } => {
                let reply = if cols == 0 || rows == 0 || cols > MAX_DIM || rows > MAX_DIM {
                    protocol("bad size").to_response()
                } else if last_resize.is_some_and(|t| t.elapsed() < limits.resize_interval) {
                    SessionError::RateLimited.to_response()
                } else {
                    last_resize = Some(Instant::now());
                    match handler.resize(&peer, id, cols, rows) {
                        Ok(()) => Response::Ok,
                        Err(e) => e.to_response(),
                    }
                };
                write_response(&mut *w, &reply)?;
            }
            Request::Attach { id } => match handler.attach(&peer, id) {
                Err(e) => write_response(&mut *w, &e.to_response())?,
                Ok(att) => return stream_phase(r, w, handler, peer, id, att, limits),
            },
        }
    }
}

/// The attached part of a connection: output pump on this thread, input read on
/// one thread, handler writes on another, joined by a bounded queue.
fn stream_phase(
    mut r: Box<dyn Read + Send>,
    mut w: Box<dyn Write + Send>,
    handler: Arc<dyn SessionHandler>,
    peer: PeerIdentity,
    id: u32,
    att: AttachedSession,
    limits: &ServeLimits,
) -> Result<(), SessionError> {
    let AttachedSession {
        token,
        cols,
        rows,
        snapshot,
        output,
    } = att;
    let head = write_response(&mut *w, &Response::Attached { cols, rows }).and_then(|()| {
        if snapshot.is_empty() {
            Ok(())
        } else {
            w.write_all(&snapshot)
                .and_then(|()| w.flush())
                .map_err(SessionError::from)
        }
    });
    if let Err(e) = head {
        handler.close(&peer, id, token);
        return Err(e);
    }

    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(limits.input_queue);

    // Handler writes. Not joined: it may be stuck inside a blocked `write`, and
    // it ends on its own once that returns and the queue is closed.
    let writer_handler = handler.clone();
    std::thread::spawn(move || {
        for chunk in rx {
            if writer_handler.write(id, &chunk).is_err() {
                break;
            }
        }
    });

    // Socket reads into the queue.
    let reader_stop = stop.clone();
    let idle = limits.attached_idle;
    let chunk = limits.input_chunk.max(1);
    let reader = std::thread::spawn(move || {
        let mut buf = vec![0u8; chunk];
        let mut last = Instant::now();
        'read: while !reader_stop.load(Ordering::SeqCst) {
            match r.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    last = Instant::now();
                    let mut item = buf[..n].to_vec();
                    loop {
                        match tx.try_send(item) {
                            Ok(()) => break,
                            Err(mpsc::TrySendError::Full(back)) => {
                                // Queue full: stop reading the socket (the
                                // peer's TCP window fills) but stay stoppable.
                                if reader_stop.load(Ordering::SeqCst) {
                                    break 'read;
                                }
                                item = back;
                                std::thread::sleep(Duration::from_millis(5));
                            }
                            Err(mpsc::TrySendError::Disconnected(_)) => break 'read,
                        }
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) if is_timeout(&e) => {
                    if idle.is_some_and(|i| last.elapsed() >= i) {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        reader_stop.store(true, Ordering::SeqCst);
    });

    let mut result = Ok(());
    while !stop.load(Ordering::SeqCst) {
        match output.recv_timeout(POLL) {
            Ok(bytes) => {
                if let Err(e) = w.write_all(&bytes).and_then(|()| w.flush()) {
                    result = Err(SessionError::Io(e));
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            // The session ended.
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    stop.store(true, Ordering::SeqCst);
    // Closing the write half is EOF for the peer.
    drop(w);
    let _ = reader.join();
    handler.close(&peer, id, token);
    result
}

// ---------------------------------------------------------------------------
// Client

/// A control connection to a session server, after a successful `hello`.
pub struct SessionClient {
    r: Box<dyn Read + Send>,
    w: Box<dyn Write + Send>,
    server_version: u32,
    timeout: Duration,
}

/// An attached session: raw bytes both ways.
pub struct AttachedStream {
    pub cols: u16,
    pub rows: u16,
    /// The terminal's snapshot, then live output. Blocks until bytes arrive; EOF
    /// means the session ended or the host dropped the connection.
    pub reader: Box<dyn Read + Send>,
    /// Keystrokes. Dropping it (and the reader) detaches.
    pub writer: Box<dyn Write + Send>,
}

/// A reader that waits through the connection's poll timeouts, so an idle
/// terminal does not surface as a read error.
struct PatientReader(Box<dyn Read + Send>);

impl Read for PatientReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            match self.0.read(buf) {
                Err(e) if is_timeout(&e) || e.kind() == io::ErrorKind::Interrupted => {}
                other => return other,
            }
        }
    }
}

impl SessionClient {
    /// Runs `hello` on a freshly dialed connection. Fails with
    /// [`SessionError::VersionMismatch`] if either side is too old for the
    /// other. Each reply is waited for at most [`CALL_TIMEOUT`].
    pub fn connect(conn: Box<dyn Connection>) -> Result<Self, SessionError> {
        Self::connect_inner(conn, CURRENT, CALL_TIMEOUT)
    }

    fn connect_inner(
        mut conn: Box<dyn Connection>,
        ver: Versions,
        timeout: Duration,
    ) -> Result<Self, SessionError> {
        conn.set_read_deadline(Some(POLL))?;
        let (r, w) = conn.split();
        let mut client = SessionClient {
            r,
            w,
            server_version: 0,
            timeout,
        };
        match client.call(&Request::Hello {
            version: ver.version,
        })? {
            Response::Hello {
                version,
                min_client,
            } => {
                if version < ver.min_peer || min_client > ver.version {
                    return Err(SessionError::VersionMismatch {
                        local: ver.version,
                        remote: version,
                    });
                }
                client.server_version = version;
                Ok(client)
            }
            _ => Err(protocol("unexpected reply to hello")),
        }
    }

    /// The server's protocol version, from `hello`.
    pub fn server_version(&self) -> u32 {
        self.server_version
    }

    /// The terminals the host shares with this peer.
    pub fn list(&mut self) -> Result<Vec<SessionSummary>, SessionError> {
        match self.call(&Request::List)? {
            Response::Sessions(list) => Ok(list),
            _ => Err(protocol("unexpected reply to list")),
        }
    }

    /// Resizes session `id`. The server accepts one per [`RESIZE_INTERVAL`] per
    /// connection and answers faster ones with [`SessionError::RateLimited`], so
    /// a caller following a window drag should coalesce and send the last size.
    /// A control connection idle for [`IDLE_DEADLINE`] is closed by the server;
    /// a later call then fails and the caller dials again.
    pub fn resize(&mut self, id: u32, cols: u16, rows: u16) -> Result<(), SessionError> {
        match self.call(&Request::Resize { id, cols, rows })? {
            Response::Ok => Ok(()),
            _ => Err(protocol("unexpected reply to resize")),
        }
    }

    /// Attaches to session `id`, consuming this connection (a connection is
    /// either control or attached). Dial a new one for further control calls.
    pub fn attach(mut self, id: u32) -> Result<AttachedStream, SessionError> {
        match self.call(&Request::Attach { id })? {
            Response::Attached { cols, rows } => Ok(AttachedStream {
                cols,
                rows,
                reader: Box::new(PatientReader(self.r)),
                writer: self.w,
            }),
            _ => Err(protocol("unexpected reply to attach")),
        }
    }

    fn call(&mut self, req: &Request) -> Result<Response, SessionError> {
        write_line(&mut *self.w, &req.to_line())?;
        let local = match req {
            Request::Hello { version } => *version,
            _ => PROTOCOL_VERSION,
        };
        let line = read_line(&mut *self.r, MAX_LINE, Instant::now() + self.timeout)?
            .ok_or(SessionError::Closed)?;
        match Response::parse(&line)? {
            Response::Error {
                code,
                message,
                version,
            } => Err(SessionError::from_wire(code, message, version, local)),
            other => Ok(other),
        }
    }
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::allowlist::Allowlist;
    use crate::tailnet_tcp::TailnetTcp;
    use crate::tailscale::fake::*;
    use crate::{watchdog, Transport};
    use std::sync::Mutex;
    use std::thread::JoinHandle;

    const ENTRY: &str = "tailnet:user/nPEERB1CNTRL/42@example.ts.net";

    fn loopback() -> std::net::IpAddr {
        "127.0.0.1".parse().unwrap()
    }

    fn server_runner() -> Arc<FakeRunner> {
        let r = Arc::new(FakeRunner::new(&status_running(&["127.0.0.1"], &[])));
        r.set_whois(loopback(), Ok(whois_user("nPEERB1CNTRL", 42)));
        r
    }

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

    type Dialed = (
        Box<dyn Connection>,
        Option<Box<dyn Connection>>,
        Arc<TailnetTcp>,
    );

    /// A real loopback `TailnetTcp` link (fake CLI, no Tailscale). The server
    /// half is `None` when the server's allowlist refused the client.
    fn connect_pair(server_allow: &[&str]) -> Dialed {
        let server =
            Arc::new(TailnetTcp::bind_for_test(server_runner(), allow(server_allow), 0).unwrap());
        let port = server.local_addrs()[0].port();
        let s = server.clone();
        let accepted = std::thread::spawn(move || s.accept().unwrap().ok());
        let client = TailnetTcp::client(client_runner(), allow(&[ENTRY]));
        let conn = client.connect(&format!("node-b:{port}")).unwrap();
        (conn, accepted.join().unwrap(), server)
    }

    fn pair() -> (Box<dyn Connection>, Box<dyn Connection>, Arc<TailnetTcp>) {
        let (c, s, keep) = connect_pair(&[ENTRY]);
        (c, s.expect("server admitted the client"), keep)
    }

    #[derive(Default)]
    struct Fake {
        sessions: Mutex<Vec<SessionSummary>>,
        written: Mutex<Vec<(u32, Vec<u8>)>>,
        resizes: Mutex<Vec<(u32, u16, u16)>>,
        closed: Mutex<Vec<u32>>,
        outputs: Mutex<Vec<mpsc::Sender<Vec<u8>>>>,
        peers: Mutex<Vec<PeerIdentity>>,
        /// Held by a test to make `write` block, like a full pty.
        write_gate: Mutex<()>,
    }

    impl SessionHandler for Fake {
        fn list(&self, peer: &PeerIdentity) -> Vec<SessionSummary> {
            self.peers.lock().unwrap().push(peer.clone());
            self.sessions.lock().unwrap().clone()
        }
        fn attach(&self, _peer: &PeerIdentity, id: u32) -> Result<AttachedSession, SessionError> {
            if id != 1 {
                return Err(SessionError::NotFound);
            }
            let (tx, rx) = mpsc::channel();
            self.outputs.lock().unwrap().push(tx);
            Ok(AttachedSession {
                token: 0,
                cols: 80,
                rows: 24,
                snapshot: b"snap".to_vec(),
                output: rx,
            })
        }
        fn write(&self, id: u32, bytes: &[u8]) -> io::Result<()> {
            let _gate = self.write_gate.lock().unwrap();
            self.written.lock().unwrap().push((id, bytes.to_vec()));
            Ok(())
        }
        fn resize(
            &self,
            _peer: &PeerIdentity,
            id: u32,
            cols: u16,
            rows: u16,
        ) -> Result<(), SessionError> {
            if id == 9 {
                return Err(SessionError::NotFound);
            }
            self.resizes.lock().unwrap().push((id, cols, rows));
            Ok(())
        }
        fn close(&self, _peer: &PeerIdentity, id: u32, _token: u64) {
            self.closed.lock().unwrap().push(id);
        }
    }

    impl Fake {
        fn written_bytes(&self, id: u32) -> Vec<u8> {
            self.written
                .lock()
                .unwrap()
                .iter()
                .filter(|(i, _)| *i == id)
                .flat_map(|(_, b)| b.clone())
                .collect()
        }
        fn take_sender(&self) -> mpsc::Sender<Vec<u8>> {
            wait_until(|| !self.outputs.lock().unwrap().is_empty());
            self.outputs.lock().unwrap().pop().unwrap()
        }
    }

    fn summary(id: u32) -> SessionSummary {
        SessionSummary {
            id,
            title: format!("zsh {id}"),
            cwd: Some("~/code/api".into()),
            command: "zsh".into(),
            running: true,
            exit_code: None,
            in_use_here: Some(false),
        }
    }

    fn wait_until(cond: impl Fn() -> bool) {
        let end = Instant::now() + Duration::from_secs(10);
        while !cond() {
            assert!(Instant::now() < end, "condition not met in time");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn serve_bg(
        conn: Box<dyn Connection>,
        fake: &Arc<Fake>,
        limits: ServeLimits,
        ver: Versions,
    ) -> JoinHandle<Result<(), SessionError>> {
        let h: Arc<dyn SessionHandler> = fake.clone();
        std::thread::spawn(move || serve_inner(conn, h, &limits, ver))
    }

    fn fake_with_session() -> Arc<Fake> {
        let f = Arc::new(Fake::default());
        *f.sessions.lock().unwrap() = vec![summary(1), summary(2)];
        f
    }

    /// Reads one reply line from a raw (deadline-free) read half.
    fn raw_reply(r: &mut Box<dyn Read + Send>) -> Response {
        let line = read_line(&mut **r, MAX_LINE, Instant::now() + Duration::from_secs(20))
            .unwrap()
            .expect("a reply line");
        Response::parse(&line).unwrap()
    }

    // --- framing ---------------------------------------------------------

    #[test]
    fn requests_round_trip() {
        for req in [
            Request::Hello { version: 1 },
            Request::List,
            Request::Attach { id: 7 },
            Request::Resize {
                id: 7,
                cols: 120,
                rows: 40,
            },
        ] {
            let line = req.to_line();
            assert!(!line.contains('\n'));
            assert_eq!(Request::parse(&line).unwrap(), req);
        }
        assert_eq!(Request::List.to_line(), r#"{"op":"list"}"#);
    }

    #[test]
    fn responses_round_trip_including_awkward_text() {
        let nasty = SessionSummary {
            id: 3,
            title: "a \"quoted\" \\ title\nwith\ttabs and \u{1} and é 🙂".into(),
            cwd: None,
            command: "claude".into(),
            running: false,
            exit_code: Some(-1),
            in_use_here: None,
        };
        for resp in [
            Response::Hello {
                version: 1,
                min_client: 1,
            },
            Response::Sessions(vec![]),
            Response::Sessions(vec![summary(1), nasty]),
            Response::Attached { cols: 80, rows: 24 },
            Response::Ok,
            Response::Error {
                code: ErrorCode::VersionMismatch,
                message: "no \"way\"".into(),
                version: Some(2),
            },
            Response::Error {
                code: ErrorCode::NotFound,
                message: String::new(),
                version: None,
            },
        ] {
            let line = resp.to_line();
            assert!(!line.contains('\n'), "{line}");
            assert_eq!(Response::parse(&line).unwrap(), resp);
        }
    }

    #[test]
    fn optional_summary_fields_are_omitted_from_the_wire() {
        let s = SessionSummary {
            id: 1,
            title: "t".into(),
            cwd: None,
            command: "c".into(),
            running: true,
            exit_code: None,
            in_use_here: None,
        };
        let line = Response::Sessions(vec![s]).to_line();
        assert!(!line.contains("cwd") && !line.contains("exit_code") && !line.contains("in_use"));
    }

    #[test]
    fn unknown_fields_are_ignored_and_a_missing_version_is_zero() {
        assert_eq!(
            Request::parse(r#"{"op":"hello","future":[1,2]}"#).unwrap(),
            Request::Hello { version: 0 }
        );
        assert_eq!(
            Request::parse(r#"{"op":"list","extra":true}"#).unwrap(),
            Request::List
        );
        let r = Response::parse(r#"{"ok":true,"kind":"ok","added_later":{"a":1}}"#).unwrap();
        assert_eq!(r, Response::Ok);
        // An error code from a newer peer is a plain failure.
        match Response::parse(r#"{"ok":false,"error":"brand_new","message":"m"}"#).unwrap() {
            Response::Error { code, .. } => assert_eq!(code, ErrorCode::Failed),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn malformed_and_unknown_requests_are_errors_not_panics() {
        for bad in [
            "",
            "not json",
            "[]",
            "{}",
            r#"{"op":5}"#,
            r#"{"op":"spawn","argv":["sh"]}"#,
            r#"{"op":"kill","id":1}"#,
            r#"{"op":"read_ring","id":1}"#,
            r#"{"op":"attach"}"#,
            r#"{"op":"attach","id":-1}"#,
            r#"{"op":"resize","id":1,"cols":70000,"rows":1}"#,
        ] {
            assert!(Request::parse(bad).is_err(), "{bad}");
        }
    }

    // --- version check ---------------------------------------------------

    #[test]
    fn hello_negotiates_the_version() {
        watchdog(60, || {
            let (c, s, _k) = pair();
            let fake = fake_with_session();
            let h = serve_bg(s, &fake, ServeLimits::default(), CURRENT);
            let client = SessionClient::connect(c).unwrap();
            assert_eq!(client.server_version(), PROTOCOL_VERSION);
            drop(client);
            h.join().unwrap().unwrap();
        });
    }

    #[test]
    fn an_old_client_is_refused_with_a_typed_mismatch() {
        watchdog(60, || {
            let (c, s, _k) = pair();
            let fake = fake_with_session();
            let newer = Versions {
                version: 2,
                min_peer: 2,
            };
            let h = serve_bg(s, &fake, ServeLimits::default(), newer);
            match SessionClient::connect(c) {
                Err(SessionError::VersionMismatch { local, remote }) => {
                    assert_eq!((local, remote), (1, 2));
                }
                Err(e) => panic!("{e:?}"),
                Ok(_) => panic!("an old client was served"),
            }
            assert!(matches!(
                h.join().unwrap(),
                Err(SessionError::VersionMismatch {
                    local: 2,
                    remote: 1
                })
            ));
        });
    }

    #[test]
    fn an_old_server_is_refused_by_a_new_client() {
        watchdog(60, || {
            let (c, s, _k) = pair();
            let fake = fake_with_session();
            let h = serve_bg(s, &fake, ServeLimits::default(), CURRENT);
            let newer = Versions {
                version: 2,
                min_peer: 2,
            };
            match SessionClient::connect_inner(c, newer, CALL_TIMEOUT) {
                Err(SessionError::VersionMismatch { local, remote }) => {
                    assert_eq!((local, remote), (2, 1));
                }
                Err(e) => panic!("{e:?}"),
                Ok(_) => panic!("an old server was used"),
            }
            // The server accepted the hello and sees the client leave.
            h.join().unwrap().unwrap();
        });
    }

    #[test]
    fn a_first_request_other_than_hello_is_refused() {
        watchdog(60, || {
            let (c, s, _k) = pair();
            let fake = fake_with_session();
            let h = serve_bg(s, &fake, ServeLimits::default(), CURRENT);
            let (mut r, mut w) = c.split();
            write_line(&mut *w, &Request::List.to_line()).unwrap();
            match raw_reply(&mut r) {
                Response::Error { code, .. } => assert_eq!(code, ErrorCode::HelloRequired),
                other => panic!("{other:?}"),
            }
            assert!(matches!(h.join().unwrap(), Err(SessionError::Protocol(_))));
            assert!(fake.peers.lock().unwrap().is_empty(), "list ran anyway");
        });
    }

    // --- caps ------------------------------------------------------------

    #[test]
    fn the_v1_caps_are_what_the_plan_says() {
        let l = ServeLimits::default();
        assert_eq!(l.hello_deadline, Duration::from_secs(5));
        assert_eq!(l.max_line, 1024 * 1024);
        assert_eq!(l.resize_interval, Duration::from_millis(100));
        assert_eq!(l.idle, IDLE_DEADLINE);
        assert!(l.attached_idle.is_none());
        assert!(l.input_queue > 0 && l.input_queue <= 64);
    }

    #[test]
    fn an_oversized_line_is_answered_and_dropped() {
        watchdog(60, || {
            let (c, s, _k) = pair();
            let fake = fake_with_session();
            let limits = ServeLimits {
                max_line: 256,
                ..ServeLimits::default()
            };
            let h = serve_bg(s, &fake, limits, CURRENT);
            let (mut r, mut w) = c.split();
            // Exactly one byte over the cap, no newline: the server has read it
            // all by the time it answers.
            w.write_all(&[b'a'; 257]).unwrap();
            match raw_reply(&mut r) {
                Response::Error { code, .. } => assert_eq!(code, ErrorCode::TooLarge),
                other => panic!("{other:?}"),
            }
            assert!(matches!(h.join().unwrap(), Err(SessionError::TooLarge)));
        });
    }

    #[test]
    fn the_default_line_cap_is_one_mib() {
        watchdog(60, || {
            let (c, s, _k) = pair();
            let fake = fake_with_session();
            let h = serve_bg(s, &fake, ServeLimits::default(), CURRENT);
            let (mut r, mut w) = c.split();
            let junk = vec![b'a'; MAX_LINE + 1];
            let writer = std::thread::spawn(move || {
                let _ = w.write_all(&junk);
                w
            });
            match raw_reply(&mut r) {
                Response::Error { code, .. } => assert_eq!(code, ErrorCode::TooLarge),
                other => panic!("{other:?}"),
            }
            assert!(matches!(h.join().unwrap(), Err(SessionError::TooLarge)));
            let _ = writer.join();
        });
    }

    #[test]
    fn a_silent_peer_times_out_of_hello_with_nothing_sent() {
        watchdog(60, || {
            let (c, s, _k) = pair();
            let fake = fake_with_session();
            let limits = ServeLimits {
                hello_deadline: Duration::from_millis(300),
                ..ServeLimits::default()
            };
            let started = Instant::now();
            let h = serve_bg(s, &fake, limits, CURRENT);
            assert!(matches!(h.join().unwrap(), Err(SessionError::TimedOut)));
            assert!(started.elapsed() < Duration::from_secs(5));
            let (mut r, _w) = c.split();
            let mut buf = [0u8; 8];
            match r.read(&mut buf) {
                Ok(0) | Err(_) => {}
                Ok(n) => panic!("a timed-out peer received {n} bytes"),
            }
        });
    }

    #[test]
    fn a_dribbled_hello_cannot_stretch_the_deadline() {
        watchdog(60, || {
            let (c, s, _k) = pair();
            let fake = fake_with_session();
            let limits = ServeLimits {
                hello_deadline: Duration::from_millis(400),
                ..ServeLimits::default()
            };
            let h = serve_bg(s, &fake, limits, CURRENT);
            let (_r, mut w) = c.split();
            let feeder = std::thread::spawn(move || {
                for b in br#"{"op":"hello","version":1"#.iter() {
                    if w.write_all(&[*b]).is_err() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(60));
                }
                w
            });
            assert!(matches!(h.join().unwrap(), Err(SessionError::TimedOut)));
            let _ = feeder.join();
        });
    }

    #[test]
    fn a_client_gives_up_on_a_server_that_never_answers() {
        watchdog(60, || {
            let (c, _s, _k) = pair();
            let started = Instant::now();
            match SessionClient::connect_inner(c, CURRENT, Duration::from_millis(300)) {
                Err(SessionError::TimedOut) => {}
                Err(e) => panic!("{e:?}"),
                Ok(_) => panic!("connected to a silent server"),
            }
            assert!(started.elapsed() < Duration::from_secs(5));
        });
    }

    #[test]
    fn a_control_connection_idles_out() {
        watchdog(60, || {
            let (c, s, _k) = pair();
            let fake = fake_with_session();
            let limits = ServeLimits {
                idle: Duration::from_millis(300),
                ..ServeLimits::default()
            };
            let h = serve_bg(s, &fake, limits, CURRENT);
            let mut client = SessionClient::connect(c).unwrap();
            assert!(matches!(h.join().unwrap(), Err(SessionError::TimedOut)));
            assert!(client.list().is_err(), "the closed connection answered");
        });
    }

    #[test]
    fn resizes_are_limited_to_one_per_interval() {
        watchdog(60, || {
            let (c, s, _k) = pair();
            let fake = fake_with_session();
            let limits = ServeLimits {
                resize_interval: Duration::from_millis(400),
                ..ServeLimits::default()
            };
            let h = serve_bg(s, &fake, limits, CURRENT);
            let mut client = SessionClient::connect(c).unwrap();
            client.resize(1, 100, 30).unwrap();
            assert!(matches!(
                client.resize(1, 101, 30),
                Err(SessionError::RateLimited)
            ));
            std::thread::sleep(Duration::from_millis(450));
            client.resize(1, 102, 30).unwrap();
            assert_eq!(
                *fake.resizes.lock().unwrap(),
                vec![(1, 100, 30), (1, 102, 30)]
            );
            drop(client);
            h.join().unwrap().unwrap();
        });
    }

    #[test]
    fn a_resize_beyond_a_sane_terminal_is_refused() {
        watchdog(60, || {
            let (c, s, _k) = pair();
            let fake = fake_with_session();
            let limits = ServeLimits {
                resize_interval: Duration::ZERO,
                ..ServeLimits::default()
            };
            let h = serve_bg(s, &fake, limits, CURRENT);
            let mut client = SessionClient::connect(c).unwrap();
            assert!(client.resize(1, 10_000, 10_000).is_err());
            assert!(client.resize(1, MAX_DIM + 1, 30).is_err());
            assert!(client.resize(1, 100, MAX_DIM + 1).is_err());
            client.resize(1, MAX_DIM, MAX_DIM).unwrap();
            assert_eq!(*fake.resizes.lock().unwrap(), vec![(1, MAX_DIM, MAX_DIM)]);
            drop(client);
            h.join().unwrap().unwrap();
        });
    }

    #[test]
    fn a_peer_that_stops_reading_is_dropped_after_the_write_deadline() {
        watchdog(60, || {
            let (c, s, _k) = pair();
            let fake = fake_with_session();
            let limits = ServeLimits {
                write_deadline: Duration::from_millis(300),
                ..ServeLimits::default()
            };
            let h = serve_bg(s, &fake, limits, CURRENT);
            let client = SessionClient::connect(c).unwrap();
            // Attached, and then never read from: the socket buffers fill.
            let _stream = client.attach(1).unwrap();
            let tx = fake.take_sender();
            let end = Instant::now() + Duration::from_secs(30);
            while !h.is_finished() {
                assert!(Instant::now() < end, "the stalled peer was never dropped");
                let _ = tx.send(vec![b'x'; 64 * 1024]);
                std::thread::sleep(Duration::from_millis(1));
            }
            assert!(matches!(h.join().unwrap(), Err(SessionError::Io(_))));
            assert_eq!(*fake.closed.lock().unwrap(), vec![1]);
        });
    }

    #[test]
    fn list_is_capped_and_its_text_is_cut() {
        watchdog(60, || {
            let (c, s, _k) = pair();
            let fake = Arc::new(Fake::default());
            *fake.sessions.lock().unwrap() = (0..(MAX_LISTED as u32 + 100))
                .map(|id| SessionSummary {
                    title: "t".repeat(5000),
                    cwd: Some("c".repeat(5000)),
                    command: "m".repeat(5000),
                    ..summary(id)
                })
                .collect();
            let h = serve_bg(s, &fake, ServeLimits::default(), CURRENT);
            let mut client = SessionClient::connect(c).unwrap();
            let list = client.list().unwrap();
            assert_eq!(list.len(), MAX_LISTED);
            assert_eq!(list[0].title.chars().count(), MAX_TEXT_CHARS);
            assert_eq!(
                list[0].cwd.as_deref().unwrap().chars().count(),
                MAX_TEXT_CHARS
            );
            assert_eq!(list[0].command.chars().count(), MAX_TEXT_CHARS);
            drop(client);
            h.join().unwrap().unwrap();
        });
    }

    // --- through the handler --------------------------------------------

    #[test]
    fn list_and_resize_over_a_control_connection() {
        watchdog(60, || {
            let (c, s, _k) = pair();
            let fake = fake_with_session();
            let limits = ServeLimits {
                resize_interval: Duration::ZERO,
                ..ServeLimits::default()
            };
            let h = serve_bg(s, &fake, limits, CURRENT);
            let mut client = SessionClient::connect(c).unwrap();
            assert_eq!(client.list().unwrap(), vec![summary(1), summary(2)]);
            // The handler saw the identity the transport proved.
            assert_eq!(
                *fake.peers.lock().unwrap(),
                vec![PeerIdentity::Device(ENTRY.to_string())]
            );
            client.resize(1, 100, 30).unwrap();
            // A refused request does not end the connection.
            assert!(matches!(
                client.resize(9, 100, 30),
                Err(SessionError::NotFound)
            ));
            assert!(matches!(
                client.resize(1, 0, 30),
                Err(SessionError::Protocol(_))
            ));
            assert!(matches!(
                client.resize(1, 100, 1_001),
                Err(SessionError::Protocol(_))
            ));
            assert_eq!(client.list().unwrap().len(), 2);
            assert_eq!(*fake.resizes.lock().unwrap(), vec![(1, 100, 30)]);
            drop(client);
            h.join().unwrap().unwrap();
        });
    }

    #[test]
    fn attach_streams_snapshot_live_output_and_input() {
        watchdog(60, || {
            let (c, s, _k) = pair();
            let fake = fake_with_session();
            let h = serve_bg(s, &fake, ServeLimits::default(), CURRENT);
            let mut att = SessionClient::connect(c).unwrap().attach(1).unwrap();
            assert_eq!((att.cols, att.rows), (80, 24));
            let mut buf = [0u8; 4];
            att.reader.read_exact(&mut buf).unwrap();
            assert_eq!(&buf, b"snap");

            let tx = fake.take_sender();
            tx.send(b"live".to_vec()).unwrap();
            att.reader.read_exact(&mut buf).unwrap();
            assert_eq!(&buf, b"live");

            att.writer.write_all(b"ls").unwrap();
            att.writer.write_all(b"\n").unwrap();
            wait_until(|| fake.written_bytes(1) == b"ls\n");

            // The session ends: the client reads EOF, the server closes once.
            drop(tx);
            let mut rest = Vec::new();
            att.reader.read_to_end(&mut rest).unwrap();
            assert!(rest.is_empty());
            h.join().unwrap().unwrap();
            assert_eq!(*fake.closed.lock().unwrap(), vec![1]);
        });
    }

    #[test]
    fn a_peer_that_leaves_detaches_and_the_handler_is_closed_once() {
        watchdog(60, || {
            let (c, s, _k) = pair();
            let fake = fake_with_session();
            let h = serve_bg(s, &fake, ServeLimits::default(), CURRENT);
            let att = SessionClient::connect(c).unwrap().attach(1).unwrap();
            let tx = fake.take_sender();
            drop(att);
            h.join().unwrap().unwrap();
            assert_eq!(*fake.closed.lock().unwrap(), vec![1]);
            drop(tx);
        });
    }

    #[test]
    fn attaching_to_a_missing_session_is_a_typed_error_and_the_connection_survives() {
        watchdog(60, || {
            let (c, s, _k) = pair();
            let fake = fake_with_session();
            let h = serve_bg(s, &fake, ServeLimits::default(), CURRENT);
            let (mut r, mut w) = c.split();
            write_line(&mut *w, &Request::Hello { version: 1 }.to_line()).unwrap();
            assert!(matches!(raw_reply(&mut r), Response::Hello { .. }));
            write_line(&mut *w, &Request::Attach { id: 2 }.to_line()).unwrap();
            match raw_reply(&mut r) {
                Response::Error { code, .. } => assert_eq!(code, ErrorCode::NotFound),
                other => panic!("{other:?}"),
            }
            write_line(&mut *w, &Request::List.to_line()).unwrap();
            assert!(matches!(raw_reply(&mut r), Response::Sessions(_)));
            assert!(fake.closed.lock().unwrap().is_empty());
            drop(w);
            drop(r);
            h.join().unwrap().unwrap();
        });
    }

    #[test]
    fn an_attached_connection_with_no_input_can_be_idled_out() {
        watchdog(60, || {
            let (c, s, _k) = pair();
            let fake = fake_with_session();
            let limits = ServeLimits {
                attached_idle: Some(Duration::from_millis(300)),
                ..ServeLimits::default()
            };
            let h = serve_bg(s, &fake, limits, CURRENT);
            let _att = SessionClient::connect(c).unwrap().attach(1).unwrap();
            let _tx = fake.take_sender();
            h.join().unwrap().unwrap();
            assert_eq!(*fake.closed.lock().unwrap(), vec![1]);
        });
    }

    #[test]
    fn by_default_a_quiet_attached_connection_stays_open() {
        watchdog(60, || {
            let (c, s, _k) = pair();
            let fake = fake_with_session();
            let h = serve_bg(s, &fake, ServeLimits::default(), CURRENT);
            let mut att = SessionClient::connect(c).unwrap().attach(1).unwrap();
            let tx = fake.take_sender();
            std::thread::sleep(Duration::from_millis(600));
            assert!(!h.is_finished());
            let mut buf = [0u8; 4];
            att.reader.read_exact(&mut buf).unwrap();
            tx.send(b"late".to_vec()).unwrap();
            att.reader.read_exact(&mut buf).unwrap();
            assert_eq!(&buf, b"late");
            drop(att);
            h.join().unwrap().unwrap();
        });
    }

    #[test]
    fn a_handler_stuck_on_input_neither_grows_the_queue_nor_hangs_teardown() {
        watchdog(120, || {
            let (c, s, _k) = pair();
            let fake = fake_with_session();
            let limits = ServeLimits {
                input_queue: 2,
                input_chunk: 1024,
                ..ServeLimits::default()
            };
            let h = serve_bg(s, &fake, limits, CURRENT);
            let mut att = SessionClient::connect(c).unwrap().attach(1).unwrap();
            let tx = fake.take_sender();
            let gate = fake.write_gate.lock().unwrap();
            let mut writer = att.writer;
            let flood = std::thread::spawn(move || {
                let chunk = vec![b'x'; 1024];
                for _ in 0..16 * 1024 {
                    if writer.write_all(&chunk).is_err() {
                        break;
                    }
                }
            });
            std::thread::sleep(Duration::from_millis(500));
            // Nothing got through the blocked handler, and the server still ends
            // the stream promptly when the session does.
            assert!(fake.written.lock().unwrap().is_empty());
            drop(tx);
            h.join().unwrap().unwrap();
            drop(gate);
            let mut rest = Vec::new();
            let _ = att.reader.read_to_end(&mut rest);
            flood.join().unwrap();
        });
    }

    // --- refusal ---------------------------------------------------------

    #[test]
    fn a_refused_peer_gets_zero_bytes_and_no_session_runs() {
        watchdog(60, || {
            let (c, server_side, _k) = connect_pair(&[]);
            assert!(server_side.is_none(), "the empty allowlist admitted a peer");
            let (mut r, mut w) = c.split();
            // Even a well-formed hello is never answered.
            let _ = write_line(&mut *w, &Request::Hello { version: 1 }.to_line());
            let mut buf = [0u8; 8];
            match r.read(&mut buf) {
                Ok(0) | Err(_) => {}
                Ok(n) => panic!("a refused peer received {n} bytes"),
            }

            let (c, server_side, _k) = connect_pair(&[]);
            assert!(server_side.is_none());
            assert!(SessionClient::connect(c).is_err());
        });
    }
}
