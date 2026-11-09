//! Remote desktop control: wire types, consent state machine and capture
//! pipeline, with no Tauri and no OS dependency.
//!
//! Design (AnyDesk and TeamViewer style, consent first):
//!
//! * Transport is the existing team relay, which is already SPAKE2 +
//!   ChaCha20-Poly1305 encrypted with Ed25519 TOFU identities. Screen frames
//!   are bounded JPEG frames, input events flow back the other way. No WebRTC,
//!   no signalling server, no second crypto stack.
//! * The machine being controlled (the target) must explicitly accept each
//!   session locally. Nothing captures and nothing is injected before that.
//!   The target chooses view-only or control and can never be granted more than
//!   the viewer asked for.
//! * One session at a time, bound to exactly one peer id. Messages from any
//!   other peer, for any other session id, or out of phase are refused.
//! * No path, file or clipboard access exists in this protocol at all.
//! * Sessions end on End, Deny, local revoke, peer disconnect or app shutdown.
//!
//! The real screen and input backends live in the desktop app behind the
//! [`ScreenSource`], [`FrameEncoder`] and [`InputSink`] traits, so everything
//! here is testable with fakes on a headless machine.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Largest base64 JPEG payload accepted in one frame (1.5 MiB). Keeps the JSON
/// envelope under the secure channel's 2 MiB frame ceiling.
pub const MAX_FRAME_B64: usize = 1_572_864;
/// Longest text run a single `Text` input may carry, in characters.
pub const MAX_TEXT_CHARS: usize = 256;
/// Sanity bound on advertised frame dimensions.
pub const MAX_DIMENSION: u32 = 4096;
/// Captured frames are downscaled to at most this width before encoding.
pub const MAX_CAPTURE_WIDTH: u32 = 1600;
/// Longest free-text reason carried by Deny and End.
pub const MAX_REASON_CHARS: usize = 200;
/// Longest session id accepted.
pub const MAX_SESSION_ID: usize = 64;
/// How long a request waits for the target user before it is stale.
pub const REQUEST_TTL_MS: u64 = 60_000;
/// Largest scroll step per event, in either axis.
pub const MAX_SCROLL: i32 = 1000;

// ---------- wire types ----------

/// What the viewer may do. `ViewOnly` never injects input.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    ViewOnly,
    Control,
}

impl Mode {
    /// The weaker of two modes. A grant is clamped to what was asked for.
    pub fn min(self, other: Mode) -> Mode {
        if self == Mode::ViewOnly || other == Mode::ViewOnly {
            Mode::ViewOnly
        } else {
            Mode::Control
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Button {
    Left,
    Right,
    Middle,
}

/// One remote input. Pointer positions are normalized to the captured display
/// (0..=1) so they survive downscaling and differing resolutions.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum InputEvent {
    MouseMove {
        x: f64,
        y: f64,
    },
    MouseButton {
        button: Button,
        down: bool,
    },
    Scroll {
        dx: i32,
        dy: i32,
    },
    /// `code` is a W3C `KeyboardEvent.code` value from a fixed allow list.
    Key {
        code: String,
        down: bool,
    },
    Text {
        s: String,
    },
}

/// The body of a desk message. Version tolerant in the sense that an unknown
/// `kind` fails to parse and the whole frame is dropped at the relay.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DeskBody {
    /// Viewer -> target: "let me see (and maybe control) your screen."
    Request {
        mode: Mode,
    },
    /// Target -> viewer: the local user accepted, with this (possibly weaker) mode.
    Accept {
        mode: Mode,
    },
    /// Target -> viewer: refused.
    Deny {
        reason: String,
    },
    /// Target -> viewer: one JPEG frame. `seq` strictly increases.
    Frame {
        seq: u64,
        w: u32,
        h: u32,
        jpeg_b64: String,
    },
    /// Viewer -> target: one input event.
    Input {
        event: InputEvent,
    },
    Ping,
    /// Either side: the session is over.
    End {
        reason: String,
    },
}

// ---------- validation ----------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeskError {
    BadSessionId,
    Busy,
    NoSession,
    UnknownSession,
    WrongPeer,
    WrongRole,
    NotActive,
    ViewOnly,
    InvalidGrant,
    Expired,
    StaleSeq,
    RateLimited,
    OutOfRange(&'static str),
    UnknownKey,
    TextTooLong,
    BadText,
    FrameTooLarge,
    BadDimensions,
    ReasonTooLong,
}

impl fmt::Display for DeskError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            DeskError::BadSessionId => "invalid session id",
            DeskError::Busy => "another remote session is already in progress",
            DeskError::NoSession => "no remote session",
            DeskError::UnknownSession => "unknown or stale session",
            DeskError::WrongPeer => "message from a peer that does not own this session",
            DeskError::WrongRole => "message not valid for this side of the session",
            DeskError::NotActive => "session is not active",
            DeskError::ViewOnly => "session is view-only",
            DeskError::InvalidGrant => "grant is broader than the request",
            DeskError::Expired => "the request expired",
            DeskError::StaleSeq => "duplicate or stale frame sequence",
            DeskError::RateLimited => "input rate limit exceeded",
            DeskError::OutOfRange(what) => return write!(f, "{what} out of range"),
            DeskError::UnknownKey => "unknown key",
            DeskError::TextTooLong => "text too long",
            DeskError::BadText => "text contains control characters",
            DeskError::FrameTooLarge => "frame too large",
            DeskError::BadDimensions => "invalid frame dimensions",
            DeskError::ReasonTooLong => "reason too long",
        };
        f.write_str(s)
    }
}

impl std::error::Error for DeskError {}

/// Session ids are opaque tokens minted by the viewer.
pub fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_SESSION_ID
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Allow list of key codes. Anything else is refused rather than passed to the
/// OS input layer.
pub fn is_known_key(code: &str) -> bool {
    const NAMED: &[&str] = &[
        "Enter",
        "NumpadEnter",
        "Escape",
        "Backspace",
        "Tab",
        "Space",
        "Delete",
        "Insert",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "ShiftLeft",
        "ShiftRight",
        "ControlLeft",
        "ControlRight",
        "AltLeft",
        "AltRight",
        "MetaLeft",
        "MetaRight",
        "CapsLock",
        "Minus",
        "Equal",
        "BracketLeft",
        "BracketRight",
        "Backslash",
        "Semicolon",
        "Quote",
        "Backquote",
        "Comma",
        "Period",
        "Slash",
    ];
    if NAMED.contains(&code) {
        return true;
    }
    if let Some(l) = code.strip_prefix("Key") {
        return l.len() == 1 && l.as_bytes()[0].is_ascii_uppercase();
    }
    if let Some(d) = code.strip_prefix("Digit") {
        return d.len() == 1 && d.as_bytes()[0].is_ascii_digit();
    }
    if let Some(n) = code.strip_prefix('F') {
        return n
            .parse::<u8>()
            .map(|n| (1..=12).contains(&n))
            .unwrap_or(false)
            && !n.starts_with('0');
    }
    false
}

