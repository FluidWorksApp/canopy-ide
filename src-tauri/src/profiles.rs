//! Per-CLI account profiles: two Claude logins, two Codex logins, side by side.
//!
//! Every agent CLI we can isolate keys its whole identity — credentials, session
//! history, settings — off one environment variable naming a config directory.
//! So a profile is not a credential store: it is a *directory*, plus the env
//! that points a CLI at it. Canopy never reads, writes, or transports a token;
//! the user logs in once inside the profile's own terminal and the CLI owns the
//! result exactly as it does today.
//!
//! The layout is deliberately a mirror of a home directory:
//!
//!   ~/.canopy/profiles/<id>/.claude          <- CLAUDE_CONFIG_DIR
//!   ~/.canopy/profiles/<id>/.codex           <- CODEX_HOME
//!   ~/.canopy/profiles/<id>/.config          <- XDG_CONFIG_HOME
//!   ~/.canopy/profiles/<id>/.local/share     <- XDG_DATA_HOME
//!
//! because that makes the profile root substitutable for `$HOME` in every
//! `hooks_config_path`/`setup_*` in agents.rs — hook installation into a profile
//! is the same code path as into the default, handed a different root. What is
//! *not* substitutable is `~/.canopy` itself (the event bus, the digests, the
//! helper binary): those stay in the real home for every profile, which is why
//! the setup functions take the config root and the helper home separately.
//!
//! The default profile is not a directory we invent — it is `$HOME`, and it
//! exports no environment at all. A user who never opens this feature must get
//! byte-identical behaviour, so "default" is modelled as the absence of a
//! profile rather than as profile number one.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The implicit profile: plain `$HOME`, no env, what every session used before
/// this module existed. Reserved — a created profile can never claim this id.
pub const DEFAULT_ID: &str = "default";

/// CLIs whose credentials we can actually put in a box. Everything else is
/// listed by the UI as single-account rather than silently given a profile that
/// isolates nothing:
///   - agy (Antigravity): OS keyring, no documented config-home variable
///   - omp: no documented config-home variable
///   - aider: no login at all — its key is an API key in the environment
pub const PROFILE_AGENTS: &[&str] = &["claude", "codex", "opencode", "amp"];

