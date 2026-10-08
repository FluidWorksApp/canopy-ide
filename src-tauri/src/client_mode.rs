use crate::profiles::valid_account_credentials;
use std::path::Path;
use std::sync::Mutex;
use tauri::Manager;

// Workspace credentials are stored in the OS credential store, never preferences or logs.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConnection {
    pub endpoint: String,
    pub token: String,
    pub workspace_id: String,
    pub workspace_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_account_key: Option<String>,
}
#[derive(Default)]
pub struct RemoteConnectionState(pub Mutex<Option<RemoteConnection>>);

#[cfg(target_os = "macos")]
fn account_token() -> Result<Option<String>, String> {
    match security_framework::passwords::get_generic_password(
        "app.causeconnect.canopy.account",
        "device",
    ) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "Account credential is invalid".into()),
        Err(error) if error.code() == -25300 => Ok(None),
        Err(_) => Err("Cannot read account credential from Keychain".into()),
    }
}
#[cfg(not(target_os = "macos"))]
fn account_token() -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(target_os = "macos")]
fn store_account_token(token: &str) -> Result<(), String> {
    security_framework::passwords::set_generic_password(
        "app.causeconnect.canopy.account",
        "device",
        token.as_bytes(),
    )
    .map_err(|_| "Cannot save account credential to Keychain".into())
}
#[cfg(not(target_os = "macos"))]
fn store_account_token(_: &str) -> Result<(), String> {
    Err("Secure account storage is unavailable on this platform".into())
}

// Display caches are namespaced by the local device credential without exposing it.
#[tauri::command]
pub fn canopy_account_cache_key() -> Result<Option<String>, String> {
    use sha2::{Digest, Sha256};
    Ok(account_token()?.map(|token| {
        format!(
            "{:x}",
            Sha256::digest(format!("canopy-display-cache:{token}").as_bytes())
        )
    }))
}

// The native process outlives renderer reloads. Reuse its TLS/HTTP pool;
// authentication is still read and applied separately on every request.
fn account_http_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .pool_idle_timeout(std::time::Duration::from_secs(300))
        .pool_max_idle_per_host(2)
        .build()
        .map_err(|_| "Account connection unavailable".to_string()))
        .as_ref().map_err(Clone::clone)
}

#[tauri::command]
pub async fn canopy_account_request(
    route: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if !matches!(
        route.as_str(),
        "/api/device"
            | "/api/me"
            | "/api/workspaces"
            | "/api/plans"
            | "/api/credits"
            | "/api/operations"
            | "/api/teams"
            | "/api/peers"
    ) {
        return Err("Invalid account request".into());
    }
    let client = account_http_client()?;
    let url = format!("https://canopyide.dev{route}");
    let mut request = if let Some(ref value) = body {
        client
            .post(url)
            .header("content-type", "application/json")
            .body(value.to_string())
    } else {
        client.get(url)
    };
    if let Some(token) = account_token()? {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Cannot reach Canopy. Check your connection and try again.")?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Canopy returned an invalid response")?;
    let mut value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "Canopy returned an invalid response")?;
    if !status.is_success() {
        return Err(value
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Account request failed")
            .to_string());
    }
    if route == "/api/device" && value.get("status").and_then(|v| v.as_str()) == Some("approved") {
        let token = value
            .get("token")
            .and_then(|v| v.as_str())
            .ok_or("Sign-in did not return a credential")?;
        if token.len() != 64
            || !token
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        {
            return Err("Invalid account credential".into());
        }
        store_account_token(token)?;
        value
            .as_object_mut()
            .ok_or("Invalid sign-in response")?
            .remove("token");
    }
    if route == "/api/device"
        && body
            .as_ref()
            .and_then(|v| v.get("action"))
            .and_then(|v| v.as_str())
            == Some("revoke")
    {
        #[cfg(target_os = "macos")]
        security_framework::passwords::delete_generic_password(
            "app.causeconnect.canopy.account",
            "device",
        )
        .map_err(|_| "Cannot remove account credential from Keychain")?;
    }
    Ok(value)
}

#[tauri::command]
pub fn execution_remote_get(
    app: tauri::AppHandle,
    state: tauri::State<RemoteConnectionState>,
) -> Result<Option<RemoteConnection>, String> {
    let mut current = state.0.lock().map_err(|_| "Connection state unavailable")?;
    if current.is_none() {
        let id = app
            .path()
            .app_config_dir()
            .ok()
            .and_then(|d| std::fs::read_to_string(d.join("active-remote-workspace")).ok());
        if let Some(id) = id {
            *current = saved_connections()?
                .into_iter()
                .find(|c| connection_id(c) == id);
        }
    }
    Ok(current.clone())
}

#[tauri::command]
pub fn execution_remote_set(
    app: tauri::AppHandle,
    state: tauri::State<RemoteConnectionState>,
    connection: RemoteConnection,
) -> Result<(), String> {
    let endpoint =
        reqwest::Url::parse(&connection.endpoint).map_err(|_| "Invalid host endpoint")?;
    let loopback = matches!(
        endpoint.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if !(endpoint.scheme() == "https" || (endpoint.scheme() == "http" && loopback))
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || connection
            .scope
            .as_deref()
            .is_some_and(|scope| !matches!(scope, "view" | "drive"))
        || connection.token.len() < 16
        || connection.token.len() > 1024
        || connection.workspace_id.is_empty()
    {
        return Err("Invalid remote workspace connection".into());
    }
    let mut all = saved_connections()?;
    all.retain(|c| connection_id(c) != connection_id(&connection));
    if all.len() >= 64 {
        return Err("Saved workspace limit reached".into());
    }
    all.push(connection.clone());
    save_connections(&all)?;
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|_| "Workspace storage unavailable")?;
    std::fs::create_dir_all(&directory).map_err(|_| "Workspace storage unavailable")?;
    let temporary = directory.join("active-remote-workspace.next");
    std::fs::write(&temporary, connection_id(&connection))
        .map_err(|_| "Workspace storage unavailable")?;
    std::fs::rename(temporary, directory.join("active-remote-workspace"))
        .map_err(|_| "Workspace storage unavailable")?;
    *state.0.lock().map_err(|_| "Connection state unavailable")? = Some(connection);
    Ok(())
}

