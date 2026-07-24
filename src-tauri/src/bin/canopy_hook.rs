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
/// Per-edit content captured into the change journal — enough to render the
/// hunk, capped so a giant Write can't bloat the log. Newlines are preserved
/// (unlike `truncate`), since the whole point is to show the diff.
const MAX_EDIT_CHARS: usize = 20_000;
/// Stop journaling once a session's edit log passes this. Best-effort: a
/// runaway session must not fill the disk, and the tail is the least useful part.
const MAX_JOURNAL_BYTES: u64 = 4 * 1024 * 1024;
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
    // Third job, distinct transport: `canopy-hook --mcp` speaks MCP over stdio
    // (registered in the CLI's user-scope MCP config by agents.rs) and serves
    // the IDE-context tools. Everything else is the hook contract below.
    if std::env::args().any(|a| a == "--mcp") {
        mcp_main();
        return;
    }
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
    let Some(map) = event.as_object_mut() else {
        return;
    };
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

/// The lifecycle state a hook event implies: `working` (a turn is in flight),
/// `waiting` (blocked on the user — a question or permission prompt), `idle`
/// (finished a turn, nothing outstanding), or `ended` (the session closed).
/// Returns None for events that don't move the state (compaction, anything
/// unrecognised), so the prior state stands rather than being reset.
fn state_for(hook_event: &str, event: &serde_json::Value) -> Option<&'static str> {
    let tool = event["tool_name"].as_str().unwrap_or("");
    let msg = event["message"].as_str().unwrap_or("").to_lowercase();
    Some(match hook_event {
        "SessionStart" | "Stop" => "idle",
        "SessionEnd" => "ended",
        "UserPromptSubmit" | "PostToolUse" => "working",
        // Every tool but the questionnaire means the turn is progressing; the
        // questionnaire itself is the agent blocking on an answer.
        "PreToolUse" => {
            if tool == "AskUserQuestion" {
                "waiting"
            } else {
                "working"
            }
        }
        // A "waiting for input" line is a completion notice, not a request —
        // the same text the frontend keys on to tell those two apart.
        "Notification" | "PermissionRequest" => {
            if msg.contains("waiting for") {
                "idle"
            } else {
                "waiting"
            }
        }
        _ => return None,
    })
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
        .unwrap_or(if event["session_id"].is_string() {
            "claude"
        } else {
            "agent"
        });
    digest["agent"] = serde_json::json!(agent);
    if let Some(b) = git_branch(cwd) {
        digest["branch"] = serde_json::json!(b);
    }

    // Lifecycle state, derived from the event. The panel shows it as a dot and
    // hibernation reads it to know which agents are safe to reclaim; both must
    // read the exact same stream the cards do, so `state_for` mirrors the
    // frontend's own reading of these events. An event that says nothing about
    // state (compaction, an unrecognised name) leaves the prior state standing.
    let prev_state = digest["state"].as_str().unwrap_or("idle").to_string();
    let state = match state_for(hook_event, event) {
        Some(s) => s.to_string(),
        None => prev_state,
    };
    digest["state"] = serde_json::json!(state);
    // `idle` is still what peer_context and older readers key on; derive it from
    // the richer state so the two can never disagree.
    digest["idle"] = serde_json::json!(state == "idle" || state == "ended");

    // Subagents (Claude dispatches them through the Task tool) that finished
    // this turn. Counted from SubagentStop and zeroed when a new human turn
    // begins, so the panel badge reads "this turn spawned N helpers" rather
    // than an ever-growing session total.
    if hook_event == "UserPromptSubmit" {
        digest["subagents"] = serde_json::json!(0);
    } else if hook_event == "SubagentStop" {
        let n = digest["subagents"].as_u64().unwrap_or(0) + 1;
        digest["subagents"] = serde_json::json!(n);
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

    // The per-agent change journal: the actual edits this session made, not just
    // which files. On a shared checkout git can't attribute working-tree changes
    // per agent, but this can — it records what *this* agent changed at the
    // moment it changed it, so its workspace shows only its own hunks even when
    // another agent later touches the same file. Best-effort; never blocks the
    // digest write above.
    append_edit_journal(session_id, agent, event);

    // Write via a temp file + rename so a reader never sees half a digest.
    let tmp = format!("{path}.tmp{}", std::process::id());
    std::fs::write(&tmp, serde_json::to_string(&digest)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Char-truncate while preserving newlines — `truncate` flattens them, which is
/// right for a one-line prompt but wrong for edit content we mean to diff.
fn cap(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}\n…(truncated)")
}

/// Append this edit to the session's change journal (`<id>.edits.jsonl`), one
/// record per (sub)edit: the before/after text the agent authored, plus the
/// file and a timestamp. Append-only so concurrent readers never see a partial
/// record; entirely best-effort, so any failure is swallowed rather than
/// breaking the hook. Only Claude-style edit tools carry old/new — a CLI that
/// reports just a path still lands in the digest `files` list above.
fn append_edit_journal(session_id: &str, agent: &str, event: &serde_json::Value) {
    let tool = event["tool_name"].as_str().unwrap_or("");
    if !matches!(tool, "Edit" | "Write" | "MultiEdit" | "NotebookEdit") {
        return;
    }
    let ti = &event["tool_input"];
    let Some(abs) = ti["file_path"]
        .as_str()
        .or_else(|| ti["notebook_path"].as_str())
    else {
        return;
    };
    let ts = now_secs();
    let mk = |old: Option<&str>, new: Option<&str>| {
        serde_json::json!({
            "ts": ts,
            "agent": agent,
            "path": abs,
            "tool": tool,
            "old": old.map(|s| cap(s, MAX_EDIT_CHARS)),
            "new": new.map(|s| cap(s, MAX_EDIT_CHARS)),
        })
    };
    let mut records: Vec<serde_json::Value> = Vec::new();
    match tool {
        "Edit" => records.push(mk(ti["old_string"].as_str(), ti["new_string"].as_str())),
        "MultiEdit" => {
            if let Some(edits) = ti["edits"].as_array() {
                for e in edits {
                    records.push(mk(e["old_string"].as_str(), e["new_string"].as_str()));
                }
            }
        }
        "Write" => records.push(mk(None, ti["content"].as_str())),
        "NotebookEdit" => records.push(mk(None, ti["new_source"].as_str())),
        _ => {}
    }
    if records.is_empty() {
        return;
    }

    let path = format!("{}/.canopy/sessions/{session_id}.edits.jsonl", home());
    // Once the log passes the cap, stop appending — the head (what the agent did
    // first) is more useful to keep than the tail, and this bounds disk use.
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_JOURNAL_BYTES {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write;
        for r in records {
            let _ = writeln!(f, "{r}");
        }
    }
}

fn git_branch(cwd: &str) -> Option<String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C")
        .arg(cwd)
        .args(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    // Don't flash a console window on Windows (this hook runs on every agent
    // event). CREATE_NO_WINDOW; no-op elsewhere.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().ok()?;
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
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(d) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };

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
            if d["idle"].as_bool().unwrap_or(false) {
                "idle"
            } else {
                "active"
            }
        ));
        block.push_str(&format!("- working dir: {peer_cwd}\n"));
        if let Some(prompts) = d["prompts"].as_array() {
            let recent: Vec<&str> = prompts
                .iter()
                .rev()
                .take(3)
                .filter_map(|p| p.as_str())
                .collect();
            if !recent.is_empty() {
                block.push_str("- recent requests:\n");
                for p in recent.iter().rev() {
                    block.push_str(&format!("  - {p}\n"));
                }
            }
        }
        if let Some(files) = d["files"].as_array() {
            let touched: Vec<&str> = files
                .iter()
                .rev()
                .take(8)
                .filter_map(|f| f.as_str())
                .collect();
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

// ---- MCP mode (`canopy-hook --mcp`) ---------------------------------------
//
// A minimal MCP stdio server: one JSON-RPC message per line in, one per line
// out. Tools proxy to the desktop app's context bridge (context.rs) over
// loopback HTTP, addressed by the CANOPY_CTX_PORT/CANOPY_CTX_TOKEN env only
// Canopy's own PTYs export. The registration is user-global, so the server
// must start cleanly in ANY terminal — outside Canopy the tools simply answer
// that no IDE is around, instead of the process refusing to run (which the
// agent CLI would surface as a broken MCP server).

fn mcp_main() {
    use std::io::{BufRead, Write};
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        // Notifications (no id) expect no reply.
        let Some(id) = msg.get("id").cloned() else {
            continue;
        };
        let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let reply = match method {
            "initialize" => {
                // Echo the client's protocol version: these tools are simple
                // enough to be valid under every revision so far.
                let proto = msg
                    .pointer("/params/protocolVersion")
                    .and_then(|v| v.as_str())
                    .unwrap_or("2024-11-05");
                rpc_ok(
                    id,
                    serde_json::json!({
                        "protocolVersion": proto,
                        "capabilities": { "tools": {} },
                        "serverInfo": { "name": "canopy", "version": env!("CARGO_PKG_VERSION") },
                    }),
                )
            }
            "ping" => rpc_ok(id, serde_json::json!({})),
            "tools/list" => rpc_ok(id, tools_list()),
            "tools/call" => {
                let name = msg
                    .pointer("/params/name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let args = msg
                    .pointer("/params/arguments")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                match call_tool(name, &args) {
                    Ok(text) => rpc_ok(
                        id,
                        serde_json::json!({ "content": [{ "type": "text", "text": text }] }),
                    ),
                    // Tool failures are results with isError, not protocol
                    // errors — the agent reads them and adapts.
                    Err(text) => rpc_ok(
                        id,
                        serde_json::json!({
                            "content": [{ "type": "text", "text": text }],
                            "isError": true,
                        }),
                    ),
                }
            }
            _ => serde_json::json!({
                "jsonrpc": "2.0", "id": id,
                "error": { "code": -32601, "message": format!("method not found: {method}") },
            }),
        };
        let mut out = stdout.lock();
        let _ = writeln!(out, "{reply}");
        let _ = out.flush();
    }
}

fn rpc_ok(id: serde_json::Value, result: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn tools_list() -> serde_json::Value {
    serde_json::json!({ "tools": [
        {
            "name": "canopy_project",
            "description": "Live context from the Canopy IDE this session is running inside: every open project with its components (labeled directories and absolute paths), their configured run commands, the dev servers / run terminals currently running (with terminal ids and exit state), and other active agents. Call this first to orient instead of exploring the filesystem blind.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "canopy_component_files",
            "description": "List the files inside one of the project's component directories (paths come from canopy_project), skipping dependency and build directories (node_modules, target, dist, ...). Breadth-first and capped, so shallow structure survives truncation.",
            "inputSchema": { "type": "object", "properties": {
                "dir": { "type": "string", "description": "Absolute path of a component, or a subdirectory of one, from canopy_project" },
                "max": { "type": "integer", "description": "Maximum number of files to return (default 500)" }
            }, "required": ["dir"], "additionalProperties": false }
        },
        {
            "name": "canopy_server_output",
            "description": "The recent terminal output of a dev server, build, or agent running in Canopy — compile errors, request logs, stack traces — without restarting anything. `server` is a terminal id from canopy_project's runServers or agents.",
            "inputSchema": { "type": "object", "properties": {
                "server": { "type": "integer", "description": "Terminal id (ptyId) from canopy_project" },
                "lines": { "type": "integer", "description": "Trailing lines to return (default 200)" }
            }, "required": ["server"], "additionalProperties": false }
        },
        {
            "name": "canopy_start_server",
            "description": "Start one of a component's configured run commands (a dev server, worker, build) in Canopy's RUNS rail, without the user clicking anything. Use this to bring up the server you need to preview or test a change. `dir` and `command` come from canopy_project (components[].path and components[].commands[].name). If a matching command is already running it is reused, not duplicated. Returns immediately; the server takes a moment to boot — call canopy_project again to see its localhost address once it's listening, and canopy_server_output to watch it start (or catch a startup error).",
            "inputSchema": { "type": "object", "properties": {
                "dir": { "type": "string", "description": "Absolute path of the component (components[].path from canopy_project)" },
                "command": { "type": "string", "description": "Name of the run command to start (components[].commands[].name from canopy_project)" }
            }, "required": ["dir", "command"], "additionalProperties": false }
        },
        {
            "name": "canopy_open_preview",
            "description": "Open a local server's URL in Canopy's built-in preview browser (an embedded, annotatable browser tab), so the user sees your change rendered without leaving the IDE and can mark elements on it for feedback. `url` should be a running server's address from canopy_project (runServers[].url), or any http://localhost URL. External (non-localhost) URLs are refused — the preview is for local servers. Opens the tab and focuses it; returns once requested.",
            "inputSchema": { "type": "object", "properties": {
                "url": { "type": "string", "description": "A local http://localhost[:port][/path] URL — typically a runServers[].url from canopy_project" }
            }, "required": ["url"], "additionalProperties": false }
        },
        {
            "name": "canopy_annotations",
            "description": "The visual feedback the user has marked on Canopy preview pages: for each tagged element, its number, the CSS selector and React component, the visible text, the user's comment, the page URL, and the component that serves it. This is the same feedback the user sends from the preview's ‘Send feedback’ button — reading it here lets you act on in-progress annotations directly, or re-check exactly what was asked. Returns an empty list when nothing is marked.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "canopy_resources",
            "description": "Live CPU and memory for every terminal Canopy is running (dev servers, builds, agents), with a per-process breakdown — pid, command, CPU %, and memory for each process in the terminal's tree, plus the terminal's totals and any listening ports. Use it to find what's pegging the CPU or leaking memory, or to confirm a server is actually working versus idle. Reflects the latest ~1s sample.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "canopy_stop_server",
            "description": "Stop (kill) a process Canopy is running — a dev server, a stuck build, a runaway agent — by its terminal id (`ptyId` from canopy_project or canopy_resources). Terminates the whole process tree. The terminal stays open showing it exited; use canopy_restart_server or canopy_start_server to bring it back. Only affects Canopy-managed terminals.",
            "inputSchema": { "type": "object", "properties": {
                "ptyId": { "type": "integer", "description": "Terminal id to stop (from canopy_project runServers/agents or canopy_resources)" }
            }, "required": ["ptyId"], "additionalProperties": false }
        },
        {
            "name": "canopy_restart_server",
            "description": "Restart a run terminal in place by its terminal id (`ptyId`) — kills the current process and relaunches the same command in the same tab. Use after a change that needs a fresh server, or to recover a crashed one. Returns immediately; call canopy_server_output shortly after to watch it come back up.",
            "inputSchema": { "type": "object", "properties": {
                "ptyId": { "type": "integer", "description": "Terminal id of the run server to restart (from canopy_project or canopy_resources)" }
            }, "required": ["ptyId"], "additionalProperties": false }
        }
    ]})
}

fn call_tool(name: &str, args: &serde_json::Value) -> Result<String, String> {
    match name {
        "canopy_project" => ctx_get("/ctx/snapshot".into()).map(pretty),
        "canopy_component_files" => {
            let dir = args
                .get("dir")
                .and_then(|v| v.as_str())
                .ok_or("missing required argument: dir")?;
            let max = args.get("max").and_then(|v| v.as_u64()).unwrap_or(500);
            ctx_get(format!("/ctx/files?dir={}&max={max}", urlencode(dir))).map(pretty)
        }
        "canopy_server_output" => {
            let server = args
                .get("server")
                .and_then(|v| v.as_u64())
                .ok_or("missing required argument: server (a terminal id from canopy_project)")?;
            let lines = args.get("lines").and_then(|v| v.as_u64()).unwrap_or(200);
            ctx_get(format!("/ctx/server-output/{server}?lines={lines}"))
        }
        "canopy_annotations" => ctx_get("/ctx/annotations".into()).map(pretty),
        "canopy_resources" => ctx_get("/ctx/resources".into()).map(pretty),
        "canopy_stop_server" => {
            let pty = args
                .get("ptyId")
                .and_then(|v| v.as_u64())
                .ok_or("missing required argument: ptyId (a terminal id from canopy_project)")?;
            ctx_post(serde_json::json!({ "kind": "stop_server", "cwd": cwd(), "ptyId": pty }))
        }
        "canopy_restart_server" => {
            let pty = args
                .get("ptyId")
                .and_then(|v| v.as_u64())
                .ok_or("missing required argument: ptyId (a terminal id from canopy_project)")?;
            ctx_post(serde_json::json!({ "kind": "restart_server", "cwd": cwd(), "ptyId": pty }))
        }
        "canopy_start_server" => {
            let dir = args
                .get("dir")
                .and_then(|v| v.as_str())
                .ok_or("missing required argument: dir (a component path from canopy_project)")?;
            let command = args.get("command").and_then(|v| v.as_str()).ok_or(
                "missing required argument: command (a run command name from canopy_project)",
            )?;
            ctx_post(serde_json::json!({
                "kind": "start_server",
                "cwd": cwd(),
                "dir": dir,
                "command": command,
            }))
        }
        "canopy_open_preview" => {
            let url = args
                .get("url")
                .and_then(|v| v.as_str())
                .ok_or("missing required argument: url")?;
            ctx_post(serde_json::json!({
                "kind": "open_preview",
                "cwd": cwd(),
                "url": url,
            }))
        }
        other => Err(format!("unknown tool: {other}")),
    }
}

/// The sidecar's working directory — inherited from the agent CLI, so it's the
/// agent's cwd, which routes an action to the right project.
fn cwd() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Re-indent JSON bodies for the model; non-JSON comes back as-is.
fn pretty(body: String) -> String {
    serde_json::from_str::<serde_json::Value>(&body)
        .and_then(|v| serde_json::to_string_pretty(&v))
        .unwrap_or(body)
}

/// GET from the app's context bridge.
fn ctx_get(path: String) -> Result<String, String> {
    ctx_request("GET", &path, None)
}

/// POST a JSON action to the context bridge. The bridge validates and returns a
/// human-readable ack (or a 4xx with a message the agent can correct against).
fn ctx_post(body: serde_json::Value) -> Result<String, String> {
    ctx_request("POST", "/ctx/action", Some(body.to_string()))
}

/// One request to the app's context bridge. Plain std TCP: it's loopback, the
/// responses carry Content-Length (Connection: close makes read-to-end
/// correct), and the hook binary stays dependency-light.
fn ctx_request(method: &str, path: &str, body: Option<String>) -> Result<String, String> {
    let port: u16 = std::env::var("CANOPY_CTX_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .ok_or(
            "This session isn't running inside a Canopy terminal, so the Canopy \
             context tools are unavailable here.",
        )?;
    let token = std::env::var("CANOPY_CTX_TOKEN").unwrap_or_default();
    let timeout = std::time::Duration::from_secs(5);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = std::net::TcpStream::connect_timeout(&addr, timeout).map_err(|e| {
        format!("Canopy isn't reachable on port {port} ({e}) — is the app still running?")
    })?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let body = body.unwrap_or_default();
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    std::io::Write::write_all(&mut stream, req.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    std::io::Read::read_to_end(&mut stream, &mut raw).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or("malformed response from Canopy")?;
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("");
    if status == "200" {
        Ok(body.to_string())
    } else {
        Err(format!("Canopy answered {status}: {body}"))
    }
}

/// Percent-encode a query value (RFC 3986 unreserved characters pass through).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
