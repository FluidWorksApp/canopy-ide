//! Platform process-container ownership for terminal sessions.
//!
//! Policy lives in `governor`; this module answers the narrower question:
//! "can this build place the process tree behind a non-destructive, dynamically
//! adjustable OS boundary without a spawn race?" Unsupported or unproven paths
//! stay monitor-only. In particular, this module never sends a memory-pressure
//! stop/kill signal and never configures an OOM-producing hard memory limit.
//! Windows does use KILL_ON_JOB_CLOSE to keep explicit PTY/native-host lifetime
//! cleanup complete; crossing a memory notification threshold never closes it.

#![cfg_attr(all(test, not(target_os = "linux")), allow(dead_code))]

use crate::governor::GovernorCapability;
use portable_pty::CommandBuilder;
use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::sync::atomic::AtomicU64;
#[cfg(any(target_os = "linux", test))]
use std::sync::Arc;
use std::sync::Mutex;

#[cfg(any(target_os = "linux", target_os = "windows", test))]
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(any(target_os = "linux", test))]
const CGROUP_ROOT_ENV: &str = "CANOPY_CGROUP_ROOT";
const DISABLE_CONTAINMENT_ENV: &str = "CANOPY_DISABLE_TERMINAL_CONTAINMENT";

pub struct ContainmentManager {
    disabled: bool,
    #[cfg(target_os = "linux")]
    linux: Option<LinuxBackend>,
    #[cfg(target_os = "linux")]
    linux_error: Option<String>,
    #[cfg(target_os = "linux")]
    active: AtomicBool,
    #[cfg(target_os = "linux")]
    sessions: Mutex<HashMap<u32, LinuxLease>>,
    #[cfg(target_os = "linux")]
    fault: Arc<Mutex<Option<String>>>,
    #[cfg(target_os = "windows")]
    windows: Option<WindowsBackend>,
    #[cfg(target_os = "windows")]
    windows_error: Option<String>,
    #[cfg(target_os = "windows")]
    active: AtomicBool,
    #[cfg(target_os = "windows")]
    sessions: Mutex<HashMap<u32, WindowsLease>>,
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    sessions: Mutex<HashMap<u32, ()>>,
}

