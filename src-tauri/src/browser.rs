//! The embedded browser: one real child webview per browser tab.
//!
//! The preview used to be an iframe pointed at a per-origin loopback reverse
//! proxy (preview.rs, still here as the fallback engine). That works, but it
//! isn't a browser: every site is served from `http://127.0.0.1:<port>`, so
//! they share one cookie jar, `Secure`/`Domain` cookies are meaningless, OAuth
//! redirects go sideways, and nothing survives a restart. Logging into a site
//! once and staying logged in — the thing people actually want from a browser
//! in their IDE — was not reachable from there.
//!
//! So this engine gives up the iframe and asks the platform for a real webview
//! (Tauri's `unstable` multi-webview support), loading the real URL at its real
//! origin, on the app's own persistent website data store. Cookies, storage and
//! credentials behave exactly as they do in Safari, because they *are* WebKit's.
//!
//! Two consequences shape everything below:
//!
//! 1. A child webview is a native view composited ABOVE the whole DOM. There is
//!    no z-index that puts a dialog over it. So the frontend keeps a placeholder
//!    div, syncs its rect here, and hides the webview whenever anything at all
//!    could overlap it (see browserHost.ts).
//! 2. There is no postMessage back to a parent — there is no parent. The host
//!    drives the injected picker by evaluating JavaScript and reading the value
//!    back; the page answers unprompted events into an outbox and rings a
//!    doorbell by navigating to the `canopy-drain:` scheme, which the navigation
//!    hook below cancels and turns into a drain.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// Everything a native browser view needs from the app that owns it.
#[derive(Default)]
pub struct BrowserManager {
    views: Mutex<HashMap<String, ViewState>>,
    /// Creation is synchronous inside an async command. A tab can close while
    /// `add_child` is still on the platform thread, before there is a ViewState
    /// for `browser_close` to find. Tokens turn that close into cancellation:
    /// the late creator closes its child instead of publishing an ownerless one.
    opening: Mutex<HashMap<String, (u64, u64)>>,
    next_open: AtomicU64,
    /// Native-issued identity of the only JavaScript page allowed to mutate
    /// browser children. A delayed command from a predecessor is rejected.
    renderer_generation: AtomicU64,
    /// A child whose close failed must remain nameable even when it never made
    /// it into `views`. This is also the bounded pending-close queue: one
    /// native retry worker drains these labels even when the renderer stays
    /// alive and no later renderer-registration sweep occurs.
    orphans: Mutex<HashMap<String, String>>,
    close_retry_running: AtomicBool,
    close_retry_attempts: AtomicU64,
    close_retry_successes: AtomicU64,
    close_retry_failures: AtomicU64,
}

#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCloseMetrics {
    pending: usize,
    retry_running: bool,
    attempts: u64,
    successes: u64,
    failures: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct CloseSweep {
    attempted: u64,
    closed: u64,
    remaining: usize,
}

enum OpenDecision {
    Existing,
    Pending,
    Create(u64),
}

struct ViewState {
    label: String,
    renderer_generation: u64,
    visible: bool,
    /// Where the frontend last said this view goes, in window points — the
    /// rect a blank view is nudged away from and back to.
    bounds: Rect,
    /// Whether this document has already had a repaint forced on it. One
    /// attempt per document: a page that stays blank through both remedies is
    /// not going to be talked round by a third, and reloading in a loop would
    /// be worse than the blank it is trying to fix.
    repaint_tried: bool,
}

#[derive(Clone, Copy, Default)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Doorbell scheme: the injected picker navigates to `canopy-drain:<n>` when it
/// has something to hand over. The navigation is always cancelled.
const DRAIN_SCHEME: &str = "canopy-drain";

/// How long an `eval` round trip may take before it is treated as lost. The
/// page's own op deadline (frontend side) is much longer; this only guards
/// against a webview that never calls the completion handler at all.
const EVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// A single worker retries transient WebKit close failures. The delay reaches
/// a low-frequency ceiling rather than creating an unbounded task/timer set.
const CLOSE_RETRY_DELAYS: [std::time::Duration; 5] = [
    std::time::Duration::from_millis(100),
    std::time::Duration::from_millis(500),
    std::time::Duration::from_secs(2),
    std::time::Duration::from_secs(10),
    std::time::Duration::from_secs(30),
];

/// Whether this build can host a native browser view at all. The child-webview
/// API is desktop-only, and only macOS has been through the overlap, snapshot
/// and session work — the other platforms stay on the proxy engine, which is
/// why preview.rs is still here.
pub const SUPPORTED: bool = cfg!(all(desktop, target_os = "macos"));

/// A webview label for a tab id. Labels are a global namespace shared with the
/// app's own window, and Tauri restricts them to `[a-zA-Z0-9 _-/:#]`, so ids
/// are both prefixed and scrubbed.
pub fn label_for(tab_id: &str) -> String {
    let mut out = String::from("canopy-browser-");
    for ch in tab_id.chars() {
        out.push(if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            ch
        } else {
            '_'
        });
    }
    out
}

/// The URL a browser tab may be pointed at. Anything else — `file:`, `data:`,
/// `javascript:` — would run with the browser profile's authority behind it,
/// and none of them is what a preview tab is for.
pub fn previewable(url: &str) -> bool {
    matches!(
        url.split_once("://").map(|(s, _)| s.to_ascii_lowercase()),
        Some(ref s) if s == "http" || s == "https"
    )
}

impl BrowserManager {
    fn require_renderer(&self, generation: u64) -> Result<(), String> {
        let current = self.renderer_generation.load(Ordering::SeqCst);
        if generation == 0 || generation != current {
            return Err(format!(
                "browser renderer generation {generation} is stale (current {current})"
            ));
        }
        Ok(())
    }

