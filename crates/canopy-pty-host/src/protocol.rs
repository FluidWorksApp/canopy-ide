//! Wire types. Control ops are one JSON line out, one JSON line back, on a fresh
//! connection. `attach` is the exception: after its reply line the same
//! connection carries raw PTY bytes both ways. Unknown fields are ignored so an
//! old host and a new app (or the reverse) can still `list` and `kill`.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    Hello,
    Spawn(SpawnSpec),
    List,
    Resize { id: u32, cols: u16, rows: u16 },
    Kill { id: u32 },
    Pgrp { id: u32 },
    RawMode { id: u32 },
    Reap { id: u32 },
    Attach { id: u32, after: u64 },
    Shutdown,
}

/// Exactly what the child gets. The host never adds its own environment: it can
/// be much older than the app, and the environment carries per-terminal tokens,
/// so it must never be logged or persisted.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct SpawnSpec {
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
    /// Opaque to the host: what the app needs to rebuild a tab after a restart.
    pub meta: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
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
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct Response {
    pub ok: bool,
    pub error: Option<String>,
    pub version: Option<u32>,
    pub host_pid: Option<u32>,
    pub id: Option<u32>,
    pub pid: Option<u32>,
    pub sessions: Option<Vec<SessionInfo>>,
    pub pgrp: Option<i32>,
    pub raw: Option<bool>,
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
    pub start: u64,
    pub end: u64,
    /// True when the requested offset had already left the ring.
    pub gap: bool,
    pub cols: u16,
    pub rows: u16,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_fields_are_ignored() {
        let r: Request = serde_json::from_str(r#"{"op":"hello","future":1}"#).unwrap();
        assert!(matches!(r, Request::Hello));
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
    fn unknown_op_is_an_error_not_a_panic() {
        assert!(serde_json::from_str::<Request>(r#"{"op":"nope"}"#).is_err());
    }
}
