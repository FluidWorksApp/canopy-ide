//! Opt-in hosted terminals: with `CANOPY_PTY_HOST=1` (Unix only) a new terminal's
//! child lives in the detached `canopy-pty-host` process instead of this one.
//! Off by default. Any failure to reach or start the host falls back to an
//! ordinary in-process terminal, so enabling it can never stop a terminal opening.
//!
//! Hosted sessions are monitor-only for containment: the host, not the app, owns
//! the child, so the app's cgroup / job-object leases do not apply to them.

use portable_pty::{Child, CommandBuilder, MasterPty};

pub fn enabled() -> bool {
    std::env::var("CANOPY_PTY_HOST").is_ok_and(|v| v == "1")
}

#[cfg(unix)]
pub use unix::{client, spawn, Client};

#[cfg(not(unix))]
pub struct Client;

#[cfg(not(unix))]
pub fn client() -> Option<Client> {
    None
}

#[cfg(not(unix))]
pub fn spawn(
    _client: &Client,
    _cmd: &CommandBuilder,
    _cols: u16,
    _rows: u16,
) -> Result<(Box<dyn Child + Send + Sync>, Box<dyn MasterPty + Send>), String> {
    Err("hosted terminals are not supported on this platform".into())
}

#[cfg(unix)]
mod unix {
    use super::*;
    use canopy_pty_host::client::{HostChild, HostClient, HostMaster};
    use canopy_pty_host::protocol::SpawnSpec;
    use std::path::PathBuf;
    use std::sync::OnceLock;

    pub type Client = HostClient;

    /// An idle host exits after this long, so quitting the app does not leave a
    /// helper behind for an hour.
    const HOST_IDLE_SECS: u64 = 60;
    /// A hosted session is killed this long after its app connection drops. A
    /// crash or force-quit leaves nothing to adopt the session yet, and the host
    /// would otherwise keep it, and its agent, running invisibly forever. The
    /// adoption change lifts this.
    const LINGER_SECS: u64 = 30;

    /// A dedicated directory: the host chmods its parent to 0700, so it must
    /// never be a shared one. Debug builds use their own so a dev app never
    /// attaches to an installed app's host.
    fn socket_path() -> Option<PathBuf> {
        if let Ok(dir) = std::env::var("CANOPY_PTY_HOST_DIR") {
            return Some(PathBuf::from(dir).join("host.sock"));
        }
        let home = std::env::var("HOME").ok()?;
        let leaf = if cfg!(debug_assertions) {
            "pty-host-dev"
        } else {
            "pty-host"
        };
        Some(
            PathBuf::from(home)
                .join(".canopy")
                .join(leaf)
                .join("host.sock"),
        )
    }

    /// `CANOPY_PTY_HOST_EXE`, else next to this executable. Packaging the host
    /// where it survives an app update is not done yet.
    fn host_exe() -> Option<PathBuf> {
        if let Ok(path) = std::env::var("CANOPY_PTY_HOST_EXE") {
            return Some(PathBuf::from(path));
        }
        let exe = std::env::current_exe()
            .ok()?
            .parent()?
            .join("canopy-pty-host");
        exe.is_file().then_some(exe)
    }

    /// The host client, started on first use. None when the switch is off or the
    /// host cannot be reached; callers then use an in-process terminal.
    pub fn client() -> Option<Client> {
        if !super::enabled() {
            return None;
        }
        static CLIENT: OnceLock<Option<Client>> = OnceLock::new();
        CLIENT
            .get_or_init(|| {
                // Said once, so a missing host is not mistaken for a working one.
                let Some(socket) = socket_path() else {
                    eprintln!("canopy: CANOPY_PTY_HOST=1 but no socket directory; using in-process terminals");
                    return None;
                };
                let Some(exe) = host_exe() else {
                    eprintln!("canopy: CANOPY_PTY_HOST=1 but canopy-pty-host was not found next to the app (set CANOPY_PTY_HOST_EXE); using in-process terminals");
                    return None;
                };
                match HostClient::ensure_running(&exe, &socket, HOST_IDLE_SECS) {
                    Ok(client) => Some(client),
                    Err(error) => {
                        eprintln!(
                            "canopy: PTY host unavailable, using in-process terminals: {error}"
                        );
                        None
                    }
                }
            })
            .clone()
    }

