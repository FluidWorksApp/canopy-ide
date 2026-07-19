//! Process-tree monitoring for PTY sessions.
//!
//! One global thread polls sysinfo every 2s while sessions exist and emits
//! `pty:stats` with per-session process trees (CPU %, memory). The frontend uses
//! this for two things: the runaway-process guard (threshold warnings + kill) and
//! the Agents panel (detecting agent CLIs like claude/codex/aider running inside
//! terminals). Also hosts the file-based agent hook bridge.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, Manager};

use crate::pty::PtyManager;

const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// Check listening ports every Nth poll. lsof forks a process, so it is the
/// costliest thing in the monitor loop, and a dev server's port changes roughly
/// once per session — 10s is far tighter than the fact ever moves.
const PORT_EVERY: u64 = 5;

#[derive(Serialize, Clone)]
pub struct ProcInfo {
    pub pid: u32,
    pub parent: Option<u32>,
    pub name: String,
    pub cmd: String,
    pub cpu: f32,
    pub mem_bytes: u64,
}

/// Whole-app resource usage: this process and every descendant.
#[derive(Serialize, Clone)]
pub struct AppStats {
    pub cpu: f32,
    pub mem_bytes: u64,
    pub procs: u32,
}

#[derive(Serialize, Clone)]
pub struct SessionStats {
    pub id: u32,
    pub title: String,
    pub cwd: String,
    pub total_cpu: f32,
    pub total_mem_bytes: u64,
    pub procs: Vec<ProcInfo>,
    /// TCP ports anything under this session is listening on, ascending.
    ///
    /// The highest-value fact about a terminal that isn't its output: it says
    /// "there is a dev server in here, on 5173" without you opening the tab and
    /// reading scrollback. Empty unless something is actually listening.
    pub ports: Vec<u16>,
}

static MONITOR_STARTED: AtomicBool = AtomicBool::new(false);

/// TCP listening ports for `pids`, as pid -> ports.
///
/// One lsof for every session rather than one per session: spawning a process
/// per terminal per poll would cost more than everything else the monitor does.
/// -F emits a stable machine format (a leading-letter field per line) instead of
/// the human table, whose columns shift with content.
///
/// Errors are swallowed to an empty map by design — lsof is missing on some
/// systems and refuses to answer for other users' processes. Ports are a garnish
/// on a status row, and no row should disappear because a port lookup failed.
#[cfg(unix)]
fn listening_ports(pids: &[u32]) -> HashMap<u32, Vec<u16>> {
    let mut out: HashMap<u32, Vec<u16>> = HashMap::new();
    if pids.is_empty() {
        return out;
    }
    let list = pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
    let Ok(res) = std::process::Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", &list, "-Fpn"])
        .output()
    else {
        return out;
    };
    let mut pid = 0_u32;
    for line in String::from_utf8_lossy(&res.stdout).lines() {
        let (tag, val) = line.split_at(1);
        match tag {
            // Fields stream in order: a p<pid> line, then the n<addr> lines
            // belonging to it, until the next p.
            "p" => pid = val.parse().unwrap_or(0),
            "n" => {
                // "127.0.0.1:5173", "*:8080", "[::1]:3000" — the port is after
                // the last colon in every form.
                if let Some(port) = val.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) {
                    let ports = out.entry(pid).or_default();
                    if !ports.contains(&port) {
                        ports.push(port);
                    }
                }
            }
            _ => {}
        }
    }
    out
}

#[cfg(not(unix))]
fn listening_ports(_pids: &[u32]) -> HashMap<u32, Vec<u16>> {
    HashMap::new()
}

