//! Settings → Remote access → Tailscale: what the INSTALLED Tailscale on this
//! machine says, and which tailnet machines may connect in to terminals here.
//!
//! Canopy never signs in, starts, stops or reconfigures Tailscale. Every CLI
//! call goes through canopy-term-net's `tailscale` module, whose command type
//! can only express `version`, `status --json`, `whois --json <ip>` and
//! `ip -4`. "Open Tailscale" launches the GUI app from a fixed per-OS location
//! and nothing else; Linux has no app, so the row says so instead.
//!
//! The allowlist is the crate's `Allowlist`, in its text form at
//! `~/.canopy/tailnet-allow.txt` (mode 0600, written atomically). Entries are
//! the crate's tailnet identities, bound to this machine's own tailnet
//! (`tailnet:user/<stable id>/<user id>@<domain>` or
//! `tailnet:tagged/<stable id>/<tags>@<domain>`), built from a fresh `whois`
//! answer for an address the tailnet itself lists for that machine, never from
//! strings the webview sends. An entry without `@<domain>` (or bound to another
//! tailnet) never admits anyone, so the row shows it as not allowed. Only
//! machines in this machine's own tailnet are listed or allowed: nodes shared in
//! from another tailnet are neither dialled nor admitted. Allowing a machine only
//! records policy: nothing listens on the tailnet yet. Connecting out needs no
//! entry here.
//!
//! Raw CLI output is never logged or returned.

use canopy_term_net::allowlist::{
    canonical_tailnet_entry, tailnet_domain_of, valid_stable_id, Allowlist,
};
use canopy_term_net::tailscale::{
    CliRunner, InstallProblem, NodeInfo, ProcessRunner, TailnetIdentity, TailnetState,
    TailnetStatus, Tailscale, WhoisError, MIN_VERSION,
};
use serde::Serialize;
use std::collections::BTreeSet;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const ALLOW_FILE: &str = "tailnet-allow.txt";

/// Serialises read-change-write of the allowlist file.
static ALLOW_LOCK: Mutex<()> = Mutex::new(());

/// What the row shows. Only `Running` lists machines.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    NotInstalled,
    /// The app is not running, or Tailscale is switched off: one card.
    Off,
    NeedsLogin,
    /// Logged in, waiting for an admin to approve this machine.
    NeedsApproval,
    Starting,
    TooOld,
    Running,
}

