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

use crate::allowlist::{canonical_tailnet_entry, tailnet_domain_of, valid_stable_id, valid_tag};
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

/// Pure: the install locations, in order. Only these fixed paths are ever
/// used. `PATH` is deliberately not consulted: this binary decides who is
/// authorised, so it must come from a place an installer puts it, never from
/// whatever the environment points at.
pub fn cli_candidates(os: Os) -> Vec<PathBuf> {
    match os {
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
    }
}

/// Pure: the first candidate the predicate accepts.
pub fn locate_cli(os: Os, accept: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    cli_candidates(os).into_iter().find(|c| accept(c))
}

/// Pure trust rule for the resolved binary on unix: owned by root or by the
/// current user, and not writable by group or others. Root covers the pkg,
/// App Store and distribution packages; the current user covers a drag-installed
/// app or a Homebrew prefix. Anyone else able to replace the file (another
/// user, a group, or the world) must not decide who is authorised. A binary the
/// current user owns is no stronger than that user's own account, which is the
/// same trust boundary as the local socket transport.
pub fn trusted_owner_mode(uid: u32, mode: u32, our_uid: u32) -> bool {
    (uid == 0 || uid == our_uid) && mode & 0o022 == 0
}

/// Why no CLI could be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallProblem {
    /// Nothing at any known install path.
    NotInstalled,
    /// Something is there but is not trusted (wrong owner or writable by
    /// others), so it is never run.
    Untrusted,
}

/// The resolved binary and the (device, inode) it had when it was checked.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Located {
    path: PathBuf,
    id: (u64, u64),
}

/// Check one resolved file now. `symlink_metadata`, so a symlink swapped in
/// since the last check is not followed and is refused.
#[cfg(unix)]
fn check_file(real: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::symlink_metadata(real).ok()?;
    (m.is_file() && trusted_owner_mode(m.uid(), m.mode(), crate::local_unix::current_uid()))
        .then(|| (m.dev(), m.ino()))
}

/// Windows: no ownership check (documented); the fixed Program Files paths
/// are admin-writable only.
#[cfg(not(unix))]
fn check_file(real: &Path) -> Option<(u64, u64)> {
    std::fs::symlink_metadata(real)
        .ok()
        .filter(|m| m.is_file())
        .map(|_| (0, 0))
}

/// Resolve a candidate to the real file (unix), or `None` if absent.
#[cfg(unix)]
fn resolve_candidate(c: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(c).ok()
}

#[cfg(not(unix))]
fn resolve_candidate(c: &Path) -> Option<PathBuf> {
    std::fs::symlink_metadata(c).ok().map(|_| c.to_path_buf())
}

fn locate(os: Os) -> Result<Located, InstallProblem> {
    let mut present = false;
    for c in cli_candidates(os) {
        let Some(real) = resolve_candidate(&c) else {
            continue;
        };
        present = true;
        if let Some(id) = check_file(&real) {
            return Ok(Located { path: real, id });
        }
    }
    Err(if present {
        InstallProblem::Untrusted
    } else {
        InstallProblem::NotInstalled
    })
}

/// The CLI on this machine as one absolute, resolved path (so nothing
/// re-resolves it through `PATH` at spawn), or `None` when there is no
/// trusted install.
pub fn find_cli() -> Option<PathBuf> {
    locate(Os::current()).ok().map(|l| l.path)
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
    /// The (device, inode) the binary had when it was trusted. Checked again
    /// just before every spawn. `None` only for the test constructor.
    expect: Option<(u64, u64)>,
    timeout: Duration,
}

impl ProcessRunner {
    /// Test only: no re-check before spawn. `locate()` / `installed()` are the
    /// only public ways in, so the location and ownership checks cannot be
    /// skipped.
    #[cfg(test)]
    fn new(cli: PathBuf, timeout: Duration) -> Self {
        Self {
            cli,
            expect: None,
            timeout,
        }
    }

    fn from_located(l: Located, timeout: Duration) -> Self {
        Self {
            cli: l.path,
            expect: Some(l.id),
            timeout,
        }
    }

    /// A runner for the installed, trusted CLI, or the reason there is none
    /// (so a UI can say "untrusted install" instead of "not installed").
    pub fn locate() -> Result<Self, InstallProblem> {
        locate(Os::current()).map(|l| Self::from_located(l, DEFAULT_TIMEOUT))
    }

