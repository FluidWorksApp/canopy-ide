//! App-side client for the host. `HostMaster` and `HostChild` implement
//! portable-pty's `MasterPty` and `Child`, so a hosted session can sit inside the
//! app's existing `Session` unchanged (reader, writer, resize, kill and wait all
//! keep their shapes).

use crate::protocol::{
    AttachReply, Request, Response, SessionInfo, SpawnSpec, EXCLUSIVE_ATTACH_VERSION,
    MIN_HOST_VERSION, PROTOCOL_VERSION,
};
use portable_pty::{Child, ChildKiller, ExitStatus, MasterPty, PtySize};
use std::io::{Read, Write};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const CALL_TIMEOUT: Duration = Duration::from_secs(5);
/// pgrp and raw-mode answers are asked under the app's `master` lock, so a hung
/// host must not hold it for the full call timeout.
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);

fn other(message: impl Into<String>) -> std::io::Error {
    std::io::Error::other(message.into())
}

fn read_line(stream: &mut UnixStream) -> std::io::Result<String> {
    // One byte at a time: the bytes after an attach reply belong to the caller.
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        if stream.read(&mut byte)? == 0 {
            return Err(other("host closed the connection"));
        }
        if byte[0] == b'\n' {
            break;
        }
        line.push(byte[0]);
        if line.len() > 1 << 20 {
            return Err(other("reply too long"));
        }
    }
    String::from_utf8(line).map_err(|_| other("reply was not utf-8"))
}

/// Run on the host executable immediately before it is started, every time
/// (first start and restarts). An error stops the start; the app uses it to
/// re-hash the installed copy.
#[derive(Clone)]
pub struct LaunchCheck(pub std::sync::Arc<dyn Fn(&Path) -> std::io::Result<()> + Send + Sync>);

impl std::fmt::Debug for LaunchCheck {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LaunchCheck")
    }
}

#[derive(Clone, Debug)]
struct Launch {
    exe: PathBuf,
    idle_secs: u64,
    check: Option<LaunchCheck>,
}

#[derive(Clone, Debug)]
pub struct HostClient {
    socket: PathBuf,
    /// Where to start a host from and how long it idles. Used only by `spawn`:
    /// restarting the host from any other call would resurrect a dead host from a
    /// liveness probe and let a stale id address a different terminal.
    launch: Option<Launch>,
}

/// What a `hello` said about the host at the socket.
#[derive(Debug)]
pub enum HelloOutcome {
    /// It answers and each side accepts the other.
    Compatible,
    /// No socket, or nobody listening.
    NoHost,
    /// It answered, but it refuses this client or is older than this client can
    /// use. It can still `list`, `kill` and `shutdown`.
    Skewed {
        version: Option<u32>,
        min_client: Option<u32>,
        host_pid: Option<u32>,
    },
    /// Anything else (a timeout, a garbled reply): nothing is known.
    Unknown(std::io::Error),
}

/// Classifies a raw `hello` reply (one that is returned even when refused).
pub fn classify_hello(reply: std::io::Result<Response>) -> HelloOutcome {
    match reply {
        Ok(r) if r.ok && r.version.is_some_and(|v| v >= MIN_HOST_VERSION) => {
            HelloOutcome::Compatible
        }
        Ok(r) => HelloOutcome::Skewed {
            version: r.version,
            min_client: r.min_client,
            host_pid: r.host_pid,
        },
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
            ) =>
        {
            HelloOutcome::NoHost
        }
        Err(e) => HelloOutcome::Unknown(e),
    }
}

/// What to do about a skewed host, from its `list`.
#[derive(Debug, PartialEq)]
pub enum SkewAction {
    /// Nothing is running in it: stop it and start ours.
    Replace,
    /// It still runs this many terminals (`None`: it could not be listed):
    /// leave it for them.
    Keep(Option<usize>),
}

