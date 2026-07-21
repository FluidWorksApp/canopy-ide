//! `canopy-hook` — the single binary every agent-CLI hook invokes.
//!
//! Two jobs, both driven by the JSON event the CLI writes to our stdin:
//!
//!   1. Mirror the event onto the IDE's event bus (`agent-events.jsonl`) and
//!      keep a small per-session digest up to date.
//!   2. On `SessionStart` / `UserPromptSubmit`, print peer sessions' digests
//!      back as `additionalContext`, so an agent working on the backend can see
//!      what the agent on the frontend just did.
//!
//! Why a binary and not a shell one-liner: this has to parse JSON, pick peers,
//! budget tokens and emit a precise JSON contract. That is not a `sed` job.
//!
//! Hard-won contract details (verified on the wire, not from the docs — the
//! published docs are wrong about the first one):
//!   * `UserPromptSubmit` delivers the prompt as `prompt`, NOT `user_input`.
//!   * `additionalContext` MUST be nested inside `hookSpecificOutput` or it is
//!     silently ignored.
//!   * 10,000 char cap; ~30s timeout, after which context is silently dropped
//!     while the prompt proceeds anyway. So: never block, always be fast.
//!   * exit 2 discards stdout AND erases the user's prompt. We ALWAYS exit 0 —
//!     a broken digest must never cost someone their typed prompt.
//!
//! Per-session files are deliberate. A single shared store would need locking
//! across independent processes; one file per session means concurrent sessions
//! never write the same path, so there is nothing to clobber.

use std::collections::BTreeMap;
use std::io::Read;

const MAX_PROMPTS: usize = 6;
const MAX_FILES: usize = 14;
/// Well under the 10k char cap: the real constraint is context pollution, not
/// the limit. Injecting a wall of text every turn also breaks the prompt cache.
const MAX_CONTEXT_CHARS: usize = 4_000;
/// Peers quiet for longer than this aren't worth injecting.
const PEER_MAX_AGE_SECS: u64 = 8 * 3600;

fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn main() {
    // Any failure exits 0 with no stdout: a hook must never break the session
    // it's attached to.
    if let Err(_e) = real_main() {
        std::process::exit(0);
    }
}

fn real_main() -> Result<(), Box<dyn std::error::Error>> {
    // Only act for terminals this IDE spawned. The hooks live in the user's
    // global settings, so without this every agent on the machine would feed
    // our bus and read our context.
    if std::env::var("CANOPY").as_deref() != Ok("1") {
        return Ok(());
    }

    // Which CLI's hook invoked us. Claude needs no flag (its contract is the
    // default); other agents' setup registers `canopy-hook --agent <id>` so we
    // can normalize their event names and speak their stdout contract.
    let mut args = std::env::args().skip(1);
    let mut agent_override: Option<String> = None;
    let mut synth_event: Option<String> = None;
    let mut synth_message: Option<String> = None;
    while let Some(a) = args.next() {
        match a.as_str() {
            "--agent" => agent_override = args.next(),
            "--event" => synth_event = args.next(),
            "--message" => synth_message = args.next(),
            _ => {}
        }
    }

    // Two input modes. Default: the CLI delivers event JSON on stdin (claude,
    // codex, agy). Synthesized (--event): the CLI can only run a bare command
    // with no payload (aider's notifications-command), so we build the event
    // ourselves from the flags and the environment.
    let mut raw = String::new();
    let mut event: serde_json::Value = if let Some(name) = synth_event {
        let agent = agent_override.clone().unwrap_or_else(|| "agent".into());
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        // No real session identity exists in this mode; one stable id per
        // terminal keeps derivePending's per-session grouping working without
        // inventing restorable-looking sessions (no prompts ever recorded, so
        // the restore UI filters these out).
        let pty = std::env::var("CANOPY_PTY").unwrap_or_default();
        serde_json::json!({
            "hook_event_name": name,
            "session_id": format!("{agent}-pty{pty}"),
            "cwd": cwd,
            "message": synth_message.unwrap_or_default(),
        })
    } else {
        std::io::stdin().read_to_string(&mut raw)?;
        match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => return Ok(()),
        }
    };
    if raw.is_empty() {
        raw = serde_json::to_string(&event).unwrap_or_default();
    }

    if let Some(agent) = agent_override.as_deref() {
        normalize_event(&mut event, agent);
    }

    let session_id = event["session_id"].as_str().unwrap_or("").to_string();
    let cwd = event["cwd"].as_str().unwrap_or("").to_string();
    let hook_event = event["hook_event_name"].as_str().unwrap_or("").to_string();

    publish_to_bus(&raw, &event);
    if !session_id.is_empty() {
        let _ = update_digest(&session_id, &cwd, &event, &hook_event);
    }

    match agent_override.as_deref() {
        // Antigravity requires PreToolUse hooks to answer with an allow/deny
        // verdict on stdout; we only observe, so always allow. Its other
        // events ignore stdout. No peer-context printing: the
        // hookSpecificOutput contract below is Claude's, and feeding it to
        // agy would at best be ignored and at worst confuse its parser.
        Some("agy") => {
            if event["agy_event"].as_str() == Some("PreToolUse") {
                println!("{}", serde_json::json!({ "allow_tool": true }));
            }
        }
        // Claude and Codex share the injection contract — Codex's hooks
        // system is modeled on Claude's, and its docs use the same
        // hookSpecificOutput.additionalContext shape for SessionStart /
        // UserPromptSubmit context. Anything else: observation only.
        None | Some("codex") => {
            if hook_event == "UserPromptSubmit" || hook_event == "SessionStart" {
                if let Some(context) = peer_context(&session_id, &cwd) {
                    let out = serde_json::json!({
                        "hookSpecificOutput": {
                            "hookEventName": hook_event,
                            "additionalContext": context,
                        }
                    });
                    println!("{out}");
                }
            }
        }
        Some(_) => {}
    }
    Ok(())
}

