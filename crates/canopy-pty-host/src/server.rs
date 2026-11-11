//! The host: owns PTYs and their child processes, keeps a bounded replay ring per
//! session, and serves the protocol on a Unix socket.
//!
//! Backpressure: while a client is attached the reader stops once the client is
//! `HIGH_WATER` bytes behind, so a stalled client blocks the child instead of
//! growing host memory. With no client attached, output drains into the ring and
//! the oldest bytes fall off (the client sees `gap` when it returns).

use crate::protocol::{AttachReply, Request, Response, SessionInfo, SpawnSpec, PROTOCOL_VERSION};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Replay kept per session.
pub const RING_CAP: usize = 4 * 1024 * 1024;
/// How far an attached client may fall behind before the child is paused.
/// Must stay below `RING_CAP` so unsent bytes are never trimmed.
pub const HIGH_WATER: usize = 2 * 1024 * 1024;
const READ_BUF: usize = 64 * 1024;
const SEND_CHUNK: usize = 64 * 1024;
const TERM_GRACE: Duration = Duration::from_secs(3);

pub struct ServerConfig {
    pub socket: PathBuf,
    /// The oldest client protocol this host serves (default `MIN_CLIENT_VERSION`).
    pub min_client: u32,
    /// Exit after this long with no live session and no connection.
    pub idle_exit: Duration,
    /// An exited session nobody reaped is dropped after this long.
    pub exited_ttl: Duration,
}

/// Default for `ServerConfig::exited_ttl`.
pub const EXITED_TTL: Duration = Duration::from_secs(600);

struct Ring {
    bytes: VecDeque<u8>,
    /// Absolute offset of `bytes[0]`.
    base: u64,
    /// Offset the attached client has been sent up to.
    attached: Option<u64>,
    /// Bumped per attach so a replaced connection stops quietly.
    generation: u64,
    eof: bool,
}

struct Session {
    id: u32,
    pid: u32,
    meta: Mutex<Option<String>>,
    key: Option<String>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    size: Mutex<(u16, u16)>,
    ring: Mutex<Ring>,
    cv: Condvar,
    exited: Mutex<Option<i32>>,
    exited_at: Mutex<Option<Instant>>,
    linger: Mutex<Option<Duration>>,
    /// When the last client detached (spawn time if none ever attached); None
    /// while a client is attached.
    detached_at: Mutex<Option<Instant>>,
    lingered: AtomicBool,
}

impl Session {
    fn exit_code(&self) -> Option<i32> {
        *self.exited.lock().unwrap()
    }

    /// Never signal a pid that has been reaped: it can be recycled.
    fn signal_group(&self, signal: libc::c_int) {
        if self.exit_code().is_none() {
            // SAFETY: plain kill(2) on the child's own process group.
            unsafe {
                libc::killpg(self.pid as libc::pid_t, signal);
            }
        }
    }

    fn info(&self) -> SessionInfo {
        let ring = self.ring.lock().unwrap();
        let (cols, rows) = *self.size.lock().unwrap();
        SessionInfo {
            id: self.id,
            pid: Some(self.pid),
            cols,
            rows,
            start: ring.base,
            end: ring.base + ring.bytes.len() as u64,
            exited: self.exit_code(),
            meta: self.meta.lock().unwrap().clone(),
            key: self.key.clone(),
            attached: Some(ring.attached.is_some()),
        }
    }
}

struct Host {
    /// Serialises spawn so two requests with one key cannot both start a session.
    spawn_lock: Mutex<()>,
    min_client: u32,
    sessions: Mutex<HashMap<u32, Arc<Session>>>,
    next_id: AtomicU32,
    connections: AtomicUsize,
    stop: Arc<AtomicBool>,
    state: Mutex<HashMap<String, String>>,
}

/// Session ids must not repeat across host lifetimes: a stale id held by an app
/// after the host restarted would otherwise address a different terminal.
fn id_seed() -> u32 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64 ^ d.as_secs().wrapping_mul(0x9E37_79B9))
        .unwrap_or(1);
    let mixed = nanos.wrapping_mul(0x2545_F491_4F6C_DD1D) ^ (std::process::id() as u64) << 7;
    // Leave room to count up without wrapping to 0.
    ((mixed >> 8) as u32 & 0x3fff_ffff).max(1)
}

