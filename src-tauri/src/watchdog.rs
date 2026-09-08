//! Resident health watchdogs — the two tracks from issue #488.
//!
//! ## Webview heartbeat
//!
//! When the machine runs out of memory, macOS's jetsam daemon kills the WebKit
//! renderer that backs Canopy's window (the `com.apple.WebKit.WebContent`
//! process). The Rust core survives — which is why the app just sits there
//! blank with no crash report while the user sees a dead IDE. This watchdog
//! pings the webview and reloads it when the pings stop being answered,
//! turning a jetsam kill into a recovery instead of a dead app.
//!
//! ## Memory pressure
//!
//! The same scenario caught on the way in: sample host memory, refresh
//! reloadable preview heaps as pressure rises, and tell the UI before the
//! system decides to take the main renderer itself.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sysinfo::System;
use tauri::{AppHandle, Emitter, Manager};

/// Tauri gives the configured app window and its first webview this label.
const APP_WEBVIEW: &str = "main";

/// How often the webview is asked to say it is alive.
const PING_EVERY: Duration = Duration::from_secs(3);
/// A ping unanswered for longer than this counts as missed.
const STALE_AFTER: Duration = Duration::from_secs(9);
/// Consecutive stale readings before the webview is reloaded.
const MISSES_BEFORE_RELOAD: u32 = 3;
/// One native pressure-shed pass may run before heartbeat recovery. It gets
/// exactly one ping interval; renderer progress must never depend on an
/// unbounded series of hopeful cache sweeps.
const PRESSURE_SHED_PROBE: Duration = PING_EVERY;
/// Grace after a reload before enforcement resumes — the fresh page needs
/// time to boot before it can start answering pings.
const RELOAD_GRACE: Duration = Duration::from_secs(45);
/// Reload at most this many times…
const MAX_RELOADS: usize = 3;
/// …within this window. Beyond that the renderer death is not transient and
/// reloading is just churn; the watchdog stops and logs instead.
const RELOAD_WINDOW: Duration = Duration::from_secs(10 * 60);
/// Native termination and heartbeat can report the same failure. One reload is
/// enough; suppress duplicate initiators while the replacement page boots.
const INCIDENTS_MAX: usize = 128;

/// Temporary value while a native reload call is in flight. It cannot collide
/// with a real epoch-millisecond acknowledgement, so compare-exchange can tell
/// whether a renderer ack/registration raced the call without an ABA window.
const ACK_RECOVERY_SENTINEL: u64 = u64::MAX;

/// How often host memory is sampled.
const MEM_POLL_EVERY: Duration = Duration::from_secs(5);

/// Pressure levels, ordered weakest → strongest. The frontend banner keys on
/// these; `memory:pressure` events only fire when the level *changes*.
pub const MEM_OK: u8 = 0;
pub const MEM_WARN: u8 = 1;
pub const MEM_CRIT: u8 = 2;

/// The webview's last heartbeat acknowledgement, in epoch ms (0 = never).
/// Written by the ack command (IPC thread), read by the watchdog loop (its
/// own thread), so it lives behind an Arc.
pub struct WatchdogState {
    last_ack_ms: AtomicU64,
    renderer_generation: AtomicU64,
    recovery: Mutex<RecoveryState>,
}

#[derive(Default)]
struct RecoveryState {
    grace_until_ms: u64,
    reloads_ms: VecDeque<u64>,
    incidents: VecDeque<RecoveryIncident>,
}

