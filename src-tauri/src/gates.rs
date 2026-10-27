//! Rules compiled into gates: the deterministic half of "if a rule matters, the
//! workspace enforces it".
//!
//! People write rules in plain language in the Rules editor; the brain compiles
//! each one into a gate from the small, fixed DSL below, the person approves the
//! compiled gate, and the app writes the approved set to a per-repository policy
//! file. `canopy-hook` reads that file on every PreToolUse and decides — with no
//! brain call, no network and no app — whether the tool call may run.
//!
//! This module is compiled into BOTH binaries: the app (`mod gates`, which writes
//! the policy and the approve-once tokens) and the standalone hook (`#[path]`,
//! which reads them). So it depends on nothing but serde, sha2, hex, globset and
//! regex — no Tauri, no `crate::` paths — and every filesystem location takes an
//! explicit home so the tests never touch the real one.
//!
//! Three kinds of finding, in decreasing strength:
//!   * self-protection — an agent editing the policy that governs it. Always on,
//!     never approvable from the agent's side.
//!   * enforced team rules — `deny-*`, `protect-tests`, package lists, egress.
//!     Denied with the rule's own words; the person can "Allow once".
//!   * irreversible actions — built in and always on (drop a table, force-push a
//!     protected branch, `terraform destroy`, move money…) plus any
//!     `require-confirm` rule. Denied *pending* an out-of-band human approval,
//!     which mints a short-lived token for that exact command.
//!   * trifecta — a session that read untrusted web content then reaching for
//!     secrets or an outbound write. Warn by default; deny when the project's
//!     policy says so.

// The app uses the writers, the hook the evaluator; each target leaves half of
// this module unused by design.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

pub const POLICY_VERSION: u32 = 1;
/// How long an "Approve once" stays redeemable. Long enough for the person to
/// tell the agent to go ahead; short enough that a forgotten approval cannot be
/// cashed in tomorrow by a different task.
pub const APPROVAL_TTL_MS: u64 = 10 * 60 * 1000;

// ---------------------------------------------------------------- the DSL

/// One compiled gate. Closed on purpose: the brain may only pick from these, and
/// the TypeScript validator (src/gates/dsl.ts) rejects anything else before it
/// can reach this file. Unknown types in a hand-edited policy fail to parse and
/// that gate is skipped, never guessed at.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Gate {
    /// No write (Write/Edit/patch, or a shell writer like rm/mv/tee/>) to a
    /// path matching any glob, relative to the repository's top level.
    /// `except_files` are exact repo-relative files let through anyway: a layer
    /// owner approved a change to them (src/lensGates.ts).
    DenyPathWrite {
        globs: Vec<String>,
        #[serde(rename = "exceptFiles", default, skip_serializing_if = "Vec::is_empty")]
        except_files: Vec<String>,
    },
    /// No shell command matching any pattern (Rust `regex` syntax: linear time,
    /// no backreferences or lookaround — the TS validator enforces the same).
    DenyCommand { patterns: Vec<String> },
    /// Ask the person first: an opt-in class beyond the built-in irreversible
    /// set (see `CONFIRM_CLASSES`), and/or custom command patterns.
    RequireConfirm {
        #[serde(rename = "match", default, skip_serializing_if = "Option::is_none")]
        class: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        patterns: Vec<String>,
    },
    /// Tests may not be edited or deleted. Empty globs mean the usual places.
    ProtectTests {
        #[serde(default)]
        globs: Vec<String>,
    },
    /// Package installs may only add these names.
    PackageAllowlist { names: Vec<String> },
    /// Package installs may never add these names.
    PackageDenylist { names: Vec<String> },
    /// Best effort: curl/wget/WebFetch may only reach these hosts.
    EgressAllowlist { hosts: Vec<String> },
    /// The brain's honest answer that a rule cannot be checked mechanically. Kept
    /// as guidance; never written to the policy.
    Unenforceable { reason: String },
}

/// Opt-in confirm classes a `require-confirm` rule can name. The built-in
/// irreversible classes are accepted too (harmlessly redundant).
pub const CONFIRM_CLASSES: &[&str] = &[
    "publish",
    "migrate",
    "install",
    "push",
    "deploy-any",
    "network-write",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PolicyGate {
    /// The rule's ledger id, so a block can be counted against it.
    pub id: String,
    /// The rule as the person wrote it — quoted back to the agent verbatim.
    pub rule: String,
    #[serde(default = "default_scope")]
    pub scope: String,
    pub gate: Gate,
    /// Team members (Canopy account ids) whose own sessions this gate doesn't
    /// stop: a layer's owner (src/lensGates.ts). A session says whose it is
    /// with `CANOPY_MEMBER`, stamped at spawn by the app it was started from.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub except_members: Vec<String>,
}

impl PolicyGate {
    /// Whether this gate checks a session started by `member`.
    pub fn applies_to(&self, member: Option<&str>) -> bool {
        match member.map(str::trim).filter(|m| !m.is_empty()) {
            Some(m) => !self.except_members.iter().any(|e| e == m),
            None => true,
        }
    }
}

impl Policy {
    /// The policy as one session sees it: gates that exempt its member dropped.
    pub fn for_member(mut self, member: Option<&str>) -> Self {
        self.gates.retain(|g| g.applies_to(member));
        self
    }
}

fn default_scope() -> String {
    "project".into()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    #[serde(default)]
    pub version: u32,
    /// The canonical root this policy was written for.
    #[serde(default)]
    pub root: String,
    #[serde(default)]
    pub updated_at: u64,
    /// "warn" (default) or "block": what a session that read web content may
    /// still do with secrets and outbound writes.
    #[serde(default)]
    pub trifecta: String,
    /// Approved, enforceable gates only.
    #[serde(default)]
    pub gates: Vec<PolicyGate>,
    /// Guidance rules, injected as a short list at session start instead of
    /// growing an instruction file.
    #[serde(default)]
    pub guidance: Vec<String>,
}

impl Policy {
    pub fn trifecta_blocks(&self) -> bool {
        self.trifecta == "block"
    }
}

// ------------------------------------------------------------- locations

/// `CANOPY_POLICY_HOME` points straight at the store (tests); otherwise
/// `~/.canopy/policy`, beside the ledger.
pub fn policy_dir(home: &str) -> PathBuf {
    if let Ok(dir) = std::env::var("CANOPY_POLICY_HOME") {
        return PathBuf::from(dir);
    }
    PathBuf::from(home).join(".canopy").join("policy")
}

/// Same rule as ledger.rs `store_dir`, so a hook-side block lands in the very
/// file the app's Rules panel reads.
pub fn ledger_dir(home: &str) -> PathBuf {
    if let Ok(dir) = std::env::var("CANOPY_LEDGER_HOME") {
        return PathBuf::from(dir);
    }
    PathBuf::from(home).join(".canopy").join("ledger")
}

/// Identical to `ledger::root_hash` (a test pins the two together): the policy
/// and the ledger are keyed by the same name for a repository.
pub fn root_hash(canonical: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(&Sha256::digest(canonical.as_bytes())[..16])
}

pub fn policy_path(home: &str, canonical: &str) -> PathBuf {
    policy_dir(home).join(format!("{}.json", root_hash(canonical)))
}

/// The worktree's top level: the nearest ancestor holding `.git` (a directory
/// in a main checkout, a `gitdir:` file in a linked worktree or submodule).
pub fn worktree_top(cwd: &Path) -> Option<PathBuf> {
    let mut dir = Some(cwd);
    while let Some(d) = dir {
        if d.join(".git").exists() {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

/// The git directory for a worktree top: `.git` itself, or what its `gitdir:`
/// file points at.
fn git_dir(top: &Path) -> Option<PathBuf> {
    let dot = top.join(".git");
    if dot.is_dir() {
        return Some(dot);
    }
    let raw = std::fs::read_to_string(&dot).ok()?;
    let target = raw.trim().strip_prefix("gitdir:")?.trim();
    let p = Path::new(target);
    Some(if p.is_absolute() {
        p.to_path_buf()
    } else {
        top.join(p)
    })
}

/// The ledger's canonical root, computed without a subprocess: the parent of
/// the repository's common git dir, canonicalized — exactly what
/// `ledger::canonical_root` gets from `git rev-parse --git-common-dir`. A hook
/// runs on every tool call, so a `git` spawn here would be the whole budget.
pub fn canonical_root(cwd: &Path) -> Option<String> {
    let top = worktree_top(cwd)?;
    let gd = git_dir(&top)?;
    let common = match std::fs::read_to_string(gd.join("commondir")) {
        Ok(raw) => {
            let p = Path::new(raw.trim());
            if p.is_absolute() {
                p.to_path_buf()
            } else {
                gd.join(p)
            }
        }
        Err(_) => gd,
    };
    let common = common.canonicalize().ok()?;
    common.parent().map(|p| p.to_string_lossy().to_string())
}

/// Load the policy that governs `cwd`: the repository's, or — for a folder git
/// cannot speak for — the nearest ancestor that has one. Returns the canonical
/// root it was filed under alongside it. Missing or unreadable: None, which is
/// "no team rules", never an error the agent sees.
pub fn load_policy(home: &str, cwd: &Path) -> Option<(String, Policy)> {
    let mut candidates: Vec<String> = Vec::new();
    if let Some(root) = canonical_root(cwd) {
        candidates.push(root);
    }
    let start = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let mut dir = Some(start.as_path());
    while let Some(d) = dir {
        candidates.push(d.to_string_lossy().to_string());
        dir = d.parent();
    }
    for root in candidates {
        let Ok(raw) = std::fs::read_to_string(policy_path(home, &root)) else {
            continue;
        };
        if let Ok(policy) = serde_json::from_str::<Policy>(&raw) {
            return Some((root, policy));
        }
    }
    None
}

/// Atomic write (temp + rename) so a hook never reads half a policy.
pub fn write_policy(home: &str, canonical: &str, policy: &Policy) -> Result<PathBuf, String> {
    let path = policy_path(home, canonical);
    write_atomic(
        &path,
        &serde_json::to_vec_pretty(policy).map_err(|e| e.to_string())?,
    )?;
    Ok(path)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

// ------------------------------------------------------- approve-once tokens

/// The identity of "that exact action" for approve-once: the repository plus
/// the command line (or the write target). Whitespace at the ends is not part
/// of the command; everything else is, so an approved `rm -rf build` does not
/// also approve `rm -rf build/..`.
pub fn action_key(root: &str, action: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(root.as_bytes());
    h.update(b"\n");
    h.update(action.trim().as_bytes());
    hex::encode(&h.finalize()[..16])
}

fn valid_key(key: &str) -> bool {
    key.len() == 32 && key.bytes().all(|b| b.is_ascii_hexdigit())
}

fn approval_path(home: &str, key: &str) -> PathBuf {
    policy_dir(home)
        .join("approvals")
        .join(format!("{key}.json"))
}

/// Mint a token: the person said "Approve once" (or "Allow once") in Canopy.
pub fn grant_once(home: &str, key: &str, now_ms: u64) -> Result<(), String> {
    if !valid_key(key) {
        return Err("not an approval key".into());
    }
    let body = serde_json::json!({ "expiresAt": now_ms + APPROVAL_TTL_MS });
    write_atomic(&approval_path(home, key), body.to_string().as_bytes())
}

/// Spend a token if there is a live one. Removing the file IS the spend, so two
/// racing hooks cannot both cash one approval: only one `remove_file` succeeds.
pub fn consume_once(home: &str, key: &str, now_ms: u64) -> bool {
    if !valid_key(key) {
        return false;
    }
    let path = approval_path(home, key);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return false;
    };
    if std::fs::remove_file(&path).is_err() {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v["expiresAt"].as_u64())
        .is_some_and(|exp| exp > now_ms)
}

// ------------------------------------------------------------------ taint

fn safe_component(s: &str) -> Option<String> {
    let clean: String = s
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .collect();
    (!clean.is_empty() && clean.len() <= 128 && !clean.starts_with('.')).then_some(clean)
}

fn taint_path(home: &str, id: &str) -> Option<PathBuf> {
    Some(policy_dir(home).join("taint").join(safe_component(id)?))
}

/// Tools whose output is content from the open web: anything a page author, an
/// issue filer or a search result controls.
pub fn reads_untrusted(tool: &str) -> bool {
    let t = tool.to_ascii_lowercase();
    t == "webfetch"
        || t == "websearch"
        || t == "web_fetch"
        || t == "web_search"
        || t.contains("browser_navigate")
        || t.contains("browser_snapshot")
        || t.contains("playwright")
        || t.contains("claude-in-chrome")
        || t.contains("puppeteer")
        || t.contains("fetch_url")
}

/// Mark a session (and its terminal, for the MCP server, which cannot see the
/// session id) as having read untrusted content. Idempotent.
pub fn mark_tainted(home: &str, ids: &[String], source: &str) {
    for id in ids {
        if let Some(path) = taint_path(home, id) {
            if path.exists() {
                continue;
            }
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&path, source);
        }
    }
}

pub fn is_tainted(home: &str, ids: &[String]) -> Option<String> {
    ids.iter().find_map(|id| {
        let p = taint_path(home, id)?;
        std::fs::read_to_string(p).ok().map(|s| {
            if s.trim().is_empty() {
                "web content".to_string()
            } else {
                s.trim().to_string()
            }
        })
    })
}

/// The terminal's taint id: pty ids restart per app launch, so the instance is
/// part of it.
pub fn pty_taint_id(instance: Option<&str>, pty: Option<&str>) -> Option<String> {
    let pty = pty.filter(|p| !p.is_empty())?;
    Some(format!("pty-{}-{pty}", instance.unwrap_or("0")))
}

// ---------------------------------------------------------------- shell lexing

/// A command line split into simple commands (on unquoted `;`, `&&`, `||`,
/// `|`, `&` and newlines), each a list of words with quotes removed. Not a
/// shell: no expansion, no subshell semantics. Good enough to find the verb and
/// its arguments, which is all a gate needs; anything cleverer is the reason
/// egress and path gates are labelled best effort.
pub fn segments(command: &str) -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = Vec::new();
    let mut words: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut chars = command.chars().peekable();
    let flush_word = |cur: &mut String, in_word: &mut bool, words: &mut Vec<String>| {
        if *in_word {
            words.push(std::mem::take(cur));
            *in_word = false;
        }
    };
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_word = true;
                for d in chars.by_ref() {
                    if d == '\'' {
                        break;
                    }
                    cur.push(d);
                }
            }
            '"' => {
                in_word = true;
                while let Some(d) = chars.next() {
                    if d == '"' {
                        break;
                    }
                    if d == '\\' {
                        if let Some(e) = chars.next() {
                            cur.push(e);
                        }
                        continue;
                    }
                    cur.push(d);
                }
            }
            '\\' => {
                if let Some(d) = chars.next() {
                    if d != '\n' {
                        cur.push(d);
                        in_word = true;
                    }
                }
            }
            ';' | '|' | '&' | '\n' | '(' | ')' => {
                flush_word(&mut cur, &mut in_word, &mut words);
                if !words.is_empty() {
                    out.push(std::mem::take(&mut words));
                }
            }
            c if c.is_whitespace() => flush_word(&mut cur, &mut in_word, &mut words),
            c => {
                cur.push(c);
                in_word = true;
            }
        }
    }
    flush_word(&mut cur, &mut in_word, &mut words);
    if !words.is_empty() {
        out.push(words);
    }
    out
}

