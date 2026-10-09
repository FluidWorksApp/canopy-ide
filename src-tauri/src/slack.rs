//! Slack, over Socket Mode: the companion answering where the team talks.
//!
//! Socket Mode is an outbound WebSocket the app opens itself, so the desktop
//! needs no public endpoint — which is the whole reason this lives here rather
//! than behind a webhook. The connection only carries events; replies go out
//! through the Web API with the bot token.
//!
//! This module moves bytes and nothing else. Who may talk to the companion,
//! what reaches it and who may approve its actions are decided in
//! `src/slackBridge.ts`, next to the companion they guard. Every envelope is
//! acknowledged before it is handed on: Slack redelivers an unacknowledged
//! envelope, and a redelivered message would be a second instruction.
//!
//! The tokens live in the macOS Keychain, the same as the account credential
//! (`client_mode.rs`). There is no plaintext fallback on other platforms.

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio_tungstenite::tungstenite::Message;

const KEYCHAIN_SERVICE: &str = "app.causeconnect.canopy.slack";
const APP_TOKEN_ACCOUNT: &str = "app-token";
const BOT_TOKEN_ACCOUNT: &str = "bot-token";
const API: &str = "https://slack.com/api";
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// Slack rejects a `text` beyond 40,000 characters; one reply stays well under.
const MAX_TEXT: usize = 39_000;
const MAX_BLOCKS_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SlackStatus {
    pub configured: bool,
    pub connected: bool,
    pub team: Option<String>,
    pub bot_user_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct SlackManager {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// Bumped on every (re)start and stop; a loop from an older generation
    /// notices and ends instead of racing the new one.
    generation: u64,
    status: SlackStatus,
}

impl SlackManager {
    fn status(&self) -> SlackStatus {
        self.inner.lock().unwrap().status.clone()
    }

    fn update(&self, app: &AppHandle, generation: u64, f: impl FnOnce(&mut SlackStatus)) {
        let status = {
            let mut inner = self.inner.lock().unwrap();
            if inner.generation != generation {
                return;
            }
            f(&mut inner.status);
            inner.status.clone()
        };
        let _ = app.emit("slack:status", status);
    }

    fn current(&self, generation: u64) -> bool {
        self.inner.lock().unwrap().generation == generation
    }
}

/// A message the companion might answer: a direct message to the bot, or a
/// mention of it in a channel. Bot traffic, edits and joins never get here.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SlackMessage {
    pub channel: String,
    pub channel_type: String,
    pub user: String,
    pub text: String,
    pub ts: String,
    pub thread_ts: Option<String>,
    pub mention: bool,
}

/// A button press on a message the bot posted.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SlackAction {
    pub action_id: String,
    pub value: String,
    pub user: String,
    pub channel: String,
    pub message_ts: String,
}

#[derive(Debug, PartialEq)]
pub enum Envelope {
    Hello,
    Disconnect,
    Message(SlackMessage),
    Action(SlackAction),
    Ignored,
}

/// One Socket Mode frame: the envelope id to acknowledge (if any) and what it
/// carried. Pure, so the filtering rules are testable without a socket.
pub fn parse_frame(raw: &str, bot_user_id: Option<&str>) -> (Option<String>, Envelope) {
    let Ok(frame) = serde_json::from_str::<serde_json::Value>(raw) else {
        return (None, Envelope::Ignored);
    };
    let ack = frame["envelope_id"].as_str().map(str::to_string);
    let kind = frame["type"].as_str().unwrap_or("");
    let envelope = match kind {
        "hello" => Envelope::Hello,
        "disconnect" => Envelope::Disconnect,
        "events_api" => message_event(&frame["payload"]["event"], bot_user_id),
        "interactive" => block_action(&frame["payload"]),
        _ => Envelope::Ignored,
    };
    (ack, envelope)
}