    fn begin_open(&self, tab_id: &str, renderer_generation: u64) -> Result<OpenDecision, String> {
        self.require_renderer(renderer_generation)?;
        // One lock order everywhere: opening -> views. This makes publish and
        // close mutually exclusive without holding either lock around WebKit.
        let mut opening = self.opening.lock().unwrap();
        if self.views.lock().unwrap().contains_key(tab_id) {
            return Ok(OpenDecision::Existing);
        }
        if opening.contains_key(tab_id) {
            return Ok(OpenDecision::Pending);
        }
        let token = self.next_open.fetch_add(1, Ordering::SeqCst) + 1;
        opening.insert(tab_id.to_string(), (token, renderer_generation));
        Ok(OpenDecision::Create(token))
    }

    /// Publish a child only if no close/replacement invalidated its creation.
    fn publish_open(&self, tab_id: String, token: u64, state: ViewState) -> bool {
        let mut opening = self.opening.lock().unwrap();
        if self.renderer_generation.load(Ordering::SeqCst) != state.renderer_generation
            || opening.get(&tab_id).copied() != Some((token, state.renderer_generation))
        {
            return false;
        }
        self.views.lock().unwrap().insert(tab_id.clone(), state);
        opening.remove(&tab_id);
        true
    }

    fn finish_failed_open(&self, tab_id: &str, token: u64) {
        let mut opening = self.opening.lock().unwrap();
        if opening
            .get(tab_id)
            .is_some_and(|(candidate, _)| *candidate == token)
        {
            opening.remove(tab_id);
        }
    }

    fn cancel_open(&self, tab_id: &str, renderer_generation: u64) {
        let mut opening = self.opening.lock().unwrap();
        if opening
            .get(tab_id)
            .is_some_and(|(_, owner)| *owner == renderer_generation)
        {
            opening.remove(tab_id);
        }
    }

    fn remember_orphan(&self, tab_id: &str, label: &str) {
        self.orphans
            .lock()
            .unwrap()
            .insert(label.to_string(), tab_id.to_string());
    }

    fn close_metrics(&self) -> BrowserCloseMetrics {
        BrowserCloseMetrics {
            pending: self.orphans.lock().unwrap().len(),
            retry_running: self.close_retry_running.load(Ordering::SeqCst),
            attempts: self.close_retry_attempts.load(Ordering::Relaxed),
            successes: self.close_retry_successes.load(Ordering::Relaxed),
            failures: self.close_retry_failures.load(Ordering::Relaxed),
        }
    }

    /// Apply one close attempt per queued label. Keeping the close operation
    /// injectable makes the fail-then-success lifecycle test deterministic;
    /// native WebKit lookup/close is supplied by `retry_pending_closes`.
    fn sweep_pending_with(&self, mut close: impl FnMut(&str) -> bool) -> CloseSweep {
        let targets = self
            .orphans
            .lock()
            .unwrap()
            .iter()
            .map(|(label, tab_id)| (label.clone(), tab_id.clone()))
            .collect::<Vec<_>>();
        let mut sweep = CloseSweep::default();
        for (label, tab_id) in targets {
            sweep.attempted += 1;
            self.close_retry_attempts.fetch_add(1, Ordering::Relaxed);
            if !close(&label) {
                self.close_retry_failures.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            sweep.closed += 1;
            self.close_retry_successes.fetch_add(1, Ordering::Relaxed);
            let mut views = self.views.lock().unwrap();
            if views.get(&tab_id).is_some_and(|state| state.label == label) {
                views.remove(&tab_id);
            }
            drop(views);
            let mut orphans = self.orphans.lock().unwrap();
            if orphans.get(&label).is_some_and(|owner| owner == &tab_id) {
                orphans.remove(&label);
            }
        }
        sweep.remaining = self.orphans.lock().unwrap().len();
        sweep
    }

    fn retry_pending_closes<R: tauri::Runtime>(&self, app: &tauri::AppHandle<R>) -> CloseSweep {
        self.sweep_pending_with(|label| match app.get_webview(label) {
            Some(view) => view.close().is_ok(),
            None => true,
        })
    }

    fn schedule_close_retry<R: tauri::Runtime>(&self, app: tauri::AppHandle<R>) {
        if self.close_retry_running.swap(true, Ordering::SeqCst) {
            return;
        }
        tauri::async_runtime::spawn(async move {
            let mut delay = 0usize;
            loop {
                tokio::time::sleep(CLOSE_RETRY_DELAYS[delay]).await;
                let manager = app.state::<BrowserManager>();
                let sweep = manager.retry_pending_closes(&app);
                if sweep.remaining == 0 {
                    manager.close_retry_running.store(false, Ordering::SeqCst);
                    // Close can race the transition above. If it queued work
                    // while this worker still looked active, start exactly one
                    // replacement worker after releasing the flag.
                    if !manager.orphans.lock().unwrap().is_empty() {
                        manager.schedule_close_retry(app.clone());
                    }
                    break;
                }
                delay = (delay + 1).min(CLOSE_RETRY_DELAYS.len() - 1);
            }
        });
    }

    fn queue_close_retry<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        tab_id: &str,
        label: &str,
    ) {
        self.remember_orphan(tab_id, label);
        self.schedule_close_retry(app.clone());
    }

    fn label(&self, tab_id: &str) -> Option<String> {
        self.views
            .lock()
            .unwrap()
            .get(tab_id)
            .map(|v| v.label.clone())
    }

    /// Labels of every live view, for teardown.
    pub fn labels(&self) -> Vec<String> {
        let mut labels = self
            .views
            .lock()
            .unwrap()
            .values()
            .map(|v| v.label.clone())
            .collect::<Vec<_>>();
        for label in self.orphans.lock().unwrap().keys() {
            if !labels.contains(label) {
                labels.push(label.clone());
            }
        }
        labels
    }

