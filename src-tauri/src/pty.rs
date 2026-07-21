//! PTY management: spawn, stream, resize, kill.
//!
//! Design:
//! - One reader thread per session does blocking reads from the PTY master into a
//!   shared `pending` buffer.
//! - One flusher thread per session drains `pending` every FLUSH_INTERVAL (coalescing
//!   many small reads into one IPC message) and sends raw bytes over a `Channel`.
//! - Backpressure: `outstanding` counts bytes sent to the WebView but not yet acked
//!   (the frontend acks after xterm.js consumes a chunk). When pending + outstanding
//!   exceeds `high_water`, the reader stops reading — the kernel PTY buffer fills and
//!   the child blocks on write. Memory stays bounded; nothing is dropped.
//! - Teardown: kill the child's whole process group, reader hits EOF, flusher drains,
//!   reaps the child, removes the session, emits `pty:exit`. No zombies, no leaks.

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

const FLUSH_INTERVAL: Duration = Duration::from_millis(10);
const READ_BUF_SIZE: usize = 64 * 1024;
const DEFAULT_HIGH_WATER: usize = 2 * 1024 * 1024;
/// How long a terminal's process group gets to exit on SIGTERM before we force
/// it. Agent CLIs use this window to flush their conversation transcript and run
/// their stop hooks — the difference between a session you can resume later and
/// one whose history never existed. Long enough for that, short enough that
/// quitting the app never feels stuck.
const GRACE: Duration = Duration::from_millis(2500);

/// A tag unique to this app launch, stamped onto every terminal it spawns
/// (env `CANOPY_INSTANCE`) and recorded in each session digest. Pid distinguishes
/// concurrent instances; the launch timestamp distinguishes a restart that reuses
/// a pid. Used to pair a session digest with the terminal it actually belongs to,
/// since the pty id alone is not unique across instances or restarts.
pub fn instance_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| {
        let pid = std::process::id();
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!("{pid:x}-{ms:x}")
    })
}

/// This launch's instance tag, for the frontend to match against digests.
#[tauri::command]
pub fn instance_id() -> String {
    instance_token().to_string()
}

pub struct Session {
    pub id: u32,
    pub pid: Option<u32>,
    pub title: Mutex<String>,
    pub cwd: String,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    shutdown: AtomicBool,
    eof: AtomicBool,
    pending: Mutex<Vec<u8>>,
    outstanding: AtomicUsize,
    high_water: usize,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<u32, Arc<Session>>>>,
    next_id: AtomicU32,
}

#[derive(Serialize, Clone)]
pub struct PtyExit {
    pub id: u32,
    pub exit_code: Option<u32>,
}

#[derive(Serialize, Clone)]
pub struct SpawnResult {
    pub id: u32,
    pub pid: Option<u32>,
    /// The size the pty was actually opened at — see PtyGeometry.
    pub cols: u16,
    pub rows: u16,
}

/// The size a pty agreed to, which is not always the size that was asked for.
///
/// The pty is the authority here, not the webview. The shell lays out its line
/// against the winsize we set via TIOCSWINSZ, so a terminal rendering at a width
/// the pty never agreed to wraps every redraw against the wrong column and
/// smears the line. Callers set their grid from what the pty confirms.
#[derive(Serialize, Clone)]
pub struct PtyGeometry {
    pub cols: u16,
    pub rows: u16,
}

impl PtyManager {
    pub fn sessions(&self) -> Arc<Mutex<HashMap<u32, Arc<Session>>>> {
        self.sessions.clone()
    }

