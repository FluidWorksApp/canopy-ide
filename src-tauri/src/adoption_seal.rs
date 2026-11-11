//! Signed adoption metadata for hosted terminals.
//!
//! The PTY host stores each session's metadata and hands it to any client of
//! `host.sock`, which is every process of this user, agents included. What an
//! adopting launch trusts from that metadata (whose terminal it is, which bridge
//! credential it holds, where it sits in the spawn tree) is therefore sealed with
//! an HMAC whose key the app keeps outside the host, in the platform secret store.
//! A session whose seal is missing or wrong is still adopted as a terminal, but
//! gets no bridge credential back.
//!
//! What this resists depends on the store. On macOS the Keychain item is
//! readable by Canopy without a prompt and by other processes only with the
//! user's approval, so an agent cannot forge a seal. On Linux the Secret Service
//! (and the fallback file) is readable by any process of the same user, so there
//! the seal only stops a forgery through the host that does not also read the
//! key. It never protects a token another same-user process reads from an
//! agent's environment, which that process can already do.

use std::sync::OnceLock;

const SERVICE: &str = "Canopy PTY host";
const DOMAIN: &str = "canopy-adopt-v1";

/// HMAC-SHA256 (RFC 2104), on `sha2` so no new dependency is pulled in.
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    const BLOCK: usize = 64;
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|b| b ^ 0x36));
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(block.map(|b| b ^ 0x5c));
    outer.update(inner);
    let mut out = [0u8; 32];
    out.copy_from_slice(&outer.finalize());
    out
}

/// The bytes a seal covers: every field adoption acts on, from the typed
/// struct, as a JSON array (fixed order, no maps of our own), with a domain tag.
fn canonical(meta: &crate::pty_hosted::HostedMeta) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!([
        DOMAIN,
        meta.v,
        meta.id,
        meta.generation,
        meta.instance,
        meta.kind,
        meta.cwd,
        meta.run,
        meta.command,
        meta.run_command_id,
        meta.run_id,
        meta.attempt_id,
        meta.execution_context,
        meta.bridge,
        meta.depth,
        meta.parent,
    ]))
    .unwrap_or_default()
}

pub fn seal(key: &[u8], meta: &crate::pty_hosted::HostedMeta) -> String {
    hex::encode(hmac_sha256(key, &canonical(meta)))
}

pub fn verify(key: &[u8], meta: &crate::pty_hosted::HostedMeta) -> bool {
    meta.seal
        .as_deref()
        .is_some_and(|seal| crate::context::constant_time_eq(seal, &self::seal(key, meta)))
}

/// The sealing key, created on first use. Read only with the PTY host on, on
/// its own thread with a bound, so a store that prompts or hangs costs the
/// launch two seconds and adopted agents their credentials, never the launch.
/// None when the store cannot be reached: nothing is sealed and nothing sealed
/// is trusted.
#[cfg(not(test))]
pub fn key() -> Option<[u8; 32]> {
    static KEY: OnceLock<Option<[u8; 32]>> = OnceLock::new();
    *KEY.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(load_or_create());
        });
        match rx.recv_timeout(std::time::Duration::from_secs(2)) {
            Ok(Ok(key)) => Some(key),
            Ok(Err(e)) => {
                log::warn!("adoption seal key unavailable ({e}); adopted terminals keep no bridge credential");
                None
            }
            Err(_) => {
                log::warn!("adoption seal key: the secret store did not answer in time");
                None
            }
        }
    })
}

/// Tests never touch the real secret store.
#[cfg(test)]
pub fn key() -> Option<[u8; 32]> {
    static KEY: OnceLock<Option<[u8; 32]>> = OnceLock::new();
    *KEY.get_or_init(|| Some([7u8; 32]))
}

#[cfg_attr(test, allow(dead_code))]
fn account() -> &'static str {
    if cfg!(debug_assertions) {
        "adoption-seal-dev"
    } else {
        "adoption-seal"
    }
}

#[cfg_attr(test, allow(dead_code))]
fn load_or_create() -> Result<[u8; 32], String> {
    if let Some(bytes) = crate::secure_store::get(SERVICE, account())? {
        if let Ok(key) = <[u8; 32]>::try_from(bytes.as_slice()) {
            return Ok(key);
        }
    }
    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key).map_err(|e| e.to_string())?;
    crate::secure_store::set(SERVICE, account(), &key)?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty_hosted::HostedMeta;

    /// RFC 4231 test cases 1, 2 and 6, checked against `openssl dgst -hmac`
    /// and Python's `hmac` before being written down.
    #[test]
    fn hmac_matches_rfc_4231() {
        assert_eq!(
            hex::encode(hmac_sha256(&[0x0b; 20], b"Hi There")),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        assert_eq!(
            hex::encode(hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert_eq!(
            hex::encode(hmac_sha256(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    fn meta() -> HostedMeta {
        HostedMeta {
            v: 1,
            id: 7,
            generation: 3,
            kind: "desktop".into(),
            cwd: "/w".into(),
            instance: "inst-a".into(),
            bridge: Some("ab".repeat(32)),
            depth: Some(1),
            parent: Some(2),
            ..Default::default()
        }
    }

    #[test]
    fn a_seal_verifies_only_with_its_key_and_its_fields() {
        let key = [1u8; 32];
        let mut sealed = meta();
        sealed.seal = Some(seal(&key, &sealed));
        assert!(verify(&key, &sealed));
        assert!(!verify(&[2u8; 32], &sealed));
        // The seal survives the host: serialised, stored, listed, parsed.
        let back: HostedMeta =
            serde_json::from_str(&serde_json::to_string(&sealed).unwrap()).unwrap();
        assert!(verify(&key, &back));
        let tamper: [fn(&mut HostedMeta); 7] = [
            |m| m.id = 8,
            |m| m.instance = "inst-b".into(),
            |m| m.bridge = Some("cd".repeat(32)),
            |m| m.depth = Some(0),
            |m| m.depth = None,
            |m| m.parent = None,
            |m| m.kind = "detached".into(),
        ];
        for change in tamper {
            let mut forged = sealed.clone();
            change(&mut forged);
            assert!(!verify(&key, &forged), "{forged:?}");
        }
        let mut unsealed = meta();
        unsealed.seal = None;
        assert!(!verify(&key, &unsealed));
    }
}
