//! When the main window freezes, sample its WebKit renderer for two seconds
//! and log what its main thread was doing as counts per class (script, GC,
//! layout...). Only codes and counts reach the log; the sample file is deleted.
#![cfg_attr(not(target_os = "macos"), allow(dead_code, unused_imports))]

use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
use std::time::Duration;

/// The main webview's renderer pid, read while it is healthy (0 = unknown).
static RENDERER_PID: AtomicI32 = AtomicI32::new(0);
static PID_READ_AT_MS: AtomicU64 = AtomicU64::new(0);
const PID_REFRESH_MS: u64 = 60_000;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct MainThread {
    pub total: u32,
    pub gc: u32,
    pub wasm: u32,
    pub layout: u32,
    pub style: u32,
    pub paint: u32,
    pub ipc_sync: u32,
    pub js: u32,
    pub idle: u32,
}

impl MainThread {
    /// The deepest class holding at least 30% of samples; script that forces
    /// layout counts as layout, script that triggers GC as GC.
    pub fn verdict(&self) -> &'static str {
        if self.total == 0 {
            return "no-main-thread";
        }
        let share = |n: u32| n * 100 / self.total >= 30;
        for (n, code) in [
            (self.gc, "gc"),
            (self.wasm, "wasm"),
            (self.layout, "layout"),
            (self.style, "style"),
            (self.paint, "paint"),
            (self.ipc_sync, "ipc-sync"),
            (self.js, "js"),
        ] {
            if share(n) {
                return code;
            }
        }
        if self.idle * 100 / self.total >= 50 {
            "idle"
        } else {
            "mixed"
        }
    }
}

/// Classify the main thread of a macOS `sample` report.
pub fn classify(report: &str) -> MainThread {
    let mut m = MainThread::default();
    let mut in_main = false;
    for line in report.lines() {
        let header = line.contains(" Thread_") && !line.trim_start().starts_with('+');
        if header {
            if in_main {
                break;
            }
            if line.contains("com.apple.main-thread") {
                in_main = true;
                m.total = count(line);
            }
            continue;
        }
        if !in_main {
            continue;
        }
        let n = count(line);
        let bump = |slot: &mut u32| *slot = (*slot).max(n);
        if line.contains("JSC::Heap::") || line.contains("GCActivityCallback") {
            bump(&mut m.gc);
        }
        if line.contains("JSC::Wasm") || line.contains("wasm") {
            bump(&mut m.wasm);
        }
        if line.contains("LayoutContext::layout") || line.contains("WebCore::Layout::") {
            bump(&mut m.layout);
        }
        if line.contains("Style::TreeResolver") || line.contains("Document::resolveStyle") {
            bump(&mut m.style);
        }
        if line.contains("RenderLayer::paint") || line.contains("GraphicsLayerCA::") {
            bump(&mut m.paint);
        }
        if line.contains("waitForSyncReply") || line.contains("sendSyncMessage") {
            bump(&mut m.ipc_sync);
        }
        if line.contains("vmEntryToJavaScript") || line.contains("JSC::Interpreter::execute") {
            bump(&mut m.js);
        }
        if line.contains("__CFRunLoopServiceMachPort") {
            bump(&mut m.idle);
        }
    }
    m
}

/// The sample count at the start of a report line, after the tree glyphs.
fn count(line: &str) -> u32 {
    let rest = line.trim_start_matches(|c: char| c.is_whitespace() || "+!:|".contains(c));
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().unwrap_or(0)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// What the main thread reports about the window (pid, occluded, key), or
/// None when it did not answer within `wait`.
#[cfg(target_os = "macos")]
fn window_facts<R: tauri::Runtime>(
    view: &tauri::webview::Webview<R>,
    wait: Duration,
) -> Option<(i32, Option<bool>, Option<bool>)> {
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel};
    let (tx, rx) = std::sync::mpsc::channel();
    view.with_webview(move |webview| {
        let ptr = webview.inner() as *mut AnyObject;
        let Some(obj) = (unsafe { ptr.as_ref() }) else {
            let _ = tx.send((0, None, None));
            return;
        };
        let facts = objc2::exception::catch(std::panic::AssertUnwindSafe(|| unsafe {
            let has_pid: bool = msg_send![obj, respondsToSelector: sel!(_webProcessIdentifier)];
            let pid: i32 = if has_pid {
                msg_send![obj, _webProcessIdentifier]
            } else {
                0
            };
            let window: *mut AnyObject = msg_send![obj, window];
            match window.as_ref() {
                Some(w) => {
                    let state: usize = msg_send![w, occlusionState];
                    let key: bool = msg_send![w, isKeyWindow];
                    // NSWindowOcclusionStateVisible = 1 << 1.
                    (pid, Some(state & 2 == 0), Some(key))
                }
                None => (pid, None, None),
            }
        }))
        .unwrap_or((0, None, None));
        let _ = tx.send(facts);
    })
    .ok()?;
    rx.recv_timeout(wait).ok()
}

