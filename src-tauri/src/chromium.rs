//! The Chromium engine: a browser the user already has, driven over CDP.
//!
//! The other two engines are WebKit. The proxy engine (preview.rs) is an iframe
//! onto a loopback reverse proxy; the webview engine (browser.rs) is a real
//! child WKWebView. Neither speaks the Chrome DevTools Protocol, because WebKit
//! has none — Safari's inspector talks a private Apple protocol. That is fine
//! until you want the things only CDP gives you: a page's accessibility tree
//! computed by the browser rather than guessed at in-page, a frame stream that
//! can be shown somewhere other than this window, and the enormous ecosystem of
//! automation that assumes a DevTools endpoint exists.
//!
//! So this engine drives a Chromium-family browser the user already installed.
//! Deliberately not one we ship: bundling Chromium would mean redistributing it
//! (with the notice obligations that implies), signing it, keeping it patched,
//! and adding a few hundred megabytes to a download for a feature most users
//! will never turn on. Detect what is there, let the user point at something
//! else, and link out if there is nothing.
//!
//! Three rules the launch below is built around, none of them optional:
//!
//! 1. **Never the user's own profile.** Chrome refuses remote debugging on the
//!    default profile anyway, but the reason matters more than the mechanism: a
//!    CDP port is unauthenticated, and anything on the machine that finds it
//!    gets every cookie in that profile. Canopy launches with its own
//!    `--user-data-dir` and treats it as Canopy's, not the user's.
//! 2. **Ephemeral port, loopback only.** `--remote-debugging-port=0` and let the
//!    OS pick; the real port is read back from the browser's own stderr. A fixed
//!    port is a fixed target, and 9222 is the first thing anything scanning
//!    localhost tries.
//! 3. **The profile is separate, and the user is told.** Logging into a site in
//!    the WebKit browser does not log you in here. That is a real cliff and it
//!    belongs in the UI, not in a bug report.
//!
//! What this module does NOT do is re-derive the op vocabulary. browser.rs
//! reduced every browser control to one primitive — evaluate JavaScript, read
//! the value back — and the injected picker (preview_picker.js) implements the
//! rest in the page. `Runtime.evaluate` is exactly that primitive, so snapshot,
//! click, type, console and network all transfer without a line of new logic.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::oneshot;

/// How long a CDP round trip may take before it is treated as lost. Generous:
/// the far side is a whole browser process that may be starting up, and the
/// page's own op deadline is longer still.
const CALL_TIMEOUT: Duration = Duration::from_secs(15);
/// How long to wait for the browser to announce its DevTools endpoint. Cold
/// starts on a slow disk are the worst case here.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(30);

/// A Chromium-family browser found on this machine.
#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
pub struct Browser {
    /// What to call it in the UI — "Google Chrome", "Brave Browser".
    pub name: String,
    pub path: String,
}

/// Where each platform puts the browsers we know how to drive, most preferred
/// first. Kept as data rather than a probe loop so the ordering is reviewable
/// and the list is testable without a filesystem.
///
/// Chromium-family only. Firefox has a CDP shim but not enough of one, and
/// Safari has no CDP at all — offering either would be offering a broken engine.
#[cfg(target_os = "macos")]
fn candidates() -> Vec<(&'static str, &'static str)> {
    vec![
        (
            "Google Chrome",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ),
        (
            "Chromium",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ),
        (
            "Microsoft Edge",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ),
        (
            "Brave Browser",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ),
        ("Arc", "/Applications/Arc.app/Contents/MacOS/Arc"),
        (
            "Vivaldi",
            "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
        ),
    ]
}

#[cfg(target_os = "windows")]
fn candidates() -> Vec<(&'static str, &'static str)> {
    vec![
        (
            "Google Chrome",
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        ),
        (
            "Google Chrome",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ),
        (
            "Microsoft Edge",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        ),
        (
            "Microsoft Edge",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        ),
        (
            "Brave Browser",
            r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
        ),
    ]
}

#[cfg(all(unix, not(target_os = "macos")))]
fn candidates() -> Vec<(&'static str, &'static str)> {
    vec![
        ("Google Chrome", "/usr/bin/google-chrome"),
        ("Google Chrome", "/usr/bin/google-chrome-stable"),
        ("Chromium", "/usr/bin/chromium"),
        ("Chromium", "/usr/bin/chromium-browser"),
        ("Microsoft Edge", "/usr/bin/microsoft-edge"),
        ("Brave Browser", "/usr/bin/brave-browser"),
    ]
}

/// The installed browsers, in preference order, deduplicated by name so two
/// install layouts of the same browser present as one choice.
fn detect_with(exists: impl Fn(&Path) -> bool) -> Vec<Browser> {
    let mut out: Vec<Browser> = Vec::new();
    for (name, path) in candidates() {
        if !exists(Path::new(path)) {
            continue;
        }
        if out.iter().any(|b| b.name == name) {
            continue;
        }
        out.push(Browser {
            name: name.to_string(),
            path: path.to_string(),
        });
    }
    out
}

/// Chromium-family browsers installed on this machine, most preferred first.
#[tauri::command]
pub fn chromium_detect() -> Vec<Browser> {
    detect_with(|p| p.exists())
}

