//! Drives `canopy-term` as a subprocess against the real `canopy-pty-host`.
//! The host binary comes from `CANOPY_PTY_HOST_EXE` (CI builds it first), else
//! this file builds it once with cargo into its own target directory.
#![cfg(unix)]

use canopy_pty_host::client::HostClient;
use serde_json::Value;
use std::os::unix::io::{FromRawFd, OwnedFd, RawFd};
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

fn host_exe() -> &'static PathBuf {
    static EXE: OnceLock<PathBuf> = OnceLock::new();
    EXE.get_or_init(|| {
        if let Ok(path) = std::env::var("CANOPY_PTY_HOST_EXE") {
            return PathBuf::from(path);
        }
        let manifest = concat!(env!("CARGO_MANIFEST_DIR"), "/../canopy-pty-host/Cargo.toml");
        let target = concat!(env!("CARGO_MANIFEST_DIR"), "/target/host-build");
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let out = Command::new(cargo)
            .args([
                "build",
                "--locked",
                "--message-format=json",
                "--bin",
                "canopy-pty-host",
            ])
            .args(["--manifest-path", manifest, "--target-dir", target])
            .stderr(Stdio::inherit())
            .output()
            .expect("cargo runs");
        assert!(out.status.success(), "building canopy-pty-host failed");
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|v| {
                v["reason"] == "compiler-artifact" && v["target"]["name"] == "canopy-pty-host"
            })
            .find_map(|v| v["executable"].as_str().map(PathBuf::from))
            .expect("host executable path in cargo output")
    })
}

struct Host {
    dir: PathBuf,
    sock: PathBuf,
    client: HostClient,
}

