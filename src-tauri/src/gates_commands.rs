//! The app's half of rules-as-gates: write the approved policy where
//! `canopy-hook` reads it, and mint approve-once tokens when the person says
//! "Approve once" / "Allow once". The evaluator and the file formats live in
//! gates.rs, shared with the hook.

use crate::gates::{self, Policy, POLICY_VERSION};
use crate::ledger;

fn home() -> Result<String, String> {
    std::env::var("HOME").map_err(|_| "no home dir".to_string())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Write the approved gates for the repository `cwd` belongs to. Keyed by the
/// ledger's canonical root, so every worktree of a repo shares one policy just
/// as it shares one ledger. Returns the file written.
#[tauri::command]
pub async fn gates_policy_write(cwd: String, mut policy: Policy) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = ledger::canonical_root(&cwd);
        policy.version = POLICY_VERSION;
        policy.root = root.clone();
        policy.updated_at = now_ms();
        // Unenforceable gates are guidance by definition; never hand them to
        // the hook as though they were policy.
        policy
            .gates
            .retain(|g| !matches!(g.gate, gates::Gate::Unenforceable { .. }));
        gates::write_policy(&home()?, &root, &policy).map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn gates_policy_read(cwd: String) -> Result<Option<Policy>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = ledger::canonical_root(&cwd);
        let path = gates::policy_path(&home()?, &root);
        Ok(std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The person approved one exact action. `key` is what the hook stamped on the
/// blocked event; the token it mints is spent by the hook's next look.
#[tauri::command]
pub async fn gates_allow_once(key: String) -> Result<(), String> {
    gates::grant_once(&home()?, &key, now_ms())
}

#[cfg(test)]
mod tests {
    #[test]
    fn policy_and_ledger_share_a_key() {
        for root in ["/home/u/repo", "C:\\work\\repo", ""] {
            assert_eq!(
                crate::gates::root_hash(root),
                crate::ledger::root_hash(root)
            );
        }
    }
}