/// Every session that has not exited counts, adoptable or not: stopping the
/// host would kill it.
pub fn skew_action(listed: &std::io::Result<Vec<SessionInfo>>) -> SkewAction {
    match listed {
        Ok(sessions) => match sessions.iter().filter(|s| s.exited.is_none()).count() {
            0 => SkewAction::Replace,
            n => SkewAction::Keep(Some(n)),
        },
        Err(_) => SkewAction::Keep(None),
    }
}

/// The answer to `shutdown_if_idle`.
#[derive(Debug, PartialEq)]
pub enum IdleShutdown {
    /// The host was idle and is stopping; it takes no more spawns.
    Stopping,
    /// It runs this many sessions and was left running.
    Busy(usize),
    /// A host older than `SHUTDOWN_IF_IDLE_VERSION` does not know the op.
    Unsupported,
    /// Any other refusal.
    Failed(String),
}

pub fn classify_idle_shutdown(reply: &Response) -> IdleShutdown {
    if reply.ok {
        return IdleShutdown::Stopping;
    }
    match reply.error.as_deref() {
        Some(crate::protocol::BUSY) => IdleShutdown::Busy(reply.running.unwrap_or(0)),
        Some(e) if e.starts_with("bad request") => IdleShutdown::Unsupported,
        other => IdleShutdown::Failed(other.unwrap_or("host error").to_owned()),
    }
}

pub struct Attached {
    pub stream: UnixStream,
    pub start: u64,
    pub end: u64,
    pub gap: bool,
    pub cols: u16,
    pub rows: u16,
}

impl HostClient {
    pub fn new(socket: impl Into<PathBuf>) -> Self {
        HostClient {
            socket: socket.into(),
            launch: None,
        }
    }

    pub fn with_launch(mut self, host_exe: impl Into<PathBuf>, idle_secs: u64) -> Self {
        self.launch = Some(Launch {
            exe: host_exe.into(),
            idle_secs,
            check: None,
        });
        self
    }

    fn with_launch_checked(
        mut self,
        host_exe: &Path,
        idle_secs: u64,
        check: Option<LaunchCheck>,
    ) -> Self {
        self.launch = Some(Launch {
            exe: host_exe.to_path_buf(),
            idle_secs,
            check,
        });
        self
    }

    pub fn socket(&self) -> &Path {
        &self.socket
    }

    fn connect(&self) -> std::io::Result<UnixStream> {
        let stream = UnixStream::connect(&self.socket)?;
        stream.set_read_timeout(Some(CALL_TIMEOUT))?;
        stream.set_write_timeout(Some(CALL_TIMEOUT))?;
        Ok(stream)
    }

    fn call(&self, request: &Request) -> std::io::Result<Response> {
        self.call_timeout(request, CALL_TIMEOUT)
    }

    /// For read-only requests: one connection that the host drops without a reply
    /// (seen on macOS while a session floods output) is retried once on a fresh
    /// connection. A host that is really gone fails the retry too, with its own
    /// error. Never used for spawn, which must not run twice.
    fn call_read_only(&self, request: &Request, timeout: Duration) -> std::io::Result<Response> {
        match self.call_timeout(request, timeout) {
            Err(e) if e.to_string().contains("host closed the connection") => {
                self.call_timeout(request, timeout)
            }
            other => other,
        }
    }

    fn call_timeout(&self, request: &Request, timeout: Duration) -> std::io::Result<Response> {
        let reply = self.call_raw(request, timeout)?;
        if reply.ok {
            Ok(reply)
        } else {
            Err(other(reply.error.unwrap_or_else(|| "host error".into())))
        }
    }

    /// The parsed reply, whether or not the host said ok.
    fn call_raw(&self, request: &Request, timeout: Duration) -> std::io::Result<Response> {
        let mut stream = UnixStream::connect(&self.socket)?;
        stream.set_read_timeout(Some(timeout))?;
        stream.set_write_timeout(Some(timeout))?;
        let mut line = serde_json::to_vec(request).map_err(other_err)?;
        line.push(b'\n');
        stream.write_all(&line)?;
        serde_json::from_str(&read_line(&mut stream)?).map_err(other_err)
    }

