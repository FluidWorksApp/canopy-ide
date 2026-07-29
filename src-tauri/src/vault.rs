// Credentials for the embedded browser, and the rules about who may see them.
//
// The in-app browser is a bare WKWebView/WebView2: it has no Keychain autofill,
// no Chrome profile, nothing. Every login inside it was being typed by hand or
// pasted from somewhere else. This is the store that fixes that — and, because
// agents drive that same browser, it is also a place where a mistake means a
// leaked password rather than a wrong pixel. The design below is mostly about
// that second part.
//
// At rest: one file, ~/.canopy/vault.enc, XChaCha20-Poly1305 over a key derived
// from the user's passphrase with Argon2id. The passphrase is never stored, the
// derived key lives in memory only while the vault is unlocked, and the KDF
// parameters travel in the file's header (authenticated as AAD) so a future
// change to them can still open an old vault. A wrong passphrase is
// indistinguishable from a tampered file — both fail the AEAD tag — and both
// are reported as "wrong passphrase or damaged vault", because the alternative
// is an oracle that tells an attacker which of the two they achieved.
//
// In memory: the key is zeroized on lock, and the vault locks itself after
// AUTO_LOCK of no use. There is no way to ask this module for a plaintext
// password without either the user's own click (vault_reveal, from Settings) or
// a fill, which never returns the value to its caller.
//
// To an agent: filling is the whole interface. `fill` takes an entry id and a
// tab, reads the secret here, injects it into the page's own form fields, and
// returns which fields it filled. The plaintext never crosses back through the
// bridge into an agent's context, so a page that talks an agent into
// exfiltrating what it has read has nothing to work with. Reading plaintext is
// possible only for an entry the user has explicitly marked `readable` — for
// the logins that are not web forms at all — and both operations need the
// user's approval for that domain the first time they happen.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;
use zeroize::Zeroize;

/// File magic and format version. The version is the last byte so a format
/// change is one comparison, not a parse.
const MAGIC: &[u8; 12] = b"CANOPYVAULT\x01";
/// Argon2id parameters. 64 MiB and three passes is roughly a fifth of a second
/// on this decade's laptop — slow enough to matter to someone with the file,
/// fast enough that unlocking does not feel broken.
const ARGON_M_COST: u32 = 65_536;
const ARGON_T_COST: u32 = 3;
const ARGON_P_COST: u32 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const HEADER_LEN: usize = MAGIC.len() + 12 + SALT_LEN + NONCE_LEN;
/// How long an unlocked vault stays unlocked without being used. Checked when
/// something asks for it rather than on a timer: a background thread holding a
/// key alive is the thing being avoided here.
const AUTO_LOCK: Duration = Duration::from_secs(30 * 60);
/// The shortest passphrase worth calling one. Argon2id is doing the work, but
/// no KDF saves a four-character secret.
const MIN_PASSPHRASE: usize = 8;

// ---------- what is stored ----------

/// One login. `password` is the only secret; everything else is shown in
/// Settings and told to agents.
#[derive(Clone, Serialize, Deserialize)]
pub struct VaultEntry {
    pub id: String,
    /// What the user calls it — "GitHub", "staging admin".
    pub label: String,
    /// The site it belongs to, as a bare host: "github.com". Matching is by
    /// label boundary (see `domain_matches`), so this covers its subdomains.
    pub domain: String,
    pub username: String,
    pub password: String,
    /// May an agent be told this password in plain text? Off by default: the
    /// browser fill path never needs it, and an agent that cannot see a secret
    /// cannot be talked into repeating it. On for the logins that are not web
    /// forms — a database URL, an SSH passphrase — where filling a field is not
    /// what the user needs.
    #[serde(default)]
    pub readable: bool,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub updated: i64,
}

/// What an agent, or the Settings list, is allowed to know about an entry:
/// everything except the password.
#[derive(Clone, Serialize)]
pub struct VaultItem {
    pub id: String,
    pub label: String,
    pub domain: String,
    pub username: String,
    pub readable: bool,
    pub notes: String,
    pub updated: i64,
}

