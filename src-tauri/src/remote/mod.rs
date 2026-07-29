//! The remote spine, Rust half: three registries and nothing feature-shaped.
//!
//! A module (see `shared/remote/modules/`) declares what it needs; this decides
//! what it gets. The direction matters — a manifest is a *request*, the tables
//! here are the *grant* — so a TypeScript edit can never widen the remote attack
//! surface on its own. `remote_registry.test.ts` fails when the two disagree,
//! and the fix is always to add the grant here deliberately.
//!
//!   commands   name -> handler + least scope that may call it (this file)
//!   streams    kind -> provider of live frames (streams.rs)
//!   verbs      name -> routed to the desktop, which owns the state (verbs.rs)
//!
//! Fail-closed everywhere: anything not listed is not reachable, whatever the
//! client asks for and whatever a manifest claims.

pub mod streams;
pub mod verbs;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::pty::PtyManager;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    View,
    Drive,
    Admin,
}

impl Scope {
    fn rank(self) -> u8 {
        match self {
            Scope::View => 0,
            Scope::Drive => 1,
            Scope::Admin => 2,
        }
    }

    pub fn allows(self, needed: Scope) -> bool {
        self.rank() >= needed.rank()
    }
}

/// Refuse a second run of the same action while one is in flight. Carried by
/// anything that spawns a process or moves a ref, because the client is a phone
/// and a phone retries.
pub const SINGLE_FLIGHT: Option<&str> = Some("single-flight");

/// The grant table: name, least scope that may call it, and its concurrency
/// guard. Adding a line here is the decision to expose a command to anything
/// holding a remote token — read it as a security review, not a list.
pub const GRANTS: &[(&str, Scope, Option<&str>)] = &[
    ("agent_usage", Scope::View, None),
    ("pty_kill", Scope::Drive, None),
    ("pty_resize", Scope::Drive, None),
    ("pty_spawn_detached", Scope::Drive, SINGLE_FLIGHT),
    ("session_digests", Scope::View, None),
    ("session_forget", Scope::Drive, None),
    ("store_load", Scope::View, None),
];

pub fn scope_of(name: &str) -> Option<Scope> {
    GRANTS
        .iter()
        .find(|(n, _, _)| *n == name)
        .map(|(_, scope, _)| *scope)
}

pub fn guard_of(name: &str) -> Option<&'static str> {
    GRANTS
        .iter()
        .find(|(n, _, _)| *n == name)
        .and_then(|(_, _, guard)| *guard)
}

/// Call a granted command. `granted` is the caller's token scope; the check
/// happens here rather than at the call site so no route can forget it.
pub async fn dispatch(
    app: &AppHandle,
    name: &str,
    args: &Value,
    granted: Scope,
) -> Result<Value, String> {
    let needed = scope_of(name).ok_or_else(|| format!("command not exposed remotely: {name}"))?;
    if !granted.allows(needed) {
        return Err(format!("insufficient scope for {name}"));
    }

    match name {
        "store_load" => crate::fsx::store_load().await.map(Value::from),

        "session_digests" => {
            let roots = args
                .get("roots")
                .and_then(|v| serde_json::from_value::<Vec<String>>(v.clone()).ok());
            crate::agents::session_digests(roots)
                .await
                .map(Value::from)
        }

        "agent_usage" => crate::agents::agent_usage()
            .await
            .and_then(|u| serde_json::to_value(u).map_err(|e| e.to_string())),

        "session_forget" => {
            let id = str_arg(args, "sessionId")?;
            crate::agents::session_forget(id).await.map(|_| Value::Null)
        }

        "pty_resize" => {
            let id = u32_arg(args, "id")?;
            let cols = u32_arg(args, "cols")? as u16;
            let rows = u32_arg(args, "rows")? as u16;
            crate::pty::pty_resize(app.state::<PtyManager>(), id, cols, rows)
                .and_then(|g| serde_json::to_value(g).map_err(|e| e.to_string()))
        }

        "pty_kill" => {
            let id = u32_arg(args, "id")?;
            crate::pty::pty_kill(app.state::<PtyManager>(), id).map(|_| Value::Null)
        }

        "pty_spawn_detached" => {
            let cwd = args
                .get("cwd")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let command = str_arg(args, "command")?;
            crate::pty::pty_spawn_detached(
                app.clone(),
                app.state::<PtyManager>(),
                cwd,
                command,
                None,
            )
            .and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string()))
        }

        // Unreachable while GRANTS and this match agree; the test below is what
        // keeps them agreeing.
        _ => Err(format!("command not exposed remotely: {name}")),
    }
}

fn str_arg(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("missing string arg: {key}"))
}

fn u32_arg(args: &Value, key: &str) -> Result<u32, String> {
    args.get(key)
        .and_then(|v| v.as_u64())
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| format!("missing numeric arg: {key}"))
}

/// What the portal is told about the shape of the server it reached: which
/// commands and verbs are live, and at what scope. The client uses it to hide
/// affordances it could not exercise anyway.
pub fn capabilities() -> Value {
    json!({
        "commands": GRANTS
            .iter()
            .map(|(n, s, g)| json!({ "name": n, "scope": s, "guard": g }))
            .collect::<Vec<_>>(),
        "verbs": verbs::VERBS
            .iter()
            .map(|v| json!({ "name": v.name, "scope": v.scope, "guard": v.guard }))
            .collect::<Vec<_>>(),
        "streams": streams::KINDS,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grants_are_sorted_and_unique() {
        let names: Vec<&str> = GRANTS.iter().map(|(n, _, _)| *n).collect();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(names, sorted, "GRANTS must be sorted and free of duplicates");
    }

    #[test]
    fn scope_ordering_is_a_ladder() {
        assert!(Scope::Admin.allows(Scope::View));
        assert!(Scope::Drive.allows(Scope::View));
        assert!(!Scope::View.allows(Scope::Drive));
        assert!(!Scope::Drive.allows(Scope::Admin));
    }

    #[test]
    fn unknown_commands_are_not_dispatchable() {
        assert!(scope_of("fs_write_file").is_none());
        assert!(scope_of("git_push").is_none());
        assert!(scope_of("pty_spawn").is_none());
    }

    /// Every arm of `dispatch` must be granted, and every grant must have an
    /// arm. A grant without an arm is a 404 the client cannot explain; an arm
    /// without a grant is a command reachable with no scope decision behind it.
    #[test]
    fn dispatch_arms_match_grants() {
        let src = include_str!("mod.rs");
        let body = src
            .split("match name {")
            .nth(1)
            .expect("dispatch match block");
        let arms: Vec<&str> = body
            .lines()
            .filter_map(|l| {
                let l = l.trim();
                l.strip_prefix('"')
                    .and_then(|rest| rest.split('"').next())
                    .filter(|_| l.contains("=>"))
            })
            .collect();
        let granted: Vec<&str> = GRANTS.iter().map(|(n, _, _)| *n).collect();
        for name in &granted {
            assert!(arms.contains(name), "grant {name} has no dispatch arm");
        }
        for arm in &arms {
            assert!(granted.contains(arm), "dispatch arm {arm} has no grant");
        }
    }
}
