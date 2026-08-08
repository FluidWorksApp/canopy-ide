//! Bounded ownership for short-lived subprocesses whose output is consumed as
//! one result. Pipes are drained concurrently for the full child lifetime, but
//! retain only a fixed prefix so a rogue tool cannot make `Command::output`
//! grow the native host without bound.

use serde::Serialize;
use std::io::Read;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Instant;
use tokio::io::{AsyncRead, AsyncReadExt};

pub(crate) const DEFAULT_STREAM_MAX: usize = 8 * 1024 * 1024;
const MAX_ACTIVE_CAPTURES: usize = 4;
const MAX_QUEUED_CAPTURES: usize = 32;
const MAX_ACTIVE_CAPTURE_BYTES: usize = 64 * 1024 * 1024;

pub(crate) struct CappedOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub max_per_stream: usize,
    retained_charge: usize,
    permit: Option<CapturePermit>,
}

impl Drop for CappedOutput {
    fn drop(&mut self) {
        RETAINED_BYTES_CURRENT.fetch_sub(self.retained_charge, Ordering::Relaxed);
    }
}

impl CappedOutput {
    /// Transfer stdout to a caller that becomes its owner; capture telemetry
    /// stops charging those bytes at the ownership boundary.
    pub(crate) fn take_stdout(&mut self) -> Vec<u8> {
        let bytes = std::mem::take(&mut self.stdout);
        self.retained_charge = self.retained_charge.saturating_sub(bytes.len());
        RETAINED_BYTES_CURRENT.fetch_sub(bytes.len(), Ordering::Relaxed);
        self.permit.take();
        bytes
    }
}

#[derive(Clone, Serialize)]
pub struct ProcessCaptureMetrics {
    pub active_children: usize,
    pub active_pipes: usize,
    pub active_captures: usize,
    pub queued_captures: usize,
    pub active_capture_bytes: usize,
    pub capture_bytes_high_water: usize,
    pub capture_high_water: usize,
    pub queue_high_water: usize,
    pub rejected_captures: u64,
    pub queue_wait_ms_total: u64,
    pub child_high_water: usize,
    pub pipe_high_water: usize,
    pub completed_children: u64,
    pub retained_bytes_current: usize,
    pub retained_bytes_high_water: usize,
    pub retained_bytes_total: u64,
    pub truncated_streams: u64,
}

static ACTIVE_CHILDREN: AtomicUsize = AtomicUsize::new(0);
static ACTIVE_PIPES: AtomicUsize = AtomicUsize::new(0);
static CHILD_HIGH_WATER: AtomicUsize = AtomicUsize::new(0);
static PIPE_HIGH_WATER: AtomicUsize = AtomicUsize::new(0);
static CAPTURE_HIGH_WATER: AtomicUsize = AtomicUsize::new(0);
static QUEUE_HIGH_WATER: AtomicUsize = AtomicUsize::new(0);
static CAPTURE_BYTES_HIGH_WATER: AtomicUsize = AtomicUsize::new(0);
static REJECTED_CAPTURES: AtomicU64 = AtomicU64::new(0);
static QUEUE_WAIT_MS_TOTAL: AtomicU64 = AtomicU64::new(0);
static COMPLETED_CHILDREN: AtomicU64 = AtomicU64::new(0);
static RETAINED_BYTES_CURRENT: AtomicUsize = AtomicUsize::new(0);
static RETAINED_BYTES_HIGH_WATER: AtomicUsize = AtomicUsize::new(0);
static RETAINED_BYTES_TOTAL: AtomicU64 = AtomicU64::new(0);
static TRUNCATED_STREAMS: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct AdmissionState {
    active: usize,
    active_bytes: usize,
    queued: usize,
}

fn admission() -> &'static (Mutex<AdmissionState>, Condvar) {
    static ADMISSION: OnceLock<(Mutex<AdmissionState>, Condvar)> = OnceLock::new();
    ADMISSION.get_or_init(|| (Mutex::new(AdmissionState::default()), Condvar::new()))
}

fn async_wake() -> &'static tokio::sync::Notify {
    static WAKE: OnceLock<tokio::sync::Notify> = OnceLock::new();
    WAKE.get_or_init(tokio::sync::Notify::new)
}

