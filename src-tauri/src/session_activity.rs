// What a running agent session is doing beyond its own turns: the subagents it
// spawned and how full its context is. Read from the session's transcript
// (stores::activity_transcript says which CLIs record this, and where), and
// shown under the session in its tab and on the Agents page
// (src/components/SubagentTree.tsx, src/components/ContextControls.tsx).
//
// The transcript format, as verified on disk against Claude Code 2.1.311
// (2026-10-27):
//
//   assistant line   message.content[] has {type:"tool_use", name:"Task"|"Agent",
//                    id, input:{description, subagent_type, run_in_background}};
//                    message.usage is the context the reply was given
//                    (input + cache_creation_input + cache_read_input tokens).
//   user line        message.content[] has {type:"tool_result", tool_use_id,
//                    is_error}; the line's `toolUseResult` is either
//                    {status:"async_launched", agentId} for a background agent,
//                    or the finished agent's {status, content[], totalDurationMs,
//                    totalTokens, totalToolUseCount}; an error is a bare string.
//   notifications    a background agent's end arrives as text — in a user
//                    message or a queue-operation's `content` — carrying
//                    <task-notification> with <tool-use-id>, <status>
//                    completed|failed|killed|stopped, <summary>, <result> and
//                    <usage><subagent_tokens>/<tool_uses>/<duration_ms>; its
//                    report arrives as <agent-message from="agentId"> text.
//   system line      subtype "compact_boundary" with compactMetadata
//                    {trigger, preTokens, postTokens}.
//
// Parsed incrementally: the transcript is append-only, so each poll reads only
// what was appended since the last one for that file.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