    /// A runner for the installed, trusted CLI, or `None`.
    pub fn installed() -> Option<Self> {
        Self::locate().ok()
    }

    fn run_argv(&self, argv: &[String], timeout: Duration) -> Result<CliOutput, CliError> {
        // Re-check the file right before the spawn: a binary replaced since it
        // was trusted is not run. A swap in the instant between this check and
        // the spawn is not closed (there is no portable fexecve); the file
        // must be unwritable to everyone else, which is what the trust rule
        // already requires.
        if let Some(id) = self.expect {
            if check_file(&self.cli) != Some(id) {
                return Err(CliError::Io(std::io::ErrorKind::PermissionDenied));
            }
        }
        let mut cmd = Command::new(&self.cli);
        cmd.args(argv)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // The child starts from an empty environment: nothing inherited
        // (`TS_SOCKET`, `LD_PRELOAD`, `DYLD_*`, proxy variables, `PATH`) can
        // redirect it or load code into it. Only a fixed PATH on unix and the
        // system root on Windows (Winsock needs it) are set.
        cmd.env_clear();
        #[cfg(unix)]
        cmd.env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
        // The standalone macOS app binary is both the GUI and the CLI, and
        // tells them apart by whether `TERM` is set: without it, `version`
        // prints "The Tailscale GUI failed to start" (read as an unreadable,
        // so "too old", version). A fixed value, so nothing is inherited.
        #[cfg(target_os = "macos")]
        cmd.env("TERM", "dumb");
        #[cfg(windows)]
        for k in ["SystemRoot", "windir"] {
            if let Some(v) = std::env::var_os(k) {
                cmd.env(k, v);
            }
        }
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
        let (out_tx, out_rx) = mpsc::sync_channel(1);
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
    /// The machine's own host name (`HostName`), for display. Capped, with
    /// control characters removed.
    pub host_name: Option<String>,
    /// The owning user id (`UserID`); absent for a tagged node.
    pub user_id: Option<i64>,
    /// ACL tags (`Tags`), sorted and unique; invalid entries are dropped.
    pub tags: Vec<String>,
}

impl std::fmt::Debug for NodeInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NodeInfo")
            .field("dns_name", &"<redacted>")
            .field("host_name", &"<redacted>")
            .field("addrs", &self.addrs)
            .field("online", &self.online)
            .field("stable_id", &self.stable_id)
            .field("user_id", &self.user_id)
            .field("tags", &self.tags)
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
    let host_name = v
        .get("HostName")
        .and_then(Json::as_str)
        .map(|h| {
            h.chars()
                .filter(|c| !c.is_control())
                .take(63)
                .collect::<String>()
        })
        .filter(|h| !h.is_empty());
    let user_id = v.get("UserID").and_then(Json::as_i64).filter(|id| *id > 0);
    let mut tags: Vec<String> = match v.get("Tags") {
        Some(Json::Arr(items)) => items
            .iter()
            .filter_map(Json::as_str)
            .filter(|t| valid_tag(t))
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    };
    tags.sort_unstable();
    tags.dedup();
    Ok(NodeInfo {
        dns_name: dns.trim_end_matches('.').to_ascii_lowercase(),
        addrs: addr_list(v.get("TailscaleIPs"), "TailscaleIPs")?,
        online: v.get("Online").and_then(Json::as_bool).unwrap_or(false),
        stable_id,
        host_name,
        user_id,
        tags,
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
    /// The CLI version, when it could be read (so a caller need not run
    /// `version` a second time).
    pub version: Option<(u32, u32, u32)>,
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

fn probe_of(state: TailnetState, version: Option<(u32, u32, u32)>) -> Probe {
    Probe {
        state,
        status: None,
        version,
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
    /// The stable node id this identity is keyed on.
    pub fn stable_id(&self) -> &str {
        match self {
            TailnetIdentity::User { stable_id, .. } | TailnetIdentity::Tagged { stable_id, .. } => {
                stable_id
            }
        }
    }

    /// The node's full DNS name as whois reported it (lowercase, no trailing
    /// dot). A display value; never log it.
    pub fn node_name(&self) -> Option<&str> {
        match self {
            TailnetIdentity::User { node_name, .. } | TailnetIdentity::Tagged { node_name, .. } => {
                node_name.as_deref()
            }
        }
    }

    /// The tailnet (DNS domain) the node belongs to, from its full name. `None`
    /// when whois gave no usable name; such an identity can never be matched to
    /// an entry bound to a tailnet, so it is refused where a tailnet is needed.
    pub fn tailnet(&self) -> Option<String> {
        self.node_name().and_then(tailnet_domain_of)
    }

    /// The allowlist entry for this identity; always a valid
    /// [`canonical_tailnet_entry`]. It carries the node's tailnet
    /// (`@<domain>`) when whois named one, which binds the entry to that
    /// tailnet; without a name it is the unbound form, which authorises
    /// nothing.
    pub fn allowlist_entry(&self) -> String {
        let bound = self.tailnet().map(|d| format!("@{d}")).unwrap_or_default();
        match self {
            TailnetIdentity::User {
                stable_id, user_id, ..
            } => format!("tailnet:user/{stable_id}/{user_id}{bound}"),
            TailnetIdentity::Tagged {
                stable_id, tags, ..
            } => format!("tailnet:tagged/{stable_id}/{}{bound}", tags.join(",")),
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
    // AllowedIPs must be present: on the wire it may be omitted to mean "the
    // same as Addresses", but the answer for a peer comes from the local node's
    // own view, where it is always filled in. A missing or null value is not
    // evidence the node routes nothing, so it is an error, not a guess. An empty
    // list is just as unusable. Anything beyond the node's own host addresses
    // is a route: refuse.
    let allowed = match node.get("AllowedIPs") {
        None | Some(Json::Null) => return Err(WhoisError::Missing("Node.AllowedIPs")),
        v => prefix_list(v, "Node.AllowedIPs")?,
    };
    if allowed.is_empty() {
        return Err(WhoisError::Invalid("Node.AllowedIPs"));
    }
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
        let version = match self.version() {
            Ok(v) => v,
            Err(state) => {
                let seen = match &state {
                    TailnetState::TooOld(t) => parse_version(t),
                    _ => None,
                };
                return probe_of(state, seen);
            }
        };
        let v = Some(version);
        let out = match self.runner.run(&CliCommand::StatusJson) {
            Ok(o) => o,
            Err(CliError::NotInstalled) => return probe_of(TailnetState::NotInstalled, v),
            Err(_) => return probe_of(TailnetState::DaemonUnreachable, v),
        };
        let status = match parse_status(&out.stdout) {
            Ok(s) => s,
            Err(_) => return probe_of(TailnetState::DaemonUnreachable, v),
        };
        Probe {
            state: classify(&status.backend_state),
            status: Some(status),
            version: v,
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
        self.version().map(|_| ())
    }

    /// The CLI version, if it is at least [`MIN_VERSION`], else the state to
    /// show. A too-old version is reported as text that [`parse_version`]
    /// reads back.
    pub fn version(&self) -> Result<(u32, u32, u32), TailnetState> {
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
            Some(v) => Ok(v),
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

/// Test support: a scripted CLI with invented, anonymised fixtures. Compiled
/// for this crate's tests and, for dependents' tests, behind the
/// `test-support` feature (never enable it in a release build).
#[cfg(any(test, feature = "test-support"))]
pub mod fake {
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
            r#"{{"Node":{{"ID":11,"StableID":"{stable}","Name":"node-b.example.ts.net.","User":{user},"Addresses":["100.64.0.2/32","127.0.0.1/32"],"AllowedIPs":["100.64.0.2/32","127.0.0.1/32"],"Hostinfo":{{}}}},
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
            r#"{{"Node":{{"ID":12,"StableID":"{stable}","Name":"box-c.example.ts.net.","User":99,"Tags":[{t}],"Addresses":["100.64.0.3/32","127.0.0.1/32"],"AllowedIPs":["100.64.0.3/32","127.0.0.1/32"]}},
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
    fn only_fixed_install_paths_are_candidates_and_path_is_ignored() {
        let mac = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
        let c = cli_candidates(Os::Mac);
        assert_eq!(c[0], PathBuf::from(mac));
        assert_eq!(c[1], PathBuf::from("/opt/homebrew/bin/tailscale"));
        assert_eq!(c[2], PathBuf::from("/usr/local/bin/tailscale"));
        assert_eq!(c.len(), 3);
        let c = cli_candidates(Os::Linux);
        assert_eq!(c[0], PathBuf::from("/usr/bin/tailscale"));
        assert_eq!(c.len(), 2);
        let c = cli_candidates(Os::Windows);
        assert_eq!(
            c[0],
            PathBuf::from(r"C:\Program Files\Tailscale\tailscale.exe")
        );
        assert_eq!(c.len(), 2);
        for os in [Os::Mac, Os::Linux, Os::Windows] {
            // Everything "installed": the first fixed path wins.
            assert_eq!(
                locate_cli(os, &|_| true),
                Some(cli_candidates(os)[0].clone())
            );
            assert_eq!(locate_cli(os, &|_| false), None);
        }
    }

    #[test]
    fn root_or_the_current_user_may_own_the_binary_but_nobody_else() {
        assert!(trusted_owner_mode(0, 0o100755, 501));
        assert!(trusted_owner_mode(0, 0o100555, 501));
        assert!(trusted_owner_mode(501, 0o100755, 501));
        assert!(trusted_owner_mode(501, 0o100700, 501));
        // Another user's file is never trusted.
        assert!(!trusted_owner_mode(502, 0o100755, 501));
        // Group or world writable is never trusted, whoever owns it.
        assert!(!trusted_owner_mode(0, 0o100775, 501));
        assert!(!trusted_owner_mode(0, 0o100757, 501));
        assert!(!trusted_owner_mode(0, 0o100777, 501));
        assert!(!trusted_owner_mode(501, 0o100775, 501));
        assert!(!trusted_owner_mode(501, 0o100757, 501));
        // Root as the current user is still root-or-self.
        assert!(trusted_owner_mode(0, 0o100755, 0));
        assert!(!trusted_owner_mode(501, 0o100755, 0));
    }

    #[cfg(unix)]
    fn script(dir: &Path, name: &str, body: &str, mode: u32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
        p
    }

    #[cfg(unix)]
    fn scratch_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ctn-ts-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[cfg(unix)]
    #[test]
    fn check_file_accepts_own_file_and_refuses_writable_or_symlink() {
        let d = scratch_dir("check");
        let good = script(&d, "good", "#!/bin/sh\n", 0o755);
        assert!(check_file(&good).is_some());
        let loose = script(&d, "loose", "#!/bin/sh\n", 0o775);
        assert!(check_file(&loose).is_none());
        let link = d.join("link");
        std::os::unix::fs::symlink(&good, &link).unwrap();
        assert!(check_file(&link).is_none());
        assert!(check_file(&d.join("missing")).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn a_binary_replaced_after_trust_is_not_spawned() {
        crate::watchdog(30, || {
            let d = scratch_dir("restat");
            let real = script(&d, "ts", "#!/bin/sh\necho one\n", 0o755);
            let id = check_file(&real).unwrap();
            let r = ProcessRunner::from_located(
                Located {
                    path: real.clone(),
                    id,
                },
                Duration::from_secs(5),
            );
            let out = r.run_argv(&[], Duration::from_secs(5)).unwrap();
            assert_eq!(out.stdout.trim(), "one");
            // Replace it with a different file (new inode) at the same path.
            let other = script(&d, "other", "#!/bin/sh\necho two\n", 0o755);
            std::fs::rename(&other, &real).unwrap();
            assert_eq!(
                r.run_argv(&[], Duration::from_secs(5)),
                Err(CliError::Io(std::io::ErrorKind::PermissionDenied))
            );
            let _ = std::fs::remove_dir_all(&d);
        });
    }

    #[cfg(unix)]
    #[test]
    fn the_child_gets_an_empty_environment() {
        crate::watchdog(30, || {
            std::env::set_var("CTN_TEST_SECRET", "leak");
            let r = ProcessRunner::new(PathBuf::from("/bin/sh"), Duration::from_secs(5));
            let argv = vec!["-c".to_string(), "echo \"[$CTN_TEST_SECRET]\"".into()];
            let out = r.run_argv(&argv, Duration::from_secs(5)).unwrap();
            assert_eq!(out.stdout.trim(), "[]");
        });
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
        assert_eq!(
            id.allowlist_entry(),
            "tailnet:user/nPEERB1CNTRL/42@example.ts.net"
        );
        assert_eq!(id.tailnet().as_deref(), Some("example.ts.net"));
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
            "tailnet:tagged/nBOXC1CNTRL/tag:a,tag:z@example.ts.net"
        );
        assert_eq!(
            canonical_tailnet_entry(&id.allowlist_entry()),
            Some(id.allowlist_entry())
        );
        // The same stable id as a user entry is a different entry.
        assert_ne!(
            id.allowlist_entry(),
            "tailnet:user/nBOXC1CNTRL/99@example.ts.net"
        );
    }

    #[test]
    fn whois_without_tags_or_user_is_an_error() {
        let no_user = r#"{"Node":{"StableID":"nX1CNTRL","Addresses":["100.64.0.5/32"],"AllowedIPs":["100.64.0.5/32"]},"UserProfile":null}"#;
        assert_eq!(parse_whois(no_user), Err(WhoisError::NoUser));
        let zero_user = r#"{"Node":{"StableID":"nX1CNTRL","Addresses":["100.64.0.5/32"],"AllowedIPs":["100.64.0.5/32"]},"UserProfile":{"ID":0}}"#;
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
        // AllowedIPs equal to the own addresses is fine.
        assert!(parse_whois(&base(
            r#","AllowedIPs":["100.64.0.7/32","fd7a:115c:a1e0::7/128"]"#
        ))
        .is_ok());
        // Absent, null or empty is an error, never read as "same as Addresses".
        assert_eq!(
            parse_whois(&base("")),
            Err(WhoisError::Missing("Node.AllowedIPs"))
        );
        assert_eq!(
            parse_whois(&base(r#","AllowedIPs":null"#)),
            Err(WhoisError::Missing("Node.AllowedIPs"))
        );
        assert_eq!(
            parse_whois(&base(r#","AllowedIPs":[]"#)),
            Err(WhoisError::Invalid("Node.AllowedIPs"))
        );
        // A subnet route, an exit route, or another host's address: refused.
        for extra in [
            r#","AllowedIPs":["100.64.0.7/32","192.168.1.0/24"]"#,
            r#","AllowedIPs":["0.0.0.0/0"]"#,
            r#","AllowedIPs":["100.64.0.8/32"]"#,
            r#","AllowedIPs":["100.64.0.7/32"],"PrimaryRoutes":["10.0.0.0/8"]"#,
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
    fn an_entry_without_a_node_name_is_unbound() {
        let id = parse_whois(
            r#"{"Node":{"StableID":"nX1CNTRL","Addresses":["100.64.0.5/32"],"AllowedIPs":["100.64.0.5/32"]},"UserProfile":{"ID":5}}"#,
        )
        .unwrap();
        assert_eq!(id.tailnet(), None);
        assert_eq!(id.allowlist_entry(), "tailnet:user/nX1CNTRL/5");
        // A name with no domain part is unbound too.
        let id = parse_whois(
            r#"{"Node":{"StableID":"nX1CNTRL","Name":"lonely.","Addresses":["100.64.0.5/32"],"AllowedIPs":["100.64.0.5/32"]},"UserProfile":{"ID":5}}"#,
        )
        .unwrap();
        assert_eq!(id.tailnet(), None);
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

    #[test]
    fn status_carries_host_name_user_and_tags() {
        let text = r#"{"BackendState":"Running","Self":{"ID":"nSELFA1CNTRL","DNSName":"a.example.ts.net.","HostName":"Node A","UserID":7,"TailscaleIPs":["100.64.0.1"]},
            "Peer":{"k":{"ID":"nPEERB1CNTRL","DNSName":"b.example.ts.net.","HostName":"bo\u0007x","Tags":["tag:z","tag:a","tag:a","bad tag"],"TailscaleIPs":["100.64.0.2"]}}}"#;
        let st = parse_status(text).unwrap();
        let me = st.self_node.unwrap();
        assert_eq!(me.host_name.as_deref(), Some("Node A"));
        assert_eq!(me.user_id, Some(7));
        assert!(me.tags.is_empty());
        let peer = &st.peers[0];
        assert_eq!(peer.host_name.as_deref(), Some("box"));
        assert_eq!(peer.user_id, None);
        assert_eq!(peer.tags, vec!["tag:a".to_string(), "tag:z".to_string()]);
        assert!(!format!("{peer:?}").contains("box"));
    }

    #[test]
    fn probe_carries_the_version() {
        let p = probe_with(
            Ok(status_running(&["100.64.0.1"], &[])),
            Ok("1.78.1\n".into()),
        );
        assert_eq!(p.version, Some((1, 78, 1)));
        let old = probe_with(Ok(String::new()), Ok("1.20.0\n".into()));
        assert_eq!(old.version, Some((1, 20, 0)));
        assert!(matches!(old.state, TailnetState::TooOld(_)));
    }
}
