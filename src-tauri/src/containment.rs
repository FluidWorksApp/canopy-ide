//! Platform process-container ownership for terminal sessions.
//!
//! Policy lives in `governor`; this module answers the narrower question:
//! "can this build place the process tree behind a non-destructive, dynamically
//! adjustable OS boundary without a spawn race?" Unsupported or unproven paths
//! stay monitor-only. In particular, this module never sends stop/kill signals
//! and never configures an OOM-producing hard memory limit.

#![cfg_attr(all(test, not(target_os = "linux")), allow(dead_code))]

use crate::governor::GovernorCapability;
use portable_pty::CommandBuilder;
use std::collections::HashMap;
use std::sync::Mutex;

#[cfg(any(target_os = "linux", test))]
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(any(target_os = "linux", test))]
const CGROUP_ROOT_ENV: &str = "CANOPY_CGROUP_ROOT";

pub struct ContainmentManager {
    #[cfg(target_os = "linux")]
    linux: Option<LinuxBackend>,
    #[cfg(target_os = "linux")]
    linux_error: Option<String>,
    #[cfg(target_os = "linux")]
    active: AtomicBool,
    #[cfg(target_os = "linux")]
    sessions: Mutex<HashMap<u32, LinuxLease>>,
    #[cfg(not(target_os = "linux"))]
    sessions: Mutex<HashMap<u32, ()>>,
}