    pub fn shutdown_all(&self, app: &tauri::AppHandle) {
        for label in self.labels() {
            if let Some(wv) = app.get_webview(&label) {
                let _ = wv.close();
            }
        }
        self.views.lock().unwrap().clear();
        self.orphans.lock().unwrap().clear();
        self.opening.lock().unwrap().clear();
        self.close_retry_running.store(false, Ordering::SeqCst);
    }

    /// A JavaScript page owns every child browser view through a React
    /// component. Reload/crash skips those components' cleanup while the native
    /// manager survives, leaving WebKit content processes alive with no tab.
    /// A newly registered page therefore closes all predecessor-owned views.
    /// Failed closes remain registered and the singleton retry worker keeps
    /// trying even if the replacement renderer never registers again.
    pub fn close_renderer_orphans<R: tauri::Runtime>(&self, app: &tauri::AppHandle<R>) {
        // A predecessor may still be blocked inside add_child and have no view
        // to enumerate yet. Invalidate every creation token first; when that
        // call returns, publish_open refuses it and the creator closes the late
        // child itself.
        self.opening.lock().unwrap().clear();
        let mut targets = self
            .views
            .lock()
            .unwrap()
            .iter()
            .map(|(tab_id, state)| (tab_id.clone(), state.label.clone()))
            .collect::<Vec<_>>();
        for (label, tab_id) in self.orphans.lock().unwrap().iter() {
            if !targets.iter().any(|(_, existing)| existing == label) {
                targets.push((tab_id.clone(), label.clone()));
            }
        }
        for (tab_id, label) in targets {
            self.remember_orphan(&tab_id, &label);
        }
        let sweep = self.retry_pending_closes(app);
        if sweep.remaining > 0 {
            log::warn!(
                "renderer recovery: {} browser view close(s) remain queued after the initial sweep",
                sweep.remaining
            );
            self.schedule_close_retry(app.clone());
        }
    }

    /// Transfer browser-child authority to the replacement JavaScript page,
    /// then sweep every child (including half-created children) of the prior one.
    pub fn renderer_registered<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        generation: u64,
    ) {
        self.renderer_generation.store(generation, Ordering::SeqCst);
        self.close_renderer_orphans(app);
    }

    fn memory_pressure_targets(&self, include_visible: bool) -> Vec<(String, String)> {
        self.views
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, state)| include_visible || !state.visible)
            .map(|(tab_id, state)| (tab_id.clone(), state.label.clone()))
            .collect()
    }

    /// Tear down the JavaScript heaps in preview renderers while the machine
    /// is running out of memory. At warning pressure only hidden previews are
    /// touched; at critical pressure the visible preview is refreshed too.
    /// Reloading preserves the URL, cookies and the native view handle, so the
    /// frontend does not end up pointing at a child view that was closed under
    /// it. The page can lose ephemeral in-document state, but only after the
    /// alternative has become WebKit terminating Canopy's main renderer.
    pub fn reload_for_memory_pressure(
        &self,
        app: &tauri::AppHandle,
        include_visible: bool,
    ) -> Vec<String> {
        // Do not hold the state mutex while dispatching work to WebKit's main
        // thread. Besides needless contention, callbacks from a reload can
        // immediately re-enter BrowserManager through the navigation hook.
        let targets = self.memory_pressure_targets(include_visible);
        let mut reloaded = Vec::new();
        for (tab_id, label) in targets {
            let Some(view) = app.get_webview(&label) else {
                continue;
            };
            match view.reload() {
                Ok(()) => reloaded.push(tab_id),
                Err(error) => log::warn!(
                    "memory-watchdog: couldn't reload preview {tab_id} ({label}): {error}"
                ),
            }
        }
        reloaded
    }
}

/// The child webview behind a browser tab. Every caller resolves through here —
/// navigation, eval, snapshots — so that a failure can name the tab and the
/// label it looked for. An agent handed a bare refusal cannot tell "that tab was
/// closed" from "snapshots are broken", and will report the wrong one.
pub(crate) fn webview<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    tab_id: &str,
) -> Result<tauri::webview::Webview<R>, String> {
    let mgr = app.state::<BrowserManager>();
    let label = mgr
        .label(tab_id)
        .ok_or_else(|| format!("no browser view is open for tab {tab_id}"))?;
    app.get_webview(&label)
        .ok_or_else(|| format!("the browser view for tab {tab_id} (webview {label}) is gone"))
}

/// Evaluate `code` in a browser view and hand back whatever it returned, JSON
/// decoded. An empty completion (the page threw, or the expression was
/// `undefined`) becomes `null` rather than an error: callers decide what a
/// missing answer means, and every one of them has a better message for it than
/// "JSON parse error" would be.
pub(crate) async fn eval_json(
    app: &tauri::AppHandle,
    tab_id: &str,
    code: String,
) -> Result<serde_json::Value, String> {
    let wv = webview(app, tab_id)?;
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Mutex::new(Some(tx));
    wv.eval_with_callback(code, move |raw| {
        if let Some(tx) = tx.lock().unwrap().take() {
            let _ = tx.send(raw);
        }
    })
    .map_err(|e| format!("the browser view refused the script: {e}"))?;
    let raw = tokio::time::timeout(EVAL_TIMEOUT, rx)
        .await
        .map_err(|_| "the page didn't answer in time".to_string())?
        .map_err(|_| "the browser view closed while it was answering".to_string())?;
    if raw.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(&raw).map_err(|e| format!("the page's answer wasn't JSON: {e}"))
}

