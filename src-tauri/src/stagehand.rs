//! An OpenAI-shaped endpoint that is really the user's own agent CLI.
//!
//! Stagehand needs a model to turn `act("click the login button")` into a
//! click, and out of the box it wants an API key. Canopy already has a model:
//! the CLI the user configured — claude, codex — authenticated against their
//! own subscription and already driving every agent in the app. Asking them to
//! paste an API key so a second, worse model could do the same job would be
//! absurd.
//!
//! Stagehand accepts a `baseURL`, which is how Ollama and every other local
//! runner plug in. So this serves `/v1/chat/completions` on loopback, and
//! answers each one by running the configured CLI once, headlessly. Stagehand
//! believes it is talking to OpenAI; the tokens come off the subscription that
//! was already paid for.
//!
//! Two things this deliberately does NOT do.
//!
//! It does not stream. Stagehand's act/extract want one structured answer, a
//! CLI in print mode produces exactly one, and a fake SSE wrapper around a
//! process that has already exited buys nothing.
//!
//! It does not authenticate by API key, because there is no key — but it does
//! require a token, minted per launch and handed only to the sidecar. The
//! endpoint runs an arbitrary CLI with the caller's prompt; anything on this
//! machine that found an open port would have a free agent. Loopback is not a
//! security boundary on a shared machine, so the token is the boundary.

use std::process::Stdio;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};

/// How long one completion may take. A CLI in print mode is a whole agent
/// starting up, so this is generous — but unbounded would mean a hung CLI
/// stalls the browser flow that is waiting on it with no way to tell.
const COMPLETION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

pub struct ShimState {
    /// argv prefix for one headless completion, e.g. `["claude", "-p"]`. The
    /// prompt is pushed on as one further argument — never interpolated into a
    /// shell string, because it is model output heading for a command line.
    pub argv: Vec<String>,
    /// Minted per launch. The sidecar gets it; nothing else does.
    pub token: String,
}

/// Flatten an OpenAI chat request into the single prompt a print-mode CLI takes.
///
/// Roles are labelled rather than dropped: Stagehand puts its instructions in
/// the system message and the page in the user message, and a model that cannot
/// tell them apart will happily "click the login button" on the instructions.
/// The transcript form is what a CLI in print mode understands, since it has no
/// role-structured input at all.
fn prompt_from_messages(body: &serde_json::Value) -> Option<String> {
    let messages = body.get("messages")?.as_array()?;
    let mut out = String::new();
    for m in messages {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("user");
        // Content is either a string or the multi-part array form; both appear
        // in the wild and Stagehand emits whichever the provider shape implies.
        let text = match m.get("content") {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Array(parts)) => parts
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => continue,
        };
        if text.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        match role {
            "system" => out.push_str("# System\n"),
            "assistant" => out.push_str("# Assistant\n"),
            _ => out.push_str("# User\n"),
        }
        out.push_str(&text);
    }
    (!out.is_empty()).then_some(out)
}

/// Wrap a completion in the response shape an OpenAI client expects.
///
/// `finish_reason: "stop"` is not decoration — a client that sees anything else
/// may retry, and a retried act() is a second click on a page that already
/// moved.
fn completion_response(text: &str, model: &str) -> serde_json::Value {
    serde_json::json!({
        "id": "chatcmpl-canopy",
        "object": "chat.completion",
        "created": 0,
        "model": model,
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": text },
            "finish_reason": "stop",
        }],
        // Stagehand reads usage for its metrics. Zeroes are honest here: the
        // cost landed on a subscription, not on a per-token bill, and inventing
        // numbers would make its cost report a work of fiction.
        "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
    })
}

/// Whether a request carries the token this shim was launched with.
///
/// Both header spellings, because Stagehand sends the OpenAI one and a bare
/// fetch may send the other; constant-time comparison is not warranted for a
/// loopback token that changes every launch, but a length check first avoids
/// the obvious short-circuit.
fn authorised(headers: &HeaderMap, token: &str) -> bool {
    let presented = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim_start_matches("Bearer ").trim())
        .or_else(|| headers.get("x-canopy-token").and_then(|v| v.to_str().ok()));
    presented.is_some_and(|p| p.len() == token.len() && p == token)
}

async fn chat_completions(
    State(state): State<Arc<ShimState>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    if !authorised(&headers, &state.token) {
        return Err((StatusCode::UNAUTHORIZED, "bad token".into()));
    }
    let prompt = prompt_from_messages(&body)
        .ok_or((StatusCode::BAD_REQUEST, "no usable messages".to_string()))?;
    let model = body
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("canopy-cli")
        .to_string();

    let mut argv = state.argv.clone();
    argv.push(prompt);
    let (exe, args) = argv.split_first().ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "no CLI configured".to_string(),
    ))?;

    // `exe` is the user's own CLI by bare name, built by stagehand.ts. A
    // GUI-launched app cannot find it, and cannot find the tools it goes on to
    // run either — the same pair of problems the companion had. See procenv.
    let resolved = crate::procenv::resolve_command(exe);
    let mut cmd = tokio::process::Command::new(&resolved);
    cmd.args(args).stdin(Stdio::null());
    if let Some(path) = crate::procenv::child_path() {
        cmd.env("PATH", path);
    }
    let out = tokio::time::timeout(COMPLETION_TIMEOUT, cmd.output())
        .await
        .map_err(|_| {
            (
                StatusCode::GATEWAY_TIMEOUT,
                "the CLI didn't answer in time".to_string(),
            )
        })?
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("could not run {exe}: {e}")))?;

    if !out.status.success() {
        // stderr is the only diagnosis available and it is usually the whole
        // story — "not logged in", "rate limited", "unknown flag".
        let why = String::from_utf8_lossy(&out.stderr);
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("{exe} failed: {}", why.trim()),
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(Json(completion_response(&text, &model)))
}