fn read_mode(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .filter(|value| value == "local" || value == "remote")
}

pub fn is_remote(app: &tauri::AppHandle) -> bool {
    app.path()
        .app_config_dir()
        .ok()
        .and_then(|dir| read_mode(&dir.join("execution-mode")))
        .as_deref()
        == Some("remote")
}

#[tauri::command]
pub fn execution_mode_get(app: tauri::AppHandle) -> Option<String> {
    app.path()
        .app_config_dir()
        .ok()
        .and_then(|dir| read_mode(&dir.join("execution-mode")))
}

#[tauri::command]
pub fn execution_mode_set(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    if mode != "local" && mode != "remote" {
        return Err("Invalid execution mode".into());
    }
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let next = directory.join("execution-mode.next");
    std::fs::write(&next, &mode).map_err(|error| error.to_string())?;
    std::fs::rename(next, directory.join("execution-mode")).map_err(|error| error.to_string())?;
    if mode == "local" {
        crate::start_local_services(&app);
    }
    Ok(())
}

fn connection_id(c: &RemoteConnection) -> String {
    format!("{}/{}", c.endpoint.trim_end_matches('/'), c.workspace_id)
}
#[cfg(target_os = "macos")]
fn saved_connections() -> Result<Vec<RemoteConnection>, String> {
    match security_framework::passwords::get_generic_password(
        "app.causeconnect.canopy.remote-workspaces",
        "saved",
    ) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "Saved workspace credentials are invalid".into()),
        Err(error) if error.code() == -25300 => Ok(vec![]),
        Err(_) => Err("Cannot read workspace credentials from Keychain".into()),
    }
}
#[cfg(target_os = "macos")]
fn save_connections(all: &[RemoteConnection]) -> Result<(), String> {
    let bytes = serde_json::to_vec(all).map_err(|_| "Cannot encode workspace credentials")?;
    security_framework::passwords::set_generic_password(
        "app.causeconnect.canopy.remote-workspaces",
        "saved",
        &bytes,
    )
    .map_err(|_| "Cannot save workspace credentials to Keychain".into())
}
#[cfg(not(target_os = "macos"))]
fn saved_connections() -> Result<Vec<RemoteConnection>, String> {
    Ok(vec![])
}
#[cfg(not(target_os = "macos"))]
fn save_connections(_: &[RemoteConnection]) -> Result<(), String> {
    Err("Secure workspace storage is unavailable on this platform".into())
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedWorkspace {
    id: String,
    endpoint: String,
    workspace_id: String,
    workspace_name: String,
}
#[tauri::command]
pub fn execution_remote_list() -> Result<Vec<SavedWorkspace>, String> {
    Ok(saved_connections()?
        .into_iter()
        .map(|c| SavedWorkspace {
            id: connection_id(&c),
            endpoint: c.endpoint,
            workspace_id: c.workspace_id,
            workspace_name: c.workspace_name,
        })
        .collect())
}
#[tauri::command]
pub fn execution_remote_forget(
    app: tauri::AppHandle,
    state: tauri::State<RemoteConnectionState>,
    id: String,
) -> Result<(), String> {
    let mut all = saved_connections()?;
    all.retain(|c| connection_id(c) != id);
    save_connections(&all)?;
    let mut current = state.0.lock().map_err(|_| "Connection state unavailable")?;
    if current.as_ref().is_some_and(|c| connection_id(c) == id) {
        *current = None;
    }
    let marker = app
        .path()
        .app_config_dir()
        .map_err(|_| "Workspace storage unavailable")?
        .join("active-remote-workspace");
    if std::fs::read_to_string(&marker).ok().as_deref() == Some(&id) {
        std::fs::remove_file(marker).map_err(|_| "Workspace storage unavailable")?;
    }
    Ok(())
}

#[tauri::command]
pub fn execution_remote_activate(
    app: tauri::AppHandle,
    state: tauri::State<RemoteConnectionState>,
    id: String,
) -> Result<(), String> {
    let connection = saved_connections()?
        .into_iter()
        .find(|c| connection_id(c) == id)
        .ok_or("Saved workspace not found")?;
    execution_remote_set(app, state, connection)
}

fn login_callback(url: &str) -> Result<Option<(u16, String, String)>, String> {
    let login = reqwest::Url::parse(url).map_err(|_| "Invalid sign-in link")?;
    if login.scheme() != "https"
        || !matches!(
            login.host_str(),
            Some("auth.openai.com" | "claude.ai" | "console.anthropic.com" | "platform.claude.com")
        )
    {
        return Ok(None);
    }
    let query: std::collections::HashMap<_, _> = login.query_pairs().into_owned().collect();
    let Some(redirect) = query.get("redirect_uri") else {
        return Ok(None);
    };
    let callback = reqwest::Url::parse(redirect).map_err(|_| "Invalid sign-in callback")?;
    if callback.scheme() != "http"
        || !matches!(
            callback.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        )
    {
        return Ok(None);
    }
    let port = callback
        .port()
        .filter(|p| *p > 1024 && *p != 8787 && *p != 8080 && *p != 8081)
        .ok_or("Unsupported sign-in callback port")?;
    if !matches!(
        callback.path(),
        "/callback" | "/auth/callback" | "/oauth/callback"
    ) || callback.query().is_some()
        || callback.fragment().is_some()
        || !callback.username().is_empty()
        || callback.password().is_some()
    {
        return Err("Unsupported sign-in callback".into());
    }
    let state = query
        .get("state")
        .filter(|s| !s.is_empty() && s.len() < 1024)
        .ok_or("Sign-in link has no state")?
        .clone();
    Ok(Some((port, callback.path().to_owned(), state)))
}
static LOGIN_PORTS: std::sync::OnceLock<Mutex<std::collections::HashMap<u16, String>>> =
    std::sync::OnceLock::new();
#[cfg(test)]
fn select_account_credentials<'a>(
    agent: &str,
    file: Option<&'a serde_json::Value>,
    keychain: Option<&'a serde_json::Value>,
) -> Option<&'a serde_json::Value> {
    keychain
        .filter(|value| valid_account_credentials(agent, value))
        .or_else(|| file.filter(|value| valid_account_credentials(agent, value)))
}

