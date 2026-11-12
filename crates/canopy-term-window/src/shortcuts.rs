//! Window shortcuts handled before a key reaches the program: copy, paste and
//! font zoom.
//!
//! macOS uses Command, which terminals never receive. Elsewhere Ctrl+Shift is
//! used, because Ctrl+C, Ctrl+V and Ctrl+- are control characters a program
//! must get. Both the shifted and unshifted character are accepted ('=' or '+',
//! '0' or ')') since the character a key produces with Shift depends on the
//! layout.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    MacOs,
    Other,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Platform::MacOs
        } else {
            Platform::Other
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Mods {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    /// Command on macOS, the Windows/Super key elsewhere.
    pub logo: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shortcut {
    Copy,
    Paste,
    ZoomIn,
    ZoomOut,
    ZoomReset,
    /// Open the find bar (Cmd+F; Ctrl+Shift+F elsewhere, because plain Ctrl+F
    /// is the program's forward-char or page-down).
    Find,
}

/// The shortcut for a key press, given the character its logical key produces
/// (lowercase or not) and the modifiers held.
pub fn shortcut(key: &str, mods: Mods, platform: Platform) -> Option<Shortcut> {
    let held = match platform {
        Platform::MacOs => mods.logo && !mods.ctrl && !mods.alt,
        Platform::Other => mods.ctrl && mods.shift && !mods.alt && !mods.logo,
    };
    if !held {
        return None;
    }
    let mut chars = key.chars();
    let ch = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    match ch.to_ascii_lowercase() {
        'c' => Some(Shortcut::Copy),
        'v' => Some(Shortcut::Paste),
        'f' => Some(Shortcut::Find),
        '=' | '+' => Some(Shortcut::ZoomIn),
        '-' | '_' => Some(Shortcut::ZoomOut),
        '0' | ')' => Some(Shortcut::ZoomReset),
        _ => None,
    }
}

/// [`shortcut`], plus plain Ctrl+C copying where there is a selection to copy
/// (Windows Terminal's rule): with a selection Ctrl+C copies, without one it
/// stays the program's interrupt, so a second press after copying interrupts.
/// macOS Command+C is always copy; Ctrl+C there is always the program's.
pub fn shortcut_with_selection(
    key: &str,
    mods: Mods,
    platform: Platform,
    has_selection: bool,
) -> Option<Shortcut> {
    if let Some(sc) = shortcut(key, mods, platform) {
        return Some(sc);
    }
    let plain_ctrl = mods.ctrl && !mods.shift && !mods.alt && !mods.logo;
    if has_selection && platform == Platform::Other && plain_ctrl && key.eq_ignore_ascii_case("c") {
        return Some(Shortcut::Copy);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const CMD: Mods = Mods {
        shift: false,
        ctrl: false,
        alt: false,
        logo: true,
    };
    const CTRL_SHIFT: Mods = Mods {
        shift: true,
        ctrl: true,
        alt: false,
        logo: false,
    };
    const CTRL: Mods = Mods {
        shift: false,
        ctrl: true,
        alt: false,
        logo: false,
    };

    #[test]
    fn macos_uses_command() {
        let m = Platform::MacOs;
        assert_eq!(shortcut("c", CMD, m), Some(Shortcut::Copy));
        assert_eq!(shortcut("v", CMD, m), Some(Shortcut::Paste));
        assert_eq!(shortcut("=", CMD, m), Some(Shortcut::ZoomIn));
        assert_eq!(shortcut("-", CMD, m), Some(Shortcut::ZoomOut));
        assert_eq!(shortcut("0", CMD, m), Some(Shortcut::ZoomReset));
        assert_eq!(shortcut("f", CMD, m), Some(Shortcut::Find));
        assert_eq!(shortcut("F", CMD, m), Some(Shortcut::Find));
        // Ctrl+F on macOS is the program's.
        assert_eq!(shortcut("f", CTRL, m), None);
        // Ctrl+C on macOS is the program's interrupt.
        assert_eq!(shortcut("c", CTRL, m), None);
    }

    #[test]
    fn elsewhere_ctrl_shift_and_plain_ctrl_goes_to_the_program() {
        let o = Platform::Other;
        assert_eq!(shortcut("C", CTRL_SHIFT, o), Some(Shortcut::Copy));
        assert_eq!(shortcut("V", CTRL_SHIFT, o), Some(Shortcut::Paste));
        assert_eq!(shortcut("+", CTRL_SHIFT, o), Some(Shortcut::ZoomIn));
        assert_eq!(shortcut("_", CTRL_SHIFT, o), Some(Shortcut::ZoomOut));
        assert_eq!(shortcut(")", CTRL_SHIFT, o), Some(Shortcut::ZoomReset));
        assert_eq!(shortcut("F", CTRL_SHIFT, o), Some(Shortcut::Find));
        // Plain Ctrl+F stays the program's (readline forward-char, less).
        assert_eq!(shortcut("f", CTRL, o), None);
        assert_eq!(shortcut("c", CTRL, o), None);
        assert_eq!(shortcut("-", CTRL, o), None);
        assert_eq!(shortcut("c", CMD, o), None);
    }

    #[test]
    fn named_keys_and_other_characters_are_not_shortcuts() {
        assert_eq!(shortcut("", CMD, Platform::MacOs), None);
        assert_eq!(shortcut("cv", CMD, Platform::MacOs), None);
        assert_eq!(shortcut("x", CMD, Platform::MacOs), None);
    }

    #[test]
    fn plain_ctrl_c_copies_only_with_a_selection_and_only_off_macos() {
        let o = Platform::Other;
        assert_eq!(
            shortcut_with_selection("c", CTRL, o, true),
            Some(Shortcut::Copy)
        );
        assert_eq!(
            shortcut_with_selection("C", CTRL, o, true),
            Some(Shortcut::Copy)
        );
        assert_eq!(shortcut_with_selection("c", CTRL, o, false), None);
        // The Ctrl+Shift form copies either way, and macOS is untouched.
        assert_eq!(
            shortcut_with_selection("C", CTRL_SHIFT, o, false),
            Some(Shortcut::Copy)
        );
        assert_eq!(
            shortcut_with_selection("c", CTRL, Platform::MacOs, true),
            None
        );
        assert_eq!(
            shortcut_with_selection("c", CMD, Platform::MacOs, false),
            Some(Shortcut::Copy)
        );
        // Other keys with Ctrl are never taken.
        assert_eq!(shortcut_with_selection("v", CTRL, o, true), None);
        assert_eq!(shortcut_with_selection("cc", CTRL, o, true), None);
    }
}