pub fn start_monitor(app: AppHandle) {
    if MONITOR_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::Builder::new()
        .name("pty-monitor".into())
        .spawn(move || {
            let mut sys = System::new();
            let mut tick: u64 = 0;
            let mut last_ports: HashMap<u32, Vec<u16>> = HashMap::new();
            loop {
                thread::sleep(POLL_INTERVAL);
                let manager = app.state::<PtyManager>();
                let sessions: Vec<(u32, Option<u32>, String, String)> = {
                    let map = manager.sessions();
                    let guard = map.lock().unwrap();
                    guard
                        .values()
                        .map(|s| {
                            (
                                s.id,
                                s.pid,
                                s.title.lock().unwrap().clone(),
                                s.cwd.clone(),
                            )
                        })
                        .collect()
                };
                sys.refresh_processes(ProcessesToUpdate::All, true);

                // parent pid -> child pids
                let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
                for (pid, proc_) in sys.processes() {
                    if let Some(parent) = proc_.parent() {
                        children
                            .entry(parent.as_u32())
                            .or_default()
                            .push(pid.as_u32());
                    }
                }

                // Our own footprint: this process plus everything under it —
                // WebView helpers, language servers, PTY children and all. That
                // total is what "the app is using" honestly means, and it's the
                // number the memory-light claim has to answer to.
                let mut app_cpu = 0.0_f32;
                let mut app_mem = 0_u64;
                let mut app_procs = 0_u32;
                let mut queue = vec![std::process::id()];
                let mut seen: Vec<u32> = Vec::new();
                while let Some(pid) = queue.pop() {
                    if seen.contains(&pid) {
                        continue; // cycles are impossible in theory, cheap to rule out
                    }
                    seen.push(pid);
                    if let Some(p) = sys.process(Pid::from_u32(pid)) {
                        app_cpu += p.cpu_usage();
                        app_mem += p.memory();
                        app_procs += 1;
                    }
                    if let Some(kids) = children.get(&pid) {
                        queue.extend(kids);
                    }
                }
                let _ = app.emit(
                    "app:stats",
                    AppStats {
                        cpu: app_cpu,
                        mem_bytes: app_mem,
                        procs: app_procs,
                    },
                );

                // Session stats are only interesting when terminals exist, but
                // app stats above must keep flowing regardless — a project with
                // no terminal open still shows its footprint.
                if sessions.is_empty() {
                    continue;
                }

                let mut stats: Vec<SessionStats> = Vec::new();
                for (id, root_pid, title, cwd) in sessions {
                    let Some(root) = root_pid else { continue };
                    let mut procs: Vec<ProcInfo> = Vec::new();
                    let mut queue = vec![root];
                    while let Some(pid) = queue.pop() {
                        if let Some(p) = sys.process(Pid::from_u32(pid)) {
                            procs.push(ProcInfo {
                                pid,
                                parent: p.parent().map(|pp| pp.as_u32()),
                                name: p.name().to_string_lossy().to_string(),
                                cmd: p
                                    .cmd()
                                    .iter()
                                    .map(|c| c.to_string_lossy())
                                    .collect::<Vec<_>>()
                                    .join(" "),
                                cpu: p.cpu_usage(),
                                mem_bytes: p.memory(),
                            });
                        }
                        if let Some(kids) = children.get(&pid) {
                            queue.extend(kids);
                        }
                    }
                    stats.push(SessionStats {
                        id,
                        title,
                        cwd,
                        total_cpu: procs.iter().map(|p| p.cpu).sum(),
                        total_mem_bytes: procs.iter().map(|p| p.mem_bytes).sum(),
                        procs,
                        ports: Vec::new(),
                    });
                }

                // Ports last, and only every PORT_EVERY-th tick: lsof forks a
                // process, which is the most expensive thing in this loop, while
                // a dev server's port changes about once a session. One call
                // covers every pid of every session — a call per session would
                // put the cost back.
                if tick % PORT_EVERY == 0 {
                    let all: Vec<u32> = stats.iter().flat_map(|s| s.procs.iter().map(|p| p.pid)).collect();
                    let by_pid = listening_ports(&all);
                    if !by_pid.is_empty() {
                        for s in stats.iter_mut() {
                            let mut ports: Vec<u16> = s
                                .procs
                                .iter()
                                .filter_map(|p| by_pid.get(&p.pid))
                                .flatten()
                                .copied()
                                .collect();
                            ports.sort_unstable();
                            ports.dedup();
                            s.ports = ports;
                        }
                    }
                    last_ports = stats.iter().map(|s| (s.id, s.ports.clone())).collect();
                } else {
                    // Carry the last reading through the ticks that skip lsof,
                    // so the port doesn't blink out of the UI between polls.
                    for s in stats.iter_mut() {
                        if let Some(p) = last_ports.get(&s.id) {
                            s.ports = p.clone();
                        }
                    }
                }
                tick = tick.wrapping_add(1);
                let _ = app.emit("pty:stats", &stats);
            }
        })
        .expect("spawn pty monitor thread");
}