fn message_event(event: &serde_json::Value, bot_user_id: Option<&str>) -> Envelope {
    let str_of = |key: &str| event[key].as_str().map(str::to_string);
    let kind = event["type"].as_str().unwrap_or("");
    // Anything with a subtype is an edit, a join, a bot post or a file share
    // notice — never a fresh instruction from a person.
    if event.get("subtype").is_some_and(|v| !v.is_null())
        || event.get("bot_id").is_some_and(|v| !v.is_null())
    {
        return Envelope::Ignored;
    }
    let (Some(channel), Some(user), Some(ts)) = (str_of("channel"), str_of("user"), str_of("ts"))
    else {
        return Envelope::Ignored;
    };
    if bot_user_id == Some(user.as_str()) {
        return Envelope::Ignored;
    }
    let channel_type = str_of("channel_type").unwrap_or_default();
    let mention = match kind {
        "app_mention" => true,
        // Channel messages arrive as app_mention; answering every message in a
        // channel the bot was added to would be eavesdropping.
        "message" if channel_type == "im" => false,
        _ => return Envelope::Ignored,
    };
    Envelope::Message(SlackMessage {
        channel,
        channel_type: if mention && channel_type.is_empty() {
            "channel".into()
        } else {
            channel_type
        },
        user,
        text: str_of("text").unwrap_or_default(),
        ts,
        thread_ts: str_of("thread_ts"),
        mention,
    })
}

fn block_action(payload: &serde_json::Value) -> Envelope {
    if payload["type"].as_str() != Some("block_actions") {
        return Envelope::Ignored;
    }
    let action = &payload["actions"][0];
    let (Some(action_id), Some(user), Some(channel), Some(message_ts)) = (
        action["action_id"].as_str(),
        payload["user"]["id"].as_str(),
        payload["channel"]["id"].as_str(),
        payload["message"]["ts"].as_str(),
    ) else {
        return Envelope::Ignored;
    };
    Envelope::Action(SlackAction {
        action_id: action_id.into(),
        value: action["value"].as_str().unwrap_or_default().into(),
        user: user.into(),
        channel: channel.into(),
        message_ts: message_ts.into(),
    })
}

/// Reject a token of the wrong kind before it reaches the Keychain: the two
/// are easy to paste the wrong way round, and Slack's error for that is opaque.
pub fn check_tokens(app_token: &str, bot_token: &str) -> Result<(), String> {
    let sane = |t: &str| t.len() <= 512 && t.bytes().all(|b| b.is_ascii_graphic());
    if !app_token.starts_with("xapp-") || !sane(app_token) {
        return Err("The app-level token starts with xapp- (Basic Information → App-Level Tokens, scope connections:write).".into());
    }
    if !bot_token.starts_with("xoxb-") || !sane(bot_token) {
        return Err(
            "The bot token starts with xoxb- (OAuth & Permissions → Bot User OAuth Token).".into(),
        );
    }
    Ok(())
}

// ---- Keychain ---------------------------------------------------------------

#[cfg(target_os = "macos")]
fn read_secret(account: &str) -> Result<Option<String>, String> {
    match security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, account) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "The stored Slack token is invalid".into()),
        Err(error) if error.code() == -25300 => Ok(None),
        Err(_) => Err("Cannot read the Slack token from Keychain".into()),
    }
}
#[cfg(target_os = "macos")]
fn write_secret(account: &str, value: &str) -> Result<(), String> {
    security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, account, value.as_bytes())
        .map_err(|_| "Cannot save the Slack token to Keychain".into())
}
#[cfg(target_os = "macos")]
fn delete_secret(account: &str) {
    let _ = security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, account);
}
#[cfg(not(target_os = "macos"))]
fn read_secret(_: &str) -> Result<Option<String>, String> {
    Ok(None)
}
#[cfg(not(target_os = "macos"))]
fn write_secret(_: &str, _: &str) -> Result<(), String> {
    Err("Slack needs secure token storage, which Canopy has only on macOS so far".into())
}
#[cfg(not(target_os = "macos"))]
fn delete_secret(_: &str) {}

fn tokens() -> Result<Option<(String, String)>, String> {
    Ok(
        match (
            read_secret(APP_TOKEN_ACCOUNT)?,
            read_secret(BOT_TOKEN_ACCOUNT)?,
        ) {
            (Some(app), Some(bot)) => Some((app, bot)),
            _ => None,
        },
    )
}

// ---- Web API ----------------------------------------------------------------

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

async fn call(
    token: &str,
    method: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let response = client()?
        .post(format!("{API}/{method}"))
        .bearer_auth(token)
        .header("content-type", "application/json; charset=utf-8")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("Slack is unreachable ({e})"))?;
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| format!("Slack answered {method} with something unreadable"))?;
    if value["ok"].as_bool() == Some(true) {
        Ok(value)
    } else {
        Err(format!(
            "Slack refused {method}: {}",
            value["error"].as_str().unwrap_or("unknown error")
        ))
    }
}