/// The DevTools WebSocket URL from a line of the browser's stderr.
///
/// Chrome prints exactly one line of the form
/// `DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<uuid>`
/// and it is the only way to learn the port when launching with `--port=0`.
/// Parsed rather than pattern-matched on the whole prefix because the text
/// before "ws://" has changed across versions and the URL has not.
fn parse_devtools_url(line: &str) -> Option<String> {
    let at = line.find("ws://")?;
    let url = line[at..].trim();
    // Chrome emits no trailing text, but a partially-flushed line can arrive
    // with the next log entry attached; stop at the first whitespace.
    let end = url.find(char::is_whitespace).unwrap_or(url.len());
    let url = &url[..end];
    if url.len() > "ws://".len() {
        Some(url.to_string())
    } else {
        None
    }
}

/// The flags Canopy launches a browser with.
///
/// `--user-data-dir` is the load-bearing one: it is what makes this Canopy's
/// browser profile rather than the user's, which is what makes exposing an
/// unauthenticated debugging port on it defensible at all. Everything else is
/// noise suppression — a browser driven by an agent should not be asking about
/// default-browser status or restoring the last crashed session.
/// `headless` is the default and is what makes this engine sit inside a tab
/// instead of beside it. A browser with a window is an OS window: it cannot be
/// composited into a pane (reparenting a foreign window needs private APIs that
/// would not survive notarisation), it takes focus, and it shows up in the dock.
/// Headless has no window to fight — the page arrives as frames, painted into
/// an ordinary <img>, which a dialog can cover like any other element.
///
/// The cost is that nobody can type into it. That is fine for the agent, which
/// drives through the injected picker rather than through real input, but it
/// means a site needing an interactive login has to be logged into headfully
/// first — which is why this is a parameter and not a constant.
fn launch_args(profile: &Path, url: &str, headless: bool) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "--remote-debugging-port=0".into(),
        // Explicit rather than relying on the default: this is a security
        // boundary and it should be readable as one.
        "--remote-debugging-address=127.0.0.1".into(),
        format!("--user-data-dir={}", profile.display()),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-session-crashed-bubble".into(),
        // A restored "Chrome didn't shut down correctly" tab set would be the
        // user's, not ours, and would race whatever we are about to open.
        "--hide-crash-restore-bubble".into(),
    ];
    if headless {
        // The modern headless mode, not the old shell: it is the same browser
        // with no window, so it keeps the profile, the extensions and the
        // rendering behaviour that `--headless=old` quietly changed.
        args.push("--headless=new".into());
    }
    args.push(url.to_string());
    args
}

// ---------- CDP transport ----------

type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<serde_json::Value>>>>;

/// One connection to a browser's DevTools endpoint.
///
/// CDP multiplexes every target (tab) over this single socket: commands carry a
/// `sessionId` and replies carry the `id` they answer. So one reader task owns
/// the socket, matches replies to waiting callers by id, and everything else
/// talks to it through `call`.
pub struct Cdp {
    out: tokio::sync::mpsc::UnboundedSender<String>,
    pending: Pending,
    next_id: AtomicI64,
}

/// A CDP event: everything the browser says that nobody asked for.
pub struct CdpEvent {
    pub method: String,
    pub session: String,
    pub params: serde_json::Value,
}

impl Cdp {
    /// Connect, and spawn the reader that fans replies back out.
    ///
    /// `events` receives anything without an `id`. Screencast frames arrive
    /// that way and there are a lot of them, so this is a channel rather than a
    /// callback: a slow consumer must not be able to stall the socket that
    /// every command also shares.
    pub async fn connect_with_events(
        ws_url: &str,
        events: tokio::sync::mpsc::UnboundedSender<CdpEvent>,
    ) -> Result<Arc<Self>, String> {
        Self::open(ws_url, Some(events)).await
    }

    async fn open(
        ws_url: &str,
        events: Option<tokio::sync::mpsc::UnboundedSender<CdpEvent>>,
    ) -> Result<Arc<Self>, String> {
        let (stream, _) = tokio_tungstenite::connect_async(ws_url)
            .await
            .map_err(|e| format!("could not reach the browser's DevTools endpoint: {e}"))?;
        let (mut sink, mut source) = stream.split();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));

        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if sink
                    .send(tokio_tungstenite::tungstenite::Message::Text(msg))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });

        let waiting = pending.clone();
        tokio::spawn(async move {
            while let Some(Ok(msg)) = source.next().await {
                let tokio_tungstenite::tungstenite::Message::Text(text) = msg else {
                    continue;
                };
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
                    continue;
                };
                // A message with an `id` answers a call; anything else is an
                // event, which nothing waits on synchronously.
                let Some(id) = v.get("id").and_then(|i| i.as_i64()) else {
                    if let (Some(sink), Some(method)) =
                        (events.as_ref(), v.get("method").and_then(|m| m.as_str()))
                    {
                        let _ = sink.send(CdpEvent {
                            method: method.to_string(),
                            session: v
                                .get("sessionId")
                                .and_then(|s| s.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            params: v.get("params").cloned().unwrap_or(serde_json::Value::Null),
                        });
                    }
                    continue;
                };
                if let Some(tx) = waiting.lock().unwrap().remove(&id) {
                    let _ = tx.send(v);
                }
            }
            // The socket died: fail every waiter rather than leaving them to
            // time out one by one.
            waiting.lock().unwrap().clear();
        });

        Ok(Arc::new(Self {
            out: tx,
            pending,
            next_id: AtomicI64::new(1),
        }))
    }

    /// Issue a CDP command and wait for its reply. `session` is None for
    /// browser-level commands and Some for anything aimed at one page.
    pub async fn call(
        &self,
        method: &str,
        params: serde_json::Value,
        session: Option<&str>,
    ) -> Result<serde_json::Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut msg = serde_json::json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            msg["sessionId"] = serde_json::Value::String(s.to_string());
        }
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.out
            .send(msg.to_string())
            .map_err(|_| "the browser connection is closed".to_string())?;
        let reply = tokio::time::timeout(CALL_TIMEOUT, rx)
            .await
            .map_err(|_| format!("{method} timed out"))?
            .map_err(|_| "the browser closed while it was answering".to_string())?;
        // CDP reports failure in-band rather than by transport error.
        if let Some(err) = reply.get("error") {
            let text = err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown CDP error");
            return Err(format!("{method}: {text}"));
        }
        Ok(reply
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    }
}

