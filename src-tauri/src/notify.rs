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
//!
//! Whether something may interrupt while Canopy is in front is the frontend's
//! call (`shouldReachOS` in `src/attention.ts`): a teammate's message does,
//! everything else waits for the window to lose focus. macOS has its own rule
//! — `NSUserNotificationCenter` files a notification from the frontmost app
//! straight into Notification Center without a banner unless its delegate
//! answers `shouldPresentNotification:` with YES — and mac_notification_sys's
//! delegate does not implement that method. So without
//! `present_while_frontmost`, a bundled Canopy that is in front silently
//! swallowed every banner the frontend asked for. (A dev build posts as
//! Terminal, which is usually not frontmost, so dev builds could still show it.)

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
    present_while_frontmost();

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

/// Teach mac_notification_sys's `NotificationCenterDelegate` to answer
/// `userNotificationCenter:shouldPresentNotification:` with YES, so a banner
/// shows even while Canopy is the frontmost app. macOS only asks when it has
/// already decided not to present, so this never adds a banner the frontend
/// did not request — the decision of who may interrupt stays in
/// `shouldReachOS`. Added at runtime because the delegate class lives inside
/// the crate's Objective-C; skipped if a future crate version implements it.
#[cfg(target_os = "macos")]
fn present_while_frontmost() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
        use objc2::{sel, Encode};

        extern "C-unwind" fn should_present(
            _this: *mut AnyObject,
            _cmd: Sel,
            _center: *mut AnyObject,
            _notification: *mut AnyObject,
        ) -> Bool {
            Bool::YES
        }

        let Some(cls) = AnyClass::get(c"NotificationCenterDelegate") else {
            return;
        };
        let selector = sel!(userNotificationCenter:shouldPresentNotification:);
        if cls.responds_to(selector) {
            return;
        }
        // BOOL, self, _cmd, center, notification.
        let Ok(types) = std::ffi::CString::new(format!("{}@:@@", Bool::ENCODING)) else {
            return;
        };
        // SAFETY: the function matches the selector's signature and the type
        // string just built for it; `class_addMethod` copies the string.
        unsafe {
            let imp: Imp = std::mem::transmute(
                should_present
                    as extern "C-unwind" fn(
                        *mut AnyObject,
                        Sel,
                        *mut AnyObject,
                        *mut AnyObject,
                    ) -> Bool,
            );
            objc2::ffi::class_addMethod(
                cls as *const AnyClass as *mut AnyClass,
                selector,
                imp,
                types.as_ptr(),
            );
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::present_while_frontmost;
    use objc2::runtime::AnyClass;
    use objc2::sel;

    /// The delegate mac_notification_sys installs must let banners through
    /// while Canopy is frontmost; without it a focused app never shows one.
    #[test]
    fn delegate_presents_while_frontmost() {
        let cls = AnyClass::get(c"NotificationCenterDelegate")
            .expect("mac_notification_sys links its delegate class");
        let selector = sel!(userNotificationCenter:shouldPresentNotification:);
        // The crate's delegate lacks it — the root cause. If a future version
        // implements it, this fails and the runtime hook can go.
        assert!(!cls.responds_to(selector));
        present_while_frontmost();
        assert!(cls.responds_to(selector));
    }
}
