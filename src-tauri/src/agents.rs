//! Process-tree monitoring for PTY sessions.
//!
//! One global thread polls sysinfo every 2s while sessions exist and emits
//! `pty:stats` with per-session process trees (CPU %, memory). The frontend uses
//! this for two things: the runaway-process guard (threshold warnings + kill) and
//! the Agents panel, which needs to know what each terminal is running — one
//! candidate per session, identified in agentid.rs rather than guessed from the
//! names in its process tree. Also hosts the file-based agent hook bridge.

#[cfg(windows)]
use crate::winproc::NoConsoleWindow;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Emitter, Manager};

use crate::agentid::AgentHint;
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

/// A live terminal as the monitor sees it before it walks any processes.
struct SessionMeta {
    id: u32,
    /// The process we spawned the terminal with — usually the shell.
    root: Option<u32>,
    title: String,
    cwd: String,
    /// Process group the pty currently has in the foreground.
    foreground: Option<u32>,
    /// The foreground app has the tty in raw mode.
    interactive: bool,
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
    /// What this terminal is running, when it is running anything: the
    /// evidence the frontend needs to name the session, resolved from the
    /// foreground process's executable. See agentid.rs — in particular, this
    /// is deliberately evidence and not a verdict.
    pub agent_hint: Option<AgentHint>,
}

/// The one process worth identifying in a terminal.
///
/// The foreground process group is what the terminal is running, but the leader
/// can be a tool the agent shelled out to (a pager, `git`, a language server) —
/// so climb from it to the direct child of the session's shell. That child is
/// the thing the user launched, and it stays the answer for as long as it lives,
/// whatever it spawns underneath.
fn candidate_pid(
    sys: &System,
    root: u32,
    foreground: Option<u32>,
    children: &HashMap<u32, Vec<u32>>,
) -> Option<u32> {
    let name_of = |pid: u32| {
        sys.process(Pid::from_u32(pid))
            .map(|p| p.name().to_string_lossy().to_string())
            .unwrap_or_default()
    };
    let parent_of = |pid: u32| {
        sys.process(Pid::from_u32(pid))
            .and_then(|p| p.parent())
            .map(|p| p.as_u32())
    };
    // A terminal Canopy launched the CLI in directly (or that the user exec'd
    // over) has no shell to be a child of — the session root is the program.
    let root_is_shell = crate::agentid::is_shell(&name_of(root));
    if let Some(fg) = foreground {
        if fg == root {
            // The shell itself holds the terminal: it is sitting at its prompt.
            return (!root_is_shell).then_some(root);
        }
        let mut pid = fg;
        // Bounded: a corrupt parent chain must not spin the monitor thread.
        for _ in 0..64 {
            match parent_of(pid) {
                Some(parent) if parent == root => return Some(pid),
                Some(parent) => pid = parent,
                None => break,
            }
        }
    }
    // No foreground group to ask (Windows, or a pty that has gone away). The
    // only non-shell child of the session is the same answer whenever a
    // terminal is running exactly one thing, which is the case that matters.
    if !root_is_shell {
        return Some(root);
    }
    let mut kids = children
        .get(&root)
        .into_iter()
        .flatten()
        .copied()
        .filter(|pid| !crate::agentid::is_shell(&name_of(*pid)));
    let only = kids.next()?;
    kids.next().is_none().then_some(only)
}

/// The most recent `pty:stats` reading, kept so the context bridge can serve
/// live CPU/memory to agents (canopy_resources) without re-deriving it — the
/// monitor loop already pays for the sysinfo walk once per tick.
#[derive(Default)]
pub struct StatsCache(pub std::sync::Mutex<Vec<SessionStats>>);

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
    let list = pids
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join(",");
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
            // Lives across ticks: identification is filesystem work, and the
            // answer for a given binary only changes when it is reinstalled.
            let mut resolver = crate::agentid::Resolver::default();
            loop {
                thread::sleep(POLL_INTERVAL);
                tick = tick.wrapping_add(1);
                let manager = app.state::<PtyManager>();
                // Clone the handles out, then ask each pty what it has in the
                // foreground: that reads the pty's own state, and doing it
                // while holding the session map would block every spawn and
                // close for the duration.
                let live: Vec<std::sync::Arc<crate::pty::Session>> = {
                    let map = manager.sessions();
                    let guard = map.lock().unwrap();
                    guard.values().cloned().collect()
                };
                let sessions: Vec<SessionMeta> = live
                    .iter()
                    .map(|s| SessionMeta {
                        id: s.id,
                        root: s.pid,
                        title: s.title.lock().unwrap().clone(),
                        cwd: s.cwd.clone(),
                        foreground: s.foreground_pid(),
                        interactive: s.raw_mode(),
                    })
                    .collect();
                // With no terminals there is nothing hot to watch — only the
                // app-footprint number in the status bar, which nobody needs at
                // 2s resolution. Skip two of every three ticks entirely.
                if sessions.is_empty() && tick % 3 != 0 {
                    continue;
                }
                // Refresh only what the monitor actually reads. The default
                // full refresh re-fetches every process's cmdline, exe path,
                // environment and cwd — each a sysctl/proc read, for every
                // process on the machine, every tick. cmd and exe are the
                // non-cheap fields we use (identification / restore), and
                // neither changes after exec — fetch once per process and keep.
                // On macOS exe costs nothing on top of cmd: both come out of
                // the same KERN_PROCARGS2 read that already fills in the name.
                sys.refresh_processes_specifics(
                    ProcessesToUpdate::All,
                    true,
                    ProcessRefreshKind::nothing()
                        .with_cpu()
                        .with_memory()
                        .with_cmd(UpdateKind::OnlyIfNotSet)
                        .with_exe(UpdateKind::OnlyIfNotSet),
                );

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
                for meta in sessions {
                    let SessionMeta {
                        id,
                        root,
                        title,
                        cwd,
                        foreground,
                        interactive,
                    } = meta;
                    let Some(root) = root else { continue };
                    // What this terminal is running, identified once from the
                    // foreground process rather than guessed from every name in
                    // the tree. None means an idle shell — or a program we can
                    // see but cannot name, which the frontend renders as itself.
                    let agent_hint = candidate_pid(&sys, root, foreground, &children)
                        .and_then(|pid| {
                            let p = sys.process(Pid::from_u32(pid))?;
                            let argv: Vec<String> = p
                                .cmd()
                                .iter()
                                .map(|c| c.to_string_lossy().to_string())
                                .collect();
                            resolver.hint(&argv, p.exe(), std::path::Path::new(&cwd))
                        })
                        .map(|hint| AgentHint {
                            interactive,
                            ..hint
                        });
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
                        agent_hint,
                    });
                }

                // Ports last, and only every PORT_EVERY-th tick: lsof forks a
                // process, which is the most expensive thing in this loop, while
                // a dev server's port changes about once a session. One call
                // covers every pid of every session — a call per session would
                // put the cost back.
                if tick % PORT_EVERY == 0 {
                    let all: Vec<u32> = stats
                        .iter()
                        .flat_map(|s| s.procs.iter().map(|p| p.pid))
                        .collect();
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
                if let Some(cache) = app.try_state::<StatsCache>() {
                    *cache.0.lock().unwrap() = stats.clone();
                }
                let _ = app.emit("pty:stats", &stats);
            }
        })
        .expect("spawn pty monitor thread");
}

/// File-based agent hook bridge: any coding-CLI hook system (Claude Code hooks,
/// Codex hooks, ...) can append JSON lines to `~/.canopy/agent-events.jsonl`;
/// we tail it and emit each poll's new lines as one `agent:events` batch — a
/// busy agent writes several lines per 500ms window, and each emit costs a
/// React commit on the other side. Works with any platform that can run a
/// shell command as a hook — fully offline, no server.
pub fn start_hook_bridge(app: AppHandle) {
    let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) else {
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
                let Ok(meta) = std::fs::metadata(&file) else {
                    continue;
                };
                let len = meta.len();
                if len < offset {
                    offset = 0; // file truncated/rotated
                }
                if len == offset {
                    continue;
                }
                let Ok(mut f) = std::fs::File::open(&file) else {
                    continue;
                };
                if f.seek(SeekFrom::Start(offset)).is_err() {
                    continue;
                }
                let mut new_data = String::new();
                if f.read_to_string(&mut new_data).is_err() {
                    continue;
                }
                offset = len;
                let batch: Vec<String> = new_data
                    .lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .map(str::to_string)
                    .collect();
                if !batch.is_empty() {
                    let _ = app.emit("agent:events", batch);
                }
            }
        })
        .expect("spawn hook bridge thread");
}

#[tauri::command]
pub async fn hook_bridge_path() -> Option<String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    Some(
        std::path::PathBuf::from(home)
            .join(".canopy")
            .join("agent-events.jsonl")
            .to_string_lossy()
            .to_string(),
    )
}

/// Every CLI Canopy knows how to wire up, with the binary that proves it is
/// installed. One list, so the panel, the health check and the startup repair
/// can't drift apart about who is supported.
pub const SUPPORTED_AGENTS: &[(&str, &str)] = &[
    ("claude", "claude"),
    ("codex", "codex"),
    ("agy", "agy"),
    ("aider", "aider"),
    ("opencode", "opencode"),
    ("omp", "omp"),
    ("amp", "amp"),
];

/// What one step of an agent's setup did. Steps are reported individually
/// because they fail independently: an MCP registry that can't be parsed says
/// nothing about whether the hooks landed, and collapsing the two into a single
/// Result meant one failure erased the other's result entirely.
#[derive(serde::Serialize, Clone, Debug)]
pub struct SetupStep {
    pub step: String,
    pub ok: bool,
    pub message: String,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct SetupReport {
    pub agent: String,
    /// True only when every step succeeded.
    pub ok: bool,
    pub steps: Vec<SetupStep>,
    /// One line for a toast, naming the agent and any step that failed.
    pub summary: String,
}

/// One-click hook automation: writes hook entries into the agent CLI's own
/// config so its events stream into our bridge file, and registers the MCP
/// server so the agent can ask the IDE for context back. Idempotent — every
/// step skips when the config already says what it would write.
#[tauri::command]
pub async fn setup_agent_hooks(agent: String) -> Result<SetupReport, String> {
    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    setup_agent(&agent, &home)
}

/// The sync core, against an explicit home: shared by the command and by the
/// startup repair, and the seam the tests drive.
pub fn setup_agent(agent: &str, home: &str) -> Result<SetupReport, String> {
    let bridge = format!("{home}/.canopy/agent-events.jsonl");
    // Eager, not `?`-chained: every step runs even when an earlier one failed,
    // so the report says what actually happened to each.
    let steps: Vec<(&str, Result<String, String>)> = match agent {
        "claude" => vec![
            ("hooks", setup_claude_hooks(home, &bridge)),
            ("mcp", setup_claude_mcp(home)),
        ],
        "codex" => vec![
            ("hooks", setup_codex_hooks(home, &bridge)),
            ("mcp", setup_codex_mcp(home)),
        ],
        "agy" => vec![
            ("hooks", setup_agy_hooks(home)),
            ("mcp", setup_agy_mcp(home)),
        ],
        "aider" => vec![("hooks", setup_aider_hooks(home))],
        "opencode" => vec![
            ("hooks", setup_opencode_plugin(home)),
            ("mcp", setup_opencode_mcp(home)),
        ],
        "omp" => vec![("hooks", setup_omp_hook(home))],
        "amp" => vec![("hooks", setup_amp_plugin(home))],
        _ => return Err(format!("auto-setup not supported for {agent} yet")),
    };
    let steps: Vec<SetupStep> = steps
        .into_iter()
        .map(|(step, result)| SetupStep {
            step: step.into(),
            ok: result.is_ok(),
            message: match result {
                Ok(m) => m,
                Err(e) => e,
            },
        })
        .collect();
    let ok = steps.iter().all(|s| s.ok);
    let summary = if ok {
        format!(
            "{agent}: {}",
            steps
                .iter()
                .map(|s| s.message.as_str())
                .collect::<Vec<_>>()
                .join("; ")
        )
    } else {
        format!(
            "{agent}: {}",
            steps
                .iter()
                .filter(|s| !s.ok)
                .map(|s| format!("{} failed — {}", s.step, s.message))
                .collect::<Vec<_>>()
                .join("; ")
        )
    };
    Ok(SetupReport {
        agent: agent.into(),
        ok,
        steps,
        summary,
    })
}

/// The config file each agent's hooks live in — the same file its `setup_*`
/// writes to, so ownership is read from where it was written rather than
/// re-derived.
fn hooks_config_path(agent: &str, home: &str) -> Option<String> {
    Some(match agent {
        "claude" => format!("{home}/.claude/settings.json"),
        "codex" => format!("{home}/.codex/config.toml"),
        "aider" => format!("{home}/.aider.conf.yml"),
        "agy" => format!("{home}/.gemini/antigravity-cli/hooks.json"),
        "opencode" => format!("{home}/.config/opencode/plugin/canopy.ts"),
        "omp" => format!("{home}/.omp/agent/hooks/canopy.ts"),
        "amp" => format!("{home}/.config/amp/plugins/canopy.ts"),
        _ => return None,
    })
}

/// Whether our hooks are already present in an agent CLI's config, read-only.
/// The panel needs this to tell "hooks aren't installed" (offer to set them up)
/// apart from "hooks are installed, but these agents predate them" (restart to
/// stream) — two states a missing session digest alone can't distinguish. A
/// config file that references any of our MARKERS is one we've hooked.
#[tauri::command]
pub async fn agent_hooks_installed(agent: String) -> bool {
    let Ok(home) = std::env::var("HOME") else {
        return false;
    };
    hooks_are_ours(&agent, &home)
}

fn hooks_are_ours(agent: &str, home: &str) -> bool {
    let Some(config) = hooks_config_path(agent, home) else {
        return false;
    };
    match std::fs::read_to_string(&config) {
        Ok(raw) => MARKERS.iter().any(|m| raw.contains(m)),
        Err(_) => false,
    }
}

/// Aider has no hook system, but `notifications-command` runs an arbitrary
/// command whenever it is waiting for input — after a turn AND at y/n
/// confirms (verified in its io.py). The helper's --event mode synthesizes
/// the JSON aider can't provide; session identity is per-terminal, which is
/// enough for cards and deliberately never enough to look restorable.
fn setup_aider_hooks(home: &str) -> Result<String, String> {
    let helper = require_helper(home, "hooks not installed")?;
    let path = std::path::PathBuf::from(home).join(".aider.conf.yml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if existing.contains("canopy-hook") {
        return Ok("Aider notifications already set up".into());
    }
    if existing.contains("notifications") {
        return Err(
            "~/.aider.conf.yml already configures notifications — point \
             notifications-command at canopy-hook manually"
                .into(),
        );
    }
    let block = format!(
        "\n# canopy: surface \"waiting for input\" in the IDE\nnotifications: true\nnotifications-command: {} --agent aider --event Notification --message \"Aider is waiting for your input\"\n",
        helper.to_string_lossy()
    );
    std::fs::write(&path, format!("{existing}{block}")).map_err(|e| e.to_string())?;
    Ok("Aider notifications hooked (~/.aider.conf.yml) — restart aider sessions".into())
}

/// Write a generated integration file, idempotently.
fn install_generated_file(
    path: std::path::PathBuf,
    source: &str,
    ok_msg: &str,
    already_msg: &str,
) -> Result<String, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if std::fs::read_to_string(&path)
        .map(|s| s == source)
        .unwrap_or(false)
    {
        return Ok(already_msg.into());
    }
    std::fs::write(&path, source).map_err(|e| e.to_string())?;
    Ok(ok_msg.into())
}