/// Longest result summary kept per subagent: a glance, not the report.
const RESULT_CHARS: usize = 600;
/// Longest description kept.
const DESCRIPTION_CHARS: usize = 200;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Subagent {
    /// The tool call that spawned it — stable for the session's lifetime.
    pub id: String,
    /// The CLI's own id for a background agent.
    pub agent_id: Option<String>,
    pub description: String,
    /// The subagent type the session asked for ("general-purpose", …).
    pub kind: Option<String>,
    /// "running", "done", "failed" or "stopped".
    pub status: String,
    pub background: bool,
    pub started_ms: Option<i64>,
    pub ended_ms: Option<i64>,
    pub duration_ms: Option<u64>,
    pub tokens: Option<u64>,
    pub tool_uses: Option<u64>,
    /// The first stretch of what it reported back, as plain text.
    pub result: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct ContextUse {
    pub model: Option<String>,
    /// Tokens the latest reply was given: the context in use right now.
    pub tokens: u64,
    pub at_ms: Option<i64>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Compaction {
    pub at_ms: Option<i64>,
    /// "manual" (someone ran /compact) or "auto" (the CLI ran out of room).
    pub trigger: String,
    pub pre_tokens: Option<u64>,
    pub post_tokens: Option<u64>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct SessionActivity {
    /// Oldest first.
    pub subagents: Vec<Subagent>,
    pub context: Option<ContextUse>,
    /// Oldest first.
    pub compactions: Vec<Compaction>,
}

#[derive(Clone, Default)]
struct State {
    order: Vec<String>,
    by_id: HashMap<String, Subagent>,
    /// Background agent id -> the tool call that launched it.
    by_agent: HashMap<String, String>,
    context: Option<ContextUse>,
    compactions: Vec<Compaction>,
}

impl State {
    fn snapshot(&self) -> SessionActivity {
        SessionActivity {
            subagents: self
                .order
                .iter()
                .filter_map(|id| self.by_id.get(id).cloned())
                .collect(),
            context: self.context.clone(),
            compactions: self.compactions.clone(),
        }
    }
}

fn ts_ms(v: &Value) -> Option<i64> {
    let s = v["timestamp"].as_str()?;
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp_millis())
}

fn chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Text from a string or a list of `{type:"text", text}` parts.
fn text_of(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    let joined = v
        .as_array()?
        .iter()
        .filter(|p| p["type"] == "text")
        .filter_map(|p| p["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    (!joined.is_empty()).then_some(joined)
}

/// A report as a short plain-text glance: whitespace folded, clipped.
fn summary(text: &str) -> Option<String> {
    let folded = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!folded.is_empty()).then(|| chars(&folded, RESULT_CHARS))
}

fn tag<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(text[start..end].trim())
}

fn status_word(s: &str) -> &'static str {
    match s {
        "completed" | "success" | "done" => "done",
        "failed" | "error" => "failed",
        "killed" | "stopped" | "cancelled" => "stopped",
        _ => "running",
    }
}

/// Every `<task-notification>` in `text`, applied to the agents it names.
fn apply_notifications(st: &mut State, text: &str, at: Option<i64>) {
    let mut rest = text;
    while let Some(i) = rest.find("<task-notification>") {
        let block = &rest[i..];
        let end = block
            .find("</task-notification>")
            .map(|e| e + "</task-notification>".len())
            .unwrap_or(block.len());
        let n = &block[..end];
        rest = &block[end..];
        let id = tag(n, "tool-use-id")
            .map(str::to_string)
            .or_else(|| tag(n, "task-id").and_then(|t| st.by_agent.get(t).cloned()));
        let Some(sub) = id.and_then(|id| st.by_id.get_mut(&id)) else {
            continue;
        };
        if let Some(s) = tag(n, "status") {
            sub.status = status_word(s).into();
        }
        if sub.status != "running" {
            sub.ended_ms = at.or(sub.ended_ms);
        }
        let num = |name: &str| tag(n, name).and_then(|v| v.parse::<u64>().ok());
        sub.duration_ms = num("duration_ms").or(sub.duration_ms);
        sub.tokens = num("subagent_tokens").or(sub.tokens);
        sub.tool_uses = num("tool_uses").or(sub.tool_uses);
        // The report itself may come separately (an agent-message); a
        // <result> that only points there is not a summary.
        if sub.result.is_none() {
            if let Some(r) = tag(n, "result").filter(|r| !r.contains("was delivered to you")) {
                sub.result = summary(r);
            } else if let Some(s) = tag(n, "summary") {
                sub.result = summary(s);
            }
        }
    }
}

/// `<agent-message from="…">` hand-backs: the report a background agent sent.
fn apply_reports(st: &mut State, text: &str) {
    let mut rest = text;
    while let Some(i) = rest.find("<agent-message from=\"") {
        let after = &rest[i + "<agent-message from=\"".len()..];
        let Some(q) = after.find('"') else { break };
        let agent = &after[..q];
        let body_end = after.find("</agent-message>").unwrap_or(after.len());
        let body = &after[q..body_end];
        rest = &after[body_end..];
        let report = body
            .split_once("The report follows:")
            .map(|(_, r)| r)
            .unwrap_or_else(|| body.split_once('>').map(|(_, r)| r).unwrap_or(body));
        if let Some(sub) = st
            .by_agent
            .get(agent)
            .cloned()
            .and_then(|id| st.by_id.get_mut(&id))
        {
            if let Some(s) = summary(report) {
                sub.result = Some(s);
            }
        }
    }
}

fn apply_line(st: &mut State, v: &Value) {
    let at = ts_ms(v);
    match v["type"].as_str().unwrap_or("") {
        "assistant" => {
            // A subagent's own replies (older CLIs wrote them inline) are not
            // the session's context.
            if v["isSidechain"] == true {
                return;
            }
            let msg = &v["message"];
            let usage = &msg["usage"];
            if usage.is_object() {
                let n = |k: &str| usage[k].as_u64().unwrap_or(0);
                let tokens = n("input_tokens")
                    + n("cache_creation_input_tokens")
                    + n("cache_read_input_tokens");
                let model = msg["model"]
                    .as_str()
                    .filter(|m| !m.is_empty() && !m.starts_with('<'))
                    .map(str::to_string);
                if tokens > 0 {
                    st.context = Some(ContextUse {
                        model: model.or_else(|| st.context.as_ref().and_then(|c| c.model.clone())),
                        tokens,
                        at_ms: at,
                    });
                }
            }
            for c in msg["content"].as_array().into_iter().flatten() {
                let name = c["name"].as_str().unwrap_or("");
                if c["type"] != "tool_use" || (name != "Task" && name != "Agent") {
                    continue;
                }
                let Some(id) = c["id"].as_str() else { continue };
                if st.by_id.contains_key(id) {
                    continue;
                }
                let input = &c["input"];
                st.order.push(id.to_string());
                st.by_id.insert(
                    id.to_string(),
                    Subagent {
                        id: id.to_string(),
                        description: chars(
                            input["description"].as_str().unwrap_or(""),
                            DESCRIPTION_CHARS,
                        ),
                        kind: input["subagent_type"].as_str().map(str::to_string),
                        status: "running".into(),
                        background: input["run_in_background"] == true,
                        started_ms: at,
                        ..Default::default()
                    },
                );
            }
        }
        "user" => {
            let content = &v["message"]["content"];
            if let Some(items) = content.as_array() {
                for c in items {
                    if c["type"] == "text" {
                        if let Some(t) = c["text"].as_str() {
                            apply_notifications(st, t, at);
                            apply_reports(st, t);
                        }
                        continue;
                    }
                    if c["type"] != "tool_result" {
                        continue;
                    }
                    let Some(id) = c["tool_use_id"].as_str() else {
                        continue;
                    };
                    let Some(sub) = st.by_id.get_mut(id) else {
                        continue;
                    };
                    let r = &v["toolUseResult"];
                    if c["is_error"] == true || r.is_string() {
                        sub.status = "failed".into();
                        sub.ended_ms = at;
                        sub.result = text_of(&c["content"])
                            .or_else(|| r.as_str().map(str::to_string))
                            .and_then(|t| summary(&t));
                        continue;
                    }
                    if r["status"] == "async_launched" {
                        sub.background = true;
                        if let Some(a) = r["agentId"].as_str() {
                            sub.agent_id = Some(a.to_string());
                            st.by_agent.insert(a.to_string(), id.to_string());
                        }
                        continue;
                    }
                    // Finished in the foreground.
                    sub.status = match r["status"].as_str() {
                        Some(s) => status_word(s).into(),
                        None => "done".into(),
                    };
                    if sub.status == "running" {
                        sub.status = "done".into();
                    }
                    sub.ended_ms = at;
                    sub.duration_ms = r["totalDurationMs"].as_u64();
                    sub.tokens = r["totalTokens"].as_u64();
                    sub.tool_uses = r["totalToolUseCount"].as_u64();
                    if let Some(a) = r["agentId"].as_str() {
                        sub.agent_id = Some(a.to_string());
                    }
                    sub.result = text_of(&r["content"])
                        .or_else(|| text_of(&c["content"]))
                        .and_then(|t| summary(&t));
                }
            } else if let Some(t) = content.as_str() {
                apply_notifications(st, t, at);
                apply_reports(st, t);
            }
        }
        "queue-operation" => {
            if let Some(t) = v["content"].as_str() {
                apply_notifications(st, t, at);
                apply_reports(st, t);
            }
        }
        "system" if v["subtype"] == "compact_boundary" => {
            let m = &v["compactMetadata"];
            let c = Compaction {
                at_ms: at,
                trigger: m["trigger"].as_str().unwrap_or("auto").to_string(),
                pre_tokens: m["preTokens"].as_u64(),
                post_tokens: m["postTokens"].as_u64(),
            };
            if let Some(post) = c.post_tokens {
                let model = st.context.as_ref().and_then(|x| x.model.clone());
                st.context = Some(ContextUse {
                    model,
                    tokens: post,
                    at_ms: at,
                });
            }
            st.compactions.push(c);
        }
        _ => {}
    }
}

/// Whether a line can matter, before paying for a JSON parse.
fn worth_parsing(line: &str) -> bool {
    line.contains("\"assistant\"")
        || line.contains("tool_result")
        || line.contains("task-notification")
        || line.contains("agent-message")
        || line.contains("compact_boundary")
}

/// Fold transcript lines into the activity — the whole parser, for tests.
#[cfg(test)]
pub fn activity_from_lines<'a>(lines: impl IntoIterator<Item = &'a str>) -> SessionActivity {
    let mut st = State::default();
    for line in lines {
        if !worth_parsing(line) {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            apply_line(&mut st, &v);
        }
    }
    st.snapshot()
}