thread_local! {
    static SYNC_CAPTURE_HELD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub(crate) struct CapturePermit {
    bytes: usize,
}

impl Drop for CapturePermit {
    fn drop(&mut self) {
        let (lock, condvar) = admission();
        let mut state = lock.lock().unwrap();
        state.active = state.active.saturating_sub(1);
        state.active_bytes = state.active_bytes.saturating_sub(self.bytes);
        drop(state);
        condvar.notify_one();
        async_wake().notify_one();
    }
}

pub(crate) fn acquire(max_per_stream: usize) -> Result<CapturePermit, String> {
    let bytes = max_per_stream
        .checked_mul(2)
        .ok_or_else(|| "process capture byte reservation overflowed".to_string())?;
    if bytes > MAX_ACTIVE_CAPTURE_BYTES {
        REJECTED_CAPTURES.fetch_add(1, Ordering::Relaxed);
        return Err("process capture exceeds the global active-byte budget".into());
    }
    let started = Instant::now();
    let (lock, condvar) = admission();
    let mut state = lock.lock().unwrap();
    if state.active >= MAX_ACTIVE_CAPTURES
        || state.active_bytes.saturating_add(bytes) > MAX_ACTIVE_CAPTURE_BYTES
    {
        if state.queued >= MAX_QUEUED_CAPTURES {
            REJECTED_CAPTURES.fetch_add(1, Ordering::Relaxed);
            return Err("process capture admission queue is full".into());
        }
        state.queued += 1;
        raise_high_water(&QUEUE_HIGH_WATER, state.queued);
        while state.active >= MAX_ACTIVE_CAPTURES
            || state.active_bytes.saturating_add(bytes) > MAX_ACTIVE_CAPTURE_BYTES
        {
            state = condvar.wait(state).unwrap();
        }
        state.queued -= 1;
        QUEUE_WAIT_MS_TOTAL.fetch_add(started.elapsed().as_millis() as u64, Ordering::Relaxed);
    }
    state.active += 1;
    state.active_bytes += bytes;
    raise_high_water(&CAPTURE_HIGH_WATER, state.active);
    raise_high_water(&CAPTURE_BYTES_HIGH_WATER, state.active_bytes);
    drop(state);
    Ok(CapturePermit { bytes })
}

async fn acquire_async(max_per_stream: usize) -> Result<CapturePermit, String> {
    struct QueueGuard {
        queued: bool,
    }
    impl Drop for QueueGuard {
        fn drop(&mut self) {
            if !self.queued {
                return;
            }
            let (lock, condvar) = admission();
            let mut state = lock.lock().unwrap();
            state.queued = state.queued.saturating_sub(1);
            drop(state);
            condvar.notify_one();
            async_wake().notify_one();
        }
    }

    let bytes = max_per_stream
        .checked_mul(2)
        .ok_or_else(|| "process capture byte reservation overflowed".to_string())?;
    if bytes > MAX_ACTIVE_CAPTURE_BYTES {
        REJECTED_CAPTURES.fetch_add(1, Ordering::Relaxed);
        return Err("process capture exceeds the global active-byte budget".into());
    }
    let started = Instant::now();
    let mut queue_guard = QueueGuard { queued: false };
    loop {
        let notified = async_wake().notified();
        {
            let (lock, _) = admission();
            let mut state = lock.lock().unwrap();
            if state.active < MAX_ACTIVE_CAPTURES
                && state.active_bytes.saturating_add(bytes) <= MAX_ACTIVE_CAPTURE_BYTES
            {
                if queue_guard.queued {
                    state.queued -= 1;
                    queue_guard.queued = false;
                    QUEUE_WAIT_MS_TOTAL
                        .fetch_add(started.elapsed().as_millis() as u64, Ordering::Relaxed);
                }
                state.active += 1;
                state.active_bytes += bytes;
                raise_high_water(&CAPTURE_HIGH_WATER, state.active);
                raise_high_water(&CAPTURE_BYTES_HIGH_WATER, state.active_bytes);
                return Ok(CapturePermit { bytes });
            }
            if !queue_guard.queued {
                if state.queued >= MAX_QUEUED_CAPTURES {
                    REJECTED_CAPTURES.fetch_add(1, Ordering::Relaxed);
                    return Err("process capture admission queue is full".into());
                }
                state.queued += 1;
                queue_guard.queued = true;
                raise_high_water(&QUEUE_HIGH_WATER, state.queued);
            }
        }
        notified.await;
    }
}

fn raise_high_water(target: &AtomicUsize, value: usize) {
    let mut seen = target.load(Ordering::Relaxed);
    while value > seen {
        match target.compare_exchange_weak(seen, value, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(actual) => seen = actual,
        }
    }
}

struct OwnershipGuard;

impl OwnershipGuard {
    fn acquire() -> Self {
        let children = ACTIVE_CHILDREN.fetch_add(1, Ordering::Relaxed) + 1;
        let pipes = ACTIVE_PIPES.fetch_add(2, Ordering::Relaxed) + 2;
        raise_high_water(&CHILD_HIGH_WATER, children);
        raise_high_water(&PIPE_HIGH_WATER, pipes);
        Self
    }
}

impl Drop for OwnershipGuard {
    fn drop(&mut self) {
        ACTIVE_PIPES.fetch_sub(2, Ordering::Relaxed);
        ACTIVE_CHILDREN.fetch_sub(1, Ordering::Relaxed);
    }
}

pub(crate) fn drain_capped<R: Read>(mut reader: R, max: usize) -> (Vec<u8>, bool) {
    let mut kept = Vec::with_capacity(max.min(8 * 1024));
    let mut buf = [0_u8; 16 * 1024];
    let mut truncated = false;
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => return (kept, truncated),
            Ok(read) => {
                let take = read.min(max.saturating_sub(kept.len()));
                kept.extend_from_slice(&buf[..take]);
                truncated |= take < read;
            }
        }
    }
}

