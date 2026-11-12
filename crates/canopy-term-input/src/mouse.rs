//! Mouse reports.
//!
//! Source: xterm ctlseqs, "Mouse Tracking" and following sections
//! (<https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Mouse-Tracking>).
//!
//! * Button codes: 0/1/2 for left/middle/right, `3` for a legacy release, 64+
//!   for wheel buttons 4-7, 128+ for buttons 8-11. Modifiers add Shift 4,
//!   Meta (Alt here) 8, Control 16. Motion adds 32.
//! * X10 (mode 9) reports presses of buttons 1-3 only, with no modifiers.
//!   1000 adds releases and the wheel, 1002 motion with a button held, 1003
//!   all motion (no button is reported as code 3 + 32).
//! * Wheel releases are never reported.
//! * Default encoding is `CSI M Cb Cx Cy`, each value + 32 in one byte, so a
//!   coordinate past 223 cannot be expressed: such an event is **dropped**
//!   rather than clamped to a wrong cell. UTF-8 (1005) extends the limit to
//!   2015 and UTF-8-encodes Cb too. SGR (1006) is `CSI < Cb ; Cx ; Cy M`, with
//!   `m` and the real button for a release, and has no limit.
//!
//! Horizontal wheel: this crate sends left as button 6 (66) and right as
//! button 7 (67), the usual X11 button numbering. ctlseqs only mentions, for
//! one Logitech mouse, "button 7 (left) and button 6 (right)", so the two
//! sources disagree and this choice is unverified against xterm. The encoder
//! is stateless: dropping motion that stays in
//! the same cell (as xterm does) is the caller's job.

use canopy_term_core::frame::{Modes, MouseEncoding, MouseMode};

use crate::buf::{csi, push_char, push_u32};
use crate::mods::Mods;

/// A mouse button, including wheel directions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MouseButton {
    /// Button 1.
    Left,
    /// Button 2.
    Middle,
    /// Button 3.
    Right,
    /// Button 4.
    WheelUp,
    /// Button 5.
    WheelDown,
    /// Button 6.
    WheelLeft,
    /// Button 7.
    WheelRight,
    /// Button 8.
    Back,
    /// Button 9.
    Forward,
    /// Button 10.
    Button10,
    /// Button 11.
    Button11,
}

impl MouseButton {
    /// The xterm event code for this button, before modifiers and motion.
    pub const fn code(self) -> u8 {
        match self {
            MouseButton::Left => 0,
            MouseButton::Middle => 1,
            MouseButton::Right => 2,
            MouseButton::WheelUp => 64,
            MouseButton::WheelDown => 65,
            MouseButton::WheelLeft => 66,
            MouseButton::WheelRight => 67,
            MouseButton::Back => 128,
            MouseButton::Forward => 129,
            MouseButton::Button10 => 130,
            MouseButton::Button11 => 131,
        }
    }

    /// True for the four wheel directions.
    pub const fn is_wheel(self) -> bool {
        matches!(
            self,
            MouseButton::WheelUp
                | MouseButton::WheelDown
                | MouseButton::WheelLeft
                | MouseButton::WheelRight
        )
    }
}

/// What happened.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MouseEventKind {
    /// A button went down, or one wheel step.
    Press(MouseButton),
    /// A button went up.
    Release(MouseButton),
    /// The pointer moved into a new cell, with the given button held (`None`
    /// when no button is down).
    Motion(Option<MouseButton>),
}

/// A mouse event at a cell. `col` and `row` are 0-based cell positions, like
/// `Cursor`; the encoder makes them 1-based.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct MouseEvent {
    /// What happened.
    pub kind: MouseEventKind,
    /// 0-based column.
    pub col: u16,
    /// 0-based row.
    pub row: u16,
    /// Modifiers. Only Shift, Alt (or Meta) and Ctrl are reported.
    pub mods: Mods,
}

/// Largest 1-based coordinate the default encoding can carry (255 - 32).
pub const LEGACY_COORD_LIMIT: u32 = 223;
/// Largest 1-based coordinate the UTF-8 (1005) encoding can carry.
pub const UTF8_COORD_LIMIT: u32 = 2015;

/// Appends the report for `ev` under `modes` to `out`. Returns `true` if
/// anything was written; `false` when the active mode does not report this
/// event (or, in the default encoding, the cell is beyond 223).
pub fn encode_mouse(ev: &MouseEvent, modes: Modes, out: &mut Vec<u8>) -> bool {
    let x10 = modes.mouse == MouseMode::Press;
    let (button, release, motion) = match ev.kind {
        MouseEventKind::Press(b) => (b.code(), false, false),
        MouseEventKind::Release(b) => {
            if b.is_wheel() {
                return false;
            }
            (b.code(), true, false)
        }
        MouseEventKind::Motion(held) => match (modes.mouse, held) {
            (MouseMode::Drag | MouseMode::Any, Some(b)) if !b.is_wheel() => (b.code(), false, true),
            (MouseMode::Any, _) => (3, false, true),
            _ => return false,
        },
    };
    match modes.mouse {
        MouseMode::Off => return false,
        MouseMode::Press => {
            if release || motion || button > 2 {
                return false;
            }
        }
        MouseMode::Normal | MouseMode::Drag | MouseMode::Any => {}
    }

    let mut mod_bits = 0u8;
    if !x10 {
        if ev.mods.contains(Mods::SHIFT) {
            mod_bits += 4;
        }
        if ev.mods.intersects(Mods::ALT | Mods::META) {
            mod_bits += 8;
        }
        if ev.mods.contains(Mods::CTRL) {
            mod_bits += 16;
        }
    }
    let motion_bit = if motion { 32 } else { 0 };
    // SGR keeps the button on release; the single-byte encodings cannot say
    // which button was released and send 3 instead (buttons 8-11 included).
    let cb = button + mod_bits + motion_bit;
    let legacy_cb = if release { 3 + mod_bits } else { cb };
    let x = ev.col as u32 + 1;
    let y = ev.row as u32 + 1;

    match modes.mouse_encoding {
        MouseEncoding::Sgr => {
            out.extend_from_slice(b"\x1b[<");
            push_u32(out, cb as u32);
            out.push(b';');
            push_u32(out, x);
            out.push(b';');
            push_u32(out, y);
            out.push(if release { b'm' } else { b'M' });
        }
        MouseEncoding::Default => {
            if x > LEGACY_COORD_LIMIT || y > LEGACY_COORD_LIMIT {
                return false;
            }
            csi(out);
            out.push(b'M');
            out.push(32 + legacy_cb);
            out.push((32 + x) as u8);
            out.push((32 + y) as u8);
        }
        MouseEncoding::Utf8 => {
            if x > UTF8_COORD_LIMIT || y > UTF8_COORD_LIMIT {
                return false;
            }
            csi(out);
            out.push(b'M');
            for v in [32 + legacy_cb as u32, 32 + x, 32 + y] {
                // v <= 2047, always a valid scalar value.
                push_char(out, char::from_u32(v).unwrap_or(' '));
            }
        }
    }
    true
}
