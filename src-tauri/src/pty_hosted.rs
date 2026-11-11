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
pub use adoption::{
    adopt, adoptable, identity_floor, note_identity, reused_instance, Adoptable, Adopted,
};
#[cfg(unix)]
pub use unix::{client, spawn, Client};

#[cfg(not(unix))]
pub struct Client;

#[cfg(not(unix))]
pub fn client() -> Option<Client> {
    None
}

/// The instance token of a previous launch whose hosted sessions are still
/// running, so adopted agents keep pairing with this launch. None here.
#[cfg(not(unix))]
pub fn reused_instance() -> Option<String> {
    None
}

#[cfg(not(unix))]
pub fn spawn(
    _client: &Client,
    _cmd: &CommandBuilder,
    _cols: u16,
    _rows: u16,
    _meta: Option<String>,
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
    pub(super) fn socket_path() -> Option<PathBuf> {
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
        // A host that exists but could not be read: hosting this run would
        // create sessions no later launch could adopt, so stay in-process.
        if matches!(resolution(), Resolution::HostUnusable) {
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
        meta: Option<String>,
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
                meta,
                linger_secs: Some(LINGER_SECS),
                key: None,
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

/// Everything adoption needs, read from a session's metadata. Versioned, and
/// identity only: no environment and no tokens besides the instance tag.
#[cfg(unix)]
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct HostedMeta {
    pub v: u32,
    pub id: u32,
    pub generation: u64,
    pub kind: String,
    pub cwd: String,
    pub run: bool,
    pub command: Option<String>,
    pub run_command_id: Option<String>,
    pub execution_context: Option<crate::execution::ExecutionContext>,
    pub run_id: Option<String>,
    pub attempt_id: Option<String>,
    pub instance: String,
}

#[cfg(unix)]
mod adoption {
    use super::unix::{socket_path, Client};
    use super::*;
    use canopy_pty_host::client::{HostChild, HostClient, HostMaster};
    use canopy_pty_host::protocol::SessionInfo;
    use std::io::Read;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::OnceLock;
    use std::time::Duration;

    pub(super) fn parse(info: &SessionInfo) -> Option<HostedMeta> {
        let meta: HostedMeta = serde_json::from_str(info.meta.as_deref()?).ok()?;
        (meta.v == 1 && meta.id != 0).then_some(meta)
    }

    /// A session this launch may take over.
    pub struct Adoptable {
        pub info: SessionInfo,
        pub meta: HostedMeta,
    }

    /// The longest the launch path waits on the host for any one answer.
    const LAUNCH_WAIT: Duration = Duration::from_secs(1);

    /// Sessions that are running, not attached to anyone (a host that predates
    /// the `attached` field reports unknown, which is never taken), whose
    /// metadata is ours and not a micro-task's, and that belong to `instance`.
    pub fn adoptable(client: &Client, instance: &str) -> Vec<Adoptable> {
        match client.list_within(LAUNCH_WAIT) {
            Ok(sessions) => adoptable_from(sessions, instance),
            Err(_) => Vec::new(),
        }
    }

    pub(super) fn adoptable_from(sessions: Vec<SessionInfo>, instance: &str) -> Vec<Adoptable> {
        sessions
            .into_iter()
            .filter(|s| s.exited.is_none() && s.attached == Some(false) && s.pid.is_some())
            .filter_map(|info| {
                let meta = parse(&info)?;
                (meta.kind != "detached" && meta.run_id.is_none() && meta.instance == instance)
                    .then_some(Adoptable { info, meta })
            })
            .collect()
    }

    pub(super) enum Resolution {
        /// No host, or nothing in it to adopt: a fresh launch.
        Fresh,
        /// A previous launch's sessions are waiting under this token.
        Reuse(String),
        /// A host answers but could not be read; do not host this run.
        HostUnusable,
    }

    /// Decided once, before the first `instance_token()`, with a non-launching
    /// client so starting the app never starts a host just to ask it.
    pub(super) fn resolution() -> &'static Resolution {
        static RESOLUTION: OnceLock<Resolution> = OnceLock::new();
        RESOLUTION.get_or_init(|| {
            if !super::enabled() {
                return Resolution::Fresh;
            }
            let Some(socket) = socket_path() else {
                return Resolution::Fresh;
            };
            if !socket.exists() {
                return Resolution::Fresh;
            }
            let probe = HostClient::new(socket);
            match probe.list_within(LAUNCH_WAIT) {
                Ok(sessions) => match choose_token(&sessions) {
                    Some(token) => Resolution::Reuse(token),
                    None => Resolution::Fresh,
                },
                // A socket file left by a host that is gone, or one that is not
                // listening, is "no host": the next spawn cleans it up and
                // starts a fresh one. Only a host that connects and then fails
                // to answer sensibly is unusable.
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::NotFound
                            | std::io::ErrorKind::ConnectionRefused
                            | std::io::ErrorKind::ConnectionReset
                            | std::io::ErrorKind::BrokenPipe
                    ) =>
                {
                    Resolution::Fresh
                }
                Err(_) => Resolution::HostUnusable,
            }
        })
    }

    /// The token most waiting sessions agree on: running, free (an old host with
    /// no `attached` field is never counted), ours, not a micro-task's.
    pub(super) fn choose_token(sessions: &[SessionInfo]) -> Option<String> {
        let mut counts: std::collections::HashMap<String, usize> = Default::default();
        for info in sessions {
            if info.exited.is_some() || info.attached != Some(false) {
                continue;
            }
            if let Some(meta) = parse(info) {
                if meta.kind != "detached" && meta.run_id.is_none() && !meta.instance.is_empty() {
                    *counts.entry(meta.instance).or_default() += 1;
                }
            }
        }
        // Ties broken by the token itself so the choice never depends on map order.
        counts
            .into_iter()
            .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(&a.0)))
            .map(|(token, _)| token)
    }

    /// The least id and generation a new terminal may use under `instance`: past
    /// every session that carries the token (running or not, attached or not,
    /// adoptable or not), and past the host's stored high-water mark. Asked with
    /// a non-launching client, so it works even when hosting is unavailable.
    pub fn identity_floor(instance: &str) -> Option<(u32, u64)> {
        let probe = HostClient::new(socket_path()?);
        let sessions = probe.list_within(LAUNCH_WAIT).ok()?;
        let mut floor: Option<(u32, u64)> = stored_identity(&probe);
        for info in &sessions {
            if let Some(meta) = parse(info) {
                if meta.instance == instance {
                    let (id, generation) = floor.unwrap_or((0, 0));
                    floor = Some((id.max(meta.id), generation.max(meta.generation)));
                }
            }
        }
        floor
    }

    pub fn reused_instance() -> Option<String> {
        match resolution() {
            Resolution::Reuse(token) => Some(token.clone()),
            _ => None,
        }
    }

    /// A session taken over: its child and master are host handles, and
    /// `history` is what it printed before this app attached.
    pub struct Adopted {
        pub meta: HostedMeta,
        pub pid: u32,
        pub child: Box<dyn Child + Send + Sync>,
        pub master: Box<dyn MasterPty + Send>,
        pub history: Vec<u8>,
        pub history_start: u64,
        pub cols: u16,
        pub rows: u16,
    }

    /// Attach from the start of the host's ring and read exactly the history the
    /// attach reply describes (its own `start`/`end`, not the listing's: the ring
    /// can move between the two calls). Live bytes then continue on the same
    /// stream. On any failure the connection drops, which only detaches.
    pub fn adopt(client: &Client, found: &Adoptable) -> Result<Adopted, String> {
        let id = found.info.id;
        let pid = found.info.pid.ok_or("session has no pid")?;
        let (master, attached) =
            HostMaster::attach(client.clone(), id, 0).map_err(|e| e.to_string())?;
        let want = attached.end.saturating_sub(attached.start) as usize;
        let mut history = vec![0u8; want];
        let mut stream = attached.stream.try_clone().map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| e.to_string())?;
        stream
            .read_exact(&mut history)
            .map_err(|e| format!("reading history: {e}"))?;
        let _ = stream.set_read_timeout(None);
        Ok(Adopted {
            meta: found.meta.clone(),
            pid,
            child: Box::new(HostChild::new(client.clone(), id, pid)),
            master: Box::new(master),
            history,
            history_start: attached.start,
            cols: attached.cols,
            rows: attached.rows,
        })
    }

    static HIGH_WATER_ID: AtomicU64 = AtomicU64::new(0);
    const HIGH_WATER_BLOCK: u64 = 64;

    /// Remember, in the host, how far ids and generations have gone, written
    /// ahead in blocks so a crash cannot make a later launch reuse a pair that
    /// an adopted terminal's sidecars already name. Best effort: an older host
    /// refuses the op and nothing is lost but the guarantee.
    pub fn note_identity(client: &Client, id: u32, generation: u64) {
        if (id as u64) < HIGH_WATER_ID.load(Ordering::Relaxed) {
            return;
        }
        let ahead = id as u64 + HIGH_WATER_BLOCK;
        HIGH_WATER_ID.store(ahead, Ordering::Relaxed);
        let _ = client.set_state(
            "identity_high_water",
            &format!("{ahead}:{}", generation + HIGH_WATER_BLOCK),
            false,
        );
    }

    pub fn stored_identity(client: &Client) -> Option<(u32, u64)> {
        let value = client.get_state("identity_high_water").ok()??;
        let (id, generation) = value.split_once(':')?;
        Some((id.parse().ok()?, generation.parse().ok()?))
    }
}

