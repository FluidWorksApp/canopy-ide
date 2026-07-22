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
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
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
                tick = tick.wrapping_add(1);
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
                // With no terminals there is nothing hot to watch — only the
                // app-footprint number in the status bar, which nobody needs at
                // 2s resolution. Skip two of every three ticks entirely.
                if sessions.is_empty() && tick % 3 != 0 {
                    continue;
                }
                // Refresh only what the monitor actually reads. The default
                // full refresh re-fetches every process's cmdline, exe path,
                // environment and cwd — each a sysctl/proc read, for every
                // process on the machine, every tick. cmd is the one non-cheap
                // field we use (agent detection / restore), and it never
                // changes after exec — fetch it once per process and keep it.
                sys.refresh_processes_specifics(
                    ProcessesToUpdate::All,
                    true,
                    ProcessRefreshKind::nothing()
                        .with_cpu()
                        .with_memory()
                        .with_cmd(UpdateKind::OnlyIfNotSet),
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
        "agy" => setup_agy_hooks(&home),
        "aider" => setup_aider_hooks(&home),
        "opencode" => setup_opencode_plugin(&home),
        "omp" => setup_omp_hook(&home),
        "amp" => setup_amp_plugin(&home),
        _ => Err(format!("auto-setup not supported for {agent} yet")),
    }
}

/// Aider has no hook system, but `notifications-command` runs an arbitrary
/// command whenever it is waiting for input — after a turn AND at y/n
/// confirms (verified in its io.py). The helper's --event mode synthesizes
/// the JSON aider can't provide; session identity is per-terminal, which is
/// enough for cards and deliberately never enough to look restorable.
fn setup_aider_hooks(home: &str) -> Result<String, String> {
    let helper = helper_path()?;
    if !helper.exists() {
        return Err(format!("hook helper missing at {}", helper.display()));
    }
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
    if std::fs::read_to_string(&path).map(|s| s == source).unwrap_or(false) {
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
    let helper = helper_path()?;
    if !helper.exists() {
        return Err(format!("hook helper missing at {}", helper.display()));
    }
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
    let helper = helper_path()?;
    if !helper.exists() {
        return Err(format!("hook helper missing at {}", helper.display()));
    }
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
    let helper = helper_path()?;
    if !helper.exists() {
        return Err(format!("hook helper missing at {}", helper.display()));
    }
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
    let helper = helper_path()?;
    if !helper.exists() {
        return Err(format!(
            "hook helper missing at {} — hooks not installed",
            helper.display()
        ));
    }
    let dir = std::path::PathBuf::from(home).join(".gemini").join("antigravity-cli");
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
        if notif { " (+ terminal notifications enabled)" } else { "" }
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
        let Ok(entries) = std::fs::read_dir(dir.path()) else { continue };
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
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
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
    // Two generations, both installed. The full hooks system (stable since
    // ~v0.124) is modeled on Claude Code's — same event names, same stdin
    // payload (session_id, transcript_path, cwd, hook_event_name) — so it
    // routes through the same helper and unlocks the whole pipeline: stamped
    // events, digests, restore, permission cards, context. The legacy
    // `notify` stays for older versions; it only fires agent-turn-complete
    // and writes the bridge raw, which degrades gracefully to idle cards.
    let notify = setup_codex_notify(home, bridge);

    let helper = helper_path()?;
    if !helper.exists() {
        return Err(format!(
            "hook helper missing at {} — hooks not installed",
            helper.display()
        ));
    }
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
        let Some(arr) = list.as_array_mut() else { continue };
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
fn setup_codex_notify(home: &str, bridge: &str) -> Result<String, String> {
    let dir = std::path::PathBuf::from(home).join(".codex");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("config.toml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if existing.contains("agent-events.jsonl") {
        return Ok("already".into());
    }
    if existing.lines().any(|l| l.trim_start().starts_with("notify")) {
        return Err("custom notify present".into());
    }
    // Codex passes the notification JSON as an argument, not stdin.
    let line = format!(
        "notify = [\"/bin/sh\", \"-c\", \"printf '%s\\\\n' \\\"$0\\\" >> {bridge}\"]\n"
    );
    std::fs::write(&path, format!("{existing}\n{line}")).map_err(|e| e.to_string())?;
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

/// One CLI's version pair: what's on disk vs what its registry publishes.
/// Either side is None when unknown — not installed, unparseable output, no
/// registry to ask, or the probe timed out.
#[derive(Serialize, Clone, Default)]
pub struct CliVersions {
    pub installed: Option<String>,
    pub latest: Option<String>,
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
                // Same charset guard as which_check — the name lands in a shell line.
                if q.bin
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
                {
                    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
                    let probe = tokio::process::Command::new(shell)
                        .args(["-lc", &format!("{} --version 2>&1", q.bin)])
                        .kill_on_drop(true)
                        .output();
                    if let Ok(Ok(o)) =
                        tokio::time::timeout(Duration::from_secs(10), probe).await
                    {
                        v.installed = first_version_token(&String::from_utf8_lossy(&o.stdout));
                    }
                }
                if let Some(url) = q.latest_url.filter(|u| u.starts_with("https://")) {
                    let fetch = tokio::process::Command::new("curl")
                        .args(["-fsSL", "-m", "8", url.as_str()])
                        .kill_on_drop(true)
                        .output();
                    if let Ok(Ok(o)) =
                        tokio::time::timeout(Duration::from_secs(10), fetch).await
                    {
                        if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&o.stdout) {
                            // npm `/latest` → top-level "version"; PyPI → info.version.
                            v.latest = json
                                .get("version")
                                .and_then(|x| x.as_str())
                                .or_else(|| json.pointer("/info/version").and_then(|x| x.as_str()))
                                .and_then(first_version_token);
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
mod tests {
    use super::claude_bucket;
    use super::first_version_token;

    /// Real `--version` output shapes from the registered CLIs, plus the
    /// noise cases: a bare CLI name has no version, and a prerelease suffix
    /// yields its release core.
    #[test]
    fn version_token_matches_real_cli_output() {
        assert_eq!(first_version_token("2.1.217 (Claude Code)").as_deref(), Some("2.1.217"));
        assert_eq!(first_version_token("codex-cli 0.98.0").as_deref(), Some("0.98.0"));
        assert_eq!(first_version_token("aider 0.86.1").as_deref(), Some("0.86.1"));
        assert_eq!(first_version_token("v1.2").as_deref(), Some("1.2"));
        assert_eq!(first_version_token("1.2.3-beta.4").as_deref(), Some("1.2.3"));
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
}
