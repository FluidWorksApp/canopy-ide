//! Every MCP server this machine has configured, from every agent CLI, as one
//! de-duplicated list.
//!
//! The agent CLIs each keep their own MCP registry, in their own dialect, in
//! their own file — and people end up configuring the same server in several of
//! them. Read separately they are seven partial answers to "what tools can my
//! agents reach"; read together, and folded on what each entry actually points
//! at, they are one.
//!
//! Discovery is file-only and deliberately so: no process is spawned, nothing is
//! connected to, so this is cheap enough to run every time the panel opens. What
//! the servers *expose* — the tools themselves — is not in any of these files
//! and can only be had by speaking MCP to each server; that is a later phase
//! built on top of this one.
//!
//! Secrets never leave this module. These configs hold live API keys in `env`
//! and sometimes in argv (`--api-key=…`), and the panel has no use for a single
//! one of them. Values are dropped at parse time and argv is redacted, so a key
//! cannot reach the webview, a log line, or a cache file by any later mistake.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::agents::read_json_config;

/// One config file's claim on a server: which CLI, under what name, from where.
/// A server configured in four CLIs has four of these, and the row is the same
/// row — this is what tells you *whose* it is.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct McpSource {
    /// Agent id, matching SUPPORTED_AGENTS where there is one.
    pub agent: String,
    /// What the UI calls this CLI, plus the scope: "Claude Code (project)".
    pub label: String,
    /// The name this server has *here*. Frequently differs between CLIs, which
    /// is exactly why the display name can't be the identity.
    pub name: String,
    pub config_path: String,
    /// "global" (the CLI's user-scope config) or "project" (in the repo).
    pub scope: String,
    /// "enabled", "disabled" (switched off in this config), or "pending" (a
    /// `.mcp.json` server the user has neither approved nor rejected).
    pub status: String,
}

/// One server, however many configs point at it.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct McpServer {
    /// Stable identity across CLIs — see `dedupe_key`. Not shown; it is what
    /// the tool-list cache will be keyed on.
    pub key: String,
    pub name: String,
    /// "stdio", "http" or "sse".
    pub transport: String,
    pub command: Option<String>,
    /// Redacted: any argument carrying a credential is `***` by the time it
    /// gets here.
    pub args: Vec<String>,
    pub url: Option<String>,
    /// Names of the environment variables the server is given. Names only —
    /// the values are dropped at parse time and never stored.
    pub env_keys: Vec<String>,
    /// Every config that configures this server, in discovery order.
    pub sources: Vec<McpSource>,
    /// True when at least one source has it switched on. A server disabled in
    /// one CLI and live in another is live, and the sources say where.
    pub enabled: bool,
}

/// The shape of one registry entry, once the dialect is parsed away.
#[derive(Clone, Debug, PartialEq)]
struct Endpoint {
    transport: String,
    command: Option<String>,
    args: Vec<String>,
    url: Option<String>,
    env_keys: Vec<String>,
    enabled: bool,
}

/// How a config spells its server entries. The three shapes are genuinely
/// different, not stylistic variants: opencode's command is one array, VS Code
/// nests the map under a different key, and the rest follow Claude's.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Dialect {
    /// `{ command, args, env }` or `{ type: "http"|"sse", url }`.
    Claude,
    /// `{ type: "local", command: [bin, ...args], environment }` /
    /// `{ type: "remote", url }`, with an explicit `enabled` flag.
    OpenCode,
}

/// A JSON registry to read: where it lives and how to read it.
struct Registry {
    agent: &'static str,
    label: &'static str,
    /// Path relative to `$HOME` (global) or to the project root (project).
    rel: &'static str,
    /// The key the server map hangs off. Dotted keys are not paths — Amp's
    /// literal key is "amp.mcpServers".
    key: &'static str,
    dialect: Dialect,
}