/// Exhaustive on purpose: a state the crate adds later must be placed here.
pub fn kind_of(state: &TailnetState) -> Kind {
    match state {
        TailnetState::NotInstalled => Kind::NotInstalled,
        TailnetState::DaemonUnreachable | TailnetState::Stopped => Kind::Off,
        TailnetState::NeedsLogin => Kind::NeedsLogin,
        TailnetState::NeedsMachineAuth => Kind::NeedsApproval,
        TailnetState::Starting => Kind::Starting,
        TailnetState::Running => Kind::Running,
        TailnetState::TooOld(_) => Kind::TooOld,
        // NoState, another user's session, or a state added later: never running.
        TailnetState::Unknown(_) => Kind::Off,
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    /// The machine's own host name when the tailnet gives one, else the first
    /// label of the MagicDNS name.
    pub name: String,
    pub dns_name: String,
    /// IPv4 when it has one.
    pub ip: Option<String>,
    /// The stable node id, the only key Allow takes. `None` cannot be allowed.
    pub stable_id: Option<String>,
    pub online: bool,
    /// An allowlist entry for this stable id is bound to this machine's own
    /// tailnet, so it admits the machine.
    pub allowed: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleView {
    pub kind: Kind,
    /// The installed version, when known.
    pub version: Option<String>,
    pub min_version: String,
    /// Whether "Open Tailscale" can launch an app on this OS.
    pub can_open_app: bool,
    pub this_machine: Option<Machine>,
    /// Every other machine on this machine's own tailnet (not nodes shared in
    /// from another), online or not, sorted by name.
    pub machines: Vec<Machine>,
    /// The allowlist file could not be read; Allow is unavailable until fixed.
    pub allow_error: Option<String>,
}

fn version_string(v: (u32, u32, u32)) -> String {
    format!("{}.{}.{}", v.0, v.1, v.2)
}

fn preferred_addr(addrs: &[IpAddr]) -> Option<IpAddr> {
    addrs
        .iter()
        .copied()
        .find(IpAddr::is_ipv4)
        .or_else(|| addrs.first().copied())
}

pub(crate) fn machine(n: &NodeInfo, allowed: &BTreeSet<String>) -> Machine {
    let ip = preferred_addr(&n.addrs).map(|a| a.to_string());
    let host = n.host_name.as_deref().map(str::trim).unwrap_or("");
    let label = n.dns_name.split('.').next().unwrap_or("");
    let name = if !host.is_empty() {
        host.to_string()
    } else if !label.is_empty() {
        label.to_string()
    } else {
        ip.clone().unwrap_or_else(|| "Unnamed".to_string())
    };
    Machine {
        name,
        dns_name: n.dns_name.clone(),
        ip,
        stable_id: n.stable_id.clone(),
        online: n.online,
        allowed: n.stable_id.as_ref().is_some_and(|id| allowed.contains(id)),
    }
}

/// The stable node id inside a tailnet allowlist entry.
pub(crate) fn entry_stable_id(entry: &str) -> Option<String> {
    let canon = canonical_tailnet_entry(entry)?;
    canon.splitn(3, '/').nth(1).map(str::to_string)
}

/// The tailnet (DNS domain) this machine is on, from its own full name.
pub(crate) fn own_domain(status: &TailnetStatus) -> Option<String> {
    status
        .self_node
        .as_ref()
        .and_then(|n| tailnet_domain_of(&n.dns_name))
}

/// Whether `n` belongs to the tailnet `domain`. Without a known own tailnet
/// nothing does, so nothing is listed or allowed.
pub(crate) fn in_tailnet(n: &NodeInfo, domain: Option<&str>) -> bool {
    domain.is_some() && tailnet_domain_of(&n.dns_name).as_deref() == domain
}

/// Stable ids with an entry bound to `domain`; only those are admitted.
fn allowed_ids(list: &Allowlist, domain: &str) -> BTreeSet<String> {
    let suffix = format!("@{domain}");
    list.keys()
        .iter()
        .filter(|k| canonical_tailnet_entry(k).is_some_and(|c| c.ends_with(&suffix)))
        .filter_map(|k| entry_stable_id(k))
        .collect()
}

/// The tailnet entries in the list (device keys are not this row's business).
pub fn allowed_entries(list: &Allowlist) -> Vec<String> {
    list.keys()
        .into_iter()
        .filter(|k| canonical_tailnet_entry(k).is_some())
        .collect()
}

/// A missing file is an empty list. A bad file is an error and is never
/// overwritten: silently replacing it would drop entries someone relies on.
fn load_allow(path: &Path) -> Result<Allowlist, String> {
    match Allowlist::load(path) {
        Ok(list) => Ok(list),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Allowlist::new()),
        Err(_) => Err(format!(
            "Can't read ~/.canopy/{ALLOW_FILE}. Fix or remove it."
        )),
    }
}

fn save_allow(path: &Path, list: &Allowlist) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Can't save the allow list: {e}"))?;
    }
    list.save(path)
        .map_err(|e| format!("Can't save the allow list: {e}"))
}