pub fn router(state: Arc<ShimState>) -> Router {
    Router::new()
        .route("/v1/chat/completions", post(chat_completions))
        .with_state(state)
}

/// Where a running shim lives, and the token that opens it.
#[derive(Clone, serde::Serialize)]
pub struct ShimHandle {
    /// What Stagehand takes as its `baseURL`.
    pub base_url: String,
    /// What it takes as its API key. Not a key — a per-launch capability.
    pub token: String,
}

/// A fresh capability token. Same shape and source as the portal's, because it
/// guards the same class of thing: a loopback endpoint that does real work.
fn gen_token() -> String {
    let mut b = [0u8; 16];
    let _ = getrandom::getrandom(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Whether a Node runtime exists to run Stagehand in. Canopy ships none — it is
/// a Rust app with a Rust sidecar — so this is a genuine prerequisite and not a
/// formality.
#[tauri::command]
pub async fn stagehand_node_available() -> bool {
    // Resolved rather than execed bare: node lives in /opt/homebrew/bin or a
    // version manager's shims, and an app launched from Finder has neither on
    // PATH. Unresolved, this answered "no Node runtime" on machines with node
    // plainly installed — and Stagehand then disabled itself for a reason the
    // user could not act on.
    tokio::process::Command::new(crate::procenv::resolve_command("node"))
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Start the model bridge and hand back what Stagehand needs to use it.
///
/// `argv` is the headless form of the user's own CLI, built by stagehand.ts —
/// which refuses to guess one, so an unsupported CLI never reaches here.
#[tauri::command]
pub async fn stagehand_bridge(argv: Vec<String>) -> Result<ShimHandle, String> {
    if argv.is_empty() {
        return Err("no CLI to drive the model bridge with".into());
    }
    serve(argv, gen_token()).await
}

/// Start the shim on loopback, on a port the OS picks.
///
/// Ephemeral for the same reason the browser's debugging port is: a fixed port
/// is a fixed target, and this one runs an agent on demand.
pub async fn serve(argv: Vec<String>, token: String) -> Result<ShimHandle, String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("could not open the model bridge: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("the model bridge has no address: {e}"))?
        .port();
    let state = Arc::new(ShimState {
        argv,
        token: token.clone(),
    });
    let app = router(state);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(ShimHandle {
        base_url: format!("http://127.0.0.1:{port}/v1"),
        token,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, text: &str) -> serde_json::Value {
        serde_json::json!({ "role": role, "content": text })
    }

    #[test]
    fn flattens_a_chat_request_into_a_labelled_transcript() {
        let body = serde_json::json!({
            "messages": [msg("system", "be precise"), msg("user", "click login")]
        });
        let p = prompt_from_messages(&body).unwrap();
        assert_eq!(p, "# System\nbe precise\n\n# User\nclick login");
    }

    // Stagehand puts its instructions in the system message and the page in the
    // user message. Losing that distinction means a model can be told to act on
    // its own instructions.
    #[test]
    fn keeps_roles_distinguishable() {
        let body = serde_json::json!({ "messages": [msg("assistant", "a"), msg("user", "b")] });
        let p = prompt_from_messages(&body).unwrap();
        assert!(p.contains("# Assistant\na"));
        assert!(p.contains("# User\nb"));
    }

    #[test]
    fn understands_the_multi_part_content_form() {
        let body = serde_json::json!({
            "messages": [{
                "role": "user",
                "content": [{ "type": "text", "text": "one" }, { "type": "text", "text": "two" }]
            }]
        });
        assert_eq!(prompt_from_messages(&body).unwrap(), "# User\none\ntwo");
    }

    #[test]
    fn a_request_with_nothing_to_say_is_not_a_prompt() {
        assert!(prompt_from_messages(&serde_json::json!({})).is_none());
        assert!(prompt_from_messages(&serde_json::json!({ "messages": [] })).is_none());
        assert!(
            prompt_from_messages(&serde_json::json!({ "messages": [msg("user", "")] })).is_none()
        );
    }

    // A client that sees anything but "stop" may retry, and a retried act() is a
    // second click on a page that has already moved on.
    #[test]
    fn answers_in_the_shape_an_openai_client_expects() {
        let r = completion_response("clicked", "gpt-4o");
        assert_eq!(r["choices"][0]["message"]["content"], "clicked");
        assert_eq!(r["choices"][0]["message"]["role"], "assistant");
        assert_eq!(r["choices"][0]["finish_reason"], "stop");
        assert_eq!(r["object"], "chat.completion");
        assert_eq!(r["model"], "gpt-4o");
    }

    // The endpoint runs an arbitrary CLI with the caller's prompt. Anything on
    // this machine that found the port would otherwise have a free agent.
    #[test]
    fn refuses_a_request_without_the_launch_token() {
        let mut headers = HeaderMap::new();
        assert!(!authorised(&headers, "secret"));
        headers.insert("authorization", "Bearer wrong".parse().unwrap());
        assert!(!authorised(&headers, "secret"));
        headers.insert("authorization", "Bearer secret".parse().unwrap());
        assert!(authorised(&headers, "secret"));
    }

    #[test]
    fn accepts_the_token_under_either_header() {
        let mut headers = HeaderMap::new();
        headers.insert("x-canopy-token", "secret".parse().unwrap());
        assert!(authorised(&headers, "secret"));
    }

    // An empty configured token must not turn into "everything is authorised".
    #[test]
    fn an_empty_token_still_has_to_match_exactly() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer ".parse().unwrap());
        assert!(authorised(&headers, ""));
        assert!(!authorised(&headers, "secret"));
    }
}
