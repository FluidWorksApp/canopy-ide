//! The unix implementation: every command except `--version`.

use canopy_pty_host::client::HostClient;
use canopy_pty_host::protocol::{SessionInfo, SpawnSpec};
use std::io::{self, Read, Write};
use std::os::unix::io::{AsRawFd, RawFd};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::{Duration, Instant};

const EXIT_ERROR: i32 = 1;
const EXIT_USAGE: i32 = 2;
const EXIT_NO_SESSION: i32 = 3;
const EXIT_NO_HOST: i32 = 4;
const EXIT_BUSY: i32 = 5;

/// Ctrl-]; followed by `d` it detaches, followed by itself it sends one Ctrl-].
const ESCAPE: u8 = 0x1d;
/// An idle host started by `new` exits after this long, like the app's.
const HOST_IDLE_SECS: u64 = 60;

const USAGE: &str = "\
canopy-term: command-line client for the Canopy persistent PTY host

usage: canopy-term [--socket PATH] [--dev] COMMAND ...

commands:
  ls [--json]                       list sessions
  new [--key KEY] [--cwd DIR] [-- CMD ARGS...]
                                    start a session (a repeated KEY returns the
                                    existing one); prints its id
  attach ID [--after N] [--force]   interactive passthrough; detach with Ctrl-] d
                                    (Ctrl-] Ctrl-] sends a literal Ctrl-])
  send ID TEXT [--enter]            type TEXT into the session (--enter adds CR);
                                    TEXT is `-` to read it from stdin (argv is
                                    visible in process lists, stdin is not)
  capture ID [--lines N]            print the tail of the replay ring as text
  wait ID                           block until the session exits, then exit with
                                    its exit code
  kill ID                           kill the session

options:
  --socket PATH   host socket (default: $CANOPY_PTY_HOST_SOCKET, else
                  $CANOPY_PTY_HOST_DIR/host.sock, else ~/.canopy/pty-host/host.sock)
  --dev           use the debug-build directory ~/.canopy/pty-host-dev
  --version       print the version and exit

exit codes: 0 ok, 1 error, 2 usage, 3 no such session, 4 host not running,
5 session is attached elsewhere, or the host does not say (see below).

The host has no read-only or input-only operation: attach, send and capture all
open the session's one data connection, and the host gives that connection to
the newest client, disconnecting whoever held it (for example the Canopy app's
terminal). So all three refuse (exit 5) unless the host reports the session as
not attached; an old host that does not report it counts as unknown, never as
free. Only `attach --force` takes a session over on purpose. send and capture
have no override. When they do connect, the session's linger clock starts at
the moment they close.
The check and the attach are two calls, so a client that attaches in between
is still disconnected. Closing that gap needs a host-side `attach` that only
succeeds if the session is free (not implemented; proposed to the host).

capture prints a byte replay of the host's ring buffer (escape sequences kept,
CRLF turned into LF), not a rendered screen.
";

struct Fail {
    code: i32,
    msg: String,
}

type Res<T> = Result<T, Fail>;

fn fail(code: i32, msg: impl Into<String>) -> Fail {
    Fail {
        code,
        msg: msg.into(),
    }
}

fn usage(msg: impl Into<String>) -> Fail {
    fail(EXIT_USAGE, format!("{} (see --help)", msg.into()))
}

fn io_fail(error: io::Error, socket: &Path) -> Fail {
    match error.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused => fail(
            EXIT_NO_HOST,
            format!("the host is not running (socket {})", socket.display()),
        ),
        _ => fail(EXIT_ERROR, error.to_string()),
    }
}

pub fn run(args: Vec<String>) -> i32 {
    match dispatch(args) {
        Ok(code) => code,
        Err(f) => {
            eprintln!("canopy-term: {}", f.msg);
            f.code
        }
    }
}

// ---------------------------------------------------------------- arguments

/// Index of the first `--`, or the length: options stop there.
fn opts_end(args: &[String]) -> usize {
    args.iter().position(|a| a == "--").unwrap_or(args.len())
}