    /// `hello`'s reply even when the host refuses this client, so a caller can
    /// tell a skewed host (it answered with its version) from no host or a
    /// host that did not answer.
    pub fn hello_raw(&self) -> std::io::Result<Response> {
        self.call_raw(
            &Request::Hello {
                client_version: PROTOCOL_VERSION,
            },
            CALL_TIMEOUT,
        )
    }

    /// Fails if the host is older than this client can use, or refuses this
    /// client as too old, so skew shows up here and not as misread bytes later.
    pub fn hello(&self) -> std::io::Result<Response> {
        let reply = self.call(&Request::Hello {
            client_version: PROTOCOL_VERSION,
        })?;
        match reply.version {
            Some(version) if version >= MIN_HOST_VERSION => Ok(reply),
            seen => Err(other(format!(
                "host speaks protocol {seen:?}, this client needs {MIN_HOST_VERSION} or newer"
            ))),
        }
    }

    /// The one call that may start a host: an idle host can be exiting just as we
    /// arrive, and a new terminal should not fail for that.
    pub fn spawn(&self, spec: SpawnSpec) -> std::io::Result<(u32, u32)> {
        self.spawn_keyed(spec).map(|(id, pid, _)| (id, pid))
    }

    /// As `spawn`, also reporting whether the spec's `key` matched an existing
    /// session (idempotent spawn): `(id, pid, existing)`.
    pub fn spawn_keyed(&self, spec: SpawnSpec) -> std::io::Result<(u32, u32, bool)> {
        if let Some(launch) = &self.launch {
            if self.hello().is_err() {
                HostClient::ensure_running_checked(
                    &launch.exe,
                    &self.socket,
                    launch.idle_secs,
                    &[],
                    launch.check.clone(),
                )?;
            }
        }
        let reply = self.call(&Request::Spawn(spec))?;
        Ok((
            reply.id.ok_or_else(|| other("no id in reply"))?,
            reply.pid.ok_or_else(|| other("no pid in reply"))?,
            reply.existing.unwrap_or(false),
        ))
    }

    /// `list` with its own bound, for the launch path where the app must not
    /// wait out the default five seconds on a host that does not answer.
    pub fn list_within(&self, timeout: Duration) -> std::io::Result<Vec<SessionInfo>> {
        Ok(self
            .call_read_only(&Request::List, timeout)?
            .sessions
            .unwrap_or_default())
    }

