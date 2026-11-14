//! The PTY host adapter (unix): spawn or attach through `canopy-pty-host`'s
//! client and hand the session's data connection to a [`StreamLink`].
//!
//! One data connection per session: the host replays its ring from offset 0
//! (the history, which rebuilds the screen of a session that was already
//! running), then sends live output; input goes back on the same connection.
//! Control calls (`resize`, `kill`) open their own short connections, so they
//! run on the link's resizer thread and never touch the window's thread.

use std::io;
use std::net::Shutdown;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use canopy_pty_host::client::{Attached, HostClient};
use canopy_pty_host::protocol::{SpawnSpec, BUSY};

use canopy_pty_host::client::{skew_action, IdleShutdown, SkewAction};

use crate::host_install;
use crate::link::{resize_plan, Limits, StreamLink};
use crate::skew::{self, Verdict};

/// A host this program starts exits this long after its last session and
/// client are gone.
pub const HOST_IDLE_SECS: u64 = 60;

/// Between the nudge's two sizes: long enough for the program to take the
/// first SIGWINCH and redraw before the real size follows.
const NUDGE_PAUSE: Duration = Duration::from_millis(50);

/// A session the window is showing.
pub struct Opened {
    pub link: StreamLink,
    pub id: u32,
    /// The size the host's PTY has right now.
    pub cols: u16,
    pub rows: u16,
}

/// What a new session is started with.
#[derive(Clone, Debug)]
pub struct NewSession {
    /// Empty means the user's shell.
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub key: Option<String>,
    pub linger_secs: u64,
    pub cols: u16,
    pub rows: u16,
    /// Start the user's shell as a login shell. Set when this program was not
    /// started from a terminal (double-clicked, or from a launcher), which gives
    /// it none of the environment a shell's profile files would have set up.
    pub login: bool,
}

/// The shell when `$SHELL` is unset, as it is for a program the Finder starts.
pub fn fallback_shell() -> &'static str {
    if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/sh"
    }
}

/// Where a session starts when no directory was asked for. A program started
/// from the Finder has `/` as its directory, which is never where anyone wants
/// a shell; use the home directory then.
pub fn default_cwd(current: PathBuf, home: Option<String>) -> PathBuf {
    match home.filter(|h| !h.is_empty()) {
        Some(home) if current == Path::new("/") => PathBuf::from(home),
        _ => current,
    }
}

/// The host's own binary: `CANOPY_PTY_HOST_EXE`, else beside this one.
pub fn host_exe() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("CANOPY_PTY_HOST_EXE") {
        if !path.is_empty() {
            return Some(PathBuf::from(path));
        }
    }
    let exe = std::env::current_exe()
        .ok()?
        .parent()?
        .join("canopy-pty-host");
    exe.is_file().then_some(exe)
}

/// A client for `socket`. Only a `launchable` socket (the default directory)
/// may have a host started for it, and only by `spawn`.
pub fn client_for(socket: &Path, launchable: bool) -> HostClient {
    let client = HostClient::new(socket);
    match (launchable, host_exe()) {
        (true, Some(exe)) => client.with_launch(exe, HOST_IDLE_SECS),
        _ => client,
    }
}

/// This program's app version, which is the Canopy release it ships in.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// How long a host that was told to stop gets to go away.
const STOP_WAIT: Duration = Duration::from_secs(3);

/// A client ready to spawn or attach. On the default socket the host beside
/// this program is first installed outside the app (`host_install`), so the host
/// it starts never runs from Downloads, a mounted image or a bundle an update is
/// about to replace; a `CANOPY_PTY_HOST_EXE` is used as given. Then the host
/// already running at the socket, if any, must be the same app version
/// (`skew`): an idle one of another version is stopped and replaced, one that
/// still runs terminals is left alone and the error says why.
pub fn prepare_client(socket: &Path, launchable: bool) -> Result<HostClient, String> {
    let explicit = std::env::var("CANOPY_PTY_HOST_EXE").is_ok_and(|p| !p.is_empty());
    let mut client = HostClient::new(socket);
    let mut installed = None;
    if launchable {
        if let Some(exe) = host_exe() {
            let exe = match (explicit, host_install::bin_dir(socket)) {
                (false, Some(bin)) => {
                    let copy = host_install::install(&exe, VERSION, &bin)
                        .map_err(|e| format!("cannot install the terminal host: {e}"))?;
                    installed = Some((bin, copy.clone()));
                    copy
                }
                _ => exe,
            };
            client = client.with_launch(exe, HOST_IDLE_SECS);
        }
    }
    vet(&client, socket, VERSION, launchable, STOP_WAIT)?;
    if let Some((bin, copy)) = installed {
        let hello = client.hello_raw();
        let live = hello.as_ref().ok().and_then(|r| r.exe.clone());
        let known = match &hello {
            Ok(_) => true,
            Err(e) => e.kind() == io::ErrorKind::NotFound,
        };
        host_install::prune(&bin, &copy, live.as_deref(), known);
    }
    Ok(client)
}