pub fn supports_profiles(agent: &str) -> bool {
    PROFILE_AGENTS.contains(&agent)
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Profile {
    pub id: String,
    pub label: String,
    /// Absolute config root. `$HOME` for the default profile.
    pub root: String,
    /// False for the default profile, which cannot be renamed or removed.
    pub removable: bool,
}

fn registry_path(home: &str) -> PathBuf {
    PathBuf::from(home).join(".canopy").join("profiles.json")
}

/// Where a profile's CLI configuration lives. The default profile is `$HOME`
/// itself — never a copy of it, never a symlink farm.
pub fn root_for(home: &str, id: &str) -> PathBuf {
    if id == DEFAULT_ID {
        PathBuf::from(home)
    } else {
        PathBuf::from(home)
            .join(".canopy")
            .join("profiles")
            .join(id)
    }
}

/// Slug for a user-typed label. Lowercase, dashed, trimmed to something that is
/// safe as a single path segment — ids become directory names, so anything that
/// could traverse (`/`, `..`) has to be impossible by construction rather than
/// rejected later.
pub fn slugify(label: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true; // leading dashes are dropped
    for ch in label.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
        if out.len() >= 32 {
            break;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

fn read_registry(home: &str) -> Vec<(String, String)> {
    let Ok(raw) = std::fs::read_to_string(registry_path(home)) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    v["profiles"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    let id = p["id"].as_str()?.to_string();
                    // A registry entry whose id would escape its directory is
                    // dropped, not sanitised: silently rewriting it would point
                    // the CLI at a different account than the one named.
                    if id.is_empty() || id == DEFAULT_ID || slugify(&id) != id {
                        return None;
                    }
                    let label = p["label"].as_str().unwrap_or(&id).to_string();
                    Some((id, label))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The account new agents launch under, as last set from the UI.
///
/// Stored rather than held in the frontend alone because Rust launches agents
/// too: a session started from the phone goes through the portal, which has no
/// webview to ask. Without this, remote launches silently used the default
/// login while the desktop was switched to another account.
pub fn active(home: &str) -> String {
    std::fs::read_to_string(registry_path(home))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v["active"].as_str().map(|s| s.to_string()))
        .filter(|id| id == DEFAULT_ID || read_registry(home).iter().any(|(x, _)| x == id))
        .unwrap_or_else(|| DEFAULT_ID.to_string())
}

pub fn set_active(home: &str, id: &str) -> Result<(), String> {
    if id != DEFAULT_ID && !read_registry(home).iter().any(|(x, _)| x == id) {
        return Err(format!("no profile named '{id}'"));
    }
    let entries = read_registry(home);
    write_registry_with(home, &entries, id)
}

fn write_registry(home: &str, entries: &[(String, String)]) -> Result<(), String> {
    let active = active(home);
    write_registry_with(home, entries, &active)
}

fn write_registry_with(
    home: &str,
    entries: &[(String, String)],
    active: &str,
) -> Result<(), String> {
    let path = registry_path(home);
    std::fs::create_dir_all(path.parent().ok_or("no .canopy dir")?).map_err(|e| e.to_string())?;
    let body = serde_json::json!({
        "active": active,
        "profiles": entries
            .iter()
            .map(|(id, label)| serde_json::json!({ "id": id, "label": label }))
            .collect::<Vec<_>>(),
    });
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// Every profile, default first. The default entry is synthesized rather than
/// stored so a hand-edited or missing registry can never leave the user with no
/// way to launch an agent.
pub fn list(home: &str) -> Vec<Profile> {
    let mut out = vec![Profile {
        id: DEFAULT_ID.into(),
        label: "Default".into(),
        root: home.to_string(),
        removable: false,
    }];
    for (id, label) in read_registry(home) {
        let root = root_for(home, &id).to_string_lossy().to_string();
        out.push(Profile {
            id,
            label,
            root,
            removable: true,
        });
    }
    out
}

/// Config roots to scan when answering "what sessions exist?" — the default
/// home plus every profile. Readers that used to take `$HOME` take this instead,
/// or a profile's agents become invisible in the panels the moment they run.
pub fn roots(home: &str) -> Vec<(String, PathBuf)> {
    list(home)
        .into_iter()
        .map(|p| (p.id, PathBuf::from(p.root)))
        .collect()
}

/// Create a profile and lay out its directories. Creating is cheap and
/// reversible; it does not log anyone in — that is the user's browser flow,
/// inside a terminal we open for them afterwards.
pub fn create(home: &str, label: &str) -> Result<Profile, String> {
    let slug = slugify(label);
    if slug.is_empty() {
        return Err("give the profile a name with at least one letter or digit".into());
    }
    if slug == DEFAULT_ID {
        return Err("'default' is the name of your existing login — pick another".into());
    }
    let mut entries = read_registry(home);
    if entries.iter().any(|(id, _)| id == &slug) {
        return Err(format!("a profile named '{slug}' already exists"));
    }
    let root = root_for(home, &slug);
    // The full mirror up front: a CLI that finds its config dir missing prints
    // a first-run wizard, and one that finds it empty prints a login prompt.
    // The second is the state we want the user dropped into.
    for sub in [".claude", ".codex", ".config", ".local/share"] {
        std::fs::create_dir_all(root.join(sub)).map_err(|e| e.to_string())?;
    }
    entries.push((slug.clone(), label.trim().to_string()));
    write_registry(home, &entries)?;
    Ok(Profile {
        id: slug,
        label: label.trim().to_string(),
        root: root.to_string_lossy().to_string(),
        removable: true,
    })
}

/// Forget a profile. The directory is deliberately left on disk: it holds a
/// live credential the user would have to re-authenticate to get back, and no
/// amount of confirmation copy makes deleting someone's login from under a
/// misclick acceptable. The caller is told where it stayed.
pub fn delete(home: &str, id: &str) -> Result<String, String> {
    if id == DEFAULT_ID {
        return Err("the default profile is your main login and can't be removed".into());
    }
    let mut entries = read_registry(home);
    let before = entries.len();
    entries.retain(|(existing, _)| existing != id);
    if entries.len() == before {
        return Err(format!("no profile named '{id}'"));
    }
    write_registry(home, &entries)?;
    Ok(root_for(home, id).to_string_lossy().to_string())
}

/// The environment that points one CLI at one profile.
///
/// Empty for the default profile — not "the same variables pointing at $HOME".
/// Exporting `CLAUDE_CONFIG_DIR=$HOME/.claude` would look equivalent and isn't:
/// it changes which code path the CLI takes, and this feature must be invisible
/// to anyone not using it.
///
/// Also empty for a CLI we cannot isolate, so a mislabelled profile can never
/// imply an isolation that isn't happening.
pub fn env_for(home: &str, agent: &str, id: &str) -> Vec<(String, String)> {
    if id == DEFAULT_ID || !supports_profiles(agent) {
        return Vec::new();
    }
    let root = root_for(home, id);
    let at = |sub: &str| root.join(sub).to_string_lossy().to_string();
    // Stamped for every profiled agent so canopy-hook can file the session's
    // plan-usage snapshot under the account it belongs to. Absent means default,
    // which is also what a `claude` run outside Canopy reports.
    let mut env = vec![("CANOPY_PROFILE".to_string(), id.to_string())];
    match agent {
        "claude" => env.push(("CLAUDE_CONFIG_DIR".into(), at(".claude"))),
        "codex" => env.push(("CODEX_HOME".into(), at(".codex"))),
        // opencode splits config from credentials across the XDG pair, so both
        // have to move or the profile shares one login with the default.
        "opencode" => {
            env.push(("XDG_CONFIG_HOME".into(), at(".config")));
            env.push(("XDG_DATA_HOME".into(), at(".local/share")));
        }
        "amp" => env.push(("AMP_SETTINGS_FILE".into(), at(".config/amp/settings.json"))),
        _ => {}
    }
    env
}

/// The account environment for whatever CLI a command line starts, resolved
/// against the account currently in use. For launchers with no webview to ask —
/// the remote portal — where the alternative is silently running on the default
/// login while the desktop is switched to another account.
///
/// Matches on the command's first token only, by basename, so `claude`,
/// `/opt/homebrew/bin/claude` and `claude --resume x` all resolve, and a
/// sentence that merely mentions a CLI does not.
pub fn env_for_command(home: &str, command: &str) -> Vec<(String, String)> {
    let Some(first) = command.split_whitespace().next() else {
        return Vec::new();
    };
    let bin = first.rsplit('/').next().unwrap_or(first);
    if !supports_profiles(bin) {
        return Vec::new();
    }
    env_for(home, bin, &active(home))
}

/// Which profile a path belongs to, for attributing a transcript found under a
/// scanned root back to an account. Longest root wins: profile roots live
/// *inside* `$HOME`, so a plain prefix test against the default matches
/// everything.
pub fn profile_of_path(home: &str, path: &Path) -> String {
    let mut best = (0usize, DEFAULT_ID.to_string());
    for (id, root) in roots(home) {
        let len = root.as_os_str().len();
        if path.starts_with(&root) && len > best.0 {
            best = (len, id);
        }
    }
    best.1
}

// ---------- who is signed in ----------
//
// "I signed this profile in and the panel still says Sign in" is the whole
// reason this exists. A profile is only useful if you can see *which account*
// it holds — otherwise two rows named Work and Personal are indistinguishable
// from two empty directories.
//
// Read from what the CLI records about the account, never from the credential:
// the token itself is none of our business, and both CLIs write a plain account
// identity beside it. Where we have no verified way to tell, the answer is
// `unknown` rather than a guess — a row claiming to be signed in when it is not
// sends the user to debug the wrong thing.

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct AccountStatus {
    pub agent: String,
    /// "in" (an account is recorded), "out" (nothing is), or "unknown" (this
    /// CLI gives us no signal we have verified).
    pub state: &'static str,
    /// The account, as the CLI itself recorded it — an email, usually. None
    /// when signed in through something that carries no identity (an API key).
    pub account: Option<String>,
}

/// The email inside a JWT's claims, without verifying it — this is a local file
/// the CLI wrote for itself, and we are reading a label off it, not trusting it
/// to authorize anything.
fn jwt_email(token: &str) -> Option<String> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    claims["email"].as_str().map(|s| s.to_string())
}

/// Claude records the signed-in account in `.claude.json` under `oauthAccount`,
/// beside (never inside) the credential — which lives in the Keychain on macOS
/// and in `.credentials.json` elsewhere. That makes this the one signal that
/// reads the same on every platform.
fn claude_account(cfg: &Path, home: &str) -> AccountStatus {
    // Verified against the CLI: with CLAUDE_CONFIG_DIR set, `.claude.json` is
    // created *inside* that directory rather than beside it.
    let state_file = if cfg == Path::new(home) {
        cfg.join(".claude.json")
    } else {
        cfg.join(".claude").join(".claude.json")
    };
    let account = std::fs::read_to_string(state_file)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| {
            let acct = &v["oauthAccount"];
            acct["emailAddress"]
                .as_str()
                .or_else(|| acct["displayName"].as_str())
                .map(|s| s.to_string())
        });
    AccountStatus {
        agent: "claude".into(),
        state: if account.is_some() { "in" } else { "out" },
        account,
    }
}

/// Codex keeps `auth.json` under CODEX_HOME with either an API key or an OAuth
/// bundle whose id_token carries the account's email.
fn codex_account(cfg: &Path) -> AccountStatus {
    let parsed = std::fs::read_to_string(cfg.join(".codex").join("auth.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
    let Some(v) = parsed else {
        return AccountStatus {
            agent: "codex".into(),
            state: "out",
            account: None,
        };
    };
    if v["OPENAI_API_KEY"].as_str().is_some_and(|k| !k.is_empty()) {
        return AccountStatus {
            agent: "codex".into(),
            state: "in",
            // An API key names no person. Saying so is better than showing a
            // blank where every other row shows an email.
            account: Some("API key".into()),
        };
    }
    let email = v["tokens"]["id_token"].as_str().and_then(jwt_email);
    AccountStatus {
        agent: "codex".into(),
        state: if v["tokens"]["access_token"].is_string() {
            "in"
        } else {
            "out"
        },
        account: email,
    }
}

/// What each CLI's account looks like inside one profile.
pub fn account_status(home: &str, id: &str) -> Vec<AccountStatus> {
    let root = root_for(home, id);
    PROFILE_AGENTS
        .iter()
        .map(|agent| match *agent {
            "claude" => claude_account(&root, home),
            "codex" => codex_account(&root),
            // opencode and amp both moved their credentials somewhere we have
            // not verified (opencode.db; amp's settings.json holds no key on a
            // signed-in machine). Until that is checked against the real CLIs,
            // "unknown" is the honest answer and the row simply offers to sign
            // in rather than asserting a state it cannot read.
            other => AccountStatus {
                agent: other.into(),
                state: "unknown",
                account: None,
            },
        })
        .collect()
}

// ---------- commands ----------

fn home() -> Result<String, String> {
    std::env::var("HOME").map_err(|_| "no home dir".to_string())
}

#[tauri::command]
pub async fn profiles_list() -> Result<Vec<Profile>, String> {
    Ok(list(&home()?))
}

/// Create the profile and immediately install our hooks and MCP registration
/// into it, for every CLI that can hold one. Setup is folded into creation on
/// purpose: a profile whose hooks were never installed launches agents that
/// look like plain shells — no cards, no notifications, no resume — and "run
/// setup for your new profile" is exactly the step a user would skip.
#[tauri::command]
pub async fn profile_create(label: String) -> Result<Profile, String> {
    let home = home()?;
    let profile = create(&home, &label)?;
    for agent in PROFILE_AGENTS {
        // Best effort per CLI: a machine without codex installed must still get
        // a working claude profile. The reports are surfaced by profile_setup
        // when the user asks for a retry.
        let _ = crate::agents::setup_agent_in(agent, &profile.root, &home);
    }
    Ok(profile)
}

/// Which account each CLI holds inside one profile — what the Accounts panel
/// shows instead of an undifferentiated "Sign in".
#[tauri::command]
pub async fn profile_accounts(id: String) -> Result<Vec<AccountStatus>, String> {
    Ok(account_status(&home()?, &id))
}

/// Record which account new agents launch under. The frontend owns the choice;
/// this is how the parts of the app that have no webview — the remote portal —
/// find out about it.
#[tauri::command]
pub async fn profile_activate(id: String) -> Result<(), String> {
    set_active(&home()?, &id)
}

#[tauri::command]
pub async fn profile_delete(id: String) -> Result<String, String> {
    delete(&home()?, &id)
}

/// The env a launcher stamps onto a PTY. Resolved in Rust rather than rebuilt
/// in the frontend so there is exactly one place that knows which variable
/// isolates which CLI.
#[tauri::command]
pub async fn profile_env(agent: String, id: String) -> Result<Vec<(String, String)>, String> {
    Ok(env_for(&home()?, &agent, &id))
}

/// Re-run hook + MCP setup for one CLI inside one profile — the retry path when
/// the CLI was installed after the profile was made.
#[tauri::command]
pub async fn profile_setup(
    agent: String,
    id: String,
) -> Result<crate::agents::SetupReport, String> {
    let home = home()?;
    let root = root_for(&home, &id).to_string_lossy().to_string();
    crate::agents::setup_agent_in(&agent, &root, &home)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("canopy-profiles-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_default_profile_is_home_itself_and_always_exists() {
        let home = scratch("default");
        let h = home.to_string_lossy().to_string();
        let all = list(&h);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, DEFAULT_ID);
        assert_eq!(all[0].root, h);
        assert!(!all[0].removable);
        assert_eq!(root_for(&h, DEFAULT_ID), PathBuf::from(&h));
    }

    /// The whole promise of the feature for existing users: turning it on for
    /// one CLI changes nothing about how any other session launches.
    #[test]
    fn the_default_profile_exports_no_environment() {
        let home = scratch("default-env");
        let h = home.to_string_lossy().to_string();
        for agent in PROFILE_AGENTS {
            assert!(env_for(&h, agent, DEFAULT_ID).is_empty());
        }
    }

    #[test]
    fn creating_a_profile_lays_out_a_home_shaped_root() {
        let home = scratch("create");
        let h = home.to_string_lossy().to_string();
        let p = create(&h, "Work Account").unwrap();
        assert_eq!(p.id, "work-account");
        let root = root_for(&h, "work-account");
        for sub in [".claude", ".codex", ".config", ".local/share"] {
            assert!(root.join(sub).is_dir(), "{sub} not created");
        }
        // Survives a reload: the registry is the source of truth, not memory.
        let all = list(&h);
        assert_eq!(all.len(), 2);
        assert_eq!(all[1].label, "Work Account");
        assert_eq!(all[1].root, root.to_string_lossy());
    }

    #[test]
    fn each_cli_gets_the_variable_that_actually_moves_its_credentials() {
        let home = scratch("env");
        let h = home.to_string_lossy().to_string();
        create(&h, "work").unwrap();
        let root = root_for(&h, "work");
        let vars = |agent: &str| -> std::collections::HashMap<String, String> {
            env_for(&h, agent, "work").into_iter().collect()
        };

        let claude = vars("claude");
        assert_eq!(
            claude.get("CLAUDE_CONFIG_DIR").map(String::as_str),
            Some(root.join(".claude").to_string_lossy().as_ref())
        );
        assert_eq!(
            claude.get("CANOPY_PROFILE").map(String::as_str),
            Some("work")
        );

        assert_eq!(
            vars("codex").get("CODEX_HOME").map(String::as_str),
            Some(root.join(".codex").to_string_lossy().as_ref())
        );
        // opencode keeps auth under XDG_DATA_HOME and config under
        // XDG_CONFIG_HOME — moving only one shares the login with the default.
        let oc = vars("opencode");
        assert!(oc.contains_key("XDG_DATA_HOME") && oc.contains_key("XDG_CONFIG_HOME"));
        assert!(vars("amp").contains_key("AMP_SETTINGS_FILE"));
    }

    /// A CLI we can't isolate must not be handed a profile that only *looks*
    /// like one — better no picker than two entries sharing one account.
    #[test]
    fn clis_without_a_config_home_variable_get_no_environment() {
        let home = scratch("unsupported");
        let h = home.to_string_lossy().to_string();
        create(&h, "work").unwrap();
        for agent in ["agy", "omp", "aider", "gemini"] {
            assert!(
                env_for(&h, agent, "work").is_empty(),
                "{agent} was given profile env it cannot honour"
            );
            assert!(!supports_profiles(agent));
        }
    }

    #[test]
    fn ids_cannot_escape_the_profiles_directory() {
        let home = scratch("escape");
        let h = home.to_string_lossy().to_string();
        assert_eq!(slugify("../../etc"), "etc");
        assert_eq!(slugify("a/b"), "a-b");
        assert!(create(&h, "///").is_err());
        assert!(create(&h, "default").is_err());
        let p = create(&h, "../../etc").unwrap();
        assert!(root_for(&h, &p.id).starts_with(home.join(".canopy/profiles")));
    }

    #[test]
    fn duplicate_labels_are_refused_rather_than_merged() {
        let home = scratch("dupe");
        let h = home.to_string_lossy().to_string();
        create(&h, "Work").unwrap();
        assert!(create(&h, "work").is_err());
    }

    /// Deleting forgets the profile; it never deletes the login inside it.
    #[test]
    fn deleting_keeps_the_credentials_on_disk() {
        let home = scratch("delete");
        let h = home.to_string_lossy().to_string();
        create(&h, "work").unwrap();
        let marker = root_for(&h, "work").join(".claude/.credentials.json");
        std::fs::write(&marker, "{}").unwrap();
        let where_it_stayed = delete(&h, "work").unwrap();
        assert_eq!(list(&h).len(), 1);
        assert!(marker.exists(), "deleting a profile destroyed a credential");
        assert!(where_it_stayed.contains("work"));
        assert!(delete(&h, DEFAULT_ID).is_err());
    }

    /// Profile roots live inside $HOME, so attribution has to be longest-match:
    /// a plain prefix test would file every profile's transcript under default.
    #[test]
    fn a_path_is_attributed_to_the_deepest_root_that_holds_it() {
        let home = scratch("attribute");
        let h = home.to_string_lossy().to_string();
        create(&h, "work").unwrap();
        let root = root_for(&h, "work");
        assert_eq!(
            profile_of_path(&h, &root.join(".claude/projects/x/a.jsonl")),
            "work"
        );
        assert_eq!(
            profile_of_path(&h, &home.join(".claude/projects/x/a.jsonl")),
            DEFAULT_ID
        );
    }

    /// The bug this shipped with: a profile that was signed in still rendered
    /// an undifferentiated "Sign in", because nothing ever read who was in it.
    #[test]
    fn a_signed_in_profile_reports_the_account_it_holds() {
        let home = scratch("account-claude");
        let h = home.to_string_lossy().to_string();
        create(&h, "work").unwrap();
        let root = root_for(&h, "work");
        // Verified layout: with CLAUDE_CONFIG_DIR set, `.claude.json` lands
        // *inside* the config dir.
        std::fs::write(
            root.join(".claude/.claude.json"),
            r#"{"oauthAccount":{"emailAddress":"vj@example.com"}}"#,
        )
        .unwrap();

        let by_agent = |all: Vec<AccountStatus>, agent: &str| {
            all.into_iter().find(|a| a.agent == agent).unwrap()
        };
        let claude = by_agent(account_status(&h, "work"), "claude");
        assert_eq!(claude.state, "in");
        assert_eq!(claude.account.as_deref(), Some("vj@example.com"));

        // An empty profile is signed out, not "unknown" — we know exactly where
        // Claude would have written the account and it isn't there.
        let codex = by_agent(account_status(&h, "work"), "codex");
        assert_eq!(codex.state, "out");

        // And the default profile reads its own file, one level up.
        std::fs::write(
            home.join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"me@example.com"}}"#,
        )
        .unwrap();
        let default = by_agent(account_status(&h, DEFAULT_ID), "claude");
        assert_eq!(default.account.as_deref(), Some("me@example.com"));
    }

    #[test]
    fn codex_reports_the_email_in_its_token_and_names_an_api_key_as_one() {
        let home = scratch("account-codex");
        let h = home.to_string_lossy().to_string();
        create(&h, "work").unwrap();
        let root = root_for(&h, "work");
        let auth = root.join(".codex/auth.json");

        // A JWT we assemble here: the payload is the only part read, and it is
        // read as a label, never trusted to authorize anything.
        use base64::Engine;
        let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"email":"vj@example.com"}"#);
        std::fs::write(
            &auth,
            format!(
                r#"{{"OPENAI_API_KEY":null,"tokens":{{"id_token":"h.{claims}.s","access_token":"a"}}}}"#
            ),
        )
        .unwrap();
        let codex = account_status(&h, "work")
            .into_iter()
            .find(|a| a.agent == "codex")
            .unwrap();
        assert_eq!(codex.state, "in");
        assert_eq!(codex.account.as_deref(), Some("vj@example.com"));

        // An API key names no person, and a blank where every other row shows
        // an email reads as a bug.
        std::fs::write(&auth, r#"{"OPENAI_API_KEY":"sk-test"}"#).unwrap();
        let keyed = account_status(&h, "work")
            .into_iter()
            .find(|a| a.agent == "codex")
            .unwrap();
        assert_eq!(keyed.state, "in");
        assert_eq!(keyed.account.as_deref(), Some("API key"));
    }

    /// A CLI whose credential store we have not verified must say so. Claiming
    /// "signed in" on a guess sends the user to debug the wrong thing.
    #[test]
    fn unverified_clis_report_unknown_rather_than_guessing() {
        let home = scratch("account-unknown");
        let h = home.to_string_lossy().to_string();
        create(&h, "work").unwrap();
        for agent in ["opencode", "amp"] {
            let s = account_status(&h, "work")
                .into_iter()
                .find(|a| a.agent == agent)
                .unwrap();
            assert_eq!(s.state, "unknown", "{agent} claimed a state it can't read");
        }
    }

    /// Rust launches agents too — the remote portal has no webview to ask —
    /// so the active account is written where both halves can read it.
    #[test]
    fn the_active_account_survives_a_restart_and_a_deleted_profile() {
        let home = scratch("active");
        let h = home.to_string_lossy().to_string();
        assert_eq!(active(&h), DEFAULT_ID);

        create(&h, "work").unwrap();
        set_active(&h, "work").unwrap();
        assert_eq!(active(&h), "work");

        // Creating another profile must not disturb the choice — write_registry
        // rewrites the same file.
        create(&h, "personal").unwrap();
        assert_eq!(active(&h), "work");

        // An account that no longer exists is not a launch target: falling back
        // to the default beats pointing agents at a directory we forgot.
        delete(&h, "work").unwrap();
        assert_eq!(active(&h), DEFAULT_ID);
        assert!(set_active(&h, "nope").is_err());
    }

    /// The portal is handed a command line, not a registry id.
    #[test]
    fn a_command_line_resolves_to_its_clis_account() {
        let home = scratch("by-command");
        let h = home.to_string_lossy().to_string();
        create(&h, "work").unwrap();
        set_active(&h, "work").unwrap();

        let has_cfg = |cmd: &str| {
            env_for_command(&h, cmd)
                .iter()
                .any(|(k, _)| k == "CLAUDE_CONFIG_DIR")
        };
        assert!(has_cfg("claude"));
        assert!(has_cfg("claude --resume abc"));
        // An absolute path is the same CLI.
        assert!(has_cfg("/opt/homebrew/bin/claude"));
        // Only the first token counts: a prompt that merely mentions a CLI is
        // not a launch of it.
        assert!(!has_cfg("echo claude"));
        // And a CLI that cannot hold a second login gets nothing.
        assert!(env_for_command(&h, "agy").is_empty());
        assert!(env_for_command(&h, "").is_empty());
    }

    #[test]
    fn a_corrupt_registry_still_leaves_a_usable_default() {
        let home = scratch("corrupt");
        let h = home.to_string_lossy().to_string();
        std::fs::create_dir_all(home.join(".canopy")).unwrap();
        std::fs::write(registry_path(&h), "{ not json").unwrap();
        assert_eq!(list(&h).len(), 1);
        // And an entry whose id would traverse is dropped, not repaired.
        std::fs::write(
            registry_path(&h),
            r#"{"profiles":[{"id":"../evil","label":"x"},{"id":"ok","label":"Ok"}]}"#,
        )
        .unwrap();
        let ids: Vec<String> = list(&h).into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec![DEFAULT_ID.to_string(), "ok".to_string()]);
    }
}