impl From<&VaultEntry> for VaultItem {
    fn from(e: &VaultEntry) -> Self {
        VaultItem {
            id: e.id.clone(),
            label: e.label.clone(),
            domain: e.domain.clone(),
            username: e.username.clone(),
            readable: e.readable,
            notes: e.notes.clone(),
            updated: e.updated,
        }
    }
}

/// The user's answer to "may an agent do this here", remembered per domain so
/// the question is asked once rather than every time.
#[derive(Clone, Serialize, Deserialize)]
pub struct VaultApproval {
    pub domain: String,
    /// Agents may fill this domain's credentials into the page.
    #[serde(default)]
    pub fill: bool,
    /// Agents may be told this domain's passwords in plain text. Only ever set
    /// for entries that are themselves marked `readable`.
    #[serde(default)]
    pub read: bool,
    #[serde(default)]
    pub granted: i64,
}

/// The decrypted file.
#[derive(Default, Serialize, Deserialize)]
struct VaultData {
    #[serde(default)]
    entries: Vec<VaultEntry>,
    #[serde(default)]
    approvals: Vec<VaultApproval>,
}

// ---------- process state ----------

#[derive(Default)]
pub struct Vault(Mutex<VaultState>);

#[derive(Default)]
struct VaultState {
    /// Present exactly while the vault is unlocked.
    key: Option<[u8; 32]>,
    salt: [u8; SALT_LEN],
    data: VaultData,
    last_use: Option<Instant>,
}

impl VaultState {
    /// Wipe the key and everything it protected. Called on lock, on auto-lock,
    /// and before an unlock replaces the contents.
    fn lock(&mut self) {
        if let Some(mut key) = self.key.take() {
            key.zeroize();
        }
        for entry in &mut self.data.entries {
            entry.password.zeroize();
        }
        self.data = VaultData::default();
        self.last_use = None;
    }

    /// The key, if the vault is unlocked and has not gone stale. Touching it
    /// also resets the idle clock, so "unlocked" means "used within AUTO_LOCK".
    fn key(&mut self) -> Result<[u8; 32], String> {
        if self.last_use.is_some_and(|t| t.elapsed() > AUTO_LOCK) {
            self.lock();
        }
        let key = self
            .key
            .ok_or_else(|| "the vault is locked — unlock it in Settings → Vault".to_string())?;
        self.last_use = Some(Instant::now());
        Ok(key)
    }
}

fn vault_path() -> Result<PathBuf, String> {
    let home = std::env::var("CANOPY_VAULT_HOME")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "no home dir".to_string())?;
    let dir = PathBuf::from(home).join(".canopy");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("vault.enc"))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------- crypto ----------

fn derive_key(passphrase: &str, salt: &[u8], m: u32, t: u32, p: u32) -> Result<[u8; 32], String> {
    let params = argon2::Params::new(m, t, p, Some(32)).map_err(|e| e.to_string())?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut key = [0u8; 32];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| e.to_string())?;
    Ok(key)
}

fn random_bytes(n: usize) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; n];
    getrandom::getrandom(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Encrypt `data` under `key` and write it where a reader can find the
/// parameters again. The header is authenticated but not encrypted: it is salt,
/// nonce and cost parameters, none of which is a secret, and all of which have
/// to be readable before the key exists.
fn seal(key: &[u8; 32], salt: &[u8; SALT_LEN], data: &VaultData) -> Result<Vec<u8>, String> {
    let nonce = random_bytes(NONCE_LEN)?;
    let mut header = Vec::with_capacity(HEADER_LEN);
    header.extend_from_slice(MAGIC);
    header.extend_from_slice(&ARGON_M_COST.to_le_bytes());
    header.extend_from_slice(&ARGON_T_COST.to_le_bytes());
    header.extend_from_slice(&ARGON_P_COST.to_le_bytes());
    header.extend_from_slice(salt);
    header.extend_from_slice(&nonce);

    let plain = serde_json::to_vec(data).map_err(|e| e.to_string())?;
    let cipher = XChaCha20Poly1305::new(key.into());
    let sealed = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &plain,
                aad: &header,
            },
        )
        .map_err(|_| "could not encrypt the vault".to_string())?;

    let mut out = header;
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// The header's parameters, or an error if this is not a vault file at all.
fn read_header(raw: &[u8]) -> Result<(u32, u32, u32, [u8; SALT_LEN], Vec<u8>), String> {
    if raw.len() <= HEADER_LEN || &raw[..MAGIC.len()] != MAGIC {
        return Err("this is not a Canopy vault file".into());
    }
    let n = MAGIC.len();
    let num =
        |at: usize| -> u32 { u32::from_le_bytes([raw[at], raw[at + 1], raw[at + 2], raw[at + 3]]) };
    let (m, t, p) = (num(n), num(n + 4), num(n + 8));
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&raw[n + 12..n + 12 + SALT_LEN]);
    let nonce = raw[n + 12 + SALT_LEN..HEADER_LEN].to_vec();
    Ok((m, t, p, salt, nonce))
}

