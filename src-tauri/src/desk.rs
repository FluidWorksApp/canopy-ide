//! Remote desktop control, desktop side. The protocol, consent state machine,
//! validation and capture loop live in `canopy_core::desk` (Tauri-free and unit
//! tested with fakes); this file wires them to the team relay, the OS capture
//! and input backends, and the UI.
//!
//! Consent first: the machine being controlled runs nothing until its user
//! calls `desk_respond(accept = true)` for that exact session. Capture and
//! input threads are only ever spawned from that command, they stop on End,
//! Deny, revoke, peer departure or app exit, and `desk:state` events let the UI
//! keep a controlled-indicator on screen for as long as a session is live.
//!
//! macOS needs the Screen Recording permission (capture) and the Accessibility
//! permission (input). When either is missing the error says so and the
//! session ends instead of silently streaming a blank screen.

use crate::relay::{DeskMsg, RelayManager};
use canopy_core::desk::{
    capture_loop, Action, DeskBody, DeskError, DeskHub, FrameEncoder, InputEvent, InputSink,
    LoopExit, Mode, Phase, Rgba, ScreenSource, SessionInfo,
};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 128-bit session token from the OS CSPRNG.
fn new_session_id() -> String {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).expect("OS randomness unavailable");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---------- native backends ----------

/// Real screen and input backends. Everything here is behind the `desk-native`
/// feature; without it (or on Linux, where xcap needs libpipewire) the session
/// protocol still works but accepting is refused with a clear message.
mod native {
    use super::*;

    /// JPEG encoding through the `image` crate (always available).
    pub struct Jpeg;

    impl FrameEncoder for Jpeg {
        fn encode_jpeg(&mut self, img: &Rgba, quality: u8) -> Result<Vec<u8>, String> {
            use image::codecs::jpeg::JpegEncoder;
            use image::ExtendedColorType;
            let mut rgb = Vec::with_capacity(img.w as usize * img.h as usize * 3);
            for px in img.pixels.chunks_exact(4) {
                rgb.extend_from_slice(&px[..3]);
            }
            let mut out = Vec::new();
            JpegEncoder::new_with_quality(&mut out, quality.clamp(1, 100))
                .encode(&rgb, img.w, img.h, ExtendedColorType::Rgb8)
                .map_err(|e| format!("JPEG encode failed: {e}"))?;
            Ok(out)
        }
    }