/// Drop what runs *around* the real verb: env assignments, sudo, time, nohup…
fn strip_prefix_words(words: &[String]) -> &[String] {
    let mut i = 0;
    while i < words.len() {
        let w = words[i].as_str();
        let is_assign = w.contains('=')
            && !w.starts_with('-')
            && w.split('=').next().is_some_and(|k| {
                !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            });
        if is_assign
            || matches!(
                w,
                "sudo"
                    | "time"
                    | "nohup"
                    | "exec"
                    | "command"
                    | "env"
                    | "nice"
                    | "doas"
                    | "builtin"
            )
        {
            i += 1;
            continue;
        }
        break;
    }
    &words[i..]
}

fn verb(words: &[String]) -> &str {
    words
        .first()
        .map(|w| w.rsplit('/').next().unwrap_or(w))
        .unwrap_or("")
}

fn has_flag(words: &[String], long: &str, short: char) -> bool {
    words.iter().any(|w| {
        w == long
            || w.starts_with(&format!("{long}="))
            || (w.starts_with('-') && !w.starts_with("--") && w[1..].contains(short))
    })
}

// ------------------------------------------------------------ path helpers

/// Lexically normalize (no filesystem): resolve `.` and `..`, keep it absolute.
pub fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn expand_home(word: &str, home: &str) -> Option<String> {
    if word == "~" || word == "$HOME" || word == "${HOME}" {
        return Some(home.to_string());
    }
    for prefix in ["~/", "$HOME/", "${HOME}/"] {
        if let Some(rest) = word.strip_prefix(prefix) {
            return Some(format!("{home}/{rest}"));
        }
    }
    // Any other expansion is a value we cannot know from here.
    if word.contains('$') || word.contains('`') {
        return None;
    }
    Some(word.to_string())
}

fn resolve(word: &str, cwd: &Path, home: &str) -> Option<PathBuf> {
    let w = expand_home(word, home)?;
    let p = Path::new(&w);
    Some(lexical(&if p.is_absolute() {
        p.to_path_buf()
    } else {
        cwd.join(p)
    }))
}

/// A glob as the person means it, made precise: a bare name ("migrations")
/// protects that directory anywhere, a name ending in `/` its contents, and a
/// pattern with no slash (`*.sql`) matches the file name at any depth.
pub fn expand_glob(glob: &str) -> Vec<String> {
    let g = glob.trim().trim_start_matches("./").trim_start_matches('/');
    if g.is_empty() {
        return vec![];
    }
    let has_meta = g.contains(['*', '?', '[', '{']);
    if let Some(dir) = g.strip_suffix('/') {
        let base = if dir.contains('/') || dir.starts_with("**") {
            dir.to_string()
        } else {
            format!("**/{dir}")
        };
        return vec![format!("{base}/**")];
    }
    if !g.contains('/') {
        if has_meta {
            return vec![format!("**/{g}")];
        }
        return vec![format!("**/{g}"), format!("**/{g}/**")];
    }
    if has_meta {
        vec![g.to_string()]
    } else {
        vec![g.to_string(), format!("{g}/**")]
    }
}

fn glob_set(globs: &[String]) -> Option<globset::GlobSet> {
    let mut b = globset::GlobSetBuilder::new();
    let mut any = false;
    for g in globs.iter().flat_map(|g| expand_glob(g)) {
        if let Ok(glob) = globset::GlobBuilder::new(&g)
            .literal_separator(true)
            .backslash_escape(true)
            .build()
        {
            b.add(glob);
            any = true;
        }
    }
    if !any {
        return None;
    }
    b.build().ok()
}

pub const DEFAULT_TEST_GLOBS: &[&str] = &[
    "*.test.*",
    "*.spec.*",
    "*_test.*",
    "test_*.py",
    "__tests__/",
    "tests/",
    "test/",
    "spec/",
];

/// The path relative to the worktree top, `/`-separated, or None outside it.
fn relative_to(path: &Path, top: &Path) -> Option<String> {
    path.strip_prefix(top)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
}

// ------------------------------------------------------------- the action

/// What a tool call is about to do, as far as a gate cares.
#[derive(Debug, Clone, Default)]
pub struct Action {
    pub tool: String,
    /// A shell command, for Bash-like tools.
    pub command: Option<String>,
    /// Absolute paths a write tool targets.
    pub writes: Vec<PathBuf>,
    /// Absolute paths a read tool targets.
    pub reads: Vec<PathBuf>,
    /// A URL a fetch tool targets.
    pub url: Option<String>,
}

impl Action {
    /// What approve-once keys on: the command line, else the first target.
    pub fn identity(&self) -> String {
        if let Some(c) = &self.command {
            return c.trim().to_string();
        }
        if let Some(w) = self.writes.first() {
            return format!("write:{}", w.display());
        }
        if let Some(r) = self.reads.first() {
            return format!("read:{}", r.display());
        }
        if let Some(u) = &self.url {
            return format!("fetch:{u}");
        }
        format!("tool:{}", self.tool)
    }
}

const SHELL_TOOLS: &[&str] = &[
    "Bash",
    "bash",
    "shell",
    "Shell",
    "exec_command",
    "local_shell",
    "run_shell_command",
    "run_terminal_cmd",
    "execute_command",
];
const WRITE_TOOLS: &[&str] = &[
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "write_file",
    "edit_file",
    "replace",
    "create_file",
];
const READ_TOOLS: &[&str] = &["Read", "read_file", "view", "NotebookRead"];

fn abs(path: &str, cwd: &Path) -> PathBuf {
    let p = Path::new(path);
    lexical(&if p.is_absolute() {
        p.to_path_buf()
    } else {
        cwd.join(p)
    })
}