/// File-based agent hook bridge: any coding-CLI hook system (Claude Code hooks,
/// Codex hooks, ...) can append JSON lines to `~/.canopy/agent-events.jsonl`;
/// we tail it and re-emit each line as an `agent:event`. Works with any platform
/// that can run a shell command as a hook — fully offline, no server.
pub fn start_hook_bridge(app: AppHandle) {
    let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
    else {
        return;
    };
    let dir = std::path::PathBuf::from(home).join(".canopy");
    let file = dir.join("agent-events.jsonl");
    let _ = std::fs::create_dir_all(&dir);
    if !file.exists() {
        let _ = std::fs::write(&file, "");
    }
    thread::Builder::new()
        .name("hook-bridge".into())
        .spawn(move || {
            use std::io::{Read, Seek, SeekFrom};
            let mut offset = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
            loop {
                thread::sleep(Duration::from_millis(500));
                let Ok(meta) = std::fs::metadata(&file) else { continue };
                let len = meta.len();
                if len < offset {
                    offset = 0; // file truncated/rotated
                }
                if len == offset {
                    continue;
                }
                let Ok(mut f) = std::fs::File::open(&file) else { continue };
                if f.seek(SeekFrom::Start(offset)).is_err() {
                    continue;
                }
                let mut new_data = String::new();
                if f.read_to_string(&mut new_data).is_err() {
                    continue;
                }
                offset = len;
                for line in new_data.lines() {
                    let line = line.trim();
                    if !line.is_empty() {
                        let _ = app.emit("agent:event", line.to_string());
                    }
                }
            }
        })
        .expect("spawn hook bridge thread");
}

#[tauri::command]
pub async fn hook_bridge_path() -> Option<String> {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok()?;
    Some(
        std::path::PathBuf::from(home)
            .join(".canopy")
            .join("agent-events.jsonl")
            .to_string_lossy()
            .to_string(),
    )
}

/// One-click hook automation: writes hook entries into the agent CLI's own
/// config so its events stream into our bridge file. Idempotent (skips if the
/// bridge path is already referenced).
#[tauri::command]
pub async fn setup_agent_hooks(agent: String) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    let bridge = format!("{home}/.canopy/agent-events.jsonl");
    match agent.as_str() {
        "claude" => setup_claude_hooks(&home, &bridge),
        "codex" => setup_codex_hooks(&home, &bridge),
        _ => Err(format!("auto-setup not supported for {agent} yet")),
    }
}

/// Where the hook helper lives once installed. Hooks reference this stable path
/// rather than the app bundle, so they keep working across upgrades and don't
/// break if the app is moved.
fn helper_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    Ok(std::path::PathBuf::from(home)
        .join(".canopy")
        .join("bin")
        .join("canopy-hook"))
}

/// Copy the helper next to our own binary into ~/.canopy/bin. Called at
/// startup so a rebuilt helper always replaces the installed one.
pub fn install_hook_helper() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let src = exe
        .parent()
        .ok_or("no exe dir")?
        .join(if cfg!(windows) { "canopy-hook.exe" } else { "canopy-hook" });
    if !src.exists() {
        return Err(format!("hook helper not built at {}", src.display()));
    }
    let dst = helper_path()?;
    std::fs::create_dir_all(dst.parent().ok_or("no bin dir")?).map_err(|e| e.to_string())?;
    // Replacing a running binary fails on some platforms; remove first.
    let _ = std::fs::remove_file(&dst);
    std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o755));
    }
    Ok(())
}