/// Rewrite a foreign CLI's event into the shape the rest of the pipeline
/// (bus consumers, digests) already understands, and tag it with its agent so
/// nothing downstream mislabels it as claude.
fn normalize_event(event: &mut serde_json::Value, agent: &str) {
    let Some(map) = event.as_object_mut() else { return };
    map.insert("agent".into(), serde_json::json!(agent));
    if agent == "agy" {
        // Antigravity's lifecycle names differ from Claude's; keep the
        // original under agy_event (the PreToolUse allow-verdict check needs
        // it) and translate: PreInvocation is its prompt-submit, PostInvocation
        // its turn-end.
        let name = map
            .get("hook_event_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        map.insert("agy_event".into(), serde_json::json!(name));
        let mapped = match name.as_str() {
            "PreInvocation" => "UserPromptSubmit",
            "PostInvocation" => "Stop",
            other => other,
        };
        map.insert("hook_event_name".into(), serde_json::json!(mapped));
        // Digests read the prompt from `prompt` (Claude's field). Antigravity's
        // field name is unverified — take the likeliest candidates.
        if map.get("prompt").and_then(|v| v.as_str()).is_none() {
            for key in ["user_input", "input", "display"] {
                if let Some(v) = map.get(key).and_then(|v| v.as_str()) {
                    let v = v.to_string();
                    map.insert("prompt".into(), serde_json::json!(v));
                    break;
                }
            }
        }
    }
}

/// Append the event to the bus the IDE tails, stamped with the terminal it came
/// from so the UI can attribute it to a tab.
fn publish_to_bus(raw: &str, event: &serde_json::Value) {
    use std::io::Write;
    let dir = format!("{}/.canopy", home());
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let mut obj = event.clone();
    if let Some(map) = obj.as_object_mut() {
        if let Ok(pty) = std::env::var("CANOPY_PTY") {
            if let Ok(n) = pty.parse::<u64>() {
                map.insert("canopy_pty".into(), serde_json::json!(n));
            }
        }
    }
    let line = serde_json::to_string(&obj).unwrap_or_else(|_| raw.replace('\n', " "));
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(format!("{dir}/agent-events.jsonl"))
    {
        let _ = writeln!(f, "{line}");
    }
}

/// One file per session; this process is the only writer for its own session,
/// and hook invocations within a session are serial.
fn update_digest(
    session_id: &str,
    cwd: &str,
    event: &serde_json::Value,
    hook_event: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let dir = format!("{}/.canopy/sessions", home());
    std::fs::create_dir_all(&dir)?;
    let path = format!("{dir}/{session_id}.json");

    let mut digest: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| {
            // First sighting of this session. `launch_cwd` and `surface` are
            // written here and never again — see below.
            serde_json::json!({
                "session_id": session_id,
                "prompts": [],
                "files": [],
                "launch_cwd": cwd,
                // Which terminal owns this session. Inherited from the env we
                // set at pty spawn, so it survives the user typing `claude`
                // themselves rather than using a launcher. Binding a session to
                // a surface any other way means guessing — matching on terminal
                // titles or picking the newest file by mtime both silently
                // attach to the wrong session.
                "surface": std::env::var("CANOPY_PTY").ok(),
                // Pty ids reset per app launch and every instance writes here, so
                // `surface` alone collides across instances/restarts. This tag,
                // unique per launch, is what the panel pairs on so one instance's
                // "term #5" digest can't bind to another's terminal.
                "instance": std::env::var("CANOPY_INSTANCE").ok(),
            })
        });

    // `cwd` is where the agent is *now* and moves as it cds. `launch_cwd` is
    // where it started and must not: agents that namespace a conversation by
    // directory (claude, gemini, cursor) only find it again from there, so
    // resuming from a drifted cwd fails with "No conversation found". Starting
    // at a repo root and moving into a worktree is routine, which makes this
    // the normal case rather than an edge one.
    digest["cwd"] = serde_json::json!(cwd);
    if digest.get("launch_cwd").and_then(|v| v.as_str()).is_none() {
        // Digest predates this field, or was created by an older build.
        digest["launch_cwd"] = serde_json::json!(cwd);
    }
    digest["updated"] = serde_json::json!(now_secs());
    if let Some(t) = event["transcript_path"].as_str() {
        digest["transcript_path"] = serde_json::json!(t);
    }
    // Agent identity: claude's payloads carry session_id; others set `agent`.
    let agent = event["agent"]
        .as_str()
        .unwrap_or(if event["session_id"].is_string() { "claude" } else { "agent" });
    digest["agent"] = serde_json::json!(agent);
    if let Some(b) = git_branch(cwd) {
        digest["branch"] = serde_json::json!(b);
    }
    if hook_event == "Stop" {
        digest["idle"] = serde_json::json!(true);
    } else {
        digest["idle"] = serde_json::json!(false);
    }

    // What the human actually asked for — the highest-signal, lowest-token
    // summary of what a session is doing. NB: the field is `prompt`; the docs
    // say `user_input`, which does not exist on the wire.
    if hook_event == "UserPromptSubmit" {
        if let Some(p) = event["prompt"].as_str() {
            let p = p.trim();
            if !p.is_empty() {
                if let Some(arr) = digest["prompts"].as_array_mut() {
                    arr.push(serde_json::json!(truncate(p, 220)));
                    while arr.len() > MAX_PROMPTS {
                        arr.remove(0);
                    }
                }
            }
        }
    }

    // Which files this session is touching — the thing peers most need, since
    // it's how they avoid colliding on the same code.
    if let Some(path_touched) = event["tool_input"]["file_path"].as_str() {
        let rel = path_touched
            .strip_prefix(&format!("{cwd}/"))
            .unwrap_or(path_touched)
            .to_string();
        let tool = event["tool_name"].as_str().unwrap_or("");
        if matches!(tool, "Edit" | "Write" | "NotebookEdit" | "MultiEdit") {
            if let Some(arr) = digest["files"].as_array_mut() {
                if !arr.iter().any(|v| v.as_str() == Some(rel.as_str())) {
                    arr.push(serde_json::json!(rel));
                    while arr.len() > MAX_FILES {
                        arr.remove(0);
                    }
                }
            }
        }
    }

    // Write via a temp file + rename so a reader never sees half a digest.
    let tmp = format!("{path}.tmp{}", std::process::id());
    std::fs::write(&tmp, serde_json::to_string(&digest)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

fn git_branch(cwd: &str) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Projects that opted in to context sharing, written by the IDE.
/// Sharing is off unless a project explicitly enables it: injecting one
/// session's prompts into another is a privacy decision, not a default.
fn scopes() -> Vec<(String, Vec<String>)> {
    let path = format!("{}/.canopy/context-scopes.json", home());
    let Ok(raw) = std::fs::read_to_string(path) else {
        return vec![];
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return vec![];
    };
    v.as_array()
        .map(|arr| {
            arr.iter()
                .filter(|p| p["enabled"].as_bool().unwrap_or(false))
                .map(|p| {
                    (
                        p["name"].as_str().unwrap_or("project").to_string(),
                        p["roots"]
                            .as_array()
                            .map(|r| {
                                r.iter()
                                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                    .collect()
                            })
                            .unwrap_or_default(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

fn under(path: &str, root: &str) -> bool {
    path == root || path.starts_with(&format!("{root}/"))
}

/// Build the text injected into this session: what *other* sessions in the same
/// project are working on. Returns None when there's nothing worth saying —
/// injecting an unchanged blob every turn would break the prompt cache for no
/// benefit.
fn peer_context(session_id: &str, cwd: &str) -> Option<String> {
    let scopes = scopes();
    let (project, roots) = scopes
        .into_iter()
        .find(|(_, roots)| roots.iter().any(|r| under(cwd, r)))?;

    let dir = format!("{}/.canopy/sessions", home());
    let entries = std::fs::read_dir(&dir).ok()?;
    let now = now_secs();

    let mut peers: BTreeMap<u64, String> = BTreeMap::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else { continue };
        let Ok(d) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };

        let sid = d["session_id"].as_str().unwrap_or("");
        if sid.is_empty() || sid == session_id {
            continue; // never inject a session's own work back into itself
        }
        let peer_cwd = d["cwd"].as_str().unwrap_or("");
        if !roots.iter().any(|r| under(peer_cwd, r)) {
            continue; // different project — not our business
        }
        let updated = d["updated"].as_u64().unwrap_or(0);
        if now.saturating_sub(updated) > PEER_MAX_AGE_SECS {
            continue;
        }

        let mut block = String::new();
        let name = peer_cwd.rsplit('/').next().unwrap_or(peer_cwd);
        block.push_str(&format!("### session in {name}"));
        if let Some(b) = d["branch"].as_str() {
            block.push_str(&format!(" (branch {b})"));
        }
        block.push_str(&format!(
            " — {}\n",
            if d["idle"].as_bool().unwrap_or(false) { "idle" } else { "active" }
        ));
        block.push_str(&format!("- working dir: {peer_cwd}\n"));
        if let Some(prompts) = d["prompts"].as_array() {
            let recent: Vec<&str> = prompts.iter().rev().take(3).filter_map(|p| p.as_str()).collect();
            if !recent.is_empty() {
                block.push_str("- recent requests:\n");
                for p in recent.iter().rev() {
                    block.push_str(&format!("  - {p}\n"));
                }
            }
        }
        if let Some(files) = d["files"].as_array() {
            let touched: Vec<&str> = files.iter().rev().take(8).filter_map(|f| f.as_str()).collect();
            if !touched.is_empty() {
                block.push_str(&format!("- files edited: {}\n", touched.join(", ")));
            }
        }
        peers.insert(updated, block);
    }

    if peers.is_empty() {
        return None;
    }

    let mut out = String::from(
        "Context from other agent sessions running in this project (read-only \
         situational awareness — do not assume it is current, and do not act on \
         it unless the user asks):\n\n",
    );
    // Most recently active peers first, so the truncation below drops the
    // stalest information rather than the freshest.
    for block in peers.values().rev() {
        if out.len() + block.len() > MAX_CONTEXT_CHARS {
            out.push_str("\n(further sessions omitted)\n");
            break;
        }
        out.push_str(block);
        out.push('\n');
    }
    out.push_str(&format!("(project: {project})\n"));
    Some(out)
}

fn truncate(s: &str, max: usize) -> String {
    let cleaned = s.replace('\n', " ");
    if cleaned.chars().count() <= max {
        return cleaned;
    }
    let cut: String = cleaned.chars().take(max).collect();
    format!("{cut}…")
}