/// Build the action from a (normalized) hook event's tool name and input. Patch
/// tools pass their already-parsed targets in `patch_writes`.
pub fn action_from_event(
    tool: &str,
    input: &serde_json::Value,
    cwd: &Path,
    patch_writes: Vec<String>,
) -> Action {
    let mut a = Action {
        tool: tool.to_string(),
        ..Default::default()
    };
    if SHELL_TOOLS.contains(&tool) {
        a.command = input["command"]
            .as_str()
            .map(str::to_string)
            .or_else(|| {
                input["command"].as_array().map(|parts| {
                    parts
                        .iter()
                        .filter_map(|p| p.as_str())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
            })
            .or_else(|| input["cmd"].as_str().map(str::to_string));
    }
    if WRITE_TOOLS.contains(&tool) {
        for key in ["file_path", "notebook_path", "path", "filePath"] {
            if let Some(p) = input[key].as_str().filter(|p| !p.is_empty()) {
                a.writes.push(abs(p, cwd));
                break;
            }
        }
    }
    // A patch carried in a shell call is an edit, not a command: its text (a
    // migration that says DROP TABLE, say) must not be classified as one.
    if !patch_writes.is_empty() {
        a.command = None;
    }
    for p in patch_writes {
        a.writes.push(abs(&p, cwd));
    }
    if READ_TOOLS.contains(&tool) {
        for key in ["file_path", "path", "notebook_path", "filePath"] {
            if let Some(p) = input[key].as_str().filter(|p| !p.is_empty()) {
                a.reads.push(abs(p, cwd));
                break;
            }
        }
    }
    if let Some(u) = input["url"].as_str() {
        a.url = Some(u.to_string());
    }
    a
}

// ---------------------------------------------------------------- findings

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FindingKind {
    SelfProtect,
    Rule,
    Irreversible,
    Trifecta,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub kind: FindingKind,
    /// For rule findings: the rule's ledger id and words.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_text: Option<String>,
    /// Gate type or irreversible class.
    pub class: String,
    /// What the action would cost, in words a non-engineer can judge.
    pub label: String,
}

/// What the hook does with a set of findings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Allow,
    /// Allow, but tell the person (trifecta in warn mode).
    Warn,
    /// Denied by a rule; the person may "Allow once".
    Blocked,
    /// Denied pending an out-of-band approval.
    NeedsApproval,
    /// Denied with no override from the agent's side.
    Refused,
}

pub fn outcome(findings: &[Finding], trifecta_blocks: bool) -> Outcome {
    if findings.iter().any(|f| f.kind == FindingKind::SelfProtect) {
        return Outcome::Refused;
    }
    if findings.iter().any(|f| f.kind == FindingKind::Rule) {
        return Outcome::Blocked;
    }
    if findings.iter().any(|f| f.kind == FindingKind::Irreversible) {
        return Outcome::NeedsApproval;
    }
    if findings.iter().any(|f| f.kind == FindingKind::Trifecta) {
        return if trifecta_blocks {
            Outcome::Blocked
        } else {
            Outcome::Warn
        };
    }
    Outcome::Allow
}

// ----------------------------------------------------- the git probe

/// What the irreversible classifier needs to know about the repository. A trait
/// so the tests can answer without a repo; the hook's implementation reads
/// `.git` files directly and spawns `git status` only for `reset --hard`.
pub trait GitProbe {
    /// (tracked changes, untracked files)
    fn dirty(&self, top: &Path) -> (bool, bool);
    fn current_branch(&self, top: &Path) -> Option<String>;
    fn default_branch(&self, top: &Path) -> Option<String>;
}

pub struct FsGit;

impl GitProbe for FsGit {
    fn dirty(&self, top: &Path) -> (bool, bool) {
        use std::io::Read;
        // Bounded read (process_capture.rs forbids unbounded capture): the
        // first few KB of porcelain answer both questions.
        let child = std::process::Command::new("git")
            .args(["status", "--porcelain=v1", "--untracked-files=normal"])
            .current_dir(top)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn();
        let Ok(mut child) = child else {
            // Unknown is treated as dirty: the cost of asking is one click, the
            // cost of guessing clean is someone's afternoon.
            return (true, true);
        };
        let mut buf = Vec::new();
        if let Some(out) = child.stdout.take() {
            let _ = out.take(64 * 1024).read_to_end(&mut buf);
        }
        let _ = child.kill();
        let _ = child.wait();
        let text = String::from_utf8_lossy(&buf);
        let tracked = text
            .lines()
            .any(|l| !l.starts_with("??") && !l.trim().is_empty());
        let untracked = text.lines().any(|l| l.starts_with("??"));
        (tracked, untracked)
    }
    fn current_branch(&self, top: &Path) -> Option<String> {
        let head = std::fs::read_to_string(git_dir(top)?.join("HEAD")).ok()?;
        head.trim()
            .strip_prefix("ref: refs/heads/")
            .map(str::to_string)
    }
    fn default_branch(&self, top: &Path) -> Option<String> {
        let gd = git_dir(top)?;
        let common = std::fs::read_to_string(gd.join("commondir"))
            .ok()
            .map(|c| {
                let p = Path::new(c.trim());
                if p.is_absolute() {
                    p.to_path_buf()
                } else {
                    gd.join(p)
                }
            })
            .unwrap_or(gd);
        let raw = std::fs::read_to_string(common.join("refs/remotes/origin/HEAD")).ok()?;
        raw.trim()
            .strip_prefix("ref: refs/remotes/origin/")
            .map(str::to_string)
    }
}

pub struct Ctx<'a> {
    pub cwd: &'a Path,
    /// The worktree top, when in a git repository.
    pub top: Option<&'a Path>,
    pub home: &'a str,
    pub git: &'a dyn GitProbe,
}

// ------------------------------------------------- irreversible actions

fn irreversible(class: &str, label: &str) -> Option<(String, String)> {
    Some((class.to_string(), label.to_string()))
}

fn is_protected_branch(name: &str, default: Option<&str>) -> bool {
    let n = name.trim_start_matches("refs/heads/");
    Some(n) == default
        || matches!(
            n,
            "main" | "master" | "trunk" | "develop" | "production" | "prod" | "stable" | "live"
        )
        || n.starts_with("release/")
        || n.starts_with("release-")
        || n.starts_with("hotfix/")
}

fn sql_destroys(lower: &str) -> bool {
    let squash: String = lower.split_whitespace().collect::<Vec<_>>().join(" ");
    [
        "drop table",
        "drop database",
        "drop schema",
        "truncate table",
        "dropdatabase(",
        "flushall",
        "flushdb",
        "migrate reset",
        "db:drop",
        "db:reset",
        "db:schema:load",
        "supabase db reset",
        "pg:reset",
        "db push --force-reset",
        "db push --accept-data-loss",
    ]
    .iter()
    .any(|n| squash.contains(n))
        || squash.split(' ').any(|w| w == "dropdb")
        // `TRUNCATE foo;` without the TABLE keyword is the same statement.
        || squash.contains("truncate ") && (squash.contains("psql") || squash.contains("mysql") || squash.contains("sqlite"))
}

/// The built-in classifier: every command here costs something no snapshot,
/// rollback or `git reflog` gives back. Returns (class, plain-language label).
///
/// Kept beside `destructive_reason` in canopy_hook.rs, not merged with it: that
/// list gates a *Build* session's every risky step ("this changes software for
/// your whole computer"); this one is the short, always-on list of things that
/// cannot be undone at all, for every session.
pub fn classify_irreversible(command: &str, ctx: &Ctx) -> Option<(String, String)> {
    let lower = command.to_ascii_lowercase();
    if sql_destroys(&lower) {
        return irreversible(
            "database",
            "deletes database data that can't be brought back",
        );
    }
    for seg in segments(command) {
        let words = strip_prefix_words(&seg);
        if words.is_empty() {
            continue;
        }
        if let Some(found) = classify_segment(words, ctx) {
            return Some(found);
        }
    }
    None
}

fn classify_segment(words: &[String], ctx: &Ctx) -> Option<(String, String)> {
    let v = verb(words);
    let args: Vec<&str> = words[1..].iter().map(String::as_str).collect();
    let has = |w: &str| args.contains(&w);
    let joined = args.join(" ").to_ascii_lowercase();
    match v {
        "rm" => {
            let recursive = words[1..]
                .iter()
                .take_while(|w| w.starts_with('-'))
                .any(|w| {
                    w == "--recursive"
                        || (!w.starts_with("--") && (w.contains('r') || w.contains('R')))
                })
                || has("--recursive");
            if !recursive {
                return None;
            }
            let boundary = ctx.top.unwrap_or(ctx.cwd);
            for target in words[1..].iter().filter(|w| !w.starts_with('-')) {
                // A glob deletes its parent's contents: `rm -rf *` at the top
                // level is the repository itself.
                let (word, globbed) = match target.find(['*', '?', '[']) {
                    Some(i) => {
                        let parent = target[..i].rsplit_once('/').map(|(p, _)| p).unwrap_or("");
                        (
                            if parent.is_empty() {
                                ".".to_string()
                            } else {
                                parent.to_string()
                            },
                            true,
                        )
                    }
                    None => (target.clone(), false),
                };
                let Some(path) = resolve(&word, ctx.cwd, ctx.home) else {
                    continue;
                };
                let home = Path::new(ctx.home);
                let is_root = path.parent().is_none();
                let outside = !path.starts_with(boundary);
                let is_boundary = path == boundary || boundary.starts_with(&path);
                if is_root || path == home || is_boundary || outside {
                    let label = if is_root || path == home {
                        "deletes everything under a top-level folder for good"
                    } else if is_boundary && !outside {
                        "deletes the whole project folder for good"
                    } else {
                        "deletes files outside this project for good"
                    };
                    let _ = globbed;
                    return irreversible("delete-files", label);
                }
            }
            None
        }
        "git" => classify_git(words, ctx),
        "terraform" | "tofu" | "terragrunt" => {
            if has("destroy") || (has("apply") && (has("-destroy") || has("--destroy"))) {
                return irreversible("infra-destroy", "tears down live infrastructure");
            }
            None
        }
        "pulumi" | "cdk" | "cdktf" | "sst" | "serverless" | "sls"
            if has("destroy") || has("remove") =>
        {
            irreversible("infra-destroy", "tears down live infrastructure")
        }
        "eksctl" if has("delete") => {
            irreversible("infra-destroy", "tears down live infrastructure")
        }
        "aws" => {
            if joined.starts_with("s3 rb") || (joined.starts_with("s3 rm") && has("--recursive")) {
                return irreversible(
                    "delete-storage",
                    "deletes a storage bucket or everything in it",
                );
            }
            if joined.contains("cloudformation delete-stack")
                || joined.contains("delete-db-instance")
                || joined.contains("delete-db-cluster")
                || joined.contains("dynamodb delete-table")
                || joined.contains("delete-bucket")
                || joined.contains("efs delete-file-system")
                || joined.contains("ec2 delete-volume")
            {
                return irreversible(
                    "delete-storage",
                    "deletes live cloud resources and their data",
                );
            }
            None
        }
        "gsutil" => {
            if has("rb") || (has("rm") && (has("-r") || has("-R") || has("-rf"))) {
                return irreversible(
                    "delete-storage",
                    "deletes a storage bucket or everything in it",
                );
            }
            None
        }
        "gcloud" => {
            if (joined.contains("storage rm") && (has("-r") || has("--recursive")))
                || joined.contains("buckets delete")
                || joined.contains("sql instances delete")
                || joined.contains("projects delete")
                || joined.contains("container clusters delete")
            {
                return irreversible(
                    "delete-storage",
                    "deletes live cloud resources and their data",
                );
            }
            if joined.starts_with("app deploy") || joined.starts_with("run deploy") {
                return irreversible("deploy", "deploys to production");
            }
            None
        }
        "az" if joined.starts_with("group delete")
            || joined.contains("storage container delete")
            || joined.contains("storage account delete") =>
        {
            irreversible(
                "delete-storage",
                "deletes live cloud resources and their data",
            )
        }
        "docker" | "podman" => {
            if joined.starts_with("volume rm") || joined.starts_with("volume prune") {
                return irreversible(
                    "delete-storage",
                    "deletes container volumes and the data in them",
                );
            }
            if joined.starts_with("system prune") && has("--volumes") {
                return irreversible(
                    "delete-storage",
                    "deletes container volumes and the data in them",
                );
            }
            if (joined.starts_with("compose down") || joined.starts_with("-compose down"))
                && (has("-v") || has("--volumes"))
            {
                return irreversible(
                    "delete-storage",
                    "deletes container volumes and the data in them",
                );
            }
            None
        }
        "docker-compose" if has("down") && (has("-v") || has("--volumes")) => irreversible(
            "delete-storage",
            "deletes container volumes and the data in them",
        ),
        "kubectl" | "oc" => {
            if has("delete") {
                let kinds = [
                    "ns",
                    "namespace",
                    "namespaces",
                    "pvc",
                    "pv",
                    "persistentvolumeclaim",
                    "persistentvolume",
                ];
                if args.iter().any(|a| {
                    let k = a.split('/').next().unwrap_or(a);
                    kinds.contains(&k)
                }) || has("--all")
                    || has("--all-namespaces")
                {
                    return irreversible(
                        "delete-storage",
                        "deletes a whole cluster namespace or its stored data",
                    );
                }
            }
            if (has("apply") || has("rollout") || has("set")) && joined.contains("prod") {
                return irreversible("deploy", "changes what is running in production");
            }
            None
        }
        "helm" if (has("uninstall") || has("delete")) && joined.contains("prod") => {
            irreversible("deploy", "removes a production release")
        }
        "fly" | "flyctl" => {
            if joined.contains("apps destroy")
                || joined.contains("volumes destroy")
                || joined.contains("volumes delete")
            {
                return irreversible("delete-storage", "deletes a live app or its volume");
            }
            if has("deploy") {
                return irreversible("deploy", "deploys to production");
            }
            None
        }
        "heroku" => {
            if joined.contains("apps:destroy") || joined.contains("pg:reset") {
                return irreversible("delete-storage", "deletes a live app or its database");
            }
            if joined.contains("releases:rollback") || joined.contains("container:release") {
                return irreversible("deploy", "changes what is running in production");
            }
            None
        }
        "vercel" | "netlify"
            if has("--prod") || has("--production") || joined.contains("--prod=true") =>
        {
            irreversible("deploy", "deploys to production")
        }
        "firebase" if has("deploy") => irreversible("deploy", "deploys to production"),
        "wrangler"
            if (has("deploy") || has("publish"))
                && !has("--dry-run")
                && !joined.contains("--env staging")
                && !joined.contains("--env dev") =>
        {
            irreversible("deploy", "deploys to production")
        }
        "eb" if has("deploy") || has("terminate") => {
            irreversible("deploy", "deploys to production")
        }
        "railway" if has("up") || has("down") => irreversible("deploy", "deploys to production"),
        "stripe" => {
            let money = [
                "charges",
                "payouts",
                "refunds",
                "transfers",
                "payment_intents",
                "topups",
                "invoices",
                "subscriptions",
                "transfer_reversals",
                "application_fees",
            ];
            let act = [
                "create",
                "confirm",
                "capture",
                "pay",
                "cancel",
                "update",
                "finalize_invoice",
                "send_invoice",
            ];
            if args.iter().any(|a| money.contains(a)) && args.iter().any(|a| act.contains(a)) {
                return irreversible("money", "moves real money");
            }
            None
        }
        "cast" if has("send") => irreversible("money", "moves real money"),
        "solana" if has("transfer") || has("pay") => irreversible("money", "moves real money"),
        "bitcoin-cli" if args.iter().any(|a| a.starts_with("send")) => {
            irreversible("money", "moves real money")
        }
        "curl" | "http" | "https" | "wget" => {
            let money_api = [
                "api.stripe.com",
                "api.paypal.com",
                "api-m.paypal.com",
                "api.wise.com",
                "api.transferwise.com",
                "connect.squareup.com",
                "api.plaid.com/transfer",
                "api.adyen.com",
                "api.braintreegateway.com",
            ];
            if money_api.iter().any(|h| joined.contains(h)) && is_outbound_write(words) {
                return irreversible("money", "moves real money");
            }
            None
        }
        _ => {
            // A generic deploy: a deploy verb aimed at production, through any
            // wrapper (`npm run deploy -- --prod`, `make deploy-prod`, `sls
            // deploy --stage production`).
            let all: Vec<String> = words.iter().map(|w| w.to_ascii_lowercase()).collect();
            let deploys = all.iter().any(|w| w.contains("deploy") || w == "release");
            let prod = all.iter().any(|w| {
                w == "prod"
                    || w == "production"
                    || w.ends_with(":prod")
                    || w.ends_with("-prod")
                    || w.ends_with("=prod")
                    || w.ends_with("=production")
                    || w == "--prod"
                    || w == "--production"
            });
            if deploys && prod {
                return irreversible("deploy", "deploys to production");
            }
            None
        }
    }
}