/// Publish which projects opted in to cross-session context sharing, and their
/// roots. The helper reads this to decide who counts as a peer. Sharing is off
/// unless a project turns it on — one session's prompts landing in another's
/// context is a privacy decision the user makes, not a default.
#[tauri::command]
pub async fn set_context_scopes(scopes: serde_json::Value) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    let dir = std::path::PathBuf::from(&home).join(".canopy");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(
        dir.join("context-scopes.json"),
        serde_json::to_string_pretty(&scopes).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// Delete one session's digest — the user removing a restorable session they
/// no longer care about. Scoped by construction: the id becomes a file name
/// inside our own sessions dir, and anything with a path separator or `..` is
/// refused rather than allowed to escape it.
#[tauri::command]
pub async fn session_forget(session_id: String) -> Result<(), String> {
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return Err("invalid session id".into());
    }
    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    let path = std::path::PathBuf::from(&home)
        .join(".canopy")
        .join("sessions")
        .join(format!("{session_id}.json"));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        // Already gone is the desired end state, not a failure.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Claude's project-bucket name for a directory: every non-alphanumeric
/// character becomes `-`. Not just `/` — dots and underscores are rewritten
/// too, so `/a/b/.claude/worktrees/x` encodes to `-a-b--claude-worktrees-x`
/// (note the double hyphen where `/.` was). Only replacing `/` silently breaks
/// every worktree, because they all live under a dotted directory.
///
/// Lossy, therefore one-way: `-`, `_` and `.` all encode to `-`, so a bucket
/// name cannot be decoded back into a path. Candidates get encoded and
/// compared; a bucket is never decoded.
fn claude_bucket(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// The bucket that actually holds `session_id`'s transcript, found by scanning
/// the project dirs for the file itself.
///
/// Deterministic: an exact filename match on a uuid. Never newest-by-mtime and
/// never a title match — those guess, and a wrong guess resumes a stranger's
/// conversation.
fn transcript_bucket(session_id: &str) -> Option<String> {
    let root = std::path::PathBuf::from(std::env::var("HOME").ok()?).join(".claude/projects");
    let name = format!("{session_id}.jsonl");
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        if entry.path().join(&name).exists() {
            return Some(entry.file_name().to_string_lossy().to_string());
        }
    }
    None
}

/// Where an agent's `--resume` has to run, and whether there is anything to
/// resume.
///
/// Claude files a conversation under the directory the session was *launched*
/// in, and `--resume` only finds it from that same directory. The cwd a hook
/// reports drifts when the agent cds mid-session — starting at a repo root and
/// moving into a worktree is routine — so resuming from the reported cwd fails
/// with "No conversation found". Walk *up* from it instead, re-encoding each
/// ancestor until one matches the bucket that really holds the transcript.
///
/// That bucket is found on disk rather than taken from the `transcript_path`
/// the hook reported: the hook fires at SessionStart, so its path is only a
/// promise of where the file will go, and it is written before any cd.
fn resume_location(digest: &serde_json::Value) -> (String, bool) {
    // Prefer where the session was launched. `cwd` follows the agent as it cds,
    // and is only a fallback for digests written before launch_cwd existed.
    let cwd = digest["launch_cwd"]
        .as_str()
        .or_else(|| digest["cwd"].as_str())
        .unwrap_or("")
        .to_string();
    let Some(session_id) = digest["session_id"].as_str() else {
        // Agents other than claude don't report one. Don't block restore on a
        // check we can't perform.
        return (cwd, true);
    };

    // Nothing on disk anywhere: the agent started but was never talked to, or
    // died before writing. Every `--resume` against it fails, so callers must
    // not offer the button.
    let Some(bucket) = transcript_bucket(session_id) else {
        return (cwd, false);
    };

    let mut probe = std::path::PathBuf::from(&cwd);
    loop {
        if claude_bucket(&probe.to_string_lossy()) == bucket {
            return (probe.to_string_lossy().to_string(), true);
        }
        if !probe.pop() {
            // The transcript exists, but no ancestor of the recorded cwd maps
            // to its bucket — it was launched outside this path entirely.
            // Resume from here would fail, so say so rather than offer a button
            // that reports "No conversation found".
            return (cwd, false);
        }
    }
}

/// Live digests of agent sessions, for showing the user exactly what would be
/// shared, and for restoring sessions after a crash.
#[tauri::command]
pub async fn session_digests() -> Result<Vec<serde_json::Value>, String> {
    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    let dir = std::path::PathBuf::from(&home).join(".canopy").join("sessions");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        if entry.path().extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(raw) = std::fs::read_to_string(entry.path()) {
            if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&raw) {
                let (root, resumable) = resume_location(&v);
                if let Some(map) = v.as_object_mut() {
                    map.insert("resume_cwd".into(), serde_json::json!(root));
                    map.insert("resumable".into(), serde_json::json!(resumable));
                }
                out.push(v);
            }
        }
    }
    Ok(out)
}