    /// Why native support is missing, or Ok when it is compiled in.
    pub fn unavailable_reason() -> Option<&'static str> {
        #[cfg(not(feature = "desk-native"))]
        {
            Some("Remote desktop control was not compiled into this build.")
        }
        #[cfg(all(feature = "desk-native", target_os = "linux"))]
        {
            Some("Sharing a screen is not available on Linux in this build yet. Viewing a teammate's screen works.")
        }
        #[cfg(all(feature = "desk-native", not(target_os = "linux")))]
        {
            None
        }
    }

    #[cfg(all(feature = "desk-native", any(windows, target_os = "macos")))]
    struct Display;

    #[cfg(all(feature = "desk-native", any(windows, target_os = "macos")))]
    impl ScreenSource for Display {
        fn capture(&mut self) -> Result<Rgba, String> {
            let hint = if cfg!(target_os = "macos") {
                " On macOS, allow Canopy under System Settings > Privacy & Security > Screen Recording, then restart it."
            } else {
                ""
            };
            let fail = |e: xcap::XCapError| format!("Screen capture failed: {e}.{hint}");
            let monitors = xcap::Monitor::all().map_err(fail)?;
            let primary = monitors
                .iter()
                .find(|m| m.is_primary().unwrap_or(false))
                .or(monitors.first())
                .ok_or_else(|| format!("No display found to capture.{hint}"))?;
            let img = primary.capture_image().map_err(fail)?;
            Ok(Rgba {
                w: img.width(),
                h: img.height(),
                pixels: img.into_raw(),
            })
        }
    }

    pub fn new_source() -> Result<Box<dyn ScreenSource>, String> {
        if let Some(why) = unavailable_reason() {
            return Err(why.into());
        }
        #[cfg(all(feature = "desk-native", any(windows, target_os = "macos")))]
        {
            Ok(Box::new(Display))
        }
        #[cfg(not(all(feature = "desk-native", any(windows, target_os = "macos"))))]
        {
            Err("Screen capture is not available in this build.".into())
        }
    }

    #[cfg_attr(not(feature = "desk-native"), allow(dead_code))]
    /// W3C `KeyboardEvent.code` to the character it types, for printable keys.
    pub fn key_char(code: &str) -> Option<char> {
        if let Some(l) = code.strip_prefix("Key") {
            return l.chars().next().map(|c| c.to_ascii_lowercase());
        }
        if let Some(d) = code.strip_prefix("Digit") {
            return d.chars().next();
        }
        Some(match code {
            "Minus" => '-',
            "Equal" => '=',
            "BracketLeft" => '[',
            "BracketRight" => ']',
            "Backslash" => '\\',
            "Semicolon" => ';',
            "Quote" => '\'',
            "Backquote" => '`',
            "Comma" => ',',
            "Period" => '.',
            "Slash" => '/',
            _ => return None,
        })
    }

    #[cfg(feature = "desk-native")]
    mod input {
        use super::*;
        use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};

        pub struct Injector(Enigo);

        pub fn new() -> Result<Injector, String> {
            Enigo::new(&Settings::default()).map(Injector).map_err(|e| {
                if matches!(e, enigo::NewConError::NoPermission) {
                    "Input control needs permission. On macOS, allow Canopy under System Settings > Privacy & Security > Accessibility, then restart it.".to_string()
                } else {
                    format!("Couldn't start input control: {e}")
                }
            })
        }

        fn named_key(code: &str) -> Option<Key> {
            Some(match code {
                "Enter" | "NumpadEnter" => Key::Return,
                "Escape" => Key::Escape,
                "Backspace" => Key::Backspace,
                "Tab" => Key::Tab,
                "Space" => Key::Space,
                "Delete" => Key::Delete,
                #[cfg(not(target_os = "macos"))]
                "Insert" => Key::Insert,
                "Home" => Key::Home,
                "End" => Key::End,
                "PageUp" => Key::PageUp,
                "PageDown" => Key::PageDown,
                "ArrowUp" => Key::UpArrow,
                "ArrowDown" => Key::DownArrow,
                "ArrowLeft" => Key::LeftArrow,
                "ArrowRight" => Key::RightArrow,
                "ShiftLeft" | "ShiftRight" => Key::Shift,
                "ControlLeft" | "ControlRight" => Key::Control,
                "AltLeft" | "AltRight" => Key::Alt,
                "MetaLeft" | "MetaRight" => Key::Meta,
                "CapsLock" => Key::CapsLock,
                "F1" => Key::F1,
                "F2" => Key::F2,
                "F3" => Key::F3,
                "F4" => Key::F4,
                "F5" => Key::F5,
                "F6" => Key::F6,
                "F7" => Key::F7,
                "F8" => Key::F8,
                "F9" => Key::F9,
                "F10" => Key::F10,
                "F11" => Key::F11,
                "F12" => Key::F12,
                _ => return None,
            })
        }

        impl InputSink for Injector {
            fn apply(&mut self, event: &InputEvent) -> Result<(), String> {
                let e = |r: enigo::InputResult<()>| r.map_err(|e| format!("Input failed: {e}"));
                let dir = |down: bool| if down { Direction::Press } else { Direction::Release };
                match event {
                    InputEvent::MouseMove { x, y } => {
                        let (w, h) = self.0.main_display().map_err(|e| format!("{e}"))?;
                        let px = (x * (w.max(1) - 1) as f64).round() as i32;
                        let py = (y * (h.max(1) - 1) as f64).round() as i32;
                        e(self.0.move_mouse(px, py, Coordinate::Abs))
                    }
                    InputEvent::MouseButton { button, down } => {
                        let b = match button {
                            canopy_core::desk::Button::Left => Button::Left,
                            canopy_core::desk::Button::Right => Button::Right,
                            canopy_core::desk::Button::Middle => Button::Middle,
                        };
                        e(self.0.button(b, dir(*down)))
                    }
                    InputEvent::Scroll { dx, dy } => {
                        let notches = |v: i32| v.signum() * (v.abs() / 40).max(1);
                        if *dy != 0 {
                            e(self.0.scroll(notches(*dy), Axis::Vertical))?;
                        }
                        if *dx != 0 {
                            e(self.0.scroll(notches(*dx), Axis::Horizontal))?;
                        }
                        Ok(())
                    }
                    InputEvent::Key { code, down } => {
                        let key = named_key(code)
                            .or_else(|| key_char(code).map(Key::Unicode))
                            .ok_or_else(|| "Unsupported key.".to_string())?;
                        e(self.0.key(key, dir(*down)))
                    }
                    InputEvent::Text { s } => e(self.0.text(s)),
                }
            }
        }
    }

    pub fn new_sink() -> Result<Box<dyn InputSink>, String> {
        if let Some(why) = unavailable_reason() {
            return Err(why.into());
        }
        #[cfg(feature = "desk-native")]
        {
            input::new().map(|i| Box::new(i) as Box<dyn InputSink>)
        }
        #[cfg(not(feature = "desk-native"))]
        {
            Err("Input control is not available in this build.".into())
        }
    }
}

