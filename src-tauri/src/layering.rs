//! Punch-through layering (experimental): browser views UNDER the app.
//!
//! The default layering puts each child webview above the whole window, which
//! is why every overlay forces the view to hide behind a freeze-frame
//! (browserHost.ts). This mode inverts the stack: the child views are ordered
//! BELOW the app's own webview, the app webview stops drawing its background,
//! and the DOM leaves a transparent hole where the preview pane is — so a
//! panel sliding over the page simply paints over it, the way an iframe would.
//!
//! What transparency cannot invert is input. The app webview is now the
//! topmost view over the page, so every click, scroll and hover would stop
//! there. `hitTest:` is overridden on it — by re-classing the live instance
//! into a one-method subclass, since wry constructs the view, not us — to
//! return nil inside the pane's rectangle wherever no DOM surface is painted,
//! letting AppKit continue to the browser view beneath. The frontend owns the
//! definition of "painted here": the same occlusion walk that used to decide
//! hide/show now syncs pass (pane) and block (overlay) rects through
//! `browser_set_passthrough`, in the window-client logical points that
//! `browser_set_bounds` already uses.
//!
//! The mode is off unless the frontend switches it on, and every native step
//! degrades to the default layering rather than to a broken one.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::Manager;

#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
pub struct PassRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl PassRect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}

/// Where events fall through to the browser view: inside a pass rect, outside
/// every block rect.
#[derive(Default)]
struct Region {
    pass: Vec<PassRect>,
    block: Vec<PassRect>,
}

static ENABLED: AtomicBool = AtomicBool::new(false);
static REGION: Mutex<Region> = Mutex::new(Region {
    pass: Vec::new(),
    block: Vec::new(),
});

pub fn punch_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Consulted from the hitTest override, on the main thread, per event — so it
/// takes the lock briefly and never blocks on anything else.
fn pass_through_at(x: f64, y: f64) -> bool {
    if !punch_enabled() {
        return false;
    }
    let r = REGION.lock().unwrap();
    r.pass.iter().any(|p| p.contains(x, y)) && !r.block.iter().any(|b| b.contains(x, y))
}

/// The frontend's current answer to "where is the page, and what covers it",
/// in window-client logical points (the browser_set_bounds space).
#[tauri::command]
pub fn browser_set_passthrough(
    pass: Vec<PassRect>,
    block: Vec<PassRect>,
) -> Result<(), String> {
    let mut r = REGION.lock().unwrap();
    r.pass = pass;
    r.block = block;
    Ok(())
}

/// Switch layering modes. `background` is the app's own colour, painted on the
/// window so the DOM's newly-transparent gaps don't flash the platform default.
/// Existing browser views are reordered in place; new ones consult the flag at
/// creation (browser.rs).
#[tauri::command]
pub fn browser_set_layering(
    app: tauri::AppHandle,
    punch: bool,
    background: Option<Vec<u8>>,
) -> Result<(), String> {
    let was = ENABLED.swap(punch, Ordering::Relaxed);
    native::apply(&app, punch, background)?;
    if was != punch {
        let mgr = app.state::<crate::browser::BrowserManager>();
        for label in mgr.labels() {
            if let Some(wv) = app.get_webview(&label) {
                if punch {
                    native::send_to_back(&wv);
                } else {
                    native::bring_to_front(&wv);
                }
            }
        }
    }
    Ok(())
}

/// A browser view was just created; put it on the right side of the app.
pub fn place_new_view(view: &tauri::webview::Webview) {
    if punch_enabled() {
        native::send_to_back(view);
    }
}

#[cfg(all(desktop, target_os = "macos"))]
mod native {
    use super::pass_through_at;
    use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
    use objc2::{msg_send, sel};
    use objc2_app_kit::{NSView, NSWindowOrderingMode};
    use objc2_foundation::{NSNumber, NSPoint, NSString};
    use objc2_web_kit::WKWebView;
    use std::ffi::CString;
    use std::sync::OnceLock;
    use tauri::Manager;

    /// The class the app webview had before it was re-classed, for the super
    /// call in the override. One app webview, so one slot.
    static ORIGINAL_CLASS: OnceLock<&'static AnyClass> = OnceLock::new();

    /// The override. `point` arrives in the superview's coordinate space;
    /// converting through the view itself accounts for flippedness, and the
    /// app webview fills the window, so local coordinates ARE the
    /// window-client points the frontend syncs.
    extern "C-unwind" fn hit_test(
        view: &NSView,
        _cmd: Sel,
        point: NSPoint,
    ) -> *mut NSView {
        unsafe {
            let local = view.convertPoint_fromView(point, view.superview().as_deref());
            let y = if view.isFlipped() {
                local.y
            } else {
                view.bounds().size.height - local.y
            };
            if pass_through_at(local.x, y) {
                return std::ptr::null_mut();
            }
            let Some(orig) = ORIGINAL_CLASS.get() else {
                return std::ptr::null_mut();
            };
            msg_send![super(view, orig), hitTest: point]
        }
    }