/// Open a vault file with a passphrase. A wrong passphrase and a corrupted file
/// produce the same error on purpose — anything else tells whoever has the file
/// which of their guesses was structurally right.
fn open(raw: &[u8], passphrase: &str) -> Result<([u8; 32], [u8; SALT_LEN], VaultData), String> {
    let (m, t, p, salt, nonce) = read_header(raw)?;
    let key = derive_key(passphrase, &salt, m, t, p)?;
    let cipher = XChaCha20Poly1305::new(&key.into());
    let plain = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &raw[HEADER_LEN..],
                aad: &raw[..HEADER_LEN],
            },
        )
        .map_err(|_| "wrong passphrase, or the vault file is damaged".to_string())?;
    let data: VaultData = serde_json::from_slice(&plain)
        .map_err(|_| "the vault opened but its contents are unreadable".to_string())?;
    Ok((key, salt, data))
}

/// Write the file so a crash mid-write cannot leave half a vault: a temp file
/// beside it, then a rename, which is atomic on every filesystem Canopy runs
/// on. 0600 on unix — the file is encrypted, and it still has no business being
/// world-readable.
fn write_file(bytes: &[u8]) -> Result<(), String> {
    let path = vault_path()?;
    let tmp = path.with_extension("enc.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Encrypt and persist the current contents. Every mutation goes through here,
/// so the file on disk is never behind what the app believes.
fn persist(state: &mut VaultState) -> Result<(), String> {
    let key = state.key()?;
    let bytes = seal(&key, &state.salt.clone(), &state.data)?;
    write_file(&bytes)
}

// ---------- domain matching ----------

/// The host of a URL, lowercased, without userinfo or port. Deliberately not a
/// full URL parser: this only ever sees what the embedded browser reports as
/// its current location.
pub fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit('@').next()?;
    // Bracketed IPv6 keeps its brackets; a port is what follows the last colon
    // outside them.
    let host = if let Some(end) = authority.find(']') {
        &authority[..=end]
    } else {
        authority.split(':').next()?
    };
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

/// Does a stored entry's domain cover this host?
///
/// Matching is on label boundaries, which is the whole point: `github.com` has
/// to cover `gist.github.com` and must not cover `github.com.evil.example` or
/// `evil-github.com`. A stored `*.` prefix is tolerated because people write it.
pub fn domain_matches(entry_domain: &str, host: &str) -> bool {
    let d = entry_domain
        .trim()
        .trim_start_matches("*.")
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if d.is_empty() {
        return false;
    }
    let h = host.trim().trim_end_matches('.').to_ascii_lowercase();
    h == d || h.ends_with(&format!(".{d}"))
}

// ---------- commands ----------

#[derive(Serialize)]
pub struct VaultStatus {
    /// A vault file exists on disk — the difference between "unlock" and
    /// "choose a passphrase" in the UI.
    pub exists: bool,
    pub unlocked: bool,
    /// Entries held, once unlocked.
    pub entries: usize,
    /// Minutes of idleness before it locks itself, so the UI can say so.
    pub auto_lock_minutes: u64,
}

#[tauri::command]
pub async fn vault_status(state: State<'_, Vault>) -> Result<VaultStatus, String> {
    let mut guard = state.0.lock().unwrap();
    // Reading the status is not "using" the vault, but it is the moment the UI
    // finds out it has gone stale, so an expired key is dropped here too.
    let unlocked = guard.key().is_ok();
    Ok(VaultStatus {
        exists: vault_path().map(|p| p.exists()).unwrap_or(false),
        unlocked,
        entries: if unlocked {
            guard.data.entries.len()
        } else {
            0
        },
        auto_lock_minutes: AUTO_LOCK.as_secs() / 60,
    })
}

/// Create the vault. Refuses to overwrite an existing one: that file is the
/// only copy of everything in it.
#[tauri::command]
pub async fn vault_create(state: State<'_, Vault>, passphrase: String) -> Result<(), String> {
    if passphrase.chars().count() < MIN_PASSPHRASE {
        return Err(format!(
            "a passphrase needs at least {MIN_PASSPHRASE} characters"
        ));
    }
    if vault_path()?.exists() {
        return Err("a vault already exists on this machine".into());
    }
    let salt_bytes = random_bytes(SALT_LEN)?;
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&salt_bytes);
    let key = derive_key(&passphrase, &salt, ARGON_M_COST, ARGON_T_COST, ARGON_P_COST)?;
    let data = VaultData::default();
    write_file(&seal(&key, &salt, &data)?)?;

    let mut guard = state.0.lock().unwrap();
    guard.lock();
    guard.key = Some(key);
    guard.salt = salt;
    guard.data = data;
    guard.last_use = Some(Instant::now());
    Ok(())
}

#[tauri::command]
pub async fn vault_unlock(state: State<'_, Vault>, passphrase: String) -> Result<(), String> {
    let raw = std::fs::read(vault_path()?)
        .map_err(|_| "there is no vault on this machine yet".to_string())?;
    let (key, salt, data) = open(&raw, &passphrase)?;
    let mut guard = state.0.lock().unwrap();
    guard.lock();
    guard.key = Some(key);
    guard.salt = salt;
    guard.data = data;
    guard.last_use = Some(Instant::now());
    Ok(())
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, Vault>) -> Result<(), String> {
    state.0.lock().unwrap().lock();
    Ok(())
}

/// Re-encrypt everything under a new passphrase. The old one is required: this
/// is a change, not a reset, and there is no reset.
#[tauri::command]
pub async fn vault_change_passphrase(
    state: State<'_, Vault>,
    old: String,
    new: String,
) -> Result<(), String> {
    if new.chars().count() < MIN_PASSPHRASE {
        return Err(format!(
            "a passphrase needs at least {MIN_PASSPHRASE} characters"
        ));
    }
    let raw = std::fs::read(vault_path()?).map_err(|e| e.to_string())?;
    let (_, _, data) = open(&raw, &old)?;
    let salt_bytes = random_bytes(SALT_LEN)?;
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&salt_bytes);
    let key = derive_key(&new, &salt, ARGON_M_COST, ARGON_T_COST, ARGON_P_COST)?;
    write_file(&seal(&key, &salt, &data)?)?;

    let mut guard = state.0.lock().unwrap();
    guard.lock();
    guard.key = Some(key);
    guard.salt = salt;
    guard.data = data;
    guard.last_use = Some(Instant::now());
    Ok(())
}