/// User-scope registries. Cursor, Windsurf and VS Code are not agent CLIs we
/// launch, but their MCP configs are on the same machine describing the same
/// servers, and leaving them out would mean showing a list the user can see is
/// incomplete.
const GLOBAL_REGISTRIES: &[Registry] = &[
    Registry {
        agent: "claude",
        label: "Claude Code",
        rel: ".claude.json",
        key: "mcpServers",
        dialect: Dialect::Claude,
    },
    Registry {
        agent: "agy",
        label: "Antigravity",
        rel: ".gemini/config/mcp_config.json",
        key: "mcpServers",
        dialect: Dialect::Claude,
    },
    Registry {
        agent: "agy",
        label: "Antigravity",
        rel: ".gemini/settings.json",
        key: "mcpServers",
        dialect: Dialect::Claude,
    },
    Registry {
        agent: "opencode",
        label: "OpenCode",
        rel: ".config/opencode/opencode.json",
        key: "mcp",
        dialect: Dialect::OpenCode,
    },
    Registry {
        agent: "amp",
        label: "Amp",
        rel: ".config/amp/settings.json",
        key: "amp.mcpServers",
        dialect: Dialect::Claude,
    },
    Registry {
        agent: "cursor",
        label: "Cursor",
        rel: ".cursor/mcp.json",
        key: "mcpServers",
        dialect: Dialect::Claude,
    },
    Registry {
        agent: "windsurf",
        label: "Windsurf",
        rel: ".codeium/windsurf/mcp_config.json",
        key: "mcpServers",
        dialect: Dialect::Claude,
    },
];

/// Registries that live in the repo. `.mcp.json` is the one that needs its
/// status looked up elsewhere — see `mcpjson_status`.
const PROJECT_REGISTRIES: &[Registry] = &[
    Registry {
        agent: "claude",
        label: "Claude Code",
        rel: ".mcp.json",
        key: "mcpServers",
        dialect: Dialect::Claude,
    },
    Registry {
        agent: "cursor",
        label: "Cursor",
        rel: ".cursor/mcp.json",
        key: "mcpServers",
        dialect: Dialect::Claude,
    },
    Registry {
        agent: "vscode",
        label: "VS Code",
        rel: ".vscode/mcp.json",
        key: "servers",
        dialect: Dialect::Claude,
    },
    Registry {
        agent: "opencode",
        label: "OpenCode",
        rel: "opencode.json",
        key: "mcp",
        dialect: Dialect::OpenCode,
    },
];

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/// Does this look like the name of something secret? Deliberately generous:
/// the cost of redacting a harmless argument is a less informative row, and the
/// cost of missing one is a live credential rendered into the UI.
fn secretish(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    [
        "key",
        "token",
        "secret",
        "password",
        "passwd",
        "auth",
        "credential",
    ]
    .iter()
    .any(|needle| n.contains(needle))
}

/// A bare credential passed as its own argument, recognised by the shapes the
/// common issuers use. Anything long, opaque and prefixed is treated as one.
fn bare_secret(arg: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "sk-",
        "sk_",
        "pk_",
        "rk_",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "github_pat_",
        "xoxb-",
        "xoxp-",
        "xoxa-",
        "xoxr-",
        "AIza",
        "bb_live_",
        "bb_test_",
        "Bearer ",
    ];
    PREFIXES.iter().any(|p| arg.starts_with(p)) && arg.len() >= 12
}

/// Argv with credentials blanked. Handles both `--api-key=VALUE` and a bare
/// token standing alone; the paired form (`--api-key VALUE`) is handled by the
/// caller, which can see the argument before it.
fn redact_arg(arg: &str) -> String {
    if let Some((lhs, rhs)) = arg.split_once('=') {
        if secretish(lhs) && !rhs.is_empty() {
            return format!("{lhs}=***");
        }
    }
    if bare_secret(arg) {
        return "***".into();
    }
    arg.into()
}

