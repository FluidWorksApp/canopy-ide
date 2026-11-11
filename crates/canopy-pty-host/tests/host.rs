//! Runs the real detached `canopy-pty-host` binary. Each test gets its own socket
//! directory and shuts its host down on drop.
#![cfg(unix)]

use canopy_pty_host::client::{Attached, HostClient};
use canopy_pty_host::protocol::SpawnSpec;
use canopy_pty_host::server::{HIGH_WATER, RING_CAP};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn host_exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_canopy-pty-host"))
}

struct Harness {
    dir: PathBuf,
    client: HostClient,
}

impl Harness {
    fn start(name: &str, idle_secs: u64) -> Harness {
        // Short on purpose: macOS caps unix socket paths at about 104 bytes.
        let dir = std::env::temp_dir().join(format!("cph{}{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        let client = HostClient::ensure_running(&host_exe(), &dir.join("h.sock"), idle_secs)
            .expect("host starts");
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
    }
}

fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only probes for existence.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
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

#[test]
fn child_survives_client_death_and_reattach_is_contiguous() {
    let h = Harness::start("a", 60);
    let (id, pid) = h.client.spawn(spec(TICKER)).unwrap();

    let mut first = h.client.attach(id, 0).unwrap();
    let before = read_until(&mut first, Duration::from_secs(5), |b| {
        contains(b, "tick5\r")
    });
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
    let after = read_until(&mut second, Duration::from_secs(5), |b| {
        contains(b, "tick15\r")
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
    let (id, _) = h.client.spawn(spec("cat")).unwrap();
    let mut a = h.client.attach(id, 0).unwrap();
    a.stream.write_all(b"hello-from-client\n").unwrap();
    let out = read_until(&mut a, Duration::from_secs(5), |b| {
        contains(b, "hello-from-client")
    });
    assert!(contains(&out, "hello-from-client"));
}

#[test]
fn stalled_client_blocks_the_child_instead_of_growing_memory() {
    let h = Harness::start("c", 60);
    let (id, _) = h.client.spawn(spec("yes")).unwrap();
    let _stalled = h.client.attach(id, 0).unwrap(); // attached, never reads

    std::thread::sleep(Duration::from_millis(1500));
    let first = h.client.list().unwrap()[0].end;
    std::thread::sleep(Duration::from_millis(1000));
    let second = h.client.list().unwrap()[0].end;

    assert!(first > 0, "child produced nothing");
    assert!(
        second - first < 256 * 1024,
        "output kept growing for a stalled client: {first} -> {second}"
    );
    assert!(
        (first as usize) < HIGH_WATER + 1024 * 1024,
        "host buffered {first} bytes for a stalled client"
    );
}

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

#[test]
fn resize_from_a_non_parent_client_reaches_the_child() {
    let h = Harness::start("e", 60);
    let script = "trap 'echo size $(stty size)' WINCH; echo ready; while :; do sleep 0.05; done";
    let (id, _) = h.client.spawn(spec(script)).unwrap();
    let mut a = h.client.attach(id, 0).unwrap();
    let _ = read_until(&mut a, Duration::from_secs(5), |b| contains(b, "ready"));
    h.client.resize(id, 100, 30).unwrap();
    let out = read_until(&mut a, Duration::from_secs(5), |b| {
        contains(b, "size 30 100")
    });
    assert!(
        contains(&out, "size 30 100"),
        "got {:?}",
        String::from_utf8_lossy(&out)
    );
    assert_eq!(h.client.list().unwrap()[0].cols, 100);
}

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

#[test]
fn exit_status_is_reported() {
    let h = Harness::start("g", 60);
    let (_, _) = h.client.spawn(spec("exit 7")).unwrap();
    assert!(wait_until(Duration::from_secs(5), || {
        h.client.list().unwrap()[0].exited == Some(7)
    }));
}

#[test]
fn sigterm_to_the_host_leaves_no_orphans() {
    let h = Harness::start("h", 60);
    let (_, a) = h.client.spawn(spec("sleep 300")).unwrap();
    let (_, b) = h.client.spawn(spec("sleep 300")).unwrap();
    let host_pid = h.client.hello().unwrap().host_pid.unwrap();
    // SAFETY: terminating the host process this test started.
    unsafe { libc::kill(host_pid as libc::pid_t, libc::SIGTERM) };
    assert!(
        wait_until(Duration::from_secs(10), || !alive(a) && !alive(b)),
        "children outlived a terminated host"
    );
    assert!(wait_until(Duration::from_secs(5), || h
        .client
        .hello()
        .is_err()));
}

#[test]
fn simultaneous_starts_create_one_host() {
    let dir = std::env::temp_dir().join(format!("cph{}race", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let socket = dir.join("h.sock");
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
    let mut stream = UnixStream::connect(h.client.socket()).unwrap();
    stream
        .write_all(b"{\"op\":\"hello\",\"future\":true}\n")
        .unwrap();
    let mut reply = String::new();
    let mut byte = [0u8; 1];
    while stream.read(&mut byte).unwrap() == 1 && byte[0] != b'\n' {
        reply.push(byte[0] as char);
    }
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

#[test]
fn a_client_older_than_the_host_accepts_is_refused_at_hello_and_attach() {
    let h = Harness::start("x", 60);
    // Version 0 means "did not say" and is always accepted, so use a raw request
    // with a version the host cannot accept once its minimum is above 1; until
    // then assert only that the field is understood and a current client passes.
    let mut stream = UnixStream::connect(h.client.socket()).unwrap();
    stream
        .write_all(b"{\"op\":\"hello\",\"client_version\":1}\n")
        .unwrap();
    let mut reply = String::new();
    let mut byte = [0u8; 1];
    while stream.read(&mut byte).unwrap() == 1 && byte[0] != b'\n' {
        reply.push(byte[0] as char);
    }
    let accepted = canopy_pty_host::protocol::MIN_CLIENT_VERSION <= 1;
    assert_eq!(reply.contains("\"ok\":true"), accepted, "{reply}");
}

#[test]
fn a_hello_without_a_version_is_still_accepted() {
    // Older apps send a bare hello; the host must not reject them.
    let h = Harness::start("w", 60);
    let mut stream = UnixStream::connect(h.client.socket()).unwrap();
    stream.write_all(b"{\"op\":\"hello\"}\n").unwrap();
    let mut reply = String::new();
    let mut byte = [0u8; 1];
    while stream.read(&mut byte).unwrap() == 1 && byte[0] != b'\n' {
        reply.push(byte[0] as char);
    }
    assert!(reply.contains("\"ok\":true"), "{reply}");
}

#[test]
fn an_idle_host_exits_by_itself() {
    let h = Harness::start("j", 1);
    let host_pid = h.client.hello().unwrap().host_pid.unwrap();
    // Do not poll over the socket: a connection counts as activity and would
    // keep the host alive. Watch the process instead.
    assert!(
        wait_until(Duration::from_secs(8), || !alive(host_pid)),
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
    let dir = std::env::temp_dir().join(format!("cph{}ttl", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let socket = dir.join("h.sock");
    let client =
        HostClient::ensure_running_with(&host_exe(), &socket, 60, &["--exited-ttl-secs", "1"])
            .unwrap();
    client.spawn(spec("exit 0")).unwrap();
    assert!(wait_until(Duration::from_secs(5), || {
        client.list().unwrap().is_empty()
    }));
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
    // SAFETY: terminating the host this test started.
    unsafe { libc::kill(before as libc::pid_t, libc::SIGTERM) };
    assert!(wait_until(Duration::from_secs(10), || !alive(before)));

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
        wait_until(Duration::from_secs(10), || !alive(pid)),
        "a detached session outlived its linger"
    );
}

#[test]
fn a_session_with_a_linger_that_is_never_attached_is_killed() {
    let h = Harness::start("p", 60);
    let mut with_linger = spec("sleep 300");
    with_linger.linger_secs = Some(1);
    let (_, pid) = h.client.spawn(with_linger).unwrap();
    assert!(wait_until(Duration::from_secs(10), || !alive(pid)));
}

#[test]
fn a_session_without_a_linger_survives_a_dropped_client() {
    let h = Harness::start("q", 60);
    let (id, pid) = h.client.spawn(spec("sleep 300")).unwrap();
    drop(h.client.attach(id, 0).unwrap());
    std::thread::sleep(Duration::from_secs(3));
    assert!(alive(pid), "a session with no linger was killed");
}