    pub fn list(&self) -> std::io::Result<Vec<SessionInfo>> {
        Ok(self
            .call_read_only(&Request::List, CALL_TIMEOUT)?
            .sessions
            .unwrap_or_default())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> std::io::Result<()> {
        self.call(&Request::Resize { id, cols, rows }).map(|_| ())
    }

    pub fn kill(&self, id: u32) -> std::io::Result<()> {
        self.call(&Request::Kill { id }).map(|_| ())
    }

    pub fn reap(&self, id: u32) -> std::io::Result<()> {
        self.call(&Request::Reap { id }).map(|_| ())
    }

    pub fn set_meta(&self, id: u32, meta: Option<String>) -> std::io::Result<()> {
        self.call(&Request::SetMeta { id, meta }).map(|_| ())
    }

    /// Change a session's linger; `None` lifts the limit.
    pub fn set_linger(&self, id: u32, linger_secs: Option<u64>) -> std::io::Result<()> {
        self.call(&Request::SetLinger { id, linger_secs })
            .map(|_| ())
    }

    /// Store `value` under `key` for this host's lifetime. With `if_unset` the
    /// first caller wins; either way the stored value is returned.
    pub fn set_state(
        &self,
        key: &str,
        value: &str,
        if_unset: bool,
    ) -> std::io::Result<Option<String>> {
        Ok(self
            .call(&Request::SetState {
                key: key.into(),
                value: value.into(),
                if_unset,
            })?
            .value)
    }

    pub fn get_state(&self, key: &str) -> std::io::Result<Option<String>> {
        Ok(self.call(&Request::GetState { key: key.into() })?.value)
    }

    pub fn pgrp(&self, id: u32) -> std::io::Result<Option<i32>> {
        Ok(self
            .call_read_only(&Request::Pgrp { id }, PROBE_TIMEOUT)?
            .pgrp)
    }

    pub fn raw_mode(&self, id: u32) -> std::io::Result<bool> {
        Ok(self
            .call_read_only(&Request::RawMode { id }, PROBE_TIMEOUT)?
            .raw
            .unwrap_or(false))
    }

    pub fn shutdown(&self) -> std::io::Result<()> {
        self.call(&Request::Shutdown).map(|_| ())
    }

    /// Stops the host only if it runs nothing, decided by the host under the
    /// lock spawns take (see `Request::ShutdownIfIdle`).
    pub fn shutdown_if_idle(&self) -> std::io::Result<IdleShutdown> {
        let reply = self.call_raw(&Request::ShutdownIfIdle, CALL_TIMEOUT)?;
        Ok(classify_idle_shutdown(&reply))
    }

    /// Opens the data connection: the reply, then raw bytes from `start` both ways.
    /// Replaces any client already attached.
    pub fn attach(&self, id: u32, after: u64) -> std::io::Result<Attached> {
        self.attach_with(id, after, false)
    }

    /// As `attach`, but fails with the error "busy"
    /// if another client is attached, checked atomically by the host. Refuses an
    /// older host, which would ignore the flag and take the session over.
    pub fn attach_exclusive(&self, id: u32, after: u64) -> std::io::Result<Attached> {
        self.require_version(EXCLUSIVE_ATTACH_VERSION, "exclusive attach")?;
        self.attach_with(id, after, true)
    }

    /// Replay-ring bytes from `after` (at most `max`), without attaching: the
    /// attached client, backpressure and linger are untouched.
    pub fn read_ring(
        &self,
        id: u32,
        after: u64,
        max: Option<u64>,
    ) -> std::io::Result<(AttachReply, Vec<u8>)> {
        let mut stream = self.connect()?;
        let mut line =
            serde_json::to_vec(&Request::ReadRing { id, after, max }).map_err(other_err)?;
        line.push(b'\n');
        stream.write_all(&line)?;
        let reply: AttachReply = serde_json::from_str(&read_line(&mut stream).map_err(|e| {
            // A version 1-2 host answers an unknown op with a `Response` error line
            // or closes; say what is missing rather than a parse error.
            other(format!(
                "host cannot read the ring (needs protocol {EXCLUSIVE_ATTACH_VERSION}): {e}"
            ))
        })?)
        .map_err(other_err)?;
        if !reply.ok {
            return Err(other(
                reply.error.unwrap_or_else(|| "read_ring refused".into()),
            ));
        }
        let mut bytes = vec![0u8; reply.len as usize];
        stream.read_exact(&mut bytes)?;
        Ok((reply, bytes))
    }

    fn require_version(&self, needed: u32, what: &str) -> std::io::Result<()> {
        match self.hello()?.version {
            Some(v) if v >= needed => Ok(()),
            seen => Err(other(format!(
                "host speaks protocol {seen:?}; {what} needs {needed} or newer"
            ))),
        }
    }

    fn attach_with(&self, id: u32, after: u64, exclusive: bool) -> std::io::Result<Attached> {
        let mut stream = self.connect()?;
        let mut line = serde_json::to_vec(&Request::Attach {
            id,
            after,
            client_version: PROTOCOL_VERSION,
            exclusive,
        })
        .map_err(other_err)?;
        line.push(b'\n');
        stream.write_all(&line)?;
        let reply: AttachReply =
            serde_json::from_str(&read_line(&mut stream)?).map_err(other_err)?;
        if !reply.ok {
            return Err(other(
                reply.error.unwrap_or_else(|| "attach refused".into()),
            ));
        }
        if reply.version != 0 && reply.version < MIN_HOST_VERSION {
            return Err(other(format!(
                "host speaks protocol {}, this client needs {MIN_HOST_VERSION} or newer",
                reply.version
            )));
        }
        // From here the connection carries raw output; reads block until bytes.
        stream.set_read_timeout(None)?;
        stream.set_write_timeout(None)?;
        Ok(Attached {
            stream,
            start: reply.start,
            end: reply.end,
            gap: reply.gap,
            cols: reply.cols,
            rows: reply.rows,
        })
    }

    /// Connects to a running host, or starts a detached one. Serialised with a
    /// lock file so two apps starting together create one host.
    pub fn ensure_running(
        host_exe: &Path,
        socket: &Path,
        idle_secs: u64,
    ) -> std::io::Result<HostClient> {
        Self::ensure_running_with(host_exe, socket, idle_secs, &[])
    }

    /// As `ensure_running`, passing extra arguments to a host it has to start.
    pub fn ensure_running_with(
        host_exe: &Path,
        socket: &Path,
        idle_secs: u64,
        extra_args: &[&str],
    ) -> std::io::Result<HostClient> {
        Self::ensure_running_checked(host_exe, socket, idle_secs, extra_args, None)
    }

    /// As `ensure_running_with`, running `check` on `host_exe` right before any
    /// start, including restarts by the returned client's `spawn`.
    ///
    /// A host that answers but speaks an incompatible protocol (a newer app's
    /// host after a downgrade, or an older one after a minimum-version bump)
    /// cannot be replaced by just starting ours: ours would see the live socket
    /// and exit. If it runs no terminals it is shut down and ours started; if it
    /// does, it is left running for them and this fails with a message saying
    /// so, and the caller uses in-process terminals until they are gone.
    pub fn ensure_running_checked(
        host_exe: &Path,
        socket: &Path,
        idle_secs: u64,
        extra_args: &[&str],
        check: Option<LaunchCheck>,
    ) -> std::io::Result<HostClient> {
        // Probe with a client that cannot restart the host: `call` retries through
        // this function, so probing with the retrying client would recurse forever.
        let client = HostClient::new(socket);
        if client.hello().is_ok() {
            return Ok(client.with_launch_checked(host_exe, idle_secs, check));
        }
        let dir = socket
            .parent()
            .ok_or_else(|| other("socket has no parent"))?;
        crate::server::prepare_socket_dir(dir)?;
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join("host.lock"))?;
        // SAFETY: flock on a descriptor we own; released when `lock` drops.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        match classify_hello(client.hello_raw()) {
            HelloOutcome::Compatible => {
                return Ok(client.with_launch_checked(host_exe, idle_secs, check));
            }
            HelloOutcome::Skewed {
                version,
                min_client,
                host_pid,
            } => match skew_action(&client.list_within(SKEW_LIST_WAIT)) {
                SkewAction::Replace => match stop_skewed_host(&client) {
                    SkewStop::Stopping => wait_for_host_gone(socket, host_pid)?,
                    SkewStop::Keep(running) => {
                        return Err(skew_kept_error(version, min_client, running));
                    }
                },
                SkewAction::Keep(running) => {
                    return Err(skew_kept_error(version, min_client, running));
                }
            },
            HelloOutcome::NoHost | HelloOutcome::Unknown(_) => {}
        }
        if let Some(check) = &check {
            (check.0)(host_exe)?;
        }
        let mut command = Command::new(host_exe);
        command
            .arg("--socket")
            .arg(socket)
            .arg("--idle-secs")
            .arg(idle_secs.to_string())
            .args(extra_args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // Hygiene: the long-lived host does not inherit the app's dynamic-loader
        // overrides. (It does not stop anyone starting the binary by hand.)
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("DYLD_") {
                command.env_remove(key);
            }
        }
        // SAFETY: setsid in the forked child before exec, no allocation.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        // Keeps its kind (PermissionDenied on a noexec mount) for the caller.
        let mut child = command.spawn().map_err(|e| {
            std::io::Error::new(e.kind(), format!("starting {}: {e}", host_exe.display()))
        })?;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if client.hello().is_ok() {
                // The host is a detached daemon now; reap our handle quietly.
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Ok(client.with_launch_checked(host_exe, idle_secs, check));
            }
            if let Ok(Some(status)) = child.try_wait() {
                return Err(other(format!("host exited at startup: {status}")));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        Err(other("host did not start in time"))
    }
}