fn bot_token() -> Result<String, String> {
    read_secret(BOT_TOKEN_ACCOUNT)?.ok_or_else(|| "Slack is not connected".to_string())
}

fn clip(text: &str) -> String {
    if text.chars().count() <= MAX_TEXT {
        return text.to_string();
    }
    let mut out: String = text.chars().take(MAX_TEXT).collect();
    out.push('…');
    out
}

fn checked_blocks(blocks: Option<serde_json::Value>) -> Result<Option<serde_json::Value>, String> {
    match blocks {
        Some(b) if !b.is_array() => Err("blocks must be an array".into()),
        Some(b) if b.to_string().len() > MAX_BLOCKS_BYTES => Err("blocks are too large".into()),
        other => Ok(other),
    }
}

// ---- Socket Mode ------------------------------------------------------------

/// (Re)start the connection with whatever is in the Keychain. Safe to call
/// any number of times: an older loop sees the new generation and ends.
pub fn start(app: &AppHandle) {
    let manager = app.state::<SlackManager>();
    let generation = {
        let mut inner = manager.inner.lock().unwrap();
        inner.generation += 1;
        inner.status = SlackStatus::default();
        inner.generation
    };
    let (app_token, bot_token) = match tokens() {
        Ok(Some(pair)) => pair,
        Ok(None) => {
            manager.update(app, generation, |_| {});
            return;
        }
        Err(error) => {
            manager.update(app, generation, |s| s.error = Some(error));
            return;
        }
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        run(app, generation, app_token, bot_token).await;
    });
}

fn stop(app: &AppHandle) {
    let manager = app.state::<SlackManager>();
    let generation = {
        let mut inner = manager.inner.lock().unwrap();
        inner.generation += 1;
        inner.status = SlackStatus::default();
        inner.generation
    };
    manager.update(app, generation, |_| {});
}

