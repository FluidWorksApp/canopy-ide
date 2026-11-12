//! Wire types. Control ops are one JSON line out, one JSON line back, on a fresh
//! connection. `attach` is the exception: after its reply line the same
//! connection carries raw PTY bytes both ways. Unknown fields are ignored so an
//! old host and a new app (or the reverse) can still `list` and `kill`.

use serde::{Deserialize, Serialize};

/// Bumped when the wire format changes in a way an old peer would misread.
/// 2: `set_linger`, `set_state` and `get_state` ops (a version 1 host rejects
/// them as unknown, so a client that needs them checks `hello` first).
/// 3: `attach` takes `exclusive`, and the `read_ring` op. An older host ignores
/// `exclusive` and would take the session over, so a client checks `hello`
/// before relying on it; `HostClient::attach_exclusive` does.
/// 4: the `shutdown_if_idle` op. An older host rejects it as unknown, which a
/// client reads as "cannot stop this host atomically".
pub const PROTOCOL_VERSION: u32 = 4;
/// The first host version that honours `exclusive` and serves `read_ring`.
pub const EXCLUSIVE_ATTACH_VERSION: u32 = 3;
/// The `error` of an exclusive attach refused because a client is attached.
pub const BUSY: &str = "busy";
/// The first host version that serves `shutdown_if_idle`.
pub const SHUTDOWN_IF_IDLE_VERSION: u32 = 4;
/// The oldest client this host will serve, and the oldest host a client will
/// use. Raised only when compatibility is deliberately dropped.
pub const MIN_CLIENT_VERSION: u32 = 1;
pub const MIN_HOST_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    Hello {
        #[serde(default)]
        client_version: u32,
    },
    Spawn(SpawnSpec),
    List,
    Resize {
        id: u32,
        cols: u16,
        rows: u16,
    },
    Kill {
        id: u32,
    },
    SetMeta {
        id: u32,
        meta: Option<String>,
    },
    Pgrp {
        id: u32,
    },
    RawMode {
        id: u32,
    },
    Reap {
        id: u32,
    },
    /// Change how long a session may sit with no client before the host kills
    /// it. `None` lifts the limit (adoption does this once the app owns it).
    SetLinger {
        id: u32,
        linger_secs: Option<u64>,
    },
    /// A small per-host-lifetime store for the app (the instance token). With
    /// `if_unset`, the first caller wins and every caller gets the stored value.
    SetState {
        key: String,
        value: String,
        #[serde(default)]
        if_unset: bool,
    },
    GetState {
        key: String,
    },
    Attach {
        id: u32,
        after: u64,
        #[serde(default)]
        client_version: u32,
        /// Refuse (`error: BUSY`) instead of replacing a client that is
        /// already attached. Checked and taken in one step inside the host.
        #[serde(default)]
        exclusive: bool,
    },
    /// Read replay-ring bytes without attaching: the reply line (an
    /// `AttachReply` whose `len` says how many bytes follow), then exactly `len`
    /// raw bytes, then the host closes. Never touches the attached client,
    /// backpressure or the linger clock.
    ReadRing {
        id: u32,
        after: u64,
        /// At most this many bytes (the ring capacity if absent).
        #[serde(default)]
        max: Option<u64>,
    },
    Shutdown,
    /// Stop the host only if no session is running, decided and acted on under
    /// the same lock `spawn` takes: a spawn that wins the race makes this reply
    /// `busy`, and one that loses is refused. Replies `ok` (stopping) or
    /// `error: "busy"` with `running` set.
    ShutdownIfIdle,
}

