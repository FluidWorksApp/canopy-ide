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
    Ok(serde_json::Value),
    Err(String),
}

#[derive(Default)]
pub struct VerbRouter {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    inflight: HashMap<String, (String, serde_json::Value)>,
    answered: HashMap<String, ((String, serde_json::Value), Answer)>,
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
    pub fn begin_request(
        &self,
        name: &str,
        guard: Option<&str>,
        action_id: &str,
        args: &serde_json::Value,
    ) -> Begin {
        let mut inner = self.inner.lock().unwrap();
        let request = (name.to_string(), args.clone());
        if let Some((original, answer)) = inner.answered.get(action_id) {
            return if original == &request {
                Begin::Replay(answer.clone())
            } else {
                Begin::Refused("request id reused for a different operation".into())
            };
        }
        if inner.inflight.contains_key(action_id) {
            return Begin::Refused(format!("{name} is already running"));
        }
        if inner.inflight.len() >= 128 {
            return Begin::Refused("too many remote operations in flight".into());
        }
        if guard == Some("single-flight") && inner.inflight.values().any(|(n, _)| n == name) {
            return Begin::Refused(format!("{name} is already running"));
        }
        inner.inflight.insert(action_id.to_string(), request);
        Begin::Run
    }

    #[cfg(test)]
    fn begin(&self, name: &str, guard: Option<&str>, action_id: &str) -> Begin {
        self.begin_request(name, guard, action_id, &serde_json::Value::Null)
    }

    pub fn finish(&self, action_id: &str, answer: Answer) {
        let mut inner = self.inner.lock().unwrap();
        let Some(request) = inner.inflight.remove(action_id) else {
            return;
        };
        // Large reads should not multiply retained memory by the replay count.
        // Keep an explicit error tombstone rather than accidentally running a
        // completed mutation again if its response exceeds the replay budget.
        let answer = match answer {
            Answer::Ok(ref value) if value.to_string().len() > 256 * 1024 => Answer::Err(
                "operation completed; response too large to replay; refresh its state".into(),
            ),
            other => other,
        };
        inner
            .answered
            .insert(action_id.to_string(), (request, answer));
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
        r.finish("a1", Answer::Ok(serde_json::Value::Null));
        assert_eq!(
            r.begin(PING.name, PING.guard, "a1"),
            Begin::Replay(Answer::Ok(serde_json::Value::Null))
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
        r.finish("a1", Answer::Ok(serde_json::Value::Null));
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
            r.finish(&id, Answer::Ok(serde_json::Value::Null));
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

    #[test]
    fn replay_preserves_the_full_result_and_rejects_changed_arguments() {
        let router = VerbRouter::default();
        let args = serde_json::json!({ "path": "/workspace/a" });
        let result = serde_json::json!({ "files": ["one", "two"] });
        assert_eq!(
            router.begin_request("fs_read_dir", None, "client:a", &args),
            Begin::Run
        );
        router.finish("client:a", Answer::Ok(result.clone()));
        assert_eq!(
            router.begin_request("fs_read_dir", None, "client:a", &args),
            Begin::Replay(Answer::Ok(result))
        );
        assert!(matches!(
            router.begin_request(
                "fs_read_dir",
                None,
                "client:a",
                &serde_json::json!({"path": "/workspace/b"})
            ),
            Begin::Refused(_)
        ));
        assert!(matches!(
            router.begin_request("pty_kill", None, "client:a", &args),
            Begin::Refused(_)
        ));
    }

    #[test]
    fn separate_principals_do_not_share_replay_answers() {
        let router = VerbRouter::default();
        assert_eq!(router.begin(PING.name, None, "principal-a:r1"), Begin::Run);
        router.finish("principal-a:r1", Answer::Ok(serde_json::json!("first")));
        assert_eq!(router.begin(PING.name, None, "principal-b:r1"), Begin::Run);
    }

    #[test]
    fn a_large_result_leaves_a_tombstone_instead_of_reexecuting() {
        let router = VerbRouter::default();
        assert_eq!(router.begin(PING.name, None, "large"), Begin::Run);
        router.finish(
            "large",
            Answer::Ok(serde_json::json!("x".repeat(256 * 1024 + 1))),
        );
        assert!(matches!(
            router.begin(PING.name, None, "large"),
            Begin::Replay(Answer::Err(_))
        ));
    }
}