/// OpenCode: JS plugins in ~/.config/opencode/plugin/ receive the full event
/// bus (permission.asked, session.idle, tool.execute, ...). The generated
/// plugin forwards normalized events to the helper over stdin, so gating,
/// pty stamping and digests all come along.
fn setup_opencode_plugin(home: &str) -> Result<String, String> {
    let helper = require_helper(home, "hooks not installed")?;
    const TEMPLATE: &str = r#"// Canopy IDE bridge — generated by Canopy, edits will be overwritten.
// Forwards OpenCode bus events to Canopy's hook helper. Fails silent by
// design: this must never break the session it observes.
import { spawn } from "node:child_process"

const HELPER = "__HELPER__"

const send = (obj) => {
  try {
    if (process.env.CANOPY !== "1") return
    const child = spawn(HELPER, ["--agent", "opencode"], { stdio: ["pipe", "ignore", "ignore"] })
    child.on("error", () => {})
    child.stdin.write(JSON.stringify(obj))
    child.stdin.end()
  } catch {}
}

export const CanopyBridge = async ({ directory }) => {
  const sid = (e) =>
    e?.properties?.sessionID ?? e?.properties?.info?.sessionID ?? e?.properties?.info?.id ?? ""
  const base = (e) => ({ session_id: sid(e), cwd: directory, agent: "opencode" })
  return {
    event: async ({ event }) => {
      try {
        switch (event?.type) {
          case "session.created":
            send({ ...base(event), hook_event_name: "SessionStart" })
            break
          case "session.idle":
            send({ ...base(event), hook_event_name: "Stop" })
            break
          case "permission.asked":
            send({
              ...base(event),
              hook_event_name: "Notification",
              message: `OpenCode needs permission: ${event?.properties?.title ?? event?.properties?.type ?? "tool"}`,
            })
            break
          case "file.edited":
            send({
              ...base(event),
              hook_event_name: "PostToolUse",
              tool_name: "Edit",
              tool_input: { file_path: event?.properties?.file ?? "" },
            })
            break
        }
      } catch {}
    },
    "tool.execute.after": async (input) => {
      try {
        send({
          session_id: input?.sessionID ?? "",
          cwd: directory,
          agent: "opencode",
          hook_event_name: "PostToolUse",
          tool_name: input?.tool ?? "",
        })
      } catch {}
    },
  }
}
"#;
    let source = TEMPLATE.replace("__HELPER__", &helper.to_string_lossy());
    install_generated_file(
        std::path::PathBuf::from(home)
            .join(".config")
            .join("opencode")
            .join("plugin")
            .join("canopy.ts"),
        &source,
        "OpenCode plugin installed — restart opencode sessions to load it",
        "OpenCode plugin already set up",
    )
}

/// oh-my-pi: TS hook modules auto-discovered from ~/.omp/agent/hooks/. Its
/// hook API is in flux (hooks vs extensions), so registration is defensive —
/// whatever events exist fire, the rest are ignored.
fn setup_omp_hook(home: &str) -> Result<String, String> {
    let helper = require_helper(home, "hooks not installed")?;
    const TEMPLATE: &str = r#"// Canopy IDE bridge — generated by Canopy, edits will be overwritten.
// Forwards oh-my-pi events to Canopy's hook helper. Defensive on purpose:
// omp's hook API is documented as in flux, so every registration and field
// access tolerates absence, and nothing here may throw into the host.
import { spawn } from "node:child_process"

const HELPER = "__HELPER__"

const send = (obj) => {
  try {
    if (process.env.CANOPY !== "1") return
    const child = spawn(HELPER, ["--agent", "omp"], { stdio: ["pipe", "ignore", "ignore"] })
    child.on("error", () => {})
    child.stdin.write(JSON.stringify(obj))
    child.stdin.end()
  } catch {}
}

export default function canopyBridge(pi) {
  const base = () => ({
    cwd: process.cwd(),
    agent: "omp",
    session_id:
      pi?.session?.id ?? pi?.sessionId ?? `omp-pty${process.env.CANOPY_PTY ?? ""}`,
  })
  const on = (ev, fn) => {
    try {
      pi?.on?.(ev, fn)
    } catch {}
  }
  on("session_start", () => send({ ...base(), hook_event_name: "SessionStart" }))
  on("turn_start", (ctx) =>
    send({
      ...base(),
      hook_event_name: "UserPromptSubmit",
      prompt: ctx?.prompt ?? ctx?.input ?? "",
    }),
  )
  on("turn_end", () => send({ ...base(), hook_event_name: "Stop" }))
  on("tool_result", (ctx) =>
    send({
      ...base(),
      hook_event_name: "PostToolUse",
      tool_name: ctx?.tool?.name ?? ctx?.name ?? "",
    }),
  )
  on("tool_approval_requested", (ctx) =>
    send({
      ...base(),
      hook_event_name: "Notification",
      message: `oh-my-pi needs approval: ${ctx?.tool?.name ?? "a tool"}`,
    }),
  )
}
"#;
    let source = TEMPLATE.replace("__HELPER__", &helper.to_string_lossy());
    install_generated_file(
        std::path::PathBuf::from(home)
            .join(".omp")
            .join("agent")
            .join("hooks")
            .join("canopy.ts"),
        &source,
        "oh-my-pi hook installed — restart omp sessions to load it",
        "oh-my-pi hook already set up",
    )
}

/// Amp: TS plugins in ~/.config/amp/plugins/ with session/agent/tool events.
/// Threads live server-side, so AMP_THREAD_ID (when present) is the session
/// identity; otherwise per-terminal, same as aider.
fn setup_amp_plugin(home: &str) -> Result<String, String> {
    let helper = require_helper(home, "hooks not installed")?;
    const TEMPLATE: &str = r#"// Canopy IDE bridge — generated by Canopy, edits will be overwritten.
// Forwards Amp plugin events to Canopy's hook helper. Fails silent by design.
import { spawn } from "node:child_process"

const HELPER = "__HELPER__"

const send = (obj) => {
  try {
    if (process.env.CANOPY !== "1") return
    const child = spawn(HELPER, ["--agent", "amp"], { stdio: ["pipe", "ignore", "ignore"] })
    child.on("error", () => {})
    child.stdin.write(JSON.stringify(obj))
    child.stdin.end()
  } catch {}
}

export default function canopyBridge(amp) {
  const base = (ctx) => ({
    cwd: process.cwd(),
    agent: "amp",
    session_id:
      ctx?.threadId ?? process.env.AMP_THREAD_ID ?? `amp-pty${process.env.CANOPY_PTY ?? ""}`,
  })
  const on = (ev, fn) => {
    try {
      amp?.on?.(ev, fn)
    } catch {}
  }
  on("session.start", (ctx) => send({ ...base(ctx), hook_event_name: "SessionStart" }))
  on("agent.start", (ctx) =>
    send({ ...base(ctx), hook_event_name: "UserPromptSubmit", prompt: ctx?.prompt ?? "" }),
  )
  on("agent.end", (ctx) => send({ ...base(ctx), hook_event_name: "Stop" }))
  on("tool.result", (ctx) =>
    send({ ...base(ctx), hook_event_name: "PostToolUse", tool_name: ctx?.tool ?? "" }),
  )
}
"#;
    let source = TEMPLATE.replace("__HELPER__", &helper.to_string_lossy());
    install_generated_file(
        std::path::PathBuf::from(home)
            .join(".config")
            .join("amp")
            .join("plugins")
            .join("canopy.ts"),
        &source,
        "Amp plugin installed — restart amp sessions to load it",
        "Amp plugin already set up",
    )
}

/// Antigravity CLI hooks: register the helper for all five of its events in
/// ~/.gemini/antigravity-cli/hooks.json, under our own named group so
/// reinstalls replace it and user-authored groups are never touched. Also
/// best-effort enables its OSC 9 `notifications` setting — Canopy's terminals
/// already parse OSC 9, so that alone surfaces "waiting for you" and
/// "finished" the moment it's on.
fn setup_agy_hooks(home: &str) -> Result<String, String> {
    let helper = require_helper(home, "hooks not installed")?;
    let dir = std::path::PathBuf::from(home)
        .join(".gemini")
        .join("antigravity-cli");
    // No directory means the CLI has never run — nothing to configure yet, and
    // creating it ourselves could fight its first-run setup.
    if !dir.exists() {
        return Err("Antigravity CLI not initialized yet — run `agy` once first".into());
    }
    let path = dir.join("hooks.json");
    let mut hooks: serde_json::Value = if path.exists() {
        let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw)
            .map_err(|e| format!("{} is not valid JSON: {e}", path.display()))?
    } else {
        serde_json::json!({})
    };
    // `--agent agy` makes the helper normalize agy's event names and answer
    // PreToolUse with an allow verdict (its required stdout contract).
    let command = format!("{} --agent agy", helper.to_string_lossy());
    let entry = |_ev: &str| {
        serde_json::json!([{
            "matcher": "*",
            "hooks": [{ "type": "command", "command": command, "timeout": 10 }]
        }])
    };
    let group = serde_json::json!({
        "PreToolUse": entry("PreToolUse"),
        "PostToolUse": entry("PostToolUse"),
        "PreInvocation": entry("PreInvocation"),
        "PostInvocation": entry("PostInvocation"),
        "Notification": entry("Notification"),
    });
    let obj = hooks.as_object_mut().ok_or("hooks.json is not an object")?;
    let already = obj.get("canopy") == Some(&group);
    if !already {
        obj.insert("canopy".into(), group);
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&hooks).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }

    // OSC 9 notifications: off by default in agy; flipping it costs nothing
    // and Canopy already listens. Best-effort — a failure here shouldn't fail
    // the hook install that already succeeded.
    let settings_path = dir.join("settings.json");
    let notif = (|| -> Result<bool, String> {
        let mut settings: serde_json::Value = if settings_path.exists() {
            serde_json::from_str(
                &std::fs::read_to_string(&settings_path).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?
        } else {
            serde_json::json!({})
        };
        let obj = settings.as_object_mut().ok_or("not an object")?;
        if obj.get("notifications") == Some(&serde_json::json!(true)) {
            return Ok(false);
        }
        obj.insert("notifications".into(), serde_json::json!(true));
        std::fs::write(
            &settings_path,
            serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        Ok(true)
    })()
    .unwrap_or(false);

    if already && !notif {
        return Ok("Antigravity hooks already set up".into());
    }
    Ok(format!(
        "Antigravity hooks installed{} — restart agy sessions to pick them up",
        if notif {
            " (+ terminal notifications enabled)"
        } else {
            ""
        }
    ))
}

/// Substrings identifying a hook entry as one of ours, across every version we
/// have shipped: the original inline shell command wrote to agent-events.jsonl,
/// later ones invoke the helper binary out of our state dir. Matching all of
/// them means an upgrade replaces its predecessor instead of stacking a dead
/// hook beside it. Hooks the user wrote match none of these and are left
/// alone. Add to this list on any future rename. Shared by the claude and
/// codex installers.
const MARKERS: &[&str] = &["agent-events.jsonl", "canopy-hook", ".canopy/"];

/// Where the hook helper lives once installed. Hooks reference this stable path
/// rather than the app bundle, so they keep working across upgrades and don't
/// break if the app is moved.
fn helper_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    Ok(helper_path_in(&home))
}

/// The same path against an explicit home. Every installer is already handed
/// the home it is writing into, so taking it as an argument keeps them honest
/// about which tree they touch — and lets the tests run against a scratch home
/// instead of mutating the process's HOME out from under other tests.
fn helper_path_in(home: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(home)
        .join(".canopy")
        .join("bin")
        .join("canopy-hook")
}

/// Copy the helper next to our own binary into ~/.canopy/bin. Called at
/// startup so a rebuilt helper always replaces the installed one.
pub fn install_hook_helper() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let src = exe.parent().ok_or("no exe dir")?.join(if cfg!(windows) {
        "canopy-hook.exe"
    } else {
        "canopy-hook"
    });
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
    let dir = std::path::PathBuf::from(&home)
        .join(".canopy")
        .join("sessions");
    // The change journal is a sidecar of the digest — forgetting the session
    // must take it too, or a long-lived machine slowly accumulates orphaned
    // edit logs. Best-effort: its absence is fine, and it must not block the
    // digest removal that is the actual point of forgetting.
    let _ = std::fs::remove_file(dir.join(format!("{session_id}.edits.jsonl")));
    let path = dir.join(format!("{session_id}.json"));
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
    // The transcript-on-disk verification below is Claude-layout-specific
    // (~/.claude/projects buckets). A non-claude agent with a session id would
    // always fail it and get wrongly labeled "can't resume" — its resume
    // command syntax is registry-verified, so trust it.
    if digest["agent"].as_str().is_some_and(|a| a != "claude") {
        return (cwd, true);
    }

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