impl Default for ContainmentManager {
    fn default() -> Self {
        let disabled = env_flag(std::env::var_os(DISABLE_CONTAINMENT_ENV).as_deref());
        #[cfg(target_os = "linux")]
        {
            let (linux, linux_error) = if disabled {
                (None, None)
            } else {
                match LinuxBackend::discover() {
                    Ok(backend) => (backend, None),
                    Err(error) => (None, Some(error)),
                }
            };
            return Self {
                disabled,
                linux,
                linux_error,
                active: AtomicBool::new(false),
                sessions: Mutex::new(HashMap::new()),
                fault: Arc::new(Mutex::new(None)),
            };
        }
        #[cfg(target_os = "windows")]
        {
            let (windows, windows_error) = if disabled {
                (None, None)
            } else {
                match WindowsBackend::discover() {
                    Ok(backend) => (Some(backend), None),
                    Err(error) => (None, Some(error)),
                }
            };
            return Self {
                disabled,
                windows,
                windows_error,
                active: AtomicBool::new(false),
                sessions: Mutex::new(HashMap::new()),
            };
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        Self {
            disabled,
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

impl ContainmentManager {
    pub fn capability(&self) -> GovernorCapability {
        #[cfg(target_os = "linux")]
        {
            if self.disabled {
                return GovernorCapability::monitor_only(
                    "linux",
                    "resident_set_sum",
                    "terminal containment is disabled by CANOPY_DISABLE_TERMINAL_CONTAINMENT; measurement and governor incidents remain active",
                );
            }
            if let Some(error) = self.fault.lock().unwrap().clone() {
                return GovernorCapability::monitor_only(
                    "linux",
                    "resident_set_sum",
                    &format!("cgroup accounting degraded after a controller fault: {error}"),
                );
            }
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
                "run inside a systemd Delegate=yes user unit or set CANOPY_CGROUP_ROOT to an explicit writable delegated cgroup to enable memory.high"
            });
            return GovernorCapability::monitor_only("linux", "resident_set_sum", detail);
        }
        #[cfg(target_os = "windows")]
        {
            if self.disabled {
                return GovernorCapability::monitor_only(
                    "windows",
                    "working_set_sum",
                    "terminal containment is disabled by CANOPY_DISABLE_TERMINAL_CONTAINMENT; measurement and governor incidents remain active",
                );
            }
            if self.windows.is_some() && self.active.load(Ordering::SeqCst) {
                return GovernorCapability::notification_limit(
                    "windows",
                    "job_committed_memory",
                    "job_object_notification_limit",
                    "future terminal trees pass a launcher gate after verified Job Object assignment; the threshold notifies but does not deny allocation",
                );
            }
            return GovernorCapability::monitor_only(
                "windows",
                "working_set_sum",
                self.windows_error.as_deref().unwrap_or(
                    "Job Object backend is ready; no gated terminal has completed verification yet",
                ),
            );
        }
        #[cfg(target_os = "macos")]
        if self.disabled {
            return GovernorCapability::monitor_only(
                "macos",
                "physical_footprint_sum",
                "terminal containment is disabled by CANOPY_DISABLE_TERMINAL_CONTAINMENT; measurement and governor incidents remain active",
            );
        }
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
        if self.disabled {
            return Ok(PreparedContainment::monitor_only());
        }
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
        #[cfg(target_os = "windows")]
        {
            let Some(backend) = &self.windows else {
                return Ok(PreparedContainment::monitor_only());
            };
            return backend.prepare(id, allowance_bytes, command);
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
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
        #[cfg(target_os = "windows")]
        {
            let Some(mut lease) = prepared.windows else {
                return Ok(());
            };
            let Some(pid) = pid else {
                return Err(ActivationFailure {
                    message: "contained PTY did not expose its root pid".into(),
                    prepared: PreparedContainment {
                        #[cfg(test)]
                        linux: None,
                        windows: Some(lease),
                    },
                });
            };
            if let Err(message) = lease.assign_verify_and_release(pid) {
                return Err(ActivationFailure {
                    message,
                    prepared: PreparedContainment {
                        #[cfg(test)]
                        linux: None,
                        windows: Some(lease),
                    },
                });
            }
            self.sessions.lock().unwrap().insert(id, lease);
            self.active.store(true, Ordering::SeqCst);
            return Ok(());
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
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
        #[cfg(target_os = "windows")]
        {
            let sessions = self.sessions.lock().unwrap();
            let Some(lease) = sessions.get(&id) else {
                return Ok(()); // this particular session is monitor-only
            };
            let old = lease.notification_limit()?;
            if allowance_bytes < old {
                return Err("containment allowance raises must be monotonic".into());
            }
            lease.set_notification_limit(allowance_bytes)
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
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
            match lease.sample() {
                Ok(sample) => return sample.current_bytes,
                Err(error) => {
                    *self.fault.lock().unwrap() = Some(error);
                    return process_tree_fallback;
                }
            }
        }
        #[cfg(target_os = "windows")]
        if let Some(lease) = self.sessions.lock().unwrap().get(&id) {
            return lease.committed_bytes().unwrap_or(process_tree_fallback);
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        let _ = id;
        process_tree_fallback
    }

    /// Forget the OS container after the session exits. Cleanup is best effort:
    /// failure means a descendant escaped the PTY lifetime or the delegate was
    /// revoked, never a reason to kill an unrelated process.
    pub fn release(&self, id: u32) {
        #[cfg(target_os = "linux")]
        if let Some(lease) = self.sessions.lock().unwrap().remove(&id) {
            lease.cleanup_with_retry(Arc::clone(&self.fault));
        }
        #[cfg(target_os = "windows")]
        {
            self.sessions.lock().unwrap().remove(&id);
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        {
            self.sessions.lock().unwrap().remove(&id);
        }
    }
}

fn env_flag(value: Option<&std::ffi::OsStr>) -> bool {
    value.is_some_and(|value| {
        matches!(
            value.to_string_lossy().trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

pub struct PreparedContainment {
    #[cfg(any(target_os = "linux", test))]
    linux: Option<LinuxLease>,
    #[cfg(target_os = "windows")]
    windows: Option<WindowsLease>,
}

impl PreparedContainment {
    fn monitor_only() -> Self {
        Self {
            #[cfg(any(target_os = "linux", test))]
            linux: None,
            #[cfg(target_os = "windows")]
            windows: None,
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

#[cfg(target_os = "windows")]
struct WindowsBackend {
    helper: PathBuf,
}

#[cfg(target_os = "windows")]
impl WindowsBackend {
    fn discover() -> Result<Self, String> {
        let helper = crate::agents::helper_path()?;
        Ok(Self { helper })
    }

    fn prepare(
        &self,
        _id: u32,
        allowance_bytes: u64,
        command: &mut CommandBuilder,
    ) -> Result<PreparedContainment, String> {
        if !self.helper.is_file() {
            return Ok(PreparedContainment::monitor_only());
        }
        let mut lease = match WindowsLease::new(allowance_bytes) {
            Ok(lease) => lease,
            Err(error) => {
                log::warn!("Windows terminal containment unavailable for this spawn: {error}");
                return Ok(PreparedContainment::monitor_only());
            }
        };
        lease.wrap_command(&self.helper, command);
        Ok(PreparedContainment {
            #[cfg(test)]
            linux: None,
            windows: Some(lease),
        })
    }
}

/// A private Job Object plus a launcher gate. The handle is stored as an
/// integer so the manager remains Send + Sync without asserting anything about
/// the generated HANDLE wrapper; every API call reconstructs it transiently.
#[cfg(target_os = "windows")]
struct WindowsLease {
    job: isize,
    gate: PathBuf,
    ready: PathBuf,
    release: PathBuf,
    notification_limit_bytes: AtomicU64,
}

#[cfg(target_os = "windows")]
impl WindowsLease {
    fn new(allowance_bytes: u64) -> Result<Self, String> {
        use windows::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let handle = unsafe { CreateJobObjectW(None, windows::core::PCWSTR::null()) }
            .map_err(|error| format!("create terminal Job Object: {error}"))?;
        let job = handle.0 as isize;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if let Err(error) = configured {
            let _ = unsafe { windows::Win32::Foundation::CloseHandle(handle) };
            return Err(format!("configure terminal Job Object lifecycle: {error}"));
        }
        let (gate, ready, release) = match create_private_gate() {
            Ok(gate) => gate,
            Err(error) => {
                let _ = unsafe { windows::Win32::Foundation::CloseHandle(handle) };
                return Err(error);
            }
        };
        let lease = Self {
            job,
            gate,
            ready,
            release,
            notification_limit_bytes: AtomicU64::new(allowance_bytes),
        };
        if let Err(error) = lease.set_notification_limit(allowance_bytes) {
            drop(lease);
            return Err(error);
        }
        Ok(lease)
    }

    fn handle(&self) -> windows::Win32::Foundation::HANDLE {
        windows::Win32::Foundation::HANDLE(self.job as *mut std::ffi::c_void)
    }

    fn wrap_command(&mut self, helper: &Path, command: &mut CommandBuilder) {
        let original = std::mem::take(command.get_argv_mut());
        let argv = command.get_argv_mut();
        argv.push(helper.as_os_str().to_owned());
        argv.push("--containment-launch".into());
        argv.push("windows-job".into());
        argv.push(self.ready.as_os_str().to_owned());
        argv.push(self.release.as_os_str().to_owned());
        argv.push("--".into());
        argv.extend(original);
    }

    fn assign_verify_and_release(&mut self, pid: u32) -> Result<(), String> {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::JobObjects::{AssignProcessToJobObject, IsProcessInJob};
        use windows::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };
        wait_for_ready(&self.ready)?;
        let access = PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION;
        let process = unsafe { OpenProcess(access, false, pid) }
            .map_err(|error| format!("open gated terminal process {pid}: {error}"))?;
        let assigned = unsafe { AssignProcessToJobObject(self.handle(), process) };
        if let Err(error) = assigned {
            let _ = unsafe { CloseHandle(process) };
            return Err(format!("assign terminal {pid} to Job Object: {error}"));
        }
        let mut in_job = windows_core::BOOL::default();
        let verified = unsafe { IsProcessInJob(process, Some(self.handle()), &mut in_job) };
        let _ = unsafe { CloseHandle(process) };
        verified.map_err(|error| format!("verify terminal Job Object membership: {error}"))?;
        if !in_job.as_bool() {
            return Err("Windows reported a successful assignment but membership is false".into());
        }
        create_gate_file(&self.release)
    }

    fn set_notification_limit(&self, allowance_bytes: u64) -> Result<(), String> {
        use windows::Win32::System::JobObjects::{
            JobObjectNotificationLimitInformation, SetInformationJobObject,
            JOBOBJECT_NOTIFICATION_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_JOB_MEMORY,
        };
        let mut info = JOBOBJECT_NOTIFICATION_LIMIT_INFORMATION::default();
        info.JobMemoryLimit = allowance_bytes;
        info.LimitFlags = JOB_OBJECT_LIMIT_JOB_MEMORY;
        unsafe {
            SetInformationJobObject(
                self.handle(),
                JobObjectNotificationLimitInformation,
                (&info as *const JOBOBJECT_NOTIFICATION_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_NOTIFICATION_LIMIT_INFORMATION>() as u32,
            )
        }
        .map_err(|error| format!("set Job Object memory notification limit: {error}"))?;
        self.notification_limit_bytes
            .store(allowance_bytes, Ordering::SeqCst);
        Ok(())
    }

    fn notification_limit(&self) -> Result<u64, String> {
        Ok(self.notification_limit_bytes.load(Ordering::SeqCst))
    }

    fn committed_bytes(&self) -> Result<u64, String> {
        use windows::Win32::System::JobObjects::{
            JobObjectLimitViolationInformation, QueryInformationJobObject,
            JOBOBJECT_LIMIT_VIOLATION_INFORMATION,
        };
        let mut info = JOBOBJECT_LIMIT_VIOLATION_INFORMATION::default();
        unsafe {
            QueryInformationJobObject(
                Some(self.handle()),
                JobObjectLimitViolationInformation,
                (&mut info as *mut JOBOBJECT_LIMIT_VIOLATION_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_LIMIT_VIOLATION_INFORMATION>() as u32,
                None,
            )
        }
        .map_err(|error| format!("query Job Object committed memory: {error}"))?;
        Ok(info.JobMemory)
    }
}

#[cfg(target_os = "windows")]
impl Drop for WindowsLease {
    fn drop(&mut self) {
        cleanup_gate(&self.gate, &self.ready, &self.release);
        let handle = self.handle();
        let _ = unsafe { windows::Win32::Foundation::CloseHandle(handle) };
        self.job = 0;
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
        let explicit = std::env::var_os(CGROUP_ROOT_ENV);
        let root = if let Some(configured) = explicit.as_ref() {
            let root = validate_delegated_root(Path::new(configured))?;
            probe_writable_delegation(&root)?;
            root
        } else if std::env::var_os("INVOCATION_ID").is_some() {
            // systemd sets INVOCATION_ID for service/scope processes. A unit
            // with Delegate=yes exposes the current cgroup as the writable
            // subtree root; validate every property before opting in. A normal
            // non-delegated unit simply stays monitor-only.
            let mount = PathBuf::from("/sys/fs/cgroup");
            let self_group = unified_cgroup_path(std::process::id())?;
            let candidate = mount.join(self_group.trim_start_matches('/'));
            match validate_delegated_root(&candidate)
                .and_then(|root| probe_writable_delegation(&root).map(|()| root))
            {
                Ok(root) => root,
                Err(_) => return Ok(None),
            }
        } else {
            return Ok(None);
        };
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
fn probe_writable_delegation(root: &Path) -> Result<(), String> {
    let mut random = [0_u8; 8];
    getrandom::getrandom(&mut random).map_err(|error| error.to_string())?;
    let probe = root.join(format!(
        ".canopy-delegation-probe-{}-{}",
        std::process::id(),
        hex::encode(random)
    ));
    std::fs::create_dir(&probe).map_err(|error| {
        format!(
            "delegated cgroup is not writable at {}: {error}",
            root.display()
        )
    })?;
    std::fs::remove_dir(&probe)
        .map_err(|error| format!("remove delegated cgroup write probe: {error}"))
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
        let (gate, ready, release) = create_private_gate()?;
        Ok(Self {
            ready,
            release,
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
        wait_for_ready(&self.ready)?;
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

    fn sample(&self) -> Result<LinuxSample, String> {
        Ok(LinuxSample {
            current_bytes: self.read_current()?,
            events: LinuxEvents::read(&self.cgroup.join("memory.events"))?,
        })
    }

    fn cleanup_with_retry(self, fault: Arc<Mutex<Option<String>>>) {
        std::thread::spawn(move || {
            cleanup_gate(&self.gate, &self.ready, &self.release);
            let mut last = None;
            for _ in 0..20 {
                match std::fs::remove_dir(&self.cgroup) {
                    Ok(()) => return,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
                    Err(error) => last = Some(error),
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            if let Some(error) = last {
                *fault.lock().unwrap() = Some(format!(
                    "remove terminal cgroup {} after child exit: {error}",
                    self.cgroup.display()
                ));
            }
        });
    }
}

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct LinuxEvents {
    low: u64,
    high: u64,
    max: u64,
    oom: u64,
    oom_kill: u64,
}

#[cfg(any(target_os = "linux", test))]
impl LinuxEvents {
    fn read(path: &Path) -> Result<Self, String> {
        let body = std::fs::read_to_string(path)
            .map_err(|error| format!("read cgroup memory.events: {error}"))?;
        Self::parse(&body)
    }

    fn parse(body: &str) -> Result<Self, String> {
        let mut events = Self::default();
        for line in body.lines() {
            let Some((name, value)) = line.split_once(' ') else {
                continue;
            };
            let value = value
                .trim()
                .parse::<u64>()
                .map_err(|_| format!("cgroup memory.events has invalid {name} count"))?;
            match name {
                "low" => events.low = value,
                "high" => events.high = value,
                "max" => events.max = value,
                "oom" => events.oom = value,
                "oom_kill" => events.oom_kill = value,
                _ => {}
            }
        }
        Ok(events)
    }
}

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LinuxSample {
    current_bytes: u64,
    #[allow(dead_code)]
    events: LinuxEvents,
}

#[cfg(any(target_os = "linux", test))]
impl Drop for LinuxLease {
    fn drop(&mut self) {
        cleanup_gate(&self.gate, &self.ready, &self.release);
        let _ = std::fs::remove_dir(&self.cgroup);
    }
}

#[cfg(any(target_os = "linux", target_os = "windows", test))]
fn create_private_gate() -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let mut random = [0_u8; 12];
    getrandom::getrandom(&mut random).map_err(|error| error.to_string())?;
    let nonce = hex::encode(random);
    let gate = std::env::temp_dir().join(format!("canopy-pty-gate-{}-{nonce}", std::process::id()));
    std::fs::create_dir(&gate)
        .map_err(|error| format!("create containment gate {}: {error}", gate.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) = std::fs::set_permissions(&gate, std::fs::Permissions::from_mode(0o700))
        {
            let _ = std::fs::remove_dir(&gate);
            return Err(format!("secure containment gate: {error}"));
        }
    }
    Ok((gate.clone(), gate.join("ready"), gate.join("release")))
}

#[cfg(any(target_os = "linux", target_os = "windows", test))]
fn wait_for_ready(ready: &Path) -> Result<(), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !ready.is_file() {
        if std::time::Instant::now() >= deadline {
            return Err("containment launcher did not reach its spawn gate before timeout".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "windows", test))]
fn cleanup_gate(gate: &Path, ready: &Path, release: &Path) {
    let _ = std::fs::remove_file(ready);
    let _ = std::fs::remove_file(release);
    let _ = std::fs::remove_dir(gate);
}

#[cfg(any(target_os = "linux", target_os = "windows", test))]
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
            disabled: false,
            #[cfg(target_os = "linux")]
            linux: None,
            #[cfg(target_os = "linux")]
            linux_error: None,
            #[cfg(target_os = "linux")]
            active: AtomicBool::new(false),
            #[cfg(target_os = "linux")]
            fault: Arc::new(Mutex::new(None)),
            #[cfg(target_os = "windows")]
            windows: None,
            #[cfg(target_os = "windows")]
            windows_error: None,
            #[cfg(target_os = "windows")]
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
        std::fs::write(
            cgroup.join("memory.events"),
            "low 0\nhigh 7\nmax 0\noom 0\noom_kill 0\n",
        )
        .unwrap();
        assert_eq!(lease.read_current().unwrap(), 4096);
        assert_eq!(lease.sample().unwrap().events.high, 7);
        let mut command = CommandBuilder::new("original program");
        command.args(["one", "two words"]);
        lease.wrap_command(Path::new("/installed/canopy-hook"), &mut command);
        let argv = command.get_argv();
        assert_eq!(argv[0], "/installed/canopy-hook");
        assert_eq!(argv[1], "--containment-launch");
        assert_eq!(argv[5], "--");
        assert_eq!(&argv[6..], &["original program", "one", "two words"]);
        std::fs::remove_file(cgroup.join("memory.current")).unwrap();
        std::fs::remove_file(cgroup.join("memory.events")).unwrap();
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

    #[test]
    fn parses_all_memory_event_counters_and_ignores_future_fields() {
        let events =
            LinuxEvents::parse("low 1\nhigh 2\nmax 3\noom 4\noom_kill 5\noom_group_kill 6\n")
                .unwrap();
        assert_eq!(
            events,
            LinuxEvents {
                low: 1,
                high: 2,
                max: 3,
                oom: 4,
                oom_kill: 5,
            }
        );
    }

    #[test]
    fn containment_kill_switch_accepts_only_explicit_truthy_values() {
        assert!(env_flag(Some(std::ffi::OsStr::new("1"))));
        assert!(env_flag(Some(std::ffi::OsStr::new("TRUE"))));
        assert!(env_flag(Some(std::ffi::OsStr::new(" yes "))));
        assert!(!env_flag(None));
        assert!(!env_flag(Some(std::ffi::OsStr::new("0"))));
        assert!(!env_flag(Some(std::ffi::OsStr::new("disabled"))));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_job_notification_limit_and_accounting_are_live() {
        let lease = WindowsLease::new(512 * 1024 * 1024).unwrap();
        assert_eq!(lease.notification_limit().unwrap(), 512 * 1024 * 1024);
        lease.set_notification_limit(1024 * 1024 * 1024).unwrap();
        assert_eq!(lease.notification_limit().unwrap(), 1024 * 1024 * 1024);
        assert_eq!(lease.committed_bytes().unwrap(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn delegation_write_probe_is_removed_immediately() {
        let root = scratch("delegation-probe");
        probe_writable_delegation(&root).unwrap();
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        std::fs::remove_dir(root).unwrap();
    }
}