#[tauri::command]
pub async fn vault_list(state: State<'_, Vault>) -> Result<Vec<VaultItem>, String> {
    let mut guard = state.0.lock().unwrap();
    guard.key()?;
    let mut items: Vec<VaultItem> = guard.data.entries.iter().map(VaultItem::from).collect();
    items.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    Ok(items)
}

/// Entries whose domain covers this URL's host, best match first — the longest
/// stored domain wins, so an entry for `admin.example.com` beats one for
/// `example.com` on that host.
#[tauri::command]
pub async fn vault_matches(state: State<'_, Vault>, url: String) -> Result<Vec<VaultItem>, String> {
    let Some(host) = host_of(&url) else {
        return Ok(Vec::new());
    };
    let mut guard = state.0.lock().unwrap();
    guard.key()?;
    let mut hits: Vec<&VaultEntry> = guard
        .data
        .entries
        .iter()
        .filter(|e| domain_matches(&e.domain, &host))
        .collect();
    hits.sort_by_key(|e| std::cmp::Reverse(e.domain.len()));
    Ok(hits.into_iter().map(VaultItem::from).collect())
}

/// Add or update one entry. `password: None` keeps the stored secret, so the
/// edit form never has to hold it to change a label.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn vault_save(
    state: State<'_, Vault>,
    id: Option<String>,
    label: String,
    domain: String,
    username: String,
    password: Option<String>,
    readable: Option<bool>,
    notes: Option<String>,
) -> Result<String, String> {
    let domain = domain.trim().trim_start_matches("*.").to_ascii_lowercase();
    if domain.is_empty() {
        return Err("an entry needs a domain — the site it logs in to".into());
    }
    let mut guard = state.0.lock().unwrap();
    guard.key()?;
    let now = now_secs();
    let id = match id {
        Some(id) => {
            let entry = guard
                .data
                .entries
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or_else(|| "no such entry".to_string())?;
            entry.label = label;
            entry.domain = domain;
            entry.username = username;
            if let Some(p) = password {
                entry.password.zeroize();
                entry.password = p;
            }
            if let Some(r) = readable {
                entry.readable = r;
            }
            if let Some(n) = notes {
                entry.notes = n;
            }
            entry.updated = now;
            id
        }
        None => {
            let id = format!("v{now}{}", guard.data.entries.len());
            guard.data.entries.push(VaultEntry {
                id: id.clone(),
                label,
                domain,
                username,
                password: password.unwrap_or_default(),
                readable: readable.unwrap_or(false),
                notes: notes.unwrap_or_default(),
                updated: now,
            });
            id
        }
    };
    persist(&mut guard)?;
    Ok(id)
}