pub(crate) fn wait_with_capped_output(
    mut child: Child,
    max_per_stream: usize,
    permit: CapturePermit,
) -> Result<CappedOutput, String> {
    let stdout = child.stdout.take().ok_or("child stdout was not piped")?;
    let stderr = child.stderr.take().ok_or("child stderr was not piped")?;
    let ownership = OwnershipGuard::acquire();
    let out_thread = std::thread::spawn(move || drain_capped(stdout, max_per_stream));
    let err_thread = std::thread::spawn(move || drain_capped(stderr, max_per_stream));
    let status = child.wait().map_err(|error| error.to_string());
    let (stdout, stdout_truncated) = out_thread.join().unwrap_or_default();
    let (stderr, stderr_truncated) = err_thread.join().unwrap_or_default();
    drop(ownership);
    let status = status?;

    COMPLETED_CHILDREN.fetch_add(1, Ordering::Relaxed);
    let retained_charge = stdout.len().saturating_add(stderr.len());
    let retained_now =
        RETAINED_BYTES_CURRENT.fetch_add(retained_charge, Ordering::Relaxed) + retained_charge;
    raise_high_water(&RETAINED_BYTES_HIGH_WATER, retained_now);
    RETAINED_BYTES_TOTAL.fetch_add(retained_charge as u64, Ordering::Relaxed);
    TRUNCATED_STREAMS.fetch_add(
        u64::from(stdout_truncated) + u64::from(stderr_truncated),
        Ordering::Relaxed,
    );
    Ok(CappedOutput {
        status,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
        max_per_stream,
        retained_charge,
        permit: Some(permit),
    })
}

pub(crate) fn output(cmd: &mut Command, max_per_stream: usize) -> Result<CappedOutput, String> {
    let nested = SYNC_CAPTURE_HELD.with(|held| {
        if held.get() {
            true
        } else {
            held.set(true);
            false
        }
    });
    if nested {
        REJECTED_CAPTURES.fetch_add(1, Ordering::Relaxed);
        return Err("nested process capture refused to avoid admission deadlock".into());
    }
    struct DepthGuard;
    impl Drop for DepthGuard {
        fn drop(&mut self) {
            SYNC_CAPTURE_HELD.with(|held| held.set(false));
        }
    }
    let _depth = DepthGuard;
    let permit = acquire(max_per_stream)?;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = cmd.spawn().map_err(|error| error.to_string())?;
    wait_with_capped_output(child, max_per_stream, permit)
}

async fn drain_async_capped<R: AsyncRead + Unpin>(mut reader: R, max: usize) -> (Vec<u8>, bool) {
    let mut kept = Vec::with_capacity(max.min(8 * 1024));
    let mut buf = [0_u8; 16 * 1024];
    let mut truncated = false;
    loop {
        match reader.read(&mut buf).await {
            Ok(0) | Err(_) => return (kept, truncated),
            Ok(read) => {
                let take = read.min(max.saturating_sub(kept.len()));
                kept.extend_from_slice(&buf[..take]);
                truncated |= take < read;
            }
        }
    }
}

pub(crate) async fn tokio_output(
    cmd: &mut tokio::process::Command,
    max_per_stream: usize,
) -> Result<CappedOutput, String> {
    let permit = acquire_async(max_per_stream).await?;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|error| error.to_string())?;
    let stdout = child.stdout.take().ok_or("child stdout was not piped")?;
    let stderr = child.stderr.take().ok_or("child stderr was not piped")?;
    let ownership = OwnershipGuard::acquire();
    let (status, (stdout, stdout_truncated), (stderr, stderr_truncated)) = tokio::join!(
        child.wait(),
        drain_async_capped(stdout, max_per_stream),
        drain_async_capped(stderr, max_per_stream),
    );
    drop(ownership);
    let status = status.map_err(|error| error.to_string())?;
    COMPLETED_CHILDREN.fetch_add(1, Ordering::Relaxed);
    let retained_charge = stdout.len().saturating_add(stderr.len());
    let retained_now =
        RETAINED_BYTES_CURRENT.fetch_add(retained_charge, Ordering::Relaxed) + retained_charge;
    raise_high_water(&RETAINED_BYTES_HIGH_WATER, retained_now);
    RETAINED_BYTES_TOTAL.fetch_add(retained_charge as u64, Ordering::Relaxed);
    TRUNCATED_STREAMS.fetch_add(
        u64::from(stdout_truncated) + u64::from(stderr_truncated),
        Ordering::Relaxed,
    );
    Ok(CappedOutput {
        status,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
        max_per_stream,
        retained_charge,
        permit: Some(permit),
    })
}