enum SkewStop {
    Stopping,
    Keep(Option<usize>),
}

/// Stops a skewed host that `list` showed idle, without killing a session a
/// compatible client started since. A host that serves `shutdown_if_idle`
/// decides atomically. An older one cannot: it is listed once more right before
/// `shutdown`, which narrows that window to the gap between those two calls.
fn stop_skewed_host(client: &HostClient) -> SkewStop {
    match client.shutdown_if_idle() {
        Ok(IdleShutdown::Stopping) => SkewStop::Stopping,
        Ok(IdleShutdown::Busy(n)) => SkewStop::Keep(Some(n)),
        Ok(IdleShutdown::Unsupported) => match skew_action(&client.list_within(SKEW_LIST_WAIT)) {
            SkewAction::Replace => {
                let _ = client.shutdown();
                SkewStop::Stopping
            }
            SkewAction::Keep(n) => SkewStop::Keep(n),
        },
        Ok(IdleShutdown::Failed(_)) | Err(_) => SkewStop::Keep(None),
    }
}

fn skew_kept_error(
    version: Option<u32>,
    min_client: Option<u32>,
    running: Option<usize>,
) -> std::io::Error {
    let shown = |v: Option<u32>| v.map_or_else(|| "?".into(), |v| v.to_string());
    let running = running.map_or_else(|| "some".into(), |n| n.to_string());
    other(format!(
        "an incompatible PTY host is still running {running} terminal(s) \
         (it speaks protocol {} and accepts clients from {}; this client \
         speaks {PROTOCOL_VERSION} and needs a host of {MIN_HOST_VERSION} or \
         newer). It is left running for them; new terminals cannot use it \
         until they exit",
        shown(version),
        shown(min_client),
    ))
}

