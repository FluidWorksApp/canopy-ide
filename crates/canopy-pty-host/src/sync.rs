//! Locks that survive a panicking thread.
//!
//! A thread that panics while holding a `Mutex` poisons it, and every later
//! `lock().unwrap()` panics too. In the host that turned one failed
//! connection into the main loop panicking, which ends the process and every
//! terminal in it. The data behind these locks stays consistent between
//! statements (no invariant spans an unlock), so the host takes the guard and
//! carries on; the panic itself is caught and logged where it happened.

use std::sync::{Condvar, LockResult, Mutex, MutexGuard, WaitTimeoutResult};
use std::time::Duration;

pub trait LockExt<T: ?Sized> {
    /// `lock()`, ignoring poison.
    fn lock_ok(&self) -> MutexGuard<'_, T>;
}

impl<T: ?Sized> LockExt<T> for Mutex<T> {
    fn lock_ok(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub trait CondvarExt {
    /// `wait()`, ignoring poison.
    fn wait_ok<'a, T>(&self, guard: MutexGuard<'a, T>) -> MutexGuard<'a, T>;
    /// `wait_timeout()`, ignoring poison.
    fn wait_timeout_ok<'a, T>(
        &self,
        guard: MutexGuard<'a, T>,
        timeout: Duration,
    ) -> (MutexGuard<'a, T>, WaitTimeoutResult);
}

impl CondvarExt for Condvar {
    fn wait_ok<'a, T>(&self, guard: MutexGuard<'a, T>) -> MutexGuard<'a, T> {
        ok(self.wait(guard))
    }

    fn wait_timeout_ok<'a, T>(
        &self,
        guard: MutexGuard<'a, T>,
        timeout: Duration,
    ) -> (MutexGuard<'a, T>, WaitTimeoutResult) {
        ok(self.wait_timeout(guard, timeout))
    }
}

fn ok<G>(result: LockResult<G>) -> G {
    result.unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn a_lock_poisoned_by_a_panicking_thread_still_opens() {
        let m = Arc::new(Mutex::new(1));
        let m2 = Arc::clone(&m);
        let _ = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("poison it");
        })
        .join();
        assert!(m.is_poisoned());
        *m.lock_ok() += 1;
        assert_eq!(*m.lock_ok(), 2);
    }
}
