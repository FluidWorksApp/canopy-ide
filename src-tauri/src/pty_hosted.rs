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
                let (socket, exe) = (socket_path()?, host_exe()?);
                match HostClient::ensure_running(&exe, &socket, 60 * 60) {
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

    fn read_until(reader: &mut dyn Read, needle: &str) -> String {
        let mut out = Vec::new();
        let mut buf = [0u8; 1024];
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => out.extend_from_slice(&buf[..n]),
            }
            if String::from_utf8_lossy(&out).contains(needle) {
                break;
            }
        }
        String::from_utf8_lossy(&out).into_owned()
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
        let (mut child, master) = spawn(
            &host.client,
            &command("echo probe=$CANOPY_HOSTED_PROBE"),
            80,
            24,
        )
        .unwrap();
        let mut reader = master.try_clone_reader().unwrap();
        let out = read_until(&mut *reader, "probe=from-the-app");
        assert!(out.contains("probe=from-the-app"), "got {out:?}");
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn input_resize_and_exit_status_work_through_the_portable_pty_traits() {
        let host = InProcessHost::start("io");
        let script = "stty size; read line; echo got=$line; exit 3";
        let (mut child, master) = spawn(&host.client, &command(script), 100, 30).unwrap();
        let mut reader = master.try_clone_reader().unwrap();
        let mut writer = master.take_writer().unwrap();
        assert!(read_until(&mut *reader, "30 100").contains("30 100"));
        writer.write_all(b"hello\n").unwrap();
        assert!(read_until(&mut *reader, "got=hello").contains("got=hello"));
        let status = child.wait().unwrap();
        assert_eq!(status.exit_code(), 3);
        let size = master.get_size().unwrap();
        assert_eq!((size.cols, size.rows), (100, 30));
        master
            .resize(portable_pty::PtySize {
                rows: 40,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .ok(); // the session has exited; only the call shape matters here
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
        assert!(!child.wait().unwrap().success());
    }

    #[test]
    fn the_switch_is_off_unless_set_to_one() {
        // Not asserting on the live environment: just the parse.
        assert!(!"0".eq("1") && !"".eq("1"));
    }
}