#[derive(Clone, serde::Serialize)]
pub struct RecoveryIncident {
    pub at_ms: u64,
    pub kind: String,
    pub generation: u64,
    pub detail: u64,
    pub outcome: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HeartbeatAction {
    Healthy,
    Waiting,
    BeginPressureShed,
    RecoveredAfterShed,
    Reload,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReloadDecision {
    Started,
    InRecovery,
    RateLimited,
    Failed,
}

fn reload_decision_message(
    reason: &'static str,
    outcome: &'static str,
    generation: u64,
    detail: u64,
    reloads_in_window: usize,
    grace_remaining_ms: u64,
) -> String {
    format!(
        "webview-recovery decision reason={reason} outcome={outcome} generation={generation} detail={detail} reloads_in_window={reloads_in_window} grace_remaining_ms={grace_remaining_ms}"
    )
}

#[derive(Default)]
struct HeartbeatTracker {
    misses: u32,
    probe_deadline_ms: Option<u64>,
    suppressed_until_ms: Option<u64>,
}

impl HeartbeatTracker {
    fn observe(&mut self, now: u64, stale: bool) -> HeartbeatAction {
        if !stale {
            self.misses = 0;
            self.suppressed_until_ms = None;
            return if self.probe_deadline_ms.take().is_some() {
                HeartbeatAction::RecoveredAfterShed
            } else {
                HeartbeatAction::Healthy
            };
        }
        if self.suppressed_until_ms.is_some_and(|until| now < until) {
            return HeartbeatAction::Waiting;
        }
        self.suppressed_until_ms = None;
        if let Some(deadline) = self.probe_deadline_ms {
            if now >= deadline {
                self.probe_deadline_ms = None;
                return HeartbeatAction::Reload;
            }
            return HeartbeatAction::Waiting;
        }
        self.misses = self.misses.saturating_add(1);
        if self.misses < MISSES_BEFORE_RELOAD {
            return HeartbeatAction::Waiting;
        }
        self.misses = 0;
        self.probe_deadline_ms = Some(now.saturating_add(PRESSURE_SHED_PROBE.as_millis() as u64));
        HeartbeatAction::BeginPressureShed
    }

    fn suppress_for(&mut self, now: u64, duration: Duration) {
        self.misses = 0;
        self.probe_deadline_ms = None;
        self.suppressed_until_ms = Some(now.saturating_add(duration.as_millis() as u64));
    }
}

impl Default for WatchdogState {
    fn default() -> Self {
        Self {
            last_ack_ms: AtomicU64::new(now_ms()),
            renderer_generation: AtomicU64::new(0),
            recovery: Mutex::new(RecoveryState::default()),
        }
    }
}

impl WatchdogState {
    pub fn renderer_registered(&self, generation: u64) {
        self.renderer_generation.store(generation, Ordering::SeqCst);
        self.last_ack_ms.store(now_ms(), Ordering::Relaxed);
        self.record("renderer_registered", 0, "ready");
    }

    fn acknowledge(&self, generation: u64) -> bool {
        if self.renderer_generation.load(Ordering::SeqCst) != generation {
            return false;
        }
        self.last_ack_ms.store(now_ms(), Ordering::Relaxed);
        true
    }

    fn record(&self, kind: &str, detail: u64, outcome: &str) {
        let mut recovery = self.recovery.lock().unwrap();
        recovery.incidents.push_back(RecoveryIncident {
            at_ms: now_ms(),
            kind: kind.to_string(),
            generation: self.renderer_generation.load(Ordering::SeqCst),
            detail,
            outcome: outcome.to_string(),
        });
        while recovery.incidents.len() > INCIDENTS_MAX {
            recovery.incidents.pop_front();
        }
    }

    fn in_recovery_grace(&self) -> bool {
        now_ms() < self.recovery.lock().unwrap().grace_until_ms
    }

    fn request_reload<R: tauri::Runtime>(
        &self,
        main: &tauri::webview::Webview<R>,
        reason: &'static str,
        detail: u64,
    ) -> ReloadDecision {
        self.request_reload_with(reason, detail, || {
            main.reload().map_err(|error| error.to_string())
        })
    }

    fn request_reload_with<F>(&self, reason: &'static str, detail: u64, reload: F) -> ReloadDecision
    where
        F: FnOnce() -> Result<(), String>,
    {
        let now = now_ms();
        let generation = self.renderer_generation.load(Ordering::SeqCst);
        let grace_until = now.saturating_add(RELOAD_GRACE.as_millis() as u64);
        {
            let mut recovery = self.recovery.lock().unwrap();
            if now < recovery.grace_until_ms {
                drop(recovery);
                self.record(reason, detail, "suppressed_during_recovery");
                self.log_reload_decision(
                    reason,
                    "suppressed_during_recovery",
                    generation,
                    detail,
                    now,
                );
                return ReloadDecision::InRecovery;
            }
            let window_ms = RELOAD_WINDOW.as_millis() as u64;
            while recovery
                .reloads_ms
                .front()
                .is_some_and(|at| now.saturating_sub(*at) >= window_ms)
            {
                recovery.reloads_ms.pop_front();
            }
            if recovery.reloads_ms.len() >= MAX_RELOADS {
                drop(recovery);
                self.record(reason, detail, "rate_limited");
                self.log_reload_decision(reason, "rate_limited", generation, detail, now);
                return ReloadDecision::RateLimited;
            }
            recovery.reloads_ms.push_back(now);
            recovery.grace_until_ms = grace_until;
        }
        let previous_ack = self
            .last_ack_ms
            .swap(ACK_RECOVERY_SENTINEL, Ordering::Relaxed);
        match reload() {
            Ok(()) => {
                // Keep a real acknowledgement that arrived during reload;
                // otherwise begin the replacement page's grace from this
                // decision without leaving the sentinel visible afterward.
                let _ = self.last_ack_ms.compare_exchange(
                    ACK_RECOVERY_SENTINEL,
                    now,
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                );
                self.record(reason, detail, "reload_started");
                self.log_reload_decision(reason, "reload_started", generation, detail, now);
                ReloadDecision::Started
            }
            Err(_error) => {
                // The slot/grace was a reservation closing simultaneous reload
                // races, not a completed attempt. Roll it back when the native
                // reload call itself fails so telemetry and retry timing remain
                // truthful.
                let mut recovery = self.recovery.lock().unwrap();
                if recovery.grace_until_ms == grace_until {
                    recovery.grace_until_ms = 0;
                }
                if let Some(index) = recovery.reloads_ms.iter().rposition(|at| *at == now) {
                    recovery.reloads_ms.remove(index);
                }
                drop(recovery);
                // `reload()` is native work and acknowledgements continue on a
                // different thread while it runs. Restore the old timestamp
                // only if our recovery sentinel is still present;
                // otherwise a live renderer's newer acknowledgement wins.
                let _ = self.last_ack_ms.compare_exchange(
                    ACK_RECOVERY_SENTINEL,
                    previous_ack,
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                );
                self.record(reason, detail, "reload_failed");
                self.log_reload_decision(reason, "reload_failed", generation, detail, now);
                ReloadDecision::Failed
            }
        }
    }

    /// One fixed-shape, content-free release record for every reload decision.
    /// The in-memory incident ring is richer while the native host lives; this
    /// line is what survives renderer and app exits in the 1 MiB resilience log.
    fn log_reload_decision(
        &self,
        reason: &'static str,
        outcome: &'static str,
        generation: u64,
        detail: u64,
        now: u64,
    ) {
        let recovery = self.recovery.lock().unwrap();
        let reloads_in_window = recovery.reloads_ms.len();
        let grace_remaining_ms = recovery.grace_until_ms.saturating_sub(now);
        drop(recovery);
        log::info!(
            "{}",
            reload_decision_message(
                reason,
                outcome,
                generation,
                detail,
                reloads_in_window,
                grace_remaining_ms,
            )
        );
    }

    fn incidents(&self) -> Vec<RecoveryIncident> {
        self.recovery
            .lock()
            .unwrap()
            .incidents
            .iter()
            .cloned()
            .collect()
    }

    pub fn app_exiting(&self, live_ptys: u64) {
        self.record("app_exit", live_ptys, "kill_all_started");
        log::info!("app-exit cleanup: requesting stop for {live_ptys} live PTYs");
    }

    pub fn app_exit_cleanup_returned(&self, requested: u64, force_signals: u64) {
        self.record("app_exit", force_signals, "kill_all_returned");
        log::info!(
            "app-exit cleanup: PTY kill_all returned (requested={requested}, force_signals={force_signals})"
        );
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The webview answers every ping with this. When the answers stop, the
/// renderer is gone (jetsam-killed, crashed, or wedged) and the loop reloads.
#[tauri::command]
pub fn watchdog_ack(state: tauri::State<'_, Arc<WatchdogState>>, generation: u64) {
    state.acknowledge(generation);
}

#[tauri::command]
pub fn watchdog_incidents(state: tauri::State<'_, Arc<WatchdogState>>) -> Vec<RecoveryIncident> {
    state.incidents()
}

/// Apple reports WebContent termination immediately. Route the main renderer
/// through the same coordinator as heartbeat recovery; preview renderers keep
/// their independent tab-level reload.
pub fn web_content_terminated<R: tauri::Runtime>(webview: &tauri::webview::Webview<R>) {
    let label = webview.label().to_string();
    if label == APP_WEBVIEW {
        let state = webview
            .app_handle()
            .state::<Arc<WatchdogState>>()
            .inner()
            .clone();
        log::error!("webview renderer terminated ({label}); coordinating recovery");
        state.request_reload(webview, "native_termination", 0);
    } else {
        log::error!("preview renderer terminated ({label}); reloading preview");
        if let Err(error) = webview.reload() {
            log::error!("preview renderer reload failed ({label}): {error}");
        }
    }
}

/// Snapshot of host memory, emitted on pressure-level changes and served to
/// `memory_info` so the UI can paint the current state the moment it mounts.
#[derive(Clone, Copy, serde::Serialize)]
pub struct MemoryPressure {
    pub level: u8,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub used_bytes: u64,
    pub free_bytes: u64,
}

/// One reading of host memory, as a level. Pure of any process state, so the
/// thresholds are unit-testable. `available` is what the kernel could hand to
/// a new allocation (free + inactive/cached). Truly idle pages are deliberately
/// not a signal: macOS keeps that pool tiny even when most RAM is reclaimable.
pub fn pressure_level(total_bytes: u64, available_bytes: u64) -> u8 {
    let total = total_bytes.max(1) as f64;
    let available_frac = available_bytes as f64 / total;
    if available_frac < 0.05 {
        MEM_CRIT
    } else if available_frac < 0.12 {
        MEM_WARN
    } else {
        MEM_OK
    }
}

#[derive(Clone, Copy)]
struct HostMemorySample {
    total_bytes: u64,
    available_bytes: u64,
    used_bytes: u64,
    free_bytes: u64,
}

fn sysinfo_memory(sys: &mut System) -> HostMemorySample {
    sys.refresh_memory();
    HostMemorySample {
        total_bytes: sys.total_memory(),
        available_bytes: sys.available_memory(),
        used_bytes: sys.used_memory(),
        free_bytes: sys.free_memory(),
    }
}

/// sysinfo 0.33 subtracts every compressed page from free + inactive on macOS.
/// On a healthy machine with a warm compressor that can saturate to zero, even
/// though the inactive/file-backed pages remain reclaimable. Read the same Mach
/// counters directly and keep compressed pages out of the available-page sum.
#[cfg(target_os = "macos")]
#[allow(deprecated)] // libc exposes the SDK call we need; mach2 would duplicate bindings.
fn host_memory(sys: &mut System) -> HostMemorySample {
    let fallback = sysinfo_memory(sys);
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if page_size <= 0 {
        return fallback;
    }

    let mut stats = unsafe { std::mem::zeroed::<libc::vm_statistics64>() };
    let mut count = libc::HOST_VM_INFO64_COUNT;
    let result = unsafe {
        // SAFETY: `stats` is the exact output structure required by
        // HOST_VM_INFO64 and `count` is initialized to its published size.
        libc::host_statistics64(
            libc::mach_host_self(),
            libc::HOST_VM_INFO64,
            &mut stats as *mut libc::vm_statistics64 as *mut _,
            &mut count,
        )
    };
    if result != libc::KERN_SUCCESS {
        return fallback;
    }

    let page_size = page_size as u64;
    // Apple documents speculative pages as already included in free_count.
    let free_pages = u64::from(stats.free_count).saturating_sub(u64::from(stats.speculative_count));
    let available_pages = u64::from(stats.free_count)
        .saturating_add(u64::from(stats.inactive_count))
        .saturating_add(u64::from(stats.purgeable_count));
    let available_bytes = available_pages
        .saturating_mul(page_size)
        .min(fallback.total_bytes);
    HostMemorySample {
        total_bytes: fallback.total_bytes,
        available_bytes,
        used_bytes: fallback.total_bytes.saturating_sub(available_bytes),
        free_bytes: free_pages.saturating_mul(page_size),
    }
}

#[cfg(not(target_os = "macos"))]
fn host_memory(sys: &mut System) -> HostMemorySample {
    sysinfo_memory(sys)
}

pub(crate) fn memory_pressure(sys: &mut System) -> MemoryPressure {
    let sample = host_memory(sys);
    MemoryPressure {
        level: pressure_level(sample.total_bytes, sample.available_bytes),
        total_bytes: sample.total_bytes,
        available_bytes: sample.available_bytes,
        used_bytes: sample.used_bytes,
        free_bytes: sample.free_bytes,
    }
}

/// A ping is stale when it has gone unanswered longer than `stale_ms`.
pub fn ping_is_stale(age_ms: u64, stale_ms: u64) -> bool {
    age_ms >= stale_ms
}

/// Refresh previews only while pressure is getting worse. A downward critical
/// -> warning transition means the first refresh worked and must not trigger a
/// second, user-visible reload.
fn should_relieve_memory(previous: u8, current: u8) -> bool {
    current > previous && current >= MEM_WARN
}

/// Start both loops. Called once from setup, alongside the other resident
/// threads (pty monitor, hook bridge, maintenance).
pub fn start(app: AppHandle) {
    start_webview_watchdog(app.clone());
    start_memory_watchdog(app);
}

/// Resolve the app UI and its containing window independently. A
/// `WebviewWindow` only exists while that window contains exactly one webview;
/// opening a native preview adds a child and makes `get_webview_window("main")`
/// return `None` even though both the app UI and window are still alive.
fn app_surface<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<(tauri::webview::Webview<R>, tauri::Window<R>)> {
    Some((app.get_webview(APP_WEBVIEW)?, app.get_window(APP_WEBVIEW)?))
}

fn start_webview_watchdog(app: AppHandle) {
    let ack = app.state::<Arc<WatchdogState>>().inner().clone();
    std::thread::Builder::new()
        .name("webview-watchdog".into())
        .spawn(move || {
            let mut heartbeat = HeartbeatTracker::default();
            loop {
                std::thread::sleep(PING_EVERY);
                // Only the main webview. Previews and browser tabs have their
                // own lifecycles; a dead renderer in one of those is a lost
                // tab, not a dead app, and reloading it would drop the user's
                // place without fixing anything.
                let Some((main, window)) = app_surface(&app) else {
                    log::info!("webview-watchdog: main window gone; stopping");
                    return;
                };
                let on_screen =
                    window.is_visible().unwrap_or(true) && !window.is_minimized().unwrap_or(false);
                if !on_screen {
                    // A hidden or minimized webview is throttled by WebKit and
                    // may legitimately not run JS — and its death is not
                    // something the user can see anyway. Skip enforcement.
                    // Never carry an expired pressure-probe deadline through a
                    // minimized interval. On restore the renderer gets a fresh
                    // observation window before any recovery action.
                    heartbeat = HeartbeatTracker::default();
                    continue;
                }
                if ack.in_recovery_grace() {
                    heartbeat = HeartbeatTracker::default();
                    continue;
                }
                let age_ms = now_ms().saturating_sub(ack.last_ack_ms.load(Ordering::Relaxed));
                let delivered = app.emit("watchdog:ping", ()).is_ok();
                let stale = !delivered
                    || ping_is_stale(age_ms, STALE_AFTER.as_millis() as u64);
                match heartbeat.observe(now_ms(), stale) {
                    HeartbeatAction::Healthy | HeartbeatAction::Waiting => {}
                    HeartbeatAction::RecoveredAfterShed => {
                        ack.record("heartbeat_pressure_probe", age_ms, "recovered");
                    }
                    HeartbeatAction::BeginPressureShed => {
                        let released = app
                            .state::<crate::browser::BrowserManager>()
                            .reload_for_memory_pressure(&app, false)
                            .len() as u64;
                        ack.record("heartbeat_pressure_probe", released, "started");
                    }
                    HeartbeatAction::Reload => {
                        // Same-event-loop liveness cannot distinguish a dead
                        // renderer from prolonged JS starvation. One bounded
                        // native shed probe has now also failed.
                        log::error!(
                            "webview-watchdog: renderer heartbeat stalled (ack {}ms stale); requesting recovery",
                            age_ms
                        );
                        match ack.request_reload(&main, "heartbeat_stall", age_ms) {
                            ReloadDecision::Started | ReloadDecision::InRecovery => {}
                            ReloadDecision::RateLimited => {
                                // Do not restart the miss/probe cycle and reload
                                // hidden previews forever after the main reload
                                // limiter has already refused further churn.
                                heartbeat.suppress_for(now_ms(), RELOAD_WINDOW);
                            }
                            ReloadDecision::Failed => {
                                // A native reload failure may be transient, but
                                // retrying every few pings creates its own churn.
                                heartbeat.suppress_for(now_ms(), RELOAD_GRACE);
                            }
                        }
                    }
                }
            }
        })
        .expect("spawn webview-watchdog");
}

fn start_memory_watchdog(app: AppHandle) {
    std::thread::Builder::new()
        .name("memory-watchdog".into())
        .spawn(move || {
            let mut sys = System::new();
            let mut last: u8 = MEM_OK;
            loop {
                std::thread::sleep(MEM_POLL_EVERY);
                let p = memory_pressure(&mut sys);
                if p.level != last {
                    let previous = last;
                    last = p.level;
                    if p.level >= MEM_WARN {
                        let avail = p.available_bytes as f64 / p.total_bytes.max(1) as f64;
                        log::warn!(
                            "memory-watchdog: pressure level {} ({:.0}% of {} bytes available)",
                            p.level,
                            avail * 100.0,
                            p.total_bytes
                        );
                    }
                    // Shed the reloadable WebKit heaps before macOS chooses a
                    // renderer to terminate. Warning pressure refreshes only
                    // hidden previews; critical pressure refreshes all native
                    // previews. Only act while pressure is rising so recovery
                    // from critical -> warning does not cause another reload.
                    if should_relieve_memory(previous, p.level) {
                        let tabs = app
                            .state::<crate::browser::BrowserManager>()
                            .reload_for_memory_pressure(&app, p.level >= MEM_CRIT);
                        if !tabs.is_empty() {
                            log::warn!(
                                "memory-watchdog: reloaded {} preview(s) to release memory: {}",
                                tabs.len(),
                                tabs.join(", ")
                            );
                        }
                    }
                    let _ = app.emit("memory:pressure", p);
                }
            }
        })
        .expect("spawn memory-watchdog");
}

/// On-demand snapshot, for the UI to paint current pressure the moment it
/// mounts rather than waiting for the first level *change*.
#[tauri::command]
pub fn memory_info() -> MemoryPressure {
    let mut sys = System::new();
    memory_pressure(&mut sys)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::{LogicalPosition, LogicalSize, WebviewUrl};

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        tauri::WebviewWindowBuilder::new(&app, APP_WEBVIEW, WebviewUrl::default())
            .build()
            .unwrap();
        app
    }

    fn open_preview(app: &tauri::App<tauri::test::MockRuntime>) {
        app.get_window(APP_WEBVIEW)
            .unwrap()
            .add_child(
                tauri::webview::WebviewBuilder::new("browser-preview", WebviewUrl::default()),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(100.0, 100.0),
            )
            .unwrap();
    }

    #[test]
    fn pressure_level_thresholds() {
        // 50% available: fine.
        assert_eq!(pressure_level(100, 50), MEM_OK);
        // 10% available: warn.
        assert_eq!(pressure_level(100, 10), MEM_WARN);
        // 3% available: critical.
        assert_eq!(pressure_level(100, 3), MEM_CRIT);
        // A tiny truly-free pool is normal when the OS has reclaimable cache.
        // Only the available figure belongs in the pressure decision.
        assert_eq!(pressure_level(100, 30), MEM_OK);
        // A machine with nothing left at all.
        assert_eq!(pressure_level(1, 0), MEM_CRIT);
    }

    #[test]
    fn stale_renderer_cannot_keep_the_watchdog_alive() {
        let state = WatchdogState::default();
        state.renderer_registered(4);
        state.last_ack_ms.store(1, Ordering::Relaxed);
        assert!(!state.acknowledge(3));
        assert_eq!(state.last_ack_ms.load(Ordering::Relaxed), 1);
        assert!(state.acknowledge(4));
        assert!(state.last_ack_ms.load(Ordering::Relaxed) > 1);
    }

    #[test]
    fn recovery_incident_history_is_bounded() {
        let state = WatchdogState::default();
        state.renderer_registered(1);
        for index in 0..(INCIDENTS_MAX + 50) {
            state.record("test", index as u64, "observed");
        }
        let incidents = state.incidents();
        assert_eq!(incidents.len(), INCIDENTS_MAX);
        assert_eq!(
            incidents.last().unwrap().detail,
            (INCIDENTS_MAX + 49) as u64
        );
    }

    #[test]
    fn app_exit_records_the_live_pty_count_before_cleanup() {
        let state = WatchdogState::default();
        state.renderer_registered(9);
        state.app_exiting(4);
        let incident = state.incidents().pop().unwrap();
        assert_eq!(incident.kind, "app_exit");
        assert_eq!(incident.generation, 9);
        assert_eq!(incident.detail, 4);
        assert_eq!(incident.outcome, "kill_all_started");

        state.app_exit_cleanup_returned(4, 1);
        let incident = state.incidents().pop().unwrap();
        assert_eq!(incident.kind, "app_exit");
        assert_eq!(incident.generation, 9);
        assert_eq!(incident.detail, 1);
        assert_eq!(incident.outcome, "kill_all_returned");
    }

    #[test]
    fn simultaneous_recovery_triggers_start_only_one_reload() {
        let app = mock_app();
        let main = app.get_webview(APP_WEBVIEW).unwrap();
        let state = WatchdogState::default();
        state.renderer_registered(7);
        assert_eq!(
            state.request_reload(&main, "native_termination", 0),
            ReloadDecision::Started
        );
        assert_eq!(
            state.request_reload(&main, "heartbeat_stall", 30_000),
            ReloadDecision::InRecovery
        );
        assert!(state
            .incidents()
            .iter()
            .any(|incident| incident.outcome == "suppressed_during_recovery"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_host_snapshot_uses_consistent_reclaimable_memory() {
        let mut sys = System::new();
        let sample = host_memory(&mut sys);
        assert!(sample.total_bytes > 0);
        assert!(sample.free_bytes <= sample.available_bytes);
        assert_eq!(
            sample.used_bytes.saturating_add(sample.available_bytes),
            sample.total_bytes
        );
    }

    #[test]
    fn ping_staleness_and_reload_trigger() {
        assert!(!ping_is_stale(8_999, 9_000));
        assert!(ping_is_stale(9_000, 9_000));
    }

    #[test]
    fn heartbeat_allows_exactly_one_bounded_pressure_shed_probe() {
        let mut tracker = HeartbeatTracker::default();
        assert_eq!(tracker.observe(0, true), HeartbeatAction::Waiting);
        assert_eq!(tracker.observe(3_000, true), HeartbeatAction::Waiting);
        assert_eq!(
            tracker.observe(6_000, true),
            HeartbeatAction::BeginPressureShed
        );
        assert_eq!(tracker.observe(8_999, true), HeartbeatAction::Waiting);
        assert_eq!(tracker.observe(9_000, true), HeartbeatAction::Reload);
        assert_eq!(tracker.probe_deadline_ms, None);
    }

    #[test]
    fn heartbeat_probe_recovery_resets_the_tracker() {
        let mut tracker = HeartbeatTracker::default();
        tracker.observe(0, true);
        tracker.observe(3_000, true);
        tracker.observe(6_000, true);
        assert_eq!(
            tracker.observe(7_000, false),
            HeartbeatAction::RecoveredAfterShed
        );
        assert_eq!(tracker.observe(10_000, false), HeartbeatAction::Healthy);
    }

    #[test]
    fn long_slow_startup_with_early_heartbeat_never_arms_recovery() {
        let mut tracker = HeartbeatTracker::default();
        // Models two minutes of Monaco/React startup while the listener
        // installed in main.tsx continues acknowledging from the same page.
        // The startup duration itself must not accumulate stale misses.
        for now in (0..=120_000).step_by(PING_EVERY.as_millis() as usize) {
            assert_eq!(tracker.observe(now, false), HeartbeatAction::Healthy);
            assert_eq!(tracker.misses, 0);
            assert_eq!(tracker.probe_deadline_ms, None);
        }
    }

    #[test]
    fn repeated_event_loop_stalls_get_one_probe_each_and_recover_without_reload() {
        let mut tracker = HeartbeatTracker::default();
        let mut pressure_sheds = 0;
        let mut reloads = 0;
        for cycle in 0..1_000_u64 {
            let base = cycle * 20_000;
            for offset in [0, 3_000, 6_000] {
                match tracker.observe(base + offset, true) {
                    HeartbeatAction::BeginPressureShed => pressure_sheds += 1,
                    HeartbeatAction::Reload => reloads += 1,
                    _ => {}
                }
            }
            assert_eq!(
                tracker.observe(base + 7_000, false),
                HeartbeatAction::RecoveredAfterShed
            );
        }
        assert_eq!(pressure_sheds, 1_000);
        assert_eq!(reloads, 0);
    }

    #[test]
    fn a_genuine_sustained_stall_has_a_bounded_single_escalation() {
        let mut tracker = HeartbeatTracker::default();
        let observations = [0, 3_000, 6_000, 8_999, 9_000].map(|now| tracker.observe(now, true));
        assert_eq!(
            observations,
            [
                HeartbeatAction::Waiting,
                HeartbeatAction::Waiting,
                HeartbeatAction::BeginPressureShed,
                HeartbeatAction::Waiting,
                HeartbeatAction::Reload,
            ]
        );
        // The caller suppresses the tracker for the recovery window after the
        // one reload decision. No second pressure probe may churn previews.
        tracker.suppress_for(9_000, RELOAD_WINDOW);
        for now in (12_000..60_000).step_by(PING_EVERY.as_millis() as usize) {
            assert_eq!(tracker.observe(now, true), HeartbeatAction::Waiting);
        }
    }

    #[test]
    fn minimized_interval_discards_an_expired_probe_deadline() {
        let mut tracker = HeartbeatTracker::default();
        tracker.observe(0, true);
        tracker.observe(3_000, true);
        assert_eq!(
            tracker.observe(6_000, true),
            HeartbeatAction::BeginPressureShed
        );
        // This is what the window-hidden branch does before observations resume.
        tracker = HeartbeatTracker::default();
        assert_eq!(tracker.observe(60_000, true), HeartbeatAction::Waiting);
    }

    #[test]
    fn reload_suppression_prevents_repeated_pressure_probe_churn() {
        let mut tracker = HeartbeatTracker::default();
        tracker.suppress_for(10_000, RELOAD_WINDOW);
        assert_eq!(tracker.observe(20_000, true), HeartbeatAction::Waiting);
        assert_eq!(tracker.observe(20_000, false), HeartbeatAction::Healthy);
        assert_eq!(tracker.observe(23_000, true), HeartbeatAction::Waiting);
    }

    #[test]
    fn failed_native_reload_rolls_back_slot_grace_and_ack() {
        let state = WatchdogState::default();
        state.renderer_registered(3);
        let previous_ack = state.last_ack_ms.load(Ordering::Relaxed);
        assert_eq!(
            state.request_reload_with("test_failure", 7, || Err("no surface".into())),
            ReloadDecision::Failed
        );
        assert_eq!(state.last_ack_ms.load(Ordering::Relaxed), previous_ack);
        let recovery = state.recovery.lock().unwrap();
        assert_eq!(recovery.grace_until_ms, 0);
        assert!(recovery.reloads_ms.is_empty());
        drop(recovery);
        assert!(state
            .incidents()
            .iter()
            .any(|incident| incident.outcome == "reload_failed"));
    }

    #[test]
    fn failed_native_reload_does_not_clobber_a_racing_ack() {
        let state = WatchdogState::default();
        state.renderer_registered(3);
        let racing_ack = state.last_ack_ms.load(Ordering::Relaxed).saturating_add(1);
        assert_eq!(
            state.request_reload_with("test_failure", 7, || {
                // Models a heartbeat acknowledgement (or replacement renderer
                // registration) arriving while the native reload call runs.
                state.last_ack_ms.store(racing_ack, Ordering::Relaxed);
                Err("no surface".into())
            }),
            ReloadDecision::Failed
        );
        assert_eq!(state.last_ack_ms.load(Ordering::Relaxed), racing_ack);
    }

    #[test]
    fn successful_native_reload_keeps_a_racing_ack_and_never_leaves_the_sentinel() {
        let state = WatchdogState::default();
        state.renderer_registered(3);
        let racing_ack = state.last_ack_ms.load(Ordering::Relaxed).saturating_add(1);
        assert_eq!(
            state.request_reload_with("test_success", 8, || {
                state.last_ack_ms.store(racing_ack, Ordering::Relaxed);
                Ok(())
            }),
            ReloadDecision::Started
        );
        assert_eq!(state.last_ack_ms.load(Ordering::Relaxed), racing_ack);

        let clean = WatchdogState::default();
        clean.renderer_registered(4);
        assert_eq!(
            clean.request_reload_with("test_success", 9, || Ok(())),
            ReloadDecision::Started
        );
        assert_ne!(
            clean.last_ack_ms.load(Ordering::Relaxed),
            ACK_RECOVERY_SENTINEL
        );
    }

    #[test]
    fn release_reload_decision_record_has_only_fixed_scalar_fields() {
        assert_eq!(
            reload_decision_message("heartbeat_stall", "reload_started", 4, 9_001, 2, 45_000),
            "webview-recovery decision reason=heartbeat_stall outcome=reload_started generation=4 detail=9001 reloads_in_window=2 grace_remaining_ms=45000"
        );
    }

    #[test]
    fn memory_relief_only_runs_as_pressure_rises() {
        assert!(!should_relieve_memory(MEM_OK, MEM_OK));
        assert!(should_relieve_memory(MEM_OK, MEM_WARN));
        assert!(should_relieve_memory(MEM_WARN, MEM_CRIT));
        assert!(!should_relieve_memory(MEM_CRIT, MEM_WARN));
        assert!(!should_relieve_memory(MEM_WARN, MEM_OK));
    }

    #[test]
    fn watchdog_keeps_its_main_surface_after_a_preview_opens() {
        let app = mock_app();
        open_preview(&app);

        // This is the representation the watchdog used before: Tauri drops it
        // once the window hosts a child webview.
        assert!(app.get_webview_window(APP_WEBVIEW).is_none());

        let (view, window) = app_surface(app.handle()).expect("main surface should survive");
        assert_eq!(view.label(), APP_WEBVIEW);
        assert_eq!(window.label(), APP_WEBVIEW);
    }
}