fn redact_args(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut redact_next = false;
    for arg in args {
        if redact_next {
            out.push("***".into());
            redact_next = false;
            continue;
        }
        // `--api-key VALUE`: the flag names the secret, the next argument is it.
        redact_next = arg.starts_with('-') && !arg.contains('=') && secretish(arg);
        out.push(redact_arg(arg));
    }
    out
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/// The last path segment of a command, without a Windows executable suffix, so
/// an absolute path and a bare name agree: `/Users/x/.canopy/bin/canopy-hook`
/// and `canopy-hook` are one command.
fn basename(cmd: &str) -> String {
    let tail = cmd
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(cmd)
        .to_ascii_lowercase();
    for suffix in [".exe", ".cmd", ".bat"] {
        if let Some(stem) = tail.strip_suffix(suffix) {
            return stem.into();
        }
    }
    tail
}

/// Scheme, host and path, lowercased. The query string is dropped: remote MCP
/// servers routinely carry per-user tokens there, and two configs pointing at
/// one endpoint with different credentials are the same server.
fn normalize_url(url: &str) -> String {
    let lower = url.trim().to_ascii_lowercase();
    let no_query = lower.split(['?', '#']).next().unwrap_or(&lower);
    // Strip userinfo — `https://user:pw@host/…` is the same host.
    let (scheme, rest) = no_query.split_once("://").unwrap_or(("", no_query));
    let rest = rest.rsplit_once('@').map_or(rest, |(_, host)| host);
    let joined = if scheme.is_empty() {
        rest.to_string()
    } else {
        format!("{scheme}://{rest}")
    };
    joined.trim_end_matches('/').to_string()
}

/// What makes two entries the same server.
///
/// Not the name: everyone calls it `playwright`, and two different `playwright`
/// entries running different packages are genuinely two servers. Not the raw
/// command either: one config writes an absolute path, another the bare binary,
/// a third adds `-y`. So identity is the normalised launch — what the process
/// would actually be — which folds those three into one and keeps two distinct
/// packages apart.
fn dedupe_key(ep: &Endpoint) -> String {
    if let Some(url) = &ep.url {
        return format!("url:{}", normalize_url(url));
    }
    let mut tokens: Vec<String> = Vec::new();
    if let Some(cmd) = &ep.command {
        tokens.push(basename(cmd));
    }
    for arg in &ep.args {
        let arg = arg.trim();
        // Runner noise. `npx -y pkg` and `npx pkg` start the same server; the
        // flag is about the prompt, not about which server this is.
        if matches!(arg, "-y" | "--yes" | "-q" | "--quiet" | "--silent") {
            continue;
        }
        // A floating `@latest` and today's pin are the same intent. A real
        // version pin (`@1.2.3`) is left alone — that one is a choice.
        let arg = arg.strip_suffix("@latest").unwrap_or(arg);
        tokens.push(arg.to_ascii_lowercase());
    }
    format!("cmd:{}", tokens.join(" "))
}

// ---------------------------------------------------------------------------
// Dialects
// ---------------------------------------------------------------------------

fn string_list(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|i| i.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Variable *names*, sorted. The values are read and dropped here, and this is
/// the only place in the app that ever holds them.
fn env_key_names(value: Option<&serde_json::Value>) -> Vec<String> {
    let mut keys: Vec<String> = value
        .and_then(|v| v.as_object())
        .map(|obj| obj.keys().cloned().collect())
        .unwrap_or_default();
    keys.sort();
    keys
}

fn parse_claude_entry(entry: &serde_json::Value) -> Option<Endpoint> {
    let obj = entry.as_object()?;
    let declared = obj.get("type").and_then(|t| t.as_str());
    let url = obj.get("url").and_then(|u| u.as_str());
    // The type field is optional in every dialect that has it, so the presence
    // of a url is what actually decides; the declared type only distinguishes
    // http from sse, which share a shape.
    if let Some(url) = url {
        return Some(Endpoint {
            transport: if declared == Some("sse") {
                "sse"
            } else {
                "http"
            }
            .into(),
            command: None,
            args: Vec::new(),
            url: Some(url.to_string()),
            env_keys: env_key_names(obj.get("headers")),
            enabled: obj.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true),
        });
    }
    let command = obj.get("command").and_then(|c| c.as_str())?;
    Some(Endpoint {
        transport: "stdio".into(),
        command: Some(command.to_string()),
        args: string_list(obj.get("args")),
        url: None,
        env_keys: env_key_names(obj.get("env")),
        enabled: obj.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true),
    })
}

fn parse_opencode_entry(entry: &serde_json::Value) -> Option<Endpoint> {
    let obj = entry.as_object()?;
    let enabled = obj.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true);
    if let Some(url) = obj.get("url").and_then(|u| u.as_str()) {
        return Some(Endpoint {
            transport: "http".into(),
            command: None,
            args: Vec::new(),
            url: Some(url.to_string()),
            env_keys: env_key_names(obj.get("headers")),
            enabled,
        });
    }
    // One array, binary first — the whole difference from Claude's dialect.
    let parts = string_list(obj.get("command"));
    let (command, args) = parts.split_first()?;
    Some(Endpoint {
        transport: "stdio".into(),
        command: Some(command.clone()),
        args: args.to_vec(),
        url: None,
        env_keys: env_key_names(obj.get("environment")),
        enabled,
    })
}