// ---------- manager ----------

struct Run {
    alive: Arc<AtomicBool>,
    input_tx: Option<SyncSender<InputEvent>>,
}

#[derive(Default)]
struct State_ {
    hub: DeskHub,
    peer_name: String,
    run: Option<Run>,
}

impl State_ {
    fn stop_run(&mut self) {
        if let Some(run) = self.run.take() {
            run.alive.store(false, Ordering::SeqCst);
        }
    }
}

#[derive(Default)]
pub struct DeskManager {
    inner: Mutex<State_>,
}

impl DeskManager {
    /// App exit: tell the peer, stop the threads. Called before the relay is
    /// torn down so the End can still be delivered.
    pub fn shutdown(&self, relay: &RelayManager) {
        let info = {
            let mut g = self.inner.lock().unwrap();
            g.stop_run();
            g.hub.end_all()
        };
        if let Some(info) = info {
            let _ = relay.send_desk(
                &info.peer,
                &info.session,
                DeskBody::End {
                    reason: "Canopy closed.".into(),
                },
            );
        }
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct DeskStateEvent {
    pub session: String,
    /// "requested" | "active" | "ended"
    pub state: &'static str,
    /// "viewer" | "target"
    pub role: &'static str,
    pub peer: String,
    pub peer_name: String,
    /// "view-only" | "control" once active.
    pub mode: Option<&'static str>,
    /// What the viewer asked for: "view-only" | "control".
    pub requested: &'static str,
    pub reason: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct DeskStatus {
    pub session: String,
    pub role: &'static str,
    pub peer: String,
    pub peer_name: String,
    pub state: &'static str,
    pub mode: Option<&'static str>,
}

fn mode_str(m: Mode) -> &'static str {
    match m {
        Mode::ViewOnly => "view-only",
        Mode::Control => "control",
    }
}

fn parts(info: &SessionInfo) -> (&'static str, &'static str, Option<&'static str>) {
    let role = match info.role {
        canopy_core::desk::Role::Viewer => "viewer",
        canopy_core::desk::Role::Target => "target",
    };
    match info.phase {
        Phase::Requested => ("requested", role, None),
        Phase::Active(m) => ("active", role, Some(mode_str(m))),
        Phase::Ended => ("ended", role, None),
    }
}

fn event_for(info: &SessionInfo, peer_name: &str, reason: Option<String>) -> DeskStateEvent {
    let (state, role, mode) = parts(info);
    DeskStateEvent {
        session: info.session.clone(),
        state,
        role,
        peer: info.peer.clone(),
        peer_name: peer_name.to_string(),
        mode,
        requested: mode_str(info.requested),
        reason,
    }
}

fn emit(app: &AppHandle, info: &SessionInfo, peer_name: &str, reason: Option<String>) {
    let _ = app.emit("desk:state", event_for(info, peer_name, reason));
}

/// End a session from a background thread (capture failure, peer unreachable).
fn finish(app: &AppHandle, session: &str, reason: &str, notify_peer: bool) {
    let mgr = app.state::<DeskManager>();
    let (info, name) = {
        let mut g = mgr.inner.lock().unwrap();
        let Ok(info) = g.hub.end_local(session) else {
            return;
        };
        g.stop_run();
        (info, g.peer_name.clone())
    };
    if notify_peer {
        let _ = app.state::<RelayManager>().send_desk(
            &info.peer,
            session,
            DeskBody::End {
                reason: reason.chars().take(canopy_core::desk::MAX_REASON_CHARS).collect(),
            },
        );
    }
    emit(app, &info, &name, Some(reason.to_string()));
}

// ---------- relay entry points ----------

enum Outcome {
    None,
    Incoming(SessionInfo, String),
    Busy,
    Activated(SessionInfo, String),
    Render,
    Ended(SessionInfo, String, String),
}

/// A desk message arrived over the relay, already stamped with the sender's
/// authenticated id. The state machine decides what it means.
pub fn on_incoming(app: &AppHandle, msg: DeskMsg) {
    let Some(mgr) = app.try_state::<DeskManager>() else {
        return;
    };
    let outcome = {
        let mut g = mgr.inner.lock().unwrap();
        match g.hub.handle(&msg.from, &msg.session, &msg.body, now_ms()) {
            Ok(Action::Incoming { .. }) => {
                g.peer_name = msg.from_name.clone();
                match g.hub.current() {
                    Some(info) => Outcome::Incoming(info, g.peer_name.clone()),
                    None => Outcome::None,
                }
            }
            Ok(Action::Activated(_)) => match g.hub.current() {
                Some(info) => Outcome::Activated(info, g.peer_name.clone()),
                None => Outcome::None,
            },
            Ok(Action::Render) => Outcome::Render,
            Ok(Action::Apply(event)) => {
                if let Some(tx) = g.run.as_ref().and_then(|r| r.input_tx.as_ref()) {
                    // A full queue drops the event; the sender is rate limited.
                    let _ = tx.try_send(event);
                }
                Outcome::None
            }
            Ok(Action::Ended { info, reason }) => {
                g.stop_run();
                Outcome::Ended(info, g.peer_name.clone(), reason)
            }
            Ok(Action::Nothing) => Outcome::None,
            Err(DeskError::Busy) if matches!(msg.body, DeskBody::Request { .. }) => Outcome::Busy,
            Err(_) => Outcome::None,
        }
    };
    match outcome {
        Outcome::None => {}
        Outcome::Incoming(info, name) | Outcome::Activated(info, name) => {
            emit(app, &info, &name, None)
        }
        Outcome::Busy => {
            let _ = app.state::<RelayManager>().send_desk(
                &msg.from,
                &msg.session,
                DeskBody::Deny {
                    reason: "Busy with another remote session.".into(),
                },
            );
        }
        Outcome::Render => {
            let _ = app.emit("relay:desk", msg);
        }
        Outcome::Ended(info, name, reason) => emit(app, &info, &name, Some(reason)),
    }
}

/// Membership changed (or the relay stopped): a session whose peer is gone ends.
pub fn on_members<'a>(app: &AppHandle, ids: impl Iterator<Item = &'a str>) {
    let Some(mgr) = app.try_state::<DeskManager>() else {
        return;
    };
    let ids: Vec<&str> = ids.collect();
    let ended = {
        let mut g = mgr.inner.lock().unwrap();
        let Some(cur) = g.hub.current() else {
            return;
        };
        if ids.contains(&cur.peer.as_str()) {
            return;
        }
        g.stop_run();
        g.hub.peer_gone(&cur.peer).map(|i| (i, g.peer_name.clone()))
    };
    if let Some((info, name)) = ended {
        emit(app, &info, &name, Some("The other side left.".into()));
    }
}

// ---------- commands ----------

/// Viewer: ask a teammate to share their screen. Returns the session id. The
/// request does nothing on its own; the teammate must accept.
#[tauri::command]
pub async fn desk_request(
    app: AppHandle,
    relay: State<'_, RelayManager>,
    desk: State<'_, DeskManager>,
    to: String,
    mode: Mode,
) -> Result<String, String> {
    let session = new_session_id();
    let name = relay.member_name(&to).unwrap_or_else(|| to.clone());
    let info = {
        let mut g = desk.inner.lock().unwrap();
        g.hub
            .request_out(&session, &to, mode, now_ms())
            .map_err(|e| e.to_string())?;
        g.peer_name = name.clone();
        g.hub.current().ok_or("No session.")?
    };
    if let Err(e) = relay.send_desk(&to, &session, DeskBody::Request { mode }) {
        let mut g = desk.inner.lock().unwrap();
        let _ = g.hub.end_local(&session);
        return Err(e);
    }
    emit(&app, &info, &name, None);
    Ok(session)
}

/// Target: the local user's decision. Accepting here is the only way capture
/// or input injection can ever start.
#[tauri::command]
pub async fn desk_respond(
    app: AppHandle,
    relay: State<'_, RelayManager>,
    desk: State<'_, DeskManager>,
    session: String,
    accept: bool,
    mode: Mode,
) -> Result<(), String> {
    // Refuse up front, and tell the viewer why, when this build cannot share.
    let unavailable = if accept { native::unavailable_reason() } else { None };
    let accept = accept && unavailable.is_none();
    let reason = unavailable.unwrap_or("Declined.");

    let (body, info, peer, name, alive, rx) = {
        let mut g = desk.inner.lock().unwrap();
        // Read the peer first: a denial clears the session from the hub.
        let peer = g
            .hub
            .current()
            .filter(|i| i.session == session)
            .map(|i| i.peer)
            .ok_or_else(|| DeskError::UnknownSession.to_string())?;
        let body = g
            .hub
            .respond(&session, accept, mode, now_ms(), reason)
            .map_err(|e| e.to_string())?;
        let name = g.peer_name.clone();
        let info = g.hub.current();
        let mut alive = None;
        let mut rx = None;
        if let (DeskBody::Accept { mode: granted }, Some(_)) = (&body, &info) {
            let flag = Arc::new(AtomicBool::new(true));
            let tx = if *granted == Mode::Control {
                let (tx, r) = sync_channel::<InputEvent>(256);
                rx = Some(r);
                Some(tx)
            } else {
                None
            };
            g.run = Some(Run {
                alive: flag.clone(),
                input_tx: tx,
            });
            alive = Some(flag);
        }
        (body, info, peer, name, alive, rx)
    };

    let sent = relay.send_desk(&peer, &session, body.clone());

    match (&body, info) {
        (DeskBody::Accept { .. }, Some(info)) => {
            if let Err(e) = sent {
                finish(&app, &session, &e, false);
                return Err(e);
            }
            if let Some(alive) = alive {
                spawn_capture(&app, session.clone(), peer.clone(), alive.clone());
                if let Some(rx) = rx {
                    spawn_input(&app, session.clone(), alive, rx);
                }
            }
            emit(&app, &info, &name, None);
            Ok(())
        }
        _ => {
            // Denied (by the user or because this build can't share).
            let ended = SessionInfo {
                session: session.clone(),
                peer,
                role: canopy_core::desk::Role::Target,
                phase: Phase::Ended,
                requested: Mode::ViewOnly,
            };
            emit(&app, &ended, &name, Some(reason.to_string()));
            match unavailable {
                Some(why) => Err(why.to_string()),
                None => sent,
            }
        }
    }
}

/// Viewer: send one input event. Fails fast on a view-only session.
#[tauri::command]
pub async fn desk_send_input(
    relay: State<'_, RelayManager>,
    desk: State<'_, DeskManager>,
    session: String,
    event: InputEvent,
) -> Result<(), String> {
    let peer = {
        let g = desk.inner.lock().unwrap();
        g.hub
            .check_outgoing_input(&session, &event)
            .map_err(|e| e.to_string())?;
        g.hub.current().ok_or("No session.")?.peer
    };
    relay.send_desk(&peer, &session, DeskBody::Input { event })
}

/// Either side: end the session now. On the target this is the instant revoke.
#[tauri::command]
pub async fn desk_end(
    app: AppHandle,
    relay: State<'_, RelayManager>,
    desk: State<'_, DeskManager>,
    session: String,
) -> Result<(), String> {
    let (info, name) = {
        let mut g = desk.inner.lock().unwrap();
        let info = g.hub.end_local(&session).map_err(|e| e.to_string())?;
        g.stop_run();
        (info, g.peer_name.clone())
    };
    let _ = relay.send_desk(
        &info.peer,
        &session,
        DeskBody::End {
            reason: "Ended by the other side.".into(),
        },
    );
    emit(&app, &info, &name, Some("Ended.".into()));
    Ok(())
}

#[tauri::command]
pub async fn desk_status(desk: State<'_, DeskManager>) -> Result<Option<DeskStatus>, String> {
    let g = desk.inner.lock().unwrap();
    Ok(g.hub.current().map(|info| {
        let (state, role, mode) = parts(&info);
        DeskStatus {
            session: info.session,
            role,
            peer: info.peer,
            peer_name: g.peer_name.clone(),
            state,
            mode,
        }
    }))
}

// ---------- threads ----------

/// Target capture thread. Only ever spawned from an accepted `desk_respond`.
fn spawn_capture(app: &AppHandle, session: String, peer: String, alive: Arc<AtomicBool>) {
    let app = app.clone();
    let spawned = thread::Builder::new()
        .name("desk-capture".into())
        .spawn({
            let app = app.clone();
            let session = session.clone();
            move || {
                let mut src = match native::new_source() {
                    Ok(s) => s,
                    Err(e) => return finish(&app, &session, &e, true),
                };
                let mut enc = native::Jpeg;
                let relay = app.state::<RelayManager>();
                let exit = capture_loop(
                    &mut *src,
                    &mut enc,
                    &alive,
                    &mut |body| relay.send_desk(&peer, &session, body).is_ok(),
                    &mut |total| {
                        // Sleep in slices so a revoke is felt within 50 ms.
                        let mut left = total;
                        while left > Duration::ZERO && alive.load(Ordering::SeqCst) {
                            let step = left.min(Duration::from_millis(50));
                            thread::sleep(step);
                            left -= step;
                        }
                    },
                );
                match exit {
                    LoopExit::Stopped => {}
                    LoopExit::PeerGone => {
                        finish(&app, &session, "Lost the connection to the other side.", false)
                    }
                    LoopExit::Failed(e) => finish(&app, &session, &e, true),
                }
            }
        });
    if let Err(e) = spawned {
        finish(&app, &session, &format!("Couldn't start screen sharing: {e}"), true);
    }
}

/// Target input thread: applies validated events through the OS sink.
fn spawn_input(
    app: &AppHandle,
    session: String,
    alive: Arc<AtomicBool>,
    rx: std::sync::mpsc::Receiver<InputEvent>,
) {
    let app = app.clone();
    let spawned = thread::Builder::new().name("desk-input".into()).spawn({
        let app = app.clone();
        let session = session.clone();
        move || {
            let mut sink = match native::new_sink() {
                Ok(s) => s,
                Err(e) => return finish(&app, &session, &e, true),
            };
            let mut held = canopy_core::desk::HeldInput::new();
            while alive.load(Ordering::SeqCst) {
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(event) => {
                        // Re-checked at the last moment: a revoke between
                        // queueing and applying must not inject.
                        if !alive.load(Ordering::SeqCst) {
                            break;
                        }
                        held.note(&event);
                        if let Err(e) = sink.apply(&event) {
                            for up in held.release_all() {
                                let _ = sink.apply(&up);
                            }
                            return finish(&app, &session, &e, true);
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            // Session over (End, revoke, disconnect): never leave a modifier
            // or button held on the target.
            for up in held.release_all() {
                let _ = sink.apply(&up);
            }
        }
    });
    if let Err(e) = spawned {
        finish(&app, &session, &format!("Couldn't start input control: {e}"), true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_core::desk::fakes::{FakeScreen, RecordingSink};
    use canopy_core::desk::{build_frame, MAX_CAPTURE_WIDTH};

    #[test]
    fn desk_session_ids_are_unique_valid_tokens() {
        let a = new_session_id();
        let b = new_session_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 32);
        assert!(canopy_core::desk::valid_session_id(&a));
    }

    #[test]
    fn desk_jpeg_encoder_produces_a_decodable_bounded_frame() {
        let mut screen = FakeScreen::new(3000, 1500);
        let body = build_frame(&mut screen, &mut native::Jpeg, 0, MAX_CAPTURE_WIDTH, 70).unwrap();
        let DeskBody::Frame { w, h, jpeg_b64, .. } = body else {
            panic!("not a frame");
        };
        assert_eq!((w, h), (1600, 800));
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(jpeg_b64)
            .unwrap();
        assert_eq!(&bytes[..2], &[0xff, 0xd8], "JPEG SOI marker");
        let img = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg).unwrap();
        assert_eq!((img.width(), img.height()), (1600, 800));
    }

    #[test]
    fn desk_key_chars_cover_printable_codes() {
        assert_eq!(native::key_char("KeyQ"), Some('q'));
        assert_eq!(native::key_char("Digit7"), Some('7'));
        assert_eq!(native::key_char("Slash"), Some('/'));
        assert_eq!(native::key_char("Enter"), None);
        // Every allow-listed code is either printable or a named key; nothing
        // the validator accepts is silently unmappable except named keys.
        for c in ["KeyA", "Digit0", "Minus", "Backquote"] {
            assert!(canopy_core::desk::is_known_key(c));
            assert!(native::key_char(c).is_some());
        }
    }

    #[test]
    fn desk_native_backends_report_a_clear_error_when_unavailable() {
        if let Some(why) = native::unavailable_reason() {
            assert!(native::new_source().is_err());
            assert!(native::new_sink().is_err());
            assert!(!why.is_empty());
        }
    }

    #[test]
    fn desk_state_event_shape_for_the_ui() {
        let info = SessionInfo {
            session: "s1".into(),
            peer: "p".into(),
            role: canopy_core::desk::Role::Target,
            phase: Phase::Active(Mode::ViewOnly),
            requested: Mode::Control,
        };
        let v = serde_json::to_value(event_for(&info, "Sam", None)).unwrap();
        assert_eq!(v["state"], "active");
        assert_eq!(v["role"], "target");
        assert_eq!(v["mode"], "view-only");
        assert_eq!(v["requested"], "control");
        assert_eq!(v["peer_name"], "Sam");
    }

    /// The view-only guarantee end to end: the sink never sees an event.
    #[test]
    fn desk_view_only_session_never_reaches_the_sink() {
        let mut hub = DeskHub::new();
        hub.handle("v", "s1", &DeskBody::Request { mode: Mode::Control }, 0)
            .unwrap();
        hub.respond("s1", true, Mode::ViewOnly, 1, "").unwrap();
        let mut sink = RecordingSink::default();
        let body = DeskBody::Input {
            event: InputEvent::MouseMove { x: 0.5, y: 0.5 },
        };
        if let Ok(Action::Apply(e)) = hub.handle("v", "s1", &body, 2) {
            sink.apply(&e).unwrap();
        }
        assert!(sink.applied.is_empty());
    }
}