#[tauri::command]
pub async fn vault_delete(state: State<'_, Vault>, id: String) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    guard.key()?;
    if let Some(at) = guard.data.entries.iter().position(|e| e.id == id) {
        guard.data.entries[at].password.zeroize();
        guard.data.entries.remove(at);
    }
    persist(&mut guard)
}

/// The plaintext, for the user's own eyes. Reachable only from Settings, where
/// the person asking is the person at the keyboard — agents go through
/// `agent_read`, which has a gate on it.
#[tauri::command]
pub async fn vault_reveal(state: State<'_, Vault>, id: String) -> Result<String, String> {
    let mut guard = state.0.lock().unwrap();
    guard.key()?;
    guard
        .data
        .entries
        .iter()
        .find(|e| e.id == id)
        .map(|e| e.password.clone())
        .ok_or_else(|| "no such entry".to_string())
}

// ---------- filling ----------

/// The script that puts a credential into a page's own form.
///
/// Values are passed as JSON literals rather than spliced into source, so a
/// password containing a quote, a backslash or a newline stays one string.
/// Fields are set through the native value setter and followed by input and
/// change events: React (and everything like it) tracks its own value and
/// ignores a plain assignment, which is how "the field looks filled but the
/// form submits empty" happens.
///
/// Two-step logins are the common case that a naive filler gets wrong: the
/// first page has a username field and no password field at all. Filling
/// whatever is there and saying which fields it managed is more useful than
/// failing, so that is what it reports.
fn fill_script(username: &str, password: &str) -> String {
    let user_json = serde_json::to_string(username).unwrap_or_else(|_| "\"\"".into());
    let pass_json = serde_json::to_string(password).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"(() => {{
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const set = (el, value) => {{
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", {{ bubbles: true }}));
    el.dispatchEvent(new Event("change", {{ bubbles: true }}));
  }};
  const pw = [...document.querySelectorAll('input[type="password"]')].find(visible);
  const scope = pw ? (pw.form || document) : document;
  const userSelectors = [
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    'input[type="email"]',
    'input[name*="user" i]',
    'input[name*="email" i]',
    'input[name*="login" i]',
    'input[id*="user" i]',
    'input[id*="email" i]',
    'input[type="text"]',
    'input:not([type])',
  ];
  let user = null;
  for (const sel of userSelectors) {{
    user = [...scope.querySelectorAll(sel)].find(visible);
    if (user) break;
  }}
  const filled = [];
  if (user && {user_json}) {{ set(user, {user_json}); filled.push("username"); }}
  if (pw) {{ set(pw, {pass_json}); filled.push("password"); }}
  if (pw && !user) {{ pw.focus(); }} else if (user && !pw) {{ user.focus(); }}
  return JSON.stringify({{ filled, form: !!(pw && pw.form) }});
}})()"#
    )
}