    /// Starts `cmd` in the host and attaches to it from offset 0. The host gets
    /// exactly the command's argv, cwd and environment, never its own. A
    /// non-UTF-8 argv or cwd is refused (the caller falls back in-process), and
    /// non-UTF-8 environment entries are skipped by `iter_full_env_as_str`.
    pub fn spawn(
        client: &Client,
        cmd: &CommandBuilder,
        cols: u16,
        rows: u16,
    ) -> Result<(Box<dyn Child + Send + Sync>, Box<dyn MasterPty + Send>), String> {
        let argv = cmd
            .get_argv()
            .iter()
            .map(|a| a.to_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .ok_or("argv is not valid UTF-8")?;
        let cwd = match cmd.get_cwd() {
            Some(cwd) => Some(cwd.to_str().ok_or("cwd is not valid UTF-8")?.to_owned()),
            None => None,
        };
        let env = cmd
            .iter_full_env_as_str()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect();
        let (id, pid) = client
            .spawn(SpawnSpec {
                argv,
                cwd,
                env,
                cols,
                rows,
                meta: None,
                linger_secs: Some(LINGER_SECS),
            })
            .map_err(|e| e.to_string())?;
        match HostMaster::attach(client.clone(), id, 0) {
            Ok((master, _attached)) => Ok((
                Box::new(HostChild::new(client.clone(), id, pid)),
                Box::new(master),
            )),
            Err(error) => {
                let _ = client.kill(id);
                Err(error.to_string())
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use canopy_pty_host::client::HostClient;
    use canopy_pty_host::server::{serve, ServerConfig, EXITED_TTL};
    use std::io::{Read, Write};
    use std::os::unix::net::UnixListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    /// A host on a thread, so these tests need no separate binary.
    struct InProcessHost {
        client: HostClient,
        stop: Arc<AtomicBool>,
        dir: std::path::PathBuf,
    }

    impl InProcessHost {
        fn start(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("cph{}{}", std::process::id(), name));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let socket = dir.join("h.sock");
            let listener = UnixListener::bind(&socket).unwrap();
            let stop = Arc::new(AtomicBool::new(false));
            let config = ServerConfig {
                socket: socket.clone(),
                min_client: canopy_pty_host::protocol::MIN_CLIENT_VERSION,
                idle_exit: Duration::from_secs(3600),
                exited_ttl: EXITED_TTL,
            };
            let thread_stop = Arc::clone(&stop);
            std::thread::spawn(move || {
                let _ = serve(listener, &config, thread_stop);
            });
            InProcessHost {
                client: HostClient::new(socket),
                stop,
                dir,
            }
        }
    }

    impl Drop for InProcessHost {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(300));
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// Reads on a thread so a missed needle fails the test instead of hanging
    /// the job on a blocking read.
    struct Pump {
        rx: std::sync::mpsc::Receiver<Vec<u8>>,
        seen: Vec<u8>,
    }

    impl Pump {
        fn new(mut reader: Box<dyn Read + Send>) -> Pump {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut buf = [0u8; 1024];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            });
            Pump {
                rx,
                seen: Vec::new(),
            }
        }

        fn until(&mut self, needle: &str) -> String {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while !String::from_utf8_lossy(&self.seen).contains(needle) {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                match self.rx.recv_timeout(left) {
                    Ok(chunk) => self.seen.extend_from_slice(&chunk),
                    Err(_) => break,
                }
            }
            String::from_utf8_lossy(&self.seen).into_owned()
        }
    }

    fn command(script: &str) -> CommandBuilder {
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg(script);
        cmd.env_clear();
        cmd.env("PATH", "/usr/bin:/bin");
        cmd.env("CANOPY_HOSTED_PROBE", "from-the-app");
        cmd
    }

    #[test]
    fn the_child_gets_the_apps_environment_not_the_hosts() {
        let host = InProcessHost::start("env");
        // The in-process host shares this process's environment. cargo sets
        // CARGO_MANIFEST_DIR for a test run and no shell invents it, while the
        // command cleared its own environment: seeing it in the child would mean
        // the host used its environment instead of the one it was sent.
        assert!(std::env::var("CARGO_MANIFEST_DIR").is_ok());
        let (mut child, master) = spawn(
            &host.client,
            &command("echo probe=$CANOPY_HOSTED_PROBE leak=[$CARGO_MANIFEST_DIR]"),
            80,
            24,
        )
        .unwrap();
        let mut pump = Pump::new(master.try_clone_reader().unwrap());
        let out = pump.until("leak=[");
        assert!(out.contains("probe=from-the-app"), "got {out:?}");
        assert!(
            out.contains("leak=[]"),
            "the host leaked its environment: {out:?}"
        );
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn input_resize_and_exit_status_work_through_the_portable_pty_traits() {
        let host = InProcessHost::start("io");
        let script = "stty size; read line; echo got=$line; exit 3";
        let (mut child, master) = spawn(&host.client, &command(script), 100, 30).unwrap();
        let mut pump = Pump::new(master.try_clone_reader().unwrap());
        let mut writer = master.take_writer().unwrap();
        assert!(pump.until("30 100").contains("30 100"));
        writer.write_all(b"hello\n").unwrap();
        assert!(pump.until("got=hello").contains("got=hello"));
        assert_eq!(child.wait().unwrap().exit_code(), 3);
        let size = master.get_size().unwrap();
        assert_eq!((size.cols, size.rows), (100, 30));
    }

    #[test]
    fn resize_reaches_a_running_hosted_child() {
        let host = InProcessHost::start("rs");
        let script =
            "trap 'echo size=$(stty size)' WINCH; echo ready; while :; do sleep 0.05; done";
        let (mut child, master) = spawn(&host.client, &command(script), 80, 24).unwrap();
        let mut pump = Pump::new(master.try_clone_reader().unwrap());
        pump.until("ready");
        master
            .resize(portable_pty::PtySize {
                rows: 40,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        assert!(pump.until("size=40 120").contains("size=40 120"));
        child.kill().unwrap();
    }

    #[test]
    fn a_non_utf8_argv_is_refused_so_the_caller_falls_back() {
        use std::os::unix::ffi::OsStringExt;
        let host = InProcessHost::start("utf8");
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg(std::ffi::OsString::from_vec(vec![0xff, 0xfe]));
        let error = spawn(&host.client, &cmd, 80, 24).err().unwrap();
        assert!(error.contains("UTF-8"), "{error}");
    }

    #[test]
    fn killing_through_the_child_handle_stops_a_hosted_session() {
        let host = InProcessHost::start("kill");
        let (mut child, _master) = spawn(&host.client, &command("sleep 300"), 80, 24).unwrap();
        assert!(child.try_wait().unwrap().is_none());
        child.kill().unwrap();
        child.wait().unwrap(); // must return, not hang
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn raw_mode_is_answered_by_the_host_not_assumed_false() {
        let host = InProcessHost::start("raw");
        // `stty raw` takes the tty out of canonical mode, like a full-screen TUI.
        let script = "stty raw -echo; echo raw-set; sleep 300";
        let (mut child, master) = spawn(&host.client, &command(script), 80, 24).unwrap();
        let mut pump = Pump::new(master.try_clone_reader().unwrap());
        pump.until("raw-set");
        let plain: &dyn MasterPty = &*master;
        let hosted = plain
            .downcast_ref::<canopy_pty_host::client::HostMaster>()
            .expect("a hosted master downcasts to HostMaster");
        assert!(hosted.raw_mode());
        child.kill().unwrap();
    }
}