impl InputEvent {
    pub fn validate(&self) -> Result<(), DeskError> {
        match self {
            InputEvent::MouseMove { x, y } => {
                let ok = |v: &f64| v.is_finite() && (0.0..=1.0).contains(v);
                if ok(x) && ok(y) {
                    Ok(())
                } else {
                    Err(DeskError::OutOfRange("pointer coordinate"))
                }
            }
            InputEvent::MouseButton { .. } => Ok(()),
            InputEvent::Scroll { dx, dy } => {
                if dx.abs() <= MAX_SCROLL && dy.abs() <= MAX_SCROLL {
                    Ok(())
                } else {
                    Err(DeskError::OutOfRange("scroll"))
                }
            }
            InputEvent::Key { code, .. } => {
                if is_known_key(code) {
                    Ok(())
                } else {
                    Err(DeskError::UnknownKey)
                }
            }
            InputEvent::Text { s } => {
                if s.chars().count() > MAX_TEXT_CHARS {
                    Err(DeskError::TextTooLong)
                } else if s.is_empty() || s.chars().any(|c| c.is_control()) {
                    Err(DeskError::BadText)
                } else {
                    Ok(())
                }
            }
        }
    }
}

impl DeskBody {
    /// Stateless checks the relay host runs before fan-out and the session
    /// runs again on receipt. Bounds every field so a hostile peer cannot push
    /// oversized data through the relay.
    pub fn validate(&self) -> Result<(), DeskError> {
        match self {
            DeskBody::Request { .. } | DeskBody::Accept { .. } | DeskBody::Ping => Ok(()),
            DeskBody::Deny { reason } | DeskBody::End { reason } => {
                if reason.chars().count() > MAX_REASON_CHARS {
                    Err(DeskError::ReasonTooLong)
                } else {
                    Ok(())
                }
            }
            DeskBody::Frame { w, h, jpeg_b64, .. } => {
                if jpeg_b64.len() > MAX_FRAME_B64 {
                    Err(DeskError::FrameTooLarge)
                } else if *w == 0 || *h == 0 || *w > MAX_DIMENSION || *h > MAX_DIMENSION {
                    Err(DeskError::BadDimensions)
                } else {
                    Ok(())
                }
            }
            DeskBody::Input { event } => event.validate(),
        }
    }
}

// ---------- rate limiting and pacing ----------

/// Token bucket, driven by a caller supplied clock so tests are deterministic.
#[derive(Debug, Clone)]
pub struct RateLimiter {
    capacity: f64,
    per_sec: f64,
    tokens: f64,
    last_ms: Option<u64>,
}

impl RateLimiter {
    pub fn new(capacity: u32, per_sec: u32) -> Self {
        RateLimiter {
            capacity: capacity as f64,
            per_sec: per_sec as f64,
            tokens: capacity as f64,
            last_ms: None,
        }
    }

    /// Input limiter: a burst of 120 then 240 events per second sustained,
    /// comfortably above a 60 Hz pointer plus typing.
    pub fn for_input() -> Self {
        RateLimiter::new(120, 240)
    }

    pub fn allow(&mut self, now_ms: u64) -> bool {
        if let Some(last) = self.last_ms {
            let dt = now_ms.saturating_sub(last) as f64 / 1000.0;
            self.tokens = (self.tokens + dt * self.per_sec).min(self.capacity);
        }
        self.last_ms = Some(now_ms);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// Frame pacing: about 8 fps, backing off when sends are slow and creeping
/// back toward the target when they are not.
#[derive(Debug, Clone)]
pub struct FramePacer {
    interval_ms: u64,
}

impl FramePacer {
    pub const TARGET_MS: u64 = 125;
    pub const MAX_MS: u64 = 1000;

    pub fn new() -> Self {
        FramePacer {
            interval_ms: Self::TARGET_MS,
        }
    }

    pub fn interval_ms(&self) -> u64 {
        self.interval_ms
    }

    /// Report how long handing the last frame to the link took. A send that
    /// ate more than half the interval means the link is the bottleneck.
    pub fn report_send(&mut self, send_ms: u64) {
        if send_ms > self.interval_ms / 2 {
            self.interval_ms = (self.interval_ms * 2).min(Self::MAX_MS);
        } else {
            self.interval_ms = (self.interval_ms - self.interval_ms / 8).max(Self::TARGET_MS);
        }
    }

    /// How long to sleep after a cycle that took `elapsed_ms`.
    pub fn sleep_ms(&self, elapsed_ms: u64) -> u64 {
        self.interval_ms.saturating_sub(elapsed_ms)
    }
}

impl Default for FramePacer {
    fn default() -> Self {
        Self::new()
    }
}

// ---------- session state machine ----------

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    /// We asked to see the peer's screen.
    Viewer,
    /// The peer asked to see ours. We are the machine being controlled.
    Target,
}

/// Idle is the absence of a session in [`DeskHub`].
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(tag = "state", content = "mode", rename_all = "kebab-case")]
pub enum Phase {
    Requested,
    Active(Mode),
    Ended,
}

/// A copyable snapshot for events and status.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct SessionInfo {
    pub session: String,
    pub peer: String,
    pub role: Role,
    pub phase: Phase,
    /// The mode the viewer asked for (the target may grant less).
    pub requested: Mode,
}

#[derive(Debug)]
pub struct DeskSession {
    id: String,
    peer: String,
    role: Role,
    phase: Phase,
    requested: Mode,
    created_ms: u64,
    last_seq: Option<u64>,
    limiter: RateLimiter,
}

impl DeskSession {
    fn new(id: &str, peer: &str, role: Role, requested: Mode, now_ms: u64) -> Self {
        DeskSession {
            id: id.to_string(),
            peer: peer.to_string(),
            role,
            phase: Phase::Requested,
            requested,
            created_ms: now_ms,
            last_seq: None,
            limiter: RateLimiter::for_input(),
        }
    }

    pub fn info(&self) -> SessionInfo {
        SessionInfo {
            session: self.id.clone(),
            peer: self.peer.clone(),
            role: self.role,
            phase: self.phase,
            requested: self.requested,
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    pub fn role(&self) -> Role {
        self.role
    }
}

/// What the embedding app should do after an incoming message.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Nothing,
    /// A peer asked to view us. Show the consent prompt. Nothing is captured.
    Incoming {
        mode: Mode,
    },
    /// Viewer side: the target accepted with this mode.
    Activated(Mode),
    /// Viewer side: show this frame.
    Render,
    /// Target side: inject this (already validated) event.
    Apply(InputEvent),
    /// The local request lifetime elapsed before this message was handled.
    Expired {
        info: SessionInfo,
    },
    /// The session is over; tear everything down.
    Ended {
        info: SessionInfo,
        reason: String,
    },
}

/// Holds at most one live session.
#[derive(Debug, Default)]
pub struct DeskHub {
    session: Option<DeskSession>,
}

impl DeskHub {
    pub fn new() -> Self {
        DeskHub { session: None }
    }