fn parse_entry(entry: &serde_json::Value, dialect: Dialect) -> Option<Endpoint> {
    match dialect {
        Dialect::Claude => parse_claude_entry(entry),
        Dialect::OpenCode => parse_opencode_entry(entry),
    }
}

// ---------------------------------------------------------------------------
// Codex TOML
// ---------------------------------------------------------------------------

/// The table path of a TOML section header, with quoting resolved, or None if
/// the line is not a header. Codex nests project paths under `[projects.'…']`,
/// whose segments are full of dots and slashes, so the split has to respect
/// quotes or a project path becomes a server name.
fn toml_table_path(line: &str) -> Option<Vec<String>> {
    let t = line.trim();
    let inner = t.strip_prefix('[')?.strip_suffix(']')?;
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in inner.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => current.push(ch),
            None if ch == '\'' || ch == '"' => quote = Some(ch),
            None if ch == '.' => parts.push(std::mem::take(&mut current)),
            None => current.push(ch),
        }
    }
    parts.push(current);
    Some(parts.into_iter().map(|p| p.trim().to_string()).collect())
}

/// One TOML scalar or single-line array of strings. Enough for the value shapes
/// an MCP entry uses, and no more — a full parser would be a dependency bought
/// to read four keys.
fn toml_value(raw: &str) -> Vec<String> {
    let raw = raw.trim();
    if let Some(inner) = raw.strip_prefix('[').and_then(|r| r.strip_suffix(']')) {
        return inner
            .split(',')
            .map(|item| item.trim().trim_matches(['"', '\'']).to_string())
            .filter(|item| !item.is_empty())
            .collect();
    }
    let unquoted = raw.trim_matches(['"', '\'']).to_string();
    if unquoted.is_empty() {
        Vec::new()
    } else {
        vec![unquoted]
    }
}

/// Codex's `[mcp_servers.*]` tables, read as text for the same reason
/// `codex_toml_with_canopy` writes them as text.
fn parse_codex_toml(raw: &str) -> Vec<(String, Endpoint)> {
    let mut servers: BTreeMap<String, Endpoint> = BTreeMap::new();
    let mut path: Vec<String> = Vec::new();
    for line in raw.lines() {
        if let Some(header) = toml_table_path(line) {
            path = header;
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // [mcp_servers.NAME] and [mcp_servers.NAME.env]
        if path.len() < 2 || path[0] != "mcp_servers" {
            continue;
        }
        let name = path[1].clone();
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim().trim_matches(['"', '\'']);
        let entry = servers.entry(name).or_insert_with(|| Endpoint {
            transport: "stdio".into(),
            command: None,
            args: Vec::new(),
            url: None,
            env_keys: Vec::new(),
            enabled: true,
        });
        if path.len() == 3 && path[2] == "env" {
            entry.env_keys.push(key.to_string());
            continue;
        }
        if path.len() != 2 {
            continue;
        }
        match key {
            "command" => entry.command = toml_value(value).into_iter().next(),
            "args" => entry.args = toml_value(value),
            "url" => {
                entry.url = toml_value(value).into_iter().next();
                entry.transport = "http".into();
            }
            "enabled" => entry.enabled = value.trim() != "false",
            _ => {}
        }
    }
    for endpoint in servers.values_mut() {
        endpoint.env_keys.sort();
    }
    // A table with neither a command nor a url is a fragment, not a server.
    servers
        .into_iter()
        .filter(|(_, e)| e.command.is_some() || e.url.is_some())
        .collect()
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/// Accumulates entries and folds them onto their identity as they arrive.
#[derive(Default)]
struct Collector {
    /// Insertion-ordered, so the list is stable across runs: BTreeMap on the
    /// key would sort by launch command, which means nothing to anyone.
    order: Vec<String>,
    by_key: BTreeMap<String, McpServer>,
}

impl Collector {
    fn add(&mut self, name: &str, endpoint: Endpoint, source: McpSource) {
        let key = dedupe_key(&endpoint);
        let enabled = source.status == "enabled";
        if !self.by_key.contains_key(&key) {
            self.order.push(key.clone());
            self.by_key.insert(
                key.clone(),
                McpServer {
                    key: key.clone(),
                    name: name.to_string(),
                    transport: endpoint.transport.clone(),
                    command: endpoint.command.clone(),
                    args: redact_args(&endpoint.args),
                    url: endpoint.url.clone(),
                    env_keys: Vec::new(),
                    sources: Vec::new(),
                    enabled: false,
                },
            );
        }
        let existing = self.by_key.get_mut(&key).expect("just inserted");
        // Union rather than first-wins: one CLI's entry may name variables the
        // other's leaves to the ambient environment, and the row should show
        // everything this server has been given anywhere.
        for env_key in endpoint.env_keys {
            if !existing.env_keys.contains(&env_key) {
                existing.env_keys.push(env_key);
            }
        }
        existing.env_keys.sort();
        existing.enabled |= enabled;
        existing.sources.push(source);
    }

    fn finish(self) -> Vec<McpServer> {
        let Collector { order, mut by_key } = self;
        order
            .into_iter()
            .filter_map(|k| by_key.remove(&k))
            .collect()
    }
}

/// Whether a `.mcp.json` server counts for this project. Claude Code asks
/// before trusting a server that arrived with a checkout, and records the
/// answer per project — a server nobody has answered for yet is neither on nor
/// off, and saying "enabled" would misreport it as reachable.
fn mcpjson_status(project_state: Option<&serde_json::Value>, name: &str) -> &'static str {
    let Some(state) = project_state else {
        return "pending";
    };
    let listed = |key: &str| {
        state
            .get(key)
            .and_then(|v| v.as_array())
            .is_some_and(|items| items.iter().any(|i| i.as_str() == Some(name)))
    };
    if listed("disabledMcpjsonServers") {
        return "disabled";
    }
    if listed("enabledMcpjsonServers") {
        return "enabled";
    }
    if state
        .get("enableAllProjectMcpServers")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return "enabled";
    }
    "pending"
}