/// Ask the page for its queued messages and forward them to the frontend as one
/// `browser:events` payload. Called on the doorbell, and once after every op so
/// a missed doorbell can't strand an agent.
fn drain(app: tauri::AppHandle, tab_id: String) {
    tauri::async_runtime::spawn(async move {
        let events = eval_json(
            &app,
            &tab_id,
            "window.__canopyBrowser && window.__canopyBrowser.drain()".into(),
        )
        .await;
        let Ok(serde_json::Value::Array(events)) = events else {
            return;
        };
        if events.is_empty() {
            return;
        }
        let _ = app.emit(
            "browser:events",
            serde_json::json!({ "tabId": tab_id, "events": events }),
        );
    });
}

fn emit_nav(app: &tauri::AppHandle, tab_id: &str, url: &str, loading: bool) {
    let _ = app.emit(
        "browser:nav",
        serde_json::json!({ "tabId": tab_id, "url": url, "loading": loading }),
    );
}

// ---------- commands ----------

/// Whether the frontend may choose the webview engine at all. The engine
/// setting still decides; this is the veto.
#[tauri::command]
pub fn browser_supported() -> bool {
    SUPPORTED
}

/// Create the child webview for `tab_id` at `rect` (logical points relative to
/// the window's client area), or navigate the existing one. Idempotent, because
/// the frontend calls it whenever a tab becomes visible and it must not matter
/// whether that tab has been shown before.
#[tauri::command]
pub async fn browser_open(
    app: tauri::AppHandle,
    window: tauri::Window,
    tab_id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    // `background` is the app's own colour as [r, g, b]: a webview with nothing
    // loaded yet paints white, which against a dark theme reads as a broken
    // pane rather than an empty one.
    background: Option<Vec<u8>>,
    // A PiP-owned browser starts behind the user's current tab. Creating it
    // hidden avoids one frame of the full native view flashing over their work.
    visible: bool,
    renderer_generation: u64,
) -> Result<(), String> {
    if !SUPPORTED {
        return Err("the embedded browser needs macOS on this build".into());
    }
    if !previewable(&url) {
        return Err(format!(
            "{url} isn't an http:// or https:// URL — the browser opens web pages"
        ));
    }
    let manager = app.state::<BrowserManager>();
    match manager.begin_open(&tab_id, renderer_generation)? {
        OpenDecision::Existing => {
            browser_navigate(app, tab_id, Some(url), None, renderer_generation).await
        }
        // Idempotent while the first platform creation is still in flight.
        OpenDecision::Pending => Ok(()),
        OpenDecision::Create(token) => {
            let result = create(
                app.clone(),
                window,
                tab_id.clone(),
                token,
                url,
                x,
                y,
                width,
                height,
                background,
                visible,
                renderer_generation,
            );
            if result.is_err() {
                app.state::<BrowserManager>()
                    .finish_failed_open(&tab_id, token);
            }
            result
        }
    }
}

/// Paint the webview's own empty space in the app's colour.
///
/// Tauri's `background_color` is documented as not implemented on macOS, so
/// this goes to WebKit directly: `underPageBackgroundColor` is what shows
/// before the first paint, past the end of a short page, and during a rubber
/// band scroll. Best effort — a failure here is a cosmetic flash, never a
/// reason to fail opening the page.
#[cfg(all(desktop, target_os = "macos"))]
fn tint(view: &tauri::webview::Webview, rgb: [u8; 3]) {
    let _ = view.with_webview(move |platform| {
        use objc2_app_kit::NSColor;
        use objc2_web_kit::WKWebView;
        let ptr = platform.inner() as *mut WKWebView;
        let Some(wk) = (unsafe { ptr.as_ref() }) else {
            return;
        };
        let color = NSColor::colorWithSRGBRed_green_blue_alpha(
            f64::from(rgb[0]) / 255.0,
            f64::from(rgb[1]) / 255.0,
            f64::from(rgb[2]) / 255.0,
            1.0,
        );
        unsafe { wk.setUnderPageBackgroundColor(Some(&color)) };
    });
}

