//! Runs the real detached `canopy-pty-host` binary. Each test gets its own socket
//! directory (a pipe name on Windows) and shuts its host down on drop.
//!
//! Scripts run under `sh -c` on Unix and PowerShell on Windows; `pick` chooses
//! per platform where the two differ. ConPTY re-renders output, so Windows
//! checks look for text rather than exact bytes, and gets longer timeouts
//! (PowerShell starts slowly on CI).
#![cfg(any(unix, windows))]

use canopy_pty_host::client::{Attached, HostClient};
use canopy_pty_host::protocol::SpawnSpec;
use canopy_pty_host::server::{HIGH_WATER, RING_CAP};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn host_exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_canopy-pty-host"))
}

/// The Unix text or the Windows text.
fn pick<'a>(unix: &'a str, windows: &'a str) -> &'a str {
    if cfg!(windows) {
        windows
    } else {
        unix
    }
}

/// `secs` seconds, stretched on Windows.
fn t(secs: u64) -> Duration {
    Duration::from_secs(if cfg!(windows) { secs * 4 } else { secs })
}

/// A directory to clean up and the endpoint to serve on: a socket inside the
/// directory on Unix, a pipe name on Windows.
fn endpoint(name: &str) -> (PathBuf, PathBuf) {
    // Short on purpose: macOS caps unix socket paths at about 104 bytes.
    let dir = std::env::temp_dir().join(format!("cph{}{}", std::process::id(), name));
    let _ = std::fs::remove_dir_all(&dir);
    #[cfg(unix)]
    let socket = dir.join("h.sock");
    #[cfg(windows)]
    let socket = PathBuf::from(format!(r"\\.\pipe\cph-{}-{}", std::process::id(), name));
    (dir, socket)
}

#[cfg(unix)]
fn raw_connect(socket: &Path) -> std::io::Result<std::os::unix::net::UnixStream> {
    std::os::unix::net::UnixStream::connect(socket)
}

#[cfg(windows)]
fn raw_connect(socket: &Path) -> std::io::Result<canopy_pty_host::windows::PipeStream> {
    canopy_pty_host::windows::PipeStream::connect(socket)
}

/// Sends one raw request line and returns the reply line.
fn raw_request(socket: &Path, line: &[u8]) -> String {
    let mut stream = raw_connect(socket).unwrap();
    stream.write_all(line).unwrap();
    let mut reply = String::new();
    let mut byte = [0u8; 1];
    while stream.read(&mut byte).unwrap() == 1 && byte[0] != b'\n' {
        reply.push(byte[0] as char);
    }
    reply
}

struct Harness {
    dir: PathBuf,
    client: HostClient,
}

impl Harness {
    fn start(name: &str, idle_secs: u64) -> Harness {
        let (dir, socket) = endpoint(name);
        let client =
            HostClient::ensure_running(&host_exe(), &socket, idle_secs).expect("host starts");
        Harness { dir, client }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = self.client.shutdown();
        std::thread::sleep(Duration::from_millis(200));
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(unix)]
fn spec(script: &str) -> SpawnSpec {
    SpawnSpec {
        argv: vec!["sh".into(), "-c".into(), script.into()],
        cwd: None,
        env: vec![
            ("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into()),
            ("TERM".into(), "xterm".into()),
        ],
        cols: 80,
        rows: 24,
        meta: Some("test-meta".into()),
        ..Default::default()
    }
}

/// PowerShell, with the test's own environment (SystemRoot, PATH, PATHEXT,
/// TEMP...): the host passes exactly what it is given.
#[cfg(windows)]
fn spec(script: &str) -> SpawnSpec {
    SpawnSpec {
        argv: vec![
            "powershell.exe".into(),
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-Command".into(),
            script.into(),
        ],
        cwd: None,
        env: std::env::vars().collect(),
        cols: 80,
        rows: 24,
        meta: Some("test-meta".into()),
        ..Default::default()
    }
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only probes for existence.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// Exited processes stay openable while anyone (the host) holds a handle, so
/// ask whether the process object is signalled rather than whether it opens.
#[cfg(windows)]
fn alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };
    // SAFETY: open, zero-timeout wait and close on a pid we were given.
    unsafe {
        let h = OpenProcess(
            PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        );
        if h.is_null() {
            return false;
        }
        let running = WaitForSingleObject(h, 0) == WAIT_TIMEOUT;
        CloseHandle(h);
        running
    }
}

/// The Unix SIGTERM tests' counterpart: Windows can only kill the host outright.
#[cfg(unix)]
fn stop_host(pid: u32) {
    // SAFETY: terminating the host process this test started.
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
}

#[cfg(windows)]
fn stop_host(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    // SAFETY: terminating the host process this test started.
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !h.is_null() {
            TerminateProcess(h, 1);
            CloseHandle(h);
        }
    }
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

/// Reads from an attach connection until `done` accepts the bytes so far.
fn read_until(attached: &mut Attached, timeout: Duration, done: impl Fn(&[u8]) -> bool) -> Vec<u8> {
    let deadline = Instant::now() + timeout;
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    attached
        .stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    while Instant::now() < deadline && !done(&out) {
        match attached.stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => out.extend_from_slice(&buf[..n]),
            Err(_) => {}
        }
    }
    out
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    String::from_utf8_lossy(haystack).contains(needle)
}

