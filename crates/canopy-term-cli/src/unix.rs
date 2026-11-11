//! The unix implementation: every command except `--version`.

use canopy_pty_host::client::HostClient;
use canopy_pty_host::protocol::{SessionInfo, SpawnSpec};
use std::io::{self, Read, Write};
use std::os::unix::io::{AsRawFd, RawFd};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicPtr, Ordering};
use std::time::{Duration, Instant};

const EXIT_ERROR: i32 = 1;
const EXIT_USAGE: i32 = 2;
const EXIT_NO_SESSION: i32 = 3;
const EXIT_NO_HOST: i32 = 4;
const EXIT_BUSY: i32 = 5;
const EXIT_GONE: i32 = 6;
const EXIT_TIMEOUT: i32 = 124;

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
                                    (Ctrl-] Ctrl-] sends a literal Ctrl-]); on
                                    exit the outer terminal's modes are reset
  send ID TEXT [--enter] [--force]  type TEXT into the session (--enter adds CR);
                                    TEXT is `-` to read it from stdin (argv is
                                    visible in process lists, stdin is not)
  capture ID [--lines N]            print the tail of the replay ring as text
  wait ID [--timeout SECS]          block until the session exits, then exit with
                                    its exit code (124 on timeout, 6 if the session
                                    went away without a recorded exit code)
  kill ID                           kill the session

options:
  --socket PATH   host socket (default: $CANOPY_PTY_HOST_SOCKET, else
                  $CANOPY_PTY_HOST_DIR/host.sock, else ~/.canopy/pty-host/host.sock)
  --dev           use the debug-build directory ~/.canopy/pty-host-dev
  --version       print the version and exit

exit codes: 0 ok, 1 error, 2 usage, 3 no such session, 4 host not running,
5 session is attached elsewhere (see below), or taken over while attached,
6 session gone without an exit code (wait), 124 timeout (wait). wait otherwise
exits with the session's own code, which can coincide with these.

new starts a host only for the default socket (~/.canopy/pty-host, or
pty-host-dev with --dev), because starting one makes its directory private
(mode 0700). For --socket, CANOPY_PTY_HOST_SOCKET or CANOPY_PTY_HOST_DIR the
host must already be running.