fn classify_git(words: &[String], ctx: &Ctx) -> Option<(String, String)> {
    // Skip global options (`git -C dir push`, `git -c k=v push`).
    let mut i = 1;
    while i < words.len() && words[i].starts_with('-') {
        if matches!(words[i].as_str(), "-C" | "-c" | "--git-dir" | "--work-tree") {
            i += 1;
        }
        i += 1;
    }
    let sub = words.get(i).map(String::as_str).unwrap_or("");
    let rest = &words[(i + 1).min(words.len())..];
    match sub {
        "push" => {
            let force = rest.iter().any(|w| {
                w == "--force"
                    || w.starts_with("--force-with-lease")
                    || w == "--force-if-includes"
                    || (w.starts_with('-') && !w.starts_with("--") && w.contains('f'))
            });
            let positional: Vec<&String> = rest.iter().filter(|w| !w.starts_with('-')).collect();
            let plus = positional.iter().skip(1).any(|r| r.starts_with('+'));
            if !force && !plus {
                return None;
            }
            if rest.iter().any(|w| w == "--all" || w == "--mirror") {
                return irreversible(
                    "force-push",
                    "overwrites shared history on a protected branch",
                );
            }
            let top = ctx.top?;
            let default = ctx.git.default_branch(top);
            let mut targets: Vec<String> = positional
                .iter()
                .skip(1)
                .filter(|r| force || r.starts_with('+'))
                .map(|r| {
                    let r = r.trim_start_matches('+');
                    r.rsplit_once(':').map(|(_, d)| d).unwrap_or(r).to_string()
                })
                .collect();
            if targets.is_empty() || targets.iter().any(|t| t == "HEAD") {
                targets.retain(|t| t != "HEAD");
                if let Some(b) = ctx.git.current_branch(top) {
                    targets.push(b);
                } else {
                    // Detached or unreadable: we cannot say it isn't protected.
                    return irreversible(
                        "force-push",
                        "overwrites shared history on a protected branch",
                    );
                }
            }
            if targets
                .iter()
                .any(|t| is_protected_branch(t, default.as_deref()))
            {
                return irreversible(
                    "force-push",
                    "overwrites shared history on a protected branch",
                );
            }
            None
        }
        "reset" if rest.iter().any(|w| w == "--hard") => {
            let top = ctx.top.unwrap_or(ctx.cwd);
            let (tracked, _) = ctx.git.dirty(top);
            tracked.then(|| {
                (
                    "discard-work".to_string(),
                    "throws away uncommitted work that was never saved anywhere".to_string(),
                )
            })
        }
        "clean"
            if rest
                .iter()
                .any(|w| w.starts_with('-') && !w.starts_with("--") && w.contains('f'))
                || rest.iter().any(|w| w == "--force") =>
        {
            if rest.iter().any(|w| w == "-n" || w == "--dry-run") {
                return None;
            }
            let top = ctx.top.unwrap_or(ctx.cwd);
            let (_, untracked) = ctx.git.dirty(top);
            untracked.then(|| {
                (
                    "discard-work".to_string(),
                    "deletes new files git has never saved".to_string(),
                )
            })
        }
        _ => None,
    }
}

/// Opt-in classes for `require-confirm`.
fn confirm_class_matches(class: &str, command: &str, ctx: &Ctx) -> bool {
    if let Some((c, _)) = classify_irreversible(command, ctx) {
        if c == class {
            return true;
        }
    }
    segments(command).iter().any(|seg| {
        let words = strip_prefix_words(seg);
        let v = verb(words);
        let args: Vec<&str> = words.iter().skip(1).map(String::as_str).collect();
        let joined = args.join(" ");
        match class {
            "publish" => {
                (matches!(
                    v,
                    "npm" | "pnpm" | "yarn" | "cargo" | "gem" | "twine" | "poetry" | "flit" | "uv"
                ) && args.contains(&"publish"))
                    || (v == "twine" && args.contains(&"upload"))
                    || (v == "gh" && joined.starts_with("release create"))
            }
            "migrate" => {
                let all = words.join(" ").to_ascii_lowercase();
                all.contains("migrate")
                    || all.contains("db:migrate")
                    || (v == "alembic" && args.contains(&"upgrade"))
            }
            "install" => install_targets(words).is_some(),
            "push" => v == "git" && args.contains(&"push"),
            "deploy-any" => words
                .iter()
                .any(|w| w.to_ascii_lowercase().contains("deploy")),
            "network-write" => is_outbound_write(words),
            _ => false,
        }
    })
}

// ----------------------------------------------------- packages & egress

/// The package names a shell segment would install, or None if it installs
/// nothing. A bare `npm install` (restore the lockfile) adds nothing new.
pub fn install_targets(words: &[String]) -> Option<Vec<String>> {
    let v = verb(words);
    let args: Vec<&str> = words.iter().skip(1).map(String::as_str).collect();
    let first = args.iter().position(|a| !a.starts_with('-'))?;
    let sub = args[first];
    let after = &args[first + 1..];
    let installs = match v {
        "npm" | "pnpm" => matches!(sub, "install" | "i" | "add" | "in" | "isntall"),
        "yarn" | "bun" => sub == "add" || (v == "bun" && sub == "install"),
        "pip" | "pip3" | "pipx" => sub == "install",
        "uv" => sub == "add" || (sub == "pip" && after.first() == Some(&"install")),
        "poetry" | "pdm" | "rye" => sub == "add",
        "cargo" => sub == "add" || sub == "install",
        "go" => sub == "get" || sub == "install",
        "gem" => sub == "install",
        "composer" => sub == "require",
        "dotnet" => sub == "add",
        "brew" => sub == "install",
        _ => false,
    };
    if !installs {
        return None;
    }
    let skip_pip = usize::from(v == "uv" && sub == "pip");
    let names: Vec<String> = after
        .iter()
        .skip(skip_pip)
        .filter(|a| !a.starts_with('-') && **a != "package")
        .filter(|a| !a.starts_with('.') && !a.starts_with('/') && !a.ends_with(".txt"))
        .map(|a| package_name(a))
        .filter(|n| !n.is_empty())
        .collect();
    if names.is_empty() {
        return None;
    }
    Some(names)
}

/// `lodash@4` → lodash, `@scope/pkg@1` → @scope/pkg, `requests==2.0` →
/// requests, `github.com/x/y@v1` → github.com/x/y. Lowercased: registries
/// treat names case-insensitively often enough that a denylist must.
pub fn package_name(spec: &str) -> String {
    let s = spec.trim();
    let s = if let Some(rest) = s.strip_prefix('@') {
        match rest.find('@') {
            Some(i) => &s[..i + 1],
            None => s,
        }
    } else {
        s.split('@').next().unwrap_or(s)
    };
    let s = s
        .split(['=', '<', '>', '~', '!', '[', ';', ' '])
        .next()
        .unwrap_or(s);
    s.to_ascii_lowercase()
}

