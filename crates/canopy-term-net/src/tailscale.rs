//! Using the INSTALLED Tailscale through its command line client. Nothing here
//! bundles, installs, logs in or changes Tailscale: the only commands that can
//! ever be run are the four in [`CliCommand`] (`version`, `status --json`,
//! `whois --json <ip>`, `ip -4`), and the type has no way to express any other.
//! `up`, `login`, `logout`, `serve`, `funnel` and `set` are unrepresentable, and
//! the only caller-supplied value, an address, is a typed `IpAddr`, so no peer
//! supplied string ever reaches a command line.
//!
//! Output handling is defensive: JSON comes from stdout only (stderr is drained
//! and discarded, so Homebrew-CLI-versus-app-daemon version warnings are
//! tolerated), unknown fields are ignored, a missing field is a typed error,
//! and nothing panics. Raw output is never logged: it holds tailnet names and
//! peers.
//!
//! Field names below come from Tailscale's Go sources (`ipnstate.Status`,
//! `ipnstate.PeerStatus`, `ipn.State`, `apitype.WhoIsResponse`,
//! `tailcfg.Node`), and the whois key set was checked against a live CLI by
//! listing keys only.

use crate::allowlist::{canonical_tailnet_entry, valid_stable_id, valid_tag};
use crate::json::{self, Json, JsonError};
use std::io::Read;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

/// Oldest Tailscale this module will talk to. UNVERIFIED: chosen as a
/// conservative floor, not derived from the changelog. Verify before relying
/// on it (see DESIGN.md).
pub const MIN_VERSION: (u32, u32, u32) = (1, 60, 0);

// ---- the commands, and only the commands ----

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliCommand {
    Version,
    StatusJson,
    WhoisJson(IpAddr),
    Ip4,
}

impl CliCommand {
    /// The exact argument vector. This is the only place argv is built.
    pub fn argv(&self) -> Vec<String> {
        match self {
            CliCommand::Version => vec!["version".into()],
            CliCommand::StatusJson => vec!["status".into(), "--json".into()],
            CliCommand::WhoisJson(ip) => vec!["whois".into(), "--json".into(), ip.to_string()],
            CliCommand::Ip4 => vec!["ip".into(), "-4".into()],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliError {
    /// The executable does not exist.
    NotInstalled,
    TimedOut,
    Io(std::io::ErrorKind),
}

/// What a command produced. Stderr is never kept. `Debug` shows only the
/// length: the raw output holds tailnet names and peers.
#[derive(Clone, PartialEq, Eq)]
pub struct CliOutput {
    pub stdout: String,
    /// Exit status, informational only: output is judged by its content.
    pub success: bool,
}

impl std::fmt::Debug for CliOutput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CliOutput")
            .field("stdout_len", &self.stdout.len())
            .field("success", &self.success)
            .finish()
    }
}

/// Runs a [`CliCommand`]. Tests inject a fake.
pub trait CliRunner: Send + Sync {
    fn run(&self, cmd: &CliCommand) -> Result<CliOutput, CliError>;
}

// ---- locating the CLI ----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Mac,
    Linux,
    Windows,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Linux
        }
    }
}

/// Whether `dir` is an absolute path for `os`, decided from the string so the
/// rule is the same whichever OS runs the test.
pub fn is_absolute_for(os: Os, dir: &str) -> bool {
    match os {
        Os::Windows => {
            let b = dir.as_bytes();
            dir.starts_with(r"\\")
                || (b.len() >= 3
                    && b[0].is_ascii_alphabetic()
                    && b[1] == b':'
                    && (b[2] == b'\\' || b[2] == b'/'))
        }
        _ => dir.starts_with('/'),
    }
}

/// Pure: the places to look, in order. Fixed install paths come first on every
/// OS; `PATH` is consulted only after them and only for ABSOLUTE entries, so a
/// relative entry (`.`, `node_modules/.bin`, an empty entry) can never supply
/// the binary that decides who is authorised.
pub fn cli_candidates(os: Os, path_env: Option<&str>) -> Vec<PathBuf> {
    let exe = if os == Os::Windows {
        "tailscale.exe"
    } else {
        "tailscale"
    };
    let sep = if os == Os::Windows { ';' } else { ':' };
    let mut candidates: Vec<PathBuf> = match os {
        Os::Mac => vec![
            PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale"),
            PathBuf::from("/opt/homebrew/bin/tailscale"),
            PathBuf::from("/usr/local/bin/tailscale"),
        ],
        Os::Linux => vec![
            PathBuf::from("/usr/bin/tailscale"),
            PathBuf::from("/usr/local/bin/tailscale"),
        ],
        Os::Windows => vec![
            PathBuf::from(r"C:\Program Files\Tailscale\tailscale.exe"),
            PathBuf::from(r"C:\Program Files (x86)\Tailscale\tailscale.exe"),
        ],
    };
    for d in path_env.unwrap_or("").split(sep) {
        let d = d.trim();
        if !is_absolute_for(os, d) {
            continue;
        }
        let p = if os == Os::Windows {
            PathBuf::from(format!("{}\\{exe}", d.trim_end_matches('\\')))
        } else {
            PathBuf::from(format!("{}/{exe}", d.trim_end_matches('/')))
        };
        if !candidates.contains(&p) {
            candidates.push(p);
        }
    }
    candidates
}

/// Pure: the first candidate the predicate accepts.
pub fn locate_cli(
    os: Os,
    path_env: Option<&str>,
    accept: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    cli_candidates(os, path_env).into_iter().find(|c| accept(c))
}

/// Pure trust rule for the resolved binary on unix: owned by root and not
/// writable by group or others. A binary anyone else could replace must not
/// decide who is authorised.
pub fn trusted_owner_mode(uid: u32, mode: u32) -> bool {
    uid == 0 && mode & 0o022 == 0
}

/// Resolve a candidate to the absolute path of the real file and check it.
#[cfg(unix)]
fn trusted_file(p: &Path) -> Option<PathBuf> {
    use std::os::unix::fs::MetadataExt;
    let real = std::fs::canonicalize(p).ok()?;
    let m = std::fs::metadata(&real).ok()?;
    (m.is_file() && trusted_owner_mode(m.uid(), m.mode())).then_some(real)
}

/// Windows: no ownership check (documented); the fixed Program Files paths
/// come first and are admin-writable only.
#[cfg(not(unix))]
fn trusted_file(p: &Path) -> Option<PathBuf> {
    p.is_file().then(|| p.to_path_buf())
}

