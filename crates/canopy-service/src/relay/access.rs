//! Signed access snapshots and the delivery rule (protocol §6).
//!
//! The control plane signs the exact snapshot bytes with Ed25519; the body
//! the gateway forwards is `{payload: base64(bytes), signature: base64(sig)}`
//! so neither end has to agree on a JSON canonicalisation. The key comes from
//! `access-keys.json` by the payload's `kid`.

use crate::util::{b64, now_ms};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

pub const MAX_SNAPSHOT_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Principal {
    pub user_id: String,
    #[serde(default)]
    pub sessions_interact: bool,
    #[serde(default)]
    pub projects: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccessSnapshot {
    pub v: u32,
    pub kid: String,
    pub workspace_id: String,
    pub service_device: String,
    pub revision: u64,
    pub issued_at: u64,
    pub expires_at: u64,
    /// Off unless the owner enabled teammate delivery for this workspace.
    #[serde(default)]
    pub team_delivery: bool,
    pub owner_user_id: String,
    #[serde(default)]
    pub principals: Vec<Principal>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SignedSnapshot {
    pub payload: String,
    pub signature: String,
}

/// `{kid: base64 raw 32-byte Ed25519 public key}`. A missing file means no
/// snapshot can be accepted, which leaves delivery to the owner only.
pub fn load_keys(path: &Path) -> HashMap<String, ed25519_dalek::VerifyingKey> {
    let Ok(raw) = std::fs::read(path) else {
        return HashMap::new();
    };
    let Ok(map) = serde_json::from_slice::<HashMap<String, String>>(&raw) else {
        eprintln!("canopy-serviced: {} is not a kid → key map", path.display());
        return HashMap::new();
    };
    map.into_iter()
        .filter_map(|(kid, key)| {
            let bytes: [u8; 32] = b64().decode(key.trim()).ok()?.try_into().ok()?;
            Some((kid, ed25519_dalek::VerifyingKey::from_bytes(&bytes).ok()?))
        })
        .collect()
}

/// Verify a snapshot's signature and binding. Rollback is the caller's check,
/// against the revision it has persisted.
pub fn verify(
    body: &[u8],
    keys: &HashMap<String, ed25519_dalek::VerifyingKey>,
    workspace_id: &str,
    service_device: &str,
) -> Result<(SignedSnapshot, AccessSnapshot), String> {
    if body.len() > MAX_SNAPSHOT_BYTES {
        return Err("access snapshot is larger than 64 KiB".into());
    }
    let signed: SignedSnapshot =
        serde_json::from_slice(body).map_err(|_| "access snapshot must be {payload, signature}")?;
    let payload = b64()
        .decode(&signed.payload)
        .map_err(|_| "access snapshot payload is not base64")?;
    let signature: [u8; 64] = b64()
        .decode(&signed.signature)
        .ok()
        .and_then(|s| s.try_into().ok())
        .ok_or("access snapshot signature is malformed")?;
    let snapshot: AccessSnapshot =
        serde_json::from_slice(&payload).map_err(|e| format!("access snapshot: {e}"))?;
    let key = keys
        .get(&snapshot.kid)
        .ok_or_else(|| format!("unknown access signing key {}", snapshot.kid))?;
    key.verify_strict(&payload, &ed25519_dalek::Signature::from_bytes(&signature))
        .map_err(|_| "access snapshot signature is invalid")?;
    if snapshot.v != 1 {
        return Err("unsupported access snapshot version".into());
    }
    if snapshot.workspace_id != workspace_id {
        return Err("access snapshot is for another workspace".into());
    }
    if snapshot.service_device != service_device {
        return Err("access snapshot is for another service device".into());
    }
    Ok((signed, snapshot))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    Deliver,
    Refuse(String),
}

/// Same account as the owner → deliver. A principal with session interaction
/// → deliver only when the owner enabled teammate delivery. Everyone else is
/// refused, and an expired (or absent) snapshot authorizes only the owner.
pub fn decide(
    owner_user_id: &str,
    snapshot: Option<&AccessSnapshot>,
    sender_user: &str,
    now: u64,
) -> Decision {
    if sender_user == owner_user_id {
        return Decision::Deliver;
    }
    let Some(snapshot) = snapshot else {
        return Decision::Refuse(
            "This workspace has no current access grant on its host, so only its owner can \
             deliver to it."
                .into(),
        );
    };
    if snapshot.expires_at <= now {
        return Decision::Refuse(
            "This workspace's access grant on its host has expired, so only its owner can \
             deliver to it until it refreshes."
                .into(),
        );
    }
    let granted = snapshot
        .principals
        .iter()
        .any(|p| p.user_id == sender_user && p.sessions_interact);
    match (granted, snapshot.team_delivery) {
        (true, true) => Decision::Deliver,
        (true, false) => Decision::Refuse(
            "The workspace owner has not enabled teammate delivery for this workspace.".into(),
        ),
        (false, _) => Decision::Refuse(
            "You have no session access to this workspace, so the host refused the delivery."
                .into(),
        ),
    }
}

pub fn decide_now(owner: &str, snapshot: Option<&AccessSnapshot>, sender: &str) -> Decision {
    decide(owner, snapshot, sender, now_ms())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ed25519_dalek::Signer;

    pub fn snapshot(revision: u64, expires_at: u64, team_delivery: bool) -> AccessSnapshot {
        AccessSnapshot {
            v: 1,
            kid: "k1".into(),
            workspace_id: "ws1".into(),
            service_device: "dev".into(),
            revision,
            issued_at: 0,
            expires_at,
            team_delivery,
            owner_user_id: "owner".into(),
            principals: vec![
                Principal {
                    user_id: "granted".into(),
                    sessions_interact: true,
                    projects: "all".into(),
                },
                Principal {
                    user_id: "viewer".into(),
                    sessions_interact: false,
                    projects: "all".into(),
                },
            ],
        }
    }

    pub fn sign(key: &ed25519_dalek::SigningKey, snapshot: &AccessSnapshot) -> Vec<u8> {
        let payload = serde_json::to_vec(snapshot).unwrap();
        serde_json::to_vec(&SignedSnapshot {
            payload: b64().encode(&payload),
            signature: b64().encode(key.sign(&payload).to_bytes()),
        })
        .unwrap()
    }

    #[test]
    fn the_authority_matrix() {
        let now = 1_000;
        let open = snapshot(1, 2_000, true);
        let closed = snapshot(1, 2_000, false);
        let expired = snapshot(1, 500, true);
        assert_eq!(decide("owner", None, "owner", now), Decision::Deliver);
        assert_eq!(
            decide("owner", Some(&expired), "owner", now),
            Decision::Deliver
        );
        assert_eq!(
            decide("owner", Some(&open), "granted", now),
            Decision::Deliver
        );
        assert!(
            matches!(decide("owner", Some(&closed), "granted", now), Decision::Refuse(r) if r.contains("teammate delivery"))
        );
        assert!(matches!(
            decide("owner", Some(&open), "viewer", now),
            Decision::Refuse(_)
        ));
        assert!(matches!(
            decide("owner", Some(&open), "stranger", now),
            Decision::Refuse(_)
        ));
        assert!(
            matches!(decide("owner", Some(&expired), "granted", now), Decision::Refuse(r) if r.contains("expired"))
        );
        assert!(matches!(
            decide("owner", None, "granted", now),
            Decision::Refuse(_)
        ));
    }

    #[test]
    fn signatures_and_bindings_are_checked() {
        let key = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let keys = HashMap::from([("k1".to_string(), key.verifying_key())]);
        let body = sign(&key, &snapshot(1, 2_000, false));
        assert!(verify(&body, &keys, "ws1", "dev").is_ok());
        assert!(verify(&body, &keys, "ws2", "dev").is_err());
        assert!(verify(&body, &keys, "ws1", "other").is_err());
        let wrong = ed25519_dalek::SigningKey::from_bytes(&[8u8; 32]);
        assert!(verify(
            &sign(&wrong, &snapshot(1, 2_000, false)),
            &keys,
            "ws1",
            "dev"
        )
        .is_err());
        let mut tampered: SignedSnapshot = serde_json::from_slice(&body).unwrap();
        let mut forged = snapshot(1, 2_000, true);
        forged.revision = 1;
        tampered.payload = b64().encode(serde_json::to_vec(&forged).unwrap());
        assert!(verify(&serde_json::to_vec(&tampered).unwrap(), &keys, "ws1", "dev").is_err());
    }
}