/// Sessions read straight from a CLI's own on-disk store, no hook required.
///
/// oh-my-pi writes complete, readable session files
/// (`~/.omp/agent/sessions/<dir>/<ts>_<id>.jsonl`, opening with a `title` and
/// a `session` record carrying the id and cwd), so its resumable sessions can
/// be listed without it cooperating at all. That is strictly better than
/// depending on a hook: the hook we install for omp is real but its plugin API
/// is documented as in flux, and on this machine it has never emitted an
/// event — meanwhile every session it ran is sitting on disk, resumable.
///
/// Bounded to the most recent files: a long-lived install accumulates
/// hundreds, and this runs on a panel refresh.
fn omp_digests(home: &str) -> Vec<serde_json::Value> {
    const MAX: usize = 60;
    let root = std::path::PathBuf::from(home)
        .join(".omp")
        .join("agent")
        .join("sessions");
    let Ok(dirs) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut files: Vec<(u64, std::path::PathBuf)> = Vec::new();
    for dir in dirs.flatten() {
        let Ok(entries) = std::fs::read_dir(dir.path()) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            let mtime = e
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            files.push((mtime, p));
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.truncate(MAX);

    files
        .into_iter()
        .filter_map(|(mtime, path)| {
            use std::io::{BufRead, BufReader};
            let f = std::fs::File::open(&path).ok()?;
            let mut id = String::new();
            let mut cwd = String::new();
            let mut title = String::new();
            // The header records are at the top; never read the whole
            // transcript just to label a row.
            for line in BufReader::new(f).lines().take(8).map_while(Result::ok) {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                match v["type"].as_str() {
                    Some("session") => {
                        id = v["id"].as_str().unwrap_or("").to_string();
                        cwd = v["cwd"].as_str().unwrap_or("").to_string();
                    }
                    Some("title") => title = v["title"].as_str().unwrap_or("").to_string(),
                    _ => {}
                }
                if !id.is_empty() && !title.is_empty() {
                    break;
                }
            }
            if id.is_empty() || cwd.is_empty() {
                return None;
            }
            Some(serde_json::json!({
                "session_id": id,
                "agent": "omp",
                "cwd": cwd,
                "launch_cwd": cwd,
                "updated": mtime,
                // The title is what the row is recognised by — omp generates
                // it from the conversation, which is the same job the last
                // human prompt does for claude.
                "prompts": if title.is_empty() { vec![] } else { vec![title] },
                "resume_cwd": cwd,
                "resumable": true,
            }))
        })
        .collect()
}

/// Live digests of agent sessions, for showing the user exactly what would be
/// shared, and for restoring sessions after a crash.
#[tauri::command]
pub async fn session_digests() -> Result<Vec<serde_json::Value>, String> {
    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    let dir = std::path::PathBuf::from(&home)
        .join(".canopy")
        .join("sessions");
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
    // Plus any CLI that keeps its own readable session store — those need no
    // hook to be restorable.
    out.extend(omp_digests(&home));
    Ok(out)
}

fn setup_claude_hooks(home: &str, bridge: &str) -> Result<String, String> {
    let dir = std::path::PathBuf::from(home).join(".claude");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("settings.json");
    let mut settings: serde_json::Value = if path.exists() {
        let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw)
            .map_err(|e| format!("~/.claude/settings.json is not valid JSON: {e}"))?
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

    // Never register a hook pointing at a binary that isn't there. Claude runs
    // hook commands without reporting failures, so a missing helper is not an
    // error the user would ever see — it just looks like the feature silently
    // does nothing. Refuse loudly instead.
    let helper = require_helper(
        home,
        "hooks not installed (build it with `cargo build --bin canopy-hook`)",
    )?;
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
    // context back into a session — the rest are observation only. SessionEnd
    // gives the panel a real "ended" state instead of inferring it from a
    // stale process; PreCompact marks the context reset so the token tray can
    // start a fresh count. Neither fires per tool call, so they add no
    // hot-path spawns the way a general PreToolUse would.
    for (event, matcher) in [
        ("PostToolUse", None),
        ("Stop", None),
        ("Notification", None),
        ("UserPromptSubmit", None),
        ("SessionStart", None),
        ("SessionEnd", None),
        ("PreCompact", None),
        ("SubagentStop", None),
        ("PreToolUse", Some("AskUserQuestion")),
    ] {
        let list = hooks.entry(event).or_insert_with(|| serde_json::json!([]));
        let Some(arr) = list.as_array_mut() else {
            continue;
        };
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

/// Register `canopy-hook --mcp` as a user-scope MCP server in ~/.claude.json,
/// giving every claude session the Canopy context tools (canopy_project,
/// canopy_component_files, canopy_server_output). Like the hooks, the
/// registration is global but self-gating: the tools only reach a live bridge
/// through CANOPY_CTX_PORT/TOKEN, which only Canopy's own PTYs export — in a
/// foreign terminal they answer with a polite "not inside Canopy".
fn setup_claude_mcp(home: &str) -> Result<String, String> {
    let helper = require_helper(home, "MCP server not registered")?;
    // ~/.claude.json is Claude Code's own state file — projects, history,
    // account. It goes through the same guarded, atomic upsert as every other
    // registry rather than a bespoke read-modify-write: the ownership check
    // stops us stamping on a `canopy` server somebody else defined, and the
    // atomic replace means a crash mid-setup can't cost the user that file.
    let want = serde_json::json!({
        "type": "stdio",
        "command": helper.to_string_lossy(),
        "args": ["--mcp"],
    });
    let changed = upsert_json_mcp(
        std::path::PathBuf::from(home).join(".claude.json"),
        "mcpServers",
        want,
        is_canopy_mcp_entry,
    )?;
    Ok(registered_msg(changed, "claude"))
}

/// Every MCP installer needs the helper on disk first, and says so the same
/// way. Hooks reference it by a stable path, so its absence means setup ran
/// before (or without) `install_hook_helper`.
fn require_helper(home: &str, consequence: &str) -> Result<std::path::PathBuf, String> {
    let helper = helper_path_in(home);
    if !helper.exists() {
        return Err(format!(
            "hook helper missing at {} — {consequence}",
            helper.display()
        ));
    }
    Ok(helper)
}

/// Whether an existing MCP entry is one of ours. Ownership is decided by what
/// the entry runs, not by the name it is filed under — a server called
/// `canopy` that launches something else belongs to whoever wrote it. Both
/// registry shapes are accepted: a command string (claude, antigravity) and an
/// argv array (opencode).
/// The keys we own, laid over the ones we don't. Only defined for two objects:
/// anything else the user replaced our entry with is theirs, and the ownership
/// check upstream has already decided whether we may touch it at all.
fn merged_entry(existing: &serde_json::Value, want: serde_json::Value) -> serde_json::Value {
    let (Some(existing), Some(ours)) = (existing.as_object(), want.as_object()) else {
        return want;
    };
    let mut out = existing.clone();
    for (k, v) in ours {
        out.insert(k.clone(), v.clone());
    }
    serde_json::Value::Object(out)
}

fn is_canopy_mcp_entry(entry: &serde_json::Value) -> bool {
    let command = entry.get("command");
    let as_string = command.and_then(|v| v.as_str());
    let as_argv0 = command
        .and_then(|v| v.as_array())
        .and_then(|args| args.first())
        .and_then(|v| v.as_str());
    as_string
        .or(as_argv0)
        .is_some_and(|command| command.contains("canopy-hook"))
}

fn registered_msg(changed: bool, agent: &str) -> String {
    if changed {
        format!("Canopy MCP server registered — new {agent} sessions get canopy_* context tools")
    } else {
        "Canopy MCP server already registered".into()
    }
}

/// MCP clients all speak to the same `canopy-hook --mcp` process, but each CLI
/// keeps its server registry in a different format. Keep those format details
/// here, beside the hook installers, rather than letting a Claude-shaped setup
/// path become the accidental integration API for every other agent.
fn canopy_mcp_command(helper: &std::path::Path) -> serde_json::Value {
    serde_json::json!({
        "command": helper.to_string_lossy(),
        "args": ["--mcp"],
    })
}

/// Read a JSON config we are about to edit. A missing file and an empty one
/// mean the same thing — nothing configured yet — and both have to be usable:
/// CLIs routinely create their config before they have anything to put in it
/// (Antigravity ships a 0-byte `mcp_config.json`), and treating that as
/// corruption made setup fail on machines where nothing was wrong. Content we
/// can't parse is still refused, because overwriting it would destroy
/// configuration somebody else wrote.
fn read_json_config(path: &std::path::Path) -> Result<serde_json::Value, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(serde_json::json!({})),
        Err(e) => return Err(format!("{} could not be read: {e}", path.display())),
    };
    if raw.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str(&raw).map_err(|e| format!("{} is not valid JSON: {e}", path.display()))
}

/// Replace a config file in one step. A plain `fs::write` truncates first, so a
/// crash or a full disk between truncate and write leaves the user with an
/// empty config — the very state `read_json_config` above had to be taught to
/// survive. These files are not ours (`~/.claude.json` holds Claude Code's own
/// account and project state), so losing one is not an acceptable outcome of a
/// setup step. The temp file is created in the destination directory to keep
/// the rename within one filesystem, and inherits the original's permissions
/// so a 0600 config doesn't come back world-readable.
fn write_config_atomic(path: &std::path::Path, body: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "config".into());
    let tmp = parent.join(format!(".{name}.canopy-{}", std::process::id()));
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    if let Ok(meta) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Insert one Canopy-owned MCP entry into a JSON config without touching other
/// servers. A pre-existing `canopy` server belongs to the user unless it points
/// at our helper; silently replacing it would be surprising and unsafe.
fn upsert_json_mcp(
    path: std::path::PathBuf,
    key: &str,
    want: serde_json::Value,
    is_ours: impl Fn(&serde_json::Value) -> bool,
) -> Result<bool, String> {
    let mut cfg = read_json_config(&path)?;
    let obj = cfg
        .as_object_mut()
        .ok_or_else(|| format!("{} is not an object", path.display()))?;
    let servers = obj.entry(key).or_insert_with(|| serde_json::json!({}));
    let servers = servers
        .as_object_mut()
        .ok_or_else(|| format!("{key} in {} is not an object", path.display()))?;
    let existing = servers.get("canopy").cloned();
    if let Some(existing) = &existing {
        if !is_ours(existing) {
            return Err(format!(
                "{} already has an MCP server named 'canopy' that Canopy does not own",
                path.display()
            ));
        }
    }
    // Merged over the entry, not written across it. `command` and `args` are
    // ours and must stay current (the helper's path moves when Canopy is
    // reinstalled), but anything else in there was put there by the user —
    // `"enabled": false` is OpenCode's documented way to switch a server off,
    // and setup runs on every launch, so replacing the entry wholesale turned
    // it silently back on each time the app started.
    let want = match &existing {
        Some(e) => merged_entry(e, want),
        None => want,
    };
    if existing.as_ref() == Some(&want) {
        return Ok(false);
    }
    servers.insert("canopy".into(), want);
    let body = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    write_config_atomic(&path, &body)?;
    Ok(true)
}

/// Splice our `[mcp_servers.canopy]` section into codex's TOML as text. A real
/// TOML round-trip would reformat and drop the comments in a file we don't
/// own, so the section is edited in place instead. `Ok(None)` means the config
/// already says exactly this and must not be rewritten.
/// Is this line the header of *our* table, however it was spelled? TOML lets a
/// key be quoted — `[mcp_servers."canopy"]` is the same table as
/// `[mcp_servers.canopy]` — and matching only the bare form appended a second
/// copy beside it, which is a duplicate-key parse error that breaks every codex
/// session.
fn is_canopy_table(line: &str) -> bool {
    let t = line.trim();
    let Some(inner) = t.strip_prefix('[').and_then(|t| t.strip_suffix(']')) else {
        return false;
    };
    let parts: Vec<&str> = inner
        .split('.')
        .map(|p| p.trim().trim_matches('"'))
        .collect();
    parts == ["mcp_servers", "canopy"]
}

fn codex_toml_with_canopy(existing: &str, helper: &str) -> Result<Option<String>, String> {
    let header = "[mcp_servers.canopy]";
    // `{:?}` gives a quoted, escaped string — valid TOML for a Windows path's
    // backslashes as much as a POSIX one's.
    let wanted = format!("{header}\ncommand = {helper:?}\nargs = [\"--mcp\"]");
    // A `canopy` key written inline under `[mcp_servers]` is a server we did
    // not write (we only ever emit the section form). Appending our section
    // beside it would be a duplicate key — a TOML parse error that breaks
    // every codex session — so refuse and say what to remove.
    let mut section = "";
    for line in existing.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            section = t;
        } else if section == "[mcp_servers]" {
            let key = t.split('=').next().unwrap_or("").trim().trim_matches('"');
            if key == "canopy" {
                return Err(
                    "~/.codex/config.toml defines a 'canopy' server inline under [mcp_servers] \
                     that Canopy does not own — remove that line and run setup again"
                        .into(),
                );
            }
        }
    }
    let mut lines: Vec<String> = existing.lines().map(str::to_string).collect();
    if let Some(start) = lines.iter().position(|line| is_canopy_table(line)) {
        let end = lines[start + 1..]
            .iter()
            .position(|line| line.trim_start().starts_with('['))
            .map(|offset| start + 1 + offset)
            .unwrap_or(lines.len());
        let old = lines[start..end].join("\n");
        if !old.contains("canopy-hook") {
            return Err(
                "~/.codex/config.toml already has an MCP server named 'canopy' that Canopy \
                 does not own"
                    .into(),
            );
        }
        // Everything in the section that isn't one of the two keys we write is
        // the user's — `env`, `startup_timeout_ms` and `tool_timeout_sec` are
        // all real codex options, and setup runs on every launch, so replacing
        // the table wholesale deleted them again each time the app started.
        let extras = lines[start + 1..end].iter().filter(|line| {
            let key = line.split('=').next().unwrap_or("").trim();
            !key.is_empty() && key != "command" && key != "args"
        });
        let replacement: Vec<String> = wanted
            .lines()
            .map(str::to_string)
            .chain(extras.cloned())
            .collect();
        if old.trim_end() == replacement.join("\n") {
            return Ok(None);
        }
        lines.splice(start..end, replacement);
    } else {
        if !lines.is_empty() && !lines.last().is_some_and(|line| line.is_empty()) {
            lines.push(String::new());
        }
        lines.extend(wanted.lines().map(str::to_string));
    }
    let mut out = lines.join("\n");
    out.push('\n');
    Ok(Some(out))
}

fn setup_codex_mcp(home: &str) -> Result<String, String> {
    let helper = require_helper(home, "MCP server not registered")?;
    let path = std::path::PathBuf::from(home).join(".codex/config.toml");
    let existing = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("{} could not be read: {e}", path.display())),
    };
    match codex_toml_with_canopy(&existing, &helper.to_string_lossy())? {
        Some(out) => {
            write_config_atomic(&path, &out)?;
            Ok(registered_msg(true, "codex"))
        }
        None => Ok(registered_msg(false, "codex")),
    }
}