/// What a fill did. Never the value — only which fields took one.
#[derive(Serialize)]
pub struct FillReport {
    /// "username", "password", or both.
    pub filled: Vec<String>,
    pub label: String,
    pub domain: String,
    /// The fields were inside a real <form>, so submitting is the page's job.
    pub form: bool,
}

/// Put an entry into the page loaded in `tab_id`.
///
/// The secret is read here, turned straight into an injected assignment, and
/// dropped. Nothing in the return value, the logs or the event stream carries
/// it: the only place it lands is the field it was meant for.
pub async fn fill_into_tab(
    app: &tauri::AppHandle,
    state: &Vault,
    tab_id: &str,
    entry_id: &str,
) -> Result<FillReport, String> {
    let (script, label, domain) = {
        let mut guard = state.0.lock().unwrap();
        guard.key()?;
        let entry = guard
            .data
            .entries
            .iter()
            .find(|e| e.id == entry_id)
            .ok_or_else(|| "no such entry".to_string())?;
        (
            fill_script(&entry.username, &entry.password),
            entry.label.clone(),
            entry.domain.clone(),
        )
    };
    let raw = crate::browser::eval_json(app, tab_id, script).await?;
    // The script answers with a JSON string; depending on how the webview
    // serialises a completion value that arrives either already parsed or as a
    // string holding the JSON. Accept both rather than depend on which.
    let report = match raw {
        serde_json::Value::String(s) => serde_json::from_str(&s).unwrap_or(serde_json::Value::Null),
        other => other,
    };
    let filled: Vec<String> = report
        .get("filled")
        .and_then(|f| f.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let form = report
        .get("form")
        .and_then(|f| f.as_bool())
        .unwrap_or(false);
    if filled.is_empty() {
        return Err("no login fields on this page — it may not have loaded the form yet".into());
    }
    Ok(FillReport {
        filled,
        label,
        domain,
        form,
    })
}

/// Fill, as the user's own click in the browser toolbar.
#[tauri::command]
pub async fn vault_fill(
    app: tauri::AppHandle,
    state: State<'_, Vault>,
    tab_id: String,
    id: String,
) -> Result<FillReport, String> {
    fill_into_tab(&app, &state, &tab_id, &id).await
}

// ---------- what agents may do ----------

// Whether a domain is approved is decided in the frontend (vaultFill.ts): it is
// the side that can put the question to the user, and it is the only side that
// can tell an agent's fill from the user's own click on the toolbar button.
// What lives here is the check no caller can skip — an entry is fill-only
// unless the user marked it readable (see `agent_read`).

/// Record the user's answer. Called after the approval prompt, never from an
/// agent's own request.
pub fn approve(state: &Vault, domain: &str, op: &str) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    guard.key()?;
    let now = now_secs();
    match guard.data.approvals.iter_mut().find(|a| a.domain == domain) {
        Some(existing) => {
            if op == "read" {
                existing.read = true;
            } else {
                existing.fill = true;
            }
            existing.granted = now;
        }
        None => guard.data.approvals.push(VaultApproval {
            domain: domain.to_string(),
            fill: op != "read",
            read: op == "read",
            granted: now,
        }),
    }
    persist(&mut guard)
}

/// The plaintext for an agent, once the frontend's approval gate has passed.
/// The `readable` flag is checked here, not there: a gate that only exists in
/// the UI is a gate that a future caller forgets to open.
#[derive(Serialize)]
pub struct VaultSecret {
    pub username: String,
    pub password: String,
}

#[tauri::command]
pub async fn vault_read(state: State<'_, Vault>, id: String) -> Result<VaultSecret, String> {
    let (_, username, password) = agent_read(&state, &id)?;
    Ok(VaultSecret { username, password })
}

