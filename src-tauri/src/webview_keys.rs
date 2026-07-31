//! Take Edge's own keyboard shortcuts back off the webview (Windows only).
//!
//! WebView2 is Edge, embedded, and it ships the browser's accelerator keys
//! switched on — sensibly, since it is built for displaying web content. Those
//! shortcuts assume "the page" is a document you are visiting. In Canopy the
//! page is the whole application, so each one does something between useless
//! and destructive:
//!
//!   Ctrl+R / F5        reloads the app — unsaved editor buffers, draft
//!                      comments and dialog state go with it (the PTYs
//!                      survive; they live in this process, not the webview)
//!   Ctrl+F             Edge's find bar, floating over the IDE as chrome the
//!                      user cannot dismiss from anything Canopy drew
//!   Ctrl+S             "Save As", offering to write the app's own HTML to disk
//!   Ctrl+Plus/Minus/0  zooms the webview *on top of* the app's own zoom
//!                      (App.tsx), so one press moved two things
//!   Alt+Left/Right     history back/forward, in a single-page app
//!   F12 / Ctrl+U       devtools and view-source, in a shipped build
//!
//! None of these are reachable through shared/shortcuts.json, which is the
//! problem: the registry is supposed to be the whole answer to "what does this
//! key do", and on one platform a second, invisible set sat underneath it.
//!
//! Only the chords Canopy binds as *menu accelerators* already beat WebView2 —
//! muda installs an accelerator table that `TranslateAcceleratorW` drains in
//! the message pump, ahead of the webview — which is why Ctrl+P opens Quick
//! Open rather than the print dialog. Everything above is what is left over.
//!
//! macOS and Linux need no equivalent: WKWebView and WebKitGTK have no such
//! setting, and far fewer built-in accelerators to begin with.

/// Turn off WebView2's browser accelerator keys.
///
/// Debug builds keep them: `Ctrl+R` to reload and `F12` for devtools are how
/// you work on the thing, and the divergence is deliberate rather than
/// accidental — a released Canopy should not be reloadable out from under
/// someone's unsaved work, and a dev build should.
///
/// Best-effort by design. The setting needs WebView2 Runtime 92.0.902.0 or
/// newer, and every step below can fail on an older or unusual runtime; a
/// browser shortcut that stays live is a papercut, not a reason to refuse to
/// start.
#[cfg(all(windows, not(debug_assertions)))]
pub fn disable_browser_accelerators(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    let applied = window.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            log::warn!("webview keys: no CoreWebView2; browser shortcuts left on");
            return;
        };
        let Ok(settings) = core.Settings() else {
            log::warn!("webview keys: no settings; browser shortcuts left on");
            return;
        };
        // ICoreWebView2Settings3 is where AreBrowserAcceleratorKeysEnabled
        // lives; an older runtime simply will not have the interface.
        match settings.cast::<ICoreWebView2Settings3>() {
            Ok(s) => {
                if let Err(e) = s.SetAreBrowserAcceleratorKeysEnabled(false) {
                    log::warn!("webview keys: could not disable browser shortcuts: {e}");
                }
            }
            Err(e) => log::warn!("webview keys: runtime too old for the setting: {e}"),
        }
    });
    if let Err(e) = applied {
        log::warn!("webview keys: could not reach the webview: {e}");
    }
}

/// No-op everywhere else: there is nothing to switch off.
#[cfg(not(all(windows, not(debug_assertions))))]
pub fn disable_browser_accelerators(_window: &tauri::WebviewWindow) {}