fn setup_agy_mcp(home: &str) -> Result<String, String> {
    let helper = require_helper(home, "MCP server not registered")?;
    // Antigravity's own bundled docs (skills/agy-customizations/docs/
    // mcp_servers.md) name ~/.gemini/config/mcp_config.json as the global
    // registry, with the same `mcpServers` map Claude uses.
    let changed = upsert_json_mcp(
        std::path::PathBuf::from(home).join(".gemini/config/mcp_config.json"),
        "mcpServers",
        canopy_mcp_command(&helper),
        is_canopy_mcp_entry,
    )?;
    Ok(registered_msg(changed, "agy"))
}

fn setup_opencode_mcp(home: &str) -> Result<String, String> {
    let helper = require_helper(home, "MCP server not registered")?;
    // OpenCode takes the command as an argv array rather than a string.
    //
    // `enabled` is deliberately not written. Its own schema has it optional
    // ("Enable or disable the MCP server on startup" — McpLocalConfig in
    // @opencode-ai/sdk), so leaving it out means enabled, and it stays a key
    // only the user ever sets. Writing `true` would put it among the keys this
    // setup keeps current, and setup runs on every launch — so switching the
    // server off, the documented way, would last until the next start.
    let want = serde_json::json!({
        "type": "local",
        "command": [helper.to_string_lossy(), "--mcp"],
    });
    let changed = upsert_json_mcp(
        std::path::PathBuf::from(home).join(".config/opencode/opencode.json"),
        "mcp",
        want,
        is_canopy_mcp_entry,
    )?;
    Ok(registered_msg(changed, "opencode"))
}

// ---------------------------------------------------------------------------
// Integration health
//
// Hooks and MCP registrations are written into config files Canopy does not
// own, by an app that ships new hook templates with every release. They rot:
// an update changes a generated plugin, a CLI rewrites its own config, a user
// moves a home directory. Nothing noticed until the Agents panel went quiet and
// somebody clicked "set up" again — the failure mode is silence, which is the
// worst kind to leave to chance. So the state is made readable (the health
// command) and self-repairing on every launch (`heal_integrations`).
// ---------------------------------------------------------------------------

/// State of one half of one CLI's integration.
/// - `ours`: present and pointing at our helper
/// - `missing`: nothing registered
/// - `foreign`: something else claimed the name — never touched, only reported
/// - `unreadable`: the config exists but can't be parsed
/// - `unsupported`: this CLI has no such integration point
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct IntegrationHealth {
    pub agent: String,
    /// Whether the CLI itself is on the user's PATH. A missing integration for
    /// a CLI that isn't installed is not a problem to report.
    pub cli_installed: bool,
    pub hooks: &'static str,
    pub mcp: &'static str,
}

/// Where each CLI keeps its JSON MCP registry, and under which key. Codex is
/// absent: its registry is TOML and read by `codex_mcp_state`.
fn json_mcp_registry(agent: &str, home: &str) -> Option<(std::path::PathBuf, &'static str)> {
    let home = std::path::PathBuf::from(home);
    Some(match agent {
        "claude" => (home.join(".claude.json"), "mcpServers"),
        "agy" => (home.join(".gemini/config/mcp_config.json"), "mcpServers"),
        "opencode" => (home.join(".config/opencode/opencode.json"), "mcp"),
        _ => return None,
    })
}

/// Read the `[mcp_servers.canopy]` section out of codex's TOML without a
/// parser, the same way `codex_toml_with_canopy` writes it.
fn codex_mcp_state(existing: &str) -> &'static str {
    let mut section = "";
    let mut body = String::new();
    for line in existing.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            if section == "[mcp_servers.canopy]" {
                break;
            }
            section = t;
            continue;
        }
        if section == "[mcp_servers.canopy]" {
            body.push_str(line);
        } else if section == "[mcp_servers]" {
            let key = t.split('=').next().unwrap_or("").trim().trim_matches('"');
            if key == "canopy" {
                return if t.contains("canopy-hook") {
                    "ours"
                } else {
                    "foreign"
                };
            }
        }
    }
    if section != "[mcp_servers.canopy]" && !existing.contains("[mcp_servers.canopy]") {
        return "missing";
    }
    if body.contains("canopy-hook") {
        "ours"
    } else {
        "foreign"
    }
}

fn mcp_state(agent: &str, home: &str) -> &'static str {
    if agent == "codex" {
        return match std::fs::read_to_string(
            std::path::PathBuf::from(home).join(".codex/config.toml"),
        ) {
            Ok(raw) => codex_mcp_state(&raw),
            Err(_) => "missing",
        };
    }
    let Some((path, key)) = json_mcp_registry(agent, home) else {
        return "unsupported";
    };
    let Ok(cfg) = read_json_config(&path) else {
        return "unreadable";
    };
    match cfg.get(key).and_then(|servers| servers.get("canopy")) {
        None => "missing",
        Some(entry) if is_canopy_mcp_entry(entry) => "ours",
        Some(_) => "foreign",
    }
}

/// Read-only status of every integration Canopy can install. Drives the panel's
/// readout and decides what the startup repair may touch.
pub fn integration_health(home: &str, installed: &HashMap<String, bool>) -> Vec<IntegrationHealth> {
    SUPPORTED_AGENTS
        .iter()
        .map(|(agent, bin)| IntegrationHealth {
            agent: (*agent).into(),
            cli_installed: installed.get(*bin).copied().unwrap_or(false),
            hooks: if hooks_are_ours(agent, home) {
                "ours"
            } else {
                "missing"
            },
            mcp: mcp_state(agent, home),
        })
        .collect()
}

#[tauri::command]
pub async fn agent_integration_health() -> Result<Vec<IntegrationHealth>, String> {
    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    let bins: Vec<String> = SUPPORTED_AGENTS.iter().map(|(_, b)| (*b).into()).collect();
    Ok(integration_health(&home, &which_installed(&bins)))
}

/// What a launch did about the integrations it found.
#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct HealthReport {
    /// The app version this check ran for. Stored, so the next launch can tell
    /// an upgrade (where generated hook files may be stale) from a restart.
    pub version: String,
    pub upgraded: bool,
    pub agents: Vec<IntegrationHealth>,
    /// Agents whose integration was re-applied, and why.
    pub repaired: Vec<String>,
    pub failed: Vec<String>,
}

/// Keep every agent integration in step, once per launch — which is also once
/// per update, the case that matters most: a release can change a generated
/// plugin's contents, or add a step to setup (the MCP registration is exactly
/// that — shipped after the hooks were, so a machine set up by the previous
/// version has hooks and no MCP until something re-runs setup).
///
/// This replaces a fire-and-forget loop in the renderer that invoked setup for
/// all seven CLIs on every launch with `.catch(() => {})`. Same intent, three
/// differences that matter: it doesn't write into the config of a CLI you don't
/// have installed, it never overwrites an MCP server somebody else registered,
/// and its results are reported instead of discarded — the failure mode of the
/// old loop was silence, which is how a broken registration survived unnoticed.
///
/// Idempotent by construction: every installer skips when the config already
/// says what it would write, so a normal launch writes nothing at all.
pub fn heal_integrations(app: AppHandle) {
    thread::Builder::new()
        .name("integration-health".into())
        .spawn(move || {
            let Ok(home) = std::env::var("HOME") else {
                return;
            };
            let bins: Vec<String> = SUPPORTED_AGENTS.iter().map(|(_, b)| (*b).into()).collect();
            let installed = which_installed(&bins);
            let report = heal_integrations_in(&home, env!("CARGO_PKG_VERSION"), &installed);
            for line in &report.repaired {
                log::info!("agent integration: {line}");
            }
            for line in &report.failed {
                log::warn!("agent integration failed: {line}");
            }
            // Kept as well as emitted. This pass starts before the webview
            // does, so the event can fire with nobody listening — and a report
            // whose whole purpose is to break a silence must not be lost to a
            // race. The frontend asks for this on mount and uses whichever
            // arrives first.
            if let Ok(mut slot) = LAST_HEALTH.lock() {
                *slot = Some(report.clone());
            }
            let _ = app.emit("agents:health", &report);
        })
        .ok();
}

static LAST_HEALTH: std::sync::Mutex<Option<HealthReport>> = std::sync::Mutex::new(None);

/// The launch's integration report, or None if the pass hasn't finished yet.
#[tauri::command]
pub async fn agent_health_report() -> Option<HealthReport> {
    LAST_HEALTH.lock().ok().and_then(|slot| slot.clone())
}

/// The sync core, against an explicit home, version and PATH probe — so the
/// tests can drive a whole launch, including the upgrade path, without
/// depending on the machine they run on.
pub fn heal_integrations_in(
    home: &str,
    version: &str,
    installed: &HashMap<String, bool>,
) -> HealthReport {
    let stamp_path = std::path::PathBuf::from(home)
        .join(".canopy")
        .join("integrations.json");
    let last = read_json_config(&stamp_path).unwrap_or_else(|_| serde_json::json!({}));
    let upgraded = last.get("version").and_then(|v| v.as_str()) != Some(version);
    let mut repaired = Vec::new();
    let mut failed = Vec::new();

    for health in integration_health(home, installed) {
        let owned = health.hooks == "ours" || health.mcp == "ours";
        // Nothing installed and nothing of ours to maintain — writing a config
        // for a CLI this machine doesn't have is pure noise. Ownership still
        // counts on its own, because PATH detection runs a login shell that a
        // GUI launch can't always reproduce, and losing that race must not
        // orphan an integration we already wrote.
        if !health.cli_installed && !owned {
            continue;
        }
        // An upgrade re-applies everything: generated files may have changed
        // underneath us. Otherwise only a hole is worth writing for — `foreign`
        // is somebody else's server and `unsupported` is nothing to fix.
        let reason = if !owned {
            Some("not set up yet".to_string())
        } else if upgraded {
            Some(format!("upgraded to {version}"))
        } else if health.hooks == "missing" {
            Some("hooks missing".to_string())
        } else if health.mcp == "missing" {
            Some("MCP registration missing".to_string())
        } else {
            None
        };
        let Some(reason) = reason else { continue };
        match setup_agent(&health.agent, home) {
            Ok(r) if r.ok => repaired.push(format!("{} ({reason})", health.agent)),
            // Per step, not per agent: hooks landing while the MCP registry
            // refuses is the normal shape of a partial failure, and rolling
            // both into one line loses which half needs the user's attention.
            Ok(r) => failed.extend(
                r.steps
                    .iter()
                    .filter(|s| !s.ok)
                    .map(|s| format!("{} {}: {}", health.agent, s.step, s.message)),
            ),
            Err(e) => failed.push(format!("{}: {e}", health.agent)),
        }
    }

    let checked = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let stamp = serde_json::json!({ "version": version, "checked": checked });
    if let Ok(body) = serde_json::to_string_pretty(&stamp) {
        if let Err(e) = write_config_atomic(&stamp_path, &body) {
            log::warn!("could not record integration health stamp: {e}");
        }
    }
    HealthReport {
        version: version.into(),
        upgraded,
        // Re-read after repairing so the report describes the end state.
        agents: integration_health(home, installed),
        repaired,
        failed,
    }
}

fn setup_codex_hooks(home: &str, bridge: &str) -> Result<String, String> {
    // Two generations, both installed. The full hooks system (stable since
    // ~v0.124) is modeled on Claude Code's — same event names, same stdin
    // payload (session_id, transcript_path, cwd, hook_event_name) — so it
    // routes through the same helper and unlocks the whole pipeline: stamped
    // events, digests, restore, permission cards, context. The legacy
    // `notify` stays for older versions; it only fires agent-turn-complete
    // and writes the bridge raw, which degrades gracefully to idle cards.
    let notify = setup_codex_notify(home, bridge);

    let helper = require_helper(home, "hooks not installed")?;
    let dir = std::path::PathBuf::from(home).join(".codex");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("hooks.json");
    let mut settings: serde_json::Value = if path.exists() {
        let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw)
            .map_err(|e| format!("{} is not valid JSON: {e}", path.display()))?
    } else {
        serde_json::json!({})
    };
    let command = format!("{} --agent codex", helper.to_string_lossy());
    let want = serde_json::json!({
        "hooks": [ { "type": "command", "command": command } ]
    });
    let hooks = settings
        .as_object_mut()
        .ok_or("hooks.json is not an object")?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));
    let hooks = hooks.as_object_mut().ok_or("hooks is not an object")?;
    let mut changed = 0;
    // No PreToolUse: we observe, and a hook there sits in the approval path.
    // PermissionRequest is registered observe-only (no stdout = no decision)
    // purely so the blocked-on-approval moment reaches the pending cards.
    for event in [
        "SessionStart",
        "UserPromptSubmit",
        "Stop",
        "SessionEnd",
        "PostToolUse",
        "PermissionRequest",
    ] {
        let list = hooks.entry(event).or_insert_with(|| serde_json::json!([]));
        let Some(arr) = list.as_array_mut() else {
            continue;
        };
        if arr.iter().any(|e| e == &want) {
            continue;
        }
        arr.retain(|e| {
            let s = e.to_string();
            !MARKERS.iter().any(|m| s.contains(m))
        });
        arr.push(want.clone());
        changed += 1;
    }
    if changed > 0 {
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }
    match (changed, notify) {
        (0, Ok(_)) => Ok("Codex hooks already set up".into()),
        _ => Ok(
            "Codex hooks installed (~/.codex/hooks.json) — restart codex sessions, and run \
             /hooks in codex once to trust them"
                .into(),
        ),
    }
}