/// The CLI on this machine as one absolute, resolved path (so nothing
/// re-resolves it through `PATH` at spawn), or `None` when there is no
/// trusted install.
pub fn find_cli() -> Option<PathBuf> {
    let path = std::env::var("PATH").ok();
    cli_candidates(Os::current(), path.as_deref())
        .iter()
        .find_map(|c| trusted_file(c))
}

// ---- the real runner ----

const MAX_OUTPUT: usize = 8 * 1024 * 1024;
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
/// `whois` sits on the accept path: a short bound.
pub const WHOIS_TIMEOUT: Duration = Duration::from_secs(2);

/// Runs the real CLI with stdin closed, both output pipes drained on their own
/// threads (a large `status --json` would otherwise fill the pipe and
/// deadlock), a hard deadline, and the child killed and reaped on timeout.
/// Output is collected with a deadline too, so a grandchild that keeps a pipe
/// open cannot hang the caller.
pub struct ProcessRunner {
    cli: PathBuf,
    timeout: Duration,
}

impl ProcessRunner {
    /// Private: `installed()` is the only public way in, so the location and
    /// ownership checks cannot be skipped.
    fn new(cli: PathBuf, timeout: Duration) -> Self {
        Self { cli, timeout }
    }

    /// A runner for the installed, trusted CLI, or `None`.
    pub fn installed() -> Option<Self> {
        find_cli().map(|p| Self::new(p, DEFAULT_TIMEOUT))
    }

    fn run_argv(&self, argv: &[String], timeout: Duration) -> Result<CliOutput, CliError> {
        let mut cmd = Command::new(&self.cli);
        cmd.args(argv)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW: no console flash from a GUI app.
            cmd.creation_flags(0x0800_0000);
        }
        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                CliError::NotInstalled
            } else {
                CliError::Io(e.kind())
            }
        })?;
        let out = child.stdout.take();
        let err = child.stderr.take();
        let (out_tx, out_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = out_tx.send(drain(out, MAX_OUTPUT));
        });
        // Stderr is read so the child never blocks on it, then thrown away.
        std::thread::spawn(move || {
            drain(err, 0);
        });
        let deadline = Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break Some(s),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        break None;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(CliError::Io(e.kind()));
                }
            }
        };
        let Some(status) = status else {
            return Err(CliError::TimedOut);
        };
        // The child has exited, but a grandchild may still hold the pipe:
        // wait for the output only until the deadline (at least briefly).
        let wait = deadline
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(200));
        match out_rx.recv_timeout(wait) {
            Ok(stdout) => Ok(CliOutput {
                stdout: String::from_utf8_lossy(&stdout).into_owned(),
                success: status.success(),
            }),
            // Incomplete output is never parsed as an answer.
            Err(_) => Err(CliError::TimedOut),
        }
    }
}

/// Read to the end, keeping at most `cap` bytes and discarding the rest.
fn drain<R: Read>(r: Option<R>, cap: usize) -> Vec<u8> {
    let mut kept = Vec::new();
    let Some(mut r) = r else { return kept };
    let mut buf = [0u8; 8192];
    loop {
        match r.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = cap.saturating_sub(kept.len());
                kept.extend_from_slice(&buf[..n.min(room)]);
            }
        }
    }
    kept
}

impl CliRunner for ProcessRunner {
    fn run(&self, cmd: &CliCommand) -> Result<CliOutput, CliError> {
        let timeout = match cmd {
            CliCommand::WhoisJson(_) => self.timeout.min(WHOIS_TIMEOUT),
            _ => self.timeout,
        };
        self.run_argv(&cmd.argv(), timeout)
    }
}

// ---- versions ----

/// `1.78.1`, `1.78.1-t4f2a`, or a multi-line `tailscale version` output, to
/// numbers. Compared numerically (a string compare puts 1.100 before 1.60).
pub fn parse_version(text: &str) -> Option<(u32, u32, u32)> {
    let first = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let token = first.split_whitespace().next()?;
    let numeric: &str = token
        .split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .next()
        .unwrap_or("");
    let mut parts = numeric.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = match parts.next() {
        Some(p) if !p.is_empty() => p.parse().ok()?,
        _ => 0,
    };
    Some((major, minor, patch))
}

// ---- status ----

/// `ipn.State`, plus a catch-all so a state added later is never mistaken for a
/// known one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendState {
    NoState,
    InUseOtherUser,
    NeedsLogin,
    NeedsMachineAuth,
    Stopped,
    Starting,
    Running,
    Other(String),
}

impl BackendState {
    pub fn parse(s: &str) -> BackendState {
        match s {
            "NoState" => BackendState::NoState,
            "InUseOtherUser" => BackendState::InUseOtherUser,
            "NeedsLogin" => BackendState::NeedsLogin,
            "NeedsMachineAuth" => BackendState::NeedsMachineAuth,
            "Stopped" => BackendState::Stopped,
            "Starting" => BackendState::Starting,
            "Running" => BackendState::Running,
            other => BackendState::Other(other.chars().take(32).collect()),
        }
    }
}

/// A node in the status. `Debug` redacts the name (tailnet names must not
/// reach a log through a stray `{:?}`).
#[derive(Clone, PartialEq, Eq)]
pub struct NodeInfo {
    /// Lowercase, without the trailing dot.
    pub dns_name: String,
    pub addrs: Vec<IpAddr>,
    pub online: bool,
    pub stable_id: Option<String>,
}