/// Whether a shell segment sends data out (the "outbound write" leg).
pub fn is_outbound_write(words: &[String]) -> bool {
    let v = verb(words);
    let args: Vec<&str> = words.iter().skip(1).map(String::as_str).collect();
    let joined = args.join(" ");
    match v {
        "curl" => {
            args.iter().enumerate().any(|(i, a)| {
                matches!(*a, "-X" | "--request")
                    && args.get(i + 1).is_some_and(|m| {
                        !m.eq_ignore_ascii_case("get") && !m.eq_ignore_ascii_case("head")
                    })
            }) || args.iter().any(|a| {
                a.starts_with("-XPOST")
                    || a.starts_with("-XPUT")
                    || a.starts_with("-XPATCH")
                    || a.starts_with("-XDELETE")
                    || matches!(
                        *a,
                        "-d" | "--data"
                            | "--data-raw"
                            | "--data-binary"
                            | "--data-urlencode"
                            | "-F"
                            | "--form"
                            | "-T"
                            | "--upload-file"
                            | "--json"
                    )
                    || a.starts_with("--data")
            })
        }
        "wget" => args
            .iter()
            .any(|a| a.starts_with("--post") || a.starts_with("--method")),
        "http" | "https" | "xh" => args.first().is_some_and(|m| {
            matches!(
                m.to_ascii_uppercase().as_str(),
                "POST" | "PUT" | "PATCH" | "DELETE"
            )
        }),
        "git" => args.contains(&"push"),
        "gh" => {
            let writes = [
                "pr create",
                "pr merge",
                "pr comment",
                "pr review",
                "pr close",
                "pr edit",
                "issue create",
                "issue comment",
                "issue close",
                "issue edit",
                "release create",
                "release upload",
                "repo create",
                "repo delete",
                "repo edit",
                "gist create",
                "secret set",
                "variable set",
                "workflow run",
                "label create",
            ];
            writes.iter().any(|w| joined.starts_with(w))
                || (args.first() == Some(&"api")
                    && args.iter().enumerate().any(|(i, a)| {
                        matches!(*a, "-f" | "-F" | "--field" | "--raw-field" | "--input")
                            || (matches!(*a, "-X" | "--method")
                                && args
                                    .get(i + 1)
                                    .is_some_and(|m| !m.eq_ignore_ascii_case("get")))
                    }))
        }
        "scp" | "rsync" | "sftp" => args.iter().any(|a| a.contains(':') && !a.starts_with('-')),
        "nc" | "ncat" | "netcat" | "telnet" => true,
        _ => false,
    }
}

fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://").map(|(_, r)| r)?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?;
    let host = if host.starts_with('[') {
        host.split(']').next()?.trim_start_matches('[')
    } else {
        host.split(':').next()?
    };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

fn host_allowed(host: &str, allow: &[String]) -> bool {
    let local = matches!(host, "localhost" | "127.0.0.1" | "::1" | "0.0.0.0")
        || host.ends_with(".localhost");
    local
        || allow.iter().any(|a| {
            let a = a.trim().to_ascii_lowercase();
            if let Some(suffix) = a.strip_prefix("*.") {
                host == suffix || host.ends_with(&format!(".{suffix}"))
            } else {
                host == a
            }
        })
}

/// URLs a shell segment reaches with a network client.
fn shell_urls(words: &[String]) -> Vec<String> {
    let v = verb(words);
    if !matches!(v, "curl" | "wget" | "http" | "https" | "xh" | "aria2c") {
        return vec![];
    }
    words
        .iter()
        .skip(1)
        .filter(|w| !w.starts_with('-'))
        .map(|w| {
            if w.contains("://") {
                w.clone()
            } else {
                format!("https://{w}")
            }
        })
        .filter(|w| host_of(w).is_some_and(|h| h.contains('.') || h == "localhost"))
        .collect()
}

// ---------------------------------------------------------- secrets

/// Files whose contents are credentials. Name-based on purpose: the trifecta
/// gate runs before the read, so it cannot look inside.
pub fn is_secret_path(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let p = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    (name == ".env"
        || (name.starts_with(".env.")
            && !name.ends_with(".example")
            && !name.ends_with(".sample")
            && !name.ends_with(".template")))
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || name.ends_with(".p12")
        || name.ends_with(".pfx")
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
        || name.starts_with("id_ecdsa")
        || name == ".npmrc"
        || name == ".pypirc"
        || name == ".netrc"
        || name == "credentials"
        || name == "secrets.json"
        || name == "secrets.yaml"
        || name == "secrets.yml"
        || p.contains("/.aws/")
        || p.contains("/.ssh/")
        || p.contains("/.config/gh/hosts")
        || p.contains("/.docker/config.json")
        || p.contains("/.kube/config")
}

fn reads_secret_in_shell(words: &[String], cwd: &Path, home: &str) -> bool {
    let v = verb(words);
    if matches!(v, "printenv" | "env" | "set" | "export") && words.len() == 1 {
        return true;
    }
    if v == "security"
        && words
            .iter()
            .any(|w| w.starts_with("find-") && w.contains("password"))
    {
        return true;
    }
    words
        .iter()
        .skip(1)
        .filter(|w| !w.starts_with('-'))
        .any(|w| resolve(w, cwd, home).is_some_and(|p| is_secret_path(&p)))
}

const VAULT_TOOLS: &[&str] = &["canopy_vault_fill", "canopy_vault_read"];

pub fn is_vault_tool(tool: &str) -> bool {
    VAULT_TOOLS
        .iter()
        .any(|t| tool == *t || tool.ends_with(&format!("__{t}")))
}

// ---------------------------------------------------------- evaluation

fn rule_finding(g: &PolicyGate, label: String) -> Finding {
    Finding {
        kind: FindingKind::Rule,
        rule_id: Some(g.id.clone()),
        rule_text: Some(g.rule.clone()),
        class: gate_type(&g.gate).to_string(),
        label,
    }
}

pub fn gate_type(g: &Gate) -> &'static str {
    match g {
        Gate::DenyPathWrite { .. } => "deny-path-write",
        Gate::DenyCommand { .. } => "deny-command",
        Gate::RequireConfirm { .. } => "require-confirm",
        Gate::ProtectTests { .. } => "protect-tests",
        Gate::PackageAllowlist { .. } => "package-allowlist",
        Gate::PackageDenylist { .. } => "package-denylist",
        Gate::EgressAllowlist { .. } => "egress-allowlist",
        Gate::Unenforceable { .. } => "unenforceable",
    }
}

fn compile_patterns(patterns: &[String]) -> Vec<regex::Regex> {
    patterns
        .iter()
        .filter_map(|p| {
            regex::RegexBuilder::new(p)
                .case_insensitive(true)
                .size_limit(1 << 20)
                .build()
                .ok()
        })
        .collect()
}

/// Paths a shell command would write or delete: the arguments of the usual
/// writers plus redirection targets. Best effort by design (see `segments`).
fn shell_write_targets(command: &str, cwd: &Path, home: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    // Redirections: `> file`, `>> file`, `>file`.
    let mut rest = command;
    while let Some(i) = rest.find('>') {
        let after = rest[i + 1..].trim_start_matches('>').trim_start();
        let target: String = after
            .chars()
            .take_while(|c| !c.is_whitespace() && !matches!(c, ';' | '|' | '&' | ')'))
            .collect();
        let target = target.trim_matches(['"', '\'']);
        if !target.is_empty() && !target.starts_with('&') && target != "/dev/null" {
            if let Some(p) = resolve(target, cwd, home) {
                out.push(p);
            }
        }
        rest = &rest[i + 1..];
    }
    for seg in segments(command) {
        let words = strip_prefix_words(&seg);
        let v = verb(words);
        let writer = matches!(
            v,
            "rm" | "rmdir"
                | "mv"
                | "cp"
                | "tee"
                | "touch"
                | "truncate"
                | "shred"
                | "unlink"
                | "ln"
                | "install"
                | "dd"
                | "chmod"
                | "chown"
        ) || (v == "sed"
            && words
                .iter()
                .any(|w| w == "-i" || w.starts_with("-i") || w == "--in-place"))
            || (v == "perl" && words.iter().any(|w| w.starts_with("-pi") || w == "-i"))
            || (v == "git"
                && words
                    .iter()
                    .skip(1)
                    .find(|w| !w.starts_with('-'))
                    .is_some_and(|s| matches!(s.as_str(), "rm" | "mv" | "checkout" | "restore")));
        if !writer {
            continue;
        }
        for w in words.iter().skip(1).filter(|w| !w.starts_with('-')) {
            let w = w.strip_prefix("of=").unwrap_or(w);
            if let Some(p) = resolve(w, cwd, home) {
                out.push(p);
            }
        }
    }
    out
}

/// Evaluate one action against the built-ins and the approved gates. Pure apart
/// from the git probe; the hook decides what to print from the result.
pub fn evaluate(
    policy: Option<&Policy>,
    action: &Action,
    ctx: &Ctx,
    tainted: Option<&str>,
) -> Vec<Finding> {
    let mut findings = Vec::new();
    let policy_root = policy_dir(ctx.home);
    let shell_writes = action
        .command
        .as_deref()
        .map(|c| shell_write_targets(c, ctx.cwd, ctx.home))
        .unwrap_or_default();
    let all_writes: Vec<&PathBuf> = action.writes.iter().chain(shell_writes.iter()).collect();

    // Self-protection: the policy and its approvals are the person's, not the
    // agent's. Without this an agent could mint its own "approve once".
    let touches_policy = all_writes.iter().any(|p| p.starts_with(&policy_root))
        || action
            .command
            .as_deref()
            .is_some_and(|c| c.contains(".canopy/policy") || c.contains("CANOPY_POLICY_HOME"));
    if touches_policy {
        findings.push(Finding {
            kind: FindingKind::SelfProtect,
            rule_id: None,
            rule_text: None,
            class: "policy".into(),
            label: "changes Canopy's own rule files".into(),
        });
        return findings;
    }

    let top = ctx.top.unwrap_or(ctx.cwd);
    let rel_writes: Vec<String> = all_writes
        .iter()
        .filter_map(|p| relative_to(p, top))
        .collect();
    let segs = action.command.as_deref().map(segments).unwrap_or_default();

    if let Some(policy) = policy {
        for g in &policy.gates {
            match &g.gate {
                Gate::DenyPathWrite { globs, .. } | Gate::ProtectTests { globs } => {
                    let defaults: Vec<String>;
                    let globs = if globs.is_empty() && matches!(g.gate, Gate::ProtectTests { .. }) {
                        defaults = DEFAULT_TEST_GLOBS.iter().map(|s| s.to_string()).collect();
                        &defaults
                    } else {
                        globs
                    };
                    let Some(set) = glob_set(globs) else { continue };
                    let except: &[String] = match &g.gate {
                        Gate::DenyPathWrite { except_files, .. } => except_files,
                        _ => &[],
                    };
                    if let Some(hit) = rel_writes
                        .iter()
                        .find(|r| set.is_match(r.as_str()) && !except.iter().any(|e| e == *r))
                    {
                        let what = if matches!(g.gate, Gate::ProtectTests { .. }) {
                            "changes a test file"
                        } else {
                            "changes a protected file"
                        };
                        findings.push(rule_finding(g, format!("{what} ({hit})")));
                    }
                }
                Gate::DenyCommand { patterns } => {
                    let Some(cmd) = action.command.as_deref() else {
                        continue;
                    };
                    let res = compile_patterns(patterns);
                    // Each simple command and the whole line: a pattern for
                    // `git push --force` must match inside `a && git push --force`.
                    let hit = res.iter().any(|re| {
                        re.is_match(cmd)
                            || segs
                                .iter()
                                .any(|s| re.is_match(&strip_prefix_words(s).join(" ")))
                    });
                    if hit {
                        findings.push(rule_finding(g, "runs a command the rule forbids".into()));
                    }
                }
                Gate::RequireConfirm { class, patterns } => {
                    let Some(cmd) = action.command.as_deref() else {
                        continue;
                    };
                    let by_class = class
                        .as_deref()
                        .is_some_and(|c| confirm_class_matches(c, cmd, ctx));
                    let by_pattern = compile_patterns(patterns).iter().any(|re| re.is_match(cmd));
                    if by_class || by_pattern {
                        findings.push(Finding {
                            kind: FindingKind::Irreversible,
                            rule_id: Some(g.id.clone()),
                            rule_text: Some(g.rule.clone()),
                            class: class.clone().unwrap_or_else(|| "require-confirm".into()),
                            label: "needs a person's OK under your team's rules".into(),
                        });
                    }
                }
                Gate::PackageAllowlist { names } | Gate::PackageDenylist { names } => {
                    let allow = matches!(g.gate, Gate::PackageAllowlist { .. });
                    let listed: Vec<String> = names.iter().map(|n| package_name(n)).collect();
                    for seg in &segs {
                        let Some(pkgs) = install_targets(strip_prefix_words(seg)) else {
                            continue;
                        };
                        let bad: Vec<&String> = pkgs
                            .iter()
                            .filter(|p| {
                                if allow {
                                    !listed.contains(p)
                                } else {
                                    listed.contains(p)
                                }
                            })
                            .collect();
                        if let Some(first) = bad.first() {
                            let label = if allow {
                                format!(
                                    "installs {first}, which isn't on the approved package list"
                                )
                            } else {
                                format!("installs {first}, which is on the banned package list")
                            };
                            findings.push(rule_finding(g, label));
                            break;
                        }
                    }
                }
                Gate::EgressAllowlist { hosts } => {
                    let mut urls: Vec<String> = segs
                        .iter()
                        .flat_map(|s| shell_urls(strip_prefix_words(s)))
                        .collect();
                    if let Some(u) = &action.url {
                        urls.push(u.clone());
                    }
                    if let Some(host) = urls
                        .iter()
                        .filter_map(|u| host_of(u))
                        .find(|h| !host_allowed(h, hosts))
                    {
                        findings.push(rule_finding(
                            g,
                            format!("contacts {host}, which isn't on the allowed list"),
                        ));
                    }
                }
                Gate::Unenforceable { .. } => {}
            }
        }
    }

    // Built-in irreversible classification — always on, policy or not.
    if let Some(cmd) = action.command.as_deref() {
        if let Some((class, label)) = classify_irreversible(cmd, ctx) {
            findings.push(Finding {
                kind: FindingKind::Irreversible,
                rule_id: None,
                rule_text: None,
                class,
                label,
            });
        }
    }

    // Trifecta: this session already read content a stranger controls.
    if let Some(source) = tainted {
        let secret = action.reads.iter().any(|p| is_secret_path(p))
            || is_vault_tool(&action.tool)
            || segs
                .iter()
                .any(|s| reads_secret_in_shell(strip_prefix_words(s), ctx.cwd, ctx.home));
        let outbound = segs
            .iter()
            .any(|s| is_outbound_write(strip_prefix_words(s)));
        if secret || outbound {
            let what = if secret {
                "reads secrets"
            } else {
                "sends data out of this computer"
            };
            findings.push(Finding {
                kind: FindingKind::Trifecta,
                rule_id: None,
                rule_text: None,
                class: if secret {
                    "secret-read".into()
                } else {
                    "outbound-write".into()
                },
                label: format!("{what} after this session read untrusted content ({source})"),
            });
        }
    }
    findings
}