/// Pull the value out of a `Runtime.evaluate` reply.
///
/// Three shapes matter and only one is success. An `exceptionDetails` means the
/// page threw and the text of that throw is the most useful thing we have. A
/// result with no `value` is `undefined` — which for every caller here means
/// "the picker isn't there yet", not an error, so it becomes null exactly as
/// the webview engine's eval_json does.
fn evaluate_value(reply: &serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(ex) = reply.get("exceptionDetails") {
        let text = ex
            .get("exception")
            .and_then(|e| e.get("description"))
            .and_then(|d| d.as_str())
            .or_else(|| ex.get("text").and_then(|t| t.as_str()))
            .unwrap_or("the page threw");
        return Err(text.to_string());
    }
    Ok(reply
        .get("result")
        .and_then(|r| r.get("value"))
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

// ---------- the engine ----------

/// One browser process and the tabs Canopy has opened in it.
#[derive(Default)]
pub struct ChromiumManager {
    inner: tokio::sync::Mutex<Option<Running>>,
    /// tab id -> the CDP session driving that tab's target.
    sessions: Mutex<HashMap<String, Session>>,
    /// tab id -> the cast that should be running there. This exists because a
    /// started cast is not a delivering cast: a cast attached in the same
    /// breath as a navigation dies with the swapped-out renderer, silently —
    /// Chrome answers OK and then sends nothing, ever. The watchdog and the
    /// navigation hook below restart from this record.
    casts: Mutex<HashMap<String, CastState>>,
}

struct CastState {
    width: u32,
    height: u32,
    /// Bumped on every (re)start, so a stale watchdog can tell its cast was
    /// already superseded and stand down.
    epoch: u64,
    /// Whether this cast has delivered at least one frame.
    fed: bool,
    /// Consecutive restarts that never produced a frame. Bounded, so a pane
    /// that genuinely cannot cast doesn't restart forever.
    barren: u32,
}

struct Running {
    /// Kept so the browser can be killed on shutdown. A browser Canopy started
    /// is Canopy's to stop; leaving it behind would strand the profile lock and
    /// the next launch would silently attach to a browser nobody can see.
    child: tokio::process::Child,
    cdp: Arc<Cdp>,
}

#[derive(Clone)]
struct Session {
    id: String,
    target: String,
}

/// Where Canopy keeps the browser profile. Inside the app's own data dir, so it
/// is removed with the app and is obviously not the user's own Chrome profile.
fn profile_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?;
    let dir = base.join("chromium-profile");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create the browser profile: {e}"))?;
    Ok(dir)
}

/// Read the browser's stderr until it announces its DevTools endpoint.
///
/// This is the only way to learn the port after asking for `--port=0`, and the
/// wait is bounded: a browser that never announces is a browser that failed to
/// start, and the lines it did print are the best diagnosis available.
async fn await_devtools_url(
    stderr: tokio::process::ChildStderr,
) -> Result<(String, tokio::process::ChildStderr), String> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut reader = BufReader::new(stderr);
    let mut seen = String::new();
    let found = tokio::time::timeout(LAUNCH_TIMEOUT, async {
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line).await {
                Ok(0) => return Err("the browser exited before it was ready".to_string()),
                Ok(_) => {
                    if let Some(url) = parse_devtools_url(&line) {
                        return Ok(url);
                    }
                    if seen.len() < 2000 {
                        seen.push_str(&line);
                    }
                }
                Err(e) => return Err(format!("could not read the browser's output: {e}")),
            }
        }
    })
    .await
    .map_err(|_| format!("the browser never reported a DevTools endpoint. It said:\n{seen}"))??;
    Ok((found, reader.into_inner()))
}

/// Clear a stale singleton lock left by a browser a previous Canopy failed to
/// stop — a dev run killed with ^C, a crash, a force-quit. That orphan keeps
/// the profile locked, and Chrome's singleton behaviour turns every new launch
/// into a silent hand-off-and-exit: "the browser exited before it was ready",
/// forever, until someone finds and kills the orphan by hand. Observed live,
/// twice in one afternoon.
///
/// The profile dir is Canopy's own (see `profile_dir`), so whatever holds its
/// lock is Canopy's to kill by construction — but the pid in a long-dead lock
/// may have been reused by anything, so it is killed only after its command
/// line proves it is a browser on this very profile.
///
/// Returns whether there was anything to clear, i.e. whether a relaunch is
/// worth attempting. On Windows Chrome keeps no `SingletonLock` symlink and
/// this is a no-op; the launch error stands.
fn clear_stale_profile_lock(profile: &Path) -> bool {
    let Ok(target) = std::fs::read_link(profile.join("SingletonLock")) else {
        return false;
    };
    // The symlink's target is "<hostname>-<pid>", nothing more.
    if let Some(pid) = target
        .to_string_lossy()
        .rsplit('-')
        .next()
        .and_then(|p| p.parse::<u32>().ok())
    {
        let holder = std::process::Command::new("ps")
            .args(["-o", "command=", "-p", &pid.to_string()])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default();
        if holder.contains(&profile.display().to_string()) {
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .status();
        }
    }
    for name in ["SingletonLock", "SingletonSocket", "SingletonCookie"] {
        let _ = std::fs::remove_file(profile.join(name));
    }
    true
}