// Select only this profile's item. Never enumerate the user's Keychain or
// fall back to the default account when a named account has no credential.
fn credential_key(
    agent: &str,
    directory: &std::path::Path,
    custom: bool,
) -> (String, Option<String>) {
    use sha2::{Digest, Sha256};
    let directory = if agent == "codex" {
        std::fs::canonicalize(directory).unwrap_or_else(|_| directory.to_path_buf())
    } else {
        directory.to_path_buf()
    };
    let hash = format!(
        "{:x}",
        Sha256::digest(directory.to_string_lossy().as_bytes())
    );
    if agent == "codex" {
        ("Codex Auth".into(), Some(format!("cli|{}", &hash[..16])))
    } else {
        (
            if custom {
                format!("Claude Code-credentials-{}", &hash[..8])
            } else {
                "Claude Code-credentials".into()
            },
            None,
        )
    }
}
fn credential_json(file: &std::path::Path) -> Result<Option<serde_json::Value>, String> {
    let meta = match std::fs::symlink_metadata(file) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot read account credentials".into()),
    };
    if !meta.is_file() || meta.len() > 65536 {
        return Err("Invalid account credential file".into());
    }
    let bytes = std::fs::read(file).map_err(|_| "Cannot read account credentials")?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "Invalid account credential data".into())
}
fn keychain_login(
    service: &str,
    account: Option<&str>,
) -> Result<Option<serde_json::Value>, String> {
    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("/usr/bin/security");
        command.args(["find-generic-password", "-s", service]);
        if let Some(account) = account {
            command.args(["-a", account]);
        }
        let output = command
            .arg("-w")
            .output()
            .map_err(|_| "Cannot access account credential store")?;
        // errSecItemNotFound is -25300, returned by security as exit code 44.
        if output.status.code() == Some(44) {
            return Ok(None);
        }
        if !output.status.success() {
            return Err(
                "Account credential store is locked or access was denied. Unlock it and retry."
                    .into(),
            );
        }
        if output.stdout.len() > 65536 {
            return Err("Agent credentials too large".into());
        }
        return serde_json::from_slice(&output.stdout)
            .map(Some)
            .map_err(|_| "Invalid account credential data".into());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (service, account);
        Err("Copying credentials from this operating system's credential store is not supported yet".into())
    }
}
fn codex_store(directory: &std::path::Path) -> Result<String, String> {
    let file = directory.join("config.toml");
    let raw = match std::fs::read_to_string(file) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok("file".into()),
        Err(_) => return Err("Cannot read Codex credential storage setting".into()),
    };
    let config: toml::Value =
        toml::from_str(&raw).map_err(|_| "Cannot parse Codex credential storage setting")?;
    if config
        .get("cli_auth_credentials_store")
        .is_some_and(|v| v.as_str().is_none())
    {
        return Err("Invalid Codex credential storage setting".into());
    }
    Ok(config
        .get("cli_auth_credentials_store")
        .and_then(|v| v.as_str())
        .unwrap_or("file")
        .to_string())
}
fn choose_login(
    agent: &str,
    mode: &str,
    file: Option<serde_json::Value>,
    keychain: Option<serde_json::Value>,
) -> Result<Option<serde_json::Value>, String> {
    let chosen = match mode {
        "file" => file,
        "keyring" => keychain,
        "auto" => keychain.or(file),
        "ephemeral" => None,
        _ => return Err("Unsupported credential storage setting".into()),
    };
    match chosen {
        Some(value) if valid_account_credentials(agent, &value) => Ok(Some(if agent == "claude" {
            serde_json::json!({"claudeAiOauth":value.get("claudeAiOauth")})
        } else {
            value
        })),
        Some(_) => Err("Account credentials are incomplete".into()),
        None => Ok(None),
    }
}
/// The account Claude records beside its login (`oauthAccount`). Identity
/// only; a bounded read of a regular file, never the credential itself.
fn claude_identity(file: &std::path::Path) -> Option<serde_json::Value> {
    std::fs::symlink_metadata(file)
        .ok()
        .filter(|m| m.is_file() && m.len() <= 16 * 1048576)?;
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    value.get("oauthAccount").filter(|v| v.is_object()).cloned()
}
fn export_profile_login(
    agent: &str,
    directory: &std::path::Path,
    custom: bool,
) -> Result<Option<serde_json::Value>, String> {
    let mode = if agent == "codex" {
        codex_store(directory)?
    } else if cfg!(target_os = "macos") {
        "auto".into()
    } else {
        "file".into()
    };
    if mode == "ephemeral" {
        return Ok(None);
    }
    let keychain = if mode == "auto" || mode == "keyring" {
        let (service, account) = credential_key(agent, directory, custom);
        keychain_login(&service, account.as_deref())?
    } else {
        None
    };
    let file = if mode == "file" || (mode == "auto" && keychain.is_none()) {
        credential_json(&directory.join(if agent == "claude" {
            ".credentials.json"
        } else {
            "auth.json"
        }))?
    } else {
        None
    };
    choose_login(agent, &mode, file, keychain)
}