/// Byte offset parsed per transcript, with the state folded up to it.
static CACHE: LazyLock<Mutex<HashMap<PathBuf, (u64, State)>>> = LazyLock::new(Default::default);

/// The activity in one transcript, reading only what grew since last time.
pub fn read_activity(path: &Path) -> SessionActivity {
    use std::io::{Read, Seek, SeekFrom};
    let (mut offset, mut st) = CACHE.lock().unwrap().get(path).cloned().unwrap_or_default();
    let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if len < offset {
        offset = 0;
        st = State::default();
    }
    if len > offset {
        if let Ok(mut f) = std::fs::File::open(path) {
            if f.seek(SeekFrom::Start(offset)).is_ok() {
                let mut raw = Vec::new();
                if f.take(len - offset).read_to_end(&mut raw).is_ok() {
                    // Only complete lines: the CLI may be mid-append.
                    let consumed = raw
                        .iter()
                        .rposition(|b| *b == b'\n')
                        .map(|i| i + 1)
                        .unwrap_or(0);
                    for line in String::from_utf8_lossy(&raw[..consumed]).lines() {
                        if !worth_parsing(line) {
                            continue;
                        }
                        if let Ok(v) = serde_json::from_str::<Value>(line) {
                            apply_line(&mut st, &v);
                        }
                    }
                    offset += consumed as u64;
                }
            }
        }
        let mut cache = CACHE.lock().unwrap();
        // Bounded: one entry per transcript looked at, and a long-lived app
        // looks at a few dozen.
        if cache.len() > 64 {
            cache.clear();
        }
        cache.insert(path.to_path_buf(), (offset, st.clone()));
    }
    st.snapshot()
}