impl ChromiumManager {
    /// Spawn the browser and wait for it to announce its DevTools endpoint.
    async fn launch(
        exe: &str,
        profile: &Path,
        headless: bool,
    ) -> Result<(tokio::process::Child, String, tokio::process::ChildStderr), String> {
        let mut child = tokio::process::Command::new(exe)
            .args(launch_args(profile, "about:blank", headless))
            .stderr(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("could not start {exe}: {e}"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "the browser gave no stderr to read".to_string())?;
        match await_devtools_url(stderr).await {
            Ok((url, rest)) => Ok((child, url, rest)),
            Err(e) => {
                let _ = child.kill().await;
                Err(e)
            }
        }
    }

    /// The live connection, launching the browser on first use.
    ///
    /// One browser process serves every tab: a second process would mean a
    /// second profile lock on the same `--user-data-dir`, which Chrome refuses.
    async fn cdp(
        &self,
        app: &tauri::AppHandle,
        exe: &str,
        headless: bool,
    ) -> Result<Arc<Cdp>, String> {
        let mut slot = self.inner.lock().await;
        if let Some(running) = slot.as_mut() {
            // A browser the user quit leaves a socket that answers nothing.
            if matches!(running.child.try_wait(), Ok(None)) {
                return Ok(running.cdp.clone());
            }
            *slot = None;
        }
        let profile = profile_dir(app)?;
        let (child, url, rest) = match Self::launch(exe, &profile, headless).await {
            Ok(v) => v,
            // An exit-before-ready is what a locked profile looks like; clear
            // the orphan holding it and try once more before giving up.
            Err(first) => {
                if !clear_stale_profile_lock(&profile) {
                    return Err(first);
                }
                Self::launch(exe, &profile, headless).await?
            }
        };
        // Keep draining stderr. A pipe nobody reads fills, and a browser whose
        // stderr has filled stops making progress — a hang with no symptom.
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(rest).lines();
            while let Ok(Some(_)) = lines.next_line().await {}
        });
        let (etx, erx) = tokio::sync::mpsc::unbounded_channel();
        let cdp = Cdp::connect_with_events(&url, etx).await?;
        pump_frames(app.clone(), erx);
        *slot = Some(Running {
            child,
            cdp: cdp.clone(),
        });
        Ok(cdp)
    }

    /// Which tab a CDP session belongs to. Frames identify themselves by
    /// session, and the frontend addresses everything by tab.
    fn tab_for_session(&self, session: &str) -> Option<String> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .find(|(_, s)| s.id == session)
            .map(|(tab, _)| tab.clone())
    }

    /// Start streaming this tab's pixels at the pane's size.
    ///
    /// Re-called on resize: Chrome scales frames to the max box given, so a
    /// stale size means a blurry or letterboxed pane rather than a broken one.
    pub async fn start_cast(
        &self,
        app: &tauri::AppHandle,
        tab_id: &str,
        width: u32,
        height: u32,
    ) -> Result<(), String> {
        let cdp = self.live().await?;
        let s = self.session(tab_id)?;
        // Headless Chrome only casts the ACTIVE page, and a target made by
        // Target.createTarget is a background tab — without this activation,
        // Page.startScreencast answers "Not attached to an active page" every
        // single time and the pane never shows a frame. Re-done on every start
        // rather than once at open: starting another pane's cast moved
        // activation there, and this pane has to take it back.
        let params = serde_json::json!({
            "format": "jpeg",
            "quality": SCREENCAST_QUALITY,
            "maxWidth": width.max(1),
            "maxHeight": height.max(1),
        });
        let mut last = String::new();
        for attempt in 0..3 {
            if attempt > 0 {
                // Activation races the renderer swap of an in-flight
                // navigation (observed live: the same sequence fails or
                // succeeds depending on whether the swap has settled), so a
                // failed start is retried against a fresh activation rather
                // than reported.
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            }
            let _ = cdp
                .call(
                    "Target.activateTarget",
                    serde_json::json!({ "targetId": s.target }),
                    None,
                )
                .await;
            match cdp
                .call("Page.startScreencast", params.clone(), Some(&s.id))
                .await
            {
                Ok(_) => {
                    log::info!(
                        target: "chromium",
                        "cast started for {tab_id} at {width}x{height} (attempt {})",
                        attempt + 1
                    );
                    let epoch = {
                        let mut casts = self.casts.lock().unwrap();
                        let c = casts.entry(tab_id.to_string()).or_insert(CastState {
                            width,
                            height,
                            epoch: 0,
                            fed: false,
                            barren: 0,
                        });
                        c.width = width;
                        c.height = height;
                        c.epoch += 1;
                        c.fed = false;
                        c.epoch
                    };
                    arm_cast_watchdog(app, tab_id.to_string(), epoch);
                    return Ok(());
                }
                Err(e) => last = e,
            }
        }
        log::warn!(target: "chromium", "cast failed for {tab_id}: {last}");
        Err(last)
    }

    /// Stop streaming — the tab went to the background, or the pane is covered.
    /// Frames for a pane nobody can see are pure cost.
    pub async fn stop_cast(&self, tab_id: &str) -> Result<(), String> {
        self.casts.lock().unwrap().remove(tab_id);
        let cdp = self.live().await?;
        let s = self.session(tab_id)?;
        cdp.call("Page.stopScreencast", serde_json::json!({}), Some(&s.id))
            .await
            .map(|_| ())
    }

    /// A real picture of the page, as base64 PNG — the same shape
    /// browser_snapshot and webview_snapshot answer with, because the callers
    /// (pageCapture, the agent bridge) are shared across engines.
    ///
    /// Not the cast stream: that is lossy JPEG already scaled down to whatever
    /// the pane happens to be, and a screenshot of it would be a screenshot of
    /// a screenshot. This asks the browser to render the page again at full
    /// size, losslessly.
    ///
    /// It is also better than either WebKit engine can manage, in a way that
    /// removes a real limitation rather than matching one: a headless browser
    /// renders whether or not its tab is in front, so there is no "bring the
    /// preview forward first" — a background tab photographs perfectly.
    ///
    /// `clip` is page CSS pixels, for a region capture.
    pub async fn capture(
        &self,
        tab_id: &str,
        clip: Option<(f64, f64, f64, f64)>,
    ) -> Result<String, String> {
        let cdp = self.live().await?;
        let s = self.session(tab_id)?;
        let mut params = serde_json::json!({
            "format": "png",
            // Past the viewport too. The pane shows one screen; a bug report
            // usually wants the part that had to be scrolled to.
            "captureBeyondViewport": clip.is_some(),
        });
        if let Some((x, y, width, height)) = clip {
            params["clip"] = serde_json::json!({
                "x": x, "y": y, "width": width, "height": height, "scale": 1,
            });
        }
        let out = cdp
            .call("Page.captureScreenshot", params, Some(&s.id))
            .await?;
        out.get("data")
            .and_then(|d| d.as_str())
            .map(|d| d.to_string())
            .ok_or_else(|| "the browser returned no image".to_string())
    }

    /// The page's own dimensions, so the pane can map a click in the picture
    /// back to a point in the page. Without this the mapping would have to
    /// guess, and every annotation would land near-but-not-on its target.
    pub async fn metrics(&self, tab_id: &str) -> Result<serde_json::Value, String> {
        self.eval_json(
            tab_id,
            "JSON.stringify({w:innerWidth,h:innerHeight})".into(),
        )
        .await
        .and_then(|v| {
            let text = v.as_str().unwrap_or("{}");
            serde_json::from_str(text).map_err(|e| format!("bad page metrics: {e}"))
        })
    }

    fn session(&self, tab_id: &str) -> Result<Session, String> {
        self.sessions
            .lock()
            .unwrap()
            .get(tab_id)
            .cloned()
            .ok_or_else(|| format!("no Chromium browser is open for tab {tab_id}"))
    }

    /// Open a tab: create a target, attach to it, and arm the picker so it is
    /// present on every document this target ever loads — including ones the
    /// page navigates to itself, which is why this is addScriptToEvaluateOn*New*
    /// Document rather than a one-off evaluate.
    pub async fn open(
        &self,
        app: &tauri::AppHandle,
        exe: &str,
        tab_id: &str,
        url: &str,
        headless: bool,
    ) -> Result<(), String> {
        let cdp = self.cdp(app, exe, headless).await?;
        let target = cdp
            .call(
                "Target.createTarget",
                serde_json::json!({ "url": "about:blank" }),
                None,
            )
            .await?
            .get("targetId")
            .and_then(|t| t.as_str())
            .ok_or_else(|| "the browser opened no tab".to_string())?
            .to_string();
        // flatten:true puts this session on the same socket instead of handing
        // back a second endpoint to dial.
        let session = cdp
            .call(
                "Target.attachToTarget",
                serde_json::json!({ "targetId": target, "flatten": true }),
                None,
            )
            .await?
            .get("sessionId")
            .and_then(|s| s.as_str())
            .ok_or_else(|| "the browser refused to attach to its own tab".to_string())?
            .to_string();
        cdp.call("Page.enable", serde_json::json!({}), Some(&session))
            .await?;
        cdp.call("Runtime.enable", serde_json::json!({}), Some(&session))
            .await?;
        cdp.call(
            "Page.addScriptToEvaluateOnNewDocument",
            serde_json::json!({ "source": picker_source() }),
            Some(&session),
        )
        .await?;
        self.sessions.lock().unwrap().insert(
            tab_id.to_string(),
            Session {
                id: session.clone(),
                target,
            },
        );
        log::info!(target: "chromium", "tab {tab_id}: opened, navigating to {url}");
        self.navigate(tab_id, url).await
    }

    pub async fn navigate(&self, tab_id: &str, url: &str) -> Result<(), String> {
        let cdp = self.live().await?;
        let s = self.session(tab_id)?;
        cdp.call(
            "Page.navigate",
            serde_json::json!({ "url": url }),
            Some(&s.id),
        )
        .await
        .map(|_| ())
    }

    /// Evaluate in the page and hand back the value, JSON decoded.
    ///
    /// The same contract as browser.rs's eval_json, deliberately: everything
    /// built on that — run_op, cmd, drain, here — works against either engine
    /// without knowing which one it is talking to.
    pub async fn eval_json(&self, tab_id: &str, code: String) -> Result<serde_json::Value, String> {
        let cdp = self.live().await?;
        let s = self.session(tab_id)?;
        let reply = cdp
            .call(
                "Runtime.evaluate",
                serde_json::json!({
                    "expression": code,
                    // Without this a returned object comes back as a remote
                    // handle to be fetched separately; the picker always
                    // answers with plain JSON, so ask for it by value.
                    "returnByValue": true,
                    "awaitPromise": true,
                }),
                Some(&s.id),
            )
            .await?;
        evaluate_value(&reply)
    }

    pub async fn close(&self, tab_id: &str) -> Result<(), String> {
        self.casts.lock().unwrap().remove(tab_id);
        let Some(s) = self.sessions.lock().unwrap().remove(tab_id) else {
            return Ok(()); // closing a tab that was never open is not an error
        };
        let cdp = self.live().await?;
        cdp.call(
            "Target.closeTarget",
            serde_json::json!({ "targetId": s.target }),
            None,
        )
        .await
        .map(|_| ())
    }

    async fn live(&self) -> Result<Arc<Cdp>, String> {
        self.inner
            .lock()
            .await
            .as_ref()
            .map(|r| r.cdp.clone())
            .ok_or_else(|| "no Chromium browser is running".to_string())
    }

    /// Stop the browser Canopy started. Called on app exit.
    pub async fn shutdown(&self) {
        self.sessions.lock().unwrap().clear();
        if let Some(mut running) = self.inner.lock().await.take() {
            let _ = running.child.kill().await;
        }
    }
}