const INCOMPLETE_LOGIN: &str = "Account credentials are incomplete";

/// What one CLI's login store holds for one profile, read from the store the
/// CLI itself reads (Keychain on macOS, the file elsewhere, Codex's configured
/// store). The single answer behind every "signed in?" in the app: the status
/// bar switcher, Settings → Accounts, the launcher banner and the remote sync
/// picker all derive from this, never from `.claude.json`'s `oauthAccount`
/// record, which outlives a login.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LoginProbe {
    /// A login the CLI can use and a sync could copy.
    Ready,
    /// The CLI cleared or never finished it (no access or refresh token).
    Incomplete,
    /// No login stored at all.
    Absent,
    /// The store could not be read (locked Keychain, denied access).
    Unreadable,
}
impl LoginProbe {
    fn of(result: &Result<Option<serde_json::Value>, String>) -> Self {
        match result {
            Ok(Some(_)) => Self::Ready,
            Ok(None) => Self::Absent,
            Err(error) if error == INCOMPLETE_LOGIN => Self::Incomplete,
            Err(_) => Self::Unreadable,
        }
    }
    /// The remote sync picker's vocabulary for the same answer.
    pub(crate) fn candidate(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Incomplete => "incomplete",
            Self::Absent => "none",
            Self::Unreadable => "unavailable",
        }
    }
}

/// Where one CLI keeps its login for a profile root, and whether Claude's
/// Keychain item is the per-directory one.
pub(crate) fn login_dir(agent: &str, root: &Path, home: &str) -> (std::path::PathBuf, bool) {
    if root == Path::new(home) {
        let (claude, codex, custom) = default_agent_dirs(home);
        if agent == "claude" {
            (claude, custom)
        } else {
            (codex, true)
        }
    } else {
        (root.join(format!(".{agent}")), true)
    }
}

/// The login state of one CLI in one profile. Cached briefly: account status
/// is re-read on every window focus, from several panels at once.
pub(crate) fn profile_login(agent: &str, root: &Path, home: &str) -> LoginProbe {
    // Tests must never read the developer's real Keychain items.
    if cfg!(test) {
        let _ = (agent, root, home);
        return LoginProbe::Unreadable;
    }
    use std::collections::HashMap;
    use std::time::{Duration, Instant};
    type Cache = Mutex<HashMap<(String, std::path::PathBuf), (Instant, LoginProbe)>>;
    static CACHE: std::sync::OnceLock<Cache> = std::sync::OnceLock::new();
    let (directory, custom) = login_dir(agent, root, home);
    let key = (agent.to_string(), directory.clone());
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((at, value)) = cache.lock().ok().and_then(|c| c.get(&key).copied()) {
        if at.elapsed() < Duration::from_secs(30) {
            return value;
        }
    }
    let value = LoginProbe::of(&export_profile_login(agent, &directory, custom));
    if let Ok(mut c) = cache.lock() {
        c.insert(key, (Instant::now(), value));
    }
    value
}

/// A config-home override for the default account, unless it was inherited
/// from a named profile's terminal (see profiles::ACCOUNT_VARS): following it
/// would read, report and sync that profile's login as "Default".
fn default_override(home: &str, value: Option<String>) -> Option<std::path::PathBuf> {
    value
        .filter(|v| !v.is_empty() && !crate::profiles::inherited_profile_path(home, v))
        .map(std::path::PathBuf::from)
}
/// The default account's Claude and Codex directories, and whether Claude's is
/// a custom CLAUDE_CONFIG_DIR (which changes its Keychain item name).
fn default_agent_dirs(home: &str) -> (std::path::PathBuf, std::path::PathBuf, bool) {
    let claude = default_override(home, std::env::var("CLAUDE_CONFIG_DIR").ok());
    let codex = default_override(home, std::env::var("CODEX_HOME").ok())
        .unwrap_or_else(|| std::path::PathBuf::from(home).join(".codex"));
    let custom = claude.is_some();
    (
        claude.unwrap_or_else(|| std::path::PathBuf::from(home).join(".claude")),
        codex,
        custom,
    )
}
/// One account's export. An incomplete login (e.g. no refresh token) is
/// reported for that account instead of aborting every other account's copy.
fn export_or_report(
    agent: &str,
    directory: &std::path::Path,
    custom: bool,
    owner: &str,
    incomplete: &mut Vec<String>,
) -> Result<Option<serde_json::Value>, String> {
    match export_profile_login(agent, directory, custom) {
        Err(error) if error == INCOMPLETE_LOGIN => {
            incomplete.push(format!(
                "{owner} ({})",
                if agent == "claude" { "Claude" } else { "Codex" }
            ));
            Ok(None)
        }
        other => other,
    }
}
/// What each local account could copy, without returning any credential:
/// "ready", "incomplete" (sign in again on this Mac), "none" or "unavailable".
#[tauri::command]
pub async fn execution_remote_account_candidates() -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<Vec<serde_json::Value>, String> {
        let home = std::env::var("HOME").map_err(|_| "Home directory unavailable")?;
        // The same probe the account status reads, so the picker and every
        // "signed in" label agree.
        Ok(crate::profiles::list(&home)
            .into_iter()
            .take(33)
            .map(|profile| {
                let root = std::path::PathBuf::from(&profile.root);
                let state = |agent: &str| profile_login(agent, &root, &home).candidate();
                serde_json::json!({"id":profile.id,"claude":state("claude"),"codex":state("codex")})
            })
            .collect())
    })
    .await
    .map_err(|_| "Account check failed".to_string())?
}