/// Legacy notify fallback for codex versions without the hooks system.
///
/// `notify` is a bare top-level key, so it MUST sit above the first table
/// header. Appending it to the end of the file is a bug: codex writes tables of
/// its own (e.g. `[tui.model_availability_nux]`), and if the file ends inside
/// one the appended key gets absorbed into that table — codex then fails to
/// load config at all ("invalid type: sequence, expected u32"). So we splice
/// notify in before the first table header, and heal any copy we misplaced.
fn setup_codex_notify(home: &str, bridge: &str) -> Result<String, String> {
    let dir = std::path::PathBuf::from(home).join(".codex");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("config.toml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();

    let is_ours = |l: &str| l.trim_start().starts_with("notify") && l.contains(bridge);
    // A notify line that isn't ours is the user's own — leave the file alone.
    if existing
        .lines()
        .any(|l| l.trim_start().starts_with("notify") && !is_ours(l))
    {
        return Err("custom notify present".into());
    }

    // Codex passes the notification JSON as an argument, not stdin.
    let notify =
        format!("notify = [\"/bin/sh\", \"-c\", \"printf '%s\\\\n' \\\"$0\\\" >> {bridge}\"]");

    // Drop any copy we wrote before (which may have been absorbed into a
    // table), then reinsert before the first table header — the only place a
    // bare key is guaranteed to belong to the document root.
    let kept: Vec<&str> = existing.lines().filter(|l| !is_ours(l)).collect();
    let mut insert_at = kept
        .iter()
        .position(|l| l.trim_start().starts_with('['))
        .unwrap_or(kept.len());
    // Keep notify above any blank lines that pad the first table, so a
    // correctly-placed file re-runs as a no-op instead of drifting downward.
    while insert_at > 0 && kept[insert_at - 1].trim().is_empty() {
        insert_at -= 1;
    }
    let mut lines: Vec<String> = kept.iter().map(|s| s.to_string()).collect();
    lines.insert(insert_at, notify);

    let mut rebuilt = lines.join("\n");
    if rebuilt.is_empty() || existing.ends_with('\n') {
        rebuilt.push('\n');
    }
    if rebuilt == existing {
        return Ok("already".into());
    }
    std::fs::write(&path, rebuilt).map_err(|e| e.to_string())?;
    Ok("installed".into())
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

/// Byte offset already parsed per transcript, with the stats accumulated up to
/// it. Transcripts are append-only JSONL, so each poll only has to parse what
/// grew since the last one — without this, the 8s status-tray poll re-read and
/// re-JSON-parsed the whole file (tens of MB in a long session) every tick,
/// per open project.
static STATS_CACHE: std::sync::LazyLock<
    std::sync::Mutex<HashMap<std::path::PathBuf, (u64, ClaudeSessionStats)>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// Aggregate token usage + model from a Claude Code session transcript
/// (~/.claude/projects/**/*.jsonl — the path arrives via hook events).
/// Powers the status tray (model / tokens / cost). Incremental: parses only
/// bytes appended since the previous call for the same path.
#[tauri::command]
pub async fn claude_session_stats(transcript_path: String) -> Result<ClaudeSessionStats, String> {
    use std::io::{Read, Seek, SeekFrom};
    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    let path = std::path::Path::new(&transcript_path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let claude_dir = std::path::PathBuf::from(&home).join(".claude");
    if !path.starts_with(&claude_dir) || path.extension().and_then(|e| e.to_str()) != Some("jsonl")
    {
        return Err("not a claude transcript".into());
    }
    let (mut offset, mut stats) = STATS_CACHE
        .lock()
        .unwrap()
        .get(&path)
        .cloned()
        .unwrap_or((0, ClaudeSessionStats::default()));
    let len = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if len < offset {
        // Truncated/rewritten (e.g. compaction) — start over.
        offset = 0;
        stats = ClaudeSessionStats::default();
    }
    if len > offset {
        let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let mut raw = String::new();
        f.read_to_string(&mut raw).map_err(|e| e.to_string())?;
        // Only consume complete lines: the writer may be mid-append, and a
        // half line parsed now would be double-counted or lost next poll.
        let consumed = match raw.rfind('\n') {
            Some(i) => i + 1,
            None => 0,
        };
        for line in raw[..consumed].lines() {
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
            stats.cache_creation_tokens +=
                usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
            stats.turns += 1;
        }
        offset += consumed as u64;
        STATS_CACHE
            .lock()
            .unwrap()
            .insert(path.clone(), (offset, stats.clone()));
    }
    Ok(stats)
}

// ---------- cross-CLI usage aggregation ----------
//
// The status tray (claude_session_stats above) follows one live Claude session.
// The Statistics panel wants the whole picture: every session Canopy knows,
// across every CLI, summed into token/cost totals and per-CLI / per-model
// breakdowns. Each CLI records usage in its own transcript format, so a small
// per-agent fold normalizes them into one shape.

/// Normalized token/cost usage for one agent session, summed across its turns.
/// `cost` is set only when the CLI records its own cost (omp); otherwise it is
/// None and the frontend estimates from `model` + a pricing table (as the tray
/// already does for Claude).
#[derive(Serialize, Clone, Default)]
pub struct AgentSessionUsage {
    pub session_id: String,
    pub agent: String,
    pub cwd: String,
    pub title: Option<String>,
    pub model: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cost: Option<f64>,
    pub turns: u64,
    pub updated: u64,
    /// Whether Canopy can read token usage for this agent. False for
    /// server-side (amp) or not-yet-parsed CLIs — the row is still returned so
    /// the CLI mix stays honest, but its numbers are zero.
    pub supported: bool,
}

/// Accumulator a per-agent fold writes into. Same fields as the wire struct,
/// minus session identity.
#[derive(Clone, Default)]
struct Usage {
    model: Option<String>,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
    cost: Option<f64>,
    turns: u64,
}

/// Byte offset + folded usage per transcript, so each poll only parses bytes
/// appended since the last one (transcripts are append-only JSONL). Separate
/// from STATS_CACHE, which serves the single-session status tray.
static USAGE_CACHE: std::sync::LazyLock<
    std::sync::Mutex<HashMap<std::path::PathBuf, (u64, Usage)>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// Fold the JSONL lines appended to `path` since last seen into a cached Usage
/// via `f`. Incremental (byte-offset cache), truncation-safe (resets on
/// shrink), and never parses a partial trailing line. `f` may add (claude/omp
/// count per turn) or overwrite (codex reports cumulative totals) — both
/// compose correctly with the append-only cache, since each line is folded
/// exactly once.
fn fold_usage(path: &std::path::Path, f: impl Fn(&serde_json::Value, &mut Usage)) -> Usage {
    use std::io::{Read, Seek, SeekFrom};
    let (mut offset, mut usage) = USAGE_CACHE
        .lock()
        .unwrap()
        .get(path)
        .cloned()
        .unwrap_or((0, Usage::default()));
    let Ok(len) = std::fs::metadata(path).map(|m| m.len()) else {
        return usage;
    };
    if len < offset {
        offset = 0;
        usage = Usage::default();
    }
    if len > offset {
        let Ok(mut file) = std::fs::File::open(path) else {
            return usage;
        };
        if file.seek(SeekFrom::Start(offset)).is_err() {
            return usage;
        }
        let mut raw = String::new();
        if file.read_to_string(&mut raw).is_err() {
            return usage;
        }
        let consumed = raw.rfind('\n').map(|i| i + 1).unwrap_or(0);
        for line in raw[..consumed].lines() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                f(&v, &mut usage);
            }
        }
        offset += consumed as u64;
        USAGE_CACHE
            .lock()
            .unwrap()
            .insert(path.to_path_buf(), (offset, usage.clone()));
    }
    usage
}

/// Claude Code JSONL: assistant lines carry `message.usage.*`, summed per turn.
fn fold_claude(v: &serde_json::Value, u: &mut Usage) {
    if v["type"] != "assistant" {
        return;
    }
    let m = &v["message"];
    if let Some(model) = m["model"].as_str() {
        u.model = Some(model.to_string());
    }
    let usage = &m["usage"];
    u.input += usage["input_tokens"].as_u64().unwrap_or(0);
    u.output += usage["output_tokens"].as_u64().unwrap_or(0);
    u.cache_read += usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
    u.cache_creation += usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
    u.turns += 1;
}

/// oh-my-pi JSONL: assistant `message` entries carry `usage` (camelCase) plus a
/// pre-computed `usage.cost.total` — the only CLI here that reports real cost.
fn fold_omp(v: &serde_json::Value, u: &mut Usage) {
    if v["type"] != "message" {
        return;
    }
    let m = &v["message"];
    if m["role"] != "assistant" {
        return;
    }
    let usage = &m["usage"];
    if usage.is_null() {
        return;
    }
    if let Some(model) = m["model"].as_str() {
        u.model = Some(model.to_string());
    }
    u.input += usage["input"].as_u64().unwrap_or(0);
    u.output += usage["output"].as_u64().unwrap_or(0);
    u.cache_read += usage["cacheRead"].as_u64().unwrap_or(0);
    u.cache_creation += usage["cacheWrite"].as_u64().unwrap_or(0);
    if let Some(c) = usage["cost"]["total"].as_f64() {
        u.cost = Some(u.cost.unwrap_or(0.0) + c);
    }
    u.turns += 1;
}

/// Codex rollout JSONL: model in `turn_context`, token counts in a
/// `token_count` event. Counts are *cumulative session totals*, so tokens are
/// overwritten (last wins), not summed — and `input_tokens` already includes
/// the cached portion, which we split back out to mirror Claude's shape.
fn fold_codex(v: &serde_json::Value, u: &mut Usage) {
    match v["type"].as_str() {
        Some("turn_context") => {
            if let Some(model) = v["payload"]["model"].as_str() {
                u.model = Some(model.to_string());
            }
        }
        Some("event_msg") => {
            let payload = &v["payload"];
            if payload["type"] != "token_count" {
                return;
            }
            let total = &payload["info"]["total_token_usage"];
            if total.is_null() {
                return;
            }
            let input = total["input_tokens"].as_u64().unwrap_or(0);
            let cached = total["cached_input_tokens"].as_u64().unwrap_or(0);
            u.cache_read = cached;
            u.input = input.saturating_sub(cached);
            u.output = total["output_tokens"].as_u64().unwrap_or(0);
            u.turns += 1;
        }
        _ => {}
    }
}

/// One session's identity + resolved transcript path, before folding.
struct Candidate {
    agent: String,
    session_id: String,
    cwd: String,
    title: Option<String>,
    path: Option<std::path::PathBuf>,
    updated: u64,
}

fn secs_mtime(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The bucketed Claude transcript for a session id, if it is on disk.
fn claude_transcript_path(home: &str, session_id: &str) -> Option<std::path::PathBuf> {
    let bucket = transcript_bucket(session_id)?;
    let path = std::path::PathBuf::from(home)
        .join(".claude/projects")
        .join(bucket)
        .join(format!("{session_id}.jsonl"));
    path.exists().then_some(path)
}

/// Sessions Canopy learned about from hook digests (~/.canopy/sessions). Covers
/// Claude (and any hook-reporting CLI); omp/codex are filled in from their own
/// stores below, so only Claude paths are resolved here.
fn canopy_digest_candidates(home: &str) -> Vec<Candidate> {
    let dir = std::path::PathBuf::from(home)
        .join(".canopy")
        .join("sessions");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&p) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let Some(session_id) = v["session_id"].as_str() else {
            continue;
        };
        let agent = v["agent"].as_str().unwrap_or("claude").to_string();
        let cwd = v["launch_cwd"]
            .as_str()
            .or_else(|| v["cwd"].as_str())
            .unwrap_or("")
            .to_string();
        let title = v["prompts"]
            .as_array()
            .and_then(|a| a.last())
            .and_then(|s| s.as_str())
            .map(|s| s.to_string());
        let updated = v["updated"]
            .as_u64()
            .or_else(|| entry.metadata().ok().as_ref().map(secs_mtime))
            .unwrap_or(0);
        let path = (agent == "claude")
            .then(|| claude_transcript_path(home, session_id))
            .flatten();
        out.push(Candidate {
            agent,
            session_id: session_id.to_string(),
            cwd,
            title,
            path,
            updated,
        });
    }
    out
}

/// The most recent oh-my-pi sessions, read straight from its store (no hook
/// needed). Header records give id/cwd/title; the file itself carries usage.
fn omp_sessions(home: &str) -> Vec<Candidate> {
    use std::io::{BufRead, BufReader};
    const MAX: usize = 60;
    let root = std::path::PathBuf::from(home).join(".omp/agent/sessions");
    let Ok(dirs) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut files: Vec<(u64, std::path::PathBuf)> = Vec::new();
    for dir in dirs.flatten() {
        let Ok(entries) = std::fs::read_dir(dir.path()) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            let mtime = e.metadata().ok().as_ref().map(secs_mtime).unwrap_or(0);
            files.push((mtime, p));
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.truncate(MAX);
    files
        .into_iter()
        .filter_map(|(mtime, path)| {
            let f = std::fs::File::open(&path).ok()?;
            let (mut id, mut cwd, mut title) = (String::new(), String::new(), String::new());
            for line in BufReader::new(f).lines().take(8).map_while(Result::ok) {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                match v["type"].as_str() {
                    Some("session") => {
                        id = v["id"].as_str().unwrap_or("").to_string();
                        cwd = v["cwd"].as_str().unwrap_or("").to_string();
                        if title.is_empty() {
                            title = v["title"].as_str().unwrap_or("").to_string();
                        }
                    }
                    Some("title") => title = v["title"].as_str().unwrap_or("").to_string(),
                    _ => {}
                }
                if !id.is_empty() && !title.is_empty() {
                    break;
                }
            }
            if id.is_empty() {
                return None;
            }
            Some(Candidate {
                agent: "omp".into(),
                session_id: id,
                cwd,
                title: (!title.is_empty()).then_some(title),
                path: Some(path),
                updated: mtime,
            })
        })
        .collect()
}

/// Recursively gather `.jsonl` files with their mtimes, bounded by `depth` so a
/// deep tree can't run away.
fn collect_jsonl(dir: &std::path::Path, depth: usize, out: &mut Vec<(u64, std::path::PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if depth > 0 {
                collect_jsonl(&p, depth - 1, out);
            }
        } else if p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
            let mtime = e.metadata().ok().as_ref().map(secs_mtime).unwrap_or(0);
            out.push((mtime, p));
        }
    }
}

/// The most recent Codex sessions, from its date-bucketed rollout store. The
/// session id and cwd come from the `session_meta` header at the top of each
/// rollout.
fn codex_sessions(home: &str) -> Vec<Candidate> {
    use std::io::{BufRead, BufReader};
    const MAX: usize = 60;
    let root = std::path::PathBuf::from(home).join(".codex/sessions");
    let mut files: Vec<(u64, std::path::PathBuf)> = Vec::new();
    collect_jsonl(&root, 4, &mut files);
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.truncate(MAX);
    files
        .into_iter()
        .filter_map(|(mtime, path)| {
            let f = std::fs::File::open(&path).ok()?;
            let (mut id, mut cwd) = (String::new(), String::new());
            for line in BufReader::new(f).lines().take(4).map_while(Result::ok) {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                if v["type"] == "session_meta" {
                    id = v["payload"]["id"].as_str().unwrap_or("").to_string();
                    cwd = v["payload"]["cwd"].as_str().unwrap_or("").to_string();
                    break;
                }
            }
            if id.is_empty() {
                return None;
            }
            Some(Candidate {
                agent: "codex".into(),
                session_id: id,
                cwd,
                title: None,
                path: Some(path),
                updated: mtime,
            })
        })
        .collect()
}