// ---------- screencast ----------
//
// A browser Canopy did not create is its own OS window, and there is no way to
// composite that into a pane — reparenting a foreign window needs private APIs
// and would not survive notarisation. So the page is streamed instead:
// Page.startScreencast pushes JPEG frames, they go to the frontend as data URLs
// and are painted into the pane, and input is sent back over Input.*.
//
// This is how every cloud-browser live view works, and it buys something the
// child-webview engine can never have: the frames are just bytes, so the same
// pane works over Canopy Remote, where a native view composited over this
// window is meaningless.

/// Frames are acked one at a time; Chrome will not send the next until the
/// previous is acknowledged, which is the backpressure. Quality is a deliberate
/// trade — this is a live view of a page being driven, not a screenshot, and
/// screenshots have their own path (snapshot.rs) that is not lossy.
const SCREENCAST_QUALITY: i64 = 60;

/// How long a freshly started cast gets to deliver its first frame before it
/// is declared dead and restarted. Observed live: a healthy cast's first frame
/// lands within ~200 ms; one attached to a renderer the navigation swapped out
/// never delivers at all.
const FIRST_FRAME_DEADLINE: std::time::Duration = std::time::Duration::from_millis(1500);

/// How many barren restarts before giving up. A pane that truly cannot cast
/// (engine tearing down, tab closing) should not restart forever.
const MAX_BARREN_RESTARTS: u32 = 4;