#[cfg(unix)]
use adoption::resolution;
#[cfg(unix)]
use adoption::Resolution;

#[cfg(all(test, unix))]
pub(crate) mod tests {
    use super::adoption::{adoptable_from as adoption_adoptable, choose_token as adoption_choose};
    use super::*;
    use canopy_pty_host::client::HostClient;
    use canopy_pty_host::server::{serve, ServerConfig, EXITED_TTL};
    use std::io::{Read, Write};
    use std::os::unix::net::UnixListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    /// A host on a thread, so these tests need no separate binary.
    pub(crate) struct InProcessHost {
        pub(crate) client: HostClient,
        stop: Arc<AtomicBool>,
        dir: std::path::PathBuf,
    }

    impl InProcessHost {
        pub(crate) fn start(name: &str) -> Self {
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

    pub(crate) fn command(script: &str) -> CommandBuilder {
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
            None,
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
        let (mut child, master) = spawn(&host.client, &command(script), 100, 30, None).unwrap();
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
        let (mut child, master) = spawn(&host.client, &command(script), 80, 24, None).unwrap();
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
        let error = spawn(&host.client, &cmd, 80, 24, None).err().unwrap();
        assert!(error.contains("UTF-8"), "{error}");
    }

    #[test]
    fn killing_through_the_child_handle_stops_a_hosted_session() {
        let host = InProcessHost::start("kill");
        let (mut child, _master) =
            spawn(&host.client, &command("sleep 300"), 80, 24, None).unwrap();
        assert!(child.try_wait().unwrap().is_none());
        child.kill().unwrap();
        child.wait().unwrap(); // must return, not hang
        assert!(child.try_wait().unwrap().is_some());
    }

    fn wait_for(mut f: impl FnMut() -> bool) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if f() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    pub(crate) fn meta_for(id: u32, generation: u64, kind: &str, instance: &str) -> String {
        serde_json::json!({
            "v": 1, "id": id, "generation": generation, "kind": kind,
            "cwd": "/tmp", "run": false, "instance": instance,
        })
        .to_string()
    }

    #[test]
    fn a_relaunch_adopts_the_session_with_its_history_and_then_live_output() {
        let host = InProcessHost::start("adopt");
        let (child, master) = spawn(
            &host.client,
            &command("echo before-quit; read x; echo got-$x; sleep 300"),
            80,
            24,
            Some(meta_for(7, 3, "desktop", "inst-a")),
        )
        .unwrap();
        assert!(wait_for(|| host.client.list().unwrap()[0].end > 0));
        // The app quits: its connection drops, which only detaches.
        drop(master);
        drop(child);
        assert!(wait_for(|| {
            host.client.list().unwrap()[0].attached == Some(false)
        }));

        assert!(adoptable(&host.client, "someone-else").is_empty());
        let found = adoptable(&host.client, "inst-a");
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].meta.id, found[0].meta.generation), (7, 3));