fn setup_claude_hooks(home: &str, bridge: &str) -> Result<String, String> {
    let dir = std::path::PathBuf::from(home).join(".claude");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("settings.json");
    let mut settings: serde_json::Value = if path.exists() {
        let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).map_err(|e| format!("~/.claude/settings.json is not valid JSON: {e}"))?
    } else {
        serde_json::json!({})
    };

    // Every event goes through our helper binary: it mirrors the event onto the
    // bus, updates the session digest, and (on SessionStart/UserPromptSubmit)
    // prints peer context back to the agent.
    //
    // These hooks live in the user's global ~/.claude/settings.json and fire for
    // *every* claude on the machine, including ones in iTerm that have nothing
    // to do with this app. The helper gates itself on $CANOPY, which only
    // PTYs we spawn export (pty.rs), so foreign sessions are ignored entirely.
    let _ = bridge; // the helper resolves the bus path itself
    let helper = helper_path()?;
    // Never register a hook pointing at a binary that isn't there. Claude runs
    // hook commands without reporting failures, so a missing helper is not an
    // error the user would ever see — it just looks like the feature silently
    // does nothing. Refuse loudly instead.
    if !helper.exists() {
        return Err(format!(
            "hook helper missing at {} — hooks not installed (build it with \
             `cargo build --bin canopy-hook`)",
            helper.display()
        ));
    }
    // Substrings identifying a hook entry as one of ours, across every version
    // we have shipped: the original inline shell command wrote to
    // agent-events.jsonl, later ones invoke the helper binary out of our state
    // dir. Matching all of them means an upgrade replaces its predecessor
    // instead of stacking a dead hook beside it. Hooks the user wrote match
    // none of these and are left alone. Add to this list on any future rename.
    const MARKERS: &[&str] = &["agent-events.jsonl", "canopy-hook", ".canopy/"];

    let command = helper.to_string_lossy().to_string();
    let make_entry = |matcher: Option<&str>| {
        let mut entry = serde_json::json!({
            "hooks": [ { "type": "command", "command": command } ]
        });
        if let Some(m) = matcher {
            entry["matcher"] = serde_json::json!(m);
        }
        entry
    };

    let hooks = settings
        .as_object_mut()
        .ok_or("settings.json is not an object")?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));
    let hooks = hooks.as_object_mut().ok_or("hooks is not an object")?;
    let mut changed = 0;
    // PreToolUse:AskUserQuestion captures questionnaires before they block.
    // UserPromptSubmit and SessionStart are the only two events that can inject
    // context back into a session — the rest are observation only.
    for (event, matcher) in [
        ("PostToolUse", None),
        ("Stop", None),
        ("Notification", None),
        ("UserPromptSubmit", None),
        ("SessionStart", None),
        ("PreToolUse", Some("AskUserQuestion")),
    ] {
        let list = hooks.entry(event).or_insert_with(|| serde_json::json!([]));
        let Some(arr) = list.as_array_mut() else { continue };
        let want = make_entry(matcher);
        if arr.iter().any(|e| e == &want) {
            continue; // already exactly what we install
        }
        // Drop any older bridge hook of ours (see MARKERS) and reinstall the
        // current one, so an upgrade replaces its predecessor rather than
        // stacking a dead hook beside it.
        arr.retain(|e| {
            let s = e.to_string();
            !MARKERS.iter().any(|m| s.contains(m))
        });
        arr.push(want);
        changed += 1;
    }
    if changed == 0 {
        return Ok("Claude Code hooks already set up".into());
    }

    std::fs::write(
        &path,
        serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(format!(
        "Claude Code hooks installed ({changed} events) — restart claude sessions to pick them up"
    ))
}

fn setup_codex_hooks(home: &str, bridge: &str) -> Result<String, String> {
    let dir = std::path::PathBuf::from(home).join(".codex");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("config.toml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if existing.contains("agent-events.jsonl") {
        return Ok("Codex hooks already set up".into());
    }
    if existing.lines().any(|l| l.trim_start().starts_with("notify")) {
        return Err("Codex config already has a custom `notify` — add the bridge append manually".into());
    }
    // Codex passes the notification JSON as an argument, not stdin.
    let line = format!(
        "notify = [\"/bin/sh\", \"-c\", \"printf '%s\\\\n' \\\"$0\\\" >> {bridge}\"]\n"
    );
    std::fs::write(&path, format!("{existing}\n{line}")).map_err(|e| e.to_string())?;
    Ok("Codex notify hook installed (~/.codex/config.toml)".into())
}