fn read_registry(
    collector: &mut Collector,
    path: &Path,
    registry: &Registry,
    scope: &str,
    status_for: &dyn Fn(&str, bool) -> &'static str,
) {
    if !path.exists() {
        return;
    }
    // An unreadable config is reported as no servers rather than as an error:
    // one CLI's broken JSON must not empty a list that seven CLIs feed.
    let Ok(config) = read_json_config(path) else {
        return;
    };
    let Some(entries) = config.get(registry.key).and_then(|m| m.as_object()) else {
        return;
    };
    for (name, entry) in entries {
        let Some(endpoint) = parse_entry(entry, registry.dialect) else {
            continue;
        };
        let status = status_for(name, endpoint.enabled);
        collector.add(
            name,
            endpoint,
            McpSource {
                agent: registry.agent.into(),
                label: format!("{} ({scope})", registry.label),
                name: name.clone(),
                config_path: path.display().to_string(),
                scope: scope.into(),
                status: status.into(),
            },
        );
    }
}

/// Straightforward status: the config's own `enabled` flag, where it has one.
fn plain_status(_name: &str, enabled: bool) -> &'static str {
    if enabled {
        "enabled"
    } else {
        "disabled"
    }
}

/// Every MCP server configured on this machine, folded onto identity.
///
/// `projects` scopes the walk: Claude keeps a per-project server map inside
/// `~/.claude.json` and repos carry `.mcp.json`, so with no roots this is the
/// user-scope answer and with them it is what this project's agents can
/// actually reach. It takes several because a Canopy project is a set of
/// components, each its own checkout with its own configs.
pub fn discover(home: &Path, projects: &[PathBuf]) -> Vec<McpServer> {
    let mut collector = Collector::default();

    for registry in GLOBAL_REGISTRIES {
        read_registry(
            &mut collector,
            &home.join(registry.rel),
            registry,
            "global",
            &plain_status,
        );
    }

    // Codex is TOML, so it gets read directly rather than through `Registry`.
    let codex_path = home.join(".codex/config.toml");
    if let Ok(raw) = std::fs::read_to_string(&codex_path) {
        for (name, endpoint) in parse_codex_toml(&raw) {
            let status = plain_status(&name, endpoint.enabled);
            collector.add(
                &name,
                endpoint,
                McpSource {
                    agent: "codex".into(),
                    label: "Codex (global)".into(),
                    name: name.clone(),
                    config_path: codex_path.display().to_string(),
                    scope: "global".into(),
                    status: status.into(),
                },
            );
        }
    }

    if projects.is_empty() {
        return collector.finish();
    }
    // Read once for every root: `~/.claude.json` is a 200KB file holding
    // Claude Code's whole account and project state, and a Canopy project can
    // have several components in it.
    let claude_path = home.join(".claude.json");
    let claude = read_json_config(&claude_path).unwrap_or_else(|_| serde_json::json!({}));
    for project in projects {
        read_project(&mut collector, project, &claude_path, &claude);
    }

    collector.finish()
}