    /// Stop every session; called on app exit so no child processes outlive us.
    ///
    /// Signals them all first and *then* waits once, rather than terminating them
    /// one at a time: the grace period is for agents to flush their transcripts,
    /// and serialising it would cost GRACE per terminal on every quit.
    pub fn kill_all(&self) {
        let sessions: Vec<Arc<Session>> = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect();
        for s in &sessions {
            s.request_stop();
        }
        let deadline = std::time::Instant::now() + GRACE;
        while std::time::Instant::now() < deadline {
            if sessions.iter().all(|s| !s.alive()) {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        for s in &sessions {
            s.force();
        }
    }
}

impl Session {
    /// Ask the process group to exit, and force it only if it refuses.
    ///
    /// This used to send SIGKILL outright. SIGKILL is uncatchable, so agent CLIs
    /// never got to shut down: Claude Code writes its conversation transcript and
    /// runs its Stop hook on the way out, and killing it dead meant a session with
    /// real work in it left *no transcript at all* — `claude --resume` on it
    /// answers "No conversation found". Closing a tab silently destroyed the
    /// conversation inside it.
    fn terminate(&self) {
        self.request_stop();
        self.await_exit(GRACE);
        self.force();
    }

    /// SIGTERM the whole process group. The shell is the PTY's session leader, so
    /// the signal reaches grandchildren — the agent — as well.
    fn request_stop(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            unsafe {
                libc::killpg(pid as libc::pid_t, libc::SIGTERM);
            }
        }
    }

    /// Whether any process in the group is still alive. Signal 0 tests for
    /// existence without delivering anything.
    fn alive(&self) -> bool {
        #[cfg(unix)]
        {
            match self.pid {
                Some(pid) => unsafe { libc::killpg(pid as libc::pid_t, 0) == 0 },
                None => false,
            }
        }
        #[cfg(not(unix))]
        {
            false
        }
    }

    /// Poll for a clean exit for up to `grace`. Polling rather than waiting on the
    /// child keeps a wedged agent from hanging app shutdown.
    fn await_exit(&self, grace: Duration) {
        let deadline = std::time::Instant::now() + grace;
        while std::time::Instant::now() < deadline {
            if !self.alive() {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    /// Last resort, for a process group that ignored SIGTERM.
    fn force(&self) {
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            if self.alive() {
                unsafe {
                    libc::killpg(pid as libc::pid_t, libc::SIGKILL);
                }
            }
        }
        let _ = self.killer.lock().unwrap().kill();
    }
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyManager>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    high_water: Option<usize>,
    on_data: Channel<InvokeResponseBody>,
) -> Result<SpawnResult, String> {
    // Clamp for the same reason pty_resize does: a terminal spawned into a
    // hidden tab measures 0, and a zero-column pty is meaningless. 80x24 is the
    // conventional fallback, and the frontend corrects it the moment the tab is
    // shown and the resize round-trips.
    let cols = if cols == 0 { 80 } else { cols };
    let rows = if rows == 0 { 24 } else { rows };

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // Allocated before spawn so the child can carry its own session id in env.
    let id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;

    let shell = shell.unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(&shell);
    // Login shell so the user's PATH / prompt setup loads, matching a real terminal.
    #[cfg(unix)]
    cmd.args(["-l"]);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Agent CLI hooks inherit these and use them to (a) prove the event came
    // from a terminal we own and (b) name the tab it came from.
    cmd.env("CANOPY", "1");
    cmd.env("CANOPY_PTY", id.to_string());
    // Pty ids reset to 1 every app launch and every instance writes to the same
    // ~/.canopy/sessions, so the pty id alone can't tell one instance's "term
    // #5" from another's — which silently binds one agent's digest to another's
    // terminal in the panel. This tag makes the pairing unambiguous.
    cmd.env("CANOPY_INSTANCE", instance_token());
    let cwd = cwd
        .or_else(|| dirs_home())
        .unwrap_or_else(|| "/".to_string());
    cmd.cwd(&cwd);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let pid = child.process_id();
    let killer = child.clone_killer();

    let session = Arc::new(Session {
        id,
        pid,
        title: Mutex::new(shell.clone()),
        cwd,
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        killer: Mutex::new(killer),
        child: Mutex::new(Some(child)),
        shutdown: AtomicBool::new(false),
        eof: AtomicBool::new(false),
        pending: Mutex::new(Vec::new()),
        outstanding: AtomicUsize::new(0),
        high_water: high_water.unwrap_or(DEFAULT_HIGH_WATER),
    });

    state.sessions.lock().unwrap().insert(id, session.clone());

    // Reader thread: blocking reads -> pending buffer, with backpressure.
    {
        let session = session.clone();
        thread::Builder::new()
            .name(format!("pty-reader-{id}"))
            .spawn(move || {
                let mut buf = [0u8; READ_BUF_SIZE];
                loop {
                    if session.shutdown.load(Ordering::SeqCst) {
                        break;
                    }
                    // Backpressure: stop reading while the WebView is behind. The
                    // kernel PTY buffer fills and the child blocks — bounded memory.
                    loop {
                        let queued = session.pending.lock().unwrap().len()
                            + session.outstanding.load(Ordering::SeqCst);
                        if queued <= session.high_water
                            || session.shutdown.load(Ordering::SeqCst)
                        {
                            break;
                        }
                        thread::sleep(Duration::from_millis(5));
                    }
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            session.pending.lock().unwrap().extend_from_slice(&buf[..n]);
                        }
                    }
                }
                session.eof.store(true, Ordering::SeqCst);
            })
            .expect("spawn pty reader thread");
    }

    // Flusher thread: coalesce pending bytes into batched IPC messages; on EOF,
    // drain, reap the child, clean up the session, emit pty:exit.
    {
        let session = session.clone();
        let sessions = state.sessions.clone();
        thread::Builder::new()
            .name(format!("pty-flush-{id}"))
            .spawn(move || {
                loop {
                    thread::sleep(FLUSH_INTERVAL);
                    let chunk = {
                        let mut pending = session.pending.lock().unwrap();
                        if pending.is_empty() {
                            None
                        } else {
                            Some(std::mem::take(&mut *pending))
                        }
                    };
                    match chunk {
                        Some(data) => {
                            session.outstanding.fetch_add(data.len(), Ordering::SeqCst);
                            if on_data.send(InvokeResponseBody::Raw(data)).is_err() {
                                // WebView side is gone; stop streaming.
                                session.terminate();
                            }
                        }
                        None => {
                            if session.eof.load(Ordering::SeqCst)
                                || session.shutdown.load(Ordering::SeqCst)
                            {
                                break;
                            }
                        }
                    }
                }
                // Reap the child so it never lingers as a zombie.
                let exit_code = session
                    .child
                    .lock()
                    .unwrap()
                    .take()
                    .and_then(|mut c| c.wait().ok())
                    .map(|status| status.exit_code());
                sessions.lock().unwrap().remove(&session.id);
                let _ = app.emit("pty:exit", PtyExit {
                    id: session.id,
                    exit_code,
                });
            })
            .expect("spawn pty flusher thread");
    }

    Ok(SpawnResult { id, pid, cols, rows })
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyManager>, id: u32, data: String) -> Result<(), String> {
    let session = get_session(&state, id)?;
    let result = session
        .writer
        .lock()
        .unwrap()
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string());
    result
}