fn take_flag(args: &mut Vec<String>, name: &str) -> bool {
    let end = opts_end(args);
    match args[..end].iter().position(|a| a == name) {
        Some(i) => {
            args.remove(i);
            true
        }
        None => false,
    }
}

fn take_opt(args: &mut Vec<String>, name: &str) -> Res<Option<String>> {
    let end = opts_end(args);
    let prefix = format!("{name}=");
    for i in 0..end {
        if args[i] == name {
            if i + 1 >= end {
                return Err(usage(format!("{name} needs a value")));
            }
            let value = args.remove(i + 1);
            args.remove(i);
            return Ok(Some(value));
        }
        if let Some(value) = args[i].strip_prefix(&prefix) {
            let value = value.to_string();
            args.remove(i);
            return Ok(Some(value));
        }
    }
    Ok(None)
}

fn take_number<T: std::str::FromStr>(args: &mut Vec<String>, name: &str) -> Res<Option<T>> {
    match take_opt(args, name)? {
        None => Ok(None),
        Some(v) => v
            .parse()
            .map(Some)
            .map_err(|_| usage(format!("{name} needs a number, got {v:?}"))),
    }
}

/// Splits at the first `--`: (before, after).
fn split_dd(args: Vec<String>) -> (Vec<String>, Vec<String>) {
    let end = opts_end(&args);
    let mut head = args;
    let tail = if end < head.len() {
        head.split_off(end + 1)
    } else {
        Vec::new()
    };
    head.truncate(end);
    (head, tail)
}

fn reject_unknown_options(args: &[String]) -> Res<()> {
    match args.iter().find(|a| a.starts_with('-') && a.len() > 1) {
        Some(a) => Err(usage(format!("unknown option {a}"))),
        None => Ok(()),
    }
}

fn parse_id(text: &str) -> Res<u32> {
    text.parse()
        .map_err(|_| usage(format!("session id must be a number, got {text:?}")))
}

/// Exactly one positional argument, the session id.
fn only_id(args: Vec<String>) -> Res<u32> {
    reject_unknown_options(&args)?;
    match args.as_slice() {
        [id] => parse_id(id),
        _ => Err(usage("expected exactly one session id")),
    }
}

fn socket_path(explicit: Option<String>, dev: bool) -> Res<PathBuf> {
    if let Some(path) = explicit {
        return Ok(PathBuf::from(path));
    }
    if let Ok(path) = std::env::var("CANOPY_PTY_HOST_SOCKET") {
        if !path.is_empty() {
            return Ok(PathBuf::from(path));
        }
    }
    if let Ok(dir) = std::env::var("CANOPY_PTY_HOST_DIR") {
        if !dir.is_empty() {
            return Ok(PathBuf::from(dir).join("host.sock"));
        }
    }
    let home = std::env::var("HOME").map_err(|_| {
        fail(
            EXIT_ERROR,
            "no HOME; pass --socket or set CANOPY_PTY_HOST_DIR",
        )
    })?;
    let leaf = if dev { "pty-host-dev" } else { "pty-host" };
    Ok(PathBuf::from(home)
        .join(".canopy")
        .join(leaf)
        .join("host.sock"))
}

fn dispatch(mut args: Vec<String>) -> Res<i32> {
    let socket = take_opt(&mut args, "--socket")?;
    let dev = take_flag(&mut args, "--dev");
    if args.is_empty() {
        eprint!("{USAGE}");
        return Ok(EXIT_USAGE);
    }
    let command = args.remove(0);
    if matches!(command.as_str(), "help" | "--help" | "-h") {
        print!("{USAGE}");
        return Ok(0);
    }
    if take_flag(&mut args, "--help") || take_flag(&mut args, "-h") {
        print!("{USAGE}");
        return Ok(0);
    }
    let socket = socket_path(socket, dev)?;
    let client = HostClient::new(&socket);
    match command.as_str() {
        "ls" => cmd_ls(&client, &socket, args),
        "kill" => cmd_kill(&client, &socket, args),
        "wait" => cmd_wait(&client, &socket, args),
        "new" => cmd_new(&socket, args),
        "send" => cmd_send(&client, &socket, args),
        "capture" => cmd_capture(&client, &socket, args),
        "attach" => cmd_attach(&client, &socket, args),
        other => Err(usage(format!("unknown command {other:?}"))),
    }
}