#[cfg(all(desktop, target_os = "macos"))]
fn create(
    app: tauri::AppHandle,
    window: tauri::Window,
    tab_id: String,
    open_token: u64,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    background: Option<Vec<u8>>,
    visible: bool,
    renderer_generation: u64,
) -> Result<(), String> {
    use tauri::utils::config::BackgroundThrottlingPolicy;
    use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
    use tauri::{LogicalPosition, LogicalSize, WebviewUrl};

    let parsed = url
        .parse::<tauri::Url>()
        .map_err(|e| format!("{url} isn't a URL: {e}"))?;
    let label = label_for(&tab_id);

    // The picker's own transport switch. Prepended rather than folded into the
    // script so preview.rs can keep injecting the identical file.
    let script = format!(
        "window.__canopyNativeBrowser = true;\n{}",
        include_str!("preview_picker.js")
    );

    let nav_app = app.clone();
    let nav_tab = tab_id.clone();
    let load_app = app.clone();
    let load_tab = tab_id.clone();
    let popup_app = app.clone();
    let popup_tab = tab_id.clone();

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .initialization_script(script)
        // A backgrounded tab's page must keep running: agents drive pages the
        // user isn't looking at, and a suspended one answers nothing.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .devtools(true)
        .on_navigation(move |url| {
            if url.scheme() == DRAIN_SCHEME {
                drain(nav_app.clone(), nav_tab.clone());
                return false;
            }
            // A new document gets its own chance to be rescued.
            if let Some(v) = nav_app
                .state::<BrowserManager>()
                .views
                .lock()
                .unwrap()
                .get_mut(&nav_tab)
            {
                v.repaint_tried = false;
            }
            emit_nav(&nav_app, &nav_tab, url.as_str(), true);
            true
        })
        .on_page_load(move |_wv, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                emit_nav(&load_app, &load_tab, payload.url().as_str(), false);
                drain(load_app.clone(), load_tab.clone());
            }
        })
        // target=_blank and window.open: one tab, one view. Opening a real OS
        // window would put a webview outside every rule the host maintains
        // about where browser pixels are allowed to be.
        .on_new_window(move |url, _features| {
            let _ = popup_app.emit(
                "browser:popup",
                serde_json::json!({ "tabId": popup_tab, "url": url.as_str() }),
            );
            NewWindowResponse::Deny
        });

    let view = window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width.max(1.0), height.max(1.0)),
        )
        .map_err(|e| format!("couldn't open the browser view: {e}"))?;

    let initial = Rect {
        x,
        y,
        width,
        height,
    };
    let manager = app.state::<BrowserManager>();
    if !manager.publish_open(
        tab_id.clone(),
        open_token,
        ViewState {
            bounds: initial,
            repaint_tried: false,
            label: label.clone(),
            renderer_generation,
            // Until the requested hide succeeds, native reality is visible.
            visible: true,
        },
    ) {
        // The tab closed while add_child was running. A successful close leaves
        // nothing to publish; a failed close is retained for the next recovery
        // sweep, so it can never become an unnameable WebContent process.
        if let Err(error) = view.close() {
            manager.queue_close_retry(&app, &tab_id, &label);
            log::warn!("browser creation cancellation: couldn't close {tab_id} ({label}): {error}");
        }
        return Ok(());
    }

    if let Some(rgb) = background.as_deref() {
        if let [r, g, b, ..] = *rgb {
            tint(&view, [r, g, b]);
        }
    }
    if !visible {
        if let Err(error) = view.hide() {
            // It is already registered, so browser_close either releases it or
            // deliberately keeps the entry for renderer recovery to retry.
            let close_error = browser_close(app.clone(), tab_id.clone(), renderer_generation).err();
            return Err(match close_error {
                Some(close) => {
                    format!("couldn't hide the browser view: {error}; close also failed: {close}")
                }
                None => format!("couldn't hide the browser view: {error}"),
            });
        }
        if let Some(state) = manager.views.lock().unwrap().get_mut(&tab_id) {
            if state.label == label {
                state.visible = false;
            }
        }
    }
    Ok(())
}

#[cfg(not(all(desktop, target_os = "macos")))]
fn create(
    _app: tauri::AppHandle,
    _window: tauri::Window,
    _tab_id: String,
    _open_token: u64,
    _url: String,
    _x: f64,
    _y: f64,
    _width: f64,
    _height: f64,
    _background: Option<Vec<u8>>,
    _visible: bool,
    _renderer_generation: u64,
) -> Result<(), String> {
    Err("the embedded browser needs macOS on this build".into())
}

#[tauri::command]
pub async fn browser_navigate(
    app: tauri::AppHandle,
    tab_id: String,
    url: Option<String>,
    action: Option<String>,
    renderer_generation: u64,
) -> Result<(), String> {
    app.state::<BrowserManager>()
        .require_renderer(renderer_generation)?;
    let wv = webview(&app, &tab_id)?;
    match (url, action.as_deref()) {
        (Some(u), _) => {
            if !previewable(&u) {
                return Err(format!(
                    "{u} isn't an http:// or https:// URL — the browser opens web pages"
                ));
            }
            let parsed = u.parse::<tauri::Url>().map_err(|e| e.to_string())?;
            wv.navigate(parsed).map_err(|e| e.to_string())
        }
        (None, Some("reload")) => wv.reload().map_err(|e| e.to_string()),
        // No back/forward on the Rust side of the API, and the page's own
        // history is the same history the platform would walk.
        (None, Some(d @ ("back" | "forward"))) => {
            let delta = if d == "back" { -1 } else { 1 };
            wv.eval(format!("history.go({delta})"))
                .map_err(|e| e.to_string())
        }
        _ => Err("navigate needs a url, or action = back | forward | reload".into()),
    }
}

/// What a view should do when the frontend asks for a visibility.
/// Put a view where the frontend says it goes.
fn place<R: tauri::Runtime>(wv: &tauri::webview::Webview<R>, r: Rect) -> Result<(), String> {
    wv.set_bounds(tauri::Rect {
        position: tauri::LogicalPosition::new(r.x, r.y).into(),
        size: tauri::LogicalSize::new(r.width.max(1.0), r.height.max(1.0)).into(),
    })
    .map_err(|e| e.to_string())
}

/// How long a freshly shown view gets to paint itself before it is treated as
/// blank. Long enough that an ordinary page wins on its own; short enough that
/// nobody sits looking at white.
const PAINT_GRACE: std::time::Duration = std::time::Duration::from_millis(350);

/// …and how long the cheap remedy gets before the expensive one.
const NUDGE_GRACE: std::time::Duration = std::time::Duration::from_millis(300);

/// Whether the page has drawn a frame. See `browser_painted` — the page
/// answers from its own first requestAnimationFrame, which is the one signal
/// that does not force the render it is measuring.
async fn has_painted(app: &tauri::AppHandle, tab_id: &str) -> bool {
    eval_json(app, tab_id, "window.__canopyPainted || 0".into())
        .await
        .ok()
        .and_then(|v| v.as_f64())
        .is_some_and(|n| n > 0.0)
}