    /// Re-class the live app webview into a subclass whose only difference is
    /// the hitTest override. Idempotent; the override consults the ENABLED
    /// flag through pass_through_at, so turning the mode off doesn't need the
    /// class put back.
    unsafe fn install_hit_test(view: &WKWebView) {
        let view: &AnyObject = view;
        let orig = view.class();
        if orig.name().to_str().is_ok_and(|n| n.starts_with("CanopyPunch_")) {
            return;
        }
        let name = CString::new(format!("CanopyPunch_{}", orig.name().to_str().unwrap_or("WKWebView")))
            .expect("class name has no NUL");
        let cls = AnyClass::get(&name).unwrap_or_else(|| {
            let mut builder = ClassBuilder::new(&name, orig)
                .expect("punch-through subclass name collision");
            unsafe {
                builder.add_method(
                    sel!(hitTest:),
                    hit_test as extern "C-unwind" fn(_, _, _) -> _,
                );
            }
            builder.register()
        });
        let _ = ORIGINAL_CLASS.set(orig);
        unsafe { objc2::ffi::object_setClass(view as *const _ as *mut _, (cls as *const AnyClass).cast()) };
    }

    /// Everything the mode needs from the app webview and its window: the
    /// hitTest override, background transparency, and a window colour behind
    /// the newly-see-through DOM.
    pub fn apply(
        app: &tauri::AppHandle,
        punch: bool,
        background: Option<Vec<u8>>,
    ) -> Result<(), String> {
        let main = app
            .get_webview("main")
            .ok_or("no app webview to re-layer")?;
        if let Some([r, g, b, ..]) = background.as_deref() {
            let _ = main
                .window()
                .set_background_color(Some(tauri::window::Color(*r, *g, *b, 255)));
        }
        main.with_webview(move |platform| unsafe {
            let ptr = platform.inner() as *mut WKWebView;
            let Some(wk) = ptr.as_ref() else { return };
            if punch {
                install_hit_test(wk);
            }
            // KVC: WKWebView's macOS background switch. Not in the public
            // headers, but the accepted way to a transparent WKWebView and the
            // same key wry flips for transparent windows.
            let value = NSNumber::new_bool(!punch);
            let value: &AnyObject = &value;
            let key = NSString::from_str("drawsBackground");
            let _: () = msg_send![wk, setValue: Some(value), forKey: &*key];
        })
        .map_err(|e| format!("cannot reach the app webview: {e}"))
    }

    /// Reorder a browser view to the back of the window's subviews — beneath
    /// the app webview, which is the whole trick. Retained across the remove
    /// so the view survives its moment out of the hierarchy.
    pub fn send_to_back(view: &tauri::webview::Webview) {
        reorder(view, NSWindowOrderingMode::Below);
    }

    /// The default layering: browser views above the app webview.
    pub fn bring_to_front(view: &tauri::webview::Webview) {
        reorder(view, NSWindowOrderingMode::Above);
    }

    fn reorder(view: &tauri::webview::Webview, order: NSWindowOrderingMode) {
        let _ = view.with_webview(move |platform| unsafe {
            let ptr = platform.inner() as *mut WKWebView;
            let Some(wk) = ptr.as_ref() else { return };
            let v: &NSView = wk;
            let Some(superview) = v.superview() else { return };
            let held = objc2::rc::Retained::retain(ptr.cast::<NSView>())
                .expect("view pointer is live");
            v.removeFromSuperview();
            superview.addSubview_positioned_relativeTo(&held, order, None);
        });
    }
}

#[cfg(not(all(desktop, target_os = "macos")))]
mod native {
    /// The proxy engine runs everywhere else; there is no native view to
    /// re-layer, and saying so beats pretending.
    pub fn apply(
        _app: &tauri::AppHandle,
        punch: bool,
        _background: Option<Vec<u8>>,
    ) -> Result<(), String> {
        if punch {
            return Err("punch-through layering needs the macOS webview engine".into());
        }
        Ok(())
    }
    pub fn send_to_back(_view: &tauri::webview::Webview) {}
    pub fn bring_to_front(_view: &tauri::webview::Webview) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> PassRect {
        PassRect { x, y, width, height }
    }

    /// One test rather than several: the statics are process-wide and cargo
    /// runs tests concurrently, so splitting these would race on ENABLED.
    #[test]
    fn pass_through_respects_mode_pass_and_block() {
        browser_set_passthrough(
            vec![rect(0.0, 0.0, 100.0, 100.0)],
            vec![rect(0.0, 0.0, 40.0, 100.0)],
        )
        .unwrap();
        assert!(!pass_through_at(60.0, 50.0), "mode off: nothing falls through");
        ENABLED.store(true, Ordering::Relaxed);
        assert!(!pass_through_at(20.0, 50.0), "under the overlay");
        assert!(pass_through_at(60.0, 50.0), "clear of the overlay");
        assert!(!pass_through_at(150.0, 50.0), "outside the pane");
        ENABLED.store(false, Ordering::Relaxed);
    }
}