impl std::fmt::Debug for NodeInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NodeInfo")
            .field("dns_name", &"<redacted>")
            .field("addrs", &self.addrs)
            .field("online", &self.online)
            .field("stable_id", &self.stable_id)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailnetStatus {
    pub backend_state: BackendState,
    /// Absent when the node is not logged in.
    pub self_node: Option<NodeInfo>,
    pub peers: Vec<NodeInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StatusError {
    Json(JsonError),
    Missing(&'static str),
    Invalid(&'static str),
}

impl From<JsonError> for StatusError {
    fn from(e: JsonError) -> Self {
        StatusError::Json(e)
    }
}

fn addr_list(v: Option<&Json>, what: &'static str) -> Result<Vec<IpAddr>, StatusError> {
    match v {
        None | Some(Json::Null) => Ok(Vec::new()),
        Some(Json::Arr(items)) => items
            .iter()
            .map(|a| {
                a.as_str()
                    .and_then(|s| s.parse::<IpAddr>().ok())
                    .ok_or(StatusError::Invalid(what))
            })
            .collect(),
        Some(_) => Err(StatusError::Invalid(what)),
    }
}

fn parse_node(v: &Json, dns_field: &'static str) -> Result<NodeInfo, StatusError> {
    if !matches!(v, Json::Obj(_)) {
        return Err(StatusError::Invalid(dns_field));
    }
    let dns = v
        .get("DNSName")
        .and_then(Json::as_str)
        .ok_or(StatusError::Missing(dns_field))?;
    let stable_id = v
        .get("ID")
        .and_then(Json::as_str)
        .filter(|s| valid_stable_id(s))
        .map(str::to_string);
    Ok(NodeInfo {
        dns_name: dns.trim_end_matches('.').to_ascii_lowercase(),
        addrs: addr_list(v.get("TailscaleIPs"), "TailscaleIPs")?,
        online: v.get("Online").and_then(Json::as_bool).unwrap_or(false),
        stable_id,
    })
}

/// Parse `tailscale status --json`.
pub fn parse_status(text: &str) -> Result<TailnetStatus, StatusError> {
    let root = json::parse(text)?;
    if !matches!(root, Json::Obj(_)) {
        return Err(StatusError::Invalid("status"));
    }
    let backend = root
        .get("BackendState")
        .and_then(Json::as_str)
        .ok_or(StatusError::Missing("BackendState"))?;
    let top_addrs = addr_list(root.get("TailscaleIPs"), "TailscaleIPs")?;
    let self_node = match root.get("Self") {
        None | Some(Json::Null) => None,
        Some(v) => {
            let mut n = parse_node(v, "Self.DNSName")?;
            if n.addrs.is_empty() {
                n.addrs = top_addrs;
            }
            Some(n)
        }
    };
    let peers = match root.get("Peer") {
        None | Some(Json::Null) => Vec::new(),
        Some(p @ Json::Obj(_)) => p
            .object_values()
            .into_iter()
            .map(|v| parse_node(v, "Peer.DNSName"))
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err(StatusError::Invalid("Peer")),
    };
    Ok(TailnetStatus {
        backend_state: BackendState::parse(backend),
        self_node,
        peers,
    })
}

/// What the UI branches on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TailnetState {
    NotInstalled,
    /// The CLI ran but the daemon did not answer usefully.
    DaemonUnreachable,
    NeedsLogin,
    NeedsMachineAuth,
    Stopped,
    Starting,
    Running,
    /// The CLI is older than [`MIN_VERSION`] (or its version is unreadable).
    TooOld(String),
    /// A backend state this code does not know. Never treated as running.
    Unknown(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probe {
    pub state: TailnetState,
    pub status: Option<TailnetStatus>,
}

/// Only exactly `Running` is running; anything unrecognised is `Unknown`.
pub fn classify(b: &BackendState) -> TailnetState {
    match b {
        BackendState::Running => TailnetState::Running,
        BackendState::NeedsLogin => TailnetState::NeedsLogin,
        BackendState::NeedsMachineAuth => TailnetState::NeedsMachineAuth,
        BackendState::Stopped => TailnetState::Stopped,
        BackendState::Starting => TailnetState::Starting,
        BackendState::NoState => TailnetState::Unknown("NoState".into()),
        BackendState::InUseOtherUser => TailnetState::Unknown("InUseOtherUser".into()),
        BackendState::Other(s) => TailnetState::Unknown(s.clone()),
    }
}

fn probe_of(state: TailnetState) -> Probe {
    Probe {
        state,
        status: None,
    }
}

// ---- who is calling ----

/// Who the tailnet says a peer address belongs to. Keyed on stable ids, not on
/// names (display values that can be renamed). This identifies a MACHINE (a
/// tailnet node), not a person: anyone using that machine is that identity.
/// `Debug` redacts the node name.
#[derive(Clone, PartialEq, Eq)]
pub enum TailnetIdentity {
    User {
        stable_id: String,
        user_id: i64,
        node_name: Option<String>,
    },
    /// A node owned by ACL tags, with no real user.
    Tagged {
        stable_id: String,
        /// Sorted and unique.
        tags: Vec<String>,
        node_name: Option<String>,
    },
}

impl std::fmt::Debug for TailnetIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TailnetIdentity::User {
                stable_id, user_id, ..
            } => f
                .debug_struct("User")
                .field("stable_id", stable_id)
                .field("user_id", user_id)
                .field("node_name", &"<redacted>")
                .finish(),
            TailnetIdentity::Tagged {
                stable_id, tags, ..
            } => f
                .debug_struct("Tagged")
                .field("stable_id", stable_id)
                .field("tags", tags)
                .field("node_name", &"<redacted>")
                .finish(),
        }
    }
}

impl TailnetIdentity {
    /// The allowlist entry for this identity; always a valid
    /// [`canonical_tailnet_entry`].
    pub fn allowlist_entry(&self) -> String {
        match self {
            TailnetIdentity::User {
                stable_id, user_id, ..
            } => format!("tailnet:user/{stable_id}/{user_id}"),
            TailnetIdentity::Tagged {
                stable_id, tags, ..
            } => format!("tailnet:tagged/{stable_id}/{}", tags.join(",")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WhoisError {
    Json(JsonError),
    Missing(&'static str),
    Invalid(&'static str),
    /// Neither tags nor a real user: nothing to key an identity on.
    NoUser,
    /// The node routes more than its own addresses (a subnet router or exit
    /// node): a connection through it could come from any machine behind it.
    RoutesBeyondSelf,
    /// The asked address is not one of the node's own addresses (it was routed
    /// through the node), so the node does not vouch for the sender.
    NotNodeAddress,
    Cli(CliError),
}

impl From<JsonError> for WhoisError {
    fn from(e: JsonError) -> Self {
        WhoisError::Json(e)
    }
}

/// A `netip.Prefix` as text, `100.64.0.2/32`, to (address, prefix length).
fn parse_prefix(s: &str) -> Option<(IpAddr, u8)> {
    let (ip, len) = s.split_once('/')?;
    let ip: IpAddr = ip.parse().ok()?;
    let len: u8 = len.parse().ok()?;
    let max = if ip.is_ipv4() { 32 } else { 128 };
    (len <= max).then_some((ip.to_canonical(), len))
}

fn prefix_list(v: Option<&Json>, what: &'static str) -> Result<Vec<(IpAddr, u8)>, WhoisError> {
    match v {
        None | Some(Json::Null) => Ok(Vec::new()),
        Some(Json::Arr(items)) => items
            .iter()
            .map(|p| {
                p.as_str()
                    .and_then(parse_prefix)
                    .ok_or(WhoisError::Invalid(what))
            })
            .collect(),
        Some(_) => Err(WhoisError::Invalid(what)),
    }
}

fn is_host_prefix(p: &(IpAddr, u8)) -> bool {
    p.1 == if p.0.is_ipv4() { 32 } else { 128 }
}

/// Parse `tailscale whois --json <ip>` into the identity and the node's own
/// addresses. Shape: `{Node: {StableID, Tags, Name, Addresses, AllowedIPs,
/// PrimaryRoutes, ...}, UserProfile: {ID, ...}}`.
fn parse_whois_full(text: &str) -> Result<(TailnetIdentity, Vec<IpAddr>), WhoisError> {
    let root = json::parse(text)?;
    let node = match root.get("Node") {
        Some(n @ Json::Obj(_)) => n,
        Some(Json::Null) | None => return Err(WhoisError::Missing("Node")),
        Some(_) => return Err(WhoisError::Invalid("Node")),
    };
    let stable_id = node
        .get("StableID")
        .and_then(Json::as_str)
        .ok_or(WhoisError::Missing("Node.StableID"))?;
    if !valid_stable_id(stable_id) {
        return Err(WhoisError::Invalid("Node.StableID"));
    }
    let node_name = node
        .get("Name")
        .and_then(Json::as_str)
        .map(|s| s.trim_end_matches('.').to_ascii_lowercase());
    let mut tags: Vec<String> = match node.get("Tags") {
        None | Some(Json::Null) => Vec::new(),
        Some(Json::Arr(items)) => items
            .iter()
            .map(|t| {
                t.as_str()
                    .filter(|s| valid_tag(s))
                    .map(str::to_string)
                    .ok_or(WhoisError::Invalid("Node.Tags"))
            })
            .collect::<Result<_, _>>()?,
        Some(_) => return Err(WhoisError::Invalid("Node.Tags")),
    };
    tags.sort_unstable();
    tags.dedup();
    // The node's own addresses are required: without them nothing can be
    // checked about where a connection came from.
    let own = match node.get("Addresses") {
        None | Some(Json::Null) => return Err(WhoisError::Missing("Node.Addresses")),
        v => prefix_list(v, "Node.Addresses")?,
    };
    if own.is_empty() || !own.iter().all(is_host_prefix) {
        return Err(WhoisError::Invalid("Node.Addresses"));
    }
    let own_ips: Vec<IpAddr> = own.iter().map(|p| p.0).collect();
    // AllowedIPs absent or null means "the same as Addresses". Anything beyond
    // the node's own host addresses is a route: refuse.
    let allowed = prefix_list(node.get("AllowedIPs"), "Node.AllowedIPs")?;
    if allowed
        .iter()
        .any(|p| !is_host_prefix(p) || !own_ips.contains(&p.0))
    {
        return Err(WhoisError::RoutesBeyondSelf);
    }
    if !prefix_list(node.get("PrimaryRoutes"), "Node.PrimaryRoutes")?.is_empty() {
        return Err(WhoisError::RoutesBeyondSelf);
    }
    if !tags.is_empty() {
        return Ok((
            TailnetIdentity::Tagged {
                stable_id: stable_id.to_string(),
                tags,
                node_name,
            },
            own_ips,
        ));
    }
    let user_id = root
        .get("UserProfile")
        .and_then(|u| u.get("ID"))
        .and_then(Json::as_i64)
        .filter(|id| *id > 0)
        .ok_or(WhoisError::NoUser)?;
    Ok((
        TailnetIdentity::User {
            stable_id: stable_id.to_string(),
            user_id,
            node_name,
        },
        own_ips,
    ))
}

/// Parse `tailscale whois --json <ip>` into an identity.
pub fn parse_whois(text: &str) -> Result<TailnetIdentity, WhoisError> {
    parse_whois_full(text).map(|(id, _)| id)
}

// ---- the client ----

pub struct Tailscale {
    runner: Arc<dyn CliRunner>,
}

impl Tailscale {
    pub fn new(runner: Arc<dyn CliRunner>) -> Self {
        Self { runner }
    }

    /// Classify the local Tailscale. Output is judged by its content whatever
    /// the exit code; only when it does not parse is the daemon unreachable.
    pub fn probe(&self) -> Probe {
        if let Err(state) = self.check_version() {
            return probe_of(state);
        }
        let out = match self.runner.run(&CliCommand::StatusJson) {
            Ok(o) => o,
            Err(CliError::NotInstalled) => return probe_of(TailnetState::NotInstalled),
            Err(_) => return probe_of(TailnetState::DaemonUnreachable),
        };
        let status = match parse_status(&out.stdout) {
            Ok(s) => s,
            Err(_) => return probe_of(TailnetState::DaemonUnreachable),
        };
        Probe {
            state: classify(&status.backend_state),
            status: Some(status),
        }
    }

    /// The status, only while the backend is exactly running. Runs
    /// `status --json` alone (the cheap call a dial makes); any other state is
    /// returned as the error.
    pub fn running_status(&self) -> Result<TailnetStatus, TailnetState> {
        let out = match self.runner.run(&CliCommand::StatusJson) {
            Ok(o) => o,
            Err(CliError::NotInstalled) => return Err(TailnetState::NotInstalled),
            Err(_) => return Err(TailnetState::DaemonUnreachable),
        };
        let status = parse_status(&out.stdout).map_err(|_| TailnetState::DaemonUnreachable)?;
        match classify(&status.backend_state) {
            TailnetState::Running => Ok(status),
            other => Err(other),
        }
    }

    /// The CLI version verdict alone: `Ok` if it is at least [`MIN_VERSION`].
    pub fn check_version(&self) -> Result<(), TailnetState> {
        let out = match self.runner.run(&CliCommand::Version) {
            Ok(o) => o,
            Err(CliError::NotInstalled) => return Err(TailnetState::NotInstalled),
            Err(_) => return Err(TailnetState::DaemonUnreachable),
        };
        match parse_version(&out.stdout) {
            None => Err(TailnetState::TooOld("unreadable".into())),
            Some(v) if v < MIN_VERSION => {
                Err(TailnetState::TooOld(format!("{}.{}.{}", v.0, v.1, v.2)))
            }
            Some(_) => Ok(()),
        }
    }

    /// Who owns `ip`. Any failure, timeout or empty answer is an error, which
    /// callers treat as a refusal. `ip` must be one of the node's own
    /// addresses, and the node must route nothing beyond them.
    pub fn whois(&self, ip: IpAddr) -> Result<TailnetIdentity, WhoisError> {
        // One canonical form: a v4-mapped address is asked as plain v4.
        let ip = ip.to_canonical();
        let out = self
            .runner
            .run(&CliCommand::WhoisJson(ip))
            .map_err(WhoisError::Cli)?;
        let (id, own) = parse_whois_full(&out.stdout)?;
        if !own.contains(&ip) {
            return Err(WhoisError::NotNodeAddress);
        }
        Ok(id)
    }
}

/// Test support: a scripted CLI with invented, anonymised fixtures.
#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    pub struct FakeRunner {
        pub version: Mutex<Result<String, CliError>>,
        pub status: Mutex<Result<String, CliError>>,
        pub whois: Mutex<HashMap<IpAddr, Result<String, CliError>>>,
        pub calls: Mutex<Vec<CliCommand>>,
    }

    impl FakeRunner {
        pub fn new(status: &str) -> Self {
            Self {
                version: Mutex::new(Ok("1.78.1\n  tailscale commit: abc\n".into())),
                status: Mutex::new(Ok(status.to_string())),
                whois: Mutex::new(HashMap::new()),
                calls: Mutex::new(Vec::new()),
            }
        }

        pub fn set_whois(&self, ip: IpAddr, r: Result<String, CliError>) {
            self.whois.lock().unwrap().insert(ip, r);
        }

        pub fn whois_calls(&self) -> usize {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|c| matches!(c, CliCommand::WhoisJson(_)))
                .count()
        }
    }

    impl CliRunner for FakeRunner {
        fn run(&self, cmd: &CliCommand) -> Result<CliOutput, CliError> {
            self.calls.lock().unwrap().push(cmd.clone());
            let r = match cmd {
                CliCommand::Version => self.version.lock().unwrap().clone(),
                CliCommand::StatusJson => self.status.lock().unwrap().clone(),
                CliCommand::WhoisJson(ip) => self
                    .whois
                    .lock()
                    .unwrap()
                    .get(ip)
                    .cloned()
                    .unwrap_or(Err(CliError::Io(std::io::ErrorKind::Other))),
                CliCommand::Ip4 => Ok(String::new()),
            };
            r.map(|stdout| CliOutput {
                stdout,
                success: true,
            })
        }
    }

    /// A running node with the given own addresses and one peer.
    pub fn status_running(self_addrs: &[&str], peer_addrs: &[&str]) -> String {
        let q = |a: &[&str]| {
            a.iter()
                .map(|x| format!("\"{x}\""))
                .collect::<Vec<_>>()
                .join(",")
        };
        format!(
            r#"{{"Version":"1.78.1-tfake","BackendState":"Running","TailscaleIPs":[{s}],
            "Self":{{"ID":"nSELFA1CNTRL","DNSName":"node-a.example.ts.net.","TailscaleIPs":[{s}],"Online":true,"UserID":1}},
            "Peer":{{"peer-1":{{"ID":"nPEERB1CNTRL","DNSName":"node-b.example.ts.net.","TailscaleIPs":[{p}],"Online":true,"UserID":2,"Extra":{{"x":1}}}}}}}}"#,
            s = q(self_addrs),
            p = q(peer_addrs)
        )
    }

    pub fn whois_user(stable: &str, user: i64) -> String {
        format!(
            r#"{{"Node":{{"ID":11,"StableID":"{stable}","Name":"node-b.example.ts.net.","User":{user},"Addresses":["100.64.0.2/32","127.0.0.1/32"],"Hostinfo":{{}}}},
            "UserProfile":{{"ID":{user},"LoginName":"user-b@example.com","DisplayName":"User B"}},"CapMap":null}}"#
        )
    }

    pub fn whois_tagged(stable: &str, tags: &[&str]) -> String {
        let t = tags
            .iter()
            .map(|x| format!("\"{x}\""))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            r#"{{"Node":{{"ID":12,"StableID":"{stable}","Name":"box-c.example.ts.net.","User":99,"Tags":[{t}],"Addresses":["100.64.0.3/32","127.0.0.1/32"]}},
            "UserProfile":{{"ID":99,"LoginName":"tagged-devices","DisplayName":"Tagged"}}}}"#
        )
    }
}