/// One project root's share of the walk.
fn read_project(
    collector: &mut Collector,
    project: &Path,
    claude_path: &Path,
    claude: &serde_json::Value,
) {
    // Claude's per-project servers, and the approval state its `.mcp.json`
    // gating is read from, both live in the user-scope file under the project's
    // absolute path.
    let project_state = claude
        .get("projects")
        .and_then(|p| p.get(project.to_string_lossy().as_ref()))
        .cloned();

    if let Some(entries) = project_state
        .as_ref()
        .and_then(|s| s.get("mcpServers"))
        .and_then(|m| m.as_object())
    {
        for (name, entry) in entries {
            let Some(endpoint) = parse_claude_entry(entry) else {
                continue;
            };
            let status = plain_status(name, endpoint.enabled);
            collector.add(
                name,
                endpoint,
                McpSource {
                    agent: "claude".into(),
                    label: "Claude Code (project)".into(),
                    name: name.clone(),
                    config_path: claude_path.display().to_string(),
                    scope: "project".into(),
                    status: status.into(),
                },
            );
        }
    }

    for registry in PROJECT_REGISTRIES {
        let gated = registry.agent == "claude" && registry.rel == ".mcp.json";
        let status_for = |name: &str, enabled: bool| {
            if gated {
                mcpjson_status(project_state.as_ref(), name)
            } else {
                plain_status(name, enabled)
            }
        };
        read_registry(
            collector,
            &project.join(registry.rel),
            registry,
            "project",
            &status_for,
        );
    }
}

