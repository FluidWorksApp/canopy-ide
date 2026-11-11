//! App-side client for the host. `HostMaster` and `HostChild` implement
//! portable-pty's `MasterPty` and `Child`, so a hosted session can sit inside the
//! app's existing `Session` unchanged (reader, writer, resize, kill and wait all
//! keep their shapes).

use crate::protocol::{
    AttachReply, Request, Response, SessionInfo, SpawnSpec, MIN_HOST_VERSION, PROTOCOL_VERSION,
};
use portable_pty::{Child, ChildKiller, ExitStatus, MasterPty, PtySize};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
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

#[derive(Clone, Debug)]
pub struct HostClient {
    socket: PathBuf,
    /// Where to start a host from and how long it idles. Used only by `spawn`:
    /// restarting the host from any other call would resurrect a dead host from a
    /// liveness probe and let a stale id address a different terminal.
    launch: Option<(PathBuf, u64)>,
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
        self.launch = Some((host_exe.into(), idle_secs));
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

    fn call_timeout(&self, request: &Request, timeout: Duration) -> std::io::Result<Response> {
        let mut stream = UnixStream::connect(&self.socket)?;
        stream.set_read_timeout(Some(timeout))?;
        stream.set_write_timeout(Some(timeout))?;
        let mut line = serde_json::to_vec(request).map_err(other_err)?;
        line.push(b'\n');
        stream.write_all(&line)?;
        let reply: Response = serde_json::from_str(&read_line(&mut stream)?).map_err(other_err)?;
        if reply.ok {
            Ok(reply)
        } else {
            Err(other(reply.error.unwrap_or_else(|| "host error".into())))
        }
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
        if let Some((exe, idle_secs)) = &self.launch {
            if self.hello().is_err() {
                HostClient::ensure_running(exe, &self.socket, *idle_secs)?;
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
            .call_timeout(&Request::List, timeout)?
            .sessions
            .unwrap_or_default())
    }

    pub fn list(&self) -> std::io::Result<Vec<SessionInfo>> {
        Ok(self.call(&Request::List)?.sessions.unwrap_or_default())
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
            .call_timeout(&Request::Pgrp { id }, PROBE_TIMEOUT)?
            .pgrp)
    }

    pub fn raw_mode(&self, id: u32) -> std::io::Result<bool> {
        Ok(self
            .call_timeout(&Request::RawMode { id }, PROBE_TIMEOUT)?
            .raw
            .unwrap_or(false))
    }

    pub fn shutdown(&self) -> std::io::Result<()> {
        self.call(&Request::Shutdown).map(|_| ())
    }

    /// Opens the data connection: the reply, then raw bytes from `start` both ways.
    pub fn attach(&self, id: u32, after: u64) -> std::io::Result<Attached> {
        let mut stream = self.connect()?;
        let mut line = serde_json::to_vec(&Request::Attach {
            id,
            after,
            client_version: PROTOCOL_VERSION,
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
        // Probe with a client that cannot restart the host: `call` retries through
        // this function, so probing with the retrying client would recurse forever.
        let client = HostClient::new(socket);
        if client.hello().is_ok() {
            return Ok(client.with_launch(host_exe, idle_secs));
        }
        let dir = socket
            .parent()
            .ok_or_else(|| other("socket has no parent"))?;
        std::fs::create_dir_all(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join("host.lock"))?;
        // SAFETY: flock on a descriptor we own; released when `lock` drops.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        if client.hello().is_ok() {
            return Ok(client.with_launch(host_exe, idle_secs));
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
        // SAFETY: setsid in the forked child before exec, no allocation.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        let mut child = command.spawn()?;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if client.hello().is_ok() {
                // The host is a detached daemon now; reap our handle quietly.
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Ok(client.with_launch(host_exe, idle_secs));
            }
            if let Ok(Some(status)) = child.try_wait() {
                return Err(other(format!("host exited at startup: {status}")));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        Err(other("host did not start in time"))
    }
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