static SIGNALLED: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_: libc::c_int) {
    SIGNALLED.store(true, Ordering::SeqCst);
}

fn peer_uid(stream: &UnixStream) -> Option<u32> {
    let fd = stream.as_raw_fd();
    #[cfg(target_os = "linux")]
    {
        // SAFETY: getsockopt writes a ucred of the stated length into `cred`.
        unsafe {
            let mut cred: libc::ucred = std::mem::zeroed();
            let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
            let rc = libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                &mut cred as *mut libc::ucred as *mut libc::c_void,
                &mut len,
            );
            return (rc == 0).then_some(cred.uid);
        }
    }
    #[cfg(target_os = "macos")]
    {
        // SAFETY: getpeereid writes two ids.
        unsafe {
            let mut uid: libc::uid_t = 0;
            let mut gid: libc::gid_t = 0;
            return (libc::getpeereid(fd, &mut uid, &mut gid) == 0).then_some(uid);
        }
    }
    #[allow(unreachable_code)]
    {
        let _ = fd;
        None
    }
}

fn raise_fd_limit() {
    // SAFETY: get/setrlimit with a properly initialised struct.
    unsafe {
        let mut limit: libc::rlimit = std::mem::zeroed();
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) == 0 {
            let want = 10_240.min(limit.rlim_max);
            if want > limit.rlim_cur {
                limit.rlim_cur = want;
                libc::setrlimit(libc::RLIMIT_NOFILE, &limit);
            }
        }
    }
}

/// Closes every inherited descriptor and leaves the launcher's directory: the
/// host lives for days and must not pin a socket or a working directory the app
/// happened to hold when it started us.
pub fn harden_process() {
    // SAFETY: closing descriptors this process does not use, chdir to root.
    unsafe {
        let mut limit: libc::rlimit = std::mem::zeroed();
        let max = if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) == 0 {
            // RLIM_INFINITY would wrap negative as an int and close nothing.
            limit.rlim_cur.min(65_536) as libc::c_int
        } else {
            1024
        };
        for fd in 3..max {
            libc::close(fd);
        }
        libc::chdir(c"/".as_ptr());
    }
}