/// Keep the best candidate per (agent, session id): a resolved path beats none,
/// then newer beats older. Lets a hook digest and a disk-store scan of the same
/// session collapse to one row.
fn upsert(map: &mut HashMap<(String, String), Candidate>, c: Candidate) {
    let key = (c.agent.clone(), c.session_id.clone());
    let better = match map.get(&key) {
        None => true,
        Some(prev) => {
            (c.path.is_some() && prev.path.is_none())
                || (c.path.is_some() == prev.path.is_some() && c.updated > prev.updated)
        }
    };
    if better {
        map.insert(key, c);
    }
}

/// Token + cost usage for every session Canopy currently knows, across all
/// supported CLIs. Powers the Statistics panel and the status-tray grand total.
/// "Known" = hook digests (Claude and any hook-reporting CLI) plus the most
/// recent sessions in omp's and Codex's own stores — not a full-history scan.
#[tauri::command]
pub async fn agent_usage() -> Result<Vec<AgentSessionUsage>, String> {
    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    let mut by_key: HashMap<(String, String), Candidate> = HashMap::new();
    for c in canopy_digest_candidates(&home) {
        upsert(&mut by_key, c);
    }
    for c in omp_sessions(&home) {
        upsert(&mut by_key, c);
    }
    for c in codex_sessions(&home) {
        upsert(&mut by_key, c);
    }

    let mut out = Vec::new();
    for c in by_key.into_values() {
        let supported = matches!(c.agent.as_str(), "claude" | "codex" | "omp");
        let usage = match (supported, c.path.as_deref()) {
            (true, Some(path)) => match c.agent.as_str() {
                "claude" => fold_usage(path, fold_claude),
                "omp" => fold_usage(path, fold_omp),
                "codex" => fold_usage(path, fold_codex),
                _ => Usage::default(),
            },
            _ => Usage::default(),
        };
        out.push(AgentSessionUsage {
            session_id: c.session_id,
            agent: c.agent,
            cwd: c.cwd,
            title: c.title,
            model: usage.model,
            input_tokens: usage.input,
            output_tokens: usage.output,
            cache_read_tokens: usage.cache_read,
            cache_creation_tokens: usage.cache_creation,
            cost: usage.cost,
            turns: usage.turns,
            updated: c.updated,
            supported,
        });
    }
    // A supported session with no parsed turns spent nothing — drop it as noise.
    // Unsupported rows are kept so the panel can name what it can't measure.
    out.retain(|u| !u.supported || u.turns > 0);
    out.sort_by(|a, b| b.updated.cmp(&a.updated));
    Ok(out)
}

/// Single-quote a string for a POSIX shell. Airtight for arbitrary content:
/// inside single quotes the shell interprets nothing, and the only character
/// that can end the quoting is escaped by closing, escaping, and reopening.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Normalise a probe candidate, or None if it isn't one.
///
/// This replaced an `is_alphanumeric() || '-' || '_'` whitelist. That guard was
/// there because the name lands in a shell line unquoted — but it also silently
/// failed every binary override that is a path (`/opt/acme/bin/claude`) or has a
/// dot in it, reporting a CLI the user definitely has as not installed. Quoting
/// makes injection impossible, so the remaining checks are only about the value
/// being one sane token: control characters would corrupt the line-based output
/// parsing, and whitespace means arguments were smuggled into a field that must
/// name a single executable.
///
/// A leading `~/` is expanded here because it is inside quotes by the time the
/// shell sees it, where tilde expansion does not happen.
fn probe_target(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.chars().any(char::is_control) {
        return None;
    }
    // The one-token rule applies to a bare command name, where whitespace can
    // only mean arguments were smuggled into a field that must name a single
    // executable. A *path* is different: `C:\Program Files\Acme\Claude.exe` is
    // the standard enterprise install location on Windows, and refusing it
    // reports a CLI the user definitely has as not installed — the same failure
    // the charset whitelist caused, moved one guard along.
    let path_shaped = s.contains('/') || s.contains('\\');
    if !path_shaped && s.split_whitespace().count() != 1 {
        return None;
    }
    match s.strip_prefix("~/") {
        Some(rest) => Some(format!("{}/{rest}", std::env::var("HOME").ok()?)),
        None => Some(s.to_string()),
    }
}

/// Check which commands exist on the user's login-shell PATH (GUI apps don't
/// inherit it). Used by the agent-CLI launcher to offer launch vs. install.
///
/// A command may also be an absolute or `~/`-relative path, which is how a
/// rebound CLI (Settings → Agents) names an enterprise build installed outside
/// PATH. `command -v` answers for both: given a path it reports it when it is
/// executable, and fails when it is not.
#[tauri::command]
pub async fn which_check(commands: Vec<String>) -> HashMap<String, bool> {
    which_installed(&commands)
}

/// The sync core: spawning a login shell is slow enough that the startup health
/// check wants to do it once, off the main thread, rather than per agent.
fn which_installed(commands: &[String]) -> HashMap<String, bool> {
    let mut result: HashMap<String, bool> = commands.iter().map(|c| (c.clone(), false)).collect();
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let script = commands
            .iter()
            .filter_map(|c| probe_target(c).map(|t| (c, t)))
            // Echo the caller's original spelling, not the expanded target: it
            // is the key the caller looks the answer up under.
            .map(|(orig, target)| {
                format!(
                    "command -v {} >/dev/null 2>&1 && printf '%s\\n' {}",
                    sh_quote(&target),
                    sh_quote(orig)
                )
            })
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
    #[cfg(windows)]
    {
        // No login shell on Windows; `where <cmd>` (where.exe on PATH) exits 0
        // when the command is found. No quoting needed and no charset guard:
        // the argument is passed to the process directly, never through a shell.
        // A command given as a path is answered by the filesystem instead —
        // `where` only searches PATH and would miss it.
        for c in commands {
            let Some(target) = probe_target(c) else {
                continue;
            };
            let ok = if target.contains('\\') || target.contains('/') {
                // PATHEXT, the way the shell that launches it would: an npm
                // shim is `claude.cmd`, so a path written without an extension
                // is on disk under a name `is_file` alone never sees, and the
                // probe would say "not installed" about something that launches
                // fine.
                std::path::Path::new(&target).is_file()
                    || std::env::var("PATHEXT")
                        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
                        .split(';')
                        .filter(|e| !e.is_empty())
                        .any(|ext| std::path::Path::new(&format!("{target}{ext}")).is_file())
            } else {
                std::process::Command::new("where")
                    .no_console_window()
                    .arg(&target)
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false)
            };
            if let Some(found) = result.get_mut(c) {
                *found = ok;
            }
        }
    }
    result
}

/// One CLI's version pair: what's on disk vs what its registry publishes.
/// Either side is None when unknown — not installed, unparseable output, no
/// registry to ask, or the probe timed out.
#[derive(Serialize, Clone, Default)]
pub struct CliVersions {
    pub installed: Option<String>,
    pub latest: Option<String>,
    /// Package manager that owns the binary, when detectable ("homebrew"). The
    /// install source, not a hardcoded assumption, decides both where "latest"
    /// comes from and which upgrade command actually works.
    #[serde(rename = "managedBy", skip_serializing_if = "Option::is_none")]
    pub managed_by: Option<String>,
    /// Upgrade command matched to the install source (e.g. `brew upgrade
    /// claude-code`); None falls back to the CLI's own updater.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct CliVersionQuery {
    pub bin: String,
    /// Registry JSON endpoint carrying the newest version (npm `/latest` doc
    /// or PyPI `/json`). None skips the network fetch — the frontend passes
    /// None both for registry-less CLIs and when its latest-cache is fresh.
    #[serde(rename = "latestUrl")]
    pub latest_url: Option<String>,
}

/// First `x.y[.z…]` token in `s` where every dot-segment is numeric. Hand
/// rolled because it is the only pattern match in the codebase — not worth a
/// regex dependency. Splitting on anything that isn't a digit or a dot means
/// prerelease suffixes ("1.2.3-beta") yield their release core ("1.2.3").
fn first_version_token(s: &str) -> Option<String> {
    for tok in s.split(|c: char| !c.is_ascii_digit() && c != '.') {
        let tok = tok.trim_matches('.');
        if tok.is_empty() {
            continue;
        }
        let segs: Vec<&str> = tok.split('.').collect();
        if segs.len() >= 2
            && segs
                .iter()
                .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        {
            return Some(tok.to_string());
        }
    }
    None
}

/// The Homebrew package name for a canonicalized binary path, and whether it
/// is a cask. `None` when the path isn't inside a Homebrew prefix — the binary
/// came from npm, pip, a native installer, or a manual build, so its own
/// updater (not `brew`) is the right upgrade route. A brew binary in `.../bin`
/// symlinks into `Cellar/<formula>/…` or `Caskroom/<cask>/…`; the segment right
/// after that marker is the package name.
fn brew_pkg(path: &str) -> Option<(String, bool)> {
    let (at, is_cask) = if let Some(i) = path.find("/Cellar/") {
        (i + "/Cellar/".len(), false)
    } else if let Some(i) = path.find("/Caskroom/") {
        (i + "/Caskroom/".len(), true)
    } else {
        return None;
    };
    let pkg = path[at..].split('/').next()?;
    // Names are conservative; anything odd must not reach the shell line below.
    if pkg.is_empty()
        || !pkg
            .chars()
            .all(|c| c.is_alphanumeric() || "-_.@+".contains(c))
    {
        return None;
    }
    Some((pkg.to_string(), is_cask))
}

/// Installed vs latest versions for the agent CLIs. Installed comes from
/// `<bin> --version` on the login-shell PATH (GUI apps don't inherit it);
/// latest from the CLI's registry via curl — the app deliberately has no HTTP
/// stack, and the webview CSP blocks registry origins, so the system curl is
/// the transport. Probes run concurrently and are individually timeboxed: one
/// hung `--version` must not wedge the whole launcher refresh.
#[tauri::command]
pub async fn cli_versions(queries: Vec<CliVersionQuery>) -> HashMap<String, CliVersions> {
    let mut out: HashMap<String, CliVersions> = queries
        .iter()
        .map(|q| (q.bin.clone(), CliVersions::default()))
        .collect();
    #[cfg(unix)]
    {
        let mut tasks = Vec::new();
        for q in queries {
            tasks.push(tokio::spawn(async move {
                let mut v = CliVersions::default();
                let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
                // Same normalisation as which_check — the name lands in a shell
                // line, where quoting (not a charset whitelist) makes it safe.
                if let Some(target) = probe_target(&q.bin) {
                    let qb = sh_quote(&target);
                    // One login shell (the costly part) yields both the version
                    // string and the resolved binary path, split on a sentinel —
                    // the path is how we learn who installed it.
                    let probe = tokio::process::Command::new(&shell)
                        .args([
                            "-lc",
                            &format!(
                                "{qb} --version 2>&1; echo '@@P@@'; command -v {qb} 2>/dev/null"
                            ),
                        ])
                        .kill_on_drop(true)
                        .output();
                    if let Ok(Ok(o)) = tokio::time::timeout(Duration::from_secs(10), probe).await {
                        let out = String::from_utf8_lossy(&o.stdout);
                        let (ver, path) = out.split_once("@@P@@").unwrap_or((out.as_ref(), ""));
                        v.installed = first_version_token(ver);
                        if let Some((pkg, is_cask)) = std::fs::canonicalize(path.trim())
                            .ok()
                            .and_then(|c| brew_pkg(&c.to_string_lossy()))
                        {
                            v.managed_by = Some("homebrew".into());
                            v.update = Some(if is_cask {
                                format!("brew upgrade --cask {pkg}")
                            } else {
                                format!("brew upgrade {pkg}")
                            });
                            // Latest from brew's tap (its notion of newest, which
                            // the install actually tracks), refreshed only when
                            // the frontend asks — same gate as the registry path.
                            if q.latest_url.is_some() {
                                let flag = if is_cask { "--cask " } else { "" };
                                let info = tokio::process::Command::new(&shell)
                                    .args([
                                        "-lc",
                                        &format!("brew info --json=v2 {flag}{pkg} 2>/dev/null"),
                                    ])
                                    .kill_on_drop(true)
                                    .output();
                                if let Ok(Ok(o)) =
                                    tokio::time::timeout(Duration::from_secs(10), info).await
                                {
                                    if let Ok(j) =
                                        serde_json::from_slice::<serde_json::Value>(&o.stdout)
                                    {
                                        v.latest = j
                                            .pointer("/formulae/0/versions/stable")
                                            .and_then(|x| x.as_str())
                                            .or_else(|| {
                                                j.pointer("/casks/0/version")
                                                    .and_then(|x| x.as_str())
                                            })
                                            .and_then(first_version_token);
                                    }
                                }
                            }
                        }
                    }
                }
                // Registry latest only when the install source isn't a package
                // manager we route ourselves — an npm/PyPI number is meaningless
                // for (and would falsely flag) a brew-managed binary.
                if v.managed_by.is_none() {
                    if let Some(url) = q.latest_url.filter(|u| u.starts_with("https://")) {
                        let fetch = tokio::process::Command::new("curl")
                            .args(["-fsSL", "-m", "8", url.as_str()])
                            .kill_on_drop(true)
                            .output();
                        if let Ok(Ok(o)) =
                            tokio::time::timeout(Duration::from_secs(10), fetch).await
                        {
                            if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&o.stdout)
                            {
                                // npm `/latest` → top-level "version"; PyPI → info.version.
                                v.latest = json
                                    .get("version")
                                    .and_then(|x| x.as_str())
                                    .or_else(|| {
                                        json.pointer("/info/version").and_then(|x| x.as_str())
                                    })
                                    .and_then(first_version_token);
                            }
                        }
                    }
                }
                (q.bin, v)
            }));
        }
        for t in tasks {
            if let Ok((bin, v)) = t.await {
                out.insert(bin, v);
            }
        }
    }
    #[cfg(not(unix))]
    let _ = queries;
    out
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
mod integration_tests {
    use super::*;

