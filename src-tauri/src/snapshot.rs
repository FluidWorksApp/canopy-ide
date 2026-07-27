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

use tauri::Manager;

/// How a capture is encoded. An agent's screenshot is evidence and must be
/// exact; the freeze-frame is a still shown under an overlay for a second, and
/// travels over IPC every time a menu opens — there, a tenth of the bytes is
/// worth more than lossless pixels.
#[derive(Clone, Copy, PartialEq)]
pub enum Encoding {
    Png,
    Jpeg,
}

/// PNG bytes of `rect` (CSS pixels, webview coordinates), base64-encoded.
/// `width` caps the output so a retina window doesn't ship a 4000px image no
/// model needs.
#[tauri::command]
pub async fn webview_snapshot(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    max_width: Option<f64>,
) -> Result<String, String> {
    capture(
        window.as_ref().clone(),
        x,
        y,
        width,
        height,
        max_width.unwrap_or(1200.0),
        Encoding::Png,
    )
    .await
}

/// PNG of one embedded-browser view, whole. A rect would be meaningless here:
/// the view's own origin is its top-left corner, and nothing of the app is
/// inside it.
#[tauri::command]
pub async fn browser_snapshot(
    app: tauri::AppHandle,
    tab_id: String,
    max_width: Option<f64>,
) -> Result<String, String> {
    let label = crate::browser::label_for(&tab_id);
    let view = app
        .get_webview(&label)
        .ok_or_else(|| "that browser tab has no page open right now".to_string())?;
    let size = view
        .size()
        .map_err(|e| format!("cannot measure the browser view: {e}"))?;
    let scale = view
        .window()
        .scale_factor()
        .map_err(|e| format!("cannot measure the browser view: {e}"))?;
    capture(
        view,
        0.0,
        0.0,
        f64::from(size.width) / scale,
        f64::from(size.height) / scale,
        max_width.unwrap_or(1200.0),
        Encoding::Png,
    )
    .await
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
    let label = crate::browser::label_for(&tab_id);
    let view = app
        .get_webview(&label)
        .ok_or_else(|| "no browser view".to_string())?;
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
    use objc2::rc::Retained;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSNumber, NSRect, NSString};
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
                let encoded = unsafe {
                    let tiff = image.TIFFRepresentation();
                    tiff.and_then(|data| NSBitmapImageRep::imageRepWithData(&data))
                        .and_then(|rep: Retained<NSBitmapImageRep>| match encoding {
                            Encoding::Png => rep.representationUsingType_properties(
                                NSBitmapImageFileType::PNG,
                                &NSDictionary::new(),
                            ),
                            Encoding::Jpeg => {
                                let key: Retained<NSString> =
                                    NSString::from_str("NSImageCompressionFactor");
                                let props = NSDictionary::from_slices(
                                    &[&*key],
                                    &[NSNumber::new_f64(0.72).as_ref()],
                                );
                                rep.representationUsingType_properties(
                                    NSBitmapImageFileType::JPEG,
                                    &props,
                                )
                            }
                        })
                        .map(|data| data.to_vec())
                };
                let _ = tx.send(encoded.ok_or_else(|| "could not encode the snapshot".to_string()));
            },
        );
        unsafe { view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler) };
    })
    .map_err(|e| format!("cannot reach the webview: {e}"))?;

    let bytes = tokio::task::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(10))
            .unwrap_or_else(|_| Err("the webview didn't answer in time".into()))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
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