/// The number printed right after `label`, once it is complete.
fn number_after(bytes: &[u8], label: &str) -> Option<u32> {
    let text = String::from_utf8_lossy(bytes).into_owned();
    let rest = &text[text.find(label)? + label.len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    (!digits.is_empty() && rest.len() > digits.len())
        .then(|| digits.parse().ok())
        .flatten()
}

/// Every `tickN` number in order of appearance.
fn ticks(bytes: &[u8]) -> Vec<u64> {
    let text = String::from_utf8_lossy(bytes).into_owned();
    let mut out = Vec::new();
    for part in text.split("tick").skip(1) {
        let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
        // A number cut off by the end of the buffer is incomplete; skip it.
        if !digits.is_empty() && part.len() > digits.len() {
            out.push(digits.parse().unwrap());
        }
    }
    out
}

const TICKER: &str = "i=0; while [ $i -lt 100000 ]; do i=$((i+1)); echo tick$i; sleep 0.02; done";
const TICKER_PS: &str =
    "for ($i = 1; $i -le 100000; $i++) { \"tick$i\"; Start-Sleep -Milliseconds 20 }";
/// Echoes each input line back in upper case (`cat` on Unix).
const ECHO_PS: &str = "while ($true) { $l = [Console]::ReadLine(); if ($null -eq $l) { break }; 'got-' + $l.ToUpper() }";

#[test]
fn child_survives_client_death_and_reattach_is_contiguous() {
    let h = Harness::start("a", 60);
    let (id, pid) = h.client.spawn(spec(pick(TICKER, TICKER_PS))).unwrap();

    let mut first = h.client.attach(id, 0).unwrap();
    // "tick6" means "tick5" is complete; ConPTY may put escapes before "\r".
    let before = read_until(&mut first, t(5), |b| contains(b, pick("tick5\r", "tick6")));
    assert!(
        contains(&before, "tick5"),
        "no output before the client died"
    );
    let offset = first.start + before.len() as u64;
    drop(first); // the app "dies": the connection just goes away

    std::thread::sleep(Duration::from_millis(500));
    assert!(alive(pid), "child died with its client");
    let listed = h.client.list().unwrap();
    assert_eq!(listed[0].pid, Some(pid), "pid changed");
    assert_eq!(listed[0].meta.as_deref(), Some("test-meta"));

    let mut second = h.client.attach(id, offset).unwrap();
    assert_eq!(
        second.start, offset,
        "reattach did not resume at the offset"
    );
    assert!(!second.gap);
    let after = read_until(&mut second, t(5), |b| {
        contains(b, pick("tick15\r", "tick16"))
    });
    let mut all = before;
    all.extend_from_slice(&after);
    let numbers = ticks(&all);
    assert!(numbers.len() >= 10, "too little output: {numbers:?}");
    assert!(
        numbers.windows(2).all(|w| w[1] == w[0] + 1),
        "lost or repeated output across reattach: {numbers:?}"
    );
}

#[test]
fn input_from_a_second_client_reaches_the_child() {
    let h = Harness::start("b", 60);
    let (id, _) = h.client.spawn(spec(pick("cat", ECHO_PS))).unwrap();
    let mut a = h.client.attach(id, 0).unwrap();
    a.stream
        .write_all(pick("hello-from-client\n", "hello-from-client\r").as_bytes())
        .unwrap();
    // On Windows the child's own answer, not conhost's echo of the typing.
    let expect = pick("hello-from-client", "got-HELLO-FROM-CLIENT");
    let out = read_until(&mut a, t(5), |b| contains(b, expect));
    assert!(
        contains(&out, expect),
        "{:?}",
        String::from_utf8_lossy(&out)
    );
}

#[test]
fn stalled_client_blocks_the_child_instead_of_growing_memory() {
    let h = Harness::start("c", 60);
    let (id, _) = h
        .client
        .spawn(spec(pick(
            "yes",
            "while ($true) { [Console]::Out.Write('y' * 4000) }",
        )))
        .unwrap();
    let _stalled = h.client.attach(id, 0).unwrap(); // attached, never reads
                                                    // Before the attach the host drains the child into its ring, and on a fast
                                                    // pty that can already be megabytes, so the bound below is on what the
                                                    // stalled client adds, measured from here.
    let at_attach = h.client.list().unwrap()[0].end;

    std::thread::sleep(Duration::from_millis(1500));
    if cfg!(windows) {
        // PowerShell may still be starting.
        assert!(wait_until(t(5), || h.client.list().unwrap()[0].end > 0));
        std::thread::sleep(Duration::from_millis(1500));
    }
    let first = h.client.list().unwrap()[0].end;
    std::thread::sleep(Duration::from_millis(1000));
    let second = h.client.list().unwrap()[0].end;

    assert!(first > 0, "child produced nothing");
    assert!(
        second - first < 256 * 1024,
        "output kept growing for a stalled client: {first} -> {second}"
    );
    assert!(
        ((first - at_attach) as usize) < HIGH_WATER + 1024 * 1024,
        "host buffered {} bytes for a stalled client",
        first - at_attach
    );
}

#[test]
fn attaching_to_a_full_ring_while_the_child_floods_keeps_the_session_usable() {
    // Regression: output read just as a client attached to a full ring trimmed
    // bytes the client had not been sent, and the sender then panicked holding
    // the ring lock; every later request for the session lost its connection.
    let h = Harness::start("fr", 60);
    let flood = pick(
        "yes",
        "$pad = 'x' * 100; $i = 0; while ($true) { [Console]::Out.WriteLine(\"$i $pad\"); $i++ }",
    );
    let (id, _) = h.client.spawn(spec(flood)).unwrap();
    assert!(
        wait_until(t(10), || { h.client.list().unwrap()[0].start > 0 }),
        "ring never filled"
    );
    for _ in 0..40 {
        let attached = h.client.attach(id, 0).unwrap();
        let listed = h.client.list().unwrap();
        assert_eq!(listed.len(), 1);
        drop(attached);
    }
    let mut last = h.client.attach(id, 0).unwrap();
    let out = read_until(&mut last, t(5), |b| b.len() > 64 * 1024);
    assert!(out.len() > 64 * 1024, "no output after the attaches");
}

#[cfg(unix)]
#[test]
fn unattached_output_drains_into_a_bounded_ring_and_reports_a_gap() {
    let h = Harness::start("d", 60);
    let (id, _) = h
        .client
        .spawn(spec("head -c 6000000 /dev/zero | tr '\\0' x"))
        .unwrap();
    assert!(wait_until(Duration::from_secs(20), || {
        h.client.list().unwrap()[0].exited.is_some()
    }));
    let info = h.client.list().unwrap().remove(0);
    assert_eq!(info.end, 6_000_000);
    assert_eq!(
        (info.end - info.start) as usize,
        RING_CAP,
        "ring not bounded"
    );
    let attached = h.client.attach(id, 0).unwrap();
    assert!(attached.gap, "a trimmed offset must be reported as a gap");
    assert_eq!(attached.start, info.start);
}

/// ConPTY re-renders the child's output, so the byte count is not the child's;
/// the ring bound and the gap flag must still hold once it has passed the cap.
#[cfg(windows)]
#[test]
fn unattached_output_drains_into_a_bounded_ring_and_reports_a_gap() {
    let h = Harness::start("d", 60);
    // About 8 MB of distinct lines (distinct, so nothing can be elided).
    let (id, _) = h
        .client
        .spawn(spec(
            "$pad = 'x' * 100; for ($i = 0; $i -lt 80000; $i++) { [Console]::Out.WriteLine(\"$i $pad\") }",
        ))
        .unwrap();
    assert!(
        wait_until(Duration::from_secs(120), || {
            h.client.list().unwrap()[0].exited.is_some()
        }),
        "the flood never finished"
    );
    // The reader may still be draining what conhost flushed at close.
    std::thread::sleep(Duration::from_millis(1000));
    let info = h.client.list().unwrap().remove(0);
    assert!(
        info.end > RING_CAP as u64,
        "only {} bytes came through ConPTY",
        info.end
    );
    assert_eq!(
        (info.end - info.start) as usize,
        RING_CAP,
        "ring not bounded"
    );
    let attached = h.client.attach(id, 0).unwrap();
    assert!(attached.gap, "a trimmed offset must be reported as a gap");
    assert_eq!(attached.start, info.start);
}

#[test]
fn resize_from_a_non_parent_client_reaches_the_child() {
    let h = Harness::start("e", 60);
    let script = pick(
        "trap 'echo size $(stty size)' WINCH; echo ready; while :; do sleep 0.05; done",
        // No SIGWINCH on Windows: poll the console size and report changes.
        "'ready'; $l = ''; while ($true) { $s = \"$([Console]::WindowHeight) $([Console]::WindowWidth)\"; if ($s -ne $l) { \"size $s\"; $l = $s }; Start-Sleep -Milliseconds 50 }",
    );
    let (id, _) = h.client.spawn(spec(script)).unwrap();
    let mut a = h.client.attach(id, 0).unwrap();
    let _ = read_until(&mut a, t(5), |b| contains(b, "ready"));
    h.client.resize(id, 100, 30).unwrap();
    let out = read_until(&mut a, t(5), |b| contains(b, "size 30 100"));
    assert!(
        contains(&out, "size 30 100"),
        "got {:?}",
        String::from_utf8_lossy(&out)
    );
    assert_eq!(h.client.list().unwrap()[0].cols, 100);
}

#[cfg(unix)]
#[test]
fn kill_stops_the_whole_process_group_and_reports_exit() {
    let h = Harness::start("f", 60);
    let (id, pid) = h
        .client
        .spawn(spec("sleep 300 & sleep 300 & wait"))
        .unwrap();
    assert!(alive(pid));
    h.client.kill(id).unwrap();
    assert!(wait_until(Duration::from_secs(10), || {
        h.client.list().unwrap()[0].exited.is_some()
    }));
    assert!(wait_until(Duration::from_secs(5), || !alive(pid)));
    h.client.reap(id).unwrap();
    assert!(h.client.list().unwrap().is_empty());
}

/// Spawns a shell with two grandchildren: one on the session's console and one
/// on a console of its own, which closing the pseudoconsole does not reach, so
/// only the Job Object can stop it. Returns (id, pid, on-console, off-console).
#[cfg(windows)]
fn spawn_with_grandchildren(h: &Harness) -> (u32, u32, u32, u32) {
    let (id, pid) = h
        .client
        .spawn(spec(
            "$a = Start-Process -PassThru -NoNewWindow -FilePath ping.exe -ArgumentList '-n','300','127.0.0.1'; \
             $b = Start-Process -PassThru -WindowStyle Hidden -FilePath ping.exe -ArgumentList '-n','300','127.0.0.1'; \
             \"oncon=$($a.Id); offcon=$($b.Id);\"; Start-Sleep 300",
        ))
        .unwrap();
    let mut found = None;
    assert!(
        wait_until(t(10), || {
            let (_, bytes) = h.client.read_ring(id, 0, None).unwrap();
            found = number_after(&bytes, "oncon=").zip(number_after(&bytes, "offcon="));
            found.is_some()
        }),
        "the script never reported its grandchildren"
    );
    let (on, off) = found.unwrap();
    assert!(alive(pid));
    assert!(alive(on), "on-console grandchild {on} not running");
    assert!(alive(off), "off-console grandchild {off} not running");
    (id, pid, on, off)
}

/// The job takes the whole tree, including a grandchild on another console
/// that outlives the pseudoconsole: kill must end in `TerminateJobObject` even
/// though closing the console already ended the shell.
#[cfg(windows)]
#[test]
fn kill_stops_the_whole_process_group_and_reports_exit() {
    let h = Harness::start("f", 60);
    let (id, pid, on, off) = spawn_with_grandchildren(&h);
    h.client.kill(id).unwrap();
    assert!(wait_until(t(10), || {
        h.client.list().unwrap()[0].exited.is_some()
    }));
    assert!(wait_until(t(5), || !alive(pid)));
    assert!(
        wait_until(t(5), || !alive(on)),
        "the on-console grandchild escaped the kill"
    );
    assert!(
        wait_until(t(5), || !alive(off)),
        "the off-console grandchild escaped the kill (job not terminated)"
    );
    h.client.reap(id).unwrap();
    assert!(h.client.list().unwrap().is_empty());
}

/// A host killed outright closes its job handles; `KILL_ON_JOB_CLOSE` then
/// takes even the descendant that console teardown cannot reach.
#[cfg(windows)]
#[test]
fn a_terminated_host_takes_off_console_descendants_with_it() {
    let h = Harness::start("hk", 60);
    let (_, pid, on, off) = spawn_with_grandchildren(&h);
    let host_pid = h.client.hello().unwrap().host_pid.unwrap();
    stop_host(host_pid);
    assert!(
        wait_until(t(10), || !alive(pid) && !alive(on) && !alive(off)),
        "descendants outlived a terminated host: shell {}, on-console {}, off-console {}",
        alive(pid),
        alive(on),
        alive(off)
    );
}

#[test]
fn exit_status_is_reported() {
    let h = Harness::start("g", 60);
    let (_, _) = h.client.spawn(spec("exit 7")).unwrap();
    assert!(wait_until(t(5), || {
        h.client.list().unwrap()[0].exited == Some(7)
    }));
}

#[test]
fn sigterm_to_the_host_leaves_no_orphans() {
    // On Windows the host is killed outright (no signal to catch); the sessions'
    // kill-on-close jobs still take the children with it.
    let h = Harness::start("h", 60);
    let (_, a) = h.client.spawn(spec("sleep 300")).unwrap();
    let (_, b) = h.client.spawn(spec("sleep 300")).unwrap();
    let host_pid = h.client.hello().unwrap().host_pid.unwrap();
    stop_host(host_pid);
    assert!(
        wait_until(t(10), || !alive(a) && !alive(b)),
        "children outlived a terminated host"
    );
    assert!(wait_until(t(5), || h.client.hello().is_err()));
}

#[test]
fn simultaneous_starts_create_one_host() {
    let (dir, socket) = endpoint("race");
    let handles: Vec<_> = (0..4)
        .map(|_| {
            let socket = socket.clone();
            std::thread::spawn(move || {
                let client = HostClient::ensure_running(&host_exe(), &socket, 60).unwrap();
                client.hello().unwrap().host_pid.unwrap()
            })
        })
        .collect();
    let pids: Vec<u32> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert!(
        pids.windows(2).all(|w| w[0] == w[1]),
        "several hosts: {pids:?}"
    );
    let _ = HostClient::new(&socket).shutdown();
    std::thread::sleep(Duration::from_millis(200));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn unknown_request_fields_are_tolerated() {
    let h = Harness::start("i", 60);
    let reply = raw_request(h.client.socket(), b"{\"op\":\"hello\",\"future\":true}\n");
    assert!(reply.contains("\"ok\":true"), "{reply}");
}

#[test]
fn hello_reports_the_protocol_version_and_the_minimum_client() {
    use canopy_pty_host::protocol::{MIN_CLIENT_VERSION, PROTOCOL_VERSION};
    let h = Harness::start("v", 60);
    let hello = h.client.hello().unwrap();
    assert_eq!(hello.version, Some(PROTOCOL_VERSION));
    assert_eq!(hello.min_client, Some(MIN_CLIENT_VERSION));
}

/// Kills a host started by hand even when the test fails, so it cannot outlive
/// the run holding inherited handles.
struct KillOnDrop(std::process::Child);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn a_client_older_than_the_host_accepts_is_refused_at_hello_and_attach() {
    // A host whose minimum is above this client's version. It is started by hand:
    // `ensure_running` would (rightly, today) treat a refusing host as no host.
    let (dir, socket) = endpoint("skew");
    std::fs::create_dir_all(&dir).unwrap();
    let _host = KillOnDrop(
        std::process::Command::new(host_exe())
            .arg("--socket")
            .arg(&socket)
            // One above whatever this client speaks, so a protocol bump never turns
            // this into a host that accepts it.
            .args([
                "--min-client",
                &(canopy_pty_host::protocol::PROTOCOL_VERSION + 1).to_string(),
                "--idle-secs",
                "60",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    // Probe by connecting: a pipe has no file to look for.
    assert!(wait_until(t(5), || raw_connect(&socket).is_ok()));
    let client = HostClient::new(&socket);

    let refused = client.hello().expect_err("hello must be refused");
    assert!(
        refused.to_string().contains("older than this host accepts"),
        "{refused}"
    );

    // Spawning does not check the version; attaching does.
    let (id, _) = client.spawn(spec("sleep 300")).unwrap();
    let error = client.attach(id, 0).err().expect("attach must be refused");
    assert!(
        error.to_string().contains("older than this host accepts"),
        "{error}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_attach_reply_carries_the_host_version() {
    let h = Harness::start("y", 60);
    let (id, _) = h.client.spawn(spec("sleep 300")).unwrap();
    // `attach` checks the reply version; reaching here means the host's was ok.
    let attached = h.client.attach(id, 0).unwrap();
    assert!(attached.start <= attached.end);
}

#[test]
fn a_hello_without_a_version_is_still_accepted() {
    // Older apps send a bare hello; the host must not reject them.
    let h = Harness::start("w", 60);
    let reply = raw_request(h.client.socket(), b"{\"op\":\"hello\"}\n");
    assert!(reply.contains("\"ok\":true"), "{reply}");
}

#[test]
fn a_repeated_spawn_key_returns_the_existing_session() {
    let h = Harness::start("z", 60);
    let mut keyed = spec("sleep 300");
    keyed.key = Some("sess-1:req-1".into());
    let (id, pid, existing) = h.client.spawn_keyed(keyed.clone()).unwrap();
    assert!(!existing);
    let (id2, pid2, existing2) = h.client.spawn_keyed(keyed.clone()).unwrap();
    assert!(existing2, "a repeated key started a second session");
    assert_eq!((id, pid), (id2, pid2));
    let listed = h.client.list().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].key.as_deref(), Some("sess-1:req-1"));

    // A different key is a different session.
    let mut other_key = spec("sleep 300");
    other_key.key = Some("sess-1:req-2".into());
    let (id3, _, existing3) = h.client.spawn_keyed(other_key).unwrap();
    assert!(!existing3);
    assert_ne!(id, id3);
}

#[test]
fn concurrent_spawns_with_one_key_start_one_session() {
    let h = Harness::start("zz", 60);
    let handles: Vec<_> = (0..6)
        .map(|_| {
            let client = h.client.clone();
            std::thread::spawn(move || {
                let mut keyed = spec("sleep 300");
                keyed.key = Some("race-key".into());
                client.spawn_keyed(keyed).unwrap()
            })
        })
        .collect();
    let results: Vec<(u32, u32, bool)> = handles.into_iter().map(|t| t.join().unwrap()).collect();
    assert!(results.windows(2).all(|w| w[0].0 == w[1].0), "{results:?}");
    assert_eq!(results.iter().filter(|r| !r.2).count(), 1, "{results:?}");
    assert_eq!(h.client.list().unwrap().len(), 1);
}

#[test]
fn a_key_still_returns_its_first_answer_after_the_session_exits_and_is_freed_by_reap() {
    let h = Harness::start("zy", 60);
    let mut keyed = spec("exit 5");
    keyed.key = Some("retry-me".into());
    let (id, _, _) = h.client.spawn_keyed(keyed.clone()).unwrap();
    assert!(wait_until(t(5), || {
        h.client.list().unwrap()[0].exited == Some(5)
    }));
    // A retried spawn gets the first session, not a fresh run of the command.
    let (again, _, existing) = h.client.spawn_keyed(keyed.clone()).unwrap();
    assert!(existing);
    assert_eq!(again, id);
    // Once reaped the key is free.
    h.client.reap(id).unwrap();
    let (fresh, _, existing) = h.client.spawn_keyed(keyed).unwrap();
    assert!(!existing);
    assert_ne!(fresh, id);
}

#[test]
fn an_idle_host_exits_by_itself() {
    let h = Harness::start("j", 1);
    let host_pid = h.client.hello().unwrap().host_pid.unwrap();
    // Do not poll over the socket: a connection counts as activity and would
    // keep the host alive. Watch the process instead.
    assert!(
        wait_until(t(8), || !alive(host_pid)),
        "an idle host never exited"
    );
    assert!(h.client.hello().is_err(), "socket still answers after exit");
}

#[test]
fn a_host_with_a_live_session_does_not_idle_out() {
    let h = Harness::start("k", 1);
    let (_, pid) = h.client.spawn(spec("sleep 300")).unwrap();
    std::thread::sleep(Duration::from_secs(3));
    assert!(alive(pid), "idle exit killed a live session");
    assert!(h.client.hello().is_ok());
}

#[test]
fn exited_sessions_are_dropped_after_the_ttl() {
    let (dir, socket) = endpoint("ttl");
    let client =
        HostClient::ensure_running_with(&host_exe(), &socket, 60, &["--exited-ttl-secs", "1"])
            .unwrap();
    client.spawn(spec("exit 0")).unwrap();
    assert!(wait_until(t(5), || { client.list().unwrap().is_empty() }));
    let _ = client.shutdown();
    std::thread::sleep(Duration::from_millis(200));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn host_child_wait_returns_when_the_session_is_gone() {
    use portable_pty::Child;
    let h = Harness::start("l", 60);
    let (id, pid) = h.client.spawn(spec("sleep 300")).unwrap();
    let mut child = canopy_pty_host::client::HostChild::new(h.client.clone(), id, pid);
    assert!(child.try_wait().unwrap().is_none());
    h.client.kill(id).unwrap();
    let status = child.wait().unwrap(); // must not hang
                                        // A second wait answers from the cached status, even after the reap.
    assert!(child.try_wait().unwrap().is_some());
}

#[test]
fn set_meta_updates_what_a_later_list_reports() {
    let h = Harness::start("m", 60);
    let (id, _) = h.client.spawn(spec("sleep 300")).unwrap();
    h.client.set_meta(id, Some("renamed".into())).unwrap();
    assert_eq!(h.client.list().unwrap()[0].meta.as_deref(), Some("renamed"));
}

#[test]
fn only_spawn_restarts_a_dead_host_and_a_stale_id_cannot_reach_a_new_one() {
    let h = Harness::start("n", 60);
    let client = h.client.clone();
    let (old_id, _) = client.spawn(spec("sleep 300")).unwrap();
    let before = client.hello().unwrap().host_pid.unwrap();
    stop_host(before);
    assert!(wait_until(t(10), || !alive(before)));

    // Liveness probes and id-addressed calls must not resurrect the host.
    assert!(client.pgrp(old_id).is_err());
    assert!(client.kill(old_id).is_err());
    assert!(client.hello().is_err(), "a probe started a host");

    // Spawning may start a replacement, and its ids never collide with old ones.
    let (new_id, _) = client.spawn(spec("sleep 300")).unwrap();
    assert_ne!(old_id, new_id, "a stale id would address the new terminal");
    assert!(
        client.kill(old_id).is_err(),
        "stale id reached a live session"
    );
    assert!(client.list().unwrap().iter().all(|s| s.id == new_id));
}

#[test]
fn a_session_with_a_linger_is_killed_after_its_client_drops() {
    let h = Harness::start("o", 60);
    let mut with_linger = spec("sleep 300");
    with_linger.linger_secs = Some(1);
    let (id, pid) = h.client.spawn(with_linger).unwrap();
    let attached = h.client.attach(id, 0).unwrap();
    std::thread::sleep(Duration::from_millis(1500));
    assert!(alive(pid), "killed while its client was still attached");
    drop(attached);
    assert!(
        wait_until(t(10), || !alive(pid)),
        "a detached session outlived its linger"
    );
}

#[test]
fn a_session_with_a_linger_that_is_never_attached_is_killed() {
    let h = Harness::start("p", 60);
    let mut with_linger = spec("sleep 300");
    with_linger.linger_secs = Some(1);
    let (_, pid) = h.client.spawn(with_linger).unwrap();
    assert!(wait_until(t(10), || !alive(pid)));
}

#[test]
fn a_session_without_a_linger_survives_a_dropped_client() {
    let h = Harness::start("q", 60);
    let (id, pid) = h.client.spawn(spec("sleep 300")).unwrap();
    drop(h.client.attach(id, 0).unwrap());
    std::thread::sleep(Duration::from_secs(3));
    assert!(alive(pid), "a session with no linger was killed");
}

#[test]
fn state_first_writer_wins_and_survives_client_reconnects() {
    let h = Harness::start("st", 60);
    assert_eq!(h.client.get_state("instance").unwrap(), None);
    let first = h.client.set_state("instance", "aaa", true).unwrap();
    assert_eq!(first.as_deref(), Some("aaa"));
    // A second app launch offering its own token gets the first one back.
    let second = h.client.set_state("instance", "bbb", true).unwrap();
    assert_eq!(second.as_deref(), Some("aaa"));
    assert_eq!(
        h.client.get_state("instance").unwrap().as_deref(),
        Some("aaa")
    );
    // Without if_unset it overwrites.
    h.client.set_state("instance", "ccc", false).unwrap();
    assert_eq!(
        h.client.get_state("instance").unwrap().as_deref(),
        Some("ccc")
    );
}

#[test]
fn lifting_linger_keeps_an_unattached_session_alive_and_a_new_limit_restarts_the_clock() {
    let h = Harness::start("sl", 60);
    let mut s = spec("sleep 300");
    s.linger_secs = Some(1);
    let (id, _) = h.client.spawn(s).unwrap();
    h.client.set_linger(id, None).unwrap();
    std::thread::sleep(Duration::from_millis(2500));
    assert!(
        h.client.list().unwrap()[0].exited.is_none(),
        "limit was lifted"
    );
    // Re-imposing a limit counts from now, not from the original detach.
    h.client.set_linger(id, Some(2)).unwrap();
    std::thread::sleep(Duration::from_millis(800));
    assert!(
        h.client.list().unwrap()[0].exited.is_none(),
        "clock restarted"
    );
    let deadline = Instant::now() + t(8);
    loop {
        if h.client.list().unwrap()[0].exited.is_some() {
            break;
        }
        assert!(Instant::now() < deadline, "session never lingered out");
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[test]
fn an_unknown_op_gets_an_error_line_and_the_host_stays_up() {
    // Adoption on an older host falls back to list and kill when a newer op is
    // refused, which only works if the refusal is a reply, not a hang-up.
    let h = Harness::start("uo", 60);
    let reply = raw_request(h.client.socket(), b"{\"op\":\"from_the_future\"}\n");
    assert!(reply.contains("\"ok\":false"), "{reply}");
    assert!(reply.contains("bad request"), "{reply}");
    h.client
        .hello()
        .expect("host still serves after a bad request");
}

#[test]
fn list_reports_whether_a_client_is_attached_and_an_old_host_reads_as_unknown() {
    let h = Harness::start("at", 60);
    let (id, _) = h.client.spawn(spec("sleep 300")).unwrap();
    assert_eq!(h.client.list().unwrap()[0].attached, Some(false));
    let attached = h.client.attach(id, 0).unwrap();
    assert!(wait_until(Duration::from_secs(5), || {
        h.client.list().unwrap()[0].attached == Some(true)
    }));
    drop(attached);
    assert!(wait_until(Duration::from_secs(5), || {
        h.client.list().unwrap()[0].attached == Some(false)
    }));
    // A host from before the field omits it; that must not look like "free".
    let info: canopy_pty_host::protocol::SessionInfo = serde_json::from_str(r#"{"id":1}"#).unwrap();
    assert_eq!(info.attached, None);
}

#[test]
fn an_exclusive_attach_is_refused_while_a_client_is_attached_and_taken_when_free() {
    let h = Harness::start("ex", 60);
    let (id, _) = h.client.spawn(spec(pick("cat", ECHO_PS))).unwrap();
    let mut first = h.client.attach_exclusive(id, 0).expect("free session");
    let refused = h
        .client
        .attach_exclusive(id, 0)
        .err()
        .expect("second exclusive attach");
    assert!(
        refused
            .to_string()
            .contains(canopy_pty_host::protocol::BUSY),
        "{refused}"
    );
    // The refused attempt must not have disturbed the first client.
    first
        .stream
        .write_all(pick("still-mine\n", "still-mine\r").as_bytes())
        .unwrap();
    let out = read_until(&mut first, t(5), |b| contains(b, "still-mine"));
    assert!(
        contains(&out, "still-mine"),
        "first client lost its session"
    );
    drop(first);
    assert!(wait_until(Duration::from_secs(5), || {
        h.client.list().unwrap()[0].attached == Some(false)
    }));
    assert!(
        h.client.attach_exclusive(id, 0).is_ok(),
        "free again after detach"
    );
}

#[test]
fn read_ring_returns_history_without_detaching_or_starting_the_linger() {
    let h = Harness::start("rr", 60);
    // `echo` and `sleep` are PowerShell aliases too.
    let mut with_linger = spec("echo first-line; echo second-line; sleep 300");
    with_linger.linger_secs = Some(1);
    let (id, pid) = h.client.spawn(with_linger).unwrap();
    let mut attached = h.client.attach(id, 0).unwrap();
    read_until(&mut attached, t(5), |b| contains(b, "second-line"));

    let (reply, bytes) = h.client.read_ring(id, 0, None).unwrap();
    assert!(contains(&bytes, "first-line") && contains(&bytes, "second-line"));
    assert_eq!(reply.len as usize, bytes.len());
    assert_eq!(reply.start, 0);
    assert_eq!(reply.end, bytes.len() as u64);
    let (capped, few) = h.client.read_ring(id, 0, Some(5)).unwrap();
    assert_eq!(few.len(), 5);
    assert_eq!(capped.len, 5);

    // Still attached, so the one-second linger never started.
    assert_eq!(h.client.list().unwrap()[0].attached, Some(true));
    std::thread::sleep(Duration::from_millis(1500));
    assert!(
        alive(pid),
        "read_ring detached the client and the linger fired"
    );
    attached.stream.write_all(b"x").unwrap();
}

#[test]
fn read_ring_past_the_end_returns_nothing() {
    let h = Harness::start("re", 60);
    let (id, _) = h.client.spawn(spec("echo done; sleep 300")).unwrap();
    assert!(wait_until(t(5), || { h.client.list().unwrap()[0].end > 0 }));
    let end = h.client.list().unwrap()[0].end;
    let (reply, bytes) = h.client.read_ring(id, end + 100, None).unwrap();
    assert!(bytes.is_empty());
    assert_eq!(reply.start, reply.end);
    assert_eq!(reply.len, 0);
    assert!(h.client.read_ring(id + 1000, 0, None).is_err());
}

#[test]
fn a_replaced_client_sees_eof_and_its_typing_no_longer_reaches_the_child() {
    let h = Harness::start("rp", 60);
    let (id, _) = h.client.spawn(spec(pick("cat", ECHO_PS))).unwrap();
    let mut first = h.client.attach(id, 0).unwrap();
    // Set before the host closes it: macOS refuses setsockopt (EINVAL) on a
    // socket whose peer has already gone.
    first.stream.set_read_timeout(Some(t(5))).unwrap();
    let mut second = h.client.attach(id, 0).unwrap();

    // The first connection is closed by the host, not left frozen.
    let mut buf = [0u8; 256];
    let mut saw_eof = false;
    let deadline = Instant::now() + t(5);
    while Instant::now() < deadline {
        match first.stream.read(&mut buf) {
            Ok(0) => {
                saw_eof = true;
                break;
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    assert!(saw_eof, "replaced client was not disconnected");

    // Whatever the replaced client still tries to type is not delivered.
    let _ = first
        .stream
        .write_all(pick("from-the-old-client\n", "from-the-old-client\r").as_bytes());
    second
        .stream
        .write_all(pick("from-the-new-client\n", "from-the-new-client\r").as_bytes())
        .unwrap();
    // On Windows the child's own answer, not conhost's echo of the typing.
    let expect = pick("from-the-new-client", "got-FROM-THE-NEW-CLIENT");
    let out = read_until(&mut second, t(5), |b| contains(b, expect));
    assert!(contains(&out, expect));
    assert!(
        !contains(&out, "from-the-old-client") && !contains(&out, "FROM-THE-OLD-CLIENT"),
        "a replaced client's input reached the child"
    );
    assert_eq!(h.client.list().unwrap()[0].attached, Some(true));
}