impl Default for ContainmentManager {
    fn default() -> Self {
        #[cfg(target_os = "linux")]
        {
            let (linux, linux_error) = match LinuxBackend::discover() {
                Ok(backend) => (backend, None),
                Err(error) => (None, Some(error)),
            };
            return Self {
                linux,
                linux_error,
                active: AtomicBool::new(false),
                sessions: Mutex::new(HashMap::new()),
            };
        }
        #[cfg(not(target_os = "linux"))]
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

impl ContainmentManager {
    pub fn capability(&self) -> GovernorCapability {
        #[cfg(target_os = "linux")]
        {
            if self.linux.is_some() && self.active.load(Ordering::SeqCst) {
                return GovernorCapability::soft_limit(
                    "linux",
                    "cgroup_v2_memory_current",
                    "cgroup_v2_memory_high",
                    "future terminal trees join an explicitly delegated cgroup before exec",
                );
            }
            let detail = self.linux_error.as_deref().unwrap_or(if self.linux.is_some() {
                "delegated cgroup configured; no gated terminal has completed verification yet"
            } else {
                "set CANOPY_CGROUP_ROOT to an explicit writable delegated cgroup to enable memory.high"
            });
            return GovernorCapability::monitor_only("linux", "resident_set_sum", detail);
        }
        #[cfg(target_os = "windows")]
        return GovernorCapability::monitor_only(
            "windows",
            "working_set_sum",
            "portable-pty starts ConPTY children immediately; a suspended launcher/job assignment gate is not yet proven",
        );
        #[cfg(target_os = "macos")]
        return GovernorCapability::monitor_only(
            "macos",
            "physical_footprint_sum",
            "macOS has no public dynamically adjustable aggregate physical-memory limit for a process tree",
        );
        #[allow(unreachable_code)]
        GovernorCapability::monitor_only(
            "other",
            "resident_set_sum",
            "no platform containment backend is available",
        )
    }

    /// Prepare containment before the child exists. On Linux this creates an
    /// empty cgroup, sets only `memory.high`, and replaces argv with the shipped
    /// launcher. The launcher joins the cgroup and waits; the user's program
    /// cannot execute until `activate` verifies membership and opens the gate.
    pub fn prepare(
        &self,
        id: u32,
        allowance_bytes: u64,
        command: &mut CommandBuilder,
    ) -> Result<PreparedContainment, String> {
        #[cfg(target_os = "linux")]
        {
            if let Some(error) = &self.linux_error {
                return Err(format!(
                    "configured terminal containment is unavailable: {error}"
                ));
            }
            let Some(backend) = &self.linux else {
                return Ok(PreparedContainment::monitor_only());
            };
            return backend.prepare(id, allowance_bytes, command);
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (id, allowance_bytes, command);
            Ok(PreparedContainment::monitor_only())
        }
    }

    /// Complete the spawn gate after portable-pty returns the root PID.
    pub fn activate(
        &self,
        id: u32,
        pid: Option<u32>,
        prepared: PreparedContainment,
    ) -> Result<(), ActivationFailure> {
        #[cfg(target_os = "linux")]
        {
            let Some(mut lease) = prepared.linux else {
                return Ok(());
            };
            let Some(pid) = pid else {
                return Err(ActivationFailure {
                    message: "contained PTY did not expose its root pid".into(),
                    prepared: PreparedContainment { linux: Some(lease) },
                });
            };
            if let Err(message) = lease.verify_and_release(pid) {
                return Err(ActivationFailure {
                    message,
                    prepared: PreparedContainment { linux: Some(lease) },
                });
            }
            self.sessions.lock().unwrap().insert(id, lease);
            self.active.store(true, Ordering::SeqCst);
            return Ok(());
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (id, pid, prepared);
            Ok(())
        }
    }

    /// Raise a live soft boundary after the governor validates an explicit
    /// generation-scoped grant. Lowering is intentionally not exposed here.
    pub fn raise_allowance(&self, id: u32, allowance_bytes: u64) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        {
            let sessions = self.sessions.lock().unwrap();
            let Some(lease) = sessions.get(&id) else {
                return if self.linux.is_some() {
                    Err("terminal has no verified cgroup containment lease".into())
                } else {
                    Ok(()) // monitor-only Linux host
                };
            };
            let old = lease.read_limit()?;
            if old != u64::MAX && allowance_bytes < old {
                return Err("containment allowance raises must be monotonic".into());
            }
            lease.write_limit(allowance_bytes)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (id, allowance_bytes);
            Ok(())
        }
    }

    /// Use the controller's own charge metric whenever it is the active soft
    /// boundary. RSS can be lower than `memory.current` because the cgroup also
    /// charges cache; warning from RSS while enforcing memory.high would allow
    /// invisible throttling before the user sees a grant request.
    pub fn measured_bytes(&self, id: u32, process_tree_fallback: u64) -> u64 {
        #[cfg(target_os = "linux")]
        if let Some(lease) = self.sessions.lock().unwrap().get(&id) {
            return lease.read_current().unwrap_or(process_tree_fallback);
        }
        #[cfg(not(target_os = "linux"))]
        let _ = id;
        process_tree_fallback
    }

    /// Forget the OS container after the session exits. Cleanup is best effort:
    /// failure means a descendant escaped the PTY lifetime or the delegate was
    /// revoked, never a reason to kill an unrelated process.
    pub fn release(&self, id: u32) {
        #[cfg(target_os = "linux")]
        if let Some(lease) = self.sessions.lock().unwrap().remove(&id) {
            drop(lease);
        }
        #[cfg(not(target_os = "linux"))]
        {
            self.sessions.lock().unwrap().remove(&id);
        }
    }
}

pub struct PreparedContainment {
    #[cfg(any(target_os = "linux", test))]
    linux: Option<LinuxLease>,
}

impl PreparedContainment {
    fn monitor_only() -> Self {
        Self {
            #[cfg(any(target_os = "linux", test))]
            linux: None,
        }
    }
}

/// Failed activation deliberately retains the prepared container. The caller
/// must terminate and reap the still-gated launcher before asking this value to
/// clean up; otherwise cgroup removal races the live process and leaks state.
pub struct ActivationFailure {
    message: String,
    prepared: PreparedContainment,
}

impl ActivationFailure {
    pub fn cleanup_after_child_exit(self) -> String {
        let message = self.message;
        drop(self.prepared);
        message
    }
}

#[cfg(any(target_os = "linux", test))]
struct LinuxBackend {
    root: PathBuf,
    helper: PathBuf,
}

#[cfg(any(target_os = "linux", test))]
impl LinuxBackend {
    fn discover() -> Result<Option<Self>, String> {
        let Some(configured) = std::env::var_os(CGROUP_ROOT_ENV) else {
            return Ok(None);
        };
        let root = validate_delegated_root(Path::new(&configured))?;
        let helper = crate::agents::helper_path()?;
        Ok(Some(Self { root, helper }))
    }