    pub fn current(&self) -> Option<SessionInfo> {
        self.session.as_ref().map(|s| s.info())
    }

    /// True only on the target of an active session: the one state in which
    /// screen capture is allowed to run.
    pub fn capture_allowed(&self, session: &str) -> bool {
        self.session.as_ref().map_or(false, |s| {
            s.id == session && s.role == Role::Target && matches!(s.phase, Phase::Active(_))
        })
    }

    /// Drop a request nobody answered within [`REQUEST_TTL_MS`], on either
    /// side, so an ignored request cannot hold the single session slot.
    /// The exact TTL boundary is expired. Active sessions are never expired.
    pub fn expire(&mut self, now_ms: u64) -> Option<SessionInfo> {
        let session = self.session.as_ref()?.id.clone();
        self.expire_request(&session, now_ms)
    }

    /// Drop only the still-matching pending request. Native timeout workers use
    /// this form so a stale worker cannot end an accepted or replacement
    /// session after it wakes.
    pub fn expire_request(&mut self, session: &str, now_ms: u64) -> Option<SessionInfo> {
        let stale = self.session.as_ref().is_some_and(|s| {
            s.id == session
                && s.phase == Phase::Requested
                && now_ms.saturating_sub(s.created_ms) >= REQUEST_TTL_MS
        });
        if !stale {
            return None;
        }
        let mut info = self.session.take()?.info();
        info.phase = Phase::Ended;
        Some(info)
    }

    /// Viewer starts a request to `peer`.
    pub fn request_out(
        &mut self,
        id: &str,
        peer: &str,
        mode: Mode,
        now_ms: u64,
    ) -> Result<(), DeskError> {
        if !valid_session_id(id) {
            return Err(DeskError::BadSessionId);
        }
        self.expire(now_ms);
        if self.session.is_some() {
            return Err(DeskError::Busy);
        }
        self.session = Some(DeskSession::new(id, peer, Role::Viewer, mode, now_ms));
        Ok(())
    }

    /// Target user's decision. Accepting is the only path to
    /// [`DeskHub::capture_allowed`]. Returns the body to send back.
    pub fn respond(
        &mut self,
        id: &str,
        accept: bool,
        mode: Mode,
        now_ms: u64,
        deny_reason: &str,
    ) -> Result<DeskBody, DeskError> {
        let s = self.session.as_mut().ok_or(DeskError::NoSession)?;
        if s.id != id {
            return Err(DeskError::UnknownSession);
        }
        if s.role != Role::Target {
            return Err(DeskError::WrongRole);
        }
        if s.phase != Phase::Requested {
            return Err(DeskError::NotActive);
        }
        if now_ms.saturating_sub(s.created_ms) >= REQUEST_TTL_MS {
            self.session = None;
            return Err(DeskError::Expired);
        }
        if !accept {
            self.session = None;
            return Ok(DeskBody::Deny {
                reason: deny_reason.chars().take(MAX_REASON_CHARS).collect(),
            });
        }
        let granted = mode.min(s.requested);
        s.phase = Phase::Active(granted);
        Ok(DeskBody::Accept { mode: granted })
    }

    /// Local End or revoke. Returns what ended, if anything matched.
    pub fn end_local(&mut self, id: &str) -> Result<SessionInfo, DeskError> {
        let s = self.session.as_ref().ok_or(DeskError::NoSession)?;
        if s.id != id {
            return Err(DeskError::UnknownSession);
        }
        let mut info = s.info();
        info.phase = Phase::Ended;
        self.session = None;
        Ok(info)
    }

    /// The link to `peer` dropped (or they left the team).
    pub fn peer_gone(&mut self, peer: &str) -> Option<SessionInfo> {
        if self.session.as_ref().map_or(false, |s| s.peer == peer) {
            let mut info = self.session.take()?.info();
            info.phase = Phase::Ended;
            return Some(info);
        }
        None
    }

    /// End whatever is running (app shutdown, relay stopped).
    pub fn end_all(&mut self) -> Option<SessionInfo> {
        let mut info = self.session.take()?.info();
        info.phase = Phase::Ended;
        Some(info)
    }

    /// Handle one message from the relay. `from` is the authenticated sender
    /// id the host stamped, never anything the peer claimed.
    pub fn handle(
        &mut self,
        from: &str,
        session: &str,
        body: &DeskBody,
        now_ms: u64,
    ) -> Result<Action, DeskError> {
        if !valid_session_id(session) {
            return Err(DeskError::BadSessionId);
        }
        body.validate()?;

        if let DeskBody::Request { mode } = body {
            self.expire(now_ms);
            if self.session.is_some() {
                return Err(DeskError::Busy);
            }
            self.session = Some(DeskSession::new(session, from, Role::Target, *mode, now_ms));
            return Ok(Action::Incoming { mode: *mode });
        }

        let s = self.session.as_ref().ok_or(DeskError::NoSession)?;
        if s.id != session {
            return Err(DeskError::UnknownSession);
        }
        if s.peer != from {
            return Err(DeskError::WrongPeer);
        }
        if s.phase == Phase::Requested && now_ms.saturating_sub(s.created_ms) >= REQUEST_TTL_MS {
            let info = self
                .expire_request(session, now_ms)
                .expect("the matching request was just proven expired");
            return Ok(Action::Expired { info });
        }
        let s = self
            .session
            .as_mut()
            .expect("the session was checked above");

        match body {
            DeskBody::End { reason } => {
                let mut info = s.info();
                info.phase = Phase::Ended;
                self.session = None;
                Ok(Action::Ended {
                    info,
                    reason: reason.clone(),
                })
            }
            DeskBody::Ping => Ok(Action::Nothing),
            DeskBody::Accept { mode } => {
                if s.role != Role::Viewer {
                    return Err(DeskError::WrongRole);
                }
                if s.phase != Phase::Requested {
                    return Err(DeskError::NotActive);
                }
                if *mode == Mode::Control && s.requested == Mode::ViewOnly {
                    return Err(DeskError::InvalidGrant);
                }
                s.phase = Phase::Active(*mode);
                Ok(Action::Activated(*mode))
            }
            DeskBody::Deny { reason } => {
                if s.role != Role::Viewer {
                    return Err(DeskError::WrongRole);
                }
                if s.phase != Phase::Requested {
                    return Err(DeskError::NotActive);
                }
                let mut info = s.info();
                info.phase = Phase::Ended;
                self.session = None;
                Ok(Action::Ended {
                    info,
                    reason: reason.clone(),
                })
            }
            DeskBody::Frame { seq, .. } => {
                if s.role != Role::Viewer {
                    return Err(DeskError::WrongRole);
                }
                if !matches!(s.phase, Phase::Active(_)) {
                    return Err(DeskError::NotActive);
                }
                if s.last_seq.map_or(false, |last| *seq <= last) {
                    return Err(DeskError::StaleSeq);
                }
                s.last_seq = Some(*seq);
                Ok(Action::Render)
            }
            DeskBody::Input { event } => {
                if s.role != Role::Target {
                    return Err(DeskError::WrongRole);
                }
                match s.phase {
                    Phase::Active(Mode::Control) => {}
                    Phase::Active(Mode::ViewOnly) => return Err(DeskError::ViewOnly),
                    _ => return Err(DeskError::NotActive),
                }
                if !s.limiter.allow(now_ms) {
                    return Err(DeskError::RateLimited);
                }
                Ok(Action::Apply(event.clone()))
            }
            DeskBody::Request { .. } => unreachable!("handled above"),
        }
    }