/// Binds the socket, replacing a stale one, and serves until SIGTERM/SIGINT, a
/// `shutdown` request or idle exit. Exits quietly (Ok) if a live host already
/// owns the socket.
pub fn run(config: ServerConfig) -> std::io::Result<()> {
    raise_fd_limit();
    if let Some(dir) = config.socket.parent() {
        std::fs::create_dir_all(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    if UnixStream::connect(&config.socket).is_ok() {
        return Ok(());
    }
    let _ = std::fs::remove_file(&config.socket);
    let listener = UnixListener::bind(&config.socket)?;
    std::fs::set_permissions(&config.socket, std::fs::Permissions::from_mode(0o600))?;

    // SAFETY: the handler only stores to an atomic.
    unsafe {
        libc::signal(libc::SIGTERM, on_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, on_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = Arc::clone(&stop);
        thread::spawn(move || {
            while !SIGNALLED.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(50));
            }
            stop.store(true, Ordering::SeqCst);
        });
    }
    serve(listener, &config, stop)
}

/// The serving core, with no signal handling, so tests can run a host on a
/// thread. Unlinks the socket and stops accepting before it stops the children,
/// so a client arriving mid-shutdown fails fast instead of reaching a host that
/// is about to disappear.
pub fn serve(
    listener: UnixListener,
    config: &ServerConfig,
    stop: Arc<AtomicBool>,
) -> std::io::Result<()> {
    listener.set_nonblocking(true)?;
    let host = Arc::new(Host {
        spawn_lock: Mutex::new(()),
        min_client: config.min_client,
        sessions: Mutex::new(HashMap::new()),
        next_id: AtomicU32::new(id_seed()),
        connections: AtomicUsize::new(0),
        stop,
        state: Mutex::new(HashMap::new()),
    });
    let mut quiet_since = Instant::now();
    // SAFETY: geteuid has no preconditions.
    let my_uid = unsafe { libc::geteuid() };

    loop {
        if host.stop.load(Ordering::SeqCst) {
            break;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                if peer_uid(&stream).is_some_and(|uid| uid != my_uid) {
                    continue;
                }
                let _ = stream.set_nonblocking(false);
                host.connections.fetch_add(1, Ordering::SeqCst);
                let host = Arc::clone(&host);
                thread::spawn(move || {
                    let _ = handle(&host, stream);
                    host.connections.fetch_sub(1, Ordering::SeqCst);
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(30));
            }
            Err(_) => thread::sleep(Duration::from_millis(100)),
        }
        let live = {
            let mut sessions = host.sessions.lock().unwrap();
            // Drop exited sessions nobody reaped, so each cannot hold a ring
            // for the host's whole lifetime.
            sessions.retain(|_, s| {
                s.exited_at
                    .lock()
                    .unwrap()
                    .is_none_or(|at| at.elapsed() < config.exited_ttl)
            });
            for s in sessions.values() {
                if let (Some(linger), None) = (*s.linger.lock().unwrap(), s.exit_code()) {
                    let detached = *s.detached_at.lock().unwrap();
                    if detached.is_some_and(|at| at.elapsed() >= linger)
                        && !s.lingered.swap(true, Ordering::SeqCst)
                    {
                        s.signal_group(libc::SIGTERM);
                        let s = Arc::clone(s);
                        thread::spawn(move || {
                            thread::sleep(TERM_GRACE);
                            s.signal_group(libc::SIGKILL);
                        });
                    }
                }
            }
            sessions.values().any(|s| s.exit_code().is_none())
        };
        if live || host.connections.load(Ordering::SeqCst) > 0 {
            quiet_since = Instant::now();
        } else if quiet_since.elapsed() >= config.idle_exit {
            break;
        }
    }

    drop(listener);
    let _ = std::fs::remove_file(&config.socket);
    shutdown_sessions(&host);
    Ok(())
}

/// SIGTERM the groups, wait out the grace period, then SIGKILL stragglers.
fn shutdown_sessions(host: &Host) {
    let sessions: Vec<Arc<Session>> = host.sessions.lock().unwrap().values().cloned().collect();
    for s in &sessions {
        s.signal_group(libc::SIGTERM);
    }
    let deadline = Instant::now() + TERM_GRACE;
    while Instant::now() < deadline && sessions.iter().any(|s| s.exit_code().is_none()) {
        thread::sleep(Duration::from_millis(50));
    }
    for s in &sessions {
        s.signal_group(libc::SIGKILL);
    }
    thread::sleep(Duration::from_millis(100));
}

fn write_line<T: serde::Serialize>(stream: &mut UnixStream, value: &T) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    line.push(b'\n');
    stream.write_all(&line)
}