/// The row's state. `runner` is the reason there is no usable CLI. Both
/// reasons show the one "not installed" card: an install Canopy will not run
/// (wrong owner, or writable by others) is, to Canopy, no install.
pub fn view(
    runner: Result<Arc<dyn CliRunner>, InstallProblem>,
    allow: &Result<Allowlist, String>,
    can_open_app: bool,
) -> TailscaleView {
    let mut v = TailscaleView {
        kind: Kind::NotInstalled,
        version: None,
        min_version: version_string(MIN_VERSION),
        can_open_app,
        this_machine: None,
        machines: Vec::new(),
        allow_error: allow.as_ref().err().cloned(),
    };
    let runner = match runner {
        Ok(r) => r,
        Err(InstallProblem::NotInstalled | InstallProblem::Untrusted) => return v,
    };
    let probe = Tailscale::new(runner).probe();
    v.kind = kind_of(&probe.state);
    v.version = probe.version.map(version_string);
    match &probe.state {
        TailnetState::Running => {
            if let Some(status) = &probe.status {
                let domain = own_domain(status);
                let ids = match (allow, &domain) {
                    (Ok(list), Some(d)) => allowed_ids(list, d),
                    _ => BTreeSet::new(),
                };
                v.this_machine = status
                    .self_node
                    .as_ref()
                    .map(|n| machine(n, &BTreeSet::new()));
                v.machines = status
                    .peers
                    .iter()
                    .filter(|n| in_tailnet(n, domain.as_deref()))
                    .map(|n| machine(n, &ids))
                    .collect();
                v.machines.sort_by(|a, b| {
                    a.name
                        .cmp(&b.name)
                        .then_with(|| a.dns_name.cmp(&b.dns_name))
                });
            }
        }
        _ => {}
    }
    v
}

fn identity_stable_id(id: &TailnetIdentity) -> &str {
    match id {
        TailnetIdentity::User { stable_id, .. } | TailnetIdentity::Tagged { stable_id, .. } => {
            stable_id
        }
    }
}

/// Change whether the machine with `stable_id` may connect in. Returns whether
/// the list changed. Allowing needs a running Tailscale; removing does not.
pub fn apply_allow(
    ts: Option<&Tailscale>,
    list: &Allowlist,
    stable_id: &str,
    allowed: bool,
) -> Result<bool, String> {
    if !valid_stable_id(stable_id) {
        return Err("Not a Tailscale machine id.".to_string());
    }
    let mut changed = false;
    if !allowed {
        for key in list.keys() {
            if entry_stable_id(&key).as_deref() == Some(stable_id) {
                changed |= list.remove(&key);
            }
        }
        return Ok(changed);
    }
    let ts = ts.ok_or_else(|| "Tailscale isn't installed.".to_string())?;
    let status = ts
        .running_status()
        .map_err(|_| "Tailscale isn't running.".to_string())?;
    let domain = own_domain(&status);
    let peer = status
        .peers
        .iter()
        .filter(|p| in_tailnet(p, domain.as_deref()))
        .find(|p| p.stable_id.as_deref() == Some(stable_id))
        .ok_or_else(|| "That machine isn't on your tailnet.".to_string())?;
    let ip = preferred_addr(&peer.addrs)
        .ok_or_else(|| "That machine has no Tailscale address.".to_string())?;
    let identity = ts.whois(ip).map_err(|e| match e {
        // A subnet router or exit node: a connection through it could come
        // from any machine behind it, so the crate never vouches for it.
        WhoisError::RoutesBeyondSelf => {
            "That machine routes other traffic, so it can't be allowed.".to_string()
        }
        _ => "Tailscale couldn't confirm that machine.".to_string(),
    })?;
    if identity_stable_id(&identity) != stable_id || identity.tailnet() != domain {
        return Err("Tailscale couldn't confirm that machine.".to_string());
    }
    let entry = identity.allowlist_entry();
    // A retagged machine or one with a new owner has a new entry; drop the old.
    for key in list.keys() {
        if key != entry && entry_stable_id(&key).as_deref() == Some(stable_id) {
            changed |= list.remove(&key);
        }
    }
    changed |= list
        .add(&entry)
        .map_err(|_| "Tailscale gave an unusable identity.".to_string())?;
    Ok(changed)
}

/// Read, change and write the allowlist file at `path`.
pub fn set_allowed_at(
    path: &Path,
    ts: Option<&Tailscale>,
    stable_id: &str,
    allowed: bool,
) -> Result<(), String> {
    let _guard = ALLOW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let list = load_allow(path)?;
    if apply_allow(ts, &list, stable_id, allowed)? {
        save_allow(path, &list)?;
    }
    Ok(())
}