// This command runs only after the user chooses to copy accounts into the
// selected workspace. Merely saving/reopening a workspace never copies them.
#[tauri::command]
pub async fn execution_remote_import_accounts(
    app: tauri::AppHandle,
    state: tauri::State<'_, RemoteConnectionState>,
    profiles: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let connection = execution_remote_get(app, state)?.ok_or("Select a remote workspace first")?;
    // None copies every account; otherwise only the chosen ids ("default" included).
    let chosen = move |id: &str| {
        profiles
            .as_ref()
            .map_or(true, |ids| ids.iter().any(|v| v == id))
    };
    let (accounts, default_identity, profile_copies, skipped, skipped_profiles, incomplete) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
    let home = std::env::var("HOME").map_err(|_| "Home directory unavailable")?;
    let (claude, codex, custom) = default_agent_dirs(&home);
    let mut accounts = serde_json::Map::new();
    let mut default_identity = None;
    let mut incomplete = Vec::new();
    if chosen(crate::profiles::DEFAULT_ID) {
        for (agent, directory, custom) in [("claude", &claude, custom), ("codex", &codex, true)] {
            if let Some(value) = export_or_report(agent, directory, custom, "Default", &mut incomplete)? { accounts.insert(agent.into(), value); }
        }
        if accounts.contains_key("claude") {
            // With CLAUDE_CONFIG_DIR the state file lives inside it; otherwise it is ~/.claude.json.
            let state_file = if custom { claude.join(".claude.json") } else { crate::profiles::claude_state_file(&home, std::path::Path::new(&home)) };
            default_identity = claude_identity(&state_file);
        }
    }
    let mut profile_copies = Vec::new();
    let mut skipped_profiles = Vec::new();
    for profile in crate::profiles::list(&home).into_iter().filter(|p| p.removable && chosen(&p.id)).take(32) {
        let root = std::path::PathBuf::from(&profile.root);
        if std::fs::canonicalize(&root).ok().as_ref() != Some(&root) {
            skipped_profiles.push(profile.label);
            continue;
        }
        let mut credentials = serde_json::Map::new();
        for (agent, directory) in [("claude", root.join(".claude")), ("codex", root.join(".codex"))] {
            if let Some(value) = export_or_report(agent, &directory, true, &profile.label, &mut incomplete)? { credentials.insert(agent.into(), value); }
        }
        if !credentials.is_empty() {
            let identity = claude_identity(&crate::profiles::claude_state_file(&home, &root));
            profile_copies.push(serde_json::json!({"id":profile.id,"label":profile.label,"accounts":credentials,"claudeIdentity":identity}));
        } else {
            skipped_profiles.push(profile.label);
        }
    }
    let skipped: Vec<&str> = if chosen(crate::profiles::DEFAULT_ID) {
        ["claude", "codex"].into_iter().filter(|agent| !accounts.contains_key(*agent)).collect()
    } else {
        Vec::new()
    };
    if accounts.is_empty() && profile_copies.is_empty() {
        if !incomplete.is_empty() {
            return Err(format!("These logins on this Mac have no refresh token, so they cannot be copied: {}. Run /login in that account on this Mac, then sync again.", incomplete.join(", ")));
        }
        return Err("No Claude or Codex login was found on this Mac".into());
    }
        Ok((accounts, default_identity, profile_copies, skipped, skipped_profiles, incomplete))
    }).await.map_err(|_| "Account copy preparation failed")??;
    // What was actually sent, per account and CLI, so the result can say
    // exactly what reached the workspace instead of what was asked for.
    let mut sent = serde_json::Map::new();
    if !accounts.is_empty() {
        sent.insert(
            crate::profiles::DEFAULT_ID.into(),
            serde_json::json!(accounts.keys().collect::<Vec<_>>()),
        );
    }
    let mut sent_labels = Vec::new();
    for copy in &profile_copies {
        if let (Some(id), Some(label), Some(held)) = (
            copy["id"].as_str(),
            copy["label"].as_str(),
            copy["accounts"].as_object(),
        ) {
            sent.insert(
                id.into(),
                serde_json::json!(held.keys().collect::<Vec<_>>()),
            );
            sent_labels.push(label.to_string());
        }
    }
    let payload =
        serde_json::json!({"command":"profile_import_credentials","args":{"accounts":accounts,"claudeIdentity":default_identity,"profiles":profile_copies}})
            .to_string();
    let response = reqwest::Client::new()
        .post(format!(
            "{}/v1/workspaces/{}/native",
            connection.endpoint.trim_end_matches('/'),
            connection.workspace_id
        ))
        .bearer_auth(connection.token)
        .header("content-type", "application/json")
        .body(payload)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|_| "Could not reach the remote workspace")?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|_| "Account import response unavailable")?;
    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| "Invalid account import response")?;
    if !status.is_success() {
        // Only known static diagnostics may enter the UI. An arbitrary server
        // error body could echo credential data and must not be displayed.
        let message = match value.get("error").and_then(|v| v.as_str()) {
            Some("Claude login missing") => "Claude credentials are incomplete. Sign in to Claude on this Mac and retry.",
            Some("Codex login missing") => "Codex credentials are incomplete. Sign in to Codex on this Mac and retry.",
            Some("Credential directory must not be a symlink") => "The remote account directory is a symlink. Choose a workspace with a private account directory.",
            Some("Agent credentials too large") => "The agent credentials exceed the import size limit.",
            Some("Unauthorized" | "Forbidden") => "This saved workspace token does not allow account imports. Update the workspace connection.",
            _ => return Err(format!("Remote account import failed (HTTP {}). Check the workspace account directory and host connection.", status.as_u16())),
        };
        return Err(message.into());
    }
    let mut result = value
        .get("result")
        .cloned()
        .ok_or("Invalid account import response")?;
    result["notUpdated"] = serde_json::json!(not_updated(&result, &sent_labels));
    result["sent"] = serde_json::Value::Object(sent);
    result["skipped"] = serde_json::json!(skipped);
    result["skippedProfiles"] = serde_json::json!(skipped_profiles);
    result["incomplete"] = serde_json::json!(incomplete);
    Ok(result)
}
/// Profiles sent but neither created nor updated by the workspace. An older
/// workspace host skips a profile that already exists there (and reports it
/// as `existingProfiles`); reporting it as synced is how a stale remote copy
/// kept being shown as current.
fn not_updated(result: &serde_json::Value, sent: &[String]) -> Vec<String> {
    let done = |key: &str| -> Vec<String> {
        result[key]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    };
    let (imported, updated) = (done("imported"), done("updated"));
    sent.iter()
        .filter(|label| !imported.contains(label) && !updated.contains(label))
        .cloned()
        .collect()
}
#[tauri::command]
pub async fn execution_remote_import_git(
    app: tauri::AppHandle,
    state: tauri::State<'_, RemoteConnectionState>,
) -> Result<serde_json::Value, String> {
    let connection = execution_remote_get(app, state)?.ok_or("Select a remote workspace first")?;
    let gh = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]
        .into_iter()
        .find(|bin| Path::new(bin).is_file())
        .unwrap_or("gh");
    let output = std::process::Command::new(gh)
        .args(["auth", "token", "--hostname", "github.com"])
        .output()
        .map_err(|_| "GitHub CLI is not installed on this Mac")?;
    if !output.status.success() || output.stdout.len() > 16384 {
        return Err("Sign in to GitHub CLI on this Mac first (gh auth login)".into());
    }
    let token = String::from_utf8(output.stdout).map_err(|_| "Local GitHub login unavailable")?;
    let mut identity = serde_json::Map::new();
    for key in ["user.name", "user.email"] {
        if let Ok(output) = std::process::Command::new("git")
            .args(["config", "--global", "--get", key])
            .output()
        {
            if output.status.success() && output.stdout.len() < 1024 {
                if let Ok(value) = String::from_utf8(output.stdout) {
                    identity.insert(key.into(), value.trim().into());
                }
            }
        }
    }
    let response=reqwest::Client::new().post(format!("{}/v1/workspaces/{}/native",connection.endpoint.trim_end_matches('/'),connection.workspace_id))
      .bearer_auth(connection.token).header("content-type","application/json").body(serde_json::json!({"command":"profile_import_git","args":{"token":token.trim(),"identity":identity}}).to_string())
      .timeout(std::time::Duration::from_secs(30)).send().await.map_err(|_|"Could not reach the remote workspace")?;
    if !response.status().is_success() {
        return Err(
            "Remote GitHub setup failed. Check the local GitHub login and workspace connection."
                .into(),
        );
    }
    Ok(serde_json::json!({"imported":["GitHub","Git author identity"]}))
}
#[tauri::command]
pub async fn execution_remote_login_prepare(
    app: tauri::AppHandle,
    state: tauri::State<'_, RemoteConnectionState>,
    url: String,
) -> Result<bool, String> {
    let Some((port, path, expected_state)) = login_callback(&url)? else {
        return Ok(false);
    };
    let connection =
        execution_remote_get(app, state)?.ok_or("Select a remote workspace before signing in")?;
    let ports = LOGIN_PORTS.get_or_init(Default::default);
    {
        let mut all = ports.lock().map_err(|_| "Sign-in bridge unavailable")?;
        if let Some(existing) = all.get(&port) {
            return if existing == &expected_state {
                Ok(true)
            } else {
                Err("Another sign-in is using this callback port. Finish it first.".into())
            };
        }
        if all.len() >= 8 {
            return Err("Too many pending sign-ins".into());
        }
        all.insert(port, expected_state.clone());
    }
    let listener = match tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await
    {
        Ok(listener) => listener,
        Err(_) => {
            ports.lock().unwrap().remove(&port);
            return Err(format!("Sign-in port {port} is already used on this Mac. Close that login or use device-code login."));
        }
    };
    let completed = std::sync::Arc::new(tokio::sync::Notify::new());
    let finished = completed.clone();
    let handler = move |axum::extract::OriginalUri(uri): axum::extract::OriginalUri| {
        let connection = connection.clone();
        let path = path.clone();
        let expected = expected_state.clone();
        let finished = finished.clone();
        async move {
            use axum::http::StatusCode;
            let parsed = reqwest::Url::parse(&format!("http://127.0.0.1{uri}"));
            let valid = parsed
                .as_ref()
                .ok()
                .map(|u| {
                    u.path() == path && u.query_pairs().any(|(k, v)| k == "state" && v == expected)
                })
                .unwrap_or(false);
            if !valid || uri.to_string().len() > 8192 {
                return (
                    StatusCode::BAD_REQUEST,
                    "This callback does not match the pending workspace sign-in.",
                );
            }
            let payload = serde_json::json!({"command":"oauth_callback","args":{"port":port,"path":uri.to_string()}}).to_string();
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .build();
            let result = match client {
                Ok(client) => {
                    client
                        .post(format!(
                            "{}/v1/workspaces/{}/native",
                            connection.endpoint.trim_end_matches('/'),
                            connection.workspace_id
                        ))
                        .bearer_auth(connection.token)
                        .header("content-type", "application/json")
                        .body(payload)
                        .send()
                        .await
                }
                Err(_) => {
                    return (
                        StatusCode::BAD_GATEWAY,
                        "Cannot connect to the remote workspace.",
                    )
                }
            };
            if result
                .as_ref()
                .map(|r| r.status().is_success())
                .unwrap_or(false)
            {
                finished.notify_one();
                (StatusCode::OK,"Sign-in returned to your remote workspace. You can close this tab and return to Canopy.")
            } else {
                (StatusCode::BAD_GATEWAY,"The remote CLI did not accept the callback. Return to Canopy and retry sign-in.")
            }
        }
    };
    let router = axum::Router::new().fallback(axum::routing::get(handler));
    tokio::spawn(async move {
        let shutdown = async move {
            tokio::select! { _ = completed.notified() => {}, _ = tokio::time::sleep(std::time::Duration::from_secs(600)) => {} }
        };
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(shutdown)
            .await;
        LOGIN_PORTS.get().unwrap().lock().unwrap().remove(&port);
    });
    Ok(true)
}