/// The words the agent reads when it is stopped. It has to say which rule,
/// what about this call broke it, and what to do instead — an agent told only
/// "denied" retries the same thing a different way.
pub fn agent_reason(findings: &[Finding], outcome: Outcome) -> String {
    let first = findings
        .iter()
        .find(|f| match outcome {
            Outcome::Refused => f.kind == FindingKind::SelfProtect,
            Outcome::Blocked => matches!(f.kind, FindingKind::Rule | FindingKind::Trifecta),
            Outcome::NeedsApproval => f.kind == FindingKind::Irreversible,
            _ => true,
        })
        .or_else(|| findings.first());
    let Some(f) = first else {
        return String::new();
    };
    match outcome {
        Outcome::Refused => format!(
            "Blocked by Canopy: this {}. Rule and approval files belong to the person; ask them to change a rule in Canopy's Rules panel.",
            f.label
        ),
        Outcome::Blocked if f.kind == FindingKind::Trifecta => format!(
            "Blocked by Canopy's untrusted-content rule: this {}. Content from the web can carry instructions that aren't the person's, so for the rest of this session secrets and outbound writes are off. Finish without it, or tell the person what you need — they can allow it once in Canopy.",
            f.label
        ),
        Outcome::Blocked => format!(
            "Blocked by team rule '{}': this {}. Don't work around the rule; if the task really needs it, tell the person — they can allow it once or edit the rule in Canopy.",
            f.rule_text.as_deref().unwrap_or("(unnamed)"),
            f.label
        ),
        Outcome::NeedsApproval => {
            let why = match &f.rule_text {
                Some(rule) => format!("team rule '{rule}' says this {}", f.label),
                None => format!("this {}, which can't be undone", f.label),
            };
            format!(
                "Canopy paused this: {why}. The person has been asked in Canopy to approve it. Stop here and wait for them. If they approve, run exactly the same command again — it is then allowed once, for 10 minutes. Do not try a different way to do the same thing."
            )
        }
        _ => String::new(),
    }
}

// --------------------------------------------------- ledger, hook side

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Append one `rule` entry to the ledger file for `canonical`, in exactly the
/// shape ledger.rs writes (its tests read one of these back). The hook cannot
/// link ledger.rs — that module emits Tauri events — so this is the same
/// single-`write_all` O_APPEND line, without the emit. The app picks it up on
/// its next query; the bus event carries the live notification.
pub fn append_ledger(
    home: &str,
    canonical: &str,
    mut entry: serde_json::Value,
) -> Result<String, String> {
    use std::io::Write;
    let ts = now_ms();
    let mut bytes = [0u8; 6];
    let _ = getrandom::getrandom(&mut bytes);
    let id = format!(
        "{ts:013}-{}{:04x}",
        hex::encode(bytes),
        std::process::id() & 0xffff
    );
    entry["id"] = serde_json::json!(id);
    entry["ts"] = serde_json::json!(ts);
    entry["root"] = serde_json::json!(canonical);
    let mut line = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
    if line.len() > 256 * 1024 {
        return Err("ledger entry too large".into());
    }
    line.push('\n');
    let dir = ledger_dir(home);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("{}.jsonl", root_hash(canonical))))
        .map_err(|e| e.to_string())?;
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    Ok(id)
}