/// Exactly what the child gets. The host never adds its own environment: it can
/// be much older than the app, and the environment carries per-terminal tokens,
/// so it must never be logged or persisted.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct SpawnSpec {
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
    /// Opaque to the host: what the app needs to rebuild a tab after a restart.
    pub meta: Option<String>,
    /// Kill the session this many seconds after its last client detaches (or
    /// after spawn if none ever attaches). None means it lives until killed.
    /// A crashed app leaves nothing to adopt a session, so callers that cannot
    /// yet be adopted must set this.
    pub linger_secs: Option<u64>,
    /// Caller-supplied idempotency key (a runner's session id plus request id).
    /// A second spawn with the same key returns the existing session instead of
    /// starting another, even if that session has exited, so a retried spawn gets
    /// its first answer. The key is freed when the session is reaped.
    pub key: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct SessionInfo {
    pub id: u32,
    pub pid: Option<u32>,
    pub cols: u16,
    pub rows: u16,
    /// Absolute output offsets still held in the host's replay ring.
    pub start: u64,
    pub end: u64,
    pub exited: Option<i32>,
    pub meta: Option<String>,
    /// The caller's key from spawn, if any.
    pub key: Option<String>,
    /// Whether a client is attached right now. `None` from a host that predates
    /// the field, which must read as "unknown", never as "free": adoption only
    /// takes sessions reported `Some(false)`.
    pub attached: Option<bool>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct Response {
    pub ok: bool,
    pub error: Option<String>,
    pub version: Option<u32>,
    pub min_client: Option<u32>,
    pub host_pid: Option<u32>,
    pub id: Option<u32>,
    pub pid: Option<u32>,
    /// True when a spawn returned an existing session for its key.
    pub existing: Option<bool>,
    pub sessions: Option<Vec<SessionInfo>>,
    /// Reply to a refused `shutdown_if_idle`: how many sessions are running.
    pub running: Option<usize>,
    pub pgrp: Option<i32>,
    pub raw: Option<bool>,
    /// Reply to `get_state` / `set_state`: the value now stored, if any.
    pub value: Option<String>,
    /// Reply to `hello`: the path this host was started from, so the app keeps
    /// that installed copy while the host lives. `None` from an older host.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exe: Option<String>,
}

impl Response {
    pub fn ok() -> Self {
        Response {
            ok: true,
            ..Default::default()
        }
    }
    pub fn err(message: impl Into<String>) -> Self {
        Response {
            ok: false,
            error: Some(message.into()),
            ..Default::default()
        }
    }
}

/// Reply line to `attach`, followed immediately by raw bytes from `start`.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct AttachReply {
    pub ok: bool,
    pub error: Option<String>,
    /// The host's protocol version, so a client can check the host at attach
    /// without a separate hello. 0 from a host that predates the field.
    pub version: u32,
    pub start: u64,
    pub end: u64,
    /// True when the requested offset had already left the ring.
    pub gap: bool,
    pub cols: u16,
    pub rows: u16,
    /// `read_ring` only: how many raw bytes follow the reply line.
    pub len: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_fields_are_ignored() {
        let r: Request = serde_json::from_str(r#"{"op":"hello","future":1}"#).unwrap();
        assert!(matches!(r, Request::Hello { client_version: 0 }));
        let r: Response = serde_json::from_str(r#"{"ok":true,"added_later":[1]}"#).unwrap();
        assert!(r.ok);
    }

    #[test]
    fn spawn_round_trips() {
        let spec = SpawnSpec {
            argv: vec!["sh".into(), "-c".into(), "true".into()],
            env: vec![("A".into(), "b".into())],
            cols: 80,
            rows: 24,
            ..Default::default()
        };
        let line = serde_json::to_string(&Request::Spawn(spec)).unwrap();
        match serde_json::from_str::<Request>(&line).unwrap() {
            Request::Spawn(s) => {
                assert_eq!(s.argv.len(), 3);
                assert_eq!(s.env[0].0, "A");
            }
            other => panic!("wrong variant {other:?}"),
        }
    }

    #[test]
    fn older_peers_that_omit_fields_still_parse() {
        // A host frozen at an older release must accept a newer app's spawn, and
        // the reverse, so every struct field is optional on the wire.
        let spec: SpawnSpec = serde_json::from_str(r#"{"argv":["sh"]}"#).unwrap();
        assert_eq!(spec.argv, vec!["sh".to_string()]);
        assert!(spec.env.is_empty() && spec.cwd.is_none());
        let info: SessionInfo = serde_json::from_str(r#"{"id":3}"#).unwrap();
        assert_eq!(info.id, 3);
        assert!(info.exited.is_none());
    }

    #[test]
    fn attach_from_an_older_client_is_not_exclusive() {
        let r: Request = serde_json::from_str(r#"{"op":"attach","id":1,"after":0}"#).unwrap();
        assert!(matches!(
            r,
            Request::Attach {
                exclusive: false,
                ..
            }
        ));
        let r: Request = serde_json::from_str(r#"{"op":"read_ring","id":1,"after":5}"#).unwrap();
        assert!(matches!(
            r,
            Request::ReadRing {
                id: 1,
                after: 5,
                max: None
            }
        ));
    }

    #[test]
    fn shutdown_if_idle_round_trips_and_an_old_host_calls_it_unknown() {
        let line = serde_json::to_string(&Request::ShutdownIfIdle).unwrap();
        assert_eq!(line, r#"{"op":"shutdown_if_idle"}"#);
        assert!(matches!(
            serde_json::from_str::<Request>(&line).unwrap(),
            Request::ShutdownIfIdle
        ));
        let r: Response =
            serde_json::from_str(r#"{"ok":false,"error":"busy","running":2}"#).unwrap();
        assert_eq!(r.running, Some(2));
    }

    #[test]
    fn unknown_op_is_an_error_not_a_panic() {
        assert!(serde_json::from_str::<Request>(r#"{"op":"nope"}"#).is_err());
    }
}