    /// Viewer side: may this event be sent now? Same rules as the target will
    /// apply, so a view-only session fails fast locally.
    pub fn check_outgoing_input(&self, id: &str, event: &InputEvent) -> Result<(), DeskError> {
        let s = self.session.as_ref().ok_or(DeskError::NoSession)?;
        if s.id != id {
            return Err(DeskError::UnknownSession);
        }
        if s.role != Role::Viewer {
            return Err(DeskError::WrongRole);
        }
        match s.phase {
            Phase::Active(Mode::Control) => event.validate(),
            Phase::Active(Mode::ViewOnly) => Err(DeskError::ViewOnly),
            _ => Err(DeskError::NotActive),
        }
    }
}

/// Tracks keys and buttons currently held on the target so they can be
/// released when a session ends or events were dropped.
#[derive(Debug, Default)]
pub struct HeldInput {
    keys: Vec<String>,
    buttons: Vec<Button>,
}

impl HeldInput {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record an event after it was applied successfully.
    pub fn note(&mut self, event: &InputEvent) {
        match event {
            InputEvent::Key { code, down: true } => {
                if !self.keys.contains(code) {
                    self.keys.push(code.clone());
                }
            }
            InputEvent::Key { code, down: false } => self.keys.retain(|k| k != code),
            InputEvent::MouseButton { button, down: true } => {
                if !self.buttons.contains(button) {
                    self.buttons.push(*button);
                }
            }
            InputEvent::MouseButton {
                button,
                down: false,
            } => self.buttons.retain(|b| b != button),
            _ => {}
        }
    }

    /// Release events for everything still held, newest first. Clears state.
    pub fn release_all(&mut self) -> Vec<InputEvent> {
        let mut out: Vec<InputEvent> = self
            .buttons
            .drain(..)
            .rev()
            .map(|button| InputEvent::MouseButton {
                button,
                down: false,
            })
            .collect();
        out.extend(
            self.keys
                .drain(..)
                .rev()
                .map(|code| InputEvent::Key { code, down: false }),
        );
        out
    }
}

// ---------- capture pipeline ----------

/// A captured display image, tightly packed RGBA8.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rgba {
    pub w: u32,
    pub h: u32,
    pub pixels: Vec<u8>,
}

/// Grabs the primary display. On macOS the real implementation needs the
/// Screen Recording permission and must return a clear error when missing.
pub trait ScreenSource {
    fn capture(&mut self) -> Result<Rgba, String>;
}

/// Turns an image into JPEG bytes at a quality of 1 to 100.
pub trait FrameEncoder {
    fn encode_jpeg(&mut self, img: &Rgba, quality: u8) -> Result<Vec<u8>, String>;
}

/// Applies an already validated input event to the local machine. On macOS the
/// real implementation needs the Accessibility permission and must return a
/// clear error when missing.
pub trait InputSink {
    fn apply(&mut self, event: &InputEvent) -> Result<(), String>;
}

/// Nearest neighbour downscale to at most `max_w` wide, keeping aspect ratio.
pub fn downscale(img: Rgba, max_w: u32) -> Rgba {
    if img.w <= max_w || img.w == 0 || img.h == 0 || max_w == 0 {
        return img;
    }
    let nw = max_w;
    let nh = ((img.h as u64 * nw as u64) / img.w as u64).max(1) as u32;
    let mut pixels = Vec::with_capacity(nw as usize * nh as usize * 4);
    for y in 0..nh {
        let sy = (y as u64 * img.h as u64 / nh as u64) as usize;
        for x in 0..nw {
            let sx = (x as u64 * img.w as u64 / nw as u64) as usize;
            let i = (sy * img.w as usize + sx) * 4;
            pixels.extend_from_slice(&img.pixels[i..i + 4]);
        }
    }
    Rgba {
        w: nw,
        h: nh,
        pixels,
    }
}

