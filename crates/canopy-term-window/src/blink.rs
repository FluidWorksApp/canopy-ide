//! Cursor blink as a pure function of time, so the event loop only has to ask
//! "visible now?" and "when does that change?".
//!
//! The cursor is solid right after input or output (`reset`), blinks while the
//! window is focused, and stops blinking (solid) after `idle_stop` without
//! activity so an idle terminal causes no redraws. Unfocused or with reduced
//! motion it never blinks.

use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug)]
pub struct CursorBlink {
    /// Time the cursor stays on, then off.
    pub half_period: Duration,
    /// Blinking stops (cursor solid) this long after the last activity.
    pub idle_stop: Duration,
    /// Off: the cursor is always visible (user setting or reduced motion).
    pub enabled: bool,
    focused: bool,
    since: Instant,
}

impl CursorBlink {
    pub fn new(now: Instant) -> Self {
        CursorBlink {
            half_period: Duration::from_millis(530),
            idle_stop: Duration::from_secs(10),
            enabled: true,
            focused: true,
            since: now,
        }
    }

    /// Input or output happened: the cursor is shown solid and the phase
    /// restarts.
    pub fn reset(&mut self, now: Instant) {
        self.since = now;
    }

    pub fn set_focused(&mut self, focused: bool, now: Instant) {
        self.focused = focused;
        self.since = now;
    }

    fn blinking(&self, now: Instant) -> bool {
        self.enabled
            && self.focused
            && !self.half_period.is_zero()
            && now.saturating_duration_since(self.since) < self.idle_stop
    }

    /// Whether the cursor is drawn at `now`.
    pub fn visible(&self, now: Instant) -> bool {
        if !self.blinking(now) {
            return true;
        }
        let elapsed = now.saturating_duration_since(self.since).as_nanos();
        let half = self.half_period.as_nanos();
        (elapsed / half) % 2 == 0
    }

    /// The next instant `visible` changes, or `None` if it will not change
    /// without new activity (so the event loop can sleep indefinitely).
    pub fn next_change(&self, now: Instant) -> Option<Instant> {
        if !self.blinking(now) {
            return None;
        }
        let elapsed = now.saturating_duration_since(self.since).as_nanos();
        let half = self.half_period.as_nanos();
        let next = (elapsed / half + 1) * half;
        let next = self.since + Duration::from_nanos(next.min(u64::MAX as u128) as u64);
        let stop = self.since + self.idle_stop;
        if next >= stop {
            // The last change: the cursor turns solid at `stop` if it is off
            // then; if it is on, nothing changes.
            return (!self.visible(now)).then_some(stop);
        }
        Some(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn blinks_on_then_off_from_the_last_activity() {
        let t0 = Instant::now();
        let mut b = CursorBlink::new(t0);
        b.half_period = ms(500);
        assert!(b.visible(t0));
        assert!(b.visible(t0 + ms(499)));
        assert!(!b.visible(t0 + ms(500)));
        assert!(b.visible(t0 + ms(1000)));
        assert_eq!(b.next_change(t0 + ms(100)), Some(t0 + ms(500)));
        assert_eq!(b.next_change(t0 + ms(500)), Some(t0 + ms(1000)));
    }

    #[test]
    fn activity_restarts_the_phase_solid() {
        let t0 = Instant::now();
        let mut b = CursorBlink::new(t0);
        b.half_period = ms(500);
        assert!(!b.visible(t0 + ms(700)));
        b.reset(t0 + ms(700));
        assert!(b.visible(t0 + ms(700)));
        assert_eq!(b.next_change(t0 + ms(700)), Some(t0 + ms(1200)));
    }

    #[test]
    fn stops_blinking_when_idle_so_nothing_wakes_the_loop() {
        let t0 = Instant::now();
        let mut b = CursorBlink::new(t0);
        b.half_period = ms(500);
        b.idle_stop = ms(1250);
        // At 1000 it turns on; the next would be off at 1500, past the stop.
        assert_eq!(b.next_change(t0 + ms(1000)), None);
        // At 600 it is off; the next change (on at 1000) is before the stop.
        assert_eq!(b.next_change(t0 + ms(600)), Some(t0 + ms(1000)));
        assert!(b.visible(t0 + ms(5000)));
        assert_eq!(b.next_change(t0 + ms(5000)), None);
    }

    #[test]
    fn an_off_phase_at_the_stop_turns_solid_at_the_stop() {
        let t0 = Instant::now();
        let mut b = CursorBlink::new(t0);
        b.half_period = ms(500);
        b.idle_stop = ms(800);
        assert!(!b.visible(t0 + ms(600)));
        assert_eq!(b.next_change(t0 + ms(600)), Some(t0 + ms(800)));
        assert!(b.visible(t0 + ms(800)));
    }

    #[test]
    fn unfocused_or_disabled_never_blinks() {
        let t0 = Instant::now();
        let mut b = CursorBlink::new(t0);
        b.half_period = ms(500);
        b.set_focused(false, t0);
        assert!(b.visible(t0 + ms(600)));
        assert_eq!(b.next_change(t0), None);
        b.set_focused(true, t0);
        b.enabled = false;
        assert!(b.visible(t0 + ms(600)));
        assert_eq!(b.next_change(t0), None);
    }
}