    fn prepare(
        &self,
        id: u32,
        allowance_bytes: u64,
        command: &mut CommandBuilder,
    ) -> Result<PreparedContainment, String> {
        if !self.helper.is_file() {
            return Err(format!(
                "containment launcher is missing at {}",
                self.helper.display()
            ));
        }
        let cgroup = self
            .root
            .join(format!("canopy-pty-{}-{id}", std::process::id()));
        std::fs::create_dir(&cgroup)
            .map_err(|error| format!("create terminal cgroup {}: {error}", cgroup.display()))?;

        let mut lease = match LinuxLease::new(cgroup.clone()) {
            Ok(lease) => lease,
            Err(error) => {
                let _ = std::fs::remove_dir(&cgroup);
                return Err(error);
            }
        };
        lease.write_limit(allowance_bytes)?;
        command.env_remove(CGROUP_ROOT_ENV);
        lease.wrap_command(&self.helper, command);
        Ok(PreparedContainment { linux: Some(lease) })
    }
}

#[cfg(any(target_os = "linux", test))]
fn validate_delegated_root(configured: &Path) -> Result<PathBuf, String> {
    if !configured.is_absolute() {
        return Err(format!("{CGROUP_ROOT_ENV} must be an absolute path"));
    }
    let mount = std::fs::canonicalize("/sys/fs/cgroup")
        .map_err(|error| format!("cgroup v2 mount unavailable: {error}"))?;
    let root = std::fs::canonicalize(configured)
        .map_err(|error| format!("invalid {CGROUP_ROOT_ENV}: {error}"))?;
    if root == mount || !root.starts_with(&mount) {
        return Err(format!(
            "{CGROUP_ROOT_ENV} must name a delegated subtree below {}",
            mount.display()
        ));
    }
    let subtree = std::fs::read_to_string(root.join("cgroup.subtree_control"))
        .map_err(|error| format!("cannot read delegated cgroup controls: {error}"))?;
    if !subtree.split_whitespace().any(|item| item == "memory") {
        return Err("delegated cgroup does not enable the memory controller for children".into());
    }
    let self_group = unified_cgroup_path(std::process::id())?;
    let self_group = std::fs::canonicalize(mount.join(self_group.trim_start_matches('/')))
        .map_err(|error| format!("cannot resolve Canopy's current cgroup: {error}"))?;
    if !self_group.starts_with(&root) {
        return Err("Canopy must itself run inside the explicitly delegated cgroup subtree".into());
    }
    Ok(root)
}

#[cfg(any(target_os = "linux", test))]
fn unified_cgroup_path(pid: u32) -> Result<String, String> {
    let body = std::fs::read_to_string(format!("/proc/{pid}/cgroup"))
        .map_err(|error| format!("read cgroup membership for pid {pid}: {error}"))?;
    body.lines()
        .find_map(|line| line.strip_prefix("0::"))
        .map(str::to_string)
        .ok_or_else(|| "unified cgroup v2 membership is unavailable".to_string())
}

#[cfg(any(target_os = "linux", test))]
struct LinuxLease {
    cgroup: PathBuf,
    gate: PathBuf,
    ready: PathBuf,
    release: PathBuf,
}

#[cfg(any(target_os = "linux", test))]
impl LinuxLease {
    fn new(cgroup: PathBuf) -> Result<Self, String> {
        let mut random = [0_u8; 12];
        getrandom::getrandom(&mut random).map_err(|error| error.to_string())?;
        let nonce = hex::encode(random);
        let gate =
            std::env::temp_dir().join(format!("canopy-pty-gate-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&gate)
            .map_err(|error| format!("create containment gate {}: {error}", gate.display()))?;
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) = std::fs::set_permissions(&gate, std::fs::Permissions::from_mode(0o700))
        {
            let _ = std::fs::remove_dir(&gate);
            return Err(format!("secure containment gate: {error}"));
        }
        Ok(Self {
            ready: gate.join("ready"),
            release: gate.join("release"),
            cgroup,
            gate,
        })
    }

    fn wrap_command(&mut self, helper: &Path, command: &mut CommandBuilder) {
        let original = std::mem::take(command.get_argv_mut());
        let argv = command.get_argv_mut();
        argv.push(helper.as_os_str().to_owned());
        argv.push("--containment-launch".into());
        argv.push(self.cgroup.join("cgroup.procs").into_os_string());
        argv.push(self.ready.as_os_str().to_owned());
        argv.push(self.release.as_os_str().to_owned());
        argv.push("--".into());
        argv.extend(original);
    }

    fn verify_and_release(&mut self, pid: u32) -> Result<(), String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !self.ready.is_file() {
            if std::time::Instant::now() >= deadline {
                return Err("containment launcher did not join its cgroup before timeout".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let actual = unified_cgroup_path(pid)?;
        let actual =
            std::fs::canonicalize(Path::new("/sys/fs/cgroup").join(actual.trim_start_matches('/')))
                .map_err(|error| format!("verify terminal cgroup membership: {error}"))?;
        if actual != self.cgroup {
            return Err(format!(
                "containment launcher joined {}, expected {}",
                actual.display(),
                self.cgroup.display()
            ));
        }
        create_gate_file(&self.release)
    }

    fn write_limit(&self, allowance_bytes: u64) -> Result<(), String> {
        std::fs::write(self.cgroup.join("memory.high"), allowance_bytes.to_string())
            .map_err(|error| format!("set cgroup memory.high: {error}"))
    }

    fn read_limit(&self) -> Result<u64, String> {
        let value = std::fs::read_to_string(self.cgroup.join("memory.high"))
            .map_err(|error| format!("read cgroup memory.high: {error}"))?;
        match value.trim() {
            "max" => Ok(u64::MAX),
            value => value
                .parse::<u64>()
                .map_err(|_| "cgroup memory.high returned an invalid value".to_string()),
        }
    }

    fn read_current(&self) -> Result<u64, String> {
        let value = std::fs::read_to_string(self.cgroup.join("memory.current"))
            .map_err(|error| format!("read cgroup memory.current: {error}"))?;
        value
            .trim()
            .parse::<u64>()
            .map_err(|_| "cgroup memory.current returned an invalid value".to_string())
    }
}

#[cfg(any(target_os = "linux", test))]
impl Drop for LinuxLease {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.ready);
        let _ = std::fs::remove_file(&self.release);
        let _ = std::fs::remove_dir(&self.gate);
        let _ = std::fs::remove_dir(&self.cgroup);
    }
}

#[cfg(any(target_os = "linux", test))]
fn create_gate_file(path: &Path) -> Result<(), String> {
    use std::fs::OpenOptions;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(|_| ())
        .map_err(|error| format!("release containment launcher: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn scratch(name: &str) -> PathBuf {
        let mut random = [0_u8; 8];
        getrandom::getrandom(&mut random).unwrap();
        let path = std::env::temp_dir().join(format!(
            "canopy-containment-test-{name}-{}-{}",
            std::process::id(),
            hex::encode(random)
        ));
        std::fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn unsupported_platform_contract_never_claims_a_hard_limit_or_pause() {
        let capability = ContainmentManager::default().capability();
        assert!(!capability.hard_limit);
        assert!(!capability.pause);
        if capability.enforcement == "monitor_only" {
            assert!(!capability.soft_limit);
            assert!(!capability.dynamic_raise);
        }
    }

    #[test]
    fn monitor_only_prepare_does_not_rewrite_the_command() {
        let manager = ContainmentManager {
            #[cfg(target_os = "linux")]
            linux: None,
            #[cfg(target_os = "linux")]
            linux_error: None,
            #[cfg(target_os = "linux")]
            active: AtomicBool::new(false),
            sessions: Mutex::new(HashMap::new()),
        };
        let mut command = CommandBuilder::new("program");
        command.args(["one", "two"]);
        let before = command.get_argv().clone();
        let _prepared = manager.prepare(1, 1024, &mut command).unwrap();
        assert_eq!(command.get_argv(), &before);
    }

    #[cfg(unix)]
    #[test]
    fn gate_wrapper_preserves_original_argv_after_the_control_boundary() {
        let root = scratch("argv");
        let cgroup = root.join("group");
        std::fs::create_dir(&cgroup).unwrap();
        let mut lease = LinuxLease::new(cgroup.clone()).unwrap();
        std::fs::write(cgroup.join("memory.current"), "4096\n").unwrap();
        assert_eq!(lease.read_current().unwrap(), 4096);
        let mut command = CommandBuilder::new("original program");
        command.args(["one", "two words"]);
        lease.wrap_command(Path::new("/installed/canopy-hook"), &mut command);
        let argv = command.get_argv();
        assert_eq!(argv[0], "/installed/canopy-hook");
        assert_eq!(argv[1], "--containment-launch");
        assert_eq!(argv[5], "--");
        assert_eq!(&argv[6..], &["original program", "one", "two words"]);
        std::fs::remove_file(cgroup.join("memory.current")).unwrap();
        drop(lease);
        let _ = std::fs::remove_dir(&cgroup);
        let _ = std::fs::remove_dir(&root);
    }

    #[cfg(unix)]
    #[test]
    fn activation_failure_retains_container_until_child_cleanup_boundary() {
        let root = scratch("activation-failure");
        let cgroup = root.join("group");
        std::fs::create_dir(&cgroup).unwrap();
        let lease = LinuxLease::new(cgroup.clone()).unwrap();
        let gate = lease.gate.clone();
        let failure = ActivationFailure {
            message: "verification failed".into(),
            prepared: PreparedContainment { linux: Some(lease) },
        };
        assert!(cgroup.is_dir());
        assert!(gate.is_dir());
        assert_eq!(failure.cleanup_after_child_exit(), "verification failed");
        assert!(!cgroup.exists());
        assert!(!gate.exists());
        let _ = std::fs::remove_dir(&root);
    }
}