/// Frontend ack after xterm.js consumes a chunk — releases backpressure.
#[tauri::command]
pub fn pty_ack(state: State<'_, PtyManager>, id: u32, bytes: usize) -> Result<(), String> {
    if let Ok(session) = get_session(&state, id) {
        let mut current = session.outstanding.load(Ordering::SeqCst);
        loop {
            let next = current.saturating_sub(bytes);
            match session.outstanding.compare_exchange(
                current,
                next,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break,
                Err(actual) => current = actual,
            }
        }
    }
    Ok(())
}

#[tauri::command]
/// Resize the pty, and report the size it actually took.
///
/// Sizes are clamped, not rejected: a hidden or zero-width container proposes 0
/// (or a NaN that arrives as 0), and a zero-column pty is meaningless — the
/// shell divides by it to lay out a line. Clamping keeps a tab that is resized
/// while hidden from poisoning the winsize.
pub fn pty_resize(
    state: State<'_, PtyManager>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<PtyGeometry, String> {
    let (cols, rows) = (cols.max(1), rows.max(1));
    let session = get_session(&state, id)?;
    session
        .master
        .lock()
        .unwrap()
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(PtyGeometry { cols, rows })
}

/// Called by the frontend at boot: any session alive at that moment belongs to
/// a previous page (webview reloads destroy JS state without unmounting), so
/// reap them all. Prevents orphaned shells across dev reloads / Cmd+R.
#[tauri::command]
pub fn pty_kill_all(state: State<'_, PtyManager>) {
    state.kill_all();
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyManager>, id: u32) -> Result<(), String> {
    let session = get_session(&state, id)?;
    // Return at once and tear down on a detached thread. terminate() blocks for
    // up to GRACE (2.5s) waiting for the agent to flush its transcript before
    // the final SIGKILL — and this command runs on the main thread, so doing
    // that wait inline froze the whole UI on every tab close. The frontend
    // already drops the tab optimistically; the read loop still emits pty:exit
    // and reaps the session once the child actually exits. SIGTERM is delivered
    // synchronously inside terminate() before the grace poll, so the shell
    // starts shutting down immediately regardless of when this thread is
    // scheduled.
    thread::spawn(move || session.terminate());
    Ok(())
}

#[tauri::command]
pub fn pty_set_title(state: State<'_, PtyManager>, id: u32, title: String) -> Result<(), String> {
    let session = get_session(&state, id)?;
    *session.title.lock().unwrap() = title;
    Ok(())
}

fn get_session(state: &State<'_, PtyManager>, id: u32) -> Result<Arc<Session>, String> {
    state
        .sessions
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no pty session {id}"))
}

fn default_shell() -> String {
    #[cfg(unix)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
}

fn dirs_home() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
}
