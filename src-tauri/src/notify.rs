//! Native notifications that go somewhere when you click them.
//!
//! The stock `@tauri-apps/plugin-notification` path posts a notification and
//! forgets it: on desktop the plugin calls `notify_rust::Notification::show()`,
//! which has no response handler at all. macOS still activates Canopy when the
//! banner is clicked — it was posted under our bundle id — so a click raised
//! the window and dropped the user wherever they happened to be. "An agent
//! finished in project X, terminal 12" arrived as a banner that, clicked, told
//! you nothing about X or 12.
//!
//! So we post them ourselves and keep the click. Every notification carries a
//! `canopy://…` target (see `src/deepLinks.ts`); when the user activates it we
//! raise the window and emit `deep-link` with that target, and the frontend
//! router lands them on the terminal, panel, or — failing that — the project.
//!
//! macOS only, deliberately: `mac_notification_sys` is the one path in this
//! dependency tree that reports a click back. Windows and Linux keep the
//! fire-and-forget plugin behaviour (same crate the plugin itself uses), so a
//! notification still shows, it just can't be routed. Nothing calls a
//! platform-specific API from the frontend — `notify_native` is the one door.

use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{AppHandle, Emitter, Manager};

/// A notification we're still waiting on blocks its thread until the user
/// clicks it, dismisses it, or macOS auto-dismisses the banner — and one that
/// lands in Notification Center is not auto-dismissed, so the thread can sit
/// there for as long as the user ignores it. Cap how many can accumulate; past
/// that, notifications are posted fire-and-forget rather than spawning an
/// unbounded pile of parked threads.
#[cfg(target_os = "macos")]
const MAX_WAITERS: usize = 8;

#[cfg(target_os = "macos")]
static WAITERS: AtomicUsize = AtomicUsize::new(0);

/// Post a native notification.
///
/// `target` is a `canopy://…` deep link; `None` means the notification has
/// nowhere in particular to go, and a click just raises the window.
#[tauri::command]
pub fn notify_native(app: AppHandle, title: String, body: String, target: Option<String>) {
    #[cfg(target_os = "macos")]
    {
        post_macos(app, title, body, target);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = target;
        post_plugin(&app, &title, &body);
    }
}

/// Fallback for platforms with no click reporting: the same call the Tauri
/// plugin makes, minus the JS hop.
#[cfg(not(target_os = "macos"))]
fn post_plugin(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

#[cfg(target_os = "macos")]
fn post_macos(app: AppHandle, title: String, body: String, target: Option<String>) {
    // Which app the notification is attributed to — and therefore which app
    // macOS activates on click. Mirrors what the plugin does: an unbundled dev
    // build has no registered bundle id of its own, so it borrows Terminal's.
    // The click still comes back to us either way; only the app that gets
    // focused differs.
    let ident = if tauri::is_dev() {
        "com.apple.Terminal".to_string()
    } else {
        app.config().identifier.clone()
    };
    // `set_application` is a process-wide `Once` inside mac_notification_sys —
    // first caller wins, later ones are a no-op error we don't care about.
    let _ = mac_notification_sys::set_application(&ident);

    let waiting = WAITERS.load(Ordering::Relaxed) < MAX_WAITERS;
    if waiting {
        WAITERS.fetch_add(1, Ordering::Relaxed);
    }
    // Always off the main thread: waiting for a click blocks, and the callbacks
    // it is waiting for are delivered on the main run loop.
    std::thread::spawn(move || {
        let mut n = mac_notification_sys::Notification::new();
        n.title(&title).message(&body);
        // `wait_for_click` is what makes `send` block for a response instead of
        // returning the moment the banner is delivered.
        n.wait_for_click(waiting).asynchronous(!waiting);
        let res = n.send();
        if waiting {
            WAITERS.fetch_sub(1, Ordering::Relaxed);
        }
        let clicked = matches!(
            res,
            Ok(mac_notification_sys::NotificationResponse::Click)
                | Ok(mac_notification_sys::NotificationResponse::ActionButton(_))
        );
        if clicked {
            activate(&app, target.as_deref());
        }
    });
}

/// Raise the window and hand the target to the frontend router.
///
/// The window, not the webview window — once a preview tab adds a child webview
/// the latter stops resolving (same reason `cli::open_forwarded` does it this
/// way). The event goes out regardless of whether the window was found: a
/// missing window is not a reason to swallow the navigation.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn activate(app: &AppHandle, target: Option<&str>) {
    if let Some(w) = app.get_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit("deep-link", target.unwrap_or("canopy://app"));
}

/// Route a deep link that arrived from outside the app (a forwarded `canopy
/// canopy://…` invocation). Same door as a notification click.
pub fn open_link(app: &AppHandle, target: &str) {
    activate(app, Some(target));
}