impl Host {
    fn start(name: &str) -> Host {
        // Short on purpose: macOS caps unix socket paths at about 104 bytes.
        let dir = std::env::temp_dir().join(format!("ct{}{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        let sock = dir.join("h.sock");
        let client = HostClient::ensure_running(host_exe(), &sock, 60).expect("host starts");
        Host { dir, sock, client }
    }

    fn term(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_canopy-term"));
        c.arg("--socket").arg(&self.sock).args(args);
        c.env_remove("CANOPY_PTY_HOST_SOCKET")
            .env_remove("CANOPY_PTY_HOST_DIR")
            .env("CANOPY_PTY_HOST_EXE", host_exe());
        c
    }

    fn run(&self, args: &[&str]) -> Output {
        self.term(args).output().expect("canopy-term runs")
    }

    fn new_session(&self, key: Option<&str>, cmd: &[&str]) -> String {
        let mut args = vec!["new"];
        if let Some(k) = key {
            args.extend(["--key", k]);
        }
        args.push("--");
        args.extend(cmd);
        let out = self.run(&args);
        assert!(out.status.success(), "new failed: {}", lossy(&out.stderr));
        lossy(&out.stdout).trim().to_string()
    }

    fn ls(&self) -> Vec<Value> {
        let out = self.run(&["ls", "--json"]);
        assert_eq!(out.status.code(), Some(0));
        serde_json::from_slice::<Value>(&out.stdout)
            .expect("ls --json is JSON")
            .as_array()
            .expect("an array")
            .clone()
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.client.shutdown();
        std::thread::sleep(Duration::from_millis(200));
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn lossy(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

fn wait_until(timeout: Duration, mut f: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    f()
}

#[test]
fn ls_json_shape_and_host_not_running() {
    let h = Host::start("a");
    assert!(h.ls().is_empty());
    let id = h.new_session(Some("k1"), &["sleep", "30"]);
    let rows = h.ls();
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row["id"].to_string(), id);
    assert!(row["pid"].is_u64());
    assert!(row["size"]["cols"].is_u64() && row["size"]["rows"].is_u64());
    assert!(row["exited"].is_null());
    assert_eq!(row["key"], "k1");
    assert!(row["meta"].is_null());
    let plain = h.run(&["ls"]);
    assert_eq!(plain.status.code(), Some(0));
    assert!(lossy(&plain.stdout).contains("k1"));

    let out = Command::new(env!("CARGO_BIN_EXE_canopy-term"))
        .args([
            "--socket",
            "/nonexistent-canopy-term-test/h.sock",
            "ls",
            "--json",
        ])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(4));
}

#[test]
fn new_with_a_key_is_idempotent() {
    let h = Host::start("b");
    let first = h.new_session(Some("same"), &["sleep", "30"]);
    let second = h.new_session(Some("same"), &["sleep", "30"]);
    assert_eq!(first, second);
    assert_eq!(h.ls().len(), 1);
}

#[test]
fn send_then_capture_roundtrip() {
    let h = Host::start("c");
    let id = h.new_session(None, &["cat"]);
    let out = h.run(&["send", &id, "hello-roundtrip", "--enter"]);
    assert_eq!(out.status.code(), Some(0), "{}", lossy(&out.stderr));
    let mut seen = String::new();
    assert!(
        wait_until(Duration::from_secs(5), || {
            let c = h.run(&["capture", &id, "--lines", "5"]);
            assert_eq!(c.status.code(), Some(0), "{}", lossy(&c.stderr));
            seen = lossy(&c.stdout);
            seen.contains("hello-roundtrip")
        }),
        "capture never showed the text: {seen:?}"
    );
}

#[test]
fn wait_returns_the_childs_exit_code() {
    let h = Host::start("d");
    let id = h.new_session(None, &["sh", "-c", "exit 7"]);
    let out = h.run(&["wait", &id]);
    assert_eq!(out.status.code(), Some(7));
}

#[test]
fn kill_codes() {
    let h = Host::start("e");
    assert_eq!(h.run(&["kill", "999"]).status.code(), Some(3));
    assert_eq!(h.run(&["kill", "notanumber"]).status.code(), Some(2));
    let id = h.new_session(None, &["sleep", "30"]);
    assert_eq!(h.run(&["kill", &id]).status.code(), Some(0));
    assert!(wait_until(Duration::from_secs(10), || {
        h.ls()[0]["exited"].is_number()
    }));
}

// ------------------------------------------------------------ attach on a pty

struct Pty {
    master: RawFd,
    slave: RawFd,
}

impl Pty {
    fn open(cols: u16, rows: u16) -> Pty {
        let (mut m, mut s) = (0, 0);
        let mut ws = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: openpty fills two descriptors.
        let rc = unsafe {
            libc::openpty(
                &mut m,
                &mut s,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut ws,
            )
        };
        assert_eq!(rc, 0, "openpty failed");
        Pty {
            master: m,
            slave: s,
        }
    }

    fn stdio(&self) -> Stdio {
        // SAFETY: a fresh dup, owned by the Stdio.
        Stdio::from(unsafe { OwnedFd::from_raw_fd(libc::dup(self.slave)) })
    }

    /// The local terminal's attributes, read through our own slave descriptor.
    fn lflag(&self) -> libc::tcflag_t {
        // SAFETY: termios is plain data.
        let mut t: libc::termios = unsafe { std::mem::zeroed() };
        assert_eq!(unsafe { libc::tcgetattr(self.slave, &mut t) }, 0);
        t.c_lflag
    }

    fn raw_now(&self) -> bool {
        self.lflag() & libc::ICANON == 0
    }

    fn write(&self, data: &[u8]) {
        // SAFETY: slice pointer and length.
        let n = unsafe { libc::write(self.master, data.as_ptr() as *const _, data.len()) };
        assert_eq!(n as usize, data.len());
    }

    fn read_until(&self, needle: &str, timeout: Duration) -> String {
        let deadline = Instant::now() + timeout;
        let mut out = Vec::new();
        while Instant::now() < deadline && !lossy(&out).contains(needle) {
            let mut p = libc::pollfd {
                fd: self.master,
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: one valid pollfd, then a read into a local buffer.
            unsafe {
                if libc::poll(&mut p, 1, 100) > 0 {
                    let mut buf = [0u8; 4096];
                    let n = libc::read(self.master, buf.as_mut_ptr() as *mut _, buf.len());
                    if n > 0 {
                        out.extend_from_slice(&buf[..n as usize]);
                    }
                }
            }
        }
        lossy(&out)
    }

    fn set_size(&self, cols: u16, rows: u16) {
        let ws = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: TIOCSWINSZ reads a winsize.
        assert_eq!(
            unsafe { libc::ioctl(self.master, libc::TIOCSWINSZ as _, &ws) },
            0
        );
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        // SAFETY: closing descriptors we opened.
        unsafe {
            libc::close(self.master);
            libc::close(self.slave);
        }
    }
}

struct Kill(Child);

impl Drop for Kill {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn start_attach(h: &Host, pty: &Pty, id: &str) -> Kill {
    let child = h
        .term(&["attach", id])
        .stdin(pty.stdio())
        .stdout(pty.stdio())
        .stderr(pty.stdio())
        .spawn()
        .expect("attach starts");
    let child = Kill(child);
    assert!(
        wait_until(Duration::from_secs(5), || pty.raw_now()),
        "attach never put the tty in raw mode"
    );
    child
}

fn wait_exit(child: &mut Kill, timeout: Duration) -> Option<std::process::ExitStatus> {
    let mut status = None;
    wait_until(timeout, || {
        status = child.0.try_wait().unwrap();
        status.is_some()
    });
    status
}

#[test]
fn attach_passes_bytes_detaches_and_restores_the_tty() {
    let h = Host::start("f");
    let id = h.new_session(None, &["cat"]);
    let pty = Pty::open(90, 31);
    let before = pty.lflag();
    assert!(before & libc::ICANON != 0);

    let mut child = start_attach(&h, &pty, &id);
    assert!(pty.lflag() & libc::ECHO == 0, "echo still on in raw mode");
    // The client's size reaches the host on attach.
    assert!(wait_until(Duration::from_secs(5), || {
        let s = &h.ls()[0]["size"];
        s["cols"] == 90 && s["rows"] == 31
    }));

    // Raw passthrough: newline and the bytes come back through the session.
    pty.write(b"hello-raw\n");
    let seen = pty.read_until("hello-raw", Duration::from_secs(5));
    assert!(
        seen.contains("hello-raw"),
        "no echo through the session: {seen:?}"
    );

    // Someone else cannot take it over without --force.
    assert_eq!(h.run(&["capture", &id]).status.code(), Some(5));

    // Detach key, split across two writes.
    pty.write(&[0x1d]);
    std::thread::sleep(Duration::from_millis(100));
    pty.write(b"d");
    let status = wait_exit(&mut child, Duration::from_secs(5)).expect("attach exited");
    assert_eq!(status.code(), Some(0));
    assert_eq!(pty.lflag(), before, "tty not restored after detach");
    // The session lives on.
    assert!(wait_until(Duration::from_secs(5), || {
        let rows = h.ls();
        rows.len() == 1 && rows[0]["exited"].is_null() && rows[0]["attached"] == false
    }));
}

#[test]
fn attach_restores_the_tty_on_sigterm_and_sigint() {
    let h = Host::start("g");
    let id = h.new_session(None, &["cat"]);
    for (sig, code) in [(libc::SIGTERM, 143), (libc::SIGINT, 130)] {
        let pty = Pty::open(80, 24);
        let before = pty.lflag();
        let mut child = start_attach(&h, &pty, &id);
        // SAFETY: signalling our own child.
        unsafe { libc::kill(child.0.id() as libc::pid_t, sig) };
        let status = wait_exit(&mut child, Duration::from_secs(5)).expect("attach exited");
        assert_eq!(status.code(), Some(code));
        assert_eq!(pty.lflag(), before, "tty not restored after signal {sig}");
        // Wait for the host to notice the detach before the next round.
        assert!(wait_until(Duration::from_secs(5), || h.ls()[0]["attached"] == false));
    }
}

#[test]
fn attach_forwards_window_resizes() {
    let h = Host::start("h");
    let id = h.new_session(None, &["cat"]);
    let pty = Pty::open(80, 24);
    let mut child = start_attach(&h, &pty, &id);
    pty.set_size(100, 30);
    // The child has no controlling tty, so deliver the signal the kernel would.
    // SAFETY: signalling our own child.
    unsafe { libc::kill(child.0.id() as libc::pid_t, libc::SIGWINCH) };
    assert!(wait_until(Duration::from_secs(5), || {
        let s = &h.ls()[0]["size"];
        s["cols"] == 100 && s["rows"] == 30
    }));
    pty.write(&[0x1d]);
    pty.write(b"d");
    assert_eq!(
        wait_exit(&mut child, Duration::from_secs(5)).and_then(|s| s.code()),
        Some(0)
    );
}