/// The session-start reminder: guidance rules, and a one-line note that the
/// enforced ones are enforced. Short by construction — this is what replaces a
/// growing instruction file, not another one.
pub fn session_context(policy: &Policy) -> Option<String> {
    if policy.guidance.is_empty() && policy.gates.is_empty() {
        return None;
    }
    let mut out = String::from("Team rules for this project (from Canopy's Rules panel):\n");
    for g in policy.guidance.iter().take(20) {
        out.push_str(&format!("- {}\n", g.trim()));
    }
    for g in policy.gates.iter().take(20) {
        out.push_str(&format!(
            "- {} (enforced: Canopy blocks violations)\n",
            g.rule.trim()
        ));
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeGit {
        tracked: bool,
        untracked: bool,
        branch: Option<&'static str>,
        default: Option<&'static str>,
    }
    impl GitProbe for FakeGit {
        fn dirty(&self, _: &Path) -> (bool, bool) {
            (self.tracked, self.untracked)
        }
        fn current_branch(&self, _: &Path) -> Option<String> {
            self.branch.map(str::to_string)
        }
        fn default_branch(&self, _: &Path) -> Option<String> {
            self.default.map(str::to_string)
        }
    }
    const CLEAN: FakeGit = FakeGit {
        tracked: false,
        untracked: false,
        branch: Some("feature"),
        default: Some("main"),
    };
    const DIRTY: FakeGit = FakeGit {
        tracked: true,
        untracked: true,
        branch: Some("main"),
        default: Some("main"),
    };

    fn ctx<'a>(git: &'a dyn GitProbe) -> Ctx<'a> {
        Ctx {
            cwd: Path::new("/home/u/repo/src"),
            top: Some(Path::new("/home/u/repo")),
            home: "/home/u",
            git,
        }
    }

    fn class(cmd: &str, git: &dyn GitProbe) -> Option<String> {
        classify_irreversible(cmd, &ctx(git)).map(|(c, _)| c)
    }

    #[test]
    fn irreversible_positives() {
        let cases: &[(&str, &str)] = &[
            ("psql -c 'DROP TABLE users'", "database"),
            ("echo 'drop   database prod;' | mysql", "database"),
            ("sqlite3 app.db \"TRUNCATE TABLE logs\"", "database"),
            ("npx prisma migrate reset --force", "database"),
            ("bin/rails db:drop", "database"),
            ("dropdb myapp", "database"),
            ("redis-cli FLUSHALL", "database"),
            ("rm -rf /", "delete-files"),
            ("rm -rf ~", "delete-files"),
            ("rm -rf $HOME/projects", "delete-files"),
            ("sudo rm -rf /var/lib/postgres", "delete-files"),
            ("rm -rf ..", "delete-files"),
            ("cd /tmp && rm -fr ../../home/u/repo", "delete-files"),
            ("rm -r -f /home/u/repo", "delete-files"),
            ("rm -rf ../*", "delete-files"),
            ("git push -f origin main", "force-push"),
            (
                "git push --force-with-lease origin HEAD:master",
                "force-push",
            ),
            ("git push origin +main", "force-push"),
            ("git push --force origin release/2.0", "force-push"),
            ("git -C . push --force --all", "force-push"),
            ("aws s3 rb s3://bucket --force", "delete-storage"),
            ("aws s3 rm s3://bucket/ --recursive", "delete-storage"),
            ("docker volume rm pgdata", "delete-storage"),
            ("docker system prune -a --volumes", "delete-storage"),
            ("docker compose down -v", "delete-storage"),
            ("kubectl delete ns staging", "delete-storage"),
            ("kubectl delete namespace/prod", "delete-storage"),
            ("gsutil rm -r gs://b", "delete-storage"),
            ("terraform destroy -auto-approve", "infra-destroy"),
            ("terraform apply -destroy", "infra-destroy"),
            ("pulumi destroy --yes", "infra-destroy"),
            ("vercel --prod", "deploy"),
            ("netlify deploy --prod", "deploy"),
            ("fly deploy", "deploy"),
            ("firebase deploy --only hosting", "deploy"),
            ("npm run deploy -- --prod", "deploy"),
            ("make deploy-prod", "deploy"),
            ("sls deploy --stage production", "deploy"),
            ("kubectl apply -f k8s/ --context prod-cluster", "deploy"),
            ("stripe refunds create --charge ch_1", "money"),
            ("stripe payouts create --amount 1000", "money"),
            (
                "curl https://api.stripe.com/v1/transfers -u sk_x: -d amount=100",
                "money",
            ),
            ("cast send 0xabc --value 1ether", "money"),
        ];
        for (cmd, want) in cases {
            assert_eq!(class(cmd, &CLEAN).as_deref(), Some(*want), "{cmd}");
        }
    }

    #[test]
    fn irreversible_negatives() {
        let cases = [
            "rm -rf node_modules",
            "rm -rf ./build dist",
            "rm -rf /home/u/repo/target",
            "rm file.txt",
            "rm -f /tmp/x",
            "rm -rf build/*",
            "rm -rf \"$TMPDIR/cache\"",
            "git push",
            "git push origin feature",
            "git push --force origin feature/x",
            "git push -u origin my-branch",
            "git reset --hard",
            "git reset --soft HEAD~1",
            "git status",
            "git clean -n",
            "docker volume ls",
            "docker compose down",
            "kubectl get ns",
            "kubectl delete pod web-123",
            "terraform plan",
            "terraform apply",
            "vercel",
            "netlify deploy",
            "npm run deploy:staging",
            "stripe listen --forward-to localhost:3000",
            "stripe customers list",
            "curl https://api.stripe.com/v1/charges",
            "echo dropped table count",
            "grep -r 'drop' src",
            "ls -la",
            "cargo test",
        ];
        for cmd in cases {
            assert_eq!(class(cmd, &CLEAN), None, "{cmd}");
        }
    }

    #[test]
    fn reset_hard_needs_uncommitted_work() {
        assert_eq!(class("git reset --hard HEAD~3", &CLEAN), None);
        assert_eq!(
            class("git reset --hard HEAD~3", &DIRTY).as_deref(),
            Some("discard-work")
        );
        assert_eq!(
            class("git clean -fdx", &DIRTY).as_deref(),
            Some("discard-work")
        );
        assert_eq!(class("git clean -fdx", &CLEAN), None);
    }

    #[test]
    fn bare_force_push_checks_current_branch() {
        // DIRTY sits on main.
        assert_eq!(
            class("git push --force", &DIRTY).as_deref(),
            Some("force-push")
        );
        // CLEAN sits on a feature branch.
        assert_eq!(class("git push --force", &CLEAN), None);
        let detached = FakeGit {
            tracked: false,
            untracked: false,
            branch: None,
            default: None,
        };
        assert_eq!(
            class("git push -f", &detached).as_deref(),
            Some("force-push")
        );
        let custom_default = FakeGit {
            tracked: false,
            untracked: false,
            branch: Some("x"),
            default: Some("dev-main"),
        };
        assert_eq!(
            class("git push -f origin dev-main", &custom_default).as_deref(),
            Some("force-push")
        );
    }

    #[test]
    fn rm_at_repo_root_glob() {
        let git = CLEAN;
        let c = Ctx {
            cwd: Path::new("/home/u/repo"),
            top: Some(Path::new("/home/u/repo")),
            home: "/home/u",
            git: &git,
        };
        assert!(classify_irreversible("rm -rf *", &c).is_some());
        assert!(classify_irreversible("rm -rf .", &c).is_some());
        assert!(classify_irreversible("rm -rf src/*", &c).is_none());
    }

    fn policy(gates: Vec<(&str, Gate)>) -> Policy {
        Policy {
            version: POLICY_VERSION,
            gates: gates
                .into_iter()
                .enumerate()
                .map(|(i, (rule, gate))| PolicyGate {
                    id: format!("r{i}"),
                    rule: rule.into(),
                    scope: "team".into(),
                    gate,
                    except_members: vec![],
                })
                .collect(),
            ..Default::default()
        }
    }

    fn write(path: &str) -> Action {
        Action {
            tool: "Edit".into(),
            writes: vec![PathBuf::from(path)],
            ..Default::default()
        }
    }
    fn bash(cmd: &str) -> Action {
        Action {
            tool: "Bash".into(),
            command: Some(cmd.into()),
            ..Default::default()
        }
    }
    fn eval(p: &Policy, a: &Action) -> Outcome {
        outcome(
            &evaluate(Some(p), a, &ctx(&CLEAN), None),
            p.trifecta_blocks(),
        )
    }

    #[test]
    fn an_owner_s_own_sessions_pass_their_layer_gate() {
        let mut p = policy(vec![(
            "Data is owned by Sam",
            Gate::DenyPathWrite {
                globs: vec!["db/**".into()],
                except_files: vec![],
            },
        )]);
        p.gates[0].except_members = vec!["u-sam".into()];
        let sam = p.clone().for_member(Some("u-sam"));
        assert_eq!(eval(&sam, &write("/home/u/repo/db/a.sql")), Outcome::Allow);
        let alex = p.clone().for_member(Some("u-alex"));
        assert_eq!(
            eval(&alex, &write("/home/u/repo/db/a.sql")),
            Outcome::Blocked
        );
        // A session that doesn't say whose it is is checked.
        let nobody = p.clone().for_member(None);
        assert_eq!(
            eval(&nobody, &write("/home/u/repo/db/a.sql")),
            Outcome::Blocked
        );
        assert_eq!(
            eval(&p.for_member(Some(" ")), &write("/home/u/repo/db/a.sql")),
            Outcome::Blocked
        );
    }

    #[test]
    fn deny_path_write_lets_approved_files_through() {
        let p = policy(vec![(
            "Data is owned by Sam",
            Gate::DenyPathWrite {
                globs: vec!["db/**".into()],
                except_files: vec!["db/schema.sql".into()],
            },
        )]);
        assert_eq!(
            eval(&p, &write("/home/u/repo/db/schema.sql")),
            Outcome::Allow
        );
        assert_eq!(
            eval(&p, &write("/home/u/repo/db/seed.sql")),
            Outcome::Blocked
        );
        assert_eq!(eval(&p, &bash("echo x > ../db/seed.sql")), Outcome::Blocked);
    }

    #[test]
    fn a_policy_without_except_files_still_parses() {
        let raw = r#"{"type":"deny-path-write","globs":["db/"]}"#;
        let g: Gate = serde_json::from_str(raw).unwrap();
        assert_eq!(
            g,
            Gate::DenyPathWrite {
                globs: vec!["db/".into()],
                except_files: vec![],
            }
        );
        // And an empty exception list is not written back out.
        assert_eq!(serde_json::to_string(&g).unwrap(), raw);
        let with: Gate = serde_json::from_str(
            r#"{"type":"deny-path-write","globs":["db/"],"exceptFiles":["db/a.sql"]}"#,
        )
        .unwrap();
        assert!(
            matches!(with, Gate::DenyPathWrite { ref except_files, .. } if except_files == &vec!["db/a.sql".to_string()])
        );
    }

    #[test]
    fn deny_path_write_globs() {
        let p = policy(vec![(
            "Never touch migrations/",
            Gate::DenyPathWrite {
                globs: vec!["migrations/".into()],
                except_files: vec![],
            },
        )]);
        assert_eq!(
            eval(&p, &write("/home/u/repo/migrations/0001.sql")),
            Outcome::Blocked
        );
        assert_eq!(
            eval(&p, &write("/home/u/repo/db/migrations/0001.sql")),
            Outcome::Blocked
        );
        assert_eq!(
            eval(&p, &write("/home/u/repo/src/migrations.ts")),
            Outcome::Allow
        );
        assert_eq!(eval(&p, &bash("rm db/0001.sql")), Outcome::Allow);
        assert_eq!(
            eval(&p, &bash("rm ../migrations/0001.sql")),
            Outcome::Blocked
        );
        assert_eq!(
            eval(&p, &bash("echo x > ../migrations/new.sql")),
            Outcome::Blocked
        );
        assert_eq!(
            eval(&p, &bash("cat ../migrations/0001.sql")),
            Outcome::Allow
        );
        let sql = policy(vec![(
            "No SQL edits",
            Gate::DenyPathWrite {
                globs: vec!["*.sql".into()],
                except_files: vec![],
            },
        )]);
        assert_eq!(
            eval(&sql, &write("/home/u/repo/a/b/c.sql")),
            Outcome::Blocked
        );
        let exact = policy(vec![(
            "Lockfile",
            Gate::DenyPathWrite {
                globs: vec!["package-lock.json".into()],
                except_files: vec![],
            },
        )]);
        assert_eq!(
            eval(&exact, &write("/home/u/repo/package-lock.json")),
            Outcome::Blocked
        );
        assert_eq!(
            eval(&exact, &write("/home/u/repo/package.json")),
            Outcome::Allow
        );
        let anchored = policy(vec![(
            "Config",
            Gate::DenyPathWrite {
                globs: vec!["config/*.yml".into()],
                except_files: vec![],
            },
        )]);
        assert_eq!(
            eval(&anchored, &write("/home/u/repo/config/prod.yml")),
            Outcome::Blocked
        );
        assert_eq!(
            eval(&anchored, &write("/home/u/repo/config/deep/prod.yml")),
            Outcome::Allow
        );
    }

    #[test]
    fn protect_tests_defaults() {
        let p = policy(vec![(
            "Don't edit tests",
            Gate::ProtectTests { globs: vec![] },
        )]);
        assert_eq!(
            eval(&p, &write("/home/u/repo/src/a.test.ts")),
            Outcome::Blocked
        );
        assert_eq!(
            eval(&p, &write("/home/u/repo/tests/test_x.py")),
            Outcome::Blocked
        );
        assert_eq!(
            eval(&p, &write("/home/u/repo/src/__tests__/x.js")),
            Outcome::Blocked
        );
        assert_eq!(eval(&p, &write("/home/u/repo/src/a.ts")), Outcome::Allow);
        assert_eq!(
            eval(&p, &write("/home/u/repo/src/contest.ts")),
            Outcome::Allow
        );
    }

    #[test]
    fn deny_command_patterns() {
        let p = policy(vec![(
            "No publishing",
            Gate::DenyCommand {
                patterns: vec![r"^npm\s+publish\b".into()],
            },
        )]);
        assert_eq!(eval(&p, &bash("npm publish")), Outcome::Blocked);
        assert_eq!(
            eval(&p, &bash("npm test && npm publish --tag next")),
            Outcome::Blocked
        );
        assert_eq!(eval(&p, &bash("FOO=1 npm publish")), Outcome::Blocked);
        assert_eq!(eval(&p, &bash("npm run publish-docs")), Outcome::Allow);
        // An invalid regex is skipped, never a crash or a block.
        let bad = policy(vec![(
            "broken",
            Gate::DenyCommand {
                patterns: vec!["(".into()],
            },
        )]);
        assert_eq!(eval(&bad, &bash("anything")), Outcome::Allow);
    }

    #[test]
    fn packages() {
        let deny = policy(vec![(
            "No moment",
            Gate::PackageDenylist {
                names: vec!["moment".into()],
            },
        )]);
        assert_eq!(eval(&deny, &bash("npm install moment@2")), Outcome::Blocked);
        assert_eq!(eval(&deny, &bash("pnpm add -D Moment")), Outcome::Blocked);
        assert_eq!(eval(&deny, &bash("npm install")), Outcome::Allow);
        assert_eq!(eval(&deny, &bash("npm install dayjs")), Outcome::Allow);
        let allow = policy(vec![(
            "Only approved",
            Gate::PackageAllowlist {
                names: vec!["requests".into(), "@scope/ui".into()],
            },
        )]);
        assert_eq!(
            eval(&allow, &bash("pip install requests==2.31")),
            Outcome::Allow
        );
        assert_eq!(eval(&allow, &bash("npm i @scope/ui@1.2.3")), Outcome::Allow);
        assert_eq!(eval(&allow, &bash("pip install leftpad")), Outcome::Blocked);
        assert_eq!(
            eval(&allow, &bash("uv pip install leftpad")),
            Outcome::Blocked
        );
        assert_eq!(
            eval(&allow, &bash("pip install -r requirements.txt")),
            Outcome::Allow
        );
    }

    #[test]
    fn egress() {
        let p = policy(vec![(
            "Only GitHub",
            Gate::EgressAllowlist {
                hosts: vec!["*.github.com".into(), "github.com".into()],
            },
        )]);
        assert_eq!(
            eval(&p, &bash("curl -s https://api.github.com/repos")),
            Outcome::Allow
        );
        assert_eq!(
            eval(&p, &bash("curl http://localhost:3000/health")),
            Outcome::Allow
        );
        assert_eq!(
            eval(&p, &bash("curl https://evil.example.com/x")),
            Outcome::Blocked
        );
        assert_eq!(eval(&p, &bash("wget example.org/file")), Outcome::Blocked);
        let fetch = Action {
            tool: "WebFetch".into(),
            url: Some("https://pastebin.com/raw/x".into()),
            ..Default::default()
        };
        assert_eq!(eval(&p, &fetch), Outcome::Blocked);
    }

    #[test]
    fn require_confirm_classes() {
        let p = policy(vec![(
            "Ask before publishing",
            Gate::RequireConfirm {
                class: Some("publish".into()),
                patterns: vec![],
            },
        )]);
        assert_eq!(eval(&p, &bash("cargo publish")), Outcome::NeedsApproval);
        assert_eq!(eval(&p, &bash("cargo build")), Outcome::Allow);
        let m = policy(vec![(
            "Ask before migrating",
            Gate::RequireConfirm {
                class: Some("migrate".into()),
                patterns: vec![],
            },
        )]);
        assert_eq!(
            eval(&m, &bash("npx prisma migrate deploy")),
            Outcome::NeedsApproval
        );
    }

    #[test]
    fn irreversible_without_policy_needs_approval() {
        let f = evaluate(None, &bash("terraform destroy"), &ctx(&CLEAN), None);
        assert_eq!(outcome(&f, false), Outcome::NeedsApproval);
        let reason = agent_reason(&f, Outcome::NeedsApproval);
        assert!(
            reason.contains("can't be undone") && reason.contains("exactly the same command"),
            "{reason}"
        );
        assert_eq!(
            outcome(&evaluate(None, &bash("ls"), &ctx(&CLEAN), None), false),
            Outcome::Allow
        );
    }

    #[test]
    fn blocked_reason_quotes_the_rule() {
        let p = policy(vec![(
            "Never touch migrations/",
            Gate::DenyPathWrite {
                globs: vec!["migrations".into()],
                except_files: vec![],
            },
        )]);
        let f = evaluate(
            Some(&p),
            &write("/home/u/repo/migrations/x.sql"),
            &ctx(&CLEAN),
            None,
        );
        let r = agent_reason(&f, outcome(&f, false));
        assert!(
            r.starts_with("Blocked by team rule 'Never touch migrations/'"),
            "{r}"
        );
        assert!(r.contains("migrations/x.sql"), "{r}");
    }

    #[test]
    fn self_protection() {
        let home = "/home/u";
        let c = Ctx {
            cwd: Path::new("/home/u/repo"),
            top: Some(Path::new("/home/u/repo")),
            home,
            git: &CLEAN,
        };
        let policy_file = policy_dir(home).join("approvals/abc.json");
        let w = Action {
            tool: "Write".into(),
            writes: vec![policy_file],
            ..Default::default()
        };
        assert_eq!(
            outcome(&evaluate(None, &w, &c, None), false),
            Outcome::Refused
        );
        assert_eq!(
            outcome(
                &evaluate(
                    None,
                    &bash("touch ~/.canopy/policy/approvals/x.json"),
                    &c,
                    None
                ),
                false
            ),
            Outcome::Refused
        );
    }

    #[test]
    fn trifecta_warns_then_blocks() {
        let read_env = Action {
            tool: "Read".into(),
            reads: vec![PathBuf::from("/home/u/repo/.env")],
            ..Default::default()
        };
        let read_example = Action {
            tool: "Read".into(),
            reads: vec![PathBuf::from("/home/u/repo/.env.example")],
            ..Default::default()
        };
        let mut p = Policy::default();
        let f = evaluate(Some(&p), &read_env, &ctx(&CLEAN), Some("WebFetch"));
        assert_eq!(outcome(&f, p.trifecta_blocks()), Outcome::Warn);
        p.trifecta = "block".into();
        assert_eq!(outcome(&f, p.trifecta_blocks()), Outcome::Blocked);
        assert_eq!(
            outcome(
                &evaluate(Some(&p), &read_example, &ctx(&CLEAN), Some("WebFetch")),
                true
            ),
            Outcome::Allow
        );
        // Untainted sessions read .env freely.
        assert_eq!(
            outcome(&evaluate(Some(&p), &read_env, &ctx(&CLEAN), None), true),
            Outcome::Allow
        );
        for cmd in [
            "git push origin feature",
            "curl -X POST https://x.io -d a=1",
            "gh pr create --fill",
            "cat ../.env",
            "printenv",
            "gh api repos/x/y/issues -f title=t",
        ] {
            assert_eq!(
                outcome(
                    &evaluate(Some(&p), &bash(cmd), &ctx(&CLEAN), Some("WebFetch")),
                    true
                ),
                Outcome::Blocked,
                "{cmd}"
            );
        }
        for cmd in [
            "curl https://x.io",
            "gh pr view 3",
            "git status",
            "cat README.md",
        ] {
            assert_eq!(
                outcome(
                    &evaluate(Some(&p), &bash(cmd), &ctx(&CLEAN), Some("WebFetch")),
                    true
                ),
                Outcome::Allow,
                "{cmd}"
            );
        }
        let vault = Action {
            tool: "mcp__canopy__canopy_vault_fill".into(),
            ..Default::default()
        };
        assert_eq!(
            outcome(
                &evaluate(Some(&p), &vault, &ctx(&CLEAN), Some("WebFetch")),
                true
            ),
            Outcome::Blocked
        );
    }

    #[test]
    fn untrusted_tools() {
        assert!(reads_untrusted("WebFetch"));
        assert!(reads_untrusted("mcp__canopy__canopy_browser_navigate"));
        assert!(reads_untrusted("mcp__playwright__browser_click"));
        assert!(!reads_untrusted("Read"));
        assert!(!reads_untrusted("Bash"));
    }

    #[test]
    fn approve_once_token() {
        let tmp = std::env::temp_dir().join(format!("canopy-gates-test-{}", std::process::id()));
        let home = tmp.to_string_lossy().to_string();
        let key = action_key("/repo", "  terraform destroy ");
        assert_eq!(key, action_key("/repo", "terraform destroy"));
        assert_ne!(key, action_key("/repo", "terraform destroy -target=x"));
        assert_ne!(key, action_key("/other", "terraform destroy"));
        assert!(!consume_once(&home, &key, 1_000));
        grant_once(&home, &key, 1_000).unwrap();
        assert!(consume_once(&home, &key, 2_000), "a live token is spent");
        assert!(!consume_once(&home, &key, 2_000), "and only once");
        grant_once(&home, &key, 1_000).unwrap();
        assert!(
            !consume_once(&home, &key, 1_000 + APPROVAL_TTL_MS + 1),
            "an expired token is no approval"
        );
        assert!(grant_once(&home, "../../etc/passwd", 0).is_err());
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn taint_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("canopy-taint-test-{}", std::process::id()));
        let home = tmp.to_string_lossy().to_string();
        let ids = vec![
            "sess-1".to_string(),
            pty_taint_id(Some("inst"), Some("4")).unwrap(),
        ];
        assert!(is_tainted(&home, &ids).is_none());
        mark_tainted(&home, &ids[1..], "WebFetch");
        assert_eq!(is_tainted(&home, &ids).as_deref(), Some("WebFetch"));
        assert!(taint_path(&home, "../x")
            .map(|p| !p.to_string_lossy().contains(".."))
            .unwrap_or(true));
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn policy_roundtrip_and_unknown_gate() {
        let raw = r#"{"version":1,"root":"/r","trifecta":"block","gates":[
            {"id":"a","rule":"x","gate":{"type":"deny-path-write","globs":["migrations/"]}},
            {"id":"b","rule":"y","scope":"team","gate":{"type":"require-confirm","match":"publish"}}
        ],"guidance":["Prefer small PRs"]}"#;
        let p: Policy = serde_json::from_str(raw).unwrap();
        assert_eq!(p.gates.len(), 2);
        assert!(p.trifecta_blocks());
        assert_eq!(
            p.gates[1].gate,
            Gate::RequireConfirm {
                class: Some("publish".into()),
                patterns: vec![]
            }
        );
        // An unknown type is not a policy the hook will guess at.
        let bad = r#"{"gates":[{"id":"a","rule":"x","gate":{"type":"run-anything"}}]}"#;
        assert!(serde_json::from_str::<Policy>(bad).is_err());
        assert!(session_context(&p).unwrap().contains("Prefer small PRs"));
    }

    #[test]
    fn canonical_root_matches_git_layout() {
        let tmp = std::env::temp_dir().join(format!("canopy-root-test-{}", std::process::id()));
        let main = tmp.join("main");
        let wt = tmp.join("wt");
        std::fs::create_dir_all(main.join(".git/worktrees/wt")).unwrap();
        std::fs::create_dir_all(wt.join("src")).unwrap();
        std::fs::write(
            wt.join(".git"),
            format!("gitdir: {}\n", main.join(".git/worktrees/wt").display()),
        )
        .unwrap();
        std::fs::write(main.join(".git/worktrees/wt/commondir"), "../..\n").unwrap();
        let want = main.canonicalize().unwrap().to_string_lossy().to_string();
        assert_eq!(canonical_root(&main).as_deref(), Some(want.as_str()));
        assert_eq!(
            canonical_root(&wt.join("src")).as_deref(),
            Some(want.as_str())
        );
        assert_eq!(worktree_top(&wt.join("src")).as_deref(), Some(wt.as_path()));
        let home = tmp.join("home").to_string_lossy().to_string();
        let policy = Policy {
            version: 1,
            root: want.clone(),
            ..Default::default()
        };
        // The env override would redirect every test; keep this one explicit.
        if std::env::var("CANOPY_POLICY_HOME").is_err() {
            write_policy(&home, &want, &policy).unwrap();
            let (root, loaded) = load_policy(&home, &wt.join("src")).unwrap();
            assert_eq!(root, want);
            assert_eq!(loaded.root, want);
        }
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn segments_split_and_unquote() {
        assert_eq!(
            segments("FOO=1 npm test && git push -f 'origin' \"main\" | tee x; echo done"),
            vec![
                vec!["FOO=1", "npm", "test"],
                vec!["git", "push", "-f", "origin", "main"],
                vec!["tee", "x"],
                vec!["echo", "done"],
            ]
            .into_iter()
            .map(|v| v.into_iter().map(String::from).collect::<Vec<_>>())
            .collect::<Vec<_>>()
        );
        // Pinned against packages/remote-host/gates.mjs rootHash: the VM's
        // policy file must have the name the VM's hook looks for.
        assert_eq!(root_hash(""), "e3b0c44298fc1c149afbf4c8996fb924");
        assert_eq!(package_name("@scope/pkg@1.2"), "@scope/pkg");
        assert_eq!(package_name("Requests>=2"), "requests");
        assert_eq!(
            expand_glob("migrations"),
            vec!["**/migrations", "**/migrations/**"]
        );
        assert_eq!(expand_glob("src/db/"), vec!["src/db/**"]);
    }
}