    /// A scratch home with the hook helper in place — every installer refuses
    /// to write without one. Named per test so the suite can run in parallel,
    /// and no test mutates the process's HOME.
    fn scratch_home(name: &str) -> std::path::PathBuf {
        let home =
            std::env::temp_dir().join(format!("canopy-integration-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join(".canopy/bin")).unwrap();
        std::fs::write(home.join(".canopy/bin/canopy-hook"), "#!/bin/sh\n").unwrap();
        // Antigravity's installer refuses to configure a CLI that has never
        // run, so its directory has to exist for agy to be a usable subject.
        // Its presence is not an integration — nothing here is set up yet.
        std::fs::create_dir_all(home.join(".gemini/antigravity-cli")).unwrap();
        home
    }

    fn write(path: &std::path::Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    // ---- read_json_config -------------------------------------------------

    /// The bug this whole hardening pass came from: Antigravity ships a 0-byte
    /// `~/.gemini/config/mcp_config.json`, and treating "exists but empty" as
    /// corruption made MCP setup fail on a machine where nothing was wrong.
    #[test]
    fn an_empty_config_file_reads_as_no_config_at_all() {
        let home = scratch_home("empty-read");
        let path = home.join("empty.json");
        for body in ["", "   ", "\n\n"] {
            write(&path, body);
            assert_eq!(
                read_json_config(&path).unwrap(),
                serde_json::json!({}),
                "{body:?} should read as an empty config"
            );
        }
        std::fs::remove_file(&path).unwrap();
        assert_eq!(read_json_config(&path).unwrap(), serde_json::json!({}));
    }

    /// Content we can't parse is a different thing entirely: somebody wrote it,
    /// and overwriting it would destroy their configuration.
    #[test]
    fn malformed_config_is_refused_rather_than_overwritten() {
        let home = scratch_home("bad-read");
        let path = home.join("bad.json");
        write(&path, "{ not json");
        let err = read_json_config(&path).unwrap_err();
        assert!(err.contains("is not valid JSON"), "{err}");
        assert!(
            err.contains("bad.json"),
            "the error must name the file: {err}"
        );
    }

    // ---- upsert_json_mcp --------------------------------------------------

    #[test]
    fn registering_into_an_empty_file_succeeds() {
        let home = scratch_home("empty-upsert");
        let path = home.join(".gemini/config/mcp_config.json");
        write(&path, "");
        let want = canopy_mcp_command(&helper_path_in(home.to_str().unwrap()));
        assert_eq!(
            upsert_json_mcp(path.clone(), "mcpServers", want, is_canopy_mcp_entry),
            Ok(true)
        );
        let cfg = read_json_config(&path).unwrap();
        assert!(is_canopy_mcp_entry(&cfg["mcpServers"]["canopy"]));
    }

    #[test]
    fn registering_twice_writes_once() {
        let home = scratch_home("idempotent");
        let path = home.join("cfg.json");
        let want = canopy_mcp_command(&helper_path_in(home.to_str().unwrap()));
        assert_eq!(
            upsert_json_mcp(
                path.clone(),
                "mcpServers",
                want.clone(),
                is_canopy_mcp_entry
            ),
            Ok(true)
        );
        assert_eq!(
            upsert_json_mcp(path.clone(), "mcpServers", want, is_canopy_mcp_entry),
            Ok(false),
            "an unchanged config must report no change"
        );
    }

    /// Other people's servers are not ours to move.
    #[test]
    fn sibling_servers_survive_registration() {
        let home = scratch_home("siblings");
        let path = home.join("cfg.json");
        write(
            &path,
            r#"{"mcpServers":{"docker":{"command":"docker","args":["mcp"]}},"theme":"dark"}"#,
        );
        let want = canopy_mcp_command(&helper_path_in(home.to_str().unwrap()));
        upsert_json_mcp(path.clone(), "mcpServers", want, is_canopy_mcp_entry).unwrap();
        let cfg = read_json_config(&path).unwrap();
        assert_eq!(cfg["mcpServers"]["docker"]["command"], "docker");
        assert_eq!(cfg["theme"], "dark", "unrelated keys must survive");
        assert!(is_canopy_mcp_entry(&cfg["mcpServers"]["canopy"]));
    }

    /// Setup runs on every launch, so anything it overwrites it overwrites
    /// forever. `enabled: false` is OpenCode's documented way to switch a
    /// server off — turning it back on at each start is the app fighting the
    /// user, silently.
    #[test]
    fn the_users_own_keys_on_our_entry_survive_a_re_register() {
        let home = scratch_home("keeps-user-keys");
        let path = home.join("cfg.json");
        let helper = helper_path_in(home.to_str().unwrap());
        write(
            &path,
            &format!(
                r#"{{"mcpServers":{{"canopy":{{"command":"{}","args":["--mcp"],"enabled":false,"timeout":90}}}}}}"#,
                helper.to_string_lossy().replace('\\', "\\\\")
            ),
        );
        let want = canopy_mcp_command(&helper);
        assert_eq!(
            upsert_json_mcp(path.clone(), "mcpServers", want, is_canopy_mcp_entry),
            Ok(false),
            "nothing of ours changed, so nothing should be written"
        );
        let cfg = read_json_config(&path).unwrap();
        assert_eq!(cfg["mcpServers"]["canopy"]["enabled"], false);
        assert_eq!(cfg["mcpServers"]["canopy"]["timeout"], 90);
    }

    /// The same rule when the helper *has* moved: our keys are refreshed, the
    /// user's are carried across.
    #[test]
    fn a_rewrite_refreshes_our_keys_and_keeps_theirs() {
        let home = scratch_home("rewrite-keeps-user-keys");
        let path = home.join("cfg.json");
        write(
            &path,
            r#"{"mcpServers":{"canopy":{"command":"/old/canopy-hook","args":["--mcp"],"enabled":false}}}"#,
        );
        let helper = helper_path_in(home.to_str().unwrap());
        let want = canopy_mcp_command(&helper);
        assert_eq!(
            upsert_json_mcp(path.clone(), "mcpServers", want, is_canopy_mcp_entry),
            Ok(true)
        );
        let cfg = read_json_config(&path).unwrap();
        assert_eq!(
            cfg["mcpServers"]["canopy"]["command"].as_str(),
            helper.to_str()
        );
        assert_eq!(cfg["mcpServers"]["canopy"]["enabled"], false);
    }

    /// The CLI the "app fights me" report was actually about: OpenCode's own
    /// switch for turning a server off. It must survive a launch, which means
    /// `enabled` must not be a key setup writes.
    #[test]
    fn a_disabled_opencode_server_stays_disabled() {
        let home = scratch_home("opencode-disabled");
        let h = home.to_str().unwrap();
        let path = home.join(".config/opencode/opencode.json");
        setup_opencode_mcp(h).unwrap();
        // The user switches it off, the documented way.
        let mut cfg = read_json_config(&path).unwrap();
        cfg["mcp"]["canopy"]["enabled"] = serde_json::json!(false);
        write(&path, &serde_json::to_string_pretty(&cfg).unwrap());
        // Next launch.
        setup_opencode_mcp(h).unwrap();
        assert_eq!(
            read_json_config(&path).unwrap()["mcp"]["canopy"]["enabled"],
            false
        );
    }

    /// `[mcp_servers."canopy"]` is the same table as the bare spelling. Missing
    /// it appended a second copy, and a duplicate key is a parse error that
    /// takes down every codex session.
    #[test]
    fn a_quoted_table_header_is_our_table() {
        let existing =
            "[mcp_servers.\"canopy\"]\ncommand = \"/old/canopy-hook\"\nargs = [\"--mcp\"]\n";
        let out = codex_toml_with_canopy(existing, "/new/canopy-hook")
            .unwrap()
            .expect("a moved helper path rewrites");
        assert_eq!(
            out.matches("mcp_servers").count(),
            1,
            "one table, not two: {out}"
        );
        assert!(out.contains("/new/canopy-hook"), "{out}");
    }

    /// Codex's own per-server options live in our table, and a launch that
    /// dropped them would drop them again on the next one.
    #[test]
    fn codex_keeps_the_options_the_user_added_to_our_table() {
        let existing = concat!(
            "[mcp_servers.canopy]\n",
            "command = \"/old/canopy-hook\"\n",
            "args = [\"--mcp\"]\n",
            "startup_timeout_ms = 30000\n",
            "\n",
            "[history]\n",
            "persistence = \"save-all\"\n",
        );
        let out = codex_toml_with_canopy(existing, "/new/canopy-hook")
            .unwrap()
            .expect("a moved helper path rewrites");
        assert!(out.contains("startup_timeout_ms = 30000"), "{out}");
        assert!(out.contains("[history]"), "{out}");
        // And now it settles: the same input twice is a no-op.
        assert_eq!(
            codex_toml_with_canopy(&out, "/new/canopy-hook").unwrap(),
            None
        );
    }

    /// A server called `canopy` that runs something else belongs to whoever
    /// wrote it. Refuse, and leave the file exactly as it was.
    #[test]
    fn a_foreign_canopy_server_is_refused_and_left_alone() {
        let home = scratch_home("foreign");
        let path = home.join("cfg.json");
        let before = r#"{"mcpServers":{"canopy":{"command":"/usr/local/bin/their-server"}}}"#;
        write(&path, before);
        let want = canopy_mcp_command(&helper_path_in(home.to_str().unwrap()));
        let err =
            upsert_json_mcp(path.clone(), "mcpServers", want, is_canopy_mcp_entry).unwrap_err();
        assert!(err.contains("does not own"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    /// An older Canopy wrote the entry without `type`; a newer one owns it and
    /// may update it in place.
    #[test]
    fn our_own_older_entry_is_upgraded_in_place() {
        let home = scratch_home("upgrade-entry");
        let path = home.join("cfg.json");
        write(
            &path,
            r#"{"mcpServers":{"canopy":{"command":"/old/path/canopy-hook","args":["--mcp"]}}}"#,
        );
        let helper = helper_path_in(home.to_str().unwrap());
        let want = canopy_mcp_command(&helper);
        assert_eq!(
            upsert_json_mcp(path.clone(), "mcpServers", want, is_canopy_mcp_entry),
            Ok(true)
        );
        let cfg = read_json_config(&path).unwrap();
        assert_eq!(
            cfg["mcpServers"]["canopy"]["command"],
            helper.to_string_lossy().as_ref()
        );
    }

    // ---- write_config_atomic ---------------------------------------------

    #[test]
    fn an_atomic_write_leaves_no_temp_file_behind() {
        let home = scratch_home("atomic");
        let path = home.join("nested/cfg.json");
        write_config_atomic(&path, "{\"a\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":1}");
        let strays: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().to_string()))
            .filter(|n| n != "cfg.json")
            .collect();
        assert!(strays.is_empty(), "left behind: {strays:?}");
    }

    /// `~/.claude.json` can hold credentials. A rewrite must not widen its mode.
    #[cfg(unix)]
    #[test]
    fn an_atomic_write_keeps_the_original_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let home = scratch_home("perms");
        let path = home.join("secret.json");
        write(&path, "{}");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        write_config_atomic(&path, "{\"b\":2}").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "0600 config came back as {mode:o}");
    }

    // ---- codex's TOML registry -------------------------------------------

    #[test]
    fn codex_registration_appends_and_then_no_ops() {
        let existing = "[mcp_servers]\n[mcp_servers.MCP_DOCKER]\ncommand = 'docker'\n";
        let out = codex_toml_with_canopy(existing, "/h/.canopy/bin/canopy-hook")
            .unwrap()
            .expect("first write registers");
        assert!(out.contains("[mcp_servers.MCP_DOCKER]"), "{out}");
        assert!(out.contains("[mcp_servers.canopy]"), "{out}");
        assert_eq!(
            codex_toml_with_canopy(&out, "/h/.canopy/bin/canopy-hook").unwrap(),
            None,
            "an unchanged config must not be rewritten"
        );
        assert_eq!(codex_mcp_state(&out), "ours");
    }

    /// A section that points somewhere else is not ours to rewrite.
    #[test]
    fn a_foreign_codex_section_is_refused() {
        let existing = "[mcp_servers.canopy]\ncommand = \"/opt/theirs\"\n";
        assert!(codex_toml_with_canopy(existing, "/h/canopy-hook")
            .unwrap_err()
            .contains("does not own"));
        assert_eq!(codex_mcp_state(existing), "foreign");
    }

    /// The inline form is one Canopy never writes, and appending our section
    /// beside it would be a duplicate key — a TOML error that breaks every
    /// codex session. Refuse instead of corrupting.
    #[test]
    fn an_inline_canopy_key_is_refused_rather_than_duplicated() {
        let existing = "[mcp_servers]\ncanopy = { command = \"/opt/theirs\" }\n";
        let err = codex_toml_with_canopy(existing, "/h/canopy-hook").unwrap_err();
        assert!(err.contains("inline"), "{err}");
        assert_eq!(codex_mcp_state(existing), "foreign");
    }

    /// Our path moves when the app is reinstalled elsewhere; the section is
    /// ours, so it gets updated rather than refused.
    #[test]
    fn a_stale_helper_path_is_rewritten() {
        let existing = "[mcp_servers.canopy]\ncommand = \"/old/canopy-hook\"\nargs = [\"--mcp\"]\n";
        let out = codex_toml_with_canopy(existing, "/new/canopy-hook")
            .unwrap()
            .expect("a stale path is a change");
        assert!(out.contains("/new/canopy-hook"), "{out}");
        assert!(!out.contains("/old/canopy-hook"), "{out}");
    }

    #[test]
    fn codex_state_reads_missing_when_nothing_is_registered() {
        assert_eq!(codex_mcp_state(""), "missing");
        assert_eq!(codex_mcp_state("[projects]\nfoo = 1\n"), "missing");
    }

    // ---- setup dispatch ---------------------------------------------------

    /// The failure that shipped: agy's MCP step erroring took the hooks step's
    /// result with it, so a half-succeeding setup reported only a parse error.
    /// Now both are reported, whatever each did.
    #[test]
    fn a_failing_step_does_not_erase_the_other_ones_result() {
        let home = scratch_home("partial");
        let h = home.to_str().unwrap();
        // Malformed (not merely empty) MCP registry: this one really can't be
        // written, and the hooks step knows nothing about it.
        write(&home.join(".gemini/config/mcp_config.json"), "{ oops");
        let report = setup_agent("agy", h).unwrap();
        assert!(!report.ok);
        assert_eq!(report.steps.len(), 2);
        assert!(report.steps[0].ok, "hooks should still install: {report:?}");
        assert!(!report.steps[1].ok);
        assert!(
            report.summary.contains("mcp failed"),
            "the summary must name the failing step: {}",
            report.summary
        );
        assert!(
            home.join(".gemini/antigravity-cli/hooks.json").exists(),
            "the hooks step's side effects must have happened"
        );
    }

    #[test]
    fn a_clean_setup_reports_every_step_ok() {
        let home = scratch_home("clean");
        let report = setup_agent("agy", home.to_str().unwrap()).unwrap();
        assert!(report.ok, "{report:?}");
        assert_eq!(mcp_state("agy", home.to_str().unwrap()), "ours");
        assert!(hooks_are_ours("agy", home.to_str().unwrap()));
    }

    #[test]
    fn an_unknown_agent_is_an_error_not_an_empty_report() {
        assert!(setup_agent("emacs", "/nowhere").is_err());
    }

    // ---- health + startup repair -----------------------------------------

    #[test]
    fn health_reports_missing_foreign_and_ours_apart() {
        let home = scratch_home("health");
        let h = home.to_str().unwrap();
        let none: HashMap<String, bool> = HashMap::new();

        let before = integration_health(h, &none);
        let agy = before.iter().find(|x| x.agent == "agy").unwrap();
        assert_eq!((agy.hooks, agy.mcp), ("missing", "missing"));

        setup_agent("agy", h).unwrap();
        let after = integration_health(h, &none);
        let agy = after.iter().find(|x| x.agent == "agy").unwrap();
        assert_eq!((agy.hooks, agy.mcp), ("ours", "ours"));

        write(
            &home.join(".config/opencode/opencode.json"),
            r#"{"mcp":{"canopy":{"command":["/opt/not-ours"]}}}"#,
        );
        let mixed = integration_health(h, &none);
        let oc = mixed.iter().find(|x| x.agent == "opencode").unwrap();
        assert_eq!(oc.mcp, "foreign");

        // aider has hooks but no MCP integration point at all — a different
        // thing from one that is missing.
        let aider = mixed.iter().find(|x| x.agent == "aider").unwrap();
        assert_eq!(aider.mcp, "unsupported");
    }

    /// The PATH probe, as a launch would hand it over. Only agy, so a test's
    /// result never depends on which CLIs the machine running it happens to
    /// have installed.
    fn only_agy_installed() -> HashMap<String, bool> {
        SUPPORTED_AGENTS
            .iter()
            .map(|(_, bin)| ((*bin).to_string(), *bin == "agy"))
            .collect()
    }

    /// The repair exists for exactly this: a machine set up by a version that
    /// only wrote hooks, then updated to one that also registers MCP.
    #[test]
    fn a_launch_fills_in_a_step_an_older_version_never_wrote() {
        let home = scratch_home("heal-missing");
        let h = home.to_str().unwrap();
        setup_agent("agy", h).unwrap();
        std::fs::remove_file(home.join(".gemini/config/mcp_config.json")).unwrap();

        let report = heal_integrations_in(h, "9.9.9", &only_agy_installed());
        assert_eq!(mcp_state("agy", h), "ours", "the hole should be filled");
        assert!(
            report.repaired.iter().any(|r| r.starts_with("agy")),
            "{:?}",
            report.repaired
        );
        assert!(report.failed.is_empty(), "{:?}", report.failed);
    }

    /// The renderer loop this replaces wrote hooks and MCP entries for all
    /// seven CLIs whether or not you had them. Configuring a CLI that isn't
    /// installed helps nobody and leaves files behind in a home that never
    /// asked for them.
    #[test]
    fn a_launch_leaves_uninstalled_clis_alone() {
        let home = scratch_home("heal-uninstalled");
        let h = home.to_str().unwrap();
        let report = heal_integrations_in(h, "9.9.9", &only_agy_installed());
        assert!(
            report.repaired.iter().all(|r| r.starts_with("agy")),
            "{:?}",
            report.repaired
        );
        assert!(!home.join(".claude/settings.json").exists());
        assert!(!home.join(".codex/hooks.json").exists());
        assert!(!home.join(".claude.json").exists());
        assert!(!home.join(".config/opencode/plugin/canopy.ts").exists());
    }

    /// An installed CLI does get wired up on first sight — that is the
    /// behaviour the renderer loop had, and the one users expect from an IDE
    /// whose whole point is watching agents work.
    #[test]
    fn a_launch_sets_up_an_installed_cli_it_has_never_seen() {
        let home = scratch_home("heal-first-run");
        let h = home.to_str().unwrap();
        let report = heal_integrations_in(h, "1.0.0", &only_agy_installed());
        assert!(
            report.repaired.iter().any(|r| r.contains("not set up yet")),
            "{:?}",
            report.repaired
        );
        assert!(hooks_are_ours("agy", h));
        assert_eq!(mcp_state("agy", h), "ours");
    }

    /// Same version, nothing missing: the pass is a no-op that rewrites
    /// nothing, so a launch can't churn files the user is watching.
    #[test]
    fn a_second_launch_on_the_same_version_changes_nothing() {
        let home = scratch_home("heal-stable");
        let h = home.to_str().unwrap();
        setup_agent("agy", h).unwrap();
        heal_integrations_in(h, "1.2.3", &only_agy_installed());
        let hooks = home.join(".gemini/antigravity-cli/hooks.json");
        let before = std::fs::metadata(&hooks).unwrap().modified().unwrap();

        let report = heal_integrations_in(h, "1.2.3", &only_agy_installed());
        assert!(!report.upgraded);
        assert!(report.repaired.is_empty(), "{:?}", report.repaired);
        assert_eq!(
            std::fs::metadata(&hooks).unwrap().modified().unwrap(),
            before,
            "an unchanged integration must not be rewritten"
        );
    }

    /// A version bump re-applies owned integrations, because that is when a
    /// generated hook file's contents can have changed underneath them.
    #[test]
    fn an_upgrade_re_applies_what_it_owns() {
        let home = scratch_home("heal-upgrade");
        let h = home.to_str().unwrap();
        setup_agent("agy", h).unwrap();
        heal_integrations_in(h, "1.0.0", &only_agy_installed());
        // Something (an older template, a user edit) left a stale hook file.
        write(&home.join(".gemini/antigravity-cli/hooks.json"), "{}");

        let report = heal_integrations_in(h, "1.0.1", &only_agy_installed());
        assert!(report.upgraded);
        assert!(
            hooks_are_ours("agy", h),
            "the upgrade should have rewritten the stale file"
        );
        assert!(report
            .repaired
            .iter()
            .any(|r| r.contains("upgraded to 1.0.1")));
    }

    /// An MCP server somebody else registered under our name survives the
    /// launch untouched, and the refusal is reported against the step it
    /// belongs to rather than swallowing the hooks step's success with it.
    #[test]
    fn a_launch_does_not_touch_a_foreign_registration() {
        let home = scratch_home("heal-foreign");
        let h = home.to_str().unwrap();
        setup_agent("agy", h).unwrap();
        let path = home.join(".gemini/config/mcp_config.json");
        let theirs = r#"{"mcpServers":{"canopy":{"command":"/opt/theirs"}}}"#;
        write(&path, theirs);

        let report = heal_integrations_in(h, "1.0.0", &only_agy_installed());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            theirs,
            "their config must come back byte for byte"
        );
        assert!(
            report.failed.iter().any(|f| f.contains("agy mcp:")),
            "{:?}",
            report.failed
        );
        assert!(
            !report.failed.iter().any(|f| f.contains("agy hooks:")),
            "the hooks step succeeded and must not be reported as failed: {:?}",
            report.failed
        );
        let agy = report.agents.iter().find(|a| a.agent == "agy").unwrap();
        assert_eq!(agy.mcp, "foreign", "and it is visible in the report");
    }

    /// An owned integration is still maintained when the PATH probe comes back
    /// empty — a GUI launch that can't reproduce the login shell must not
    /// orphan hooks we already wrote.
    #[test]
    fn an_owned_integration_survives_a_failed_path_probe() {
        let home = scratch_home("heal-nopath");
        let h = home.to_str().unwrap();
        setup_agent("agy", h).unwrap();
        std::fs::remove_file(home.join(".gemini/config/mcp_config.json")).unwrap();

        let report = heal_integrations_in(h, "1.0.0", &HashMap::new());
        assert_eq!(mcp_state("agy", h), "ours");
        assert!(
            report.repaired.iter().any(|r| r.starts_with("agy")),
            "{:?}",
            report.repaired
        );
    }
}

#[cfg(test)]
mod tests {
    use super::claude_bucket;
    use super::first_version_token;
    use super::probe_target;
    use super::sh_quote;

