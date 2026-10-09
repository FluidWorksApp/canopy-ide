//! How the host reaches the control-plane relay (protocol §6.2). A trait so
//! the relay logic is testable without a network.
//!
//! Every call for a workspace authenticates with that workspace's short-lived
//! host token, which the gateway rewrites about once a minute at
//! `<relay_dir>/<ws>/relay-credential`. The file is read on every request and
//! never cached; a missing or empty file means "not configured yet".

use super::crypto::{Envelope, PublicIdentity};
use futures_util::future::BoxFuture;
use serde::Deserialize;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, PartialEq)]
pub enum TransportError {
    NotConfigured,
    Failed(String),
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SenderInfo {
    pub id: String,
    pub user_id: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub workspace_ids: Option<Vec<String>>,
    pub public_keys: PublicIdentity,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PollRow {
    pub id: String,
    pub envelope: serde_json::Value,
    #[serde(default)]
    pub sender: Option<SenderInfo>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct DirectoryDevice {
    pub id: String,
    pub user_id: String,
    pub public_keys: PublicIdentity,
    #[serde(default)]
    pub kind: Option<String>,
}

pub trait RelayTransport: Send + Sync {
    fn poll<'a>(
        &'a self,
        workspace: &'a str,
        device: &'a str,
    ) -> BoxFuture<'a, Result<Vec<PollRow>, TransportError>>;
    fn ack<'a>(
        &'a self,
        workspace: &'a str,
        device: &'a str,
        ids: Vec<String>,
    ) -> BoxFuture<'a, Result<(), TransportError>>;
    fn directory<'a>(
        &'a self,
        workspace: &'a str,
        device: &'a str,
        team: &'a str,
    ) -> BoxFuture<'a, Result<Vec<DirectoryDevice>, TransportError>>;
    fn relay<'a>(
        &'a self,
        workspace: &'a str,
        device: &'a str,
        team: &'a str,
        recipient: &'a str,
        envelope: &'a Envelope,
    ) -> BoxFuture<'a, Result<(), TransportError>>;
}

pub struct HttpTransport {
    base: String,
    relay_dir: PathBuf,
    client: reqwest::Client,
}

impl HttpTransport {
    pub fn new(base: String, relay_dir: PathBuf) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            relay_dir,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(20))
                .build()
                .expect("an HTTP client builds"),
        }
    }

    fn token(&self, workspace: &str) -> Result<String, TransportError> {
        let path = self.relay_dir.join(workspace).join("relay-credential");
        match std::fs::read_to_string(&path) {
            Ok(raw) => {
                let token = raw.trim();
                let token = token.strip_prefix("Bearer ").unwrap_or(token).trim();
                if token.is_empty() {
                    Err(TransportError::NotConfigured)
                } else {
                    Ok(token.to_string())
                }
            }
            Err(_) => Err(TransportError::NotConfigured),
        }
    }

    async fn call(
        &self,
        workspace: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, TransportError> {
        let mut retried = false;
        loop {
            let token = self.token(workspace)?;
            let response = self
                .client
                .post(format!("{}/api/peers", self.base))
                .bearer_auth(token)
                .header("content-type", "application/json")
                .body(body.to_string())
                .send()
                .await
                .map_err(|e| TransportError::Failed(e.to_string()))?;
            let status = response.status().as_u16();
            // The token may have rotated under us: re-read once.
            if status == 401 && !retried {
                retried = true;
                continue;
            }
            let bytes = response
                .bytes()
                .await
                .map_err(|e| TransportError::Failed(e.to_string()))?;
            if !(200..300).contains(&status) {
                return Err(TransportError::Failed(format!(
                    "relay answered {status}: {}",
                    String::from_utf8_lossy(&bytes)
                        .chars()
                        .take(200)
                        .collect::<String>()
                )));
            }
            return serde_json::from_slice(&bytes)
                .map_err(|e| TransportError::Failed(e.to_string()));
        }
    }
}

impl RelayTransport for HttpTransport {
    fn poll<'a>(
        &'a self,
        workspace: &'a str,
        device: &'a str,
    ) -> BoxFuture<'a, Result<Vec<PollRow>, TransportError>> {
        Box::pin(async move {
            let value = self
                .call(
                    workspace,
                    serde_json::json!({ "action": "poll", "deviceId": device }),
                )
                .await?;
            serde_json::from_value(value.get("envelopes").cloned().unwrap_or_default())
                .map_err(|e| TransportError::Failed(e.to_string()))
        })
    }

    fn ack<'a>(
        &'a self,
        workspace: &'a str,
        device: &'a str,
        ids: Vec<String>,
    ) -> BoxFuture<'a, Result<(), TransportError>> {
        Box::pin(async move {
            self.call(
                workspace,
                serde_json::json!({ "action": "ack", "deviceId": device, "ids": ids }),
            )
            .await
            .map(|_| ())
        })
    }

    fn directory<'a>(
        &'a self,
        workspace: &'a str,
        device: &'a str,
        team: &'a str,
    ) -> BoxFuture<'a, Result<Vec<DirectoryDevice>, TransportError>> {
        Box::pin(async move {
            let value = self
                .call(
                    workspace,
                    serde_json::json!({ "action": "directory", "deviceId": device, "teamId": team }),
                )
                .await?;
            let devices = value
                .get("devices")
                .and_then(|d| d.as_array())
                .cloned()
                .unwrap_or_default();
            Ok(devices
                .into_iter()
                .filter_map(|d| serde_json::from_value(d).ok())
                .collect())
        })
    }

    fn relay<'a>(
        &'a self,
        workspace: &'a str,
        device: &'a str,
        team: &'a str,
        recipient: &'a str,
        envelope: &'a Envelope,
    ) -> BoxFuture<'a, Result<(), TransportError>> {
        Box::pin(async move {
            self.call(
                workspace,
                serde_json::json!({
                    "action": "relay",
                    "deviceId": device,
                    "teamId": team,
                    "recipientDevice": recipient,
                    "envelope": envelope,
                }),
            )
            .await
            .map(|_| ())
        })
    }
}