/// Check, after a grace period, that the cast actually fed the pane — and
/// restart it if not. "Started" is Chrome's word, not a delivery guarantee:
/// the POC for this pipeline watched casts report OK and then send nothing
/// because the page's renderer was swapped out from under them.
fn arm_cast_watchdog(app: &tauri::AppHandle, tab_id: String, epoch: u64) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        tokio::time::sleep(FIRST_FRAME_DEADLINE).await;
        let mgr = app.state::<ChromiumManager>();
        let restart = {
            let mut casts = mgr.casts.lock().unwrap();
            match casts.get_mut(&tab_id) {
                // Same cast, still starving: restart unless it has proven
                // barren too many times already.
                Some(c) if c.epoch == epoch && !c.fed => {
                    c.barren += 1;
                    (c.barren <= MAX_BARREN_RESTARTS).then_some((c.width, c.height, c.barren))
                }
                // Fed, superseded, or stopped: this watchdog's job is done.
                _ => None,
            }
        };
        if let Some((w, h, n)) = restart {
            log::warn!(
                target: "chromium",
                "cast for {tab_id} delivered no frame in {FIRST_FRAME_DEADLINE:?} — restarting ({n}/{MAX_BARREN_RESTARTS})"
            );
            let _ = mgr.start_cast(&app, &tab_id, w, h).await;
        }
    });
}