// ----------------------------------------------------------------- commands

fn list(client: &HostClient, socket: &Path) -> Res<Vec<SessionInfo>> {
    client.list().map_err(|e| io_fail(e, socket))
}

fn find(client: &HostClient, socket: &Path, id: u32) -> Res<SessionInfo> {
    list(client, socket)?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| fail(EXIT_NO_SESSION, format!("no such session {id}")))
}

fn cmd_ls(client: &HostClient, socket: &Path, mut args: Vec<String>) -> Res<i32> {
    let json = take_flag(&mut args, "--json");
    reject_unknown_options(&args)?;
    if !args.is_empty() {
        return Err(usage("ls takes no arguments"));
    }
    let sessions = list(client, socket)?;
    let mut out = String::new();
    if json {
        let rows: Vec<serde_json::Value> = sessions
            .iter()
            .map(|s| {
                serde_json::json!({
                    "id": s.id,
                    "pid": s.pid,
                    "size": { "cols": s.cols, "rows": s.rows },
                    "exited": s.exited,
                    "key": s.key,
                    "meta": s.meta,
                    "attached": s.attached,
                    "start": s.start,
                    "end": s.end,
                })
            })
            .collect();
        out.push_str(&serde_json::Value::Array(rows).to_string());
        out.push('\n');
    } else {
        out.push_str(&format!(
            "{:<5} {:<8} {:<8} {:<10} {:<20} {}\n",
            "ID", "PID", "SIZE", "STATE", "KEY", "META"
        ));
        for s in &sessions {
            let state = match (s.exited, s.attached) {
                (Some(code), _) => format!("exit {code}"),
                (None, Some(true)) => "attached".to_string(),
                (None, _) => "running".to_string(),
            };
            let meta: String = s
                .meta
                .as_deref()
                .and_then(|m| m.lines().next())
                .unwrap_or("-")
                .chars()
                .take(40)
                .collect();
            out.push_str(&format!(
                "{:<5} {:<8} {:<8} {:<10} {:<20} {}\n",
                s.id,
                s.pid.map(|p| p.to_string()).unwrap_or_else(|| "-".into()),
                format!("{}x{}", s.cols, s.rows),
                state,
                s.key.as_deref().unwrap_or("-"),
                meta
            ));
        }
    }
    let _ = io::stdout().write_all(out.as_bytes());
    Ok(0)
}

fn cmd_kill(client: &HostClient, socket: &Path, args: Vec<String>) -> Res<i32> {
    let id = only_id(args)?;
    find(client, socket, id)?;
    client.kill(id).map_err(|e| io_fail(e, socket))?;
    Ok(0)
}