attach and send open the session's one data connection, which the host would
otherwise hand to the newest client, disconnecting whoever held it (for example
the Canopy app's terminal). They use an exclusive attach: the host refuses
atomically (exit 5) if a client is attached, and only --force takes a session
over on purpose. Both need a host speaking protocol 3 or newer and report an
error against an older one. When send connects, the session's linger clock
starts at the moment it closes. capture reads the replay ring without
attaching and never disturbs the attached client.

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
            let _ = writeln!(io::stderr(), "canopy-term: {}", f.msg);
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

/// The socket, and whether it is the default dedicated directory, the only
/// place `new` may start a host (starting one chmods the directory to 0700).
fn socket_path(explicit: Option<String>, dev: bool) -> Res<(PathBuf, bool)> {
    if let Some(path) = explicit {
        return Ok((PathBuf::from(path), false));
    }
    if let Ok(path) = std::env::var("CANOPY_PTY_HOST_SOCKET") {
        if !path.is_empty() {
            return Ok((PathBuf::from(path), false));
        }
    }
    if let Ok(dir) = std::env::var("CANOPY_PTY_HOST_DIR") {
        if !dir.is_empty() {
            return Ok((PathBuf::from(dir).join("host.sock"), false));
        }
    }
    let home = std::env::var("HOME").map_err(|_| {
        fail(
            EXIT_ERROR,
            "no HOME; pass --socket or set CANOPY_PTY_HOST_DIR",
        )
    })?;
    let leaf = if dev { "pty-host-dev" } else { "pty-host" };
    Ok((
        PathBuf::from(home)
            .join(".canopy")
            .join(leaf)
            .join("host.sock"),
        true,
    ))
}

fn dispatch(mut args: Vec<String>) -> Res<i32> {
    let socket = take_opt(&mut args, "--socket")?;
    let dev = take_flag(&mut args, "--dev");
    if args.is_empty() {
        let _ = write!(io::stderr(), "{USAGE}");
        return Ok(EXIT_USAGE);
    }
    let command = args.remove(0);
    if matches!(command.as_str(), "help" | "--help" | "-h") {
        let _ = write!(io::stdout(), "{USAGE}");
        return Ok(0);
    }
    if take_flag(&mut args, "--help") || take_flag(&mut args, "-h") {
        let _ = write!(io::stdout(), "{USAGE}");
        return Ok(0);
    }
    let (socket, launchable) = socket_path(socket, dev)?;
    let client = HostClient::new(&socket);
    match command.as_str() {
        "ls" => cmd_ls(&client, &socket, args),
        "kill" => cmd_kill(&client, &socket, args),
        "wait" => cmd_wait(&client, &socket, args),
        "new" => cmd_new(&socket, launchable, args),
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
    // It can vanish between the two calls.
    client.kill(id).map_err(|e| host_fail(e, socket, id))?;
    Ok(0)
}

/// Polls every 20 ms: the app reaps an exited session within about 50 ms, and a
/// reaped session's exit code is gone. A blocking `wait` op on the host would
/// remove that race (requested as a follow-up).
fn cmd_wait(client: &HostClient, socket: &Path, mut args: Vec<String>) -> Res<i32> {
    let timeout: Option<f64> = take_number(&mut args, "--timeout")?;
    let id = only_id(args)?;
    let deadline = timeout.map(|t| Instant::now() + Duration::from_secs_f64(t.max(0.0)));
    // Pinned to the pid first seen, so a restarted host reusing the id is not
    // mistaken for the same session.
    let first = find(client, socket, id)?;
    let pid = first.pid;
    let mut info = Some(first);
    loop {
        match info {
            Some(s) if s.pid == pid => {
                if let Some(code) = s.exited {
                    return Ok(code.rem_euclid(256));
                }
            }
            _ => {
                return Err(fail(
                    EXIT_GONE,
                    format!("session {id} went away without a recorded exit code (reaped by another client?)"),
                ))
            }
        }
        if deadline.is_some_and(|d| Instant::now() >= d) {
            return Err(fail(EXIT_TIMEOUT, format!("session {id} still running")));
        }
        std::thread::sleep(Duration::from_millis(20));
        info = list(client, socket)?.into_iter().find(|s| s.id == id);
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

fn cmd_new(socket: &Path, launchable: bool, mut args: Vec<String>) -> Res<i32> {
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
    if launchable {
        if let Some(exe) = host_exe() {
            // Only `new`, and only for the default directory, may start a host.
            client = client.with_launch(exe, HOST_IDLE_SECS);
        }
    }
    let (id, _pid, existing) = client.spawn_keyed(spec).map_err(|e| {
        let mut f = io_fail(e, socket);
        if f.code == EXIT_NO_HOST && !launchable {
            f.msg
                .push_str("; canopy-term starts a host only for the default socket");
        }
        f
    })?;
    let _ = writeln!(io::stdout(), "{id}");
    if existing {
        say(format_args!(
            "canopy-term: key already in use, returned the existing session"
        ));
    }
    Ok(0)
}

/// Maps a host refusal to its exit code; anything else goes through `io_fail`.
fn host_fail(error: io::Error, socket: &Path, id: u32) -> Fail {
    let text = error.to_string();
    if text == canopy_pty_host::protocol::BUSY {
        fail(
            EXIT_BUSY,
            format!("session {id} is attached elsewhere (--force takes it over)"),
        )
    } else if text.contains("no such session") {
        fail(EXIT_NO_SESSION, format!("no such session {id}"))
    } else {
        io_fail(error, socket)
    }
}

/// Opens the session's data connection. Unless `force`, the host refuses
/// atomically when a client is attached (exclusive attach, protocol 3). A host
/// older than that is an error, never a fallback to a racy client-side check.
fn open_data(
    client: &HostClient,
    socket: &Path,
    id: u32,
    after: u64,
    force: bool,
) -> Res<canopy_pty_host::client::Attached> {
    let attached = if force {
        client.attach(id, after)
    } else {
        client.attach_exclusive(id, after)
    };
    attached.map_err(|e| host_fail(e, socket, id))
}

fn cmd_send(client: &HostClient, socket: &Path, mut args: Vec<String>) -> Res<i32> {
    let enter = take_flag(&mut args, "--enter");
    let force = take_flag(&mut args, "--force");
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
    if find(client, socket, id)?.exited.is_some() {
        return Err(fail(EXIT_ERROR, format!("session {id} has exited")));
    }
    // A start past the end clamps to it, so nothing is replayed.
    let attached = open_data(client, socket, id, u64::MAX, force)?;
    let mut stream = attached.stream;
    // A session that never reads its input must not hang send.
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
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
    // Read-only: never takes the data connection from whoever is attached.
    let (_, bytes) = client
        .read_ring(id, 0, None)
        .map_err(|e| host_fail(e, socket, id))?;
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

/// Escape keys: Ctrl-] as a plain byte, or as the kitty keyboard protocol sends
/// it once an inner program has pushed kitty flags onto the outer terminal.
const ESCAPE_KEYS: [&[u8]; 3] = [b"\x1d", b"\x1b[93;5u", b"\x1b[93;5:1u"];
/// The kitty release event for Ctrl-]; ignored between the two keys.
const ESCAPE_RELEASE: [&[u8]; 1] = [b"\x1b[93;5:3u"];
/// `d`, plain or kitty-encoded.
const DETACH_KEYS: [&[u8]; 4] = [b"d", b"\x1b[100u", b"\x1b[100;1u", b"\x1b[100;1:1u"];

/// Undoes terminal modes an inner program may have turned on in the outer
/// terminal: attributes, alternate screen, mouse tracking, bracketed paste,
/// application cursor keys and keypad, one level of kitty keyboard flags, and a
/// hidden cursor.
const RESET: &[u8] = b"\x1b[0m\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?1l\x1b>\x1b[<u\x1b[?25h";

/// Stop reading stdin only past this much unsent input (far more than any real
/// paste), so Ctrl-] and signals are never stuck behind a stalled host.
const HOST_QUEUE_CAP: usize = 64 << 20;
/// Stop reading the session while this much output waits for the terminal.
const OUT_QUEUE_CAP: usize = 1 << 20;
/// How long a lone ESC or a partial escape sequence is held before it is sent.
const HOLD_MS: libc::c_int = 50;

enum Match {
    Full(usize),
    Partial,
    No,
}

fn match_any(rest: &[u8], keys: &[&[u8]]) -> Match {
    let mut partial = false;
    for key in keys {
        if rest.starts_with(key) {
            return Match::Full(key.len());
        }
        if key.starts_with(rest) {
            partial = true;
        }
    }
    if partial {
        Match::Partial
    } else {
        Match::No
    }
}

/// Finds the detach sequence (an escape key, then `d`) in stdin, across reads.
/// Everything else passes through unchanged; the escape key twice sends one.
#[derive(Default)]
struct EscapeFilter {
    /// The tail of the last read that may be the start of a key sequence.
    held: Vec<u8>,
    /// The escape key just seen, still waiting for the next key.
    pending: Option<Vec<u8>>,
}

impl EscapeFilter {
    /// Appends what should reach the session to `out`; true means detach.
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> bool {
        let mut buf = std::mem::take(&mut self.held);
        buf.extend_from_slice(input);
        let mut i = 0;
        while i < buf.len() {
            let rest = &buf[i..];
            if self.pending.is_some() {
                let mut partial = false;
                match match_any(rest, &DETACH_KEYS) {
                    Match::Full(_) => {
                        self.pending = None;
                        return true;
                    }
                    Match::Partial => partial = true,
                    Match::No => {}
                }
                match match_any(rest, &ESCAPE_RELEASE) {
                    Match::Full(n) => {
                        i += n;
                        continue;
                    }
                    Match::Partial => partial = true,
                    Match::No => {}
                }
                match match_any(rest, &ESCAPE_KEYS) {
                    Match::Full(n) => {
                        // Escape twice: send it once, literally.
                        out.extend_from_slice(&rest[..n]);
                        self.pending = None;
                        i += n;
                        continue;
                    }
                    Match::Partial => partial = true,
                    Match::No => {}
                }
                if partial {
                    self.held = rest.to_vec();
                    return false;
                }
                // Not a detach: the escape key goes through, then this byte is
                // read again normally.
                if let Some(key) = self.pending.take() {
                    out.extend_from_slice(&key);
                }
                continue;
            }
            if rest[0] != 0x1d && rest[0] != 0x1b {
                out.push(rest[0]);
                i += 1;
                continue;
            }
            match match_any(rest, &ESCAPE_KEYS) {
                Match::Full(n) => {
                    self.pending = Some(rest[..n].to_vec());
                    i += n;
                }
                Match::Partial => {
                    self.held = rest.to_vec();
                    return false;
                }
                Match::No => {
                    out.push(rest[0]);
                    i += 1;
                }
            }
        }
        false
    }

    /// Whether bytes are held waiting for the rest of a sequence.
    fn holding(&self) -> bool {
        !self.held.is_empty()
    }

    /// The hold timed out: what was held was a key of its own (a lone ESC).
    fn flush(&mut self, out: &mut Vec<u8>) {
        if self.held.is_empty() {
            return;
        }
        if let Some(key) = self.pending.take() {
            out.extend_from_slice(&key);
        }
        out.append(&mut self.held);
    }
}

/// Write end of the signal self-pipe, for the async signal handler.
static SIGNAL_PIPE: AtomicI32 = AtomicI32::new(-1);
/// The terminal attributes to restore, for the backstop in the alarm handler.
static SAVED_TERMIOS: AtomicPtr<libc::termios> = AtomicPtr::new(std::ptr::null_mut());
/// Original file status flags of fds 0 and 1 (-1: not changed).
static SAVED_FL: [AtomicI32; 2] = [AtomicI32::new(-1), AtomicI32::new(-1)];
/// Whether stdout is a terminal, so the reset sequence is worth writing.
static OUT_IS_TTY: AtomicBool = AtomicBool::new(false);
/// The terminating signal the main loop has not yet acted on.
static PENDING_SIGNAL: AtomicI32 = AtomicI32::new(0);

const TERMINATING: [libc::c_int; 4] = [libc::SIGINT, libc::SIGTERM, libc::SIGHUP, libc::SIGQUIT];
const ROUTED: [libc::c_int; 6] = [
    libc::SIGINT,
    libc::SIGTERM,
    libc::SIGHUP,
    libc::SIGQUIT,
    libc::SIGTSTP,
    libc::SIGWINCH,
];

extern "C" fn on_signal(sig: libc::c_int) {
    let fd = SIGNAL_PIPE.load(Ordering::Relaxed);
    if fd >= 0 {
        let byte = sig as u8;
        // SAFETY: write(2) is async-signal-safe; one byte to a non-blocking pipe.
        unsafe {
            libc::write(fd, &byte as *const u8 as *const libc::c_void, 1);
        }
    }
    if TERMINATING.contains(&sig) {
        PENDING_SIGNAL.store(sig, Ordering::Relaxed);
        // Backstop: if the main loop has not restored the terminal within a
        // second, the alarm handler does it and exits.
        // SAFETY: alarm(2) is async-signal-safe.
        unsafe {
            libc::alarm(1);
        }
    }
}

/// Only async-signal-safe calls: write, fcntl, tcsetattr, _exit.
extern "C" fn on_alarm(_sig: libc::c_int) {
    // SAFETY: every call here is async-signal-safe and reads saved plain data.
    unsafe {
        if OUT_IS_TTY.load(Ordering::Relaxed) {
            // Before the flags are restored, so a stuck terminal cannot block it.
            libc::write(1, RESET.as_ptr() as *const libc::c_void, RESET.len());
        }
        for (fd, saved) in SAVED_FL.iter().enumerate() {
            let flags = saved.load(Ordering::Relaxed);
            if flags >= 0 {
                libc::fcntl(fd as libc::c_int, libc::F_SETFL, flags);
            }
        }
        let termios = SAVED_TERMIOS.load(Ordering::Relaxed);
        if !termios.is_null() {
            libc::tcsetattr(0, libc::TCSANOW, termios);
        }
        libc::_exit(128 + PENDING_SIGNAL.load(Ordering::Relaxed));
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

/// Routes the terminating signals, SIGTSTP and SIGWINCH into a pipe the main
/// loop polls, so none of them can end the process with the terminal raw.
fn install_signals() -> io::Result<RawFd> {
    let mut fds = [0 as libc::c_int; 2];
    // SAFETY: pipe fills the two-element array.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    set_nonblocking_cloexec(fds[0]);
    set_nonblocking_cloexec(fds[1]);
    SIGNAL_PIPE.store(fds[1], Ordering::Relaxed);
    for sig in ROUTED {
        install_handler(sig, on_signal);
    }
    install_handler(libc::SIGALRM, on_alarm);
    Ok(fds[0])
}

fn install_handler(sig: libc::c_int, handler: extern "C" fn(libc::c_int)) {
    // SAFETY: a zeroed sigaction is valid; the handlers are async-signal-safe.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = handler as libc::sighandler_t;
        libc::sigemptyset(&mut action.sa_mask);
        action.sa_flags = libc::SA_RESTART;
        libc::sigaction(sig, &action, std::ptr::null_mut());
    }
}

fn uninstall_signals() {
    // SAFETY: cancels the backstop, then back to the default dispositions.
    unsafe {
        libc::alarm(0);
        for sig in ROUTED {
            libc::signal(sig, libc::SIG_DFL);
        }
        libc::signal(libc::SIGALRM, libc::SIG_DFL);
    }
}

/// Writes what it can within `limit`, for output that must not hang an exit.
fn write_with_deadline(fd: RawFd, mut data: &[u8], limit: Duration) {
    let deadline = Instant::now() + limit;
    while !data.is_empty() && Instant::now() < deadline {
        // SAFETY: the pointer and length come from a live slice.
        let n = unsafe { libc::write(fd, data.as_ptr() as *const libc::c_void, data.len()) };
        if n > 0 {
            data = &data[n as usize..];
            continue;
        }
        let error = io::Error::last_os_error();
        match error.kind() {
            io::ErrorKind::Interrupted => {}
            io::ErrorKind::WouldBlock => {
                let mut p = libc::pollfd {
                    fd,
                    events: libc::POLLOUT,
                    revents: 0,
                };
                // SAFETY: one valid pollfd.
                unsafe { libc::poll(&mut p, 1, 50) };
            }
            _ => return,
        }
    }
}

/// The local terminal while attached: raw mode, fds 0 and 1 non-blocking (both
/// flags live on the open file description the shell shares, so they must go
/// back). Dropping it writes the mode reset and restores both, on every path
/// out of the loop including errors and panics (SIGKILL aside).
struct Terminal {
    raw: bool,
}

impl Terminal {
    fn enter() -> Terminal {
        // SAFETY: termios is plain data; tcgetattr fills it for a tty; fcntl
        // only changes status flags, whose originals are saved first.
        unsafe {
            OUT_IS_TTY.store(libc::isatty(1) == 1, Ordering::Relaxed);
            let mut raw = false;
            let mut saved: libc::termios = std::mem::zeroed();
            if libc::isatty(0) == 1 && libc::tcgetattr(0, &mut saved) == 0 {
                if SAVED_TERMIOS.load(Ordering::Relaxed).is_null() {
                    // Leaked on purpose: the alarm handler may read it at any time.
                    SAVED_TERMIOS.store(Box::into_raw(Box::new(saved)), Ordering::Relaxed);
                }
                let mut attrs = saved;
                libc::cfmakeraw(&mut attrs);
                raw = libc::tcsetattr(0, libc::TCSANOW, &attrs) == 0;
            }
            for (fd, slot) in SAVED_FL.iter().enumerate() {
                let flags = libc::fcntl(fd as libc::c_int, libc::F_GETFL);
                if flags >= 0 {
                    slot.store(flags, Ordering::Relaxed);
                    libc::fcntl(fd as libc::c_int, libc::F_SETFL, flags | libc::O_NONBLOCK);
                }
            }
            Terminal { raw }
        }
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        if OUT_IS_TTY.load(Ordering::Relaxed) {
            write_with_deadline(1, RESET, Duration::from_millis(300));
        }
        // SAFETY: restores the flags and attributes saved in `enter`.
        unsafe {
            for (fd, slot) in SAVED_FL.iter().enumerate() {
                let flags = slot.swap(-1, Ordering::Relaxed);
                if flags >= 0 {
                    libc::fcntl(fd as libc::c_int, libc::F_SETFL, flags);
                }
            }
            let termios = SAVED_TERMIOS.load(Ordering::Relaxed);
            if self.raw && !termios.is_null() {
                libc::tcsetattr(0, libc::TCSANOW, termios);
            }
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
/// program then redraws instead of leaving a blank screen. The pause keeps the
/// two resizes from reaching the program as one SIGWINCH at the old size.
fn nudge_redraw(client: &HostClient, id: u32) {
    if let Some((cols, rows)) = winsize() {
        if rows >= 2 {
            let _ = client.resize(id, cols, rows - 1);
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = client.resize(id, cols, rows);
    }
}

fn is_would_block(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    )
}

/// A status line on stderr that never panics, even with stderr gone (SIGHUP).
fn say(text: std::fmt::Arguments) {
    let _ = writeln!(io::stderr(), "{text}");
}

fn cmd_attach(client: &HostClient, socket: &Path, mut args: Vec<String>) -> Res<i32> {
    let after: Option<u64> = take_number(&mut args, "--after")?;
    let force = take_flag(&mut args, "--force");
    let id = only_id(args)?;
    // Without --after nothing is replayed: the screen redraws on the nudge below.
    let attached = open_data(client, socket, id, after.unwrap_or(u64::MAX), force)?;
    let signals = install_signals().map_err(|e| fail(EXIT_ERROR, e.to_string()))?;
    let mut stream = attached.stream;
    stream
        .set_nonblocking(true)
        .map_err(|e| fail(EXIT_ERROR, e.to_string()))?;
    let sock_fd = stream.as_raw_fd();

    let mut terminal = Some(Terminal::enter());
    nudge_redraw(client, id);

    let readable = libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL;
    let writable = libc::POLLOUT | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL;
    let mut filter = EscapeFilter::default();
    let mut to_host: Vec<u8> = Vec::new();
    let mut to_out: Vec<u8> = Vec::new();
    let mut buf = vec![0u8; 65536];
    // Nothing in this loop blocks except poll itself, so signals and the detach
    // key are always handled.
    let outcome = 'main: loop {
        // A descriptor of -1 is skipped by poll; a zero event mask would still
        // report hang-ups and spin.
        let gate = |on: bool, fd: RawFd| if on { fd } else { -1 };
        let mut fds = [
            libc::pollfd {
                fd: gate(to_host.len() < HOST_QUEUE_CAP, 0),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: gate(to_out.len() < OUT_QUEUE_CAP, sock_fd),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: gate(!to_host.is_empty(), sock_fd),
                events: libc::POLLOUT,
                revents: 0,
            },
            libc::pollfd {
                fd: gate(!to_out.is_empty(), 1),
                events: libc::POLLOUT,
                revents: 0,
            },
            libc::pollfd {
                fd: signals,
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        let timeout = if filter.holding() { HOLD_MS } else { -1 };
        // SAFETY: five valid pollfds.
        let ready = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) };
        if ready < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            break Outcome::Ended;
        }
        if ready == 0 {
            filter.flush(&mut to_host);
            continue;
        }
        if fds[4].revents & libc::POLLIN != 0 {
            let mut sigs = [0u8; 64];
            // SAFETY: reads into a local buffer from our own non-blocking pipe.
            let n = unsafe { libc::read(signals, sigs.as_mut_ptr() as *mut libc::c_void, 64) };
            for &sig in sigs.iter().take(n.max(0) as usize) {
                let sig = sig as i32;
                if sig == libc::SIGWINCH {
                    push_size(client, id);
                } else if sig == libc::SIGTSTP {
                    // Give the terminal back, stop for real, and take it again
                    // when continued. (SIGSTOP cannot be caught.)
                    drop(terminal.take());
                    // SAFETY: default disposition, then stop ourselves.
                    unsafe {
                        libc::signal(libc::SIGTSTP, libc::SIG_DFL);
                        libc::raise(libc::SIGTSTP);
                    }
                    install_handler(libc::SIGTSTP, on_signal);
                    terminal = Some(Terminal::enter());
                    nudge_redraw(client, id);
                } else {
                    break 'main Outcome::Signal(sig);
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
                if !is_would_block(&io::Error::last_os_error()) {
                    break Outcome::Detached;
                }
            } else if filter.feed(&buf[..n as usize], &mut to_host) {
                break Outcome::Detached;
            }
        }
        if fds[1].revents & readable != 0 {
            match stream.read(&mut buf) {
                Ok(0) => break Outcome::Ended,
                Ok(n) => to_out.extend_from_slice(&buf[..n]),
                Err(e) if is_would_block(&e) => {}
                Err(_) => break Outcome::Ended,
            }
        }
        if fds[2].revents & writable != 0 {
            match stream.write(&to_host) {
                Ok(n) => {
                    to_host.drain(..n);
                }
                Err(e) if is_would_block(&e) => {}
                Err(_) => break Outcome::Ended,
            }
        }
        if fds[3].revents & writable != 0 {
            // SAFETY: the pointer and length come from a live Vec.
            let n = unsafe { libc::write(1, to_out.as_ptr() as *const libc::c_void, to_out.len()) };
            if n > 0 {
                to_out.drain(..n as usize);
            } else if n < 0 && !is_would_block(&io::Error::last_os_error()) {
                break Outcome::Detached;
            }
        }
    };
    // Terminal back to normal first; then the backstop is no longer needed.
    drop(terminal);
    uninstall_signals();
    // Input not yet delivered is dropped on purpose: a detach must not wait for
    // a stalled session.
    let _ = stream.set_nonblocking(false);
    close_cleanly(stream);
    match outcome {
        Outcome::Detached => {
            say(format_args!("[detached from session {id}]"));
            Ok(0)
        }
        Outcome::Signal(sig) => {
            say(format_args!("[detached from session {id}: signal {sig}]"));
            Ok(128 + sig)
        }
        Outcome::Ended => ended(client, id),
    }
}

/// The host closed the connection: the session ended, or another client took
/// it over (`attach --force`), which leaves it running.
fn ended(client: &HostClient, id: u32) -> Res<i32> {
    // The reaper records the status a moment after the output ends.
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut running = false;
    loop {
        match client.list() {
            Ok(sessions) => match sessions.into_iter().find(|s| s.id == id) {
                Some(s) => {
                    if let Some(code) = s.exited {
                        say(format_args!("[session {id} ended, exit code {code}]"));
                        return Ok(code.rem_euclid(256));
                    }
                    running = true;
                }
                None => {
                    running = false;
                    break;
                }
            },
            Err(_) => break,
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    if running {
        say(format_args!(
            "[session {id} was taken over by another client]"
        ));
        return Ok(EXIT_BUSY);
    }
    say(format_args!("[connection to session {id} closed]"));
    Ok(EXIT_ERROR)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(f: &mut EscapeFilter, input: &[u8]) -> (Vec<u8>, bool) {
        let mut out = Vec::new();
        let detach = f.feed(input, &mut out);
        (out, detach)
    }

    #[test]
    fn plain_input_passes_through() {
        let mut f = EscapeFilter::default();
        assert_eq!(feed(&mut f, b"ab\x1b[Ac"), (b"ab\x1b[Ac".to_vec(), false));
        assert!(!f.holding());
    }

    #[test]
    fn ctrl_bracket_then_d_detaches() {
        let mut f = EscapeFilter::default();
        assert_eq!(feed(&mut f, b"x\x1d"), (b"x".to_vec(), false));
        assert_eq!(feed(&mut f, b"d"), (vec![], true));
    }

    #[test]
    fn kitty_escape_split_across_reads_detaches() {
        let mut f = EscapeFilter::default();
        assert_eq!(feed(&mut f, b"\x1b[93;"), (vec![], false));
        assert!(f.holding());
        assert_eq!(feed(&mut f, b"5u"), (vec![], false));
        assert_eq!(feed(&mut f, b"d"), (vec![], true));
        let mut f = EscapeFilter::default();
        assert_eq!(
            feed(&mut f, b"\x1b[93;5:1u\x1b[93;5:3u\x1b[100;1u"),
            (vec![], true)
        );
    }

    #[test]
    fn double_escape_sends_one() {
        let mut f = EscapeFilter::default();
        assert_eq!(feed(&mut f, b"\x1d\x1dz"), (b"\x1dz".to_vec(), false));
        let mut f = EscapeFilter::default();
        assert_eq!(
            feed(&mut f, b"\x1b[93;5u\x1b[93;5u"),
            (b"\x1b[93;5u".to_vec(), false)
        );
    }

    #[test]
    fn escape_then_other_key_sends_both() {
        let mut f = EscapeFilter::default();
        assert_eq!(feed(&mut f, b"\x1dq"), (b"\x1dq".to_vec(), false));
    }

    #[test]
    fn lone_esc_is_sent_after_the_hold() {
        let mut f = EscapeFilter::default();
        assert_eq!(feed(&mut f, b"\x1b"), (vec![], false));
        assert!(f.holding());
        let mut out = Vec::new();
        f.flush(&mut out);
        assert_eq!(out, b"\x1b");
        assert!(!f.holding());
    }

    #[test]
    fn near_miss_sequence_passes_intact() {
        let mut f = EscapeFilter::default();
        assert_eq!(feed(&mut f, b"\x1b[93;6u"), (b"\x1b[93;6u".to_vec(), false));
    }

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
