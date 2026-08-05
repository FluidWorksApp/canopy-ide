//! A picture of what the window is actually showing, for `canopy_screenshot`.
//!
//! The DOM snapshot the browser-control tools return is text: it can say a
//! button exists, never that it is overlapping the heading or invisible on a
//! dark background — which is most of what a user complains about. This gives
//! an agent the pixels.
//!
//! Captured through the webview's OWN snapshot API (WKWebView
//! `takeSnapshotWithConfiguration:`), not a screen grab: a screen grab of one's
//! own window still needs macOS Screen Recording permission, and asking a
//! developer for that to see their own preview is not a trade worth making.
//!
//! Which webview gets snapshotted depends on the browser engine. Under the
//! proxy the page is an iframe inside the main window, so the caller passes the
//! iframe's rect in CSS pixels and the capture is cropped to it. Under the
//! webview engine the page IS its own view, so there is nothing to crop to and
//! nothing else in the frame — the whole child webview is the picture.
//!
//! Because it is the page's own API and not a screen grab, it does not read the
//! compositor: `takeSnapshotWithConfiguration:` asks the web process to paint
//! the rect fresh. So a child webview answers with its page whether or not that
//! view is on screen — hidden behind another tab, or hidden since before it ever
//! painted, verified both ways against WebKit. That is what lets an agent
//! photograph a preview it is not looking at, which is the point: nothing in
//! Canopy moves the user's front tab to take a picture.
//!
//! Both resolve to a `Webview`, never a `WebviewWindow`. Tauri only calls a
//! window a `WebviewWindow` while it hosts exactly one webview, so the app's own
//! window stopped answering to that the moment a preview tab added a child —
//! taking every capture of the app's UI with it, at exactly the moment an agent
//! most wants to look at the screen. A snapshot only ever needed the webview.

use tauri::Manager;

/// The label Tauri gives the app's own window, and so its webview: the window in
/// `tauri.conf.json` names none, and `main` is the default.
const APP_WEBVIEW: &str = "main";

/// The webview the app's UI runs in, child webviews or no child webviews.
fn app_webview<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<tauri::webview::Webview<R>, String> {
    app.get_webview(APP_WEBVIEW)
        .ok_or_else(|| format!("cannot capture the app window: no webview {APP_WEBVIEW} is open"))
}

/// How a capture is encoded. An agent's screenshot is evidence and must be
/// exact; the freeze-frame is a still shown under an overlay for a second, and
/// travels over IPC every time a menu opens — there, a tenth of the bytes is
/// worth more than lossless pixels.
#[derive(Clone, Copy, PartialEq)]
pub enum Encoding {
    Png,
    Jpeg,
}

impl Encoding {
    fn mime(self) -> &'static str {
        match self {
            Encoding::Png => "image/png",
            Encoding::Jpeg => "image/jpeg",
        }
    }
}

/// PNG bytes of `rect` (CSS pixels, webview coordinates), base64-encoded.
/// `width` caps the output so a retina window doesn't ship a 4000px image no
/// model needs.
#[tauri::command]
pub async fn webview_snapshot(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    max_width: Option<f64>,
) -> Result<String, String> {
    capture(
        app_webview(&app)?,
        x,
        y,
        width,
        height,
        max_width.unwrap_or(1200.0),
        Encoding::Png,
    )
    .await
}

/// A capture and the size, in logical points, it was taken at.
///
/// The size is measured here rather than passed in because the caller often
/// cannot know it: a preview tab that isn't the front tab has a `display: none`
/// placeholder, so its rect in the app's DOM is zeros at exactly the moment an
/// agent asks for a picture of the page.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    pub image: String,
    pub width: f64,
    pub height: f64,
    pub mime_type: &'static str,
}