fn cmd_wait(client: &HostClient, socket: &Path, args: Vec<String>) -> Res<i32> {
    let id = only_id(args)?;
    loop {
        let info = find(client, socket, id)?;
        if let Some(code) = info.exited {
            return Ok(code.rem_euclid(256));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// `$CANOPY_PTY_HOST_EXE`, else `canopy-pty-host` next to this executable.
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

fn cmd_new(socket: &Path, mut args: Vec<String>) -> Res<i32> {
    let key = take_opt(&mut args, "--key")?;
    let cwd = take_opt(&mut args, "--cwd")?;
    let (head, command) = split_dd(args);
    reject_unknown_options(&head)?;
    if !head.is_empty() {
        return Err(usage(format!(
            "unexpected argument {:?}; put the command after --",
            head[0]
        )));
    }
    let argv = if command.is_empty() {
        vec![std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/sh".into())]
    } else {
        command
    };
    let cwd = match cwd {
        Some(dir) => std::path::absolute(dir).map_err(|e| fail(EXIT_ERROR, e.to_string()))?,
        None => std::env::current_dir().map_err(|e| fail(EXIT_ERROR, e.to_string()))?,
    };
    // The host gives the child exactly this environment and nothing of its own.
    // Entries that are not valid UTF-8 cannot go over the JSON wire; skip them.
    let mut env: Vec<(String, String)> = std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect();
    if !env.iter().any(|(k, _)| k == "TERM") {
        env.push(("TERM".into(), "xterm-256color".into()));
    }
    let (cols, rows) = winsize().unwrap_or((80, 24));
    let spec = SpawnSpec {
        argv,
        cwd: Some(cwd.to_string_lossy().into_owned()),
        env,
        cols,
        rows,
        key,
        ..Default::default()
    };
    let mut client = HostClient::new(socket);
    if let Some(exe) = host_exe() {
        // Only `new` may start a host; every other command reports "not running".
        client = client.with_launch(exe, HOST_IDLE_SECS);
    }
    let (id, _pid, existing) = client.spawn_keyed(spec).map_err(|e| io_fail(e, socket))?;
    println!("{id}");
    if existing {
        eprintln!("canopy-term: key already in use, returned the existing session");
    }
    Ok(0)
}

/// Opens the session's data connection after checking nobody else holds it.
fn open_data(
    client: &HostClient,
    socket: &Path,
    id: u32,
    after: u64,
    force: bool,
) -> Res<canopy_pty_host::client::Attached> {
    let info = find(client, socket, id)?;
    // None is "unknown" (a host that predates the field), never "free".
    if !force {
        match info.attached {
            Some(false) => {}
            Some(true) => {
                return Err(fail(
                    EXIT_BUSY,
                    format!("session {id} is attached by another client"),
                ))
            }
            None => {
                return Err(fail(
                    EXIT_BUSY,
                    format!("the host does not report whether session {id} is attached"),
                ))
            }
        }
    }
    client.attach(id, after).map_err(|e| io_fail(e, socket))
}

fn cmd_send(client: &HostClient, socket: &Path, mut args: Vec<String>) -> Res<i32> {
    let enter = take_flag(&mut args, "--enter");
    let (head, tail) = split_dd(args);
    reject_unknown_options(&head)?;
    let positional: Vec<String> = head.into_iter().chain(tail).collect();
    let [id, text] = positional.as_slice() else {
        return Err(usage("usage: send ID TEXT [--enter]"));
    };
    let id = parse_id(id)?;
    let mut data = if text == "-" {
        let mut bytes = Vec::new();
        io::stdin()
            .read_to_end(&mut bytes)
            .map_err(|e| fail(EXIT_ERROR, e.to_string()))?;
        bytes
    } else {
        text.clone().into_bytes()
    };
    if enter {
        data.push(b'\r');
    }
    // A start past the end clamps to it, so nothing is replayed.
    let attached = open_data(client, socket, id, u64::MAX, false)?;
    let mut stream = attached.stream;
    stream
        .write_all(&data)
        .map_err(|e| fail(EXIT_ERROR, e.to_string()))?;
    close_cleanly(stream);
    Ok(0)
}

/// Half-closes, then waits for the host to close its side. The host clears the
/// session's `attached` flag and has written our bytes by then, and we do not
/// close on unread output. Without this a command run right after another
/// could still see the session as attached.
fn close_cleanly(mut stream: std::os::unix::net::UnixStream) {
    let _ = stream.shutdown(std::net::Shutdown::Write);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut sink = [0u8; 4096];
    while let Ok(n) = stream.read(&mut sink) {
        if n == 0 {
            break;
        }
    }
}

fn cmd_capture(client: &HostClient, socket: &Path, mut args: Vec<String>) -> Res<i32> {
    let lines: Option<usize> = take_number(&mut args, "--lines")?;
    let id = only_id(args)?;
    let attached = open_data(client, socket, id, 0, false)?;
    let want = attached.end.saturating_sub(attached.start) as usize;
    let mut stream = attached.stream;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut bytes = Vec::with_capacity(want);
    let mut buf = [0u8; 16384];
    while bytes.len() < want {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => bytes.extend_from_slice(&buf[..n]),
        }
    }
    bytes.truncate(want);
    close_cleanly(stream);
    let tail = match lines {
        Some(n) => last_lines(&bytes, n),
        None => &bytes[..],
    };
    let text = String::from_utf8_lossy(tail).replace("\r\n", "\n");
    let _ = io::stdout().write_all(text.as_bytes());
    Ok(0)
}

/// The last `n` lines of `bytes`, counting a final unterminated line.
fn last_lines(bytes: &[u8], n: usize) -> &[u8] {
    if n == 0 {
        return &[];
    }
    let body = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    let mut seen = 0;
    for (i, b) in body.iter().enumerate().rev() {
        if *b == b'\n' {
            seen += 1;
            if seen == n {
                return &bytes[i + 1..];
            }
        }
    }
    bytes
}

// ------------------------------------------------------------------- attach

/// Write end of the signal self-pipe, for the async signal handler.
static SIGNAL_PIPE: AtomicI32 = AtomicI32::new(-1);

extern "C" fn on_signal(sig: libc::c_int) {
    let fd = SIGNAL_PIPE.load(Ordering::Relaxed);
    if fd >= 0 {
        let byte = sig as u8;
        // SAFETY: write(2) is async-signal-safe; one byte to a non-blocking pipe.
        unsafe {
            libc::write(fd, &byte as *const u8 as *const libc::c_void, 1);
        }
    }
}

fn set_nonblocking_cloexec(fd: RawFd) {
    // SAFETY: plain fcntl calls on a descriptor we own.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
        let fdflags = libc::fcntl(fd, libc::F_GETFD);
        libc::fcntl(fd, libc::F_SETFD, fdflags | libc::FD_CLOEXEC);
    }
}

/// Routes SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGTSTP and SIGWINCH into a pipe the main loop polls,
/// so none of them can end the process with the terminal still in raw mode.
fn install_signals() -> io::Result<RawFd> {
    let mut fds = [0 as libc::c_int; 2];
    // SAFETY: pipe fills the two-element array.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    set_nonblocking_cloexec(fds[0]);
    set_nonblocking_cloexec(fds[1]);
    SIGNAL_PIPE.store(fds[1], Ordering::Relaxed);
    for sig in [
        libc::SIGINT,
        libc::SIGTERM,
        libc::SIGHUP,
        libc::SIGQUIT,
        libc::SIGTSTP,
        libc::SIGWINCH,
    ] {
        install_handler(sig);
    }
    Ok(fds[0])
}

fn install_handler(sig: libc::c_int) {
    // SAFETY: a zeroed sigaction is valid; the handler only calls write(2).
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
        libc::sigemptyset(&mut action.sa_mask);
        action.sa_flags = libc::SA_RESTART;
        libc::sigaction(sig, &action, std::ptr::null_mut());
    }
}

/// Puts a terminal into raw mode and puts it back when dropped, which covers
/// returns, errors and panics (not SIGKILL, which nothing can).
struct RawMode {
    fd: RawFd,
    saved: libc::termios,
}

impl RawMode {
    fn enter(fd: RawFd) -> Option<RawMode> {
        // SAFETY: termios is plain data; tcgetattr fills it for a tty descriptor.
        unsafe {
            if libc::isatty(fd) != 1 {
                return None;
            }
            let mut saved: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(fd, &mut saved) != 0 {
                return None;
            }
            let mut raw = saved;
            libc::cfmakeraw(&mut raw);
            if libc::tcsetattr(fd, libc::TCSANOW, &raw) != 0 {
                return None;
            }
            Some(RawMode { fd, saved })
        }
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        // SAFETY: restores the attributes read in `enter`.
        unsafe {
            libc::tcsetattr(self.fd, libc::TCSANOW, &self.saved);
        }
    }
}

fn winsize() -> Option<(u16, u16)> {
    for fd in [1, 0, 2] {
        // SAFETY: winsize is plain data; TIOCGWINSZ fills it.
        let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
        if unsafe { libc::ioctl(fd, libc::TIOCGWINSZ as _, &mut ws) } == 0
            && ws.ws_col > 0
            && ws.ws_row > 0
        {
            return Some((ws.ws_col, ws.ws_row));
        }
    }
    None
}

fn write_all_fd(fd: RawFd, mut data: &[u8]) -> io::Result<()> {
    while !data.is_empty() {
        // SAFETY: the pointer and length come from a live slice.
        let n = unsafe { libc::write(fd, data.as_ptr() as *const libc::c_void, data.len()) };
        if n < 0 {
            let error = io::Error::last_os_error();
            match error.kind() {
                io::ErrorKind::Interrupted => continue,
                io::ErrorKind::WouldBlock => {
                    let mut p = libc::pollfd {
                        fd,
                        events: libc::POLLOUT,
                        revents: 0,
                    };
                    // SAFETY: one valid pollfd.
                    unsafe { libc::poll(&mut p, 1, 1000) };
                    continue;
                }
                _ => return Err(error),
            }
        }
        data = &data[n as usize..];
    }
    Ok(())
}

enum Outcome {
    Detached,
    Ended,
    Signal(i32),
}

fn push_size(client: &HostClient, id: u32) {
    if let Some((cols, rows)) = winsize() {
        let _ = client.resize(id, cols, rows);
    }
}

/// A resize to the size a terminal already has sends no SIGWINCH, so on attach
/// shrink by one row and restore, like the app's adopt path: an idle full-screen
/// program then redraws instead of leaving a blank screen.
fn nudge_redraw(client: &HostClient, id: u32) {
    if let Some((cols, rows)) = winsize() {
        if rows >= 2 {
            let _ = client.resize(id, cols, rows - 1);
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = client.resize(id, cols, rows);
    }
}

fn cmd_attach(client: &HostClient, socket: &Path, mut args: Vec<String>) -> Res<i32> {
    let after: Option<u64> = take_number(&mut args, "--after")?;
    let force = take_flag(&mut args, "--force");
    let id = only_id(args)?;
    // Without --after nothing is replayed: the screen redraws on the resize below.
    let attached = open_data(client, socket, id, after.unwrap_or(u64::MAX), force)?;
    let signals = install_signals().map_err(|e| fail(EXIT_ERROR, e.to_string()))?;
    let mut stream = attached.stream;
    let sock_fd = stream.as_raw_fd();

    let mut raw = RawMode::enter(0);
    nudge_redraw(client, id);

    let mut fds = [
        libc::pollfd {
            fd: 0,
            events: libc::POLLIN,
            revents: 0,
        },
        libc::pollfd {
            fd: sock_fd,
            events: libc::POLLIN,
            revents: 0,
        },
        libc::pollfd {
            fd: signals,
            events: libc::POLLIN,
            revents: 0,
        },
    ];
    let readable = libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL;
    let mut pending_escape = false;
    let mut buf = [0u8; 8192];
    let outcome = 'main: loop {
        for f in fds.iter_mut() {
            f.revents = 0;
        }
        // SAFETY: three valid pollfds.
        let ready = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, -1) };
        if ready < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            break Outcome::Ended;
        }
        if fds[2].revents & libc::POLLIN != 0 {
            let mut sigs = [0u8; 64];
            // SAFETY: reads into a local buffer from our own non-blocking pipe.
            let n = unsafe { libc::read(signals, sigs.as_mut_ptr() as *mut libc::c_void, 64) };
            for &sig in sigs.iter().take(n.max(0) as usize) {
                if sig as i32 == libc::SIGWINCH {
                    push_size(client, id);
                } else if sig as i32 == libc::SIGTSTP {
                    // Give the terminal back, stop for real, and take it again
                    // when continued. (SIGSTOP cannot be caught.)
                    drop(raw.take());
                    // SAFETY: default disposition, then stop ourselves.
                    unsafe {
                        libc::signal(libc::SIGTSTP, libc::SIG_DFL);
                        libc::raise(libc::SIGTSTP);
                    }
                    install_handler(libc::SIGTSTP);
                    raw = RawMode::enter(0);
                    nudge_redraw(client, id);
                } else {
                    break 'main Outcome::Signal(sig as i32);
                }
            }
        }
        if fds[0].revents & readable != 0 {
            // SAFETY: reads into a local buffer from stdin.
            let n = unsafe { libc::read(0, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
            if n == 0 {
                break Outcome::Detached; // stdin closed
            }
            if n < 0 {
                match io::Error::last_os_error().kind() {
                    io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock => continue,
                    _ => break Outcome::Detached,
                }
            }
            let mut out = Vec::with_capacity(n as usize + 1);
            let mut detach = false;
            for &b in &buf[..n as usize] {
                if pending_escape {
                    pending_escape = false;
                    match b {
                        b'd' => {
                            detach = true;
                            break;
                        }
                        ESCAPE => out.push(ESCAPE),
                        other => {
                            out.push(ESCAPE);
                            out.push(other);
                        }
                    }
                } else if b == ESCAPE {
                    pending_escape = true;
                } else {
                    out.push(b);
                }
            }
            if !out.is_empty() && stream.write_all(&out).is_err() {
                break Outcome::Ended;
            }
            if detach {
                break Outcome::Detached;
            }
        }
        if fds[1].revents & readable != 0 {
            match stream.read(&mut buf) {
                Ok(0) => break Outcome::Ended,
                Ok(n) => {
                    if write_all_fd(1, &buf[..n]).is_err() {
                        break Outcome::Detached;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => break Outcome::Ended,
            }
        }
    };
    // Terminal back to normal before anything is printed.
    drop(raw);
    close_cleanly(stream);
    match outcome {
        Outcome::Detached => {
            eprintln!("[detached from session {id}]");
            Ok(0)
        }
        Outcome::Signal(sig) => {
            eprintln!("[detached from session {id}: signal {sig}]");
            Ok(128 + sig)
        }
        Outcome::Ended => {
            // The reaper records the status a moment after the output ends.
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut code = None;
            while Instant::now() < deadline {
                match client.list() {
                    Ok(sessions) => match sessions.into_iter().find(|s| s.id == id) {
                        Some(s) if s.exited.is_some() => {
                            code = s.exited;
                            break;
                        }
                        Some(_) => {}
                        None => break,
                    },
                    Err(_) => break,
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            match code {
                Some(c) => {
                    eprintln!("[session {id} ended, exit code {c}]");
                    Ok(c.rem_euclid(256))
                }
                None => {
                    eprintln!("[connection to session {id} closed]");
                    Ok(EXIT_ERROR)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_lines_counts_from_the_end() {
        assert_eq!(last_lines(b"a\nb\nc\n", 2), b"b\nc\n");
        assert_eq!(last_lines(b"a\nb\nc", 2), b"b\nc");
        assert_eq!(last_lines(b"a\nb\nc\n", 10), b"a\nb\nc\n");
        assert_eq!(last_lines(b"a\nb\n", 0), b"");
    }

    #[test]
    fn dd_splits_once() {
        let (h, t) = split_dd(vec![
            "--key".into(),
            "k".into(),
            "--".into(),
            "ls".into(),
            "--".into(),
        ]);
        assert_eq!(h, vec!["--key", "k"]);
        assert_eq!(t, vec!["ls", "--"]);
        let (h, t) = split_dd(vec!["a".into()]);
        assert_eq!((h, t), (vec!["a".to_string()], vec![]));
    }

    #[test]
    fn options_stop_at_dd() {
        let mut args: Vec<String> = vec!["--json".into(), "--".into(), "--json".into()];
        assert!(take_flag(&mut args, "--json"));
        assert!(!take_flag(&mut args, "--json"));
        assert_eq!(args, vec!["--", "--json"]);
    }
}
