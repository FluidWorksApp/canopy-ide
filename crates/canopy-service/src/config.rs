//! Daemon configuration. The systemd unit runs the binary with no arguments
//! and supplies everything through the environment; flags override it.

use std::path::PathBuf;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct Config {
    /// Persistent, private service state (`CANOPY_SERVICE_STATE`).
    pub state_dir: PathBuf,
    /// Sockets (`CANOPY_SERVICE_RUNTIME`).
    pub run_dir: PathBuf,
    /// Control-plane base URL for the relay. None disables the relay client.
    pub relay_url: Option<String>,
    /// Per-workspace relay credentials, `<dir>/<ws>/relay-credential`,
    /// rewritten by the gateway about once a minute.
    pub relay_dir: PathBuf,
    /// `{kid: base64 raw Ed25519 public key}` for access snapshots.
    pub access_keys: PathBuf,
    pub relay_poll: Duration,
}

pub const DEFAULT_STATE_DIR: &str = "/var/lib/canopy-service";
pub const DEFAULT_RUN_DIR: &str = "/run/canopy-service";
pub const DEFAULT_RELAY_DIR: &str = "/run/canopy-relay";

impl Config {
    pub fn new(state_dir: PathBuf, run_dir: PathBuf) -> Self {
        Self {
            access_keys: state_dir.join("access-keys.json"),
            relay_dir: PathBuf::from(DEFAULT_RELAY_DIR),
            state_dir,
            run_dir,
            relay_url: None,
            relay_poll: Duration::from_secs(2),
        }
    }

    /// Environment first, then `--flag value` overrides.
    pub fn from_env_and_args(
        env: impl Fn(&str) -> Option<String>,
        args: &[String],
    ) -> Result<Self, String> {
        let state = env("CANOPY_SERVICE_STATE").filter(|v| !v.is_empty());
        let run = env("CANOPY_SERVICE_RUNTIME").filter(|v| !v.is_empty());
        let mut config = Config::new(
            PathBuf::from(state.as_deref().unwrap_or(DEFAULT_STATE_DIR)),
            PathBuf::from(run.as_deref().unwrap_or(DEFAULT_RUN_DIR)),
        );
        let mut access_keys = env("CANOPY_SERVICE_ACCESS_KEYS")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        config.relay_url = env("CANOPY_SERVICE_RELAY_URL").filter(|v| !v.trim().is_empty());
        if let Some(dir) = env("CANOPY_SERVICE_RELAY_DIR").filter(|v| !v.is_empty()) {
            config.relay_dir = PathBuf::from(dir);
        }
        let mut iter = args.iter();
        while let Some(flag) = iter.next() {
            let mut value = || {
                iter.next()
                    .cloned()
                    .ok_or_else(|| format!("{flag} needs a value"))
            };
            match flag.as_str() {
                "--state-dir" => config.state_dir = PathBuf::from(value()?),
                "--run-dir" => config.run_dir = PathBuf::from(value()?),
                "--relay-url" => config.relay_url = Some(value()?),
                "--relay-dir" => config.relay_dir = PathBuf::from(value()?),
                "--access-keys" => access_keys = Some(PathBuf::from(value()?)),
                other => return Err(format!("unknown argument: {other}")),
            }
        }
        config.access_keys =
            access_keys.unwrap_or_else(|| config.state_dir.join("access-keys.json"));
        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_then_flags() {
        let env = |name: &str| match name {
            "CANOPY_SERVICE_STATE" => Some("/s".to_string()),
            "CANOPY_SERVICE_RUNTIME" => Some("/r".to_string()),
            _ => None,
        };
        let config = Config::from_env_and_args(env, &[]).unwrap();
        assert_eq!(config.state_dir, PathBuf::from("/s"));
        assert_eq!(config.run_dir, PathBuf::from("/r"));
        assert_eq!(config.access_keys, PathBuf::from("/s/access-keys.json"));
        assert!(config.relay_url.is_none());
        let config = Config::from_env_and_args(env, &["--run-dir".into(), "/x".into()]).unwrap();
        assert_eq!(config.run_dir, PathBuf::from("/x"));
        let defaults = Config::from_env_and_args(|_| None, &[]).unwrap();
        assert_eq!(defaults.state_dir, PathBuf::from(DEFAULT_STATE_DIR));
        assert_eq!(defaults.run_dir, PathBuf::from(DEFAULT_RUN_DIR));
        assert!(Config::from_env_and_args(|_| None, &["--nope".into()]).is_err());
    }
}