        let taken = adopt(&host.client, &found[0]).unwrap();
        assert_eq!(taken.history_start, 0);
        assert!(
            String::from_utf8_lossy(&taken.history).contains("before-quit"),
            "history was {:?}",
            String::from_utf8_lossy(&taken.history)
        );
        assert_eq!(
            Some(taken.pid),
            found[0].info.pid,
            "same child, not a new one"
        );
        // Taken: a second launch-time pass must not see it as free.
        assert!(adoptable(&host.client, "inst-a").is_empty());

        // Input and live output continue, with no history repeated.
        let mut writer = taken.master.take_writer().unwrap();
        let mut pump = Pump::new(taken.master.try_clone_reader().unwrap());
        writer.write_all(b"hi\n").unwrap();
        let seen = pump.until("got-hi");
        assert!(seen.contains("got-hi"), "{seen:?}");
        assert!(
            !seen.contains("before-quit"),
            "history leaked into live: {seen:?}"
        );
        let mut child = taken.child;
        child.kill().unwrap();
    }

    fn info(
        id: u32,
        meta: Option<String>,
        attached: Option<bool>,
        exited: Option<i32>,
    ) -> canopy_pty_host::protocol::SessionInfo {
        canopy_pty_host::protocol::SessionInfo {
            id,
            pid: Some(1000 + id),
            meta,
            attached,
            exited,
            ..Default::default()
        }
    }

    #[test]
    fn the_token_is_the_one_most_free_sessions_carry() {
        let a = |i| Some(meta_for(i, i as u64, "desktop", "inst-a"));
        let b = |i| Some(meta_for(i, i as u64, "desktop", "inst-b"));
        let sessions = vec![
            info(1, a(1), Some(false), None),
            info(2, a(2), Some(false), None),
            info(3, b(3), Some(false), None),
        ];
        assert_eq!(adoption_choose(&sessions).as_deref(), Some("inst-a"));
    }

    #[test]
    fn an_old_host_exited_attached_and_micro_task_sessions_never_count() {
        let m = |kind: &str| Some(meta_for(1, 1, kind, "inst-a"));
        let sessions = vec![
            info(1, m("desktop"), None, None),       // host without the field
            info(2, m("desktop"), Some(true), None), // someone is attached
            info(3, m("desktop"), Some(false), Some(0)), // exited
            info(4, m("detached"), Some(false), None), // micro-task
            info(5, None, Some(false), None),        // no metadata
            info(6, Some("{not json".into()), Some(false), None),
        ];
        assert_eq!(adoption_choose(&sessions), None);
        assert!(adoption_adoptable(sessions, "inst-a").is_empty());
    }

    #[test]
    fn a_run_bound_session_is_a_micro_task_tab_and_is_never_adopted() {
        // Micro-task tabs are ephemeral and never restored; the stale sweep
        // settles their run, so adopting the terminal would contradict it.
        let bound = serde_json::json!({
            "v": 1, "id": 5, "generation": 5, "kind": "desktop", "cwd": "/tmp",
            "run": false, "instance": "inst-a", "run_id": "run-1", "attempt_id": "att-1",
        })
        .to_string();
        let sessions = vec![info(5, Some(bound), Some(false), None)];
        assert_eq!(adoption_choose(&sessions), None);
        assert!(adoption_adoptable(sessions, "inst-a").is_empty());
    }

    #[test]
    fn micro_tasks_exited_and_attached_sessions_are_not_adopted() {
        let host = InProcessHost::start("noadopt");
        let (_c1, _m1) = spawn(
            &host.client,
            &command("sleep 300"),
            80,
            24,
            Some(meta_for(1, 1, "detached", "inst-a")),
        )
        .unwrap();
        // Still attached through _m1, and detached kind anyway.
        assert!(adoptable(&host.client, "inst-a").is_empty());
        // A session with no metadata at all is not ours to adopt.
        let (c2, m2) = spawn(&host.client, &command("sleep 300"), 80, 24, None).unwrap();
        drop((c2, m2));
        assert!(wait_for(|| host
            .client
            .list()
            .unwrap()
            .iter()
            .any(|s| s.meta.is_none() && s.attached == Some(false))));
        assert!(adoptable(&host.client, "inst-a").is_empty());
    }

    #[test]
    fn spawn_writes_the_identity_metadata_with_the_session() {
        let host = InProcessHost::start("meta");
        let meta = r#"{"v":1,"id":7,"generation":3}"#.to_string();
        let (mut child, _master) = spawn(
            &host.client,
            &command("sleep 300"),
            80,
            24,
            Some(meta.clone()),
        )
        .unwrap();
        let listed = host.client.list().unwrap();
        assert_eq!(listed[0].meta.as_deref(), Some(meta.as_str()));
        let _ = child.kill();
    }

    #[test]
    fn raw_mode_is_answered_by_the_host_not_assumed_false() {
        let host = InProcessHost::start("raw");
        // `stty raw` takes the tty out of canonical mode, like a full-screen TUI.
        let script = "stty raw -echo; echo raw-set; sleep 300";
        let (mut child, master) = spawn(&host.client, &command(script), 80, 24, None).unwrap();
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