fn handle(host: &Arc<Host>, mut stream: UnixStream) -> std::io::Result<()> {
    let min_client = host.min_client;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut line = String::new();
    {
        // Read just the request line; raw bytes may follow an attach.
        let mut reader = BufReader::with_capacity(1, &stream);
        reader.read_line(&mut line)?;
    }
    stream.set_read_timeout(None)?;
    let request: Request = match serde_json::from_str(line.trim()) {
        Ok(request) => request,
        Err(e) => return write_line(&mut stream, &Response::err(format!("bad request: {e}"))),
    };
    match request {
        Request::Hello { client_version } => {
            // A client too old for this host is refused up front, so skew between
            // the app, a runner and a long-lived host fails at attach with a clear
            // message instead of as garbage later. 0 means "did not say".
            if client_version != 0 && client_version < min_client {
                return write_line(
                    &mut stream,
                    &Response {
                        error: Some(format!(
                            "client protocol {client_version} is older than this host accepts ({min_client})"
                        )),
                        version: Some(PROTOCOL_VERSION),
                        min_client: Some(min_client),
                        host_pid: Some(std::process::id()),
                        ..Default::default()
                    },
                );
            }
            write_line(
                &mut stream,
                &Response {
                    ok: true,
                    version: Some(PROTOCOL_VERSION),
                    min_client: Some(min_client),
                    host_pid: Some(std::process::id()),
                    ..Default::default()
                },
            )
        }
        Request::Spawn(spec) => {
            let reply = match spawn(host, spec) {
                Ok((session, existing)) => Response {
                    ok: true,
                    id: Some(session.id),
                    pid: Some(session.pid),
                    existing: Some(existing),
                    ..Default::default()
                },
                Err(e) => Response::err(e),
            };
            write_line(&mut stream, &reply)
        }
        Request::List => {
            let mut sessions: Vec<SessionInfo> = host
                .sessions
                .lock()
                .unwrap()
                .values()
                .map(|s| s.info())
                .collect();
            sessions.sort_by_key(|s| s.id);
            write_line(
                &mut stream,
                &Response {
                    ok: true,
                    sessions: Some(sessions),
                    ..Default::default()
                },
            )
        }
        Request::Resize { id, cols, rows } => {
            let reply = with_session(host, id, |s| {
                s.master
                    .lock()
                    .unwrap()
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|e| e.to_string())?;
                *s.size.lock().unwrap() = (cols, rows);
                Ok(Response::ok())
            });
            write_line(&mut stream, &reply)
        }
        Request::Kill { id } => {
            let reply = with_session(host, id, |s| {
                s.signal_group(libc::SIGTERM);
                let s = Arc::clone(s);
                thread::spawn(move || {
                    thread::sleep(TERM_GRACE);
                    s.signal_group(libc::SIGKILL);
                });
                Ok(Response::ok())
            });
            write_line(&mut stream, &reply)
        }
        Request::SetMeta { id, meta } => {
            let reply = with_session(host, id, |s| {
                *s.meta.lock().unwrap() = meta;
                Ok(Response::ok())
            });
            write_line(&mut stream, &reply)
        }
        Request::SetLinger { id, linger_secs } => {
            let reply = with_session(host, id, |s| {
                *s.linger.lock().unwrap() = linger_secs.map(Duration::from_secs);
                // Restart the clock from now so lifting then re-imposing a
                // limit does not kill a session that has been unattended a while.
                // Under the ring lock, like attach, so the check and the stamp
                // cannot straddle an attach that clears `detached_at`.
                let _ring = s.ring.lock().unwrap();
                let mut detached = s.detached_at.lock().unwrap();
                if detached.is_some() {
                    *detached = Some(Instant::now());
                }
                Ok(Response::ok())
            });
            write_line(&mut stream, &reply)
        }
        Request::SetState {
            key,
            value,
            if_unset,
        } => {
            let mut state = host.state.lock().unwrap();
            if !(if_unset && state.contains_key(&key)) {
                state.insert(key.clone(), value);
            }
            let reply = Response {
                ok: true,
                value: state.get(&key).cloned(),
                ..Default::default()
            };
            drop(state);
            write_line(&mut stream, &reply)
        }
        Request::GetState { key } => {
            let reply = Response {
                ok: true,
                value: host.state.lock().unwrap().get(&key).cloned(),
                ..Default::default()
            };
            write_line(&mut stream, &reply)
        }
        Request::Pgrp { id } => {
            let reply = with_session(host, id, |s| {
                let pgrp = s.master.lock().unwrap().process_group_leader();
                Ok(Response {
                    ok: true,
                    pgrp,
                    ..Default::default()
                })
            });
            write_line(&mut stream, &reply)
        }
        Request::RawMode { id } => {
            let reply = with_session(host, id, |s| {
                let master = s.master.lock().unwrap();
                let raw = master.as_raw_fd().map(|fd| {
                    // SAFETY: fd belongs to the live master held under the lock.
                    unsafe {
                        let mut t: libc::termios = std::mem::zeroed();
                        libc::tcgetattr(fd, &mut t) == 0 && t.c_lflag & libc::ICANON == 0
                    }
                });
                Ok(Response {
                    ok: true,
                    raw,
                    ..Default::default()
                })
            });
            write_line(&mut stream, &reply)
        }
        Request::Reap { id } => {
            let mut sessions = host.sessions.lock().unwrap();
            let reply = match sessions.get(&id) {
                Some(s) if s.exit_code().is_some() => {
                    sessions.remove(&id);
                    Response::ok()
                }
                Some(_) => Response::err("session is still running"),
                None => Response::err("no such session"),
            };
            drop(sessions);
            write_line(&mut stream, &reply)
        }
        Request::Attach {
            id,
            after,
            client_version,
        } => {
            if client_version != 0 && client_version < min_client {
                return write_line(
                    &mut stream,
                    &AttachReply {
                        error: Some(format!(
                            "client protocol {client_version} is older than this host accepts ({min_client})"
                        )),
                        ..Default::default()
                    },
                );
            }
            let session = host.sessions.lock().unwrap().get(&id).cloned();
            match session {
                Some(session) => attach(session, stream, after),
                None => write_line(
                    &mut stream,
                    &AttachReply {
                        error: Some("no such session".into()),
                        ..Default::default()
                    },
                ),
            }
        }
        Request::Shutdown => {
            write_line(&mut stream, &Response::ok())?;
            host.stop.store(true, Ordering::SeqCst);
            Ok(())
        }
    }
}