/// Turn the frame stream on for a tab, and pump frames to the frontend.
fn pump_frames(app: tauri::AppHandle, mut rx: tokio::sync::mpsc::UnboundedReceiver<CdpEvent>) {
    tauri::async_runtime::spawn(async move {
        use tauri::{Emitter, Manager};
        let mut seen_frames = std::collections::HashSet::new();
        while let Some(ev) = rx.recv().await {
            match ev.method.as_str() {
                "Page.screencastFrame" => {
                    let Some(data) = ev.params.get("data").and_then(|d| d.as_str()) else {
                        continue;
                    };
                    let session_id = ev
                        .params
                        .get("sessionId")
                        .and_then(|s| s.as_i64())
                        .unwrap_or_default();
                    let mgr = app.state::<ChromiumManager>();
                    let tab = mgr.tab_for_session(&ev.session);
                    // Ack first, then deliver: a frame we fail to deliver must
                    // still not stall the stream, and Chrome sends nothing more
                    // until the ack lands.
                    if let Ok(cdp) = mgr.live().await {
                        let _ = cdp
                            .call(
                                "Page.screencastFrameAck",
                                serde_json::json!({ "sessionId": session_id }),
                                Some(&ev.session),
                            )
                            .await;
                    }
                    if let Some(tab_id) = tab {
                        if seen_frames.insert(ev.session.clone()) {
                            log::info!(target: "chromium", "first frame for tab {tab_id}");
                        }
                        if let Some(c) = mgr.casts.lock().unwrap().get_mut(&tab_id) {
                            c.fed = true;
                            c.barren = 0;
                        }
                        let _ = app.emit(
                            "chromium:frame",
                            serde_json::json!({
                                "tabId": tab_id,
                                "frame": format!("data:image/jpeg;base64,{data}"),
                            }),
                        );
                    } else {
                        log::warn!(target: "chromium", "frame for unknown session {}", ev.session);
                    }
                }
                // The page moved: the URL bar and the history buttons are the
                // frontend's, and it cannot see a navigation it did not cause.
                // Top frame only — an iframe navigating is not the page moving.
                "Page.frameNavigated" => {
                    let Some(frame) = ev.params.get("frame") else {
                        continue;
                    };
                    if frame.get("parentId").is_some() {
                        continue;
                    }
                    let url = frame
                        .get("url")
                        .and_then(|u| u.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let mgr = app.state::<ChromiumManager>();
                    if let Some(tab_id) = mgr.tab_for_session(&ev.session) {
                        let _ = app.emit(
                            "chromium:nav",
                            serde_json::json!({ "tabId": tab_id, "url": url }),
                        );
                        // A cross-process navigation kills a running cast
                        // without a word; restart it on the new document.
                        let restart = mgr
                            .casts
                            .lock()
                            .unwrap()
                            .get(&tab_id)
                            .map(|c| (c.width, c.height));
                        if let Some((w, h)) = restart {
                            let app = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let mgr = app.state::<ChromiumManager>();
                                let _ = mgr.start_cast(&app, &tab_id, w, h).await;
                            });
                        }
                    }
                }
                _ => {}
            }
        }
    });
}

// ---------- commands ----------
//
// Deliberately the same shapes as browser.rs's, so the frontend's browser host
// can pick an engine per call rather than branching through every code path.

#[tauri::command]
pub async fn chromium_open(
    app: tauri::AppHandle,
    exe: String,
    tab_id: String,
    url: String,
    headless: Option<bool>,
) -> Result<(), String> {
    use tauri::Manager;
    let mgr = app.state::<ChromiumManager>();
    mgr.open(&app, &exe, &tab_id, &url, headless.unwrap_or(true))
        .await
}

#[tauri::command]
pub async fn chromium_navigate(
    app: tauri::AppHandle,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    use tauri::Manager;
    app.state::<ChromiumManager>().navigate(&tab_id, &url).await
}

#[tauri::command]
pub async fn chromium_run_op(
    app: tauri::AppHandle,
    tab_id: String,
    op: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let code = format!(
        "window.__canopyBrowser ? window.__canopyBrowser.run({}) : null",
        serde_json::to_string(&op).map_err(|e| e.to_string())?
    );
    app.state::<ChromiumManager>()
        .eval_json(&tab_id, code)
        .await
}

#[tauri::command]
pub async fn chromium_command(
    app: tauri::AppHandle,
    tab_id: String,
    message: serde_json::Value,
) -> Result<(), String> {
    use tauri::Manager;
    let code = format!(
        "window.__canopyBrowser && window.__canopyBrowser.cmd({})",
        serde_json::to_string(&message).map_err(|e| e.to_string())?
    );
    app.state::<ChromiumManager>()
        .eval_json(&tab_id, code)
        .await
        .map(|_| ())
}

/// Queued page events, for the same reason browser.rs drains: there is no
/// postMessage back from a page we do not host.
#[tauri::command]
pub async fn chromium_drain(
    app: tauri::AppHandle,
    tab_id: String,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    app.state::<ChromiumManager>()
        .eval_json(
            &tab_id,
            "window.__canopyBrowser && window.__canopyBrowser.drain()".into(),
        )
        .await
}

#[tauri::command]
pub async fn chromium_here(
    app: tauri::AppHandle,
    tab_id: String,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    app.state::<ChromiumManager>()
        .eval_json(
            &tab_id,
            "window.__canopyBrowser && window.__canopyBrowser.here()".into(),
        )
        .await
}

#[tauri::command]
pub async fn chromium_close(app: tauri::AppHandle, tab_id: String) -> Result<(), String> {
    use tauri::Manager;
    app.state::<ChromiumManager>().close(&tab_id).await
}

/// A full-quality PNG of the page. `clip` is page CSS pixels for a region.
#[tauri::command]
pub async fn chromium_capture(
    app: tauri::AppHandle,
    tab_id: String,
    clip: Option<(f64, f64, f64, f64)>,
) -> Result<String, String> {
    use tauri::Manager;
    app.state::<ChromiumManager>().capture(&tab_id, clip).await
}

/// The page's viewport size, for mapping a pane click back to a page point.
#[tauri::command]
pub async fn chromium_metrics(
    app: tauri::AppHandle,
    tab_id: String,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    app.state::<ChromiumManager>().metrics(&tab_id).await
}