pub(crate) fn reject_truncated(out: &CappedOutput, label: &str) -> Result<(), String> {
    if out.stdout_truncated || out.stderr_truncated {
        Err(format!(
            "{label} output exceeded the {} MiB per-stream limit",
            out.max_per_stream / 1024 / 1024
        ))
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn process_capture_metrics() -> ProcessCaptureMetrics {
    let state = admission().0.lock().unwrap();
    ProcessCaptureMetrics {
        active_children: ACTIVE_CHILDREN.load(Ordering::Relaxed),
        active_pipes: ACTIVE_PIPES.load(Ordering::Relaxed),
        active_captures: state.active,
        queued_captures: state.queued,
        active_capture_bytes: state.active_bytes,
        capture_bytes_high_water: CAPTURE_BYTES_HIGH_WATER.load(Ordering::Relaxed),
        capture_high_water: CAPTURE_HIGH_WATER.load(Ordering::Relaxed),
        queue_high_water: QUEUE_HIGH_WATER.load(Ordering::Relaxed),
        rejected_captures: REJECTED_CAPTURES.load(Ordering::Relaxed),
        queue_wait_ms_total: QUEUE_WAIT_MS_TOTAL.load(Ordering::Relaxed),
        child_high_water: CHILD_HIGH_WATER.load(Ordering::Relaxed),
        pipe_high_water: PIPE_HIGH_WATER.load(Ordering::Relaxed),
        completed_children: COMPLETED_CHILDREN.load(Ordering::Relaxed),
        retained_bytes_current: RETAINED_BYTES_CURRENT.load(Ordering::Relaxed),
        retained_bytes_high_water: RETAINED_BYTES_HIGH_WATER.load(Ordering::Relaxed),
        retained_bytes_total: RETAINED_BYTES_TOTAL.load(Ordering::Relaxed),
        truncated_streams: TRUNCATED_STREAMS.load(Ordering::Relaxed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn drains_both_streams_and_releases_owned_handles_after_truncation() {
        let before = process_capture_metrics();
        let mut command = Command::new("sh");
        command.args([
            "-c",
            "head -c 200000 /dev/zero; head -c 200000 /dev/zero >&2",
        ]);
        let out = output(&mut command, 8 * 1024).unwrap();
        assert_eq!(out.stdout.len(), 8 * 1024);
        assert_eq!(out.stderr.len(), 8 * 1024);
        assert!(out.stdout_truncated && out.stderr_truncated);
        let after = process_capture_metrics();
        assert_eq!(after.active_pipes, after.active_children * 2);
        assert!(after.active_children <= MAX_ACTIVE_CAPTURES);
        assert!(after.completed_children > before.completed_children);
        assert!(after.truncated_streams >= before.truncated_streams + 2);
        assert!(after.child_high_water >= 1);
        assert!(after.pipe_high_water >= 2);
    }

    #[cfg(unix)]
    #[test]
    fn admits_only_four_children_before_spawn_and_releases_the_queue() {
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(9));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let mut command = Command::new("sh");
                    command.args(["-c", "sleep 0.05; printf x"]);
                    let output = output(&mut command, 1024).unwrap();
                    assert_eq!(output.stdout.as_slice(), b"x");
                })
            })
            .collect();
        barrier.wait();
        for thread in threads {
            thread.join().unwrap();
        }
        let metrics = process_capture_metrics();
        assert!(metrics.active_captures <= MAX_ACTIVE_CAPTURES);
        assert!(metrics.queued_captures <= MAX_QUEUED_CAPTURES);
        assert!(metrics.capture_high_water <= MAX_ACTIVE_CAPTURES);
        assert!(metrics.capture_bytes_high_water <= MAX_ACTIVE_CAPTURE_BYTES);
        assert!(metrics.queue_high_water >= 1);
    }

    #[test]
    fn production_modules_do_not_reintroduce_command_output_capture() {
        fn inspect(dir: &std::path::Path) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    inspect(&path);
                    continue;
                }
                if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                    continue;
                }
                let source = std::fs::read_to_string(&path).unwrap();
                // Tests may use Command::output to construct fixtures; runtime
                // code before the first test module must use this bounded owner.
                let production = source.split("#[cfg(test)]").next().unwrap_or(&source);
                assert!(
                    !production.contains(".output()") && !production.contains("wait_with_output()"),
                    "unbounded subprocess capture in {}",
                    path.display()
                );
            }
        }

        inspect(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src")
                .as_path(),
        );
    }
}