#[tauri::command]
pub async fn mcp_servers(project_dirs: Option<Vec<String>>) -> Result<Vec<McpServer>, String> {
    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    let projects: Vec<PathBuf> = project_dirs
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .collect();
    Ok(discover(Path::new(&home), &projects))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio(command: &str, args: &[&str]) -> Endpoint {
        Endpoint {
            transport: "stdio".into(),
            command: Some(command.into()),
            args: args.iter().map(|a| (*a).to_string()).collect(),
            url: None,
            env_keys: Vec::new(),
            enabled: true,
        }
    }

    #[test]
    fn an_absolute_path_and_a_bare_binary_are_one_server() {
        assert_eq!(
            dedupe_key(&stdio("/Users/x/.canopy/bin/canopy-hook", &["--mcp"])),
            dedupe_key(&stdio("canopy-hook", &["--mcp"])),
        );
    }

    #[test]
    fn runner_noise_does_not_split_a_server() {
        assert_eq!(
            dedupe_key(&stdio("npx", &["-y", "@mastra/mcp-docs-server"])),
            dedupe_key(&stdio("npx", &["@mastra/mcp-docs-server@latest"])),
        );
    }

    #[test]
    fn different_packages_stay_apart() {
        assert_ne!(
            dedupe_key(&stdio("npx", &["@playwright/mcp"])),
            dedupe_key(&stdio("npx", &["@mastra/mcp-docs-server"])),
        );
    }

    #[test]
    fn a_pinned_version_is_a_choice_and_is_kept() {
        assert_ne!(
            dedupe_key(&stdio("npx", &["@playwright/mcp@1.2.3"])),
            dedupe_key(&stdio("npx", &["@playwright/mcp@latest"])),
        );
    }

    #[test]
    fn one_endpoint_with_two_credentials_is_one_server() {
        let with = |q: &str| Endpoint {
            transport: "http".into(),
            command: None,
            args: Vec::new(),
            url: Some(format!("https://Example.com/mcp/?token={q}")),
            env_keys: Vec::new(),
            enabled: true,
        };
        assert_eq!(dedupe_key(&with("aaa")), dedupe_key(&with("bbb")));
        assert_eq!(dedupe_key(&with("aaa")), "url:https://example.com/mcp");
    }

    #[test]
    fn credentials_in_argv_never_survive_parsing() {
        let args = redact_args(&[
            "--api-key=bb_live_secretvalue".into(),
            "--token".into(),
            "hunter2".into(),
            "AIzaSyBNtGu9QEzetAjtdVXF5AaITV3rghu1KPE".into(),
            "--headless".into(),
        ]);
        assert_eq!(
            args,
            vec!["--api-key=***", "--token", "***", "***", "--headless"],
        );
    }

    #[test]
    fn env_values_are_dropped_and_only_names_kept() {
        let entry = serde_json::json!({
            "command": "npx",
            "args": ["@browserbasehq/mcp-server-browserbase"],
            "env": { "BROWSERBASE_API_KEY": "bb_live_xxx", "GEMINI_API_KEY": "AIzaSy" },
        });
        let endpoint = parse_claude_entry(&entry).expect("parses");
        assert_eq!(endpoint.env_keys, ["BROWSERBASE_API_KEY", "GEMINI_API_KEY"]);
        let rendered = serde_json::to_string(&endpoint.env_keys).unwrap();
        assert!(!rendered.contains("bb_live_xxx"));
    }

    #[test]
    fn opencodes_single_array_command_parses_like_the_others() {
        let entry = serde_json::json!({
            "type": "local",
            "command": ["/Users/x/.canopy/bin/canopy-hook", "--mcp"],
            "enabled": true,
        });
        let endpoint = parse_opencode_entry(&entry).expect("parses");
        assert_eq!(
            dedupe_key(&endpoint),
            dedupe_key(&stdio("canopy-hook", &["--mcp"]))
        );
    }

    #[test]
    fn a_disabled_opencode_server_is_read_as_disabled() {
        let entry = serde_json::json!({
            "type": "local",
            "command": ["foo"],
            "enabled": false,
        });
        assert!(!parse_opencode_entry(&entry).expect("parses").enabled);
    }

    #[test]
    fn a_remote_entry_is_read_as_remote() {
        let entry = serde_json::json!({ "type": "sse", "url": "https://example.com/sse" });
        let endpoint = parse_claude_entry(&entry).expect("parses");
        assert_eq!(endpoint.transport, "sse");
        assert_eq!(endpoint.command, None);
    }

    #[test]
    fn codex_tables_parse_and_project_paths_are_not_servers() {
        let raw = r#"
model = "gpt-5"

[mcp_servers]
[mcp_servers.MCP_DOCKER]
command = 'docker'
args = ['mcp', 'gateway', 'run']

[projects.'/Users/shoaib/Documents/GitHub/banana-app']
trust_level = 'trusted'

[mcp_servers.canopy]
command = "/Users/shoaib/.canopy/bin/canopy-hook"
args = ["--mcp"]

[mcp_servers.canopy.env]
CANOPY_CTX_PORT = "1234"
"#;
        let servers = parse_codex_toml(raw);
        let names: Vec<&str> = servers.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["MCP_DOCKER", "canopy"]);
        let canopy = &servers[1].1;
        assert_eq!(canopy.args, ["--mcp"]);
        assert_eq!(canopy.env_keys, ["CANOPY_CTX_PORT"]);
        assert_eq!(servers[0].1.args, ["mcp", "gateway", "run"]);
    }

    #[test]
    fn an_mcpjson_server_nobody_has_answered_for_is_pending() {
        let state =
            serde_json::json!({ "enabledMcpjsonServers": [], "disabledMcpjsonServers": [] });
        assert_eq!(mcpjson_status(Some(&state), "linear"), "pending");
        assert_eq!(mcpjson_status(None, "linear"), "pending");
        let approved = serde_json::json!({ "enabledMcpjsonServers": ["linear"] });
        assert_eq!(mcpjson_status(Some(&approved), "linear"), "enabled");
        let rejected = serde_json::json!({ "disabledMcpjsonServers": ["linear"] });
        assert_eq!(mcpjson_status(Some(&rejected), "linear"), "disabled");
        let blanket = serde_json::json!({ "enableAllProjectMcpServers": true });
        assert_eq!(mcpjson_status(Some(&blanket), "linear"), "enabled");
    }

    /// The case the whole feature exists for: the same server, configured in
    /// two CLIs under two names, is one row that knows about both.
    #[test]
    fn the_same_server_in_two_clis_collapses_to_one_row() {
        let mut collector = Collector::default();
        let source = |agent: &str, name: &str, status: &str| McpSource {
            agent: agent.into(),
            label: agent.into(),
            name: name.into(),
            config_path: "/tmp/x".into(),
            scope: "global".into(),
            status: status.into(),
        };
        collector.add(
            "browserbase",
            stdio("npx", &["@browserbasehq/mcp-server-browserbase"]),
            source("cursor", "browserbase", "disabled"),
        );
        collector.add(
            "bb",
            stdio(
                "/opt/homebrew/bin/npx",
                &["-y", "@browserbasehq/mcp-server-browserbase"],
            ),
            source("windsurf", "bb", "enabled"),
        );
        let servers = collector.finish();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].sources.len(), 2);
        // Named by the first config that had it, not by the last.
        assert_eq!(servers[0].name, "browserbase");
        // Off in one CLI and on in another is on, and the sources say where.
        assert!(servers[0].enabled);
    }

    #[test]
    fn env_var_names_are_unioned_across_configs() {
        let mut collector = Collector::default();
        let with_env = |keys: &[&str]| Endpoint {
            env_keys: keys.iter().map(|k| (*k).to_string()).collect(),
            ..stdio("npx", &["srv"])
        };
        let source = McpSource {
            agent: "cursor".into(),
            label: "Cursor".into(),
            name: "srv".into(),
            config_path: "/tmp/x".into(),
            scope: "global".into(),
            status: "enabled".into(),
        };
        collector.add("srv", with_env(&["A_KEY"]), source.clone());
        collector.add("srv", with_env(&["B_KEY", "A_KEY"]), source);
        assert_eq!(collector.finish()[0].env_keys, ["A_KEY", "B_KEY"]);
    }

    #[test]
    fn discovery_reads_a_whole_home_and_folds_it() {
        let dir = std::env::temp_dir().join(format!("canopy-mcp-{}", std::process::id()));
        let home = dir.join("home");
        let project = dir.join("project");
        std::fs::create_dir_all(home.join(".cursor")).unwrap();
        std::fs::create_dir_all(home.join(".codeium/windsurf")).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            home.join(".cursor/mcp.json"),
            r#"{"mcpServers":{"browserbase":{"command":"npx","args":["@browserbasehq/mcp-server-browserbase"],"env":{"BROWSERBASE_API_KEY":"bb_live_xxx"}}}}"#,
        )
        .unwrap();
        std::fs::write(
            home.join(".codeium/windsurf/mcp_config.json"),
            r#"{"mcpServers":{"browserbase":{"command":"npx","args":["-y","@browserbasehq/mcp-server-browserbase"]},"mastra":{"command":"npx","args":["-y","@mastra/mcp-docs-server"]}}}"#,
        )
        .unwrap();
        std::fs::write(
            home.join(".claude.json"),
            format!(
                r#"{{"projects":{{"{}":{{"disabledMcpjsonServers":["linear"]}}}}}}"#,
                project.display()
            ),
        )
        .unwrap();
        std::fs::write(
            project.join(".mcp.json"),
            r#"{"mcpServers":{"linear":{"type":"http","url":"https://mcp.linear.app/mcp"}}}"#,
        )
        .unwrap();

        let servers = discover(&home, std::slice::from_ref(&project));
        let names: Vec<&str> = servers.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["browserbase", "mastra", "linear"]);
        // Two CLIs, one server.
        assert_eq!(servers[0].sources.len(), 2);
        assert_eq!(servers[0].env_keys, ["BROWSERBASE_API_KEY"]);
        // Rejected for this project, so not reachable here.
        assert!(!servers[2].enabled);
        assert_eq!(servers[2].sources[0].status, "disabled");
        assert_eq!(servers[2].transport, "http");

        std::fs::remove_dir_all(&dir).ok();
    }
}