#[tauri::command]
pub async fn session_activity(
    session_id: String,
    agent: String,
    roots: Option<Vec<String>>,
    profile: Option<String>,
) -> Result<Option<SessionActivity>, String> {
    let roots = roots.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        crate::stores::activity_transcript(&agent, &session_id, &roots, profile.as_deref())
            .map(|p| read_activity(&p))
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(v: Value) -> String {
        v.to_string()
    }

    #[test]
    fn a_background_agent_from_launch_to_report() {
        let lines = [
            line(
                serde_json::json!({"type":"assistant","timestamp":"2026-10-26T06:50:00.000Z",
                "message":{"model":"claude-opus-5-5","usage":{"input_tokens":2,"cache_creation_input_tokens":17634,"cache_read_input_tokens":27210,"output_tokens":235},
                "content":[{"type":"tool_use","id":"toolu_1","name":"Agent","input":{"description":"Reliability research","subagent_type":"general-purpose","prompt":"…"}}]}}),
            ),
            line(
                serde_json::json!({"type":"user","timestamp":"2026-10-26T06:50:01.000Z",
                "message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"Async agent launched successfully."}]}]},
                "toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"a3fa","description":"Reliability research"}}),
            ),
            line(
                serde_json::json!({"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-26T06:58:57.780Z",
                "content":"<agent-message from=\"a3fa\"> [Subagent hand-back] … The report follows:\n    Review is the bottleneck.\n    Evidence: …\n</agent-message>"}),
            ),
            line(
                serde_json::json!({"type":"user","timestamp":"2026-10-26T06:58:58.000Z",
                "message":{"content":"<task-notification> <task-id>a3fa</task-id> <tool-use-id>toolu_1</tool-use-id> <status>completed</status> <summary>Agent \"Reliability research\" finished</summary> <result>This agent's report was delivered to you as a message.</result> <usage><subagent_tokens>74476</subagent_tokens><tool_uses>22</tool_uses><duration_ms>206624</duration_ms></usage> </task-notification>"}}),
            ),
        ];
        let a = activity_from_lines(lines.iter().map(String::as_str));
        assert_eq!(a.subagents.len(), 1);
        let s = &a.subagents[0];
        assert_eq!(s.description, "Reliability research");
        assert_eq!(s.kind.as_deref(), Some("general-purpose"));
        assert_eq!(s.status, "done");
        assert!(s.background);
        assert_eq!(s.agent_id.as_deref(), Some("a3fa"));
        assert_eq!(s.duration_ms, Some(206_624));
        assert_eq!(s.tokens, Some(74_476));
        assert_eq!(s.tool_uses, Some(22));
        assert_eq!(
            s.result.as_deref(),
            Some("Review is the bottleneck. Evidence: …")
        );
        assert!(s.started_ms.is_some() && s.ended_ms > s.started_ms);
        let ctx = a.context.unwrap();
        assert_eq!(ctx.tokens, 44_846);
        assert_eq!(ctx.model.as_deref(), Some("claude-opus-5-5"));
    }

    #[test]
    fn foreground_results_errors_and_still_running() {
        let lines = [
            line(
                serde_json::json!({"type":"assistant","timestamp":"2026-10-26T07:00:00Z","message":{"content":[
                {"type":"tool_use","id":"t_ok","name":"Task","input":{"description":"Find the bug"}},
                {"type":"tool_use","id":"t_err","name":"Task","input":{"description":"Too many"}},
                {"type":"tool_use","id":"t_run","name":"Agent","input":{"description":"Still going","run_in_background":true}},
                {"type":"tool_use","id":"t_bash","name":"Bash","input":{"command":"ls"}}]}}),
            ),
            line(
                serde_json::json!({"type":"user","timestamp":"2026-10-26T07:01:00Z",
                "message":{"content":[{"type":"tool_result","tool_use_id":"t_ok","content":[{"type":"text","text":"It was an off-by-one."}]}]},
                "toolUseResult":{"status":"completed","content":[{"type":"text","text":"It was an off-by-one."}],"totalDurationMs":60000,"totalTokens":1200,"totalToolUseCount":4}}),
            ),
            line(
                serde_json::json!({"type":"user","timestamp":"2026-10-26T07:01:01Z",
                "message":{"content":[{"type":"tool_result","tool_use_id":"t_err","is_error":true,"content":"Concurrent subagent limit reached."}]},
                "toolUseResult":"Error: Concurrent subagent limit reached."}),
            ),
        ];
        let a = activity_from_lines(lines.iter().map(String::as_str));
        let by = |id: &str| a.subagents.iter().find(|s| s.id == id).unwrap().clone();
        assert_eq!(a.subagents.len(), 3, "Bash is not a subagent");
        assert_eq!(by("t_ok").status, "done");
        assert_eq!(by("t_ok").duration_ms, Some(60_000));
        assert_eq!(by("t_ok").result.as_deref(), Some("It was an off-by-one."));
        assert_eq!(by("t_err").status, "failed");
        assert_eq!(
            by("t_err").result.as_deref(),
            Some("Concurrent subagent limit reached.")
        );
        assert_eq!(by("t_run").status, "running");
        assert!(by("t_run").background);
    }

    #[test]
    fn compaction_resets_the_context_and_sidechains_do_not_count() {
        let lines = [
            line(
                serde_json::json!({"type":"assistant","message":{"model":"m","usage":{"input_tokens":100000}}}),
            ),
            line(
                serde_json::json!({"type":"assistant","isSidechain":true,"message":{"model":"m","usage":{"input_tokens":5}}}),
            ),
            line(
                serde_json::json!({"type":"system","subtype":"compact_boundary","timestamp":"2026-10-11T08:39:35.607Z",
                "compactMetadata":{"trigger":"manual","preTokens":109269,"postTokens":11379}}),
            ),
        ];
        let a = activity_from_lines(lines.iter().map(String::as_str));
        assert_eq!(a.compactions.len(), 1);
        assert_eq!(a.compactions[0].trigger, "manual");
        assert_eq!(a.compactions[0].pre_tokens, Some(109_269));
        let ctx = a.context.unwrap();
        assert_eq!(ctx.tokens, 11_379);
        assert_eq!(ctx.model.as_deref(), Some("m"));
    }

    #[test]
    fn reads_only_what_was_appended() {
        let path =
            std::env::temp_dir().join(format!("canopy-activity-{}.jsonl", std::process::id()));
        let first = line(serde_json::json!({"type":"assistant","message":{"content":[
            {"type":"tool_use","id":"t1","name":"Task","input":{"description":"one"}}]}}));
        std::fs::write(&path, format!("{first}\n{{\"type\":\"assis")).unwrap();
        let a = read_activity(&path);
        assert_eq!(a.subagents.len(), 1);
        assert_eq!(a.subagents[0].status, "running");
        // The half-written line completes, and a result lands.
        let rest = line(serde_json::json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"t1","content":"ok"}]},"toolUseResult":{"status":"completed"}}));
        std::fs::write(
            &path,
            format!("{first}\n{{\"type\":\"assistant\",\"message\":{{}}}}\n{rest}\n"),
        )
        .unwrap();
        let b = read_activity(&path);
        assert_eq!(b.subagents[0].status, "done");
        std::fs::remove_file(&path).ok();
    }
}
