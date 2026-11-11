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
        ..Default::default()
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
                                                    // Before the attach the host drains the child into its ring, and on a fast
                                                    // pty that can already be megabytes, so the bound below is on what the
                                                    // stalled client adds, measured from here.
    let at_attach = h.client.list().unwrap()[0].end;

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
        ((first - at_attach) as usize) < HIGH_WATER + 1024 * 1024,
        "host buffered {} bytes for a stalled client",
        first - at_attach
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
    // The app keeps the installed copy a live host was started from.
    let exe = std::path::PathBuf::from(hello.exe.expect("hello names the host's exe"));
    assert_eq!(
        exe.canonicalize().unwrap(),
        host_exe().canonicalize().unwrap()
    );
}

#[test]
fn a_client_older_than_the_host_accepts_is_refused_at_hello_and_attach() {
    // A host whose minimum is above this client's version. It is started by hand:
    // `ensure_running` would replace it (it runs no terminals yet).
    let dir = std::env::temp_dir().join(format!("cph{}skew", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let socket = dir.join("h.sock");
    let mut host = std::process::Command::new(host_exe())
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
        .spawn()
        .unwrap();
    assert!(wait_until(Duration::from_secs(5), || socket.exists()));
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

    let _ = host.kill();
    let _ = host.wait();
    let _ = std::fs::remove_dir_all(&dir);
}

/// A host started by hand that refuses this client (its minimum is one above
/// our protocol), the way a newer app's host looks after a downgrade, or an
/// older one after a minimum-version bump.
fn refusing_host(name: &str) -> (PathBuf, PathBuf, std::process::Child) {
    let dir = std::env::temp_dir().join(format!("cph{}{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let socket = dir.join("h.sock");
    let host = std::process::Command::new(host_exe())
        .arg("--socket")
        .arg(&socket)
        .args([
            "--min-client",
            &(canopy_pty_host::protocol::PROTOCOL_VERSION + 1).to_string(),
            "--idle-secs",
            "60",
        ])
        .spawn()
        .unwrap();
    assert!(wait_until(Duration::from_secs(5), || socket.exists()));
    (dir, socket, host)
}

/// Waits (bounded) for a child to exit; true if it did.
fn exits_within(child: &mut std::process::Child, timeout: Duration) -> bool {
    wait_until(timeout, || matches!(child.try_wait(), Ok(Some(_))))
}

#[test]
fn an_idle_incompatible_host_is_replaced_by_ours() {
    let (dir, socket, mut old) = refusing_host("skewr");
    let old_pid = old.id();
    let client = HostClient::ensure_running(&host_exe(), &socket, 60)
        .expect("an idle incompatible host is replaced");
    let hello = client.hello().expect("the new host accepts this client");
    assert_ne!(hello.host_pid, Some(old_pid));
    assert!(
        exits_within(&mut old, Duration::from_secs(10)),
        "the old host was not shut down"
    );
    let _ = client.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_incompatible_host_with_terminals_is_left_running_for_them() {
    let (dir, socket, mut old) = refusing_host("skewk");
    // Spawning is not version-gated, so the old host can be given a terminal.
    let (id, _) = HostClient::new(&socket).spawn(spec("sleep 300")).unwrap();
    let error = HostClient::ensure_running(&host_exe(), &socket, 60)
        .expect_err("a host with terminals must not be replaced");
    let message = error.to_string();
    assert!(message.contains("still running 1 terminal"), "{message}");
    // Still the old host, still running the terminal.
    assert!(
        matches!(old.try_wait(), Ok(None)),
        "the old host was stopped"
    );
    let listed = HostClient::new(&socket).list().unwrap();
    assert!(listed.iter().any(|s| s.id == id && s.exited.is_none()));
    let _ = old.kill();
    let _ = exits_within(&mut old, Duration::from_secs(10));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_launch_check_runs_before_every_start_and_can_stop_it() {
    use canopy_pty_host::client::LaunchCheck;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    let dir = std::env::temp_dir().join(format!("cph{}chk", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let socket = dir.join("h.sock");
    let refuse = LaunchCheck(Arc::new(|_: &std::path::Path| {
        Err(std::io::Error::other("copy no longer matches"))
    }));
    let error = HostClient::ensure_running_checked(&host_exe(), &socket, 60, &[], Some(refuse))
        .expect_err("a failed check stops the start");
    assert!(error.to_string().contains("no longer matches"), "{error}");
    assert!(!socket.exists(), "nothing was started");

    let calls = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&calls);
    let count = LaunchCheck(Arc::new(move |_: &std::path::Path| {
        counted.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }));
    let client =
        HostClient::ensure_running_checked(&host_exe(), &socket, 60, &[], Some(count)).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    // A restart by the client's spawn runs the same check again.
    client.shutdown().unwrap();
    assert!(wait_until(Duration::from_secs(5), || !socket.exists()));
    let (_, _) = client.spawn(spec("sleep 300")).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let _ = client.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_host_binary_that_cannot_be_executed_reports_permission_denied() {
    // What a noexec home looks like from here: exec fails with EACCES.
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("cph{}nox", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let exe = dir.join("canopy-pty-host");
    std::fs::copy(host_exe(), &exe).unwrap();
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o644)).unwrap();
    let error = HostClient::ensure_running(&exe, &dir.join("h.sock"), 60)
        .expect_err("a non-executable host cannot start");
    assert_eq!(
        error.kind(),
        std::io::ErrorKind::PermissionDenied,
        "{error}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn hello_outcomes_and_skew_actions_are_classified() {
    use canopy_pty_host::client::{classify_hello, skew_action, HelloOutcome, SkewAction};
    use canopy_pty_host::protocol::{Response, SessionInfo, MIN_HOST_VERSION};
    use std::io::{Error, ErrorKind};
    let reply = |ok: bool, version: Option<u32>| -> std::io::Result<Response> {
        Ok(Response {
            ok,
            version,
            ..Default::default()
        })
    };
    assert!(matches!(
        classify_hello(reply(true, Some(MIN_HOST_VERSION))),
        HelloOutcome::Compatible
    ));
    // The host refuses us (its minimum is above our version).
    assert!(matches!(
        classify_hello(reply(false, Some(MIN_HOST_VERSION + 5))),
        HelloOutcome::Skewed { .. }
    ));
    // The host accepts us but is older than we can use, or does not say.
    assert!(matches!(
        classify_hello(reply(true, Some(MIN_HOST_VERSION - 1))),
        HelloOutcome::Skewed { .. }
    ));
    assert!(matches!(
        classify_hello(reply(true, None)),
        HelloOutcome::Skewed { .. }
    ));
    for kind in [ErrorKind::NotFound, ErrorKind::ConnectionRefused] {
        assert!(matches!(
            classify_hello(Err(Error::from(kind))),
            HelloOutcome::NoHost
        ));
    }
    // A timeout says nothing about versions: never treated as skew.
    assert!(matches!(
        classify_hello(Err(Error::from(ErrorKind::TimedOut))),
        HelloOutcome::Unknown(_)
    ));

    let session = |exited: Option<i32>| SessionInfo {
        exited,
        ..Default::default()
    };
    assert_eq!(skew_action(&Ok(vec![])), SkewAction::Replace);
    assert_eq!(
        skew_action(&Ok(vec![session(Some(0)), session(Some(1))])),
        SkewAction::Replace
    );
    // Every running session counts, adoptable or not.
    assert_eq!(
        skew_action(&Ok(vec![session(None), session(Some(0)), session(None)])),
        SkewAction::Keep(Some(2))
    );
    assert_eq!(
        skew_action(&Err(Error::from(ErrorKind::TimedOut))),
        SkewAction::Keep(None)
    );
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
    assert!(wait_until(Duration::from_secs(5), || {
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
    let deadline = Instant::now() + Duration::from_secs(8);
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
    let mut stream = UnixStream::connect(h.client.socket()).unwrap();
    stream.write_all(b"{\"op\":\"from_the_future\"}\n").unwrap();
    let mut reply = String::new();
    let mut byte = [0u8; 1];
    while stream.read(&mut byte).unwrap() == 1 && byte[0] != b'\n' {
        reply.push(byte[0] as char);
    }
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
    let (id, _) = h.client.spawn(spec("cat")).unwrap();
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
    first.stream.write_all(b"still-mine\n").unwrap();
    let out = read_until(&mut first, Duration::from_secs(5), |b| {
        contains(b, "still-mine")
    });
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
    let mut with_linger = spec("echo first-line; echo second-line; sleep 300");
    with_linger.linger_secs = Some(1);
    let (id, pid) = h.client.spawn(with_linger).unwrap();
    let mut attached = h.client.attach(id, 0).unwrap();
    read_until(&mut attached, Duration::from_secs(5), |b| {
        contains(b, "second-line")
    });

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
    assert!(wait_until(Duration::from_secs(5), || {
        h.client.list().unwrap()[0].end > 0
    }));
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
    let (id, _) = h.client.spawn(spec("cat")).unwrap();
    let mut first = h.client.attach(id, 0).unwrap();
    let mut second = h.client.attach(id, 0).unwrap();

    // The first connection is closed by the host, not left frozen.
    first
        .stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut buf = [0u8; 256];
    let mut saw_eof = false;
    let deadline = Instant::now() + Duration::from_secs(5);
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
    let _ = first.stream.write_all(b"from-the-old-client\n");
    second.stream.write_all(b"from-the-new-client\n").unwrap();
    let out = read_until(&mut second, Duration::from_secs(5), |b| {
        contains(b, "from-the-new-client")
    });
    assert!(contains(&out, "from-the-new-client"));
    assert!(
        !contains(&out, "from-the-old-client"),
        "a replaced client's input reached the child"
    );
    assert_eq!(h.client.list().unwrap()[0].attached, Some(true));
}