#[derive(Serialize, Clone, Default)]
pub struct ClaudeSessionStats {
    pub model: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub turns: u64,
}

/// Aggregate token usage + model from a Claude Code session transcript
/// (~/.claude/projects/**/*.jsonl — the path arrives via hook events).
/// Powers the status tray (model / tokens / cost).
#[tauri::command]
pub async fn claude_session_stats(transcript_path: String) -> Result<ClaudeSessionStats, String> {
    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    let path = std::path::Path::new(&transcript_path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let claude_dir = std::path::PathBuf::from(&home).join(".claude");
    if !path.starts_with(&claude_dir) || path.extension().and_then(|e| e.to_str()) != Some("jsonl")
    {
        return Err("not a claude transcript".into());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut stats = ClaudeSessionStats::default();
    for line in raw.lines() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if entry["type"] != "assistant" {
            continue;
        }
        let message = &entry["message"];
        if let Some(model) = message["model"].as_str() {
            stats.model = Some(model.to_string());
        }
        let usage = &message["usage"];
        stats.input_tokens += usage["input_tokens"].as_u64().unwrap_or(0);
        stats.output_tokens += usage["output_tokens"].as_u64().unwrap_or(0);
        stats.cache_read_tokens += usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
        stats.cache_creation_tokens += usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
        stats.turns += 1;
    }
    Ok(stats)
}

/// Check which commands exist on the user's login-shell PATH (GUI apps don't
/// inherit it). Used by the agent-CLI launcher to offer launch vs. install.
#[tauri::command]
pub async fn which_check(commands: Vec<String>) -> HashMap<String, bool> {
    let mut result: HashMap<String, bool> =
        commands.iter().map(|c| (c.clone(), false)).collect();
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let script = commands
            .iter()
            .filter(|c| c.chars().all(|ch| ch.is_alphanumeric() || ch == '-' || ch == '_'))
            .map(|c| format!("command -v {c} >/dev/null 2>&1 && echo {c}"))
            .collect::<Vec<_>>()
            .join("; ");
        if let Ok(out) = std::process::Command::new(shell)
            .args(["-lc", &script])
            .output()
        {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                if let Some(found) = result.get_mut(line.trim()) {
                    *found = true;
                }
            }
        }
    }
    result
}

/// Kill an arbitrary process (used by the Agents panel / runaway guard for
/// killing a specific process inside a session without tearing the session down).
#[tauri::command]
pub async fn kill_process(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
        if result == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error().to_string())
        }
    }
    #[cfg(windows)]
    {
        Err("not implemented on windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::claude_bucket;

    /// Mirrors the encoding claude applies to bucket directories under
    /// ~/.claude/projects. The `.claude/worktrees` case is the isolation model,
    /// and `/` -> `-` alone gets all three cases wrong.
    #[test]
    fn bucket_encodes_every_non_alphanumeric() {
        assert_eq!(
            claude_bucket("/Users/dev/Projects/my-app/backend/.claude/worktrees/feat"),
            "-Users-dev-Projects-my-app-backend--claude-worktrees-feat",
            "a dot must encode to '-', giving '--claude' where '/.' was"
        );
        assert_eq!(
            claude_bucket("/private/var/folders/d1/2vxk8gl_1mxz/T/scratch"),
            "-private-var-folders-d1-2vxk8gl-1mxz-T-scratch",
            "an underscore must encode to '-'"
        );
        assert_eq!(
            claude_bucket("/Users/dev/Projects/my-demo"),
            "-Users-dev-Projects-my-demo",
            "an existing hyphen survives unchanged"
        );
    }

    /// The encoding is many-to-one, which is why a bucket name is never decoded
    /// back into a path — candidates are encoded and compared instead.
    #[test]
    fn bucket_encoding_is_lossy() {
        assert_eq!(claude_bucket("/a/b-c"), claude_bucket("/a/b_c"));
        assert_eq!(claude_bucket("/a/b.c"), claude_bucket("/a/b-c"));
    }
}