#[cfg(test)]
mod remote_login_tests {
    use super::*;
    #[test]
    fn callback_only_uses_provider_and_loopback_with_state() {
        assert_eq!(login_callback("https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&state=synthetic").unwrap(), Some((1455,"/auth/callback".into(),"synthetic".into())));
        assert!(login_callback(
            "https://evil.example/?redirect_uri=http://localhost:1455/auth/callback&state=x"
        )
        .unwrap()
        .is_none());
        assert!(login_callback("https://claude.ai/oauth/authorize?redirect_uri=http://localhost:53000/callback&state=x").unwrap().is_some());
        assert!(login_callback(
            "https://auth.openai.com/?redirect_uri=http://localhost:8787/callback&state=x"
        )
        .is_err());
        assert!(login_callback(
            "https://auth.openai.com/?redirect_uri=http://localhost:1455/callback"
        )
        .is_err());
    }
}

#[cfg(test)]
mod account_import_tests {
    #[test]
    fn saved_connection_retains_freshness_and_lease_identity() {
        let value = serde_json::json!({
            "endpoint": "https://workspace.example.invalid", "token": "synthetic",
            "workspaceId": "workspace", "workspaceName": "Workspace",
            "clientId": "same-lease", "expiresAt": "2026-10-08T10:00:00Z",
            "credentialAccountKey": "account-fingerprint"
        });
        let connection: super::RemoteConnection = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(connection).unwrap(), value);
        let legacy: super::RemoteConnection = serde_json::from_value(serde_json::json!({
            "endpoint": "https://workspace.example.invalid", "token": "synthetic",
            "workspaceId": "workspace", "workspaceName": "Workspace"
        })).unwrap();
        assert!(legacy.expires_at.is_none());
        assert!(legacy.credential_account_key.is_none());
        assert!(legacy.client_id.is_none());
    }

    use super::*;
    #[test]
    fn profile_keys_are_scoped_and_default_is_never_a_named_fallback() {
        let a = credential_key(
            "claude",
            std::path::Path::new("/profiles/work/.claude"),
            true,
        );
        let b = credential_key(
            "claude",
            std::path::Path::new("/profiles/personal/.claude"),
            true,
        );
        assert_ne!(a, b);
        assert!(a.0.starts_with("Claude Code-credentials-"));
        assert_eq!(
            credential_key("claude", std::path::Path::new("/home/.claude"), false).0,
            "Claude Code-credentials"
        );
        assert_eq!(
            credential_key("codex", std::path::Path::new("/profiles/work/.codex"), true).0,
            "Codex Auth"
        );
    }
    #[test]
    fn codex_store_selection_never_uses_stale_file_in_keyring_or_ephemeral_mode() {
        let file = serde_json::json!({"OPENAI_API_KEY":"synthetic-file"});
        let key = serde_json::json!({"OPENAI_API_KEY":"synthetic-keychain"});
        assert_eq!(
            choose_login("codex", "file", Some(file.clone()), Some(key.clone())).unwrap(),
            Some(file.clone())
        );
        assert_eq!(
            choose_login("codex", "auto", Some(file.clone()), Some(key.clone())).unwrap(),
            Some(key)
        );
        assert_eq!(
            choose_login("codex", "keyring", Some(file.clone()), None).unwrap(),
            None
        );
        assert_eq!(
            choose_login("codex", "ephemeral", Some(file.clone()), None).unwrap(),
            None
        );
        assert_eq!(
            choose_login("codex", "auto", Some(file), None)
                .unwrap()
                .is_some(),
            true
        );
        assert!(choose_login("codex", "unsupported", None, None).is_err());
    }
    #[test]
    fn claude_export_excludes_unrelated_mcp_secrets() {
        let source = serde_json::json!({"claudeAiOauth":{"accessToken":"synthetic","refreshToken":"synthetic-refresh"},"mcpOAuth":{"private":"not-exported"}});
        let selected = choose_login("claude", "auto", None, Some(source))
            .unwrap()
            .unwrap();
        assert!(selected.get("mcpOAuth").is_none());
        assert!(selected.get("claudeAiOauth").is_some());
    }
    #[test]
    fn stale_claude_file_does_not_hide_current_keychain_login() {
        let stale = serde_json::json!({"claudeAiOauth":{},"mcpOAuth":{}});
        let current = serde_json::json!({"claudeAiOauth":{"accessToken":"synthetic-current","refreshToken":"synthetic-refresh"}});
        assert_eq!(
            select_account_credentials("claude", Some(&stale), Some(&current)),
            Some(&current)
        );
        assert_eq!(
            select_account_credentials("claude", Some(&stale), None),
            None
        );
    }
    #[test]
    fn current_keychain_wins_over_stale_but_valid_file() {
        let old = serde_json::json!({"claudeAiOauth":{"accessToken":"synthetic-old","refreshToken":"synthetic-old-refresh"}});
        let current = serde_json::json!({"claudeAiOauth":{"accessToken":"synthetic-current","refreshToken":"synthetic-current-refresh"}});
        assert_eq!(
            select_account_credentials("claude", Some(&old), Some(&current)),
            Some(&current)
        );
        assert_eq!(
            select_account_credentials("claude", Some(&current), None),
            Some(&current)
        );
    }
    #[test]
    fn a_profile_an_older_host_skipped_is_not_reported_as_synced() {
        let sent = vec!["VJ".to_string(), "Work".to_string()];
        // Older host: existing profiles are skipped, no `updated` key.
        let old = serde_json::json!({"imported":["codex"],"existingProfiles":["VJ"]});
        assert_eq!(not_updated(&old, &sent), sent);
        let new = serde_json::json!({"imported":["codex","Work"],"updated":["VJ"]});
        assert!(not_updated(&new, &sent).is_empty());
    }
    #[test]
    fn a_default_override_inherited_from_a_profile_terminal_is_ignored() {
        let home = "/Users/dev";
        assert_eq!(
            default_override(home, Some("/Users/dev/.canopy/profiles/vj/.claude".into())),
            None
        );
        assert_eq!(
            default_override(home, Some("/Users/dev/alt-claude".into())),
            Some(std::path::PathBuf::from("/Users/dev/alt-claude"))
        );
        assert_eq!(default_override(home, Some(String::new())), None);
        assert_eq!(default_override(home, None), None);
    }
    #[test]
    fn every_login_answer_has_one_picker_state() {
        let probe = |r: Result<Option<serde_json::Value>, String>| LoginProbe::of(&r).candidate();
        assert_eq!(probe(Ok(Some(serde_json::json!({})))), "ready");
        assert_eq!(probe(Ok(None)), "none");
        assert_eq!(probe(Err(INCOMPLETE_LOGIN.into())), "incomplete");
        assert_eq!(probe(Err("locked".into())), "unavailable");
    }
    #[test]
    fn a_login_without_a_refresh_token_is_reported_as_incomplete() {
        // export_or_report and the candidate check match on this exact error.
        let access_only = serde_json::json!({"claudeAiOauth":{"accessToken":"synthetic","refreshToken":null,"expiresAt":0}});
        assert_eq!(
            choose_login("claude", "auto", None, Some(access_only)),
            Err(INCOMPLETE_LOGIN.to_string())
        );
    }
    #[test]
    fn claude_identity_reads_only_the_recorded_account() {
        let dir = std::env::temp_dir().join(format!("canopy-identity-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(".claude.json");
        assert_eq!(claude_identity(&file), None);
        // Large state files (project history) must not drop the identity.
        let padding = "x".repeat(100_000);
        std::fs::write(&file, serde_json::json!({"projects":{"p":padding},"oauthAccount":{"emailAddress":"me@example.com"}}).to_string()).unwrap();
        assert_eq!(
            claude_identity(&file),
            Some(serde_json::json!({"emailAddress":"me@example.com"}))
        );
        std::fs::write(&file, r#"{"oauthAccount":"not-an-object"}"#).unwrap();
        assert_eq!(claude_identity(&file), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn unrelated_credential_data_and_empty_strings_are_not_logins() {
        assert!(!valid_account_credentials(
            "claude",
            &serde_json::json!({"mcpOAuth":{}})
        ));
        assert!(!valid_account_credentials(
            "codex",
            &serde_json::json!({"tokens":{"access_token":""},"OPENAI_API_KEY":null})
        ));
        assert!(valid_account_credentials(
            "codex",
            &serde_json::json!({"tokens":{"access_token":"synthetic"}})
        ));
        assert!(valid_account_credentials(
            "codex",
            &serde_json::json!({"OPENAI_API_KEY":"synthetic-key"})
        ));
    }
}