/// Remember the renderer pid while the window is healthy.
#[cfg(target_os = "macos")]
pub fn refresh_pid<R: tauri::Runtime>(view: &tauri::webview::Webview<R>) {
    let now = now_ms();
    if now.saturating_sub(PID_READ_AT_MS.load(Ordering::Relaxed)) < PID_REFRESH_MS {
        return;
    }
    PID_READ_AT_MS.store(now, Ordering::Relaxed);
    if let Some((pid, _, _)) = window_facts(view, Duration::from_secs(1)) {
        if pid > 0 {
            RENDERER_PID.store(pid, Ordering::Relaxed);
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn refresh_pid<R: tauri::Runtime>(_view: &tauri::webview::Webview<R>) {}

/// Sample the frozen renderer and log one content-free line. Takes about 2s.
#[cfg(target_os = "macos")]
pub fn log_freeze<R: tauri::Runtime>(view: &tauri::webview::Webview<R>) {
    let facts = window_facts(view, Duration::from_millis(500));
    let flag = |v: Option<bool>| match v {
        Some(true) => "yes",
        Some(false) => "no",
        None => "unknown",
    };
    let (occluded, key) = match facts {
        Some((_, o, k)) => (flag(o), flag(k)),
        None => ("unknown", "unknown"),
    };
    let app_main = if facts.is_some() {
        "responsive"
    } else {
        "unresponsive"
    };
    let pid = match facts {
        Some((pid, _, _)) if pid > 0 => pid,
        _ => RENDERER_PID.load(Ordering::Relaxed),
    };
    let summary = if pid > 0 { sample(pid) } else { None };
    match summary {
        Some(m) => log::warn!(
            "freeze-sample: main={} total={} gc={} wasm={} layout={} style={} paint={} ipc_sync={} js={} idle={} app_main={app_main} occluded={occluded} key={key}",
            m.verdict(), m.total, m.gc, m.wasm, m.layout, m.style, m.paint, m.ipc_sync, m.js, m.idle
        ),
        None => log::warn!(
            "freeze-sample: main=not-sampled pid_known={} app_main={app_main} occluded={occluded} key={key}",
            pid > 0
        ),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn log_freeze<R: tauri::Runtime>(_view: &tauri::webview::Webview<R>) {}

#[cfg(target_os = "macos")]
fn sample(pid: i32) -> Option<MainThread> {
    use std::process::{Command, Stdio};
    let path = std::env::temp_dir().join(format!("canopy-freeze-{pid}.txt"));
    let mut child = Command::new("/usr/bin/sample")
        .arg(pid.to_string())
        .arg("2")
        .arg("-mayDie")
        .arg("-file")
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    let finished = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(100))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let report = std::fs::read_to_string(&path).ok();
    let _ = std::fs::remove_file(&path);
    if !finished {
        return None;
    }
    report.map(|r| classify(&r))
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPORT: &str = "Analysis of sampling com.apple.WebKit.WebContent (pid 1) every 1 millisecond
Call graph:
    1000 Thread_1   DispatchQueue_1: com.apple.main-thread  (serial)
    + 1000 start  (in dyld) + 6000  [0x1]
    +   990 WebCore::timerFired(__CFRunLoopTimer*, void*)  (in WebCore) + 76  [0x2]
    +   ! 980 vmEntryToJavaScript  (in JavaScriptCore) + 1  [0x3]
    +   ! : 700 WebCore::LocalFrameViewLayoutContext::layout()  (in WebCore) + 1  [0x4]
    +   ! : | 100 JSC::Heap::collectIfNecessaryOrDefer(JSC::GCDeferralContext*)  (in JavaScriptCore) + 1  [0x5]
    +   10 __CFRunLoopServiceMachPort  (in CoreFoundation) + 1  [0x6]
    900 Thread_2: JavaScriptCore libpas scavenger
    + 900 JSC::Heap::runCurrentPhase  (in JavaScriptCore) + 1  [0x7]
";

    #[test]
    fn counts_only_the_main_thread_and_names_the_deepest_heavy_class() {
        let m = classify(REPORT);
        assert_eq!(m.total, 1000);
        assert_eq!(m.js, 980);
        assert_eq!(m.layout, 700);
        assert_eq!(m.gc, 100, "the scavenger thread is not the main thread");
        assert_eq!(m.idle, 10);
        assert_eq!(m.verdict(), "layout");
    }

    #[test]
    fn an_idle_main_thread_says_idle() {
        let m = MainThread {
            total: 100,
            idle: 95,
            ..Default::default()
        };
        assert_eq!(m.verdict(), "idle");
        assert_eq!(MainThread::default().verdict(), "no-main-thread");
        assert_eq!(
            MainThread {
                total: 100,
                js: 20,
                idle: 20,
                ..Default::default()
            }
            .verdict(),
            "mixed"
        );
    }
}