fn allow_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| "No home folder.".to_string())?;
    Ok(PathBuf::from(home).join(".canopy").join(ALLOW_FILE))
}

pub(crate) fn installed_runner() -> Result<Arc<dyn CliRunner>, InstallProblem> {
    ProcessRunner::locate().map(|r| Arc::new(r) as Arc<dyn CliRunner>)
}

fn can_open_app() -> bool {
    cfg!(any(target_os = "macos", windows))
}

#[tauri::command]
pub async fn tailscale_status() -> Result<TailscaleView, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let allow = allow_path().and_then(|p| load_allow(&p));
        view(installed_runner(), &allow, can_open_app())
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tailscale_allow_set(stable_id: String, allowed: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = allow_path()?;
        let ts = installed_runner().ok().map(Tailscale::new);
        set_allowed_at(&path, ts.as_ref(), &stable_id, allowed)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tailscale_allowed_list() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<Vec<String>, String> {
        let list = load_allow(&allow_path()?)?;
        Ok(allowed_entries(&list))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tailscale_open_app() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(open_app)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(target_os = "macos")]
fn open_app() -> Result<(), String> {
    use std::process::{Command, Stdio};
    // Launch Services finds the app by name; `open` returns once it is asked.
    let ok = Command::new("/usr/bin/open")
        .args(["-a", "Tailscale"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err("Couldn't open the Tailscale app.".to_string())
    }
}

#[cfg(windows)]
fn open_app() -> Result<(), String> {
    use crate::winproc::NoConsoleWindow;
    for exe in [
        r"C:\Program Files\Tailscale\tailscale-ipn.exe",
        r"C:\Program Files (x86)\Tailscale\tailscale-ipn.exe",
    ] {
        if Path::new(exe).is_file() {
            return std::process::Command::new(exe)
                .no_console_window()
                .spawn()
                .map(|_| ())
                .map_err(|_| "Couldn't open the Tailscale app.".to_string());
        }
    }
    Err("Couldn't find the Tailscale app.".to_string())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn open_app() -> Result<(), String> {
    Err("Start Tailscale on this machine.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_term_net::tailscale::fake::{whois_tagged, whois_user, FakeRunner};
    use canopy_term_net::tailscale::{CliCommand, CliError};

    const RUNNING: &str = r#"{"Version":"1.78.1-tfake","BackendState":"Running","TailscaleIPs":["100.64.0.1"],
        "Self":{"ID":"nSELFA1CNTRL","DNSName":"node-a.example.ts.net.","TailscaleIPs":["100.64.0.1","fd7a:115c:a1e0::1"],"Online":true},
        "Peer":{
          "k1":{"ID":"nLAPTOP1CNTRL","HostName":"laptop-1","DNSName":"laptop.example.ts.net.","TailscaleIPs":["fd7a:115c:a1e0::2","100.64.0.2"],"Online":true},
          "k2":{"ID":"nBUILD1CNTRL","DNSName":"build-box.example.ts.net.","TailscaleIPs":["100.64.0.3"],"Online":true},
          "k3":{"ID":"nNODEB1CNTRL","DNSName":"node-b.example.ts.net.","TailscaleIPs":["100.64.0.4"],"Online":false},
          "k4":{"DNSName":"old-box.example.ts.net.","TailscaleIPs":["100.64.0.5"],"Online":false}
        }}"#;

    const LAPTOP: &str = "nLAPTOP1CNTRL";
    const BUILD: &str = "nBUILD1CNTRL";
    /// The invented tailnet every fixture machine is on.
    const DOMAIN: &str = "@example.ts.net";

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    type Fake = FakeRunner;

    fn shared(f: Fake) -> (Arc<Fake>, Arc<dyn CliRunner>) {
        let fake = Arc::new(f);
        let dynamic: Arc<dyn CliRunner> = fake.clone();
        (fake, dynamic)
    }

    fn view_of(f: Fake) -> TailscaleView {
        let (_, r) = shared(f);
        view(Ok(r), &Ok(Allowlist::new()), true)
    }

    fn with_backend(state: &str) -> Kind {
        view_of(Fake::new(&format!(r#"{{"BackendState":"{state}"}}"#))).kind
    }

    /// A fresh, not yet created directory per test; the file goes inside it.
    fn temp_path(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("canopy-tailnet-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join(ALLOW_FILE)
    }

    fn entries_at(path: &Path) -> Vec<String> {
        allowed_entries(&load_allow(path).unwrap())
    }

    #[test]
    fn not_installed_when_no_cli_is_found() {
        let v = view(
            Err(InstallProblem::NotInstalled),
            &Ok(Allowlist::new()),
            true,
        );
        assert_eq!(v.kind, Kind::NotInstalled);
        assert!(v.this_machine.is_none() && v.machines.is_empty());
        let f = Fake::new("");
        *f.version.lock().unwrap() = Err(CliError::NotInstalled);
        assert_eq!(view_of(f).kind, Kind::NotInstalled);
    }

    #[test]
    fn an_untrusted_install_shows_the_not_installed_card_and_never_runs() {
        let v = view(Err(InstallProblem::Untrusted), &Ok(Allowlist::new()), true);
        assert_eq!(v.kind, Kind::NotInstalled);
        assert_eq!(v.version, None);
        assert!(v.this_machine.is_none() && v.machines.is_empty());
    }

    #[test]
    fn app_not_running_and_stopped_are_one_off_state() {
        assert_eq!(
            view_of(Fake::new("failed to connect to local tailscaled")).kind,
            Kind::Off
        );
        let f = Fake::new("");
        *f.status.lock().unwrap() = Err(CliError::TimedOut);
        assert_eq!(view_of(f).kind, Kind::Off);
        assert_eq!(with_backend("Stopped"), Kind::Off);
    }

    #[test]
    fn login_approval_and_starting_have_their_own_states() {
        assert_eq!(with_backend("NeedsLogin"), Kind::NeedsLogin);
        assert_eq!(with_backend("NeedsMachineAuth"), Kind::NeedsApproval);
        assert_eq!(with_backend("Starting"), Kind::Starting);
        assert_eq!(with_backend("Running"), Kind::Running);
    }

    #[test]
    fn unknown_states_are_off_never_running() {
        for s in ["NoState", "InUseOtherUser", "Running2", "running"] {
            assert_eq!(with_backend(s), Kind::Off, "{s}");
        }
        assert_eq!(kind_of(&TailnetState::Unknown("x".into())), Kind::Off);
    }

    #[test]
    fn too_old_reports_the_found_and_minimum_versions() {
        let f = Fake::new(RUNNING);
        *f.version.lock().unwrap() = Ok("1.40.2".to_string());
        let v = view_of(f);
        assert_eq!(v.kind, Kind::TooOld);
        assert_eq!(v.version.as_deref(), Some("1.40.2"));
        assert_eq!(v.min_version, version_string(MIN_VERSION));
        assert!(v.machines.is_empty());

        let f = Fake::new(RUNNING);
        *f.version.lock().unwrap() = Ok("garbage".to_string());
        let v = view_of(f);
        assert_eq!(v.kind, Kind::TooOld);
        assert_eq!(v.version, None);
    }

    #[test]
    fn running_lists_this_machine_and_every_peer_with_allowed_flags() {
        let list = Allowlist::new();
        list.add(&format!("tailnet:user/{LAPTOP}/42{DOMAIN}"))
            .unwrap();
        let (fake, r) = shared(Fake::new(RUNNING));
        let v = view(Ok(r), &Ok(list), false);
        assert_eq!(v.kind, Kind::Running);
        assert_eq!(v.version.as_deref(), Some("1.78.1"));
        // One `version` call: the probe's own, not a second one for the row.
        assert_eq!(
            fake.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|c| **c == CliCommand::Version)
                .count(),
            1
        );
        assert!(!v.can_open_app);

        let me = v.this_machine.unwrap();
        assert_eq!(me.name, "node-a");
        assert_eq!(me.dns_name, "node-a.example.ts.net");
        assert_eq!(me.ip.as_deref(), Some("100.64.0.1"));

        let names: Vec<&str> = v.machines.iter().map(|m| m.name.as_str()).collect();
        // A host name wins over the MagicDNS label; without one the label is used.
        assert_eq!(names, ["build-box", "laptop-1", "node-b", "old-box"]);
        assert_eq!(v.machines[1].dns_name, "laptop.example.ts.net");
        let laptop = &v.machines[1];
        assert!(laptop.allowed && laptop.online);
        // IPv4 is preferred even when listed second.
        assert_eq!(laptop.ip.as_deref(), Some("100.64.0.2"));
        assert_eq!(laptop.stable_id.as_deref(), Some(LAPTOP));
        assert!(!v.machines[0].allowed);
        assert_eq!(v.machines.iter().filter(|m| !m.online).count(), 2);
        assert_eq!(v.machines[3].stable_id, None);
        assert_eq!(v.allow_error, None);
    }

    #[test]
    fn an_unreadable_allowlist_is_reported_and_nothing_shows_allowed() {
        let (_, r) = shared(Fake::new(RUNNING));
        let v = view(Ok(r), &Err("bad".to_string()), true);
        assert_eq!(v.kind, Kind::Running);
        assert_eq!(v.allow_error.as_deref(), Some("bad"));
        assert!(v.machines.iter().all(|m| !m.allowed));
    }

    #[test]
    fn the_view_serialises_in_the_shape_the_row_reads() {
        let j = serde_json::to_value(view_of(Fake::new(RUNNING))).unwrap();
        assert_eq!(j["kind"], "running");
        assert_eq!(j["thisMachine"]["dnsName"], "node-a.example.ts.net");
        assert!(j["minVersion"].is_string());
        assert!(j["canOpenApp"].is_boolean());
        assert_eq!(j["machines"][1]["stableId"], LAPTOP);
        assert_eq!(
            serde_json::to_value(Kind::NotInstalled).unwrap(),
            "notInstalled"
        );
        assert_eq!(
            serde_json::to_value(Kind::NeedsApproval).unwrap(),
            "needsApproval"
        );
        assert_eq!(serde_json::to_value(Kind::TooOld).unwrap(), "tooOld");
    }

    #[test]
    fn entry_ids_come_only_from_tailnet_entries() {
        assert_eq!(
            entry_stable_id("tailnet:user/nX1CNTRL/42").as_deref(),
            Some("nX1CNTRL")
        );
        assert_eq!(
            entry_stable_id("tailnet:user/nX1CNTRL/42@example.ts.net").as_deref(),
            Some("nX1CNTRL")
        );
        assert_eq!(
            entry_stable_id("tailnet:tagged/nX1CNTRL/tag:a@example.ts.net").as_deref(),
            Some("nX1CNTRL")
        );
        assert_eq!(entry_stable_id(&"a".repeat(64)), None);
        assert_eq!(entry_stable_id("node-a.example.ts.net"), None);
    }

    #[test]
    fn allowing_records_the_whois_identity_of_the_listed_address() {
        let path = temp_path("allow-user");
        let f = Fake::new(RUNNING);
        f.set_whois(ip("100.64.0.2"), Ok(whois_user(LAPTOP, 42)));
        let (fake, r) = shared(f);
        let ts = Tailscale::new(r);
        set_allowed_at(&path, Some(&ts), LAPTOP, true).unwrap();
        assert_eq!(
            entries_at(&path),
            vec![format!("tailnet:user/{LAPTOP}/42{DOMAIN}")]
        );
        // whois asked about the address the tailnet lists for that machine.
        assert!(fake
            .calls
            .lock()
            .unwrap()
            .contains(&CliCommand::WhoisJson(ip("100.64.0.2"))));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // Switching it off removes it.
        set_allowed_at(&path, Some(&ts), LAPTOP, false).unwrap();
        assert!(entries_at(&path).is_empty());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_tagged_machine_gets_a_tagged_entry() {
        let path = temp_path("allow-tagged");
        let f = Fake::new(RUNNING);
        f.set_whois(ip("100.64.0.3"), Ok(whois_tagged(BUILD, &["tag:ci"])));
        let (_, r) = shared(f);
        set_allowed_at(&path, Some(&Tailscale::new(r)), BUILD, true).unwrap();
        assert_eq!(
            entries_at(&path),
            vec![format!("tailnet:tagged/{BUILD}/tag:ci{DOMAIN}")]
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_subnet_router_is_refused_with_its_own_reason() {
        let path = temp_path("allow-router");
        let f = Fake::new(RUNNING);
        f.set_whois(
            ip("100.64.0.3"),
            Ok(format!(
                r#"{{"Node":{{"StableID":"{BUILD}","Addresses":["100.64.0.3/32"],
                "AllowedIPs":["100.64.0.3/32","192.168.50.0/24"]}},"UserProfile":{{"ID":7}}}}"#
            )),
        );
        let (_, r) = shared(f);
        let err = set_allowed_at(&path, Some(&Tailscale::new(r)), BUILD, true).unwrap_err();
        assert!(err.contains("routes other traffic"), "{err}");
        assert!(!path.exists());
    }

    #[test]
    fn allowing_again_replaces_a_stale_identity_for_the_same_machine() {
        let path = temp_path("allow-stale");
        let old = Allowlist::new();
        old.add(&format!("tailnet:user/{LAPTOP}/7{DOMAIN}"))
            .unwrap();
        save_allow(&path, &old).unwrap();
        let f = Fake::new(RUNNING);
        f.set_whois(ip("100.64.0.2"), Ok(whois_user(LAPTOP, 42)));
        let (_, r) = shared(f);
        set_allowed_at(&path, Some(&Tailscale::new(r)), LAPTOP, true).unwrap();
        assert_eq!(
            entries_at(&path),
            vec![format!("tailnet:user/{LAPTOP}/42{DOMAIN}")]
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn allow_fails_closed_and_writes_nothing() {
        let path = temp_path("allow-refused");
        // Not on the tailnet.
        let (_, r) = shared(Fake::new(RUNNING));
        let ts = Tailscale::new(r);
        assert!(set_allowed_at(&path, Some(&ts), "nNOPE1CNTRL", true).is_err());
        // whois cannot answer.
        assert!(set_allowed_at(&path, Some(&ts), LAPTOP, true).is_err());
        // whois names a different machine.
        let f = Fake::new(RUNNING);
        f.set_whois(ip("100.64.0.2"), Ok(whois_user("nOTHER1CNTRL", 42)));
        let (_, r) = shared(f);
        assert!(set_allowed_at(&path, Some(&Tailscale::new(r)), LAPTOP, true).is_err());
        // Tailscale stopped, or not installed.
        let (_, r) = shared(Fake::new(r#"{"BackendState":"Stopped"}"#));
        assert!(set_allowed_at(&path, Some(&Tailscale::new(r)), LAPTOP, true).is_err());
        assert!(set_allowed_at(&path, None, LAPTOP, true).is_err());
        // Not a stable id at all.
        assert!(set_allowed_at(&path, Some(&ts), "../x", true).is_err());
        assert!(set_allowed_at(&path, Some(&ts), "", false).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn removing_works_without_tailscale_and_keeps_other_entries() {
        let path = temp_path("remove");
        let device = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let list = Allowlist::new();
        list.add(&format!("tailnet:user/{LAPTOP}/42{DOMAIN}"))
            .unwrap();
        list.add(&format!("tailnet:tagged/{LAPTOP}/tag:ci{DOMAIN}"))
            .unwrap();
        // An unbound entry still parses, so it can be removed.
        list.add(&format!("tailnet:user/{LAPTOP}/9")).unwrap();
        list.add(&format!("tailnet:user/{BUILD}/42{DOMAIN}"))
            .unwrap();
        list.add(device).unwrap();
        save_allow(&path, &list).unwrap();
        set_allowed_at(&path, None, LAPTOP, false).unwrap();
        let left = load_allow(&path).unwrap();
        assert_eq!(
            allowed_entries(&left),
            vec![format!("tailnet:user/{BUILD}/42{DOMAIN}")]
        );
        assert!(left.contains(device));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_missing_file_is_empty_and_a_bad_one_is_never_overwritten() {
        let path = temp_path("bad-file");
        assert!(load_allow(&path).unwrap().is_empty());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "not-an-entry\n").unwrap();
        assert!(load_allow(&path).is_err());
        assert!(set_allowed_at(&path, None, LAPTOP, false).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not-an-entry\n");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn only_entries_bound_to_this_tailnet_show_as_allowed() {
        let list = Allowlist::new();
        // Unbound: parses, never admits. Another tailnet: never admits either.
        list.add(&format!("tailnet:user/{LAPTOP}/42")).unwrap();
        list.add(&format!("tailnet:user/{BUILD}/42@other.example.net"))
            .unwrap();
        let (_, r) = shared(Fake::new(RUNNING));
        let v = view(Ok(r), &Ok(list), true);
        assert!(v.machines.iter().all(|m| !m.allowed));
    }

    #[test]
    fn allowing_replaces_an_unbound_entry_with_a_bound_one() {
        let path = temp_path("allow-unbound");
        let old = Allowlist::new();
        old.add(&format!("tailnet:user/{LAPTOP}/42")).unwrap();
        save_allow(&path, &old).unwrap();
        let f = Fake::new(RUNNING);
        f.set_whois(ip("100.64.0.2"), Ok(whois_user(LAPTOP, 42)));
        let (_, r) = shared(f);
        set_allowed_at(&path, Some(&Tailscale::new(r)), LAPTOP, true).unwrap();
        assert_eq!(
            entries_at(&path),
            vec![format!("tailnet:user/{LAPTOP}/42{DOMAIN}")]
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_node_shared_in_from_another_tailnet_is_not_listed_or_allowed() {
        let status = RUNNING.replace(
            "laptop.example.ts.net.",
            "laptop.other-tailnet.example.net.",
        );
        let (_, r) = shared(Fake::new(&status));
        let v = view(Ok(r), &Ok(Allowlist::new()), true);
        assert!(v
            .machines
            .iter()
            .all(|m| m.stable_id.as_deref() != Some(LAPTOP)));
        assert_eq!(v.machines.len(), 3);

        let path = temp_path("allow-shared-in");
        let f = Fake::new(&status);
        f.set_whois(ip("100.64.0.2"), Ok(whois_user(LAPTOP, 42)));
        let (_, r) = shared(f);
        assert!(set_allowed_at(&path, Some(&Tailscale::new(r)), LAPTOP, true).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn a_whois_from_another_tailnet_or_without_allowed_ips_is_refused() {
        let path = temp_path("allow-whois-refused");
        // The node is listed in this tailnet but whois names another one.
        let f = Fake::new(RUNNING);
        f.set_whois(
            ip("100.64.0.2"),
            Ok(whois_user(LAPTOP, 42)
                .replace("node-b.example.ts.net.", "node-b.other.example.net.")),
        );
        let (_, r) = shared(f);
        assert!(set_allowed_at(&path, Some(&Tailscale::new(r)), LAPTOP, true).is_err());
        // whois without AllowedIPs is an error in the crate.
        let f = Fake::new(RUNNING);
        f.set_whois(
            ip("100.64.0.2"),
            Ok(whois_user(LAPTOP, 42)
                .replace(r#","AllowedIPs":["100.64.0.2/32","127.0.0.1/32"]"#, "")),
        );
        let (_, r) = shared(f);
        assert!(set_allowed_at(&path, Some(&Tailscale::new(r)), LAPTOP, true).is_err());
        assert!(!path.exists());
    }
}
