//! Verbs: the third registry, and the only one with no logic of its own.
//!
//! A verb is an action the *desktop* must run, because what it needs isn't in
//! the Rust core — tabs that are open, a hibernation snapshot, a Monaco model.
//! The server's whole job is to check the grant, refuse a replay, hand the
//! request to the desktop and carry the answer back. It never learns what the
//! verb does, which is why a new one costs a line here and a handler in the
//! shell that owns the state.
//!
//! Two properties this has to hold, because the client is a phone:
//!
//!   * **Replay-safe.** A reconnecting client retries; an action id already
//!     answered returns the same answer instead of running twice.
//!   * **Single-flight.** Anything that moves a ref, wakes a project or spawns
//!     a process declares the guard, and a second request while one is in
//!     flight is refused rather than queued.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use super::Scope;

pub struct Verb {
    pub name: &'static str,
    pub scope: Scope,
    pub guard: Option<&'static str>,
}

/// Empty on purpose: every module shipped so far is backed by state the Rust
/// core already holds, and the Rust-first rule says such a module has no verbs.
/// The first frontend-owned surface (hibernation's `resume`) adds the first
/// line here.
pub const VERBS: &[Verb] = &[];

pub fn lookup(name: &str) -> Option<&'static Verb> {
    VERBS.iter().find(|v| v.name == name)
}

/// How many answered action ids to remember. A phone retries within seconds of
/// a drop, so this only has to outlive a reconnect — not a session.
const REPLAY_MEMORY: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    Ok,
    Err(String),
}

#[derive(Default)]
pub struct VerbRouter {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    inflight: HashMap<String, String>,
    answered: HashMap<String, Answer>,
    order: VecDeque<String>,
}

/// What `begin` decided. `Run` is the only outcome that reaches the desktop.
#[derive(Debug, PartialEq, Eq)]
pub enum Begin {
    Run,
    /// Already answered under this action id — hand the same answer back.
    Replay(Answer),
    Refused(String),
}

impl VerbRouter {
    /// Admit one action, or say why not. Takes a name and guard rather than a
    /// `Verb` because a granted Rust command needs exactly the same protection:
    /// a retried `pty_spawn_detached` must not leave two agents running.
    pub fn begin(&self, name: &str, guard: Option<&str>, action_id: &str) -> Begin {
        let mut inner = self.inner.lock().unwrap();
        if let Some(prev) = inner.answered.get(action_id) {
            return Begin::Replay(prev.clone());
        }
        if inner.inflight.contains_key(action_id) {
            return Begin::Refused(format!("{name} is already running"));
        }
        if guard == Some("single-flight") && inner.inflight.values().any(|n| n == name) {
            return Begin::Refused(format!("{name} is already running"));
        }
        inner
            .inflight
            .insert(action_id.to_string(), name.to_string());
        Begin::Run
    }

    pub fn finish(&self, action_id: &str, answer: Answer) {
        let mut inner = self.inner.lock().unwrap();
        inner.inflight.remove(action_id);
        inner.answered.insert(action_id.to_string(), answer);
        inner.order.push_back(action_id.to_string());
        while inner.order.len() > REPLAY_MEMORY {
            if let Some(old) = inner.order.pop_front() {
                inner.answered.remove(&old);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RESUME: Verb = Verb {
        name: "hibernation.resume",
        scope: Scope::Drive,
        guard: Some("single-flight"),
    };
    const PING: Verb = Verb {
        name: "core.ping",
        scope: Scope::View,
        guard: None,
    };

    #[test]
    fn a_replayed_action_id_returns_the_first_answer() {
        let r = VerbRouter::default();
        assert_eq!(r.begin(PING.name, PING.guard, "a1"), Begin::Run);
        r.finish("a1", Answer::Ok);
        assert_eq!(
            r.begin(PING.name, PING.guard, "a1"),
            Begin::Replay(Answer::Ok)
        );
    }

    #[test]
    fn single_flight_refuses_a_concurrent_run_under_a_new_id() {
        let r = VerbRouter::default();
        assert_eq!(r.begin(RESUME.name, RESUME.guard, "a1"), Begin::Run);
        match r.begin(RESUME.name, RESUME.guard, "a2") {
            Begin::Refused(msg) => assert!(msg.contains("hibernation.resume")),
            other => panic!("expected refusal, got {other:?}"),
        }
        r.finish("a1", Answer::Ok);
        assert_eq!(r.begin(RESUME.name, RESUME.guard, "a2"), Begin::Run);
    }

    #[test]
    fn unguarded_verbs_run_concurrently() {
        let r = VerbRouter::default();
        assert_eq!(r.begin(PING.name, PING.guard, "a1"), Begin::Run);
        assert_eq!(r.begin(PING.name, PING.guard, "a2"), Begin::Run);
    }

    #[test]
    fn replay_memory_is_bounded() {
        let r = VerbRouter::default();
        for i in 0..REPLAY_MEMORY + 10 {
            let id = format!("a{i}");
            r.begin(PING.name, PING.guard, &id);
            r.finish(&id, Answer::Ok);
        }
        assert_eq!(
            r.begin(PING.name, PING.guard, "a0"),
            Begin::Run,
            "oldest answer evicted"
        );
        assert!(matches!(
            r.begin(PING.name, PING.guard, &format!("a{}", REPLAY_MEMORY + 9)),
            Begin::Replay(_)
        ));
    }

    #[test]
    fn errors_replay_as_errors() {
        let r = VerbRouter::default();
        r.begin(PING.name, PING.guard, "a1");
        r.finish("a1", Answer::Err("nope".into()));
        assert_eq!(
            r.begin(PING.name, PING.guard, "a1"),
            Begin::Replay(Answer::Err("nope".into()))
        );
    }
}