fn with_session(
    host: &Host,
    id: u32,
    f: impl FnOnce(&Arc<Session>) -> Result<Response, String>,
) -> Response {
    let session = host.sessions.lock().unwrap().get(&id).cloned();
    match session {
        Some(session) => f(&session).unwrap_or_else(Response::err),
        None => Response::err("no such session"),
    }
}

/// Returns the session and whether it already existed for the spawn's key.
fn spawn(host: &Arc<Host>, spec: SpawnSpec) -> Result<(Arc<Session>, bool), String> {
    let _one_spawn_at_a_time = host.spawn_lock.lock().unwrap();
    if let Some(key) = &spec.key {
        let existing = host
            .sessions
            .lock()
            .unwrap()
            .values()
            .find(|s| s.key.as_deref() == Some(key.as_str()))
            .cloned();
        if let Some(session) = existing {
            return Ok((session, true));
        }
    }
    let Some(program) = spec.argv.first() else {
        return Err("empty argv".into());
    };
    let size = PtySize {
        rows: spec.rows.max(1),
        cols: spec.cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(program);
    cmd.args(&spec.argv[1..]);
    // Exactly the caller's environment, never the host's own.
    cmd.env_clear();
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    if let Some(cwd) = &spec.cwd {
        cmd.cwd(cwd);
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let pid = child.process_id().ok_or("child has no pid")?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let session = Arc::new(Session {
        id: host.next_id.fetch_add(1, Ordering::SeqCst),
        pid,
        meta: Mutex::new(spec.meta),
        key: spec.key,
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        size: Mutex::new((size.cols, size.rows)),
        ring: Mutex::new(Ring {
            bytes: VecDeque::new(),
            base: 0,
            attached: None,
            generation: 0,
            eof: false,
        }),
        cv: Condvar::new(),
        exited: Mutex::new(None),
        exited_at: Mutex::new(None),
        linger: Mutex::new(spec.linger_secs.map(Duration::from_secs)),
        detached_at: Mutex::new(Some(Instant::now())),
        lingered: AtomicBool::new(false),
    });

    // Reaper: records the exit status. Only after this may the pid be reused.
    {
        let session = Arc::clone(&session);
        thread::spawn(move || {
            let code = match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(_) => -1,
            };
            *session.exited.lock().unwrap() = Some(code);
            *session.exited_at.lock().unwrap() = Some(Instant::now());
            session.cv.notify_all();
        });
    }
    // Reader: output -> ring, paused while the attached client is too far behind.
    {
        let session = Arc::clone(&session);
        thread::spawn(move || {
            let mut buf = vec![0u8; READ_BUF];
            loop {
                {
                    let mut ring = session.ring.lock().unwrap();
                    while let Some(sent) = ring.attached {
                        let end = ring.base + ring.bytes.len() as u64;
                        if end.saturating_sub(sent) as usize > HIGH_WATER {
                            ring = session.cv.wait(ring).unwrap();
                        } else {
                            break;
                        }
                    }
                }
                let n = match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let mut ring = session.ring.lock().unwrap();
                ring.bytes.extend(&buf[..n]);
                let over = ring.bytes.len().saturating_sub(RING_CAP);
                if over > 0 {
                    ring.bytes.drain(..over);
                    ring.base += over as u64;
                }
                session.cv.notify_all();
            }
            let mut ring = session.ring.lock().unwrap();
            ring.eof = true;
            session.cv.notify_all();
        });
    }

    host.sessions
        .lock()
        .unwrap()
        .insert(session.id, Arc::clone(&session));
    Ok((session, false))
}

fn attach(session: Arc<Session>, mut stream: UnixStream, after: u64) -> std::io::Result<()> {
    let (start, generation, cols, rows) = {
        let mut ring = session.ring.lock().unwrap();
        let end = ring.base + ring.bytes.len() as u64;
        let start = after.max(ring.base).min(end);
        ring.generation += 1;
        ring.attached = Some(start);
        // Under the ring lock and after the bump: an older connection's input
        // thread stamps `detached_at` only while it still owns the generation,
        // so clearing earlier would let that stamp land after ours and start a
        // linger clock on a session that is attached.
        *session.detached_at.lock().unwrap() = None;
        session.cv.notify_all();
        let (cols, rows) = *session.size.lock().unwrap();
        (start, ring.generation, cols, rows)
    };
    let reply = {
        let ring = session.ring.lock().unwrap();
        AttachReply {
            ok: true,
            error: None,
            version: PROTOCOL_VERSION,
            start,
            end: ring.base + ring.bytes.len() as u64,
            gap: after < ring.base,
            cols,
            rows,
        }
    };
    write_line(&mut stream, &reply)?;

    // Client -> PTY. Dropping the connection only detaches. This thread is also
    // what notices the client is gone while the child is silent, so the output
    // loop below (which only finds out on a write) stops, a paused reader is
    // released, and the linger clock starts.
    let mut input = stream.try_clone()?;
    let closed = Arc::new(AtomicBool::new(false));
    {
        let session = Arc::clone(&session);
        let closed = Arc::clone(&closed);
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = input.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut writer = session.writer.lock().unwrap();
                if writer.write_all(&buf[..n]).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
            closed.store(true, Ordering::SeqCst);
            let mut ring = session.ring.lock().unwrap();
            if ring.generation == generation {
                ring.attached = None;
                *session.detached_at.lock().unwrap() = Some(Instant::now());
            }
            session.cv.notify_all();
        });
    }

    // PTY -> client.
    let mut pos = start;
    loop {
        let chunk: Vec<u8> = {
            let mut ring = session.ring.lock().unwrap();
            loop {
                if ring.generation != generation || closed.load(Ordering::SeqCst) {
                    return Ok(()); // replaced by a newer attach, or the client left
                }
                let end = ring.base + ring.bytes.len() as u64;
                if pos < end {
                    let offset = (pos - ring.base) as usize;
                    let take = (end - pos).min(SEND_CHUNK as u64) as usize;
                    let (a, b) = ring.bytes.as_slices();
                    let mut out = Vec::with_capacity(take);
                    if offset < a.len() {
                        let from_a = (a.len() - offset).min(take);
                        out.extend_from_slice(&a[offset..offset + from_a]);
                        out.extend_from_slice(&b[..take - from_a]);
                    } else {
                        let o = offset - a.len();
                        out.extend_from_slice(&b[o..o + take]);
                    }
                    break out;
                }
                if ring.eof {
                    ring.attached = None;
                    session.cv.notify_all();
                    drop(ring);
                    let _ = stream.shutdown(std::net::Shutdown::Write);
                    return Ok(());
                }
                ring = session
                    .cv
                    .wait_timeout(ring, Duration::from_millis(500))
                    .unwrap()
                    .0;
            }
        };
        if stream.write_all(&chunk).is_err() {
            let mut ring = session.ring.lock().unwrap();
            if ring.generation == generation {
                ring.attached = None;
                *session.detached_at.lock().unwrap() = Some(Instant::now());
            }
            session.cv.notify_all();
            return Ok(());
        }
        pos += chunk.len() as u64;
        let mut ring = session.ring.lock().unwrap();
        if ring.generation == generation {
            ring.attached = Some(pos);
            session.cv.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn high_water_is_below_ring_capacity() {
        // Unsent bytes must never be trimmed out from under an attached client.
        assert!(HIGH_WATER + READ_BUF < RING_CAP);
    }
}