/// Start (or resize) the frame stream for a tab's pane.
#[tauri::command]
pub async fn chromium_start_cast(
    app: tauri::AppHandle,
    tab_id: String,
    width: u32,
    height: u32,
) -> Result<(), String> {
    use tauri::Manager;
    app.state::<ChromiumManager>()
        .start_cast(&app, &tab_id, width, height)
        .await
}

/// Stop the frame stream. Frames for a pane nobody is looking at are pure cost,
/// so this is called whenever the tab goes to the background.
#[tauri::command]
pub async fn chromium_stop_cast(app: tauri::AppHandle, tab_id: String) -> Result<(), String> {
    use tauri::Manager;
    app.state::<ChromiumManager>().stop_cast(&tab_id).await
}

/// The picker, as text — the same bytes preview.rs and browser.rs inject.
fn picker_source() -> String {
    // __canopyNativeBrowser selects the outbox transport: there is no parent to
    // postMessage to here, exactly as in the child-webview engine.
    // __canopyPulledBrowser additionally silences the doorbell: this host
    // drains the outbox over CDP, and the webview doorbell — an assignment to
    // the canopy-drain: scheme — is a real navigation in a browser with no
    // policy hook to cancel it. Rung while a page was loading, it cancelled
    // the load itself: every document died at birth and the cast starved.
    format!(
        "window.__canopyNativeBrowser = true;\nwindow.__canopyPulledBrowser = true;\n{}",
        include_str!("preview_picker.js")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_devtools_url_out_of_chrome_chatter() {
        assert_eq!(
            parse_devtools_url("DevTools listening on ws://127.0.0.1:52301/devtools/browser/ab-cd")
                .as_deref(),
            Some("ws://127.0.0.1:52301/devtools/browser/ab-cd")
        );
    }

    // Chrome writes plenty to stderr that is not the announcement, and reading
    // a port out of the wrong line would mean dialling nothing forever.
    #[test]
    fn ignores_lines_that_are_not_the_announcement() {
        assert_eq!(parse_devtools_url("[1234:5678] some warning"), None);
        assert_eq!(parse_devtools_url(""), None);
        assert_eq!(parse_devtools_url("ws://"), None);
    }

    #[test]
    fn stops_at_whitespace_when_two_lines_arrive_together() {
        assert_eq!(
            parse_devtools_url("DevTools listening on ws://127.0.0.1:1/x next line here")
                .as_deref(),
            Some("ws://127.0.0.1:1/x")
        );
    }

    #[test]
    fn detects_nothing_when_nothing_is_installed() {
        assert!(detect_with(|_| false).is_empty());
    }

    #[test]
    fn detects_in_preference_order_and_dedupes_by_name() {
        let found = detect_with(|_| true);
        assert!(!found.is_empty());
        let names: Vec<&str> = found.iter().map(|b| b.name.as_str()).collect();
        let mut unique = names.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(names.len(), unique.len(), "one entry per browser name");
    }

    // The whole security argument for exposing a debugging port rests on the
    // profile being ours, so this is not a style assertion.
    #[test]
    fn always_launches_on_a_canopy_owned_profile_and_an_ephemeral_port() {
        let args = launch_args(
            Path::new("/tmp/canopy-profile"),
            "https://example.com",
            true,
        );
        assert!(args
            .iter()
            .any(|a| a == "--user-data-dir=/tmp/canopy-profile"));
        assert!(args.iter().any(|a| a == "--remote-debugging-port=0"));
        assert!(args
            .iter()
            .any(|a| a == "--remote-debugging-address=127.0.0.1"));
        assert_eq!(args.last().unwrap(), "https://example.com");
    }

    // Headless is what lets this engine live inside a tab: a browser with a
    // window is an OS window, and there is no supported way to put one of those
    // in a pane. The new mode specifically — --headless=old is a different
    // browser with different rendering.
    #[test]
    fn launches_headless_by_default_and_headful_only_when_asked() {
        let head = launch_args(Path::new("/p"), "about:blank", false);
        assert!(!head.iter().any(|a| a.starts_with("--headless")));
        let less = launch_args(Path::new("/p"), "about:blank", true);
        assert!(less.iter().any(|a| a == "--headless=new"));
        // The URL stays last either way; Chrome reads the first positional as
        // the page to open and a flag after it is ignored.
        assert_eq!(less.last().unwrap(), "about:blank");
    }

    #[test]
    fn an_evaluate_reply_carrying_an_exception_is_an_error() {
        let reply = serde_json::json!({
            "result": { "type": "object" },
            "exceptionDetails": {
                "text": "Uncaught",
                "exception": { "description": "TypeError: nope" }
            }
        });
        assert_eq!(evaluate_value(&reply).unwrap_err(), "TypeError: nope");
    }

    // undefined is the normal answer while a page is still loading its picker.
    #[test]
    fn an_undefined_result_is_null_not_a_failure() {
        let reply = serde_json::json!({ "result": { "type": "undefined" } });
        assert_eq!(evaluate_value(&reply).unwrap(), serde_json::Value::Null);
    }

    #[test]
    fn a_plain_value_comes_straight_back() {
        let reply = serde_json::json!({ "result": { "type": "string", "value": "hi" } });
        assert_eq!(evaluate_value(&reply).unwrap(), serde_json::json!("hi"));
    }
}