/// How long a skewed host gets to answer `list`.
const SKEW_LIST_WAIT: Duration = Duration::from_secs(1);
/// How long a skewed host gets to go after `shutdown`.
const SKEW_EXIT_WAIT: Duration = Duration::from_secs(5);

/// After `shutdown`: the old host removes its socket path once, after it stops
/// accepting and before it stops its children. A new host must not bind before
/// that removal or the old one would delete the new socket, so wait for the
/// path itself to go (not just for connections to be refused), then, best
/// effort, for the old process to exit.
fn wait_for_host_gone(socket: &Path, host_pid: Option<u32>) -> std::io::Result<()> {
    let deadline = Instant::now() + SKEW_EXIT_WAIT;
    while std::fs::symlink_metadata(socket).is_ok() {
        if Instant::now() >= deadline {
            return Err(other(
                "an incompatible PTY host was asked to stop but its socket is still there",
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    if let Some(pid) = host_pid.and_then(|p| libc::pid_t::try_from(p).ok()) {
        // SAFETY: signal 0 only checks that the process exists.
        while unsafe { libc::kill(pid, 0) } == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    Ok(())
}

fn other_err<E: std::error::Error + Send + Sync + 'static>(e: E) -> std::io::Error {
    std::io::Error::other(e)
}

/// A hosted session's master side. Reader and writer are two handles on the one
/// attach connection, so dropping them detaches without touching the child.
pub struct HostMaster {
    client: HostClient,
    id: u32,
    stream: UnixStream,
    size: Mutex<(u16, u16)>,
}

impl HostMaster {
    pub fn attach(
        client: HostClient,
        id: u32,
        after: u64,
    ) -> std::io::Result<(HostMaster, Attached)> {
        let attached = client.attach(id, after)?;
        HostMaster::wrap(client, id, attached)
    }

    /// As `attach`, but refused with `BUSY` if another client holds the session
    /// (and refused by a host older than protocol 3).
    pub fn attach_exclusive(
        client: HostClient,
        id: u32,
        after: u64,
    ) -> std::io::Result<(HostMaster, Attached)> {
        let attached = client.attach_exclusive(id, after)?;
        HostMaster::wrap(client, id, attached)
    }

    fn wrap(
        client: HostClient,
        id: u32,
        attached: Attached,
    ) -> std::io::Result<(HostMaster, Attached)> {
        let stream = attached.stream.try_clone()?;
        let master = HostMaster {
            client,
            id,
            stream,
            size: Mutex::new((attached.cols, attached.rows)),
        };
        Ok((master, attached))
    }
}

impl HostMaster {
    /// Whether the foreground program has taken the terminal out of canonical
    /// mode. A hosted session has no local fd to ask, so the host answers.
    pub fn raw_mode(&self) -> bool {
        self.client.raw_mode(self.id).unwrap_or(false)
    }
}

impl MasterPty for HostMaster {
    fn resize(&self, size: PtySize) -> anyhow::Result<()> {
        self.client.resize(self.id, size.cols, size.rows)?;
        *self.size.lock().unwrap() = (size.cols, size.rows);
        Ok(())
    }

    fn get_size(&self) -> anyhow::Result<PtySize> {
        let (cols, rows) = *self.size.lock().unwrap();
        Ok(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
    }

    fn try_clone_reader(&self) -> anyhow::Result<Box<dyn Read + Send>> {
        Ok(Box::new(self.stream.try_clone()?))
    }

    fn take_writer(&self) -> anyhow::Result<Box<dyn Write + Send>> {
        Ok(Box::new(self.stream.try_clone()?))
    }

    fn process_group_leader(&self) -> Option<libc::pid_t> {
        self.client.pgrp(self.id).ok().flatten()
    }

    fn as_raw_fd(&self) -> Option<std::os::unix::io::RawFd> {
        None
    }

    fn tty_name(&self) -> Option<PathBuf> {
        None
    }
}

#[derive(Clone, Debug)]
pub struct HostKiller {
    client: HostClient,
    id: u32,
}

impl ChildKiller for HostKiller {
    fn kill(&mut self) -> std::io::Result<()> {
        self.client.kill(self.id)
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(self.clone())
    }
}

/// How many unreachable-host answers in a row mean the host (and so the child)
/// is gone.
const HOST_GONE_AFTER: u32 = 3;

#[derive(Debug)]
pub struct HostChild {
    killer: HostKiller,
    pid: u32,
    done: Option<ExitStatus>,
    unreachable: u32,
}

impl HostChild {
    pub fn new(client: HostClient, id: u32, pid: u32) -> Self {
        HostChild {
            killer: HostKiller { client, id },
            pid,
            done: None,
            unreachable: 0,
        }
    }
}

impl ChildKiller for HostChild {
    fn kill(&mut self) -> std::io::Result<()> {
        self.killer.kill()
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        self.killer.clone_killer()
    }
}

impl Child for HostChild {
    /// Gone from the host's list, or listed under a different pid (a restarted
    /// host numbers sessions from 1 again), counts as exited, as does a host
    /// that stays unreachable. Without that `wait` could spin forever.
    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        if let Some(status) = &self.done {
            return Ok(Some(status.clone()));
        }
        let id = self.killer.id;
        let status = match self.killer.client.list() {
            Ok(sessions) => {
                self.unreachable = 0;
                match sessions
                    .into_iter()
                    .find(|s| s.id == id && s.pid == Some(self.pid))
                {
                    Some(s) => match s.exited {
                        Some(code) => {
                            // Seen: free the host's ring.
                            let _ = self.killer.client.reap(id);
                            Some(ExitStatus::with_exit_code(code.max(0) as u32))
                        }
                        None => None,
                    },
                    None => Some(ExitStatus::with_exit_code(1)),
                }
            }
            Err(_) => {
                self.unreachable += 1;
                (self.unreachable >= HOST_GONE_AFTER).then(|| ExitStatus::with_exit_code(1))
            }
        };
        self.done = status.clone();
        Ok(status)
    }

    fn wait(&mut self) -> std::io::Result<ExitStatus> {
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(status);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn process_id(&self) -> Option<u32> {
        Some(self.pid)
    }
}