fn running_sessions(
    listed: &io::Result<Vec<canopy_pty_host::protocol::SessionInfo>>,
) -> Option<usize> {
    listed
        .as_ref()
        .ok()
        .map(|s| s.iter().filter(|s| s.exited.is_none()).count())
}

/// Checks that the host at the socket can be shared with `ours`, replacing an
/// idle one of another version when `replaceable`. `Err` is the message for the
/// user.
pub fn vet(
    client: &HostClient,
    socket: &Path,
    ours: &str,
    replaceable: bool,
    wait: Duration,
) -> Result<(), String> {
    let Verdict::Mismatch(m) = skew::judge(client.hello_raw(), ours) else {
        return Ok(());
    };
    let listed = client.list();
    let mut running = running_sessions(&listed);
    if replaceable && skew_action(&listed) == SkewAction::Replace {
        match client.shutdown_if_idle() {
            Ok(IdleShutdown::Stopping) => {
                let start = std::time::Instant::now();
                while start.elapsed() < wait {
                    if skew::judge(client.hello_raw(), ours) == Verdict::NoHost {
                        return Ok(());
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                return Err(format!(
                    "{} (it was idle and was asked to stop, but is still running)",
                    skew::explain(&m, ours, socket, Some(0))
                ));
            }
            Ok(IdleShutdown::Busy(n)) => running = Some(n),
            _ => running = None,
        }
    }
    Err(skew::explain(&m, ours, socket, running))
}

/// The spawn request. The host gives the child exactly this environment, so
/// this is where it is built: the caller's, except that this program is the
/// terminal, so `TERM` and friends are ours whatever the parent terminal said.
/// `shell` is `$SHELL`.
pub fn build_spec(
    new: &NewSession,
    shell: Option<String>,
    env: impl IntoIterator<Item = (String, String)>,
) -> SpawnSpec {
    let argv = if new.argv.is_empty() {
        let mut argv = vec![shell
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| fallback_shell().to_string())];
        if new.login {
            argv.push("-l".to_string());
        }
        argv
    } else {
        new.argv.clone()
    };
    let ours = ["TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"];
    let mut env: Vec<(String, String)> = env
        .into_iter()
        .filter(|(k, _)| !ours.contains(&k.as_str()))
        .collect();
    env.push(("TERM".into(), "xterm-256color".into()));
    env.push(("COLORTERM".into(), "truecolor".into()));
    env.push(("TERM_PROGRAM".into(), "canopy-term-app".into()));
    env.push((
        "TERM_PROGRAM_VERSION".into(),
        env!("CARGO_PKG_VERSION").into(),
    ));
    SpawnSpec {
        argv,
        cwd: Some(new.cwd.to_string_lossy().into_owned()),
        env,
        cols: new.cols,
        rows: new.rows,
        linger_secs: Some(new.linger_secs),
        key: new.key.clone(),
        ..Default::default()
    }
}

/// Starts a session (or, for a repeated key, finds it) and shows it.
pub fn open_new(client: &HostClient, spec: SpawnSpec) -> io::Result<Opened> {
    let (id, _pid, existing) = client.spawn_keyed(spec)?;
    open_attached(client, id, false, existing)
}

/// Attaches to session `id`. Without `force` the attach is exclusive: the host
/// refuses with `busy` if another client (the Canopy app, say) holds the
/// session, instead of disconnecting it. `redraw` nudges the program to
/// repaint, for a session that was already running.
pub fn open_attached(
    client: &HostClient,
    id: u32,
    force: bool,
    redraw: bool,
) -> io::Result<Opened> {
    let attached = if force {
        client.attach(id, 0)?
    } else {
        client.attach_exclusive(id, 0)?
    };
    wrap(client, id, attached, redraw)
}

fn wrap(client: &HostClient, id: u32, attached: Attached, redraw: bool) -> io::Result<Opened> {
    let Attached {
        stream,
        start,
        end,
        gap,
        cols,
        rows,
    } = attached;
    let reader = stream.try_clone()?;
    let writer = stream.try_clone()?;
    // History that left the ring (`gap`) cannot rebuild the screen, so the
    // program is asked to repaint, like for any session that was running.
    let wants_nudge = redraw || gap;
    let mut pending_nudge = wants_nudge;
    let control = client.clone();
    let on_resize = move |cols: u16, rows: u16| {
        let (first, last) = resize_plan(cols, rows, &mut pending_nudge);
        if let Some((c, r)) = first {
            let _ = control.resize(id, c, r);
            thread::sleep(NUDGE_PAUSE);
        }
        let _ = control.resize(id, last.0, last.1);
    };
    let on_close = move || {
        let _ = stream.shutdown(Shutdown::Both);
    };
    let link = StreamLink::new(
        reader,
        writer,
        end.saturating_sub(start),
        Limits::default(),
        on_resize,
        on_close,
    );
    if wants_nudge && cols > 0 && rows > 0 {
        let _ = link.request_resize(cols, rows);
    }
    Ok(Opened {
        link,
        id,
        cols,
        rows,
    })
}

/// A message for the user for a failed spawn or attach.
pub fn explain(error: &io::Error, socket: &Path, id: Option<u32>) -> String {
    if error.to_string() == BUSY {
        let which = id.map_or("the session".to_string(), |i| format!("session {i}"));
        return format!("{which} is attached by another client; use --force to take it over");
    }
    match error.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused => format!(
            "no PTY host is running at {} (start one with `canopy-term new`, or run \
             without --attach/--socket so this program starts one)",
            socket.display()
        ),
        _ => error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_term_session::{LinkRead, SessionLink};
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    fn until(mut done: impl FnMut() -> bool) {
        let start = Instant::now();
        while !done() {
            assert!(start.elapsed() < Duration::from_secs(10), "timed out");
            thread::sleep(Duration::from_millis(2));
        }
    }

    /// A stand-in for the host: answers `hello`, `resize` and `attach` in the
    /// real wire format, and records every request line and all input bytes.
    /// What the stand-in answers to the calls the version check makes.
    #[derive(Clone)]
    struct Behaviour {
        hello: String,
        list: String,
        /// Reply to `shutdown_if_idle`.
        idle: String,
        /// Whether an accepted shutdown takes the socket away, as a host that
        /// exits does.
        vanish: bool,
    }

    impl Default for Behaviour {
        fn default() -> Self {
            Behaviour {
                hello: "{\"ok\":true,\"version\":3,\"min_client\":1}".into(),
                list: "{\"ok\":true,\"sessions\":[]}".into(),
                idle: "{\"ok\":true}".into(),
                vanish: true,
            }
        }
    }

    struct FakeHost {
        socket: PathBuf,
        lines: Arc<Mutex<Vec<String>>>,
        input: Arc<Mutex<Vec<u8>>>,
    }

    fn serve(
        stream: UnixStream,
        lines: Arc<Mutex<Vec<String>>>,
        input: Arc<Mutex<Vec<u8>>>,
        behaviour: Behaviour,
        socket: PathBuf,
    ) {
        let Ok(clone) = stream.try_clone() else {
            return;
        };
        let mut reader = BufReader::new(clone);
        let mut out = stream;
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let line = line.trim().to_string();
        lines.lock().unwrap().push(line.clone());
        if line.contains("\"op\":\"hello\"") {
            let _ = out.write_all(format!("{}\n", behaviour.hello).as_bytes());
        } else if line.contains("\"op\":\"list\"") {
            let _ = out.write_all(format!("{}\n", behaviour.list).as_bytes());
        } else if line.contains("\"op\":\"shutdown_if_idle\"") {
            let _ = out.write_all(format!("{}\n", behaviour.idle).as_bytes());
            if behaviour.vanish && behaviour.idle.contains("\"ok\":true") {
                let _ = std::fs::remove_file(&socket);
            }
        } else if line.contains("\"op\":\"resize\"") {
            let _ = out.write_all(b"{\"ok\":true}\n");
        } else if line.contains("\"op\":\"attach\"") {
            if line.contains("\"id\":99") {
                let _ = out.write_all(b"{\"ok\":false,\"error\":\"busy\"}\n");
                return;
            }
            let reply = "{\"ok\":true,\"version\":3,\"start\":0,\"end\":5,\"gap\":false,\
                         \"cols\":80,\"rows\":24}\n";
            let _ = out.write_all(reply.as_bytes());
            let _ = out.write_all(b"hello!live");
            let mut buf = [0u8; 256];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => input.lock().unwrap().extend_from_slice(&buf[..n]),
                }
            }
        }
    }

    fn fake_host() -> FakeHost {
        fake_host_with(Behaviour::default())
    }

    fn fake_host_with(behaviour: Behaviour) -> FakeHost {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let socket = std::env::temp_dir().join(format!(
            "cta{}-{}.sock",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket).expect("bind fake host");
        let lines = Arc::new(Mutex::new(Vec::new()));
        let input = Arc::new(Mutex::new(Vec::new()));
        let (l, i) = (lines.clone(), input.clone());
        let path = socket.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (l, i) = (l.clone(), i.clone());
                let (b, s) = (behaviour.clone(), path.clone());
                thread::spawn(move || serve(stream, l, i, b, s));
            }
        });
        FakeHost {
            socket,
            lines,
            input,
        }
    }

    impl FakeHost {
        fn client(&self) -> HostClient {
            HostClient::new(&self.socket)
        }
        fn requests(&self, op: &str) -> Vec<String> {
            let tag = format!("\"op\":\"{op}\"");
            self.lines
                .lock()
                .unwrap()
                .iter()
                .filter(|l| l.contains(&tag))
                .cloned()
                .collect()
        }
    }

    impl Drop for FakeHost {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.socket);
        }
    }

    fn read(link: &mut StreamLink) -> (LinkRead, Vec<u8>) {
        let mut buf = [0u8; 64];
        let r = link.try_read(&mut buf).unwrap();
        let n = match r {
            LinkRead::Data(n) | LinkRead::Replay(n) => n,
            _ => 0,
        };
        (r, buf[..n].to_vec())
    }

    #[test]
    fn attach_replays_the_ring_then_goes_live_and_sends_input() {
        let host = fake_host();
        let mut opened = open_attached(&host.client(), 7, false, false).unwrap();
        assert_eq!((opened.id, opened.cols, opened.rows), (7, 80, 24));
        // Exclusive, from offset 0.
        let attach = host.requests("attach");
        assert_eq!(attach.len(), 1);
        assert!(attach[0].contains("\"exclusive\":true"), "{}", attach[0]);
        assert!(attach[0].contains("\"after\":0"), "{}", attach[0]);

        until(|| opened.link.queued() == 10);
        assert_eq!(
            read(&mut opened.link),
            (LinkRead::Replay(5), b"hello".to_vec())
        );
        assert_eq!(read(&mut opened.link).0, LinkRead::ReplayEnd);
        assert_eq!(
            read(&mut opened.link),
            (LinkRead::Data(5), b"!live".to_vec())
        );

        assert_eq!(opened.link.try_write(b"ls\r").unwrap(), 3);
        until(|| host.input.lock().unwrap().as_slice() == b"ls\r");
    }

    #[test]
    fn force_takes_the_session_over() {
        let host = fake_host();
        let _opened = open_attached(&host.client(), 7, true, false).unwrap();
        let attach = host.requests("attach");
        assert!(attach[0].contains("\"exclusive\":false"), "{}", attach[0]);
    }

    #[test]
    fn a_busy_session_is_explained() {
        let host = fake_host();
        let err = open_attached(&host.client(), 99, false, false)
            .err()
            .expect("busy");
        let text = explain(&err, &host.socket, Some(99));
        assert!(
            text.contains("session 99") && text.contains("--force"),
            "{text}"
        );
    }

    #[test]
    fn a_missing_host_is_explained() {
        let socket = std::env::temp_dir().join("cta-nobody-here.sock");
        let err = HostClient::new(&socket)
            .attach(1, 0)
            .err()
            .expect("no host");
        assert!(explain(&err, &socket, Some(1)).contains("no PTY host"));
    }

    #[test]
    fn resizes_reach_the_host_and_a_running_session_is_nudged_first() {
        let host = fake_host();
        let opened = open_attached(&host.client(), 7, false, true).unwrap();
        // The nudge: one row fewer, then the real size.
        until(|| host.requests("resize").len() == 2);
        let resizes = host.requests("resize");
        assert!(resizes[0].contains("\"rows\":23"), "{}", resizes[0]);
        assert!(resizes[1].contains("\"rows\":24"), "{}", resizes[1]);
        // A later resize is plain.
        opened.link.request_resize(100, 40).unwrap();
        until(|| host.requests("resize").len() == 3);
        let last = host.requests("resize").pop().unwrap();
        assert!(
            last.contains("\"cols\":100") && last.contains("\"rows\":40"),
            "{last}"
        );
    }

    #[test]
    fn a_fresh_session_is_not_nudged() {
        let host = fake_host();
        let opened = open_attached(&host.client(), 7, false, false).unwrap();
        opened.link.request_resize(100, 40).unwrap();
        until(|| !host.requests("resize").is_empty());
        let resizes = host.requests("resize");
        assert_eq!(resizes.len(), 1);
        assert!(resizes[0].contains("\"rows\":40"), "{}", resizes[0]);
    }

    #[test]
    fn the_spec_makes_this_program_the_terminal() {
        let new = NewSession {
            argv: vec![],
            cwd: PathBuf::from("/work"),
            key: Some("k".into()),
            linger_secs: 99,
            cols: 100,
            rows: 30,
            login: false,
        };
        let env = vec![
            ("PATH".to_string(), "/bin".to_string()),
            ("TERM".to_string(), "xterm-kitty".to_string()),
            ("TERM_PROGRAM".to_string(), "Apple_Terminal".to_string()),
        ];
        let spec = build_spec(&new, Some("/bin/zsh".into()), env);
        assert_eq!(spec.argv, vec!["/bin/zsh".to_string()]);
        assert_eq!(spec.cwd.as_deref(), Some("/work"));
        assert_eq!((spec.cols, spec.rows), (100, 30));
        assert_eq!(spec.linger_secs, Some(99));
        assert_eq!(spec.key.as_deref(), Some("k"));
        let get = |k: &str| {
            let all: Vec<&str> = spec
                .env
                .iter()
                .filter(|(n, _)| n == k)
                .map(|(_, v)| v.as_str())
                .collect();
            all
        };
        assert_eq!(get("PATH"), vec!["/bin"]);
        assert_eq!(get("TERM"), vec!["xterm-256color"]);
        assert_eq!(get("COLORTERM"), vec!["truecolor"]);
        assert_eq!(get("TERM_PROGRAM"), vec!["canopy-term-app"]);
    }

    #[test]
    fn a_command_and_the_shell_fallback() {
        let mut new = NewSession {
            argv: vec!["claude".into(), "--resume".into()],
            cwd: PathBuf::from("/"),
            key: None,
            linger_secs: 1,
            cols: 80,
            rows: 24,
            login: false,
        };
        assert_eq!(
            build_spec(&new, Some("/bin/zsh".into()), vec![]).argv,
            vec!["claude".to_string(), "--resume".to_string()]
        );
        new.argv.clear();
        assert_eq!(
            build_spec(&new, None, vec![]).argv,
            vec![fallback_shell().to_string()]
        );
        assert_eq!(
            build_spec(&new, Some(String::new()), vec![]).argv,
            vec![fallback_shell().to_string()]
        );
    }

    #[test]
    fn a_launcher_start_gets_a_login_shell_and_the_home_directory() {
        let mut new = NewSession {
            argv: vec![],
            cwd: PathBuf::from("/"),
            key: None,
            linger_secs: 1,
            cols: 80,
            rows: 24,
            login: true,
        };
        assert_eq!(
            build_spec(&new, Some("/bin/zsh".into()), vec![]).argv,
            vec!["/bin/zsh".to_string(), "-l".to_string()]
        );
        // A command is run as asked, whatever the flag.
        new.argv = vec!["claude".into()];
        assert_eq!(
            build_spec(&new, Some("/bin/zsh".into()), vec![]).argv,
            vec!["claude".to_string()]
        );
        let home = Some("/Users/u".to_string());
        assert_eq!(
            default_cwd(PathBuf::from("/"), home.clone()),
            PathBuf::from("/Users/u")
        );
        assert_eq!(
            default_cwd(PathBuf::from("/work"), home.clone()),
            PathBuf::from("/work")
        );
        assert_eq!(default_cwd(PathBuf::from("/"), None), PathBuf::from("/"));
        assert_eq!(
            default_cwd(PathBuf::from("/"), Some(String::new())),
            PathBuf::from("/")
        );
    }

    const DIGEST: &str = "0123456789abcdef";

    fn behaviour_of(app_version: Option<&str>, list: &str) -> Behaviour {
        let exe = app_version
            .map(|v| format!(",\"exe\":\"/h/.canopy/pty-host/bin/{v}-{DIGEST}/canopy-pty-host\""))
            .unwrap_or_default();
        Behaviour {
            hello: format!("{{\"ok\":true,\"version\":4,\"min_client\":1{exe}}}"),
            list: format!("{{\"ok\":true,\"sessions\":{list}}}"),
            ..Behaviour::default()
        }
    }

    const NONE: Duration = Duration::from_millis(300);

    #[test]
    fn a_host_of_the_same_version_is_shared_untouched() {
        let host = fake_host_with(behaviour_of(Some("0.5.15"), "[{\"id\":1}]"));
        vet(&host.client(), &host.socket, "0.5.15", true, NONE).unwrap();
        assert!(host.requests("shutdown_if_idle").is_empty());
    }

    #[test]
    fn a_host_of_another_version_with_terminals_is_refused_with_a_clear_message() {
        let host = fake_host_with(behaviour_of(
            Some("0.5.14"),
            "[{\"id\":1},{\"id\":2,\"exited\":0}]",
        ));
        let text = vet(&host.client(), &host.socket, "0.5.15", true, NONE).unwrap_err();
        assert!(text.contains("Canopy 0.5.14"), "{text}");
        assert!(text.contains("Canopy Terminal 0.5.15"), "{text}");
        assert!(text.contains("1 terminal(s)"), "{text}");
        assert!(text.contains("--socket"), "{text}");
        // It runs a terminal, so it was not asked to stop.
        assert!(host.requests("shutdown_if_idle").is_empty());
    }

    #[test]
    fn an_idle_host_of_another_version_is_stopped_so_ours_can_start() {
        let host = fake_host_with(behaviour_of(Some("0.5.14"), "[{\"id\":1,\"exited\":0}]"));
        vet(&host.client(), &host.socket, "0.5.15", true, NONE).unwrap();
        assert_eq!(host.requests("shutdown_if_idle").len(), 1);
    }

    #[test]
    fn a_socket_the_user_named_is_never_replaced() {
        let host = fake_host_with(behaviour_of(Some("0.5.14"), "[]"));
        let text = vet(&host.client(), &host.socket, "0.5.15", false, NONE).unwrap_err();
        assert!(text.contains("Canopy 0.5.14"), "{text}");
        assert!(host.requests("shutdown_if_idle").is_empty());
    }

    #[test]
    fn a_host_that_turns_out_busy_is_left_alone() {
        let mut b = behaviour_of(Some("0.5.14"), "[]");
        b.idle = "{\"ok\":false,\"error\":\"busy\",\"running\":2}".into();
        let host = fake_host_with(b);
        let text = vet(&host.client(), &host.socket, "0.5.15", true, NONE).unwrap_err();
        assert!(text.contains("2 terminal(s)"), "{text}");
    }

    #[test]
    fn a_host_that_will_not_stop_is_reported() {
        let mut b = behaviour_of(Some("0.5.14"), "[]");
        b.vanish = false;
        let host = fake_host_with(b);
        let text = vet(&host.client(), &host.socket, "0.5.15", true, NONE).unwrap_err();
        assert!(text.contains("still running"), "{text}");
    }

    #[test]
    fn a_host_too_old_to_name_its_origin_is_called_older() {
        let host = fake_host_with(behaviour_of(None, "[{\"id\":1}]"));
        let text = vet(&host.client(), &host.socket, "0.5.15", true, NONE).unwrap_err();
        assert!(text.contains("an older Canopy"), "{text}");
    }

    #[test]
    fn no_host_is_fine() {
        let socket = std::env::temp_dir().join("cta-vet-nobody.sock");
        vet(&HostClient::new(&socket), &socket, "0.5.15", true, NONE).unwrap();
    }
}
