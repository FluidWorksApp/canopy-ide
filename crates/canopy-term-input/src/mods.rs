//! Keyboard modifiers.

use std::ops::{BitOr, BitOrAssign};

/// Modifier state for a key or mouse event, as a bit set.
///
/// The bit values are exactly the kitty keyboard protocol's modifier bits
/// (<https://sw.kovidgoyal.net/kitty/keyboard-protocol/#modifiers>):
///
/// ```text
/// shift 1, alt 2, ctrl 4, super 8, hyper 16, meta 32, caps_lock 64, num_lock 128
/// ```
///
/// so the kitty encoding is `1 + bits`. Legacy xterm encodings use the low six
/// bits the same way (xterm's "Meta" parameter bit 8 is `SUPER` here) and drop
/// the lock bits. `ALT` is the Option key on macOS and `SUPER` is Command.
///
/// For an event on a modifier key itself, set the bit for that modifier as it
/// is *after* the event: pressing left Ctrl has `CTRL` set, releasing it does
/// not (unless the other Ctrl is still held).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Hash)]
pub struct Mods(pub u8);

impl Mods {
    /// No modifiers.
    pub const NONE: Mods = Mods(0);
    /// Shift.
    pub const SHIFT: Mods = Mods(1);
    /// Alt (Option on macOS).
    pub const ALT: Mods = Mods(1 << 1);
    /// Control.
    pub const CTRL: Mods = Mods(1 << 2);
    /// Super (Windows / Command).
    pub const SUPER: Mods = Mods(1 << 3);
    /// Hyper.
    pub const HYPER: Mods = Mods(1 << 4);
    /// Meta (a distinct XKB modifier, not Alt).
    pub const META: Mods = Mods(1 << 5);
    /// Caps Lock is on.
    pub const CAPS_LOCK: Mods = Mods(1 << 6);
    /// Num Lock is on.
    pub const NUM_LOCK: Mods = Mods(1 << 7);
    /// Both lock bits.
    pub const LOCKS: Mods = Mods((1 << 6) | (1 << 7));

    /// The raw bits.
    #[inline]
    pub const fn bits(self) -> u8 {
        self.0
    }

    /// True if every bit of `other` is set.
    #[inline]
    pub const fn contains(self, other: Mods) -> bool {
        self.0 & other.0 == other.0
    }

    /// True if any bit of `other` is set.
    #[inline]
    pub const fn intersects(self, other: Mods) -> bool {
        self.0 & other.0 != 0
    }

    /// True if no bit is set.
    #[inline]
    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// `self` with the bits of `other` added.
    #[inline]
    pub const fn union(self, other: Mods) -> Mods {
        Mods(self.0 | other.0)
    }

    /// `self` with the bits of `other` removed.
    #[inline]
    pub const fn difference(self, other: Mods) -> Mods {
        Mods(self.0 & !other.0)
    }
}

impl BitOr for Mods {
    type Output = Mods;
    #[inline]
    fn bitor(self, rhs: Mods) -> Mods {
        self.union(rhs)
    }
}

impl BitOrAssign for Mods {
    #[inline]
    fn bitor_assign(&mut self, rhs: Mods) {
        self.0 |= rhs.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bits_match_the_kitty_spec() {
        // https://sw.kovidgoyal.net/kitty/keyboard-protocol/#modifiers
        assert_eq!(Mods::SHIFT.bits(), 0b1);
        assert_eq!(Mods::ALT.bits(), 0b10);
        assert_eq!(Mods::CTRL.bits(), 0b100);
        assert_eq!(Mods::SUPER.bits(), 0b1000);
        assert_eq!(Mods::HYPER.bits(), 0b10000);
        assert_eq!(Mods::META.bits(), 0b100000);
        assert_eq!(Mods::CAPS_LOCK.bits(), 0b1000000);
        assert_eq!(Mods::NUM_LOCK.bits(), 0b10000000);
        assert_eq!(Mods::LOCKS, Mods::CAPS_LOCK | Mods::NUM_LOCK);
    }

    #[test]
    fn set_operations() {
        let m = Mods::CTRL | Mods::SHIFT;
        assert!(m.contains(Mods::CTRL));
        assert!(!m.contains(Mods::CTRL | Mods::ALT));
        assert!(m.intersects(Mods::CTRL | Mods::ALT));
        assert_eq!(m.difference(Mods::SHIFT), Mods::CTRL);
        assert!(Mods::NONE.is_empty());
        let mut n = Mods::NONE;
        n |= Mods::ALT;
        assert_eq!(n, Mods::ALT);
    }
}