async fn run(app: AppHandle, generation: u64, app_token: String, bot_token: String) {
    let manager = app.state::<SlackManager>();
    let bot_user_id = match call(&bot_token, "auth.test", serde_json::json!({})).await {
        Ok(who) => {
            let user = who["user_id"].as_str().map(str::to_string);
            let team = who["team"].as_str().map(str::to_string);
            manager.update(&app, generation, |s| {
                s.configured = true;
                s.team = team;
                s.bot_user_id = user.clone();
            });
            user
        }
        Err(error) => {
            manager.update(&app, generation, |s| {
                s.configured = true;
                s.error = Some(error);
            });
            return;
        }
    };
    let mut backoff = Duration::from_secs(1);
    while manager.current(generation) {
        match session(&app, generation, &app_token, bot_user_id.as_deref()).await {
            // A clean `disconnect` from Slack is routine (it rotates sockets):
            // reconnect at once.
            Ok(()) => backoff = Duration::from_secs(1),
            Err(error) => {
                manager.update(&app, generation, |s| {
                    s.connected = false;
                    s.error = Some(error);
                });
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }
    }
}

async fn session(
    app: &AppHandle,
    generation: u64,
    app_token: &str,
    bot_user_id: Option<&str>,
) -> Result<(), String> {
    let manager = app.state::<SlackManager>();
    let opened = call(app_token, "apps.connections.open", serde_json::json!({})).await?;
    let url = opened["url"]
        .as_str()
        .filter(|u| u.starts_with("wss://"))
        .ok_or("Slack gave no Socket Mode address")?;
    let (mut ws, _) = tokio::time::timeout(HTTP_TIMEOUT, tokio_tungstenite::connect_async(url))
        .await
        .map_err(|_| "timed out connecting to Slack".to_string())?
        .map_err(|e| format!("could not connect to Slack ({e})"))?;
    loop {
        // Re-checked between frames so a stop or reconfigure ends this socket
        // within one heartbeat rather than when Slack next speaks.
        let frame = match tokio::time::timeout(Duration::from_secs(30), ws.next()).await {
            Err(_) => {
                if !manager.current(generation) {
                    let _ = ws.close(None).await;
                    return Ok(());
                }
                ws.send(Message::Ping(Vec::new().into()))
                    .await
                    .map_err(|e| e.to_string())?;
                continue;
            }
            Ok(None) => return Err("Slack closed the connection".into()),
            Ok(Some(Err(e))) => return Err(e.to_string()),
            Ok(Some(Ok(frame))) => frame,
        };
        if !manager.current(generation) {
            let _ = ws.close(None).await;
            return Ok(());
        }
        let text = match frame {
            Message::Text(text) => text.to_string(),
            Message::Ping(data) => {
                let _ = ws.send(Message::Pong(data)).await;
                continue;
            }
            Message::Close(_) => return Err("Slack closed the connection".into()),
            _ => continue,
        };
        let (ack, envelope) = parse_frame(&text, bot_user_id);
        if let Some(id) = ack {
            ws.send(Message::Text(
                serde_json::json!({ "envelope_id": id }).to_string().into(),
            ))
            .await
            .map_err(|e| e.to_string())?;
        }
        match envelope {
            Envelope::Hello => manager.update(app, generation, |s| {
                s.connected = true;
                s.error = None;
            }),
            Envelope::Disconnect => return Ok(()),
            Envelope::Message(message) => {
                let _ = app.emit("slack:message", message);
            }
            Envelope::Action(action) => {
                let _ = app.emit("slack:action", action);
            }
            Envelope::Ignored => {}
        }
    }
}

// ---- Commands ---------------------------------------------------------------

#[tauri::command]
pub fn slack_status(state: tauri::State<'_, SlackManager>) -> SlackStatus {
    state.status()
}

/// Check the pair against Slack, then store it and reconnect. Nothing is
/// stored for a bot token Slack does not recognise.
#[tauri::command]
pub async fn slack_configure(
    app: AppHandle,
    app_token: String,
    bot_token: String,
) -> Result<(), String> {
    let (app_token, bot_token) = (app_token.trim().to_string(), bot_token.trim().to_string());
    check_tokens(&app_token, &bot_token)?;
    call(&bot_token, "auth.test", serde_json::json!({})).await?;
    write_secret(APP_TOKEN_ACCOUNT, &app_token)?;
    write_secret(BOT_TOKEN_ACCOUNT, &bot_token)?;
    start(&app);
    Ok(())
}

#[tauri::command]
pub fn slack_disconnect(app: AppHandle) {
    delete_secret(APP_TOKEN_ACCOUNT);
    delete_secret(BOT_TOKEN_ACCOUNT);
    stop(&app);
}

#[tauri::command]
pub async fn slack_post(
    channel: String,
    thread_ts: Option<String>,
    text: String,
    blocks: Option<serde_json::Value>,
) -> Result<String, String> {
    let mut body =
        serde_json::json!({ "channel": channel, "text": clip(&text), "unfurl_links": false });
    if let Some(ts) = thread_ts {
        body["thread_ts"] = ts.into();
    }
    if let Some(blocks) = checked_blocks(blocks)? {
        body["blocks"] = blocks;
    }
    let posted = call(&bot_token()?, "chat.postMessage", body).await?;
    posted["ts"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Slack did not say where the message landed".into())
}

#[tauri::command]
pub async fn slack_update(
    channel: String,
    ts: String,
    text: String,
    blocks: Option<serde_json::Value>,
) -> Result<(), String> {
    let mut body = serde_json::json!({ "channel": channel, "ts": ts, "text": clip(&text) });
    body["blocks"] = checked_blocks(blocks)?.unwrap_or_else(|| serde_json::json!([]));
    call(&bot_token()?, "chat.update", body).await.map(|_| ())
}

/// A person's display name, for the companion's envelope and the panel.
#[tauri::command]
pub async fn slack_user_name(user: String) -> Result<String, String> {
    let info = call(
        &bot_token()?,
        "users.info",
        serde_json::json!({ "user": user }),
    )
    .await?;
    let profile = &info["user"]["profile"];
    Ok([
        &profile["display_name"],
        &profile["real_name"],
        &info["user"]["name"],
    ]
    .iter()
    .filter_map(|v| v.as_str())
    .find(|v| !v.trim().is_empty())
    .unwrap_or(user.as_str())
    .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(event: serde_json::Value) -> String {
        serde_json::json!({ "envelope_id": "e1", "type": "events_api", "payload": { "event": event } }).to_string()
    }

    #[test]
    fn a_direct_message_is_acknowledged_and_handed_on() {
        let (ack, envelope) = parse_frame(
            &event(serde_json::json!({
                "type": "message", "channel_type": "im", "channel": "D1", "user": "U1",
                "text": "hello", "ts": "1.2"
            })),
            Some("UBOT"),
        );
        assert_eq!(ack.as_deref(), Some("e1"));
        assert_eq!(
            envelope,
            Envelope::Message(SlackMessage {
                channel: "D1".into(),
                channel_type: "im".into(),
                user: "U1".into(),
                text: "hello".into(),
                ts: "1.2".into(),
                thread_ts: None,
                mention: false,
            })
        );
    }

    #[test]
    fn a_mention_in_a_thread_keeps_its_thread() {
        let (_, envelope) = parse_frame(
            &event(serde_json::json!({
                "type": "app_mention", "channel": "C1", "user": "U1", "text": "<@UBOT> hi",
                "ts": "3.4", "thread_ts": "1.0"
            })),
            Some("UBOT"),
        );
        let Envelope::Message(m) = envelope else {
            panic!("not a message")
        };
        assert!(m.mention);
        assert_eq!(m.channel_type, "channel");
        assert_eq!(m.thread_ts.as_deref(), Some("1.0"));
    }

    #[test]
    fn edits_bots_the_bot_itself_and_channel_chatter_are_ignored_but_still_acknowledged() {
        for ignored in [
            serde_json::json!({"type":"message","channel_type":"im","subtype":"message_changed","channel":"D1","user":"U1","ts":"1"}),
            serde_json::json!({"type":"message","channel_type":"im","bot_id":"B1","channel":"D1","user":"U1","ts":"1"}),
            serde_json::json!({"type":"message","channel_type":"im","channel":"D1","user":"UBOT","ts":"1"}),
            serde_json::json!({"type":"message","channel_type":"channel","channel":"C1","user":"U1","ts":"1"}),
            serde_json::json!({"type":"reaction_added","user":"U1"}),
        ] {
            let (ack, envelope) = parse_frame(&event(ignored.clone()), Some("UBOT"));
            assert_eq!(ack.as_deref(), Some("e1"), "{ignored}");
            assert_eq!(envelope, Envelope::Ignored, "{ignored}");
        }
    }

    #[test]
    fn a_button_press_names_who_pressed_it() {
        let raw = serde_json::json!({
            "envelope_id": "e2", "type": "interactive",
            "payload": {
                "type": "block_actions", "user": {"id": "U1"}, "channel": {"id": "D1"},
                "message": {"ts": "9.9"},
                "actions": [{"action_id": "canopy_approve", "value": "p7"}]
            }
        })
        .to_string();
        let (ack, envelope) = parse_frame(&raw, None);
        assert_eq!(ack.as_deref(), Some("e2"));
        assert_eq!(
            envelope,
            Envelope::Action(SlackAction {
                action_id: "canopy_approve".into(),
                value: "p7".into(),
                user: "U1".into(),
                channel: "D1".into(),
                message_ts: "9.9".into(),
            })
        );
    }

    #[test]
    fn control_frames_and_garbage() {
        assert_eq!(
            parse_frame(r#"{"type":"hello"}"#, None),
            (None, Envelope::Hello)
        );
        assert_eq!(
            parse_frame(
                r#"{"type":"disconnect","reason":"refresh_requested"}"#,
                None
            ),
            (None, Envelope::Disconnect)
        );
        assert_eq!(parse_frame("not json", None), (None, Envelope::Ignored));
    }

    #[test]
    fn tokens_must_be_the_right_kind() {
        assert!(check_tokens("xapp-test", "xoxb-test").is_ok());
        assert!(check_tokens("xoxb-test", "xapp-test").is_err());
        assert!(check_tokens("xapp-bad value", "xoxb-test").is_err());
    }

    #[test]
    fn long_replies_are_clipped_and_blocks_are_checked() {
        let long = "a".repeat(MAX_TEXT + 10);
        assert_eq!(clip(&long).chars().count(), MAX_TEXT + 1);
        assert!(checked_blocks(Some(serde_json::json!({}))).is_err());
        assert!(checked_blocks(Some(serde_json::json!([])))
            .unwrap()
            .is_some());
    }
}
