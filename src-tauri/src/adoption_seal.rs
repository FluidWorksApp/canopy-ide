//! Signed adoption metadata for hosted terminals.
//!
//! The PTY host stores each session's metadata and hands it to any client of
//! `host.sock`, which is every process of this user, agents included. What an
//! adopting launch trusts from that metadata (whose terminal it is, which bridge
//! credential it holds, where it sits in the spawn tree) is therefore sealed with
//! an HMAC whose key the app keeps outside the host, in the platform secret store.
//! A session whose seal is missing or wrong is still adopted as a terminal, but
//! gets no bridge credential back. The seal also covers the host's own id for
//! the session (`HostedMeta::host`), checked against the session it is listed
//! on, so metadata copied onto a decoy session verifies for nobody.
//!
//! What this resists depends on the store. On macOS the Keychain item is
//! readable by Canopy without a prompt and by other processes only with the
//! user's approval, so an agent cannot forge a seal. On Linux the Secret Service
//! (and the fallback file) is readable by any process of the same user, so there
//! the seal only stops a forgery through the host that does not also read the
//! key. It never protects a token another same-user process reads from an
//! agent's environment, which that process can already do.

const SERVICE: &str = "Canopy PTY host";
const DOMAIN: &str = "canopy-adopt-v1";
/// A different domain for a native window's session (`NativeMeta`): the two
/// kinds of seal are over differently shaped, differently tagged messages, so
/// one can never be presented as the other.
#[cfg_attr(not(unix), allow(dead_code))]
const NATIVE_DOMAIN: &str = "canopy-native-v1";

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
        meta.host,
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

/// The bytes a native-window seal covers: every field the listing reads, bound
/// to the host's id for the session like `canonical`.
#[cfg_attr(not(unix), allow(dead_code))]
fn canonical_native(meta: &crate::pty_hosted::NativeMeta) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!([
        NATIVE_DOMAIN,
        meta.native,
        meta.instance,
        meta.nonce,
        meta.host,
        meta.cwd,
    ]))
    .unwrap_or_default()
}

#[cfg_attr(not(unix), allow(dead_code))]
pub fn seal_native(key: &[u8], meta: &crate::pty_hosted::NativeMeta) -> String {
    hex::encode(hmac_sha256(key, &canonical_native(meta)))
}

#[cfg_attr(not(unix), allow(dead_code))]
pub fn verify_native(key: &[u8], meta: &crate::pty_hosted::NativeMeta) -> bool {
    meta.seal
        .as_deref()
        .is_some_and(|seal| crate::context::constant_time_eq(seal, &seal_native(key, meta)))
}

/// The sealing key, created on first use, never cached as absent. The secret
/// store is read on its own thread (a store that prompts or hangs must not take
/// the launch with it), once at a time; a load that fails or is still waiting
/// is simply asked again on a later call.
///
/// `key()` waits up to two seconds for the first answer, and after one wait
/// that ran out it stops waiting (a pending Keychain prompt must not stall every
/// spawn) and just reports what is loaded. `key_nowait()` never waits: the
/// launch-path resolution uses it. None means nothing is sealed and nothing
/// sealed is trusted, for that call only.
#[cfg(not(test))]
pub fn key() -> Option<[u8; 32]> {
    key_with(Some(std::time::Duration::from_secs(2)))
}

#[cfg(not(test))]
#[cfg_attr(not(unix), allow(dead_code))]
pub fn key_nowait() -> Option<[u8; 32]> {
    key_with(None)
}

/// Start the load now, so a later `key_nowait()` finds it done.
#[cfg(not(test))]
#[cfg_attr(not(unix), allow(dead_code))]
pub fn prefetch() {
    let _ = key_with(None);
}