/// One embedded-browser view, whole. A rect would be meaningless here: the
/// view's own origin is its top-left corner, and nothing of the app is inside
/// it. PNG unless the caller asks for `format: "jpeg"` — an agent's screenshot
/// is evidence, but the PiP polls this four times a second and lossless pixels
/// there are only encode time and IPC weight.
#[tauri::command]
pub async fn browser_snapshot(
    app: tauri::AppHandle,
    tab_id: String,
    max_width: Option<f64>,
    format: Option<String>,
) -> Result<Shot, String> {
    let encoding = match format.as_deref() {
        Some("jpeg") => Encoding::Jpeg,
        _ => Encoding::Png,
    };
    let view = crate::browser::webview(&app, &tab_id)?;
    let size = view
        .size()
        .map_err(|e| format!("cannot measure the browser view: {e}"))?;
    let scale = view
        .window()
        .scale_factor()
        .map_err(|e| format!("cannot measure the browser view: {e}"))?;
    let width = f64::from(size.width) / scale;
    let height = f64::from(size.height) / scale;
    let image = capture(
        view,
        0.0,
        0.0,
        width,
        height,
        max_width.unwrap_or(1200.0),
        encoding,
    )
    .await?;
    Ok(Shot {
        image,
        width,
        height,
        mime_type: encoding.mime(),
    })
}

/// The freeze-frame: a JPEG of a browser view, taken while it is still on
/// screen, so that hiding it for an overlay leaves the page apparently frozen
/// underneath rather than replaced by a hole.
///
/// Deliberately forgiving. A view that is mid-navigation, offscreen or already
/// hidden simply has no frame to give, and the caller keeps whatever it had —
/// so this returns an error only for things worth logging, and the frontend
/// treats every failure the same way: keep the previous frame.
#[tauri::command]
pub async fn browser_frame(
    app: tauri::AppHandle,
    tab_id: String,
    max_width: Option<f64>,
) -> Result<String, String> {
    let view = crate::browser::webview(&app, &tab_id)?;
    let size = view.size().map_err(|e| e.to_string())?;
    let scale = view.window().scale_factor().map_err(|e| e.to_string())?;
    capture(
        view,
        0.0,
        0.0,
        f64::from(size.width) / scale,
        f64::from(size.height) / scale,
        // Half-ish resolution: it is a still behind a dialog, and softness there
        // is invisible where transfer size is not.
        max_width.unwrap_or(900.0),
        Encoding::Jpeg,
    )
    .await
}