/// A view has just been shown. If its document loaded while the view was off
/// screen, WebKit never drew it and will not draw it now — the pane is blank
/// white until something forces a new render. That is the bug users hit by
/// opening a preview with a panel over it, and the reason the only fix they
/// had was pressing reload.
///
/// Two remedies, cheapest first, because the expensive one costs page state:
/// resizing the view by a pixel makes WebKit recompute what is visible and
/// build tiles for it, and a reload rebuilds the document outright. Neither
/// runs unless the page itself reports that it has never painted, so an
/// ordinary show — which is almost all of them — does nothing at all.
fn repaint_if_blank(app: tauri::AppHandle, tab_id: String) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(PAINT_GRACE).await;
        // Still the state we were called for? A view hidden again in the
        // meantime is not blank on screen, and rendering it would be work
        // nobody asked for.
        let bounds = {
            let mgr = app.state::<BrowserManager>();
            let mut views = mgr.views.lock().unwrap();
            match views.get_mut(&tab_id) {
                Some(v) if v.visible && !v.repaint_tried => {
                    v.repaint_tried = true;
                    v.bounds
                }
                _ => return,
            }
        };
        if has_painted(&app, &tab_id).await {
            return;
        }
        let Ok(wv) = webview(&app, &tab_id) else {
            return;
        };
        let _ = place(
            &wv,
            Rect {
                width: (bounds.width - 1.0).max(1.0),
                ..bounds
            },
        );
        let _ = place(&wv, bounds);
        tokio::time::sleep(NUDGE_GRACE).await;
        if has_painted(&app, &tab_id).await {
            return;
        }
        // Nothing cheap worked, so do what the user was doing by hand. A page
        // that has never rendered has nothing on screen to lose.
        let _ = wv.reload();
    });
}

#[tauri::command]
pub fn browser_set_bounds(
    app: tauri::AppHandle,
    tab_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    renderer_generation: u64,
) -> Result<(), String> {
    app.state::<BrowserManager>()
        .require_renderer(renderer_generation)?;
    let wv = webview(&app, &tab_id)?;
    let rect = Rect {
        x,
        y,
        width,
        height,
    };
    if let Some(v) = app
        .state::<BrowserManager>()
        .views
        .lock()
        .unwrap()
        .get_mut(&tab_id)
    {
        v.bounds = rect;
    }
    place(&wv, rect)
}

/// Show or hide the view. This is the single lever every overlap rule pulls —
/// tab switches, dialogs, menus, the palette, a hidden project, hibernation.
#[tauri::command]
pub fn browser_set_visible(
    app: tauri::AppHandle,
    tab_id: String,
    visible: bool,
    renderer_generation: u64,
) -> Result<(), String> {
    app.state::<BrowserManager>()
        .require_renderer(renderer_generation)?;
    let wv = webview(&app, &tab_id)?;
    {
        let mgr = app.state::<BrowserManager>();
        let mut views = mgr.views.lock().unwrap();
        match views.get_mut(&tab_id) {
            Some(v) if v.visible == visible => return Ok(()),
            Some(v) => v.visible = visible,
            None => {}
        }
    }
    if !visible {
        return wv.hide().map_err(|e| e.to_string());
    }
    wv.show().map_err(|e| e.to_string())?;
    repaint_if_blank(app, tab_id);
    Ok(())
}

#[tauri::command]
pub fn browser_close(
    app: tauri::AppHandle,
    tab_id: String,
    renderer_generation: u64,
) -> Result<(), String> {
    let manager = app.state::<BrowserManager>();
    manager.require_renderer(renderer_generation)?;
    // If add_child has not returned yet, this invalidates its token. The creator
    // will close the late child before publishing it.
    manager.cancel_open(&tab_id, renderer_generation);
    let label = manager
        .views
        .lock()
        .unwrap()
        .get(&tab_id)
        .map(|state| state.label.clone());
    let orphan_labels = manager
        .orphans
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(label, owner)| (owner == &tab_id).then_some(label.clone()))
        .collect::<Vec<_>>();
    let Some(label) = label else {
        if orphan_labels.is_empty() {
            return Ok(());
        }
        let sweep = manager.retry_pending_closes(&app);
        if orphan_labels
            .iter()
            .any(|orphan| manager.orphans.lock().unwrap().contains_key(orphan))
        {
            manager.schedule_close_retry(app.clone());
            return Err(format!(
                "{} browser view close(s) remain queued after a failed close",
                sweep.remaining
            ));
        }
        return Ok(());
    };
    if let Some(wv) = app.get_webview(&label) {
        if let Err(error) = wv.close() {
            manager.queue_close_retry(&app, &tab_id, &label);
            return Err(error.to_string());
        }
    }
    // Remove only after close succeeds. If WebKit refuses the close, retaining
    // the handle lets renderer recovery retry instead of losing the only name
    // by which the leaked process can be reached.
    let mut views = manager.views.lock().unwrap();
    if views.get(&tab_id).is_some_and(|state| state.label == label) {
        views.remove(&tab_id);
    }
    manager.orphans.lock().unwrap().remove(&label);
    Ok(())
}

#[tauri::command]
pub fn browser_close_metrics(app: tauri::AppHandle) -> BrowserCloseMetrics {
    app.state::<BrowserManager>().close_metrics()
}

/// Run one browser op (`canopy_browser_*`) against the page. Read-only ops
/// answer inside this call; cursor-led ones report `done: false` and their
/// result arrives later on `browser:events`.
#[tauri::command]
pub async fn browser_run_op(
    app: tauri::AppHandle,
    tab_id: String,
    op: serde_json::Value,
    renderer_generation: u64,
) -> Result<serde_json::Value, String> {
    app.state::<BrowserManager>()
        .require_renderer(renderer_generation)?;
    let code = format!(
        "window.__canopyBrowser ? window.__canopyBrowser.run({}) : null",
        serde_json::to_string(&op).map_err(|e| e.to_string())?
    );
    let out = eval_json(&app, &tab_id, code).await?;
    // Async op: the page will ring the doorbell, but a page that navigates
    // mid-op might not get to. One follow-up drain is cheap insurance.
    if out.get("done").and_then(|d| d.as_bool()) != Some(true) {
        drain(app.clone(), tab_id);
    }
    Ok(out)
}