#[cfg(not(test))]
fn key_with(wait: Option<std::time::Duration>) -> Option<[u8; 32]> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Condvar, Mutex};
    struct State {
        key: Option<[u8; 32]>,
        loading: bool,
    }
    static STATE: Mutex<State> = Mutex::new(State {
        key: None,
        loading: false,
    });
    static DONE: Condvar = Condvar::new();
    static GAVE_UP_WAITING: AtomicBool = AtomicBool::new(false);

    let mut state = STATE.lock().unwrap();
    if state.key.is_some() {
        return state.key;
    }
    if !state.loading {
        state.loading = true;
        std::thread::spawn(|| {
            let loaded = load_or_create();
            let mut state = STATE.lock().unwrap();
            state.loading = false;
            match loaded {
                Ok(key) => state.key = Some(key),
                Err(e) => log::warn!(
                    "adoption seal key unavailable ({e}); adopted terminals keep no bridge credential until it loads"
                ),
            }
            DONE.notify_all();
        });
    }
    let wait = wait.filter(|_| !GAVE_UP_WAITING.load(Ordering::Relaxed))?;
    let (state, timeout) = DONE
        .wait_timeout_while(state, wait, |s| s.loading && s.key.is_none())
        .unwrap();
    if timeout.timed_out() {
        GAVE_UP_WAITING.store(true, Ordering::Relaxed);
        log::warn!(
            "adoption seal key: the secret store did not answer in time; asking again later"
        );
    }
    state.key
}

/// Tests never touch the real secret store.
#[cfg(test)]
pub fn key() -> Option<[u8; 32]> {
    Some([7u8; 32])
}

#[cfg(test)]
#[cfg_attr(not(unix), allow(dead_code))]
pub fn key_nowait() -> Option<[u8; 32]> {
    key()
}

#[cfg(test)]
#[cfg_attr(not(unix), allow(dead_code))]
pub fn prefetch() {}

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
        let tamper: [fn(&mut HostedMeta); 8] = [
            |m| m.id = 8,
            |m| m.instance = "inst-b".into(),
            |m| m.bridge = Some("cd".repeat(32)),
            |m| m.depth = Some(0),
            |m| m.depth = None,
            |m| m.parent = None,
            |m| m.kind = "detached".into(),
            |m| m.host = Some(9),
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

    fn native() -> crate::pty_hosted::NativeMeta {
        crate::pty_hosted::NativeMeta {
            native: 1,
            instance: "inst-a".into(),
            nonce: "n0".into(),
            host: Some(5),
            cwd: "/w".into(),
            seal: None,
        }
    }

    #[test]
    fn a_native_seal_verifies_only_with_its_key_and_its_fields() {
        let key = [1u8; 32];
        let mut sealed = native();
        sealed.seal = Some(seal_native(&key, &sealed));
        assert!(verify_native(&key, &sealed));
        assert!(!verify_native(&[2u8; 32], &sealed));
        let tamper: [fn(&mut crate::pty_hosted::NativeMeta); 5] = [
            |m| m.instance = "inst-b".into(),
            |m| m.nonce = "n1".into(),
            |m| m.host = Some(6),
            |m| m.host = None,
            |m| m.cwd = "/elsewhere".into(),
        ];
        for change in tamper {
            let mut forged = sealed.clone();
            change(&mut forged);
            assert!(!verify_native(&key, &forged), "{forged:?}");
        }
        let mut unsealed = native();
        unsealed.seal = None;
        assert!(!verify_native(&key, &unsealed));
    }

    /// The two kinds of seal share a key and an HMAC, so the domain tag and the
    /// shape of the message are all that keep one from standing in for the
    /// other. Each seal fails the other kind's check, field for field.
    #[test]
    fn a_native_seal_is_never_an_adoption_seal_and_the_reverse() {
        let key = [3u8; 32];
        let mut terminal = meta();
        terminal.seal = Some(seal(&key, &terminal));
        let mut window = native();
        window.seal = Some(seal_native(&key, &window));
        // A native seal copied onto terminal metadata (and the terminal seal
        // onto a native window's) verifies for nothing.
        let mut crossed = meta();
        crossed.seal = window.seal.clone();
        assert!(!verify(&key, &crossed));
        let mut crossed = native();
        crossed.seal = terminal.seal.clone();
        assert!(!verify_native(&key, &crossed));
        // Even the same bytes under both domains differ.
        assert_ne!(window.seal, terminal.seal);
        assert_ne!(canonical_native(&window), canonical(&terminal));
    }
}
