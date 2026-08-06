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
//! The same scenario caught on the way in: sample host memory and tell the UI
//! to shed load (close previews, hibernate projects) before the system decides
//! to take the renderer itself.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use sysinfo::System;
use tauri::{AppHandle, Emitter, Manager};

/// How often the webview is asked to say it is alive.
const PING_EVERY: Duration = Duration::from_secs(3);
/// A ping unanswered for longer than this counts as missed.
const STALE_AFTER: Duration = Duration::from_secs(9);
/// Consecutive stale readings before the webview is reloaded.
const MISSES_BEFORE_RELOAD: u32 = 3;
/// Grace after a reload before enforcement resumes — the fresh page needs
/// time to boot before it can start answering pings.
const RELOAD_GRACE: Duration = Duration::from_secs(45);
/// Reload at most this many times…
const MAX_RELOADS: usize = 3;
/// …within this window. Beyond that the renderer death is not transient and
/// reloading is just churn; the watchdog stops and logs instead.
const RELOAD_WINDOW: Duration = Duration::from_secs(10 * 60);

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
}

impl Default for WatchdogState {
    fn default() -> Self {
        Self {
            last_ack_ms: AtomicU64::new(now_ms()),
        }
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
pub fn watchdog_ack(state: tauri::State<'_, Arc<WatchdogState>>) {
    state.last_ack_ms.store(now_ms(), Ordering::Relaxed);
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

fn memory_pressure(sys: &mut System) -> MemoryPressure {
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

/// Enough consecutive stale pings to reload the webview.
pub fn misses_trigger_reload(misses: u32, threshold: u32) -> bool {
    misses >= threshold
}

/// Start both loops. Called once from setup, alongside the other resident
/// threads (pty monitor, hook bridge, maintenance).
pub fn start(app: AppHandle) {
    start_webview_watchdog(app.clone());
    start_memory_watchdog(app);
}

fn start_webview_watchdog(app: AppHandle) {
    let ack = app.state::<Arc<WatchdogState>>().inner().clone();
    std::thread::Builder::new()
        .name("webview-watchdog".into())
        .spawn(move || {
            let mut misses: u32 = 0;
            let mut reloads: Vec<Instant> = Vec::new();
            let mut grace_until = Instant::now() + RELOAD_GRACE;
            loop {
                std::thread::sleep(PING_EVERY);
                // Only the main webview. Previews and browser tabs have their
                // own lifecycles; a dead renderer in one of those is a lost
                // tab, not a dead app, and reloading it would drop the user's
                // place without fixing anything.
                let Some(main) = app.get_webview_window("main") else {
                    log::info!("webview-watchdog: main window gone; stopping");
                    return;
                };
                let on_screen =
                    main.is_visible().unwrap_or(true) && !main.is_minimized().unwrap_or(false);
                if !on_screen {
                    // A hidden or minimized webview is throttled by WebKit and
                    // may legitimately not run JS — and its death is not
                    // something the user can see anyway. Skip enforcement.
                    continue;
                }
                if Instant::now() < grace_until {
                    continue;
                }
                let age_ms = now_ms().saturating_sub(ack.last_ack_ms.load(Ordering::Relaxed));
                let delivered = app.emit("watchdog:ping", ()).is_ok();
                if delivered && !ping_is_stale(age_ms, STALE_AFTER.as_millis() as u64) {
                    misses = 0;
                    continue;
                }
                misses += 1;
                if !misses_trigger_reload(misses, MISSES_BEFORE_RELOAD) {
                    continue;
                }
                // A genuine death. Reload — but only so many times in a window
                // before calling it non-transient and giving up.
                let now = Instant::now();
                reloads.retain(|t| now.duration_since(*t) < RELOAD_WINDOW);
                if reloads.len() >= MAX_RELOADS {
                    log::error!(
                        "webview-watchdog: {MAX_RELOADS} reloads in {}s; giving up",
                        RELOAD_WINDOW.as_secs()
                    );
                    return;
                }
                log::error!(
                    "webview-watchdog: webview unresponsive (ack {}ms stale); reloading",
                    age_ms
                );
                reloads.push(now);
                grace_until = now + RELOAD_GRACE;
                misses = 0;
                ack.last_ack_ms.store(now_ms(), Ordering::Relaxed);
                if let Err(e) = main.reload() {
                    log::error!("webview-watchdog: reload failed: {e}");
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
        assert!(!misses_trigger_reload(2, 3));
        assert!(misses_trigger_reload(3, 3));
    }
}