/// A host->page command with no result: annotate mode, badge sync.
#[tauri::command]
pub async fn browser_command(
    app: tauri::AppHandle,
    tab_id: String,
    message: serde_json::Value,
    renderer_generation: u64,
) -> Result<(), String> {
    app.state::<BrowserManager>()
        .require_renderer(renderer_generation)?;
    let code = format!(
        "window.__canopyBrowser && window.__canopyBrowser.cmd({})",
        serde_json::to_string(&message).map_err(|e| e.to_string())?
    );
    eval_json(&app, &tab_id, code).await.map(|_| ())
}

/// Has this view's current document ever rendered a frame?
///
/// Not the same question as "has it loaded", which is the whole bug: a page
/// that loads while its view is hidden finishes loading and never paints, and
/// WebKit does not go back and paint it afterwards. The page answers from its
/// own first `requestAnimationFrame` (preview_picker.js), a callback that only
/// runs when the view is actually being drawn. Asked with an eval because a
/// snapshot would force the very render it is trying to detect — which is why
/// this bug survived a suite that takes pictures.
#[tauri::command]
pub async fn browser_painted(
    app: tauri::AppHandle,
    tab_id: String,
    renderer_generation: u64,
) -> Result<bool, String> {
    app.state::<BrowserManager>()
        .require_renderer(renderer_generation)?;
    Ok(has_painted(&app, &tab_id).await)
}

/// Where the page thinks it is. The page-load hook covers real navigations;
/// this covers the in-page (pushState) ones it can't see.
#[tauri::command]
pub async fn browser_here(
    app: tauri::AppHandle,
    tab_id: String,
    renderer_generation: u64,
) -> Result<serde_json::Value, String> {
    app.state::<BrowserManager>()
        .require_renderer(renderer_generation)?;
    eval_json(
        &app,
        &tab_id,
        "window.__canopyBrowser && window.__canopyBrowser.here()".into(),
    )
    .await
}