    /// The whole point of the rewrite, against a real pty: the terminal's
    /// foreground program is the candidate — not the shell that is idling, and
    /// not a grandchild the program spawned.
    #[cfg(unix)]
    #[test]
    fn the_foreground_program_is_the_candidate() {
        use super::{
            candidate_pid, HashMap, Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind,
        };
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{Read, Write};
        use std::time::{Duration, Instant};

        let pty = native_pty_system().openpty(PtySize::default()).unwrap();
        // Interactive, so the shell turns on job control and hands the terminal
        // to what it runs — which is what tcgetpgrp reports.
        let mut cmd = CommandBuilder::new("bash");
        cmd.arg("-i");
        cmd.env("PS1", "$ ");
        let mut child = pty.slave.spawn_command(cmd).unwrap();
        drop(pty.slave);
        let root = child.process_id().unwrap();
        let mut writer = pty.master.take_writer().unwrap();
        // Drain the master: a full buffer would block the shell.
        let mut reader = pty.master.try_clone_reader().unwrap();
        std::thread::spawn(move || {
            let mut buf = [0_u8; 4096];
            while reader.read(&mut buf).map(|n| n > 0).unwrap_or(false) {}
        });

        let scan = |sys: &mut System| {
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing().with_cmd(UpdateKind::OnlyIfNotSet),
            );
            let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
            for (pid, proc_) in sys.processes() {
                if let Some(parent) = proc_.parent() {
                    children
                        .entry(parent.as_u32())
                        .or_default()
                        .push(pid.as_u32());
                }
            }
            children
        };
        let settle = |pty: &Box<dyn portable_pty::MasterPty + Send>, want_root: bool| {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let fg = pty.process_group_leader().map(|p| p as u32);
                if (fg == Some(root)) == want_root && fg.is_some() {
                    return fg;
                }
                assert!(Instant::now() < deadline, "pty foreground never settled");
                std::thread::sleep(Duration::from_millis(50));
            }
        };

        let mut sys = System::new();
        // Idle at its prompt: the shell holds its own terminal, and a shell is
        // not something to put in the Agents panel.
        let fg = settle(&pty.master, true);
        let children = scan(&mut sys);
        assert_eq!(candidate_pid(&sys, root, fg, &children), None);

        // Now run something that itself spawns a child. The candidate must be
        // the program the shell started, never the grandchild underneath it —
        // that is the failure mode where an MCP server or a `git` named the row.
        writeln!(writer, "bash -c 'sleep 30 & wait' ").unwrap();
        writer.flush().unwrap();
        let fg = settle(&pty.master, false);
        let children = scan(&mut sys);
        let candidate = candidate_pid(&sys, root, fg, &children).expect("a foreground program");
        assert_eq!(
            sys.process(Pid::from_u32(candidate))
                .and_then(|p| p.parent())
                .map(|p| p.as_u32()),
            Some(root),
            "the candidate must be the shell's own child"
        );
        let _ = child.kill();
    }

    /// Real `--version` output shapes from the registered CLIs, plus the
    /// noise cases: a bare CLI name has no version, and a prerelease suffix
    /// yields its release core.
    #[test]
    fn version_token_matches_real_cli_output() {
        assert_eq!(
            first_version_token("2.1.217 (Claude Code)").as_deref(),
            Some("2.1.217")
        );
        assert_eq!(
            first_version_token("codex-cli 0.98.0").as_deref(),
            Some("0.98.0")
        );
        assert_eq!(
            first_version_token("aider 0.86.1").as_deref(),
            Some("0.86.1")
        );
        assert_eq!(first_version_token("v1.2").as_deref(), Some("1.2"));
        assert_eq!(
            first_version_token("1.2.3-beta.4").as_deref(),
            Some("1.2.3")
        );
        assert_eq!(first_version_token("opencode"), None);
        assert_eq!(first_version_token(""), None);
        // A lone integer (an exit code, a count) must not read as a version.
        assert_eq!(first_version_token("exit 1"), None);
    }

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

    #[test]
    fn sh_quote_neutralises_embedded_quotes() {
        assert_eq!(sh_quote("claude"), "'claude'");
        // The POSIX '\'' idiom: close, escaped quote, reopen. Anything that
        // tried to break out ends up as literal text inside the quotes.
        assert_eq!(
            sh_quote("a'; rm -rf /; echo '"),
            r"'a'\''; rm -rf /; echo '\'''"
        );
    }

    /// The whole point of replacing the old charset whitelist: these are the
    /// shapes a rebound enterprise CLI actually takes, and every one of them
    /// used to report "not installed" no matter what was on disk.
    #[test]
    fn probe_target_accepts_the_shapes_an_override_takes() {
        assert_eq!(probe_target("claude").as_deref(), Some("claude"));
        assert_eq!(probe_target("acme-claude").as_deref(), Some("acme-claude"));
        assert_eq!(
            probe_target("/opt/acme/bin/claude").as_deref(),
            Some("/opt/acme/bin/claude")
        );
        assert_eq!(probe_target("claude.sh").as_deref(), Some("claude.sh"));
        // Surrounding whitespace is the user's, not the value's.
        assert_eq!(probe_target("  claude  ").as_deref(), Some("claude"));
    }

    #[test]
    fn probe_target_expands_a_leading_tilde() {
        // Tilde expansion doesn't happen inside the quotes the value lands in,
        // so it has to happen here or `~/bin/claude` never resolves.
        let home = std::env::var("HOME").unwrap();
        assert_eq!(
            probe_target("~/bin/claude").as_deref(),
            Some(format!("{home}/bin/claude").as_str())
        );
    }

    /// `Program Files` is *the* enterprise install location on Windows, and
    /// spaced application paths are ordinary on macOS too. Rejecting them left
    /// the row saying "install" forever — the exact symptom rebinding exists to
    /// end, and the shape the identity-folding test already uses as its fixture.
    #[test]
    fn probe_target_keeps_the_spaces_in_a_path() {
        assert_eq!(
            probe_target(r"C:\Program Files\Acme\Claude.exe").as_deref(),
            Some(r"C:\Program Files\Acme\Claude.exe")
        );
        assert_eq!(
            probe_target("/Applications/Acme CLI/bin/claude").as_deref(),
            Some("/Applications/Acme CLI/bin/claude")
        );
    }

    #[test]
    fn probe_target_rejects_non_candidates() {
        assert_eq!(probe_target(""), None);
        assert_eq!(probe_target("   "), None);
        // Arguments belong to a launch command, not to a field naming one
        // executable — and `command -v` would answer about the wrong thing.
        assert_eq!(probe_target("acme run claude"), None);
        // A newline would corrupt the line-based parse of the probe's output.
        assert_eq!(probe_target("claude\necho pwned"), None);
    }
}