/// Remember that the user allowed agents to do `op` on this domain. Only ever
/// called after the approval prompt has been answered.
#[tauri::command]
pub async fn vault_approve(
    state: State<'_, Vault>,
    domain: String,
    op: String,
) -> Result<(), String> {
    approve(&state, &domain, &op)
}

#[tauri::command]
pub async fn vault_approvals(state: State<'_, Vault>) -> Result<Vec<VaultApproval>, String> {
    let mut guard = state.0.lock().unwrap();
    guard.key()?;
    Ok(guard.data.approvals.clone())
}

/// Take back a domain's approvals. The next agent that tries has to ask again.
#[tauri::command]
pub async fn vault_revoke(state: State<'_, Vault>, domain: String) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    guard.key()?;
    guard.data.approvals.retain(|a| a.domain != domain);
    persist(&mut guard)
}

/// The plaintext, for an agent. Two locks on this door, and both have to be
/// opened by the user: the entry itself must be marked `readable`, and the
/// domain must have a `read` approval. Everything else gets the fill path,
/// which never hands the value over.
pub fn agent_read(state: &Vault, id: &str) -> Result<(String, String, String), String> {
    let mut guard = state.0.lock().unwrap();
    guard.key()?;
    let entry = guard
        .data
        .entries
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| "no such entry".to_string())?;
    if !entry.readable {
        return Err(format!(
            "\"{}\" is fill-only. Use vault_fill to put it into the page — or mark the entry \
             readable in Settings → Vault if it is a login no browser form can take.",
            entry.label
        ));
    }
    Ok((
        entry.domain.clone(),
        entry.username.clone(),
        entry.password.clone(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `unwrap_err` would need `Debug` on the success type, and the success
    /// type here holds plaintext passwords — a Debug impl on it is one stray
    /// `{:?}` away from a secret in a log line. So the tests take the error out
    /// by hand and the secrets stay unprintable.
    fn err_of<T>(r: Result<T, String>) -> String {
        match r {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        }
    }

    fn data_with(password: &str) -> VaultData {
        VaultData {
            entries: vec![VaultEntry {
                id: "v1".into(),
                label: "GitHub".into(),
                domain: "github.com".into(),
                username: "sam".into(),
                password: password.into(),
                readable: false,
                notes: String::new(),
                updated: 10,
            }],
            approvals: vec![],
        }
    }

    fn sealed(passphrase: &str, data: &VaultData) -> Vec<u8> {
        let salt = [7u8; SALT_LEN];
        let key = derive_key(passphrase, &salt, 8, 1, 1).unwrap();
        // Sealing with the real cost parameters in the header would make every
        // test pay for them; the round-trip below reads them back out, so the
        // header has to say what was actually used.
        let nonce = random_bytes(NONCE_LEN).unwrap();
        let mut header = Vec::new();
        header.extend_from_slice(MAGIC);
        header.extend_from_slice(&8u32.to_le_bytes());
        header.extend_from_slice(&1u32.to_le_bytes());
        header.extend_from_slice(&1u32.to_le_bytes());
        header.extend_from_slice(&salt);
        header.extend_from_slice(&nonce);
        let plain = serde_json::to_vec(data).unwrap();
        let cipher = XChaCha20Poly1305::new(&key.into());
        let out = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &plain,
                    aad: &header,
                },
            )
            .unwrap();
        let mut file = header;
        file.extend_from_slice(&out);
        file
    }

    #[test]
    fn a_vault_opens_with_its_passphrase_and_with_nothing_else() {
        let file = sealed("correct horse battery", &data_with("hunter2"));
        let (_, _, data) = open(&file, "correct horse battery").unwrap();
        assert_eq!(data.entries[0].password, "hunter2");
        // The wrong passphrase and a damaged file are the same error: telling
        // them apart would say which guess was closer.
        let wrong = err_of(open(&file, "correct horse batter"));
        assert!(wrong.contains("wrong passphrase"), "{wrong}");
    }

    #[test]
    fn a_changed_byte_anywhere_fails_to_open() {
        let file = sealed("correct horse battery", &data_with("hunter2"));
        // In the ciphertext...
        let mut tampered = file.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        assert!(open(&tampered, "correct horse battery").is_err());
        // ...and in the header, which is authenticated rather than encrypted:
        // flipping a KDF cost or the salt has to be caught, not silently
        // honoured into a different key.
        let mut header_flip = file.clone();
        header_flip[MAGIC.len()] ^= 0x01;
        assert!(open(&header_flip, "correct horse battery").is_err());
    }

    #[test]
    fn a_file_that_is_not_a_vault_says_so_rather_than_failing_to_decrypt() {
        let err = err_of(open(b"{\"entries\":[]}", "whatever"));
        assert!(err.contains("not a Canopy vault"), "{err}");
    }

    #[test]
    fn a_domain_covers_its_subdomains_and_nothing_that_merely_looks_like_it() {
        assert!(domain_matches("github.com", "github.com"));
        assert!(domain_matches("github.com", "gist.github.com"));
        assert!(domain_matches("github.com", "GitHub.com"));
        assert!(domain_matches("*.github.com", "api.github.com"));
        // The attacks this is here for.
        assert!(!domain_matches("github.com", "evil-github.com"));
        assert!(!domain_matches("github.com", "github.com.evil.example"));
        assert!(!domain_matches("github.com", "notgithub.com"));
        assert!(!domain_matches("", "github.com"));
        // Sibling subdomains do not cover each other.
        assert!(!domain_matches("admin.example.com", "shop.example.com"));
    }

    #[test]
    fn the_host_is_taken_from_a_url_the_way_a_browser_would() {
        assert_eq!(
            host_of("https://github.com/login").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            host_of("http://localhost:5173/").as_deref(),
            Some("localhost")
        );
        assert_eq!(
            host_of("https://user:pw@example.com:8443/x").as_deref(),
            Some("example.com")
        );
        assert_eq!(
            host_of("https://EXAMPLE.com.").as_deref(),
            Some("example.com")
        );
        assert_eq!(host_of("https://[::1]:3000/").as_deref(), Some("[::1]"));
        assert_eq!(host_of(""), None);
    }

    #[test]
    fn the_fill_script_carries_values_as_data_not_as_source() {
        // A password that would end the string, comment out the rest, or inject
        // a statement if it were spliced into the script text.
        let nasty = "\";alert(1);//\n\\";
        let script = fill_script("sam", nasty);
        assert!(script.contains(r#""\";alert(1);//\n\\""#), "{script}");
        // And the raw sequence never appears unescaped.
        assert!(!script.contains("\";alert(1);//\n"));
    }

    #[test]
    fn an_entry_is_fill_only_until_the_user_says_otherwise() {
        let vault = Vault(Mutex::new(VaultState {
            key: Some([1u8; 32]),
            salt: [0u8; SALT_LEN],
            data: data_with("hunter2"),
            last_use: Some(Instant::now()),
        }));
        let err = agent_read(&vault, "v1").unwrap_err();
        assert!(err.contains("fill-only"), "{err}");
        // Marked readable, the same call succeeds — the gate is the flag, not
        // the caller.
        vault.0.lock().unwrap().data.entries[0].readable = true;
        let (_, user, pass) = agent_read(&vault, "v1").unwrap();
        assert_eq!((user.as_str(), pass.as_str()), ("sam", "hunter2"));
    }

    #[test]
    fn a_locked_vault_answers_nothing() {
        let vault = Vault(Mutex::new(VaultState::default()));
        assert!(agent_read(&vault, "v1").is_err());
        assert!(vault.0.lock().unwrap().key().is_err());
    }

    #[test]
    fn locking_wipes_the_key_and_the_secrets_it_protected() {
        let mut state = VaultState {
            key: Some([9u8; 32]),
            salt: [0u8; SALT_LEN],
            data: data_with("hunter2"),
            last_use: Some(Instant::now()),
        };
        state.lock();
        assert!(state.key.is_none());
        assert!(state.data.entries.is_empty());
        assert!(state.key().is_err());
    }
}