#[cfg(target_os = "macos")]
async fn capture(
    view: tauri::webview::Webview,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    max_width: f64,
    encoding: Encoding,
) -> Result<String, String> {
    use base64::Engine;
    use objc2_app_kit::NSImage;
    use objc2_foundation::NSRect;
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    if width <= 0.0 || height <= 0.0 {
        return Err("nothing to capture: the preview has no size on screen".into());
    }
    let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<u8>, String>>();

    // WKWebView is main-thread-only, and so is the completion block it calls
    // back on. This closure runs on the main thread; the caller is a tokio
    // worker, so parking it on the channel below can't deadlock the callback.
    view.with_webview(move |webview| {
        let ptr = webview.inner() as *mut WKWebView;
        let Some(view) = (unsafe { ptr.as_ref() }) else {
            let _ = tx.send(Err("no webview to capture".into()));
            return;
        };
        let Some(mtm) = objc2::MainThreadMarker::new() else {
            let _ = tx.send(Err("snapshot must run on the main thread".into()));
            return;
        };
        let config = unsafe { WKSnapshotConfiguration::new(mtm) };
        unsafe {
            config.setRect(NSRect::new(
                objc2_foundation::NSPoint::new(x, y),
                objc2_foundation::NSSize::new(width, height),
            ));
            config.setSnapshotWidth(Some(&objc2_foundation::NSNumber::new_f64(
                width.min(max_width),
            )));
        }
        let tx = tx.clone();
        let handler = block2::RcBlock::new(
            move |image: *mut NSImage, error: *mut objc2_foundation::NSError| {
                if !error.is_null() {
                    let message = unsafe { (*error).localizedDescription() }.to_string();
                    let _ = tx.send(Err(format!("the webview refused to snapshot: {message}")));
                    return;
                }
                let Some(image) = (unsafe { image.as_ref() }) else {
                    let _ = tx.send(Err("the webview returned no image".into()));
                    return;
                };
                // This block runs on the main thread — the same thread every
                // show, hide and set_bounds the coordination depends on queues
                // through. Only the bitmap copy happens here; the PNG/JPEG
                // encode is the expensive part and runs on the blocking thread
                // that is already parked waiting for these bytes.
                let tiff = unsafe { image.TIFFRepresentation() }.map(|data| data.to_vec());
                let _ = tx.send(tiff.ok_or_else(|| "the webview returned no bitmap".to_string()));
            },
        );
        unsafe { view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler) };
    })
    .map_err(|e| format!("cannot reach the webview: {e}"))?;

    let bytes = tokio::task::spawn_blocking(move || {
        let tiff = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap_or_else(|_| Err("the webview didn't answer in time".into()))?;
        encode(&tiff, encoding)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// TIFF bytes to PNG or JPEG, off the main thread. NSBitmapImageRep is safe
/// here: it is not a view, and encoding an image rep touches nothing that
/// belongs to AppKit's UI state.
#[cfg(target_os = "macos")]
fn encode(tiff: &[u8], encoding: Encoding) -> Result<Vec<u8>, String> {
    use objc2::rc::Retained;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::{NSData, NSDictionary, NSNumber, NSString};

    let data = NSData::with_bytes(tiff);
    NSBitmapImageRep::imageRepWithData(&data)
        .and_then(|rep: Retained<NSBitmapImageRep>| match encoding {
            Encoding::Png => unsafe {
                rep.representationUsingType_properties(
                    NSBitmapImageFileType::PNG,
                    &NSDictionary::new(),
                )
            },
            Encoding::Jpeg => unsafe {
                let key: Retained<NSString> = NSString::from_str("NSImageCompressionFactor");
                let props =
                    NSDictionary::from_slices(&[&*key], &[NSNumber::new_f64(0.72).as_ref()]);
                rep.representationUsingType_properties(NSBitmapImageFileType::JPEG, &props)
            },
        })
        .map(|data| data.to_vec())
        .ok_or_else(|| "could not encode the snapshot".to_string())
}

// Windows' CoreWebView2 (CapturePreview) and WebKitGTK (snapshot) both offer an
// equivalent; neither is wired up yet, and a clear "not here" beats an agent
// wondering why its picture is blank.
#[cfg(not(target_os = "macos"))]
async fn capture(
    _view: tauri::webview::Webview,
    _x: f64,
    _y: f64,
    _width: f64,
    _height: f64,
    _max_width: f64,
    _encoding: Encoding,
) -> Result<String, String> {
    Err(
        "Screenshots of the preview are only available on macOS so far — use \
         canopy_browser_snapshot for the page's structure and text."
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::{LogicalPosition, LogicalSize, WebviewUrl};

    /// The app as it runs: one window, the UI's webview inside it.
    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        tauri::WebviewWindowBuilder::new(&app, APP_WEBVIEW, WebviewUrl::default())
            .build()
            .unwrap();
        app
    }

    /// And a preview tab open in it.
    fn open_preview(app: &tauri::App<tauri::test::MockRuntime>, tab_id: &str) {
        let window = app.get_window(APP_WEBVIEW).unwrap();
        window
            .add_child(
                tauri::webview::WebviewBuilder::new(
                    crate::browser::label_for(tab_id),
                    WebviewUrl::default(),
                ),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(100.0, 100.0),
            )
            .unwrap();
    }

    /// The regression this module's resolution exists to survive: a window that
    /// hosts a child webview stops being a `WebviewWindow`, which is how the app
    /// webview used to be resolved. `canopy_screenshot` died whenever a preview
    /// tab was open — the one time an agent has most to look at.
    #[test]
    fn a_preview_tab_stops_the_window_resolving_as_a_webview_window() {
        let app = mock_app();
        assert!(app.get_webview_window(APP_WEBVIEW).is_some());
        open_preview(&app, "tab-1");
        assert!(app.get_webview_window(APP_WEBVIEW).is_none());
    }

    #[test]
    fn the_app_webview_resolves_with_a_preview_tab_open() {
        let app = mock_app();
        open_preview(&app, "tab-1");
        let view = app_webview(app.handle()).expect("app webview should resolve");
        assert_eq!(view.label(), APP_WEBVIEW);
    }
}