/// Forget every site's cookies, storage and caches — the browser profile is
/// shared by every tab on purpose (that is what keeps you logged in), so this
/// is all-or-nothing, exactly like a browser's "clear browsing data".
#[tauri::command]
pub fn browser_clear_data(app: tauri::AppHandle, renderer_generation: u64) -> Result<(), String> {
    app.state::<BrowserManager>()
        .require_renderer(renderer_generation)?;
    if !SUPPORTED {
        return Err(
            "There is no embedded-browser profile on this platform yet — the preview runs \
             through the loopback proxy, which keeps nothing between sessions."
                .into(),
        );
    }
    // Any webview sharing the app's default data store will do, and the main
    // window always exists.
    let wv = app
        .webviews()
        .into_values()
        .next()
        .ok_or_else(|| "no webview to clear".to_string())?;
    wv.clear_all_browsing_data()
        .map_err(|e| format!("couldn't clear the browsing data: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(label: &str, renderer_generation: u64) -> ViewState {
        ViewState {
            label: label.into(),
            renderer_generation,
            visible: false,
            bounds: Rect::default(),
            repaint_tried: false,
        }
    }

    #[test]
    fn close_cancels_an_inflight_child_before_it_can_publish() {
        let manager = BrowserManager::default();
        manager.renderer_generation.store(1, Ordering::SeqCst);
        let OpenDecision::Create(token) = manager.begin_open("tab", 1).unwrap() else {
            panic!("first open should create");
        };
        manager.cancel_open("tab", 1);
        assert!(!manager.publish_open("tab".into(), token, state("late", 1)));
        assert!(manager.views.lock().unwrap().is_empty());
    }

    #[test]
    fn stale_creator_cannot_overwrite_a_reopened_tab() {
        let manager = BrowserManager::default();
        manager.renderer_generation.store(1, Ordering::SeqCst);
        let OpenDecision::Create(old) = manager.begin_open("tab", 1).unwrap() else {
            panic!("first open should create");
        };
        manager.cancel_open("tab", 1);
        manager.renderer_generation.store(2, Ordering::SeqCst);
        let OpenDecision::Create(current) = manager.begin_open("tab", 2).unwrap() else {
            panic!("replacement open should create");
        };
        assert!(!manager.publish_open("tab".into(), old, state("old", 1)));
        assert!(manager.publish_open("tab".into(), current, state("current", 2)));
        assert_eq!(manager.label("tab").as_deref(), Some("current"));
    }

    #[test]
    fn failed_close_of_an_unpublished_child_stays_recoverable() {
        let manager = BrowserManager::default();
        manager.remember_orphan("tab", "orphan-label");
        assert_eq!(manager.labels(), vec!["orphan-label".to_string()]);
    }

    #[test]
    fn pending_close_retries_fail_then_succeed_without_losing_the_handle() {
        let manager = BrowserManager::default();
        manager
            .views
            .lock()
            .unwrap()
            .insert("tab".into(), state("view-label", 1));
        manager.remember_orphan("tab", "view-label");

        let first = manager.sweep_pending_with(|_| false);
        assert_eq!(
            first,
            CloseSweep {
                attempted: 1,
                closed: 0,
                remaining: 1,
            }
        );
        assert_eq!(manager.label("tab").as_deref(), Some("view-label"));
        assert_eq!(manager.close_metrics().pending, 1);

        let second = manager.sweep_pending_with(|_| true);
        assert_eq!(
            second,
            CloseSweep {
                attempted: 1,
                closed: 1,
                remaining: 0,
            }
        );
        assert!(manager.views.lock().unwrap().is_empty());
        assert!(manager.orphans.lock().unwrap().is_empty());
        let metrics = manager.close_metrics();
        assert_eq!(
            (metrics.attempts, metrics.successes, metrics.failures),
            (2, 1, 1)
        );
    }

    #[test]
    fn renderer_recovery_invalidates_a_predecessor_creation() {
        use tauri::WebviewUrl;

        let app = tauri::test::mock_app();
        let manager = BrowserManager::default();
        manager.renderer_generation.store(1, Ordering::SeqCst);
        let OpenDecision::Create(token) = manager.begin_open("old-page-tab", 1).unwrap() else {
            panic!("first open should create");
        };
        tauri::WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .build()
            .unwrap();
        manager.renderer_registered(app.handle(), 2);
        assert!(!manager.publish_open(
            "old-page-tab".into(),
            token,
            state("late-old-page-view", 1),
        ));
    }

    #[test]
    fn a_label_survives_any_tab_id() {
        assert_eq!(
            label_for("2f1c9b6e-0000-4aaa-8bbb-ccccdddd0001"),
            "canopy-browser-2f1c9b6e-0000-4aaa-8bbb-ccccdddd0001"
        );
        assert_eq!(label_for("t1a/b c"), "canopy-browser-t1a_b_c");
        assert_eq!(label_for(""), "canopy-browser-");
    }

    /// The nudge has to change the size WebKit is asked to fill — that is
    /// what makes it recompute the visible rect and build tiles — while
    /// leaving the view where the placeholder is.
    #[test]
    fn the_nudge_changes_the_size_and_keeps_the_position() {
        let r = Rect {
            x: 120.0,
            y: 60.0,
            width: 800.0,
            height: 600.0,
        };
        let nudged = Rect {
            width: (r.width - 1.0).max(1.0),
            ..r
        };
        assert_ne!(nudged.width, r.width);
        assert_eq!((nudged.x, nudged.y), (r.x, r.y));
        // A collapsed pane must not nudge itself to nothing.
        let tiny = Rect { width: 1.0, ..r };
        assert_eq!((tiny.width - 1.0f64).max(1.0), 1.0);
    }

    #[test]
    fn only_web_pages_are_previewable() {
        assert!(previewable("http://localhost:5173/"));
        assert!(previewable("https://example.com"));
        assert!(previewable("HTTPS://example.com"));
        assert!(!previewable("file:///etc/passwd"));
        assert!(!previewable("javascript:alert(1)"));
        assert!(!previewable("data:text/html,<b>x"));
        assert!(!previewable("example.com"));
    }

    /// A tab's snapshot goes to the tab's own child webview, found by the label
    /// the manager recorded — not to the window it happens to be sitting in.
    #[test]
    fn a_tab_resolves_to_its_own_child_webview() {
        use tauri::{LogicalPosition, LogicalSize, WebviewUrl};

        let app = tauri::test::mock_app();
        app.handle().manage(BrowserManager::default());
        tauri::WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .build()
            .unwrap();
        let label = label_for("tab-1");
        app.get_window("main")
            .unwrap()
            .add_child(
                tauri::webview::WebviewBuilder::new(&label, WebviewUrl::default()),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(100.0, 100.0),
            )
            .unwrap();
        app.state::<BrowserManager>().views.lock().unwrap().insert(
            "tab-1".into(),
            ViewState {
                label: label.clone(),
                renderer_generation: 1,
                visible: true,
                bounds: Rect::default(),
                repaint_tried: false,
            },
        );

        assert_eq!(webview(app.handle(), "tab-1").unwrap().label(), label);
    }

    #[test]
    fn renderer_recovery_closes_and_forgets_predecessor_browser_views() {
        use tauri::{LogicalPosition, LogicalSize, WebviewUrl};

        let app = tauri::test::mock_app();
        app.handle().manage(BrowserManager::default());
        tauri::WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .build()
            .unwrap();
        let label = label_for("old-tab");
        app.get_window("main")
            .unwrap()
            .add_child(
                tauri::webview::WebviewBuilder::new(&label, WebviewUrl::default()),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(100.0, 100.0),
            )
            .unwrap();
        app.state::<BrowserManager>().views.lock().unwrap().insert(
            "old-tab".into(),
            ViewState {
                label: label.clone(),
                renderer_generation: 1,
                visible: false,
                bounds: Rect::default(),
                repaint_tried: false,
            },
        );

        app.state::<BrowserManager>()
            .close_renderer_orphans(app.handle());

        assert!(app
            .state::<BrowserManager>()
            .views
            .lock()
            .unwrap()
            .is_empty());
        assert!(app.get_webview(&label).is_none());
    }

    /// A refusal has to name the tab it failed on. An agent handed a bare
    /// "snapshot refused" reports the wrong bug — which is how the window's own
    /// resolution stayed broken for four merged PRs.
    #[test]
    fn a_missing_tab_says_which_tab() {
        let app = tauri::test::mock_app();
        app.handle().manage(BrowserManager::default());
        let err = webview(app.handle(), "tab-gone").unwrap_err();
        assert!(err.contains("tab-gone"), "{err}");
    }

    #[test]
    fn memory_pressure_spares_the_visible_preview_until_critical() {
        let manager = BrowserManager::default();
        let mut views = manager.views.lock().unwrap();
        for (tab_id, visible) in [("visible", true), ("hidden-a", false), ("hidden-b", false)] {
            views.insert(
                tab_id.into(),
                ViewState {
                    label: label_for(tab_id),
                    renderer_generation: 1,
                    visible,
                    bounds: Rect::default(),
                    repaint_tried: false,
                },
            );
        }
        drop(views);

        let mut warning: Vec<String> = manager
            .memory_pressure_targets(false)
            .into_iter()
            .map(|(tab_id, _)| tab_id)
            .collect();
        warning.sort();
        assert_eq!(warning, ["hidden-a", "hidden-b"]);

        let mut critical: Vec<String> = manager
            .memory_pressure_targets(true)
            .into_iter()
            .map(|(tab_id, _)| tab_id)
            .collect();
        critical.sort();
        assert_eq!(critical, ["hidden-a", "hidden-b", "visible"]);
    }
}