/// Capture, downscale, encode and wrap one frame. `Err(FrameTooLarge)` means
/// the caller should retry smaller or at lower quality.
pub fn build_frame(
    src: &mut dyn ScreenSource,
    enc: &mut dyn FrameEncoder,
    seq: u64,
    max_w: u32,
    quality: u8,
) -> Result<DeskBody, FrameError> {
    let img = src.capture().map_err(FrameError::Capture)?;
    let img = downscale(img, max_w);
    let jpeg = enc
        .encode_jpeg(&img, quality)
        .map_err(FrameError::Capture)?;
    let jpeg_b64 = base64::engine::general_purpose::STANDARD.encode(jpeg);
    let body = DeskBody::Frame {
        seq,
        w: img.w,
        h: img.h,
        jpeg_b64,
    };
    body.validate().map_err(|_| FrameError::TooLarge)?;
    Ok(body)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    /// Capture or encode failed, with a user-facing message.
    Capture(String),
    TooLarge,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoopExit {
    /// The alive flag went false (End, disconnect or shutdown).
    Stopped,
    /// `send` reported the peer is gone.
    PeerGone,
    /// Capture failed; the message is safe to show the user.
    Failed(String),
}

/// The target's capture thread body. Runs until `alive` clears, `send` returns
/// false or capture fails. `sleep` is injected so tests do not wait.
pub fn capture_loop(
    src: &mut dyn ScreenSource,
    enc: &mut dyn FrameEncoder,
    alive: &AtomicBool,
    send: &mut dyn FnMut(DeskBody) -> bool,
    sleep: &mut dyn FnMut(Duration),
) -> LoopExit {
    let mut pacer = FramePacer::new();
    let mut seq: u64 = 0;
    let mut quality: u8 = 70;
    let mut max_w = MAX_CAPTURE_WIDTH;
    while alive.load(Ordering::SeqCst) {
        let started = Instant::now();
        match build_frame(src, enc, seq, max_w, quality) {
            Ok(body) => {
                seq += 1;
                let sent = Instant::now();
                if !alive.load(Ordering::SeqCst) {
                    return LoopExit::Stopped;
                }
                if !send(body) {
                    return LoopExit::PeerGone;
                }
                pacer.report_send(sent.elapsed().as_millis() as u64);
            }
            Err(FrameError::TooLarge) => {
                // Shrink and try again next tick rather than dropping the link.
                quality = quality.saturating_sub(20).max(20);
                max_w = (max_w * 3 / 4).max(320);
            }
            Err(FrameError::Capture(e)) => return LoopExit::Failed(e),
        }
        let wait = pacer.sleep_ms(started.elapsed().as_millis() as u64);
        sleep(Duration::from_millis(wait));
    }
    LoopExit::Stopped
}

// ---------- fakes ----------

/// In-memory stand-ins used by this crate's tests and the app's tests.
pub mod fakes {
    use super::*;

    /// Produces a solid colour image of a fixed size and counts captures.
    pub struct FakeScreen {
        pub w: u32,
        pub h: u32,
        pub captures: usize,
        pub fail_with: Option<String>,
    }

    impl FakeScreen {
        pub fn new(w: u32, h: u32) -> Self {
            FakeScreen {
                w,
                h,
                captures: 0,
                fail_with: None,
            }
        }
    }

    impl ScreenSource for FakeScreen {
        fn capture(&mut self) -> Result<Rgba, String> {
            self.captures += 1;
            if let Some(e) = &self.fail_with {
                return Err(e.clone());
            }
            Ok(Rgba {
                w: self.w,
                h: self.h,
                pixels: vec![200; self.w as usize * self.h as usize * 4],
            })
        }
    }

    /// "Encodes" to `bytes_per_pixel_div` bytes per pixel so tests can force
    /// oversize frames without a real codec.
    pub struct FakeEncoder {
        pub bytes_per_pixel: usize,
        pub qualities: Vec<u8>,
    }

    impl FakeEncoder {
        pub fn new(bytes_per_pixel: usize) -> Self {
            FakeEncoder {
                bytes_per_pixel,
                qualities: Vec::new(),
            }
        }
    }

    impl FrameEncoder for FakeEncoder {
        fn encode_jpeg(&mut self, img: &Rgba, quality: u8) -> Result<Vec<u8>, String> {
            self.qualities.push(quality);
            Ok(vec![
                0xff;
                img.w as usize * img.h as usize * self.bytes_per_pixel
            ])
        }
    }

    #[derive(Default)]
    pub struct RecordingSink {
        pub applied: Vec<InputEvent>,
    }

    impl InputSink for RecordingSink {
        fn apply(&mut self, event: &InputEvent) -> Result<(), String> {
            self.applied.push(event.clone());
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fakes::*;
    use super::*;

    const S: &str = "sess-1";

    fn mv(x: f64, y: f64) -> DeskBody {
        DeskBody::Input {
            event: InputEvent::MouseMove { x, y },
        }
    }

    fn frame(seq: u64) -> DeskBody {
        DeskBody::Frame {
            seq,
            w: 10,
            h: 10,
            jpeg_b64: "AAAA".into(),
        }
    }

    /// Target hub with a pending request from peer "v".
    fn target_pending(mode: Mode) -> DeskHub {
        let mut hub = DeskHub::new();
        let a = hub.handle("v", S, &DeskBody::Request { mode }, 0).unwrap();
        assert_eq!(a, Action::Incoming { mode });
        hub
    }

    fn target_active(mode: Mode) -> DeskHub {
        let mut hub = target_pending(Mode::Control);
        hub.respond(S, true, mode, 10, "").unwrap();
        hub
    }

    #[test]
    fn unanswered_request_expires_at_boundary_and_frees_the_slot() {
        let mut hub = DeskHub::new();
        hub.handle(
            "a",
            S,
            &DeskBody::Request {
                mode: Mode::Control,
            },
            0,
        )
        .unwrap();
        assert_eq!(
            hub.handle(
                "b",
                "sess-2",
                &DeskBody::Request {
                    mode: Mode::Control
                },
                1
            ),
            Err(DeskError::Busy)
        );
        assert!(hub.expire(REQUEST_TTL_MS - 1).is_none());
        assert!(hub.expire(REQUEST_TTL_MS).is_some());
        assert!(hub
            .handle(
                "b",
                "sess-2",
                &DeskBody::Request {
                    mode: Mode::Control
                },
                REQUEST_TTL_MS,
            )
            .is_ok());
        assert_eq!(hub.current().unwrap().peer, "b");

        // Viewer side too, and active sessions never expire.
        let mut v = DeskHub::new();
        v.request_out("sess-3", "t", Mode::Control, 0).unwrap();
        assert!(v.expire(REQUEST_TTL_MS).is_some());
        assert!(v.current().is_none());
        let mut t = DeskHub::new();
        t.handle(
            "a",
            S,
            &DeskBody::Request {
                mode: Mode::Control,
            },
            0,
        )
        .unwrap();
        t.respond(S, true, Mode::Control, 1, "").unwrap();
        assert!(t.expire(REQUEST_TTL_MS * 10).is_none());
    }

    #[test]
    fn stale_expiry_cannot_end_an_active_or_replacement_session() {
        let mut hub = target_pending(Mode::Control);
        hub.respond(S, true, Mode::Control, 1, "").unwrap();
        assert!(hub.expire_request(S, REQUEST_TTL_MS).is_none());
        assert_eq!(hub.current().unwrap().phase, Phase::Active(Mode::Control));

        hub.end_local(S).unwrap();
        hub.handle(
            "other",
            "sess-2",
            &DeskBody::Request {
                mode: Mode::ViewOnly,
            },
            REQUEST_TTL_MS,
        )
        .unwrap();
        assert!(hub
            .expire_request(S, REQUEST_TTL_MS.saturating_mul(2))
            .is_none());
        assert_eq!(hub.current().unwrap().session, "sess-2");
    }

    #[test]
    fn held_input_releases_everything_still_down() {
        let mut h = HeldInput::new();
        let k = |c: &str, down| InputEvent::Key {
            code: c.into(),
            down,
        };
        h.note(&k("ControlLeft", true));
        h.note(&k("KeyA", true));
        h.note(&k("KeyA", false));
        h.note(&InputEvent::MouseButton {
            button: Button::Left,
            down: true,
        });
        let rel = h.release_all();
        assert_eq!(
            rel,
            vec![
                InputEvent::MouseButton {
                    button: Button::Left,
                    down: false
                },
                k("ControlLeft", false)
            ]
        );
        assert!(h.release_all().is_empty());
    }

    #[test]
    fn oversized_frame_dimensions_are_rejected() {
        let b = DeskBody::Frame {
            seq: 1,
            w: MAX_DIMENSION + 1,
            h: 10,
            jpeg_b64: "AAAA".into(),
        };
        assert_eq!(b.validate(), Err(DeskError::BadDimensions));
    }

    #[test]
    fn request_without_accept_never_captures() {
        let hub = target_pending(Mode::Control);
        assert!(!hub.capture_allowed(S));
        // Input before accept is refused.
        let mut hub = hub;
        assert_eq!(
            hub.handle("v", S, &mv(0.5, 0.5), 5),
            Err(DeskError::NotActive)
        );
    }

    #[test]
    fn accept_enables_capture_and_deny_clears() {
        let mut hub = target_pending(Mode::Control);
        let body = hub.respond(S, true, Mode::Control, 10, "").unwrap();
        assert_eq!(
            body,
            DeskBody::Accept {
                mode: Mode::Control
            }
        );
        assert!(hub.capture_allowed(S));
        assert!(!hub.capture_allowed("other"));

        let mut hub = target_pending(Mode::Control);
        let body = hub
            .respond(S, false, Mode::Control, 10, "no thanks")
            .unwrap();
        assert_eq!(
            body,
            DeskBody::Deny {
                reason: "no thanks".into()
            }
        );
        assert!(!hub.capture_allowed(S));
        assert!(hub.current().is_none());
    }

    #[test]
    fn grant_is_clamped_to_the_request() {
        let mut hub = target_pending(Mode::ViewOnly);
        let body = hub.respond(S, true, Mode::Control, 10, "").unwrap();
        assert_eq!(
            body,
            DeskBody::Accept {
                mode: Mode::ViewOnly
            }
        );
    }

    #[test]
    fn expired_request_cannot_be_accepted() {
        let mut hub = target_pending(Mode::Control);
        assert_eq!(
            hub.respond(S, true, Mode::Control, REQUEST_TTL_MS, ""),
            Err(DeskError::Expired)
        );
        assert!(!hub.capture_allowed(S));
    }

    #[test]
    fn late_incoming_answer_expires_viewer_request() {
        let mut hub = DeskHub::new();
        hub.request_out(S, "target", Mode::Control, 0).unwrap();
        let action = hub
            .handle(
                "target",
                S,
                &DeskBody::Accept {
                    mode: Mode::Control,
                },
                REQUEST_TTL_MS,
            )
            .unwrap();
        assert!(matches!(action, Action::Expired { info } if info.session == S));
        assert!(hub.current().is_none());
    }

    #[test]
    fn only_the_target_can_respond() {
        let mut hub = DeskHub::new();
        hub.request_out(S, "t", Mode::Control, 0).unwrap();
        assert_eq!(
            hub.respond(S, true, Mode::Control, 1, ""),
            Err(DeskError::WrongRole)
        );
        assert!(!hub.capture_allowed(S));
    }

    #[test]
    fn accept_by_wrong_peer_rejected() {
        let mut hub = DeskHub::new();
        hub.request_out(S, "t", Mode::Control, 0).unwrap();
        let r = hub.handle(
            "mallory",
            S,
            &DeskBody::Accept {
                mode: Mode::Control,
            },
            1,
        );
        assert_eq!(r, Err(DeskError::WrongPeer));
        assert_eq!(hub.current().unwrap().phase, Phase::Requested);
        let r = hub.handle(
            "t",
            S,
            &DeskBody::Accept {
                mode: Mode::Control,
            },
            1,
        );
        assert_eq!(r, Ok(Action::Activated(Mode::Control)));
    }

    #[test]
    fn viewer_cannot_be_granted_more_than_asked() {
        let mut hub = DeskHub::new();
        hub.request_out(S, "t", Mode::ViewOnly, 0).unwrap();
        let r = hub.handle(
            "t",
            S,
            &DeskBody::Accept {
                mode: Mode::Control,
            },
            1,
        );
        assert_eq!(r, Err(DeskError::InvalidGrant));
    }

    #[test]
    fn input_from_wrong_peer_or_session_rejected() {
        let mut hub = target_active(Mode::Control);
        assert_eq!(
            hub.handle("mallory", S, &mv(0.1, 0.1), 20),
            Err(DeskError::WrongPeer)
        );
        assert_eq!(
            hub.handle("v", "sess-2", &mv(0.1, 0.1), 20),
            Err(DeskError::UnknownSession)
        );
        assert!(matches!(
            hub.handle("v", S, &mv(0.1, 0.1), 20),
            Ok(Action::Apply(_))
        ));
    }

    #[test]
    fn view_only_never_injects_input() {
        let mut hub = target_active(Mode::ViewOnly);
        assert_eq!(
            hub.handle("v", S, &mv(0.5, 0.5), 20),
            Err(DeskError::ViewOnly)
        );
        let key = DeskBody::Input {
            event: InputEvent::Key {
                code: "Enter".into(),
                down: true,
            },
        };
        assert_eq!(hub.handle("v", S, &key, 20), Err(DeskError::ViewOnly));
    }

    #[test]
    fn out_of_range_coordinates_rejected() {
        let mut hub = target_active(Mode::Control);
        for (x, y) in [
            (-0.01, 0.5),
            (0.5, 1.01),
            (f64::NAN, 0.5),
            (f64::INFINITY, 0.0),
        ] {
            assert!(matches!(
                hub.handle("v", S, &mv(x, y), 20),
                Err(DeskError::OutOfRange(_))
            ));
        }
        assert!(hub.handle("v", S, &mv(0.0, 1.0), 20).is_ok());
    }

    #[test]
    fn unknown_keys_scroll_and_text_validated() {
        let ev = |e: InputEvent| DeskBody::Input { event: e };
        let mut hub = target_active(Mode::Control);
        assert_eq!(
            hub.handle(
                "v",
                S,
                &ev(InputEvent::Key {
                    code: "Power".into(),
                    down: true
                }),
                20
            ),
            Err(DeskError::UnknownKey)
        );
        assert_eq!(
            hub.handle(
                "v",
                S,
                &ev(InputEvent::Key {
                    code: "F13".into(),
                    down: true
                }),
                20
            ),
            Err(DeskError::UnknownKey)
        );
        assert!(hub
            .handle(
                "v",
                S,
                &ev(InputEvent::Key {
                    code: "KeyA".into(),
                    down: true
                }),
                20
            )
            .is_ok());
        assert!(matches!(
            hub.handle("v", S, &ev(InputEvent::Scroll { dx: 0, dy: 5000 }), 20),
            Err(DeskError::OutOfRange(_))
        ));
        let long = "a".repeat(MAX_TEXT_CHARS + 1);
        assert_eq!(
            hub.handle("v", S, &ev(InputEvent::Text { s: long }), 20),
            Err(DeskError::TextTooLong)
        );
        assert_eq!(
            hub.handle(
                "v",
                S,
                &ev(InputEvent::Text {
                    s: "a\u{7}b".into()
                }),
                20
            ),
            Err(DeskError::BadText)
        );
        let max = "a".repeat(MAX_TEXT_CHARS);
        assert!(hub
            .handle("v", S, &ev(InputEvent::Text { s: max }), 20)
            .is_ok());
    }

    #[test]
    fn oversize_frame_rejected() {
        let mut hub = DeskHub::new();
        hub.request_out(S, "t", Mode::ViewOnly, 0).unwrap();
        hub.handle(
            "t",
            S,
            &DeskBody::Accept {
                mode: Mode::ViewOnly,
            },
            1,
        )
        .unwrap();
        let big = DeskBody::Frame {
            seq: 0,
            w: 10,
            h: 10,
            jpeg_b64: "A".repeat(MAX_FRAME_B64 + 1),
        };
        assert_eq!(hub.handle("t", S, &big, 2), Err(DeskError::FrameTooLarge));
        let zero = DeskBody::Frame {
            seq: 0,
            w: 0,
            h: 10,
            jpeg_b64: "AA".into(),
        };
        assert_eq!(hub.handle("t", S, &zero, 2), Err(DeskError::BadDimensions));
        let at_cap = DeskBody::Frame {
            seq: 0,
            w: 10,
            h: 10,
            jpeg_b64: "A".repeat(MAX_FRAME_B64),
        };
        assert_eq!(hub.handle("t", S, &at_cap, 2), Ok(Action::Render));
    }

    #[test]
    fn replayed_and_stale_seq_rejected() {
        let mut hub = DeskHub::new();
        hub.request_out(S, "t", Mode::ViewOnly, 0).unwrap();
        // Frames before accept are refused.
        assert_eq!(hub.handle("t", S, &frame(0), 1), Err(DeskError::NotActive));
        hub.handle(
            "t",
            S,
            &DeskBody::Accept {
                mode: Mode::ViewOnly,
            },
            1,
        )
        .unwrap();
        assert_eq!(hub.handle("t", S, &frame(5), 2), Ok(Action::Render));
        assert_eq!(hub.handle("t", S, &frame(5), 3), Err(DeskError::StaleSeq));
        assert_eq!(hub.handle("t", S, &frame(4), 3), Err(DeskError::StaleSeq));
        assert_eq!(hub.handle("t", S, &frame(6), 4), Ok(Action::Render));
    }

    #[test]
    fn target_refuses_frames_and_viewer_refuses_input() {
        let mut t = target_active(Mode::Control);
        assert_eq!(t.handle("v", S, &frame(0), 20), Err(DeskError::WrongRole));
        let mut v = DeskHub::new();
        v.request_out(S, "t", Mode::Control, 0).unwrap();
        v.handle(
            "t",
            S,
            &DeskBody::Accept {
                mode: Mode::Control,
            },
            1,
        )
        .unwrap();
        assert_eq!(
            v.handle("t", S, &mv(0.5, 0.5), 2),
            Err(DeskError::WrongRole)
        );
    }

    #[test]
    fn input_rate_limit_enforced_and_recovers() {
        let mut hub = target_active(Mode::Control);
        let mut ok = 0;
        // A flood inside a single millisecond.
        for _ in 0..1000 {
            if hub.handle("v", S, &mv(0.5, 0.5), 100).is_ok() {
                ok += 1;
            }
        }
        assert_eq!(ok, 120);
        assert_eq!(
            hub.handle("v", S, &mv(0.5, 0.5), 100),
            Err(DeskError::RateLimited)
        );
        // 100 ms later about 24 tokens have refilled.
        assert!(hub.handle("v", S, &mv(0.5, 0.5), 200).is_ok());
    }

    #[test]
    fn second_concurrent_session_refused() {
        let mut hub = target_active(Mode::Control);
        let r = hub.handle(
            "other",
            "sess-2",
            &DeskBody::Request {
                mode: Mode::ViewOnly,
            },
            30,
        );
        assert_eq!(r, Err(DeskError::Busy));
        assert_eq!(hub.current().unwrap().session, S);
        assert_eq!(
            hub.request_out("sess-3", "x", Mode::ViewOnly, 30),
            Err(DeskError::Busy)
        );
    }

    #[test]
    fn bad_session_ids_refused() {
        let mut hub = DeskHub::new();
        for id in ["", "has space", "a/b", &"x".repeat(MAX_SESSION_ID + 1)] {
            assert_eq!(
                hub.handle(
                    "v",
                    id,
                    &DeskBody::Request {
                        mode: Mode::Control
                    },
                    0
                ),
                Err(DeskError::BadSessionId)
            );
            assert_eq!(
                hub.request_out(id, "t", Mode::Control, 0),
                Err(DeskError::BadSessionId)
            );
        }
    }

    #[test]
    fn end_and_disconnect_tear_down() {
        let mut hub = target_active(Mode::Control);
        // End from a stranger is ignored.
        assert_eq!(
            hub.handle("mallory", S, &DeskBody::End { reason: "x".into() }, 20),
            Err(DeskError::WrongPeer)
        );
        assert!(hub.capture_allowed(S));
        let a = hub
            .handle(
                "v",
                S,
                &DeskBody::End {
                    reason: "done".into(),
                },
                21,
            )
            .unwrap();
        assert!(matches!(a, Action::Ended { ref reason, .. } if reason == "done"));
        assert!(!hub.capture_allowed(S));

        let mut hub = target_active(Mode::Control);
        assert!(hub.peer_gone("someone-else").is_none());
        assert!(hub.capture_allowed(S));
        let info = hub.peer_gone("v").unwrap();
        assert_eq!(info.phase, Phase::Ended);
        assert!(!hub.capture_allowed(S));
        assert!(hub.current().is_none());

        let mut hub = target_active(Mode::Control);
        assert_eq!(hub.end_local("nope"), Err(DeskError::UnknownSession));
        assert!(hub.end_local(S).is_ok());
        assert!(hub.end_all().is_none());
    }

    #[test]
    fn deny_ends_viewer_session() {
        let mut hub = DeskHub::new();
        hub.request_out(S, "t", Mode::Control, 0).unwrap();
        let a = hub
            .handle(
                "t",
                S,
                &DeskBody::Deny {
                    reason: "no".into(),
                },
                1,
            )
            .unwrap();
        assert!(matches!(a, Action::Ended { .. }));
        assert!(hub.current().is_none());
    }

    #[test]
    fn viewer_checks_input_locally() {
        let mut hub = DeskHub::new();
        hub.request_out(S, "t", Mode::Control, 0).unwrap();
        let ev = InputEvent::MouseMove { x: 0.5, y: 0.5 };
        assert_eq!(hub.check_outgoing_input(S, &ev), Err(DeskError::NotActive));
        hub.handle(
            "t",
            S,
            &DeskBody::Accept {
                mode: Mode::ViewOnly,
            },
            1,
        )
        .unwrap();
        assert_eq!(hub.check_outgoing_input(S, &ev), Err(DeskError::ViewOnly));
    }

    #[test]
    fn serde_round_trip_and_unknown_kind() {
        let bodies = vec![
            DeskBody::Request {
                mode: Mode::ViewOnly,
            },
            DeskBody::Accept {
                mode: Mode::Control,
            },
            DeskBody::Deny {
                reason: "busy".into(),
            },
            frame(3),
            mv(0.25, 0.75),
            DeskBody::Input {
                event: InputEvent::MouseButton {
                    button: Button::Left,
                    down: true,
                },
            },
            DeskBody::Input {
                event: InputEvent::Scroll { dx: 1, dy: -2 },
            },
            DeskBody::Input {
                event: InputEvent::Key {
                    code: "KeyA".into(),
                    down: false,
                },
            },
            DeskBody::Input {
                event: InputEvent::Text { s: "hi".into() },
            },
            DeskBody::Ping,
            DeskBody::End {
                reason: "bye".into(),
            },
        ];
        for b in bodies {
            let json = serde_json::to_string(&b).unwrap();
            let back: DeskBody = serde_json::from_str(&json).unwrap();
            assert_eq!(b, back, "{json}");
        }
        assert_eq!(
            serde_json::to_string(&DeskBody::Request {
                mode: Mode::ViewOnly
            })
            .unwrap(),
            r#"{"kind":"request","mode":"view-only"}"#
        );
        assert!(serde_json::from_str::<DeskBody>(r#"{"kind":"clipboard","text":"x"}"#).is_err());
        assert!(serde_json::from_str::<DeskBody>(
            r#"{"kind":"input","event":{"kind":"run","cmd":"rm"}}"#
        )
        .is_err());
        assert!(serde_json::from_str::<DeskBody>(r#"{"kind":"request","mode":"root"}"#).is_err());
    }

    #[test]
    fn key_allow_list() {
        for ok in [
            "KeyA", "KeyZ", "Digit0", "F1", "F12", "Enter", "ArrowUp", "MetaLeft",
        ] {
            assert!(is_known_key(ok), "{ok}");
        }
        for bad in [
            "", "Keya", "KeyAB", "Digit10", "F0", "F13", "F01", "Power", "key", "Sleep",
        ] {
            assert!(!is_known_key(bad), "{bad}");
        }
    }

    #[test]
    fn pacer_backs_off_and_recovers() {
        let mut p = FramePacer::new();
        assert_eq!(p.interval_ms(), 125);
        p.report_send(100);
        assert_eq!(p.interval_ms(), 250);
        for _ in 0..10 {
            p.report_send(2000);
        }
        assert_eq!(p.interval_ms(), FramePacer::MAX_MS);
        for _ in 0..100 {
            p.report_send(1);
        }
        assert_eq!(p.interval_ms(), FramePacer::TARGET_MS);
        assert_eq!(p.sleep_ms(25), 100);
        assert_eq!(p.sleep_ms(500), 0);
    }

    #[test]
    fn downscale_caps_width_and_keeps_aspect() {
        let img = Rgba {
            w: 3200,
            h: 1800,
            pixels: vec![7; 3200 * 1800 * 4],
        };
        let out = downscale(img, 1600);
        assert_eq!((out.w, out.h), (1600, 900));
        assert_eq!(out.pixels.len(), 1600 * 900 * 4);
        let small = Rgba {
            w: 100,
            h: 50,
            pixels: vec![1; 100 * 50 * 4],
        };
        assert_eq!(downscale(small.clone(), 1600), small);
    }

    #[test]
    fn capture_loop_streams_increasing_seq_then_stops() {
        let mut src = FakeScreen::new(2000, 1000);
        let mut enc = FakeEncoder::new(0);
        let alive = AtomicBool::new(true);
        let mut got: Vec<DeskBody> = Vec::new();
        let mut send = |b: DeskBody| {
            got.push(b);
            if got.len() == 3 {
                alive.store(false, Ordering::SeqCst);
            }
            true
        };
        let mut slept = Vec::new();
        let exit = capture_loop(&mut src, &mut enc, &alive, &mut send, &mut |d| {
            slept.push(d)
        });
        assert_eq!(exit, LoopExit::Stopped);
        let seqs: Vec<u64> = got
            .iter()
            .map(|b| match b {
                DeskBody::Frame { seq, w, h, .. } => {
                    assert_eq!((*w, *h), (1600, 800));
                    *seq
                }
                _ => panic!("not a frame"),
            })
            .collect();
        assert_eq!(seqs, vec![0, 1, 2]);
        assert!(!slept.is_empty());
    }

    #[test]
    fn capture_loop_stops_when_peer_gone_and_reports_capture_errors() {
        let mut src = FakeScreen::new(10, 10);
        let mut enc = FakeEncoder::new(1);
        let alive = AtomicBool::new(true);
        let exit = capture_loop(&mut src, &mut enc, &alive, &mut |_| false, &mut |_| {});
        assert_eq!(exit, LoopExit::PeerGone);

        let mut src = FakeScreen::new(10, 10);
        src.fail_with = Some("Screen Recording permission is required".into());
        let exit = capture_loop(&mut src, &mut enc, &alive, &mut |_| true, &mut |_| {});
        assert_eq!(
            exit,
            LoopExit::Failed("Screen Recording permission is required".into())
        );

        // Never starts when already stopped: nothing is captured.
        let mut src = FakeScreen::new(10, 10);
        let stopped = AtomicBool::new(false);
        capture_loop(&mut src, &mut enc, &stopped, &mut |_| true, &mut |_| {});
        assert_eq!(src.captures, 0);
    }

    #[test]
    fn capture_loop_shrinks_when_frames_are_too_big() {
        // 1600x800 at 2 bytes per pixel is far over the cap, so it must back off.
        let mut src = FakeScreen::new(1600, 800);
        let mut enc = FakeEncoder::new(2);
        let alive = AtomicBool::new(true);
        let mut n = 0;
        let mut send = |_b: DeskBody| {
            n += 1;
            n < 1
        };
        let exit = capture_loop(&mut src, &mut enc, &alive, &mut send, &mut |_| {});
        assert_eq!(exit, LoopExit::PeerGone);
        assert!(enc.qualities.len() > 1);
        assert!(enc.qualities.windows(2).all(|w| w[1] <= w[0]));
    }

    /// Whole flow with fakes: request, local accept, capture, input applied.
    #[test]
    fn end_to_end_with_fakes() {
        let mut viewer = DeskHub::new();
        let mut target = DeskHub::new();

        viewer.request_out(S, "t", Mode::Control, 0).unwrap();
        let req = DeskBody::Request {
            mode: Mode::Control,
        };
        assert_eq!(
            target.handle("v", S, &req, 0),
            Ok(Action::Incoming {
                mode: Mode::Control
            })
        );
        assert!(!target.capture_allowed(S));

        let reply = target.respond(S, true, Mode::Control, 1, "").unwrap();
        assert_eq!(
            viewer.handle("t", S, &reply, 1),
            Ok(Action::Activated(Mode::Control))
        );
        assert!(target.capture_allowed(S));

        // Target captures one frame and the viewer accepts it.
        let mut src = FakeScreen::new(800, 600);
        let mut enc = FakeEncoder::new(0);
        let alive = AtomicBool::new(true);
        let mut frames = Vec::new();
        capture_loop(
            &mut src,
            &mut enc,
            &alive,
            &mut |b| {
                frames.push(b);
                alive.store(false, Ordering::SeqCst);
                true
            },
            &mut |_| {},
        );
        assert_eq!(frames.len(), 1);
        assert_eq!(viewer.handle("t", S, &frames[0], 2), Ok(Action::Render));

        // Viewer input passes both checks and reaches the sink.
        let ev = InputEvent::MouseButton {
            button: Button::Right,
            down: true,
        };
        viewer.check_outgoing_input(S, &ev).unwrap();
        let mut sink = RecordingSink::default();
        match target
            .handle("v", S, &DeskBody::Input { event: ev.clone() }, 3)
            .unwrap()
        {
            Action::Apply(e) => sink.apply(&e).unwrap(),
            other => panic!("{other:?}"),
        }
        assert_eq!(sink.applied, vec![ev]);
    }
}