#[cfg(test)]
mod tests {
    use super::fake::*;
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    fn probe_with(status: Result<String, CliError>, version: Result<String, CliError>) -> Probe {
        let r = FakeRunner::new("");
        *r.status.lock().unwrap() = status;
        *r.version.lock().unwrap() = version;
        Tailscale::new(Arc::new(r)).probe()
    }

    fn state_with_backend(b: &str) -> TailnetState {
        let json = format!(r#"{{"BackendState":"{b}"}}"#);
        probe_with(Ok(json), Ok("1.78.1".into())).state
    }

    #[test]
    fn each_command_maps_to_its_exact_argv() {
        assert_eq!(CliCommand::Version.argv(), vec!["version"]);
        assert_eq!(CliCommand::StatusJson.argv(), vec!["status", "--json"]);
        assert_eq!(CliCommand::Ip4.argv(), vec!["ip", "-4"]);
        assert_eq!(
            CliCommand::WhoisJson(ip("100.64.0.2")).argv(),
            vec!["whois", "--json", "100.64.0.2"]
        );
        assert_eq!(
            CliCommand::WhoisJson(ip("fd7a:115c:a1e0::2")).argv(),
            vec!["whois", "--json", "fd7a:115c:a1e0::2"]
        );
    }

    #[test]
    fn no_command_is_a_banned_verb() {
        let all = [
            CliCommand::Version,
            CliCommand::StatusJson,
            CliCommand::Ip4,
            CliCommand::WhoisJson(ip("100.64.0.2")),
        ];
        for c in all {
            let first = c.argv().remove(0);
            for banned in ["up", "login", "logout", "serve", "funnel", "set", "down"] {
                assert_ne!(first, banned);
            }
        }
    }

    #[test]
    fn fixed_install_paths_come_before_path_on_every_os() {
        let mac = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
        let c = cli_candidates(Os::Mac, Some("/opt/x"));
        assert_eq!(c[0], PathBuf::from(mac));
        assert_eq!(c[1], PathBuf::from("/opt/homebrew/bin/tailscale"));
        assert_eq!(c[2], PathBuf::from("/usr/local/bin/tailscale"));
        assert_eq!(c.last().unwrap(), &PathBuf::from("/opt/x/tailscale"));
        let c = cli_candidates(Os::Linux, Some("/opt/x"));
        assert_eq!(c[0], PathBuf::from("/usr/bin/tailscale"));
        assert_eq!(c[1], PathBuf::from("/usr/local/bin/tailscale"));
        assert_eq!(c[2], PathBuf::from("/opt/x/tailscale"));
        let c = cli_candidates(Os::Windows, Some(r"C:\y\"));
        assert_eq!(
            c[0],
            PathBuf::from(r"C:\Program Files\Tailscale\tailscale.exe")
        );
        assert_eq!(c.last().unwrap(), &PathBuf::from(r"C:\y\tailscale.exe"));
        // Everything in both installed: the fixed path wins, not PATH.
        assert_eq!(
            locate_cli(Os::Linux, Some("/opt/x"), &|_| true),
            Some(PathBuf::from("/usr/bin/tailscale"))
        );
        assert_eq!(locate_cli(Os::Linux, None, &|_| false), None);
    }

    #[test]
    fn relative_and_empty_path_entries_are_ignored() {
        let unix_path = ".:node_modules/.bin::bin:./x:/abs";
        for os in [Os::Mac, Os::Linux] {
            let c = cli_candidates(os, Some(unix_path));
            for p in &c {
                assert!(p.to_string_lossy().starts_with('/'), "{p:?}");
            }
            assert!(c.contains(&PathBuf::from("/abs/tailscale")));
            // A planted relative binary is never picked even if it "exists".
            let pick = locate_cli(os, Some(unix_path), &|p: &Path| {
                !p.to_string_lossy().starts_with('/') || p == Path::new("/abs/tailscale")
            });
            assert_eq!(pick, Some(PathBuf::from("/abs/tailscale")));
        }
        let c = cli_candidates(
            Os::Windows,
            Some(r".;node_modules\.bin;;bin;D:\t;\\srv\share"),
        );
        assert!(c.contains(&PathBuf::from(r"D:\t\tailscale.exe")));
        assert!(c.contains(&PathBuf::from(r"\\srv\share\tailscale.exe")));
        assert_eq!(c.len(), 4);
    }

    #[test]
    fn absoluteness_is_decided_per_target_os() {
        assert!(is_absolute_for(Os::Linux, "/usr/bin"));
        assert!(!is_absolute_for(Os::Linux, "usr/bin"));
        assert!(!is_absolute_for(Os::Mac, "."));
        assert!(!is_absolute_for(Os::Mac, ""));
        assert!(is_absolute_for(Os::Windows, r"C:\x"));
        assert!(is_absolute_for(Os::Windows, "C:/x"));
        assert!(is_absolute_for(Os::Windows, r"\\srv\share"));
        assert!(!is_absolute_for(Os::Windows, r"C:x"));
        assert!(!is_absolute_for(Os::Windows, r"\x"));
        assert!(!is_absolute_for(Os::Windows, "/usr/bin"));
    }

    #[test]
    fn only_a_root_owned_unwritable_binary_is_trusted() {
        assert!(trusted_owner_mode(0, 0o100755));
        assert!(trusted_owner_mode(0, 0o100555));
        assert!(!trusted_owner_mode(501, 0o100755));
        assert!(!trusted_owner_mode(0, 0o100775));
        assert!(!trusted_owner_mode(0, 0o100757));
        assert!(!trusted_owner_mode(0, 0o100777));
    }

    #[test]
    fn versions_compare_numerically() {
        assert_eq!(parse_version("1.78.1"), Some((1, 78, 1)));
        assert_eq!(
            parse_version("1.78.1-t4f2a-gabc\n  commit: x"),
            Some((1, 78, 1))
        );
        assert_eq!(parse_version("\n1.100"), Some((1, 100, 0)));
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("warning: mismatch"), None);
        assert!((1, 100, 0) > MIN_VERSION);
        assert!((1, 9, 0) < MIN_VERSION);
    }

    #[test]
    fn state_not_installed() {
        let p = probe_with(Ok(String::new()), Err(CliError::NotInstalled));
        assert_eq!(p.state, TailnetState::NotInstalled);
    }

    #[test]
    fn state_daemon_unreachable() {
        assert_eq!(
            probe_with(Err(CliError::TimedOut), Ok("1.78.1".into())).state,
            TailnetState::DaemonUnreachable
        );
        // Non-JSON output, such as the daemon-is-down message.
        assert_eq!(
            probe_with(
                Ok("failed to connect to local tailscaled".into()),
                Ok("1.78.1".into())
            )
            .state,
            TailnetState::DaemonUnreachable
        );
        assert_eq!(
            probe_with(Ok(String::new()), Ok("1.78.1".into())).state,
            TailnetState::DaemonUnreachable
        );
    }

    #[test]
    fn states_from_backend_state() {
        assert_eq!(state_with_backend("NeedsLogin"), TailnetState::NeedsLogin);
        assert_eq!(state_with_backend("Stopped"), TailnetState::Stopped);
        assert_eq!(state_with_backend("Starting"), TailnetState::Starting);
        assert_eq!(
            state_with_backend("NeedsMachineAuth"),
            TailnetState::NeedsMachineAuth
        );
        assert_eq!(state_with_backend("Running"), TailnetState::Running);
    }

    #[test]
    fn unknown_backend_states_are_never_running() {
        assert_eq!(
            state_with_backend("NoState"),
            TailnetState::Unknown("NoState".into())
        );
        assert_eq!(
            state_with_backend("InUseOtherUser"),
            TailnetState::Unknown("InUseOtherUser".into())
        );
        assert_eq!(
            state_with_backend("Running2"),
            TailnetState::Unknown("Running2".into())
        );
        assert_eq!(
            state_with_backend("running"),
            TailnetState::Unknown("running".into())
        );
    }

    #[test]
    fn too_old_version() {
        let p = probe_with(
            Ok(status_running(&["100.64.0.1"], &[])),
            Ok("1.40.2".into()),
        );
        assert_eq!(p.state, TailnetState::TooOld("1.40.2".into()));
        assert!(p.status.is_none());
        assert_eq!(
            probe_with(Ok(String::new()), Ok("garbage".into())).state,
            TailnetState::TooOld("unreadable".into())
        );
    }

    #[test]
    fn version_mismatch_warning_on_stderr_is_tolerated() {
        // The runner never surfaces stderr, so a warning there cannot change
        // the result; stdout alone decides.
        let p = probe_with(
            Ok(status_running(&["100.64.0.1"], &["100.64.0.2"])),
            Ok("1.78.1\n".into()),
        );
        assert_eq!(p.state, TailnetState::Running);
    }

    #[test]
    fn output_is_judged_by_content_not_exit_code() {
        struct Failing;
        impl CliRunner for Failing {
            fn run(&self, cmd: &CliCommand) -> Result<CliOutput, CliError> {
                Ok(CliOutput {
                    stdout: match cmd {
                        CliCommand::Version => "1.78.1".into(),
                        _ => r#"{"BackendState":"Stopped"}"#.into(),
                    },
                    success: false,
                })
            }
        }
        assert_eq!(
            Tailscale::new(Arc::new(Failing)).probe().state,
            TailnetState::Stopped
        );
    }

    #[test]
    fn status_parses_self_peers_and_ignores_unknown_fields() {
        let s = parse_status(&status_running(
            &["100.64.0.1", "fd7a:115c:a1e0::1"],
            &["100.64.0.2"],
        ))
        .unwrap();
        assert_eq!(s.backend_state, BackendState::Running);
        let me = s.self_node.unwrap();
        assert_eq!(me.dns_name, "node-a.example.ts.net");
        assert_eq!(me.addrs.len(), 2);
        assert_eq!(me.stable_id.as_deref(), Some("nSELFA1CNTRL"));
        assert_eq!(s.peers.len(), 1);
        assert_eq!(s.peers[0].dns_name, "node-b.example.ts.net");
        assert_eq!(s.peers[0].addrs, vec![ip("100.64.0.2")]);
        assert!(s.peers[0].online);
    }

    #[test]
    fn status_tolerates_nulls_and_missing_optional_parts() {
        let s = parse_status(r#"{"BackendState":"NeedsLogin","Self":null,"Peer":null}"#).unwrap();
        assert!(s.self_node.is_none());
        assert!(s.peers.is_empty());
        let s = parse_status(
            r#"{"BackendState":"Running","TailscaleIPs":["100.64.0.1"],
                "Self":{"DNSName":"n.example.ts.net.","TailscaleIPs":null},"Peer":{}}"#,
        )
        .unwrap();
        // Own addresses fall back to the top-level list.
        assert_eq!(s.self_node.unwrap().addrs, vec![ip("100.64.0.1")]);
    }

    #[test]
    fn status_missing_or_bad_fields_are_typed_errors() {
        assert_eq!(
            parse_status(r#"{"Self":{}}"#),
            Err(StatusError::Missing("BackendState"))
        );
        assert_eq!(
            parse_status(r#"{"BackendState":"Running","Self":{"TailscaleIPs":[]}}"#),
            Err(StatusError::Missing("Self.DNSName"))
        );
        assert_eq!(
            parse_status(r#"{"BackendState":"Running","Peer":{"k":{"TailscaleIPs":[]}}}"#),
            Err(StatusError::Missing("Peer.DNSName"))
        );
        assert_eq!(
            parse_status(
                r#"{"BackendState":"Running","Self":{"DNSName":"a.","TailscaleIPs":["nope"]}}"#
            ),
            Err(StatusError::Invalid("TailscaleIPs"))
        );
        assert_eq!(
            parse_status(r#"{"BackendState":5}"#),
            Err(StatusError::Missing("BackendState"))
        );
        assert_eq!(parse_status("[]"), Err(StatusError::Invalid("status")));
        assert!(matches!(parse_status("{"), Err(StatusError::Json(_))));
        assert!(matches!(parse_status(""), Err(StatusError::Json(_))));
    }

    #[test]
    fn whois_user_identity() {
        let id = parse_whois(&whois_user("nPEERB1CNTRL", 42)).unwrap();
        assert_eq!(
            id,
            TailnetIdentity::User {
                stable_id: "nPEERB1CNTRL".into(),
                user_id: 42,
                node_name: Some("node-b.example.ts.net".into()),
            }
        );
        assert_eq!(id.allowlist_entry(), "tailnet:user/nPEERB1CNTRL/42");
        assert_eq!(
            canonical_tailnet_entry(&id.allowlist_entry()),
            Some(id.allowlist_entry())
        );
    }

    #[test]
    fn whois_tagged_identity_is_a_separate_kind() {
        let id = parse_whois(&whois_tagged("nBOXC1CNTRL", &["tag:z", "tag:a", "tag:a"])).unwrap();
        assert_eq!(
            id.allowlist_entry(),
            "tailnet:tagged/nBOXC1CNTRL/tag:a,tag:z"
        );
        assert_eq!(
            canonical_tailnet_entry(&id.allowlist_entry()),
            Some(id.allowlist_entry())
        );
        // The same stable id as a user entry is a different entry.
        assert_ne!(id.allowlist_entry(), "tailnet:user/nBOXC1CNTRL/99");
    }

    #[test]
    fn whois_without_tags_or_user_is_an_error() {
        let no_user =
            r#"{"Node":{"StableID":"nX1CNTRL","Addresses":["100.64.0.5/32"]},"UserProfile":null}"#;
        assert_eq!(parse_whois(no_user), Err(WhoisError::NoUser));
        let zero_user = r#"{"Node":{"StableID":"nX1CNTRL","Addresses":["100.64.0.5/32"]},"UserProfile":{"ID":0}}"#;
        assert_eq!(parse_whois(zero_user), Err(WhoisError::NoUser));
    }

    #[test]
    fn whois_malformed_is_a_typed_error() {
        assert!(matches!(parse_whois("not json"), Err(WhoisError::Json(_))));
        assert!(matches!(parse_whois(""), Err(WhoisError::Json(_))));
        assert_eq!(parse_whois("{}"), Err(WhoisError::Missing("Node")));
        assert_eq!(
            parse_whois(r#"{"Node":null}"#),
            Err(WhoisError::Missing("Node"))
        );
        assert_eq!(
            parse_whois(r#"{"Node":{}}"#),
            Err(WhoisError::Missing("Node.StableID"))
        );
        assert_eq!(
            parse_whois(r#"{"Node":{"StableID":"bad id"}}"#),
            Err(WhoisError::Invalid("Node.StableID"))
        );
        assert_eq!(
            parse_whois(r#"{"Node":{"StableID":"nX","Tags":["bad/tag"]}}"#),
            Err(WhoisError::Invalid("Node.Tags"))
        );
        assert_eq!(
            parse_whois(r#"{"Node":{"StableID":"nX","Tags":"tag:a"}}"#),
            Err(WhoisError::Invalid("Node.Tags"))
        );
    }

    #[test]
    fn whois_failure_is_an_error_not_a_guess() {
        let r = Arc::new(FakeRunner::new(""));
        r.set_whois(ip("100.64.0.9"), Err(CliError::TimedOut));
        let ts = Tailscale::new(r.clone());
        assert_eq!(
            ts.whois(ip("100.64.0.9")),
            Err(WhoisError::Cli(CliError::TimedOut))
        );
        // An address the fake knows nothing about also fails.
        assert!(ts.whois(ip("100.64.0.10")).is_err());
        r.set_whois(ip("100.64.0.2"), Ok(whois_user("nPEERB1CNTRL", 42)));
        assert!(ts.whois(ip("100.64.0.2")).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn real_runner_drains_large_output_without_deadlock() {
        crate::watchdog(30, || {
            // 600 KB on stdout and 300 KB on stderr, far past a pipe buffer.
            let r = ProcessRunner::new(PathBuf::from("/bin/sh"), Duration::from_secs(20));
            let argv = vec![
                "-c".to_string(),
                "head -c 600000 /dev/zero | tr '\\0' x; head -c 300000 /dev/zero >&2; exit 3"
                    .into(),
            ];
            let out = r.run_argv(&argv, Duration::from_secs(20)).unwrap();
            assert_eq!(out.stdout.len(), 600_000);
            assert!(!out.success);
        });
    }

    #[cfg(unix)]
    #[test]
    fn real_runner_kills_and_reaps_on_timeout() {
        crate::watchdog(30, || {
            let r = ProcessRunner::new(PathBuf::from("/bin/sh"), Duration::from_millis(300));
            let started = Instant::now();
            let err = r
                .run_argv(
                    &["-c".to_string(), "exec sleep 20".to_string()],
                    Duration::from_millis(300),
                )
                .unwrap_err();
            assert_eq!(err, CliError::TimedOut);
            assert!(started.elapsed() < Duration::from_secs(10));
        });
    }

    #[cfg(unix)]
    #[test]
    fn a_grandchild_holding_the_pipe_cannot_hang_the_caller() {
        crate::watchdog(30, || {
            let r = ProcessRunner::new(PathBuf::from("/bin/sh"), Duration::from_secs(1));
            let started = Instant::now();
            // The shell exits at once; its background sleep keeps stdout open.
            let err = r
                .run_argv(
                    &["-c".to_string(), "sleep 20 & exit 0".to_string()],
                    Duration::from_secs(1),
                )
                .unwrap_err();
            assert_eq!(err, CliError::TimedOut);
            assert!(started.elapsed() < Duration::from_secs(10));
        });
    }

    #[test]
    fn whois_uses_the_short_timeout() {
        let r = ProcessRunner::new(PathBuf::from("/x"), Duration::from_secs(10));
        // The bound is applied per command; checked through the constant.
        assert!(WHOIS_TIMEOUT <= Duration::from_secs(2));
        assert!(r.timeout > WHOIS_TIMEOUT);
    }

    #[test]
    fn routes_beyond_the_nodes_own_addresses_are_refused() {
        let base = |extra: &str| {
            format!(
                r#"{{"Node":{{"StableID":"nR1CNTRL","Addresses":["100.64.0.7/32","fd7a:115c:a1e0::7/128"]{extra}}},"UserProfile":{{"ID":5}}}}"#
            )
        };
        // AllowedIPs equal to the own addresses is fine; absent or null too.
        assert!(parse_whois(&base(
            r#","AllowedIPs":["100.64.0.7/32","fd7a:115c:a1e0::7/128"]"#
        ))
        .is_ok());
        assert!(parse_whois(&base("")).is_ok());
        assert!(parse_whois(&base(r#","AllowedIPs":null"#)).is_ok());
        // A subnet route, an exit route, or another host's address: refused.
        for extra in [
            r#","AllowedIPs":["100.64.0.7/32","192.168.1.0/24"]"#,
            r#","AllowedIPs":["0.0.0.0/0"]"#,
            r#","AllowedIPs":["100.64.0.8/32"]"#,
            r#","PrimaryRoutes":["10.0.0.0/8"]"#,
        ] {
            assert_eq!(
                parse_whois(&base(extra)),
                Err(WhoisError::RoutesBeyondSelf),
                "{extra}"
            );
        }
        assert_eq!(
            parse_whois(&base(r#","AllowedIPs":["nope"]"#)),
            Err(WhoisError::Invalid("Node.AllowedIPs"))
        );
    }

    #[test]
    fn whois_needs_the_nodes_own_addresses() {
        assert_eq!(
            parse_whois(r#"{"Node":{"StableID":"nX1CNTRL"},"UserProfile":{"ID":5}}"#),
            Err(WhoisError::Missing("Node.Addresses"))
        );
        assert_eq!(
            parse_whois(
                r#"{"Node":{"StableID":"nX1CNTRL","Addresses":[]},"UserProfile":{"ID":5}}"#
            ),
            Err(WhoisError::Invalid("Node.Addresses"))
        );
        assert_eq!(
            parse_whois(
                r#"{"Node":{"StableID":"nX1CNTRL","Addresses":["100.64.0.0/24"]},"UserProfile":{"ID":5}}"#
            ),
            Err(WhoisError::Invalid("Node.Addresses"))
        );
    }

    #[test]
    fn whois_refuses_an_address_routed_through_the_node() {
        let r = Arc::new(FakeRunner::new(""));
        // The fixture node owns 100.64.0.2 and 127.0.0.1, not 100.64.0.99.
        r.set_whois(ip("100.64.0.99"), Ok(whois_user("nPEERB1CNTRL", 42)));
        r.set_whois(ip("100.64.0.2"), Ok(whois_user("nPEERB1CNTRL", 42)));
        let ts = Tailscale::new(r);
        assert_eq!(ts.whois(ip("100.64.0.99")), Err(WhoisError::NotNodeAddress));
        assert!(ts.whois(ip("100.64.0.2")).is_ok());
        assert!(ts.whois(ip("::ffff:100.64.0.2")).is_ok());
    }

    #[test]
    fn check_version_alone() {
        let r = FakeRunner::new("");
        *r.version.lock().unwrap() = Ok("1.40.0".into());
        assert_eq!(
            Tailscale::new(Arc::new(r)).check_version(),
            Err(TailnetState::TooOld("1.40.0".into()))
        );
        assert_eq!(
            Tailscale::new(Arc::new(FakeRunner::new(""))).check_version(),
            Ok(())
        );
    }

    #[test]
    fn debug_output_never_shows_tailnet_names() {
        let status = parse_status(&status_running(&["100.64.0.1"], &["100.64.0.2"])).unwrap();
        let id = parse_whois(&whois_user("nPEERB1CNTRL", 42)).unwrap();
        let tagged = parse_whois(&whois_tagged("nBOXC1CNTRL", &["tag:a"])).unwrap();
        let out = CliOutput {
            stdout: status_running(&["100.64.0.1"], &[]),
            success: true,
        };
        let shown = format!("{status:?} {id:?} {tagged:?} {out:?}");
        assert!(!shown.contains("example.ts.net"), "{shown}");
        assert!(!shown.contains("user-b@"), "{shown}");
        assert!(shown.contains("redacted"));
    }

    #[test]
    fn real_runner_missing_executable_is_not_installed() {
        let r = ProcessRunner::new(
            PathBuf::from("/nonexistent/definitely-not-tailscale"),
            Duration::from_secs(1),
        );
        assert_eq!(r.run(&CliCommand::Version), Err(CliError::NotInstalled));
    }
}
