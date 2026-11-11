//! Windows platform layer: the named-pipe transport, ConPTY sessions held in Job
//! Objects, and the detached launch. The protocol and the server core are shared
//! with Unix (`server.rs`, `client.rs`); only what touches the OS lives here.
//!
//! Transport. One per-user pipe name, `\\.\pipe\canopy-pty-host-<user SID>`
//! (`default_pipe_name`). Every instance carries the security descriptor
//! `O:<sid>D:P(A;;GA;;;<sid>)(A;;GA;;;SY)` and `PIPE_REJECT_REMOTE_CLIENTS`, so
//! only the same user (and SYSTEM) can open it, enforced by the kernel at open.
//! The host does not also look the client up by pid: that check could only
//! reject callers the DACL already admitted, and a pid lookup races with pid
//! reuse and fails for elevated peers. The first instance is created with
//! `FILE_FLAG_FIRST_PIPE_INSTANCE`, which is the single-instance lock: a second
//! host fails to bind and exits quietly. The DACL cannot stop another user from
//! creating the (predictable) name first, and the client sends the terminal's
//! environment, tokens included, so the client checks that the pipe's owner is
//! its own SID and opens with `SECURITY_IDENTIFICATION` (a squatter cannot
//! impersonate it).
//!
//! Every pipe handle is overlapped. On a synchronous handle a blocked `ReadFile`
//! holds the file object's lock and stalls a `WriteFile` from another thread on
//! the same connection, and the attach loop and `HostMaster` both read and write
//! one connection from two threads. Pipes have no half-close: `shutdown` cancels
//! this connection's pending I/O and makes later reads end, so the last clone
//! drops and the handle closes (bytes already written stay readable by the
//! peer; `DisconnectNamedPipe` is never used because it discards them).
//!
//! PTYs. ConPTY driven directly rather than through portable-pty, for three
//! reasons: portable-pty always passes `PSEUDOCONSOLE_INHERIT_CURSOR`, which
//! makes conhost ask the terminal for the cursor position and wait for the
//! answer, and a host session often has no terminal attached; it cannot create
//! the child suspended, so a Job Object could only be assigned after the child
//! had started (and possibly spawned children of its own); and the host has to
//! close the pseudoconsole itself when the child exits, because the output pipe
//! does not reach EOF until it is closed. Each session's process tree lives in
//! its own Job Object with `KILL_ON_JOB_CLOSE`: kill is `TerminateJobObject`, and
//! a host that dies (even by `TerminateProcess`) takes its sessions with it,
//! like a hung-up PTY on Unix. A soft stop (`SIGTERM` on Unix) closes the
//! pseudoconsole, which sends console programs `CTRL_CLOSE_EVENT`.

#![allow(clippy::upper_case_acronyms)]

use crate::protocol::SpawnSpec;
use portable_pty::{Child, ChildKiller, ExitStatus, MasterPty, PtySize};
use std::ffi::{c_void, OsStr, OsString};
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, BOOL, ERROR_ACCESS_DENIED, ERROR_BROKEN_PIPE,
    ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_OPERATION_ABORTED, ERROR_PIPE_BUSY,
    ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE, HANDLE,
    INVALID_HANDLE_VALUE, S_OK, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SDDL_REVISION_1, SE_KERNEL_OBJECT,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenUser, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
    SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED,
    OPEN_EXISTING, PIPE_ACCESS_DUPLEX, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
};
use windows_sys::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
};
use windows_sys::Win32::System::Diagnostics::Debug::{
    SetErrorMode, SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, CreatePipe, WaitNamedPipeW, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows_sys::Win32::System::Threading::{
    CreateEventW, CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess,
    GetExitCodeProcess, InitializeProcThreadAttributeList, OpenProcessToken, ResumeThread,
    TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject, CREATE_BREAKAWAY_FROM_JOB,
    CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, DETACHED_PROCESS,
    EXTENDED_STARTUPINFO_PRESENT, INFINITE, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

const PIPE_BUFFER: u32 = 64 * 1024;
/// How long `PipeStream::connect` waits for a free instance of a busy pipe.
const CONNECT_BUSY_WAIT: Duration = Duration::from_secs(5);
/// Blocking pipe waits wake this often to notice `shutdown`.
const WAKE: Duration = Duration::from_millis(250);
/// Same as portable-pty minus `PSEUDOCONSOLE_INHERIT_CURSOR` (0x1):
/// `PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE`.
const PSEUDOCONSOLE_FLAGS: u32 = 0x2 | 0x4;

fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(Some(0)).collect()
}

fn last_error() -> io::Error {
    io::Error::last_os_error()
}

fn win_error(code: u32) -> io::Error {
    io::Error::from_raw_os_error(code as i32)
}

/// # Safety
/// `handle` must be a valid, owned handle (not null, not INVALID_HANDLE_VALUE).
unsafe fn owned(handle: HANDLE) -> OwnedHandle {
    OwnedHandle::from_raw_handle(handle as RawHandle)
}

fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle() as HANDLE
}

fn new_event() -> io::Result<OwnedHandle> {
    // SAFETY: an unnamed manual-reset event, initially unsignalled.
    let event = unsafe { CreateEventW(null(), 1, 0, null()) };
    if event.is_null() {
        return Err(last_error());
    }
    // SAFETY: just created and owned by us.
    Ok(unsafe { owned(event) })
}

// ---------------------------------------------------------------------------
// Identity and security
// ---------------------------------------------------------------------------

/// # Safety
/// `sid` must point at a valid SID.
unsafe fn sid_string(sid: PSID) -> io::Result<String> {
    let mut text: *mut u16 = null_mut();
    if ConvertSidToStringSidW(sid, &mut text) == 0 {
        return Err(last_error());
    }
    let mut len = 0;
    while *text.add(len) != 0 {
        len += 1;
    }
    let out = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
    LocalFree(text.cast());
    Ok(out)
}

fn query_user_sid() -> io::Result<String> {
    // SAFETY: token query on our own process; the buffer is sized by the first
    // call and 8-byte aligned for TOKEN_USER.
    unsafe {
        let mut token: HANDLE = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(last_error());
        }
        let token = owned(token);
        let mut len = 0u32;
        GetTokenInformation(raw(&token), TokenUser, null_mut(), 0, &mut len);
        if len == 0 {
            return Err(last_error());
        }
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        if GetTokenInformation(
            raw(&token),
            TokenUser,
            buf.as_mut_ptr().cast(),
            len,
            &mut len,
        ) == 0
        {
            return Err(last_error());
        }
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        sid_string(user.User.Sid)
    }
}

/// The current user's SID as a string (`S-1-5-21-...`).
pub fn user_sid() -> io::Result<&'static str> {
    static SID: OnceLock<String> = OnceLock::new();
    if let Some(sid) = SID.get() {
        return Ok(sid);
    }
    let sid = query_user_sid()?;
    Ok(SID.get_or_init(|| sid))
}

/// The per-user pipe name: `\\.\pipe\canopy-pty-host-<SID>`, with `-<tag>`
/// appended when `tag` is non-empty (debug builds use their own).
pub fn default_pipe_name(tag: &str) -> io::Result<PathBuf> {
    let sid = user_sid()?;
    let name = if tag.is_empty() {
        format!(r"\\.\pipe\canopy-pty-host-{sid}")
    } else {
        format!(r"\\.\pipe\canopy-pty-host-{sid}-{tag}")
    };
    Ok(PathBuf::from(name))
}

/// A self-relative security descriptor from SDDL, freed on drop.
struct PipeSecurity {
    descriptor: PSECURITY_DESCRIPTOR,
}

// SAFETY: the descriptor is immutable after creation and only read by the OS.
unsafe impl Send for PipeSecurity {}
unsafe impl Sync for PipeSecurity {}

impl PipeSecurity {
    fn current_user_only() -> io::Result<PipeSecurity> {
        let sid = user_sid()?;
        // Owner is the user (not the Administrators group an elevated token
        // defaults to), so the client's owner check holds when elevated too.
        let sddl = format!("O:{sid}D:P(A;;GA;;;{sid})(A;;GA;;;SY)");
        let sddl = wide(OsStr::new(&sddl));
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: valid nul-terminated SDDL; the result is LocalFree'd on drop.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        };
        if ok == 0 {
            return Err(last_error());
        }
        Ok(PipeSecurity { descriptor })
    }

    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor,
            bInheritHandle: 0,
        }
    }
}

impl Drop for PipeSecurity {
    fn drop(&mut self) {
        // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
        unsafe {
            LocalFree(self.descriptor);
        }
    }
}

/// Refuses a pipe that another user created under our name.
fn verify_owner(handle: &OwnedHandle) -> io::Result<()> {
    // SAFETY: owner query on a handle we hold; the descriptor is freed below and
    // `owner` points into it.
    let owner = unsafe {
        let mut owner: PSID = null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        let rc = GetSecurityInfo(
            raw(handle),
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            null_mut(),
            null_mut(),
            &mut descriptor,
        );
        if rc != 0 {
            return Err(win_error(rc));
        }
        let text = sid_string(owner);
        LocalFree(descriptor);
        text?
    };
    let me = user_sid()?;
    if owner != me {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("the host pipe is owned by {owner}, not the current user {me}"),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Pipe stream
// ---------------------------------------------------------------------------

struct PipeInner {
    handle: OwnedHandle,
    read_timeout: Mutex<Option<Duration>>,
    write_timeout: Mutex<Option<Duration>>,
    shut: AtomicBool,
}

/// One end of a named-pipe connection, with the `UnixStream` methods the host
/// and client use. Clones share the connection, which closes when the last one
/// drops (as with a socket's duplicated descriptors).
pub struct PipeStream {
    inner: Arc<PipeInner>,
}

impl std::fmt::Debug for PipeStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PipeStream").finish_non_exhaustive()
    }
}

impl PipeStream {
    fn from_handle(handle: OwnedHandle) -> PipeStream {
        PipeStream {
            inner: Arc::new(PipeInner {
                handle,
                read_timeout: Mutex::new(None),
                write_timeout: Mutex::new(None),
                shut: AtomicBool::new(false),
            }),
        }
    }

    /// Opens a client connection to the host pipe `name`. Fails with
    /// `NotFound` when no host serves it, and refuses a pipe owned by another
    /// user.
    pub fn connect(name: impl AsRef<Path>) -> io::Result<PipeStream> {
        let name = wide(name.as_ref().as_os_str());
        let deadline = Instant::now() + CONNECT_BUSY_WAIT;
        loop {
            // SAFETY: nul-terminated name; overlapped handle owned below.
            let handle = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                    null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                // SAFETY: a valid handle we now own.
                let handle = unsafe { owned(handle) };
                verify_owner(&handle)?;
                return Ok(PipeStream::from_handle(handle));
            }
            // SAFETY: no preconditions.
            let error = unsafe { GetLastError() };
            if error == ERROR_PIPE_BUSY && Instant::now() < deadline {
                // SAFETY: nul-terminated name.
                unsafe { WaitNamedPipeW(name.as_ptr(), WAKE.as_millis() as u32) };
                continue;
            }
            return Err(win_error(error));
        }
    }

    pub fn try_clone(&self) -> io::Result<PipeStream> {
        Ok(PipeStream {
            inner: Arc::clone(&self.inner),
        })
    }

    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        *self.inner.read_timeout.lock().unwrap() = timeout;
        Ok(())
    }

    pub fn set_write_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        *self.inner.write_timeout.lock().unwrap() = timeout;
        Ok(())
    }

    /// Ends this connection for every clone, whichever half is asked: pending
    /// and later reads return end-of-file and writes fail, so the clones drop
    /// and the handle closes. Already-written bytes stay readable by the peer.
    pub fn shutdown(&self, _how: std::net::Shutdown) -> io::Result<()> {
        self.inner.shut.store(true, Ordering::SeqCst);
        // SAFETY: cancels this process's I/O on our own handle.
        unsafe { CancelIoEx(raw(&self.inner.handle), null()) };
        Ok(())
    }

    fn end(&self, write: bool) -> io::Result<usize> {
        if write {
            Err(io::ErrorKind::BrokenPipe.into())
        } else {
            Ok(0)
        }
    }

    fn io(&self, write: bool, ptr: *mut u8, len: usize) -> io::Result<usize> {
        if len == 0 {
            return Ok(0);
        }
        if self.inner.shut.load(Ordering::SeqCst) {
            return self.end(write);
        }
        let len = len.min(u32::MAX as usize) as u32;
        let timeout = if write {
            *self.inner.write_timeout.lock().unwrap()
        } else {
            *self.inner.read_timeout.lock().unwrap()
        };
        let handle = raw(&self.inner.handle);
        let event = new_event()?;
        // SAFETY: OVERLAPPED is plain data; zero is its documented initial state.
        let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
        ov.hEvent = raw(&event);
        // SAFETY: `ptr`/`len` describe a live buffer, and `ov` and the buffer
        // outlive the operation: every path below waits for it to complete.
        let started = unsafe {
            if write {
                WriteFile(handle, ptr, len, null_mut(), &mut ov)
            } else {
                ReadFile(handle, ptr, len, null_mut(), &mut ov)
            }
        };
        if started == 0 {
            // SAFETY: no preconditions.
            let error = unsafe { GetLastError() };
            if error != ERROR_IO_PENDING {
                return self.finish_error(error, write);
            }
            let deadline = timeout.map(|t| Instant::now() + t);
            loop {
                let slice = deadline
                    .map(|d| d.saturating_duration_since(Instant::now()).min(WAKE))
                    .unwrap_or(WAKE);
                // SAFETY: waiting on our own event.
                let waited = unsafe { WaitForSingleObject(raw(&event), slice.as_millis() as u32) };
                if waited == WAIT_OBJECT_0 {
                    break;
                }
                let timed_out = deadline.is_some_and(|d| Instant::now() >= d);
                let shut = self.inner.shut.load(Ordering::SeqCst);
                if waited == WAIT_TIMEOUT && !timed_out && !shut {
                    continue;
                }
                // Give up on it, but only after it has finished with `ov` and
                // the buffer. Bytes that arrived before the cancel still count.
                let mut done = 0u32;
                // SAFETY: cancel then wait for our own operation.
                let completed = unsafe {
                    CancelIoEx(handle, &ov);
                    GetOverlappedResult(handle, &ov, &mut done, 1)
                };
                if completed != 0 {
                    return Ok(done as usize);
                }
                if timed_out {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "pipe operation timed out",
                    ));
                }
                return self.end(write);
            }
        }
        let mut done = 0u32;
        // SAFETY: the operation has completed (or completes now; bWait = TRUE).
        if unsafe { GetOverlappedResult(handle, &ov, &mut done, 1) } == 0 {
            // SAFETY: no preconditions.
            return self.finish_error(unsafe { GetLastError() }, write);
        }
        Ok(done as usize)
    }

    fn finish_error(&self, error: u32, write: bool) -> io::Result<usize> {
        match error {
            ERROR_BROKEN_PIPE
            | ERROR_PIPE_NOT_CONNECTED
            | ERROR_NO_DATA
            | ERROR_OPERATION_ABORTED => self.end(write),
            other => Err(win_error(other)),
        }
    }
}

impl Read for &PipeStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.io(false, buf.as_mut_ptr(), buf.len())
    }
}

impl Write for &PipeStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.io(true, buf.as_ptr() as *mut u8, buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Read for PipeStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        (&*self).read(buf)
    }
}

impl Write for PipeStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        (&*self).write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Pipe listener
// ---------------------------------------------------------------------------

/// One server instance waiting for a client (overlapped `ConnectNamedPipe`).
struct Pending {
    handle: Option<OwnedHandle>,
    event: OwnedHandle,
    /// Boxed so its address stays put while the connect is outstanding.
    ov: Box<OVERLAPPED>,
    connected: bool,
}

// SAFETY: the raw pointers inside OVERLAPPED are an event handle we own.
unsafe impl Send for Pending {}

impl Pending {
    fn start(handle: OwnedHandle) -> io::Result<Pending> {
        let event = new_event()?;
        // SAFETY: OVERLAPPED is plain data.
        let mut ov: Box<OVERLAPPED> = Box::new(unsafe { std::mem::zeroed() });
        ov.hEvent = raw(&event);
        // SAFETY: overlapped connect on our own instance; `ov` is boxed and
        // outlives the operation (Drop cancels and waits).
        let ok = unsafe { ConnectNamedPipe(raw(&handle), &mut *ov) };
        let connected = if ok != 0 {
            true
        } else {
            // SAFETY: no preconditions.
            match unsafe { GetLastError() } {
                ERROR_IO_PENDING => false,
                ERROR_PIPE_CONNECTED => true,
                other => return Err(win_error(other)),
            }
        };
        Ok(Pending {
            handle: Some(handle),
            event,
            ov,
            connected,
        })
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        if let Some(handle) = &self.handle {
            if !self.connected {
                let mut done = 0u32;
                // SAFETY: cancel and wait out our own connect before `ov` goes.
                unsafe {
                    CancelIoEx(raw(handle), &*self.ov);
                    GetOverlappedResult(raw(handle), &*self.ov, &mut done, 1);
                }
            }
        }
    }
}

fn create_instance(name: &[u16], security: &PipeSecurity, first: bool) -> io::Result<OwnedHandle> {
    let attributes = security.attributes();
    let mut open_mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
    if first {
        open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
    }
    // SAFETY: nul-terminated name and a live security descriptor.
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            open_mode,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            PIPE_BUFFER,
            PIPE_BUFFER,
            0,
            &attributes,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(last_error());
    }
    // SAFETY: a valid handle we now own.
    Ok(unsafe { owned(handle) })
}

/// The host's end of the pipe: always one instance waiting for the next client.
pub struct PipeListener {
    name: Vec<u16>,
    security: PipeSecurity,
    pending: Pending,
}

impl PipeListener {
    /// Creates the first instance of `name`. Fails with `AddrInUse` when the
    /// name already exists (a live host, or someone squatting it).
    pub fn bind(name: impl AsRef<Path>) -> io::Result<PipeListener> {
        let name = wide(name.as_ref().as_os_str());
        let security = PipeSecurity::current_user_only()?;
        let first = create_instance(&name, &security, true).map_err(|e| {
            if e.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) {
                io::Error::new(io::ErrorKind::AddrInUse, "the host pipe already exists")
            } else {
                e
            }
        })?;
        let pending = Pending::start(first)?;
        Ok(PipeListener {
            name,
            security,
            pending,
        })
    }

    /// Waits up to `wait` for a client. The next instance is created before the
    /// connected one is handed over, so the name never disappears in between.
    pub fn accept_timeout(&mut self, wait: Duration) -> io::Result<Option<PipeStream>> {
        if !self.pending.connected {
            // SAFETY: waiting on our own event.
            let waited =
                unsafe { WaitForSingleObject(raw(&self.pending.event), wait.as_millis() as u32) };
            if waited == WAIT_TIMEOUT {
                return Ok(None);
            }
            let handle = raw(self.pending.handle.as_ref().expect("pending instance"));
            let mut done = 0u32;
            // SAFETY: the connect has completed (the event fired).
            if unsafe { GetOverlappedResult(handle, &*self.pending.ov, &mut done, 0) } == 0 {
                let error = last_error();
                // A client that came and went: replace the instance.
                self.pending.connected = true; // nothing outstanding to cancel
                self.pending = Pending::start(create_instance(&self.name, &self.security, false)?)?;
                return Err(error);
            }
            self.pending.connected = true;
        }
        let next = Pending::start(create_instance(&self.name, &self.security, false)?)?;
        let mut done = std::mem::replace(&mut self.pending, next);
        let handle = done.handle.take().expect("connected instance");
        Ok(Some(PipeStream::from_handle(handle)))
    }
}

// ---------------------------------------------------------------------------
// Host process
// ---------------------------------------------------------------------------

fn system_directory() -> Option<PathBuf> {
    let mut buf = [0u16; 260];
    // SAFETY: writes at most `buf.len()` wide chars.
    let len = unsafe { GetSystemDirectoryW(buf.as_mut_ptr(), buf.len() as u32) } as usize;
    (len > 0 && len < buf.len()).then(|| PathBuf::from(String::from_utf16_lossy(&buf[..len])))
}

/// No error dialogs, and leave the launcher's directory: the host lives for days
/// and must not pin a directory (Windows refuses to delete a directory that is a
/// process's working directory).
pub fn harden_process() {
    // SAFETY: process-wide error mode flags.
    unsafe {
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    }
    if let Some(dir) = system_directory() {
        let _ = std::env::set_current_dir(dir);
    }
}

// ---------------------------------------------------------------------------
// Command lines, environment, program lookup
// ---------------------------------------------------------------------------

/// MSVC argv quoting (as portable-pty's `append_quoted`, after ArgvQuote).
fn append_quoted(arg: &OsStr, cmdline: &mut Vec<u16>) {
    let units: Vec<u16> = arg.encode_wide().collect();
    let needs_quotes = units.is_empty()
        || units.iter().any(|&c| {
            c == b' ' as u16
                || c == b'\t' as u16
                || c == b'\n' as u16
                || c == 0x0b
                || c == b'"' as u16
        });
    if !needs_quotes {
        cmdline.extend(units);
        return;
    }
    cmdline.push(b'"' as u16);
    let mut i = 0;
    while i < units.len() {
        let mut backslashes = 0;
        while i < units.len() && units[i] == b'\\' as u16 {
            i += 1;
            backslashes += 1;
        }
        if i == units.len() {
            // Double trailing backslashes so the closing quote stays a quote.
            cmdline.extend(std::iter::repeat(b'\\' as u16).take(backslashes * 2));
            break;
        } else if units[i] == b'"' as u16 {
            cmdline.extend(std::iter::repeat(b'\\' as u16).take(backslashes * 2 + 1));
            cmdline.push(units[i]);
        } else {
            cmdline.extend(std::iter::repeat(b'\\' as u16).take(backslashes));
            cmdline.push(units[i]);
        }
        i += 1;
    }
    cmdline.push(b'"' as u16);
}

fn command_line<S: AsRef<OsStr>>(argv: &[S]) -> io::Result<Vec<u16>> {
    let mut cmdline = Vec::new();
    for (i, arg) in argv.iter().enumerate() {
        let arg = arg.as_ref();
        if arg.encode_wide().any(|c| c == 0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "argument contains a nul",
            ));
        }
        if i > 0 {
            cmdline.push(b' ' as u16);
        }
        append_quoted(arg, &mut cmdline);
    }
    cmdline.push(0);
    Ok(cmdline)
}

fn env_lookup<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
    env.iter()
        .rev()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.as_str())
}

/// `CREATE_UNICODE_ENVIRONMENT` block, sorted case-insensitively by name as
/// Windows expects. Exactly the caller's variables; a later duplicate wins.
fn environment_block(env: &[(String, String)]) -> Vec<u16> {
    let mut vars: Vec<(&str, &str)> = Vec::new();
    for (k, v) in env {
        if let Some(slot) = vars
            .iter_mut()
            .find(|(seen, _)| seen.eq_ignore_ascii_case(k))
        {
            *slot = (k, v);
        } else {
            vars.push((k, v));
        }
    }
    vars.sort_by_key(|(k, _)| k.to_uppercase());
    let mut block = Vec::new();
    for (k, v) in vars {
        block.extend(OsStr::new(k).encode_wide());
        block.push(b'=' as u16);
        block.extend(OsStr::new(v).encode_wide());
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}

/// Finds `program` the way the caller's environment would: as given when it has
/// a directory part, else along the spec's `PATH` with `PATHEXT`. `None` leaves
/// the search to `CreateProcessW` (system directories, then the host's `PATH`).
fn resolve_program(program: &str, env: &[(String, String)], cwd: Option<&Path>) -> Option<PathBuf> {
    let given = Path::new(program);
    if program.contains(['\\', '/', ':']) {
        return Some(match cwd {
            Some(cwd) if given.is_relative() => cwd.join(given),
            _ => given.to_path_buf(),
        });
    }
    let exts = env_lookup(env, "PATHEXT").unwrap_or(".COM;.EXE;.BAT;.CMD");
    let path = env_lookup(env, "PATH")?;
    for dir in std::env::split_paths(OsStr::new(path)) {
        let exact = dir.join(given);
        if given.extension().is_some() && exact.is_file() {
            return Some(exact);
        }
        for ext in exts.split(';').filter(|e| !e.is_empty()) {
            let mut name = OsString::from(program);
            name.push(ext);
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// ConPTY sessions
// ---------------------------------------------------------------------------

struct Console(HPCON);

impl Drop for Console {
    fn drop(&mut self) {
        // SAFETY: created by CreatePseudoConsole and closed exactly once.
        unsafe { ClosePseudoConsole(self.0) };
    }
}

type ConsoleSlot = Arc<Mutex<Option<Console>>>;

/// What the host needs to stop a session's whole tree.
pub(crate) struct Group {
    console: ConsoleSlot,
    job: Arc<OwnedHandle>,
}

impl Group {
    /// Soft stop: close the pseudoconsole (console programs get
    /// `CTRL_CLOSE_EVENT`). Off-thread: closing can wait on conhost, which may
    /// itself wait for a paused reader.
    pub(crate) fn hang_up(&self) {
        let console = self.console.lock().unwrap().take();
        if let Some(console) = console {
            std::thread::spawn(move || drop(console));
        }
    }

    /// Hard stop: every process in the session's job.
    pub(crate) fn kill(&self) {
        // SAFETY: our own job handle.
        unsafe { TerminateJobObject(raw(&self.job), 1) };
    }

    /// The child exited: close the pseudoconsole so its output pipe reaches EOF
    /// (it does not by itself). Runs on the reaper thread before the exit is
    /// recorded, so the console's last output is flushed first; bounded, because
    /// closing waits on conhost, which waits on a reader that backpressure may
    /// have paused.
    pub(crate) fn child_exited(&self) {
        let console = self.console.lock().unwrap().take();
        if let Some(console) = console {
            let (done, closed) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                drop(console);
                let _ = done.send(());
            });
            let _ = closed.recv_timeout(Duration::from_secs(2));
        }
    }
}

struct ConPtyMaster {
    console: ConsoleSlot,
    reader: File,
    writer: Mutex<Option<File>>,
    size: Mutex<PtySize>,
}

impl MasterPty for ConPtyMaster {
    fn resize(&self, size: PtySize) -> anyhow::Result<()> {
        let console = self.console.lock().unwrap();
        let Some(console) = console.as_ref() else {
            anyhow::bail!("the session's console is closed");
        };
        let coord = COORD {
            X: size.cols as i16,
            Y: size.rows as i16,
        };
        // SAFETY: a live pseudoconsole, held under the lock.
        let hr = unsafe { ResizePseudoConsole(console.0, coord) };
        anyhow::ensure!(hr == S_OK, "ResizePseudoConsole failed: HRESULT {hr:#x}");
        *self.size.lock().unwrap() = size;
        Ok(())
    }

    fn get_size(&self) -> anyhow::Result<PtySize> {
        Ok(*self.size.lock().unwrap())
    }

    fn try_clone_reader(&self) -> anyhow::Result<Box<dyn Read + Send>> {
        Ok(Box::new(self.reader.try_clone()?))
    }

    fn take_writer(&self) -> anyhow::Result<Box<dyn Write + Send>> {
        let writer = self.writer.lock().unwrap().take();
        writer
            .map(|w| Box::new(w) as Box<dyn Write + Send>)
            .ok_or_else(|| anyhow::anyhow!("writer already taken"))
    }
}

fn exit_code_now(process: &OwnedHandle) -> Option<u32> {
    // SAFETY: zero-timeout wait and exit-code query on a handle we own.
    unsafe {
        if WaitForSingleObject(raw(process), 0) != WAIT_OBJECT_0 {
            return None;
        }
        let mut code = 0u32;
        (GetExitCodeProcess(raw(process), &mut code) != 0).then_some(code)
    }
}

#[derive(Debug, Clone)]
struct JobKiller(Arc<OwnedHandle>);

impl ChildKiller for JobKiller {
    fn kill(&mut self) -> io::Result<()> {
        // SAFETY: our own job handle.
        if unsafe { TerminateJobObject(raw(&self.0), 1) } == 0 {
            return Err(last_error());
        }
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(self.clone())
    }
}

#[derive(Debug)]
struct ConPtyChild {
    process: OwnedHandle,
    pid: u32,
    killer: JobKiller,
}

impl ChildKiller for ConPtyChild {
    fn kill(&mut self) -> io::Result<()> {
        self.killer.kill()
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        self.killer.clone_killer()
    }
}

impl Child for ConPtyChild {
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        Ok(exit_code_now(&self.process).map(ExitStatus::with_exit_code))
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        // SAFETY: infinite wait on our own process handle.
        unsafe { WaitForSingleObject(raw(&self.process), INFINITE) };
        exit_code_now(&self.process)
            .map(ExitStatus::with_exit_code)
            .ok_or_else(last_error)
    }

    fn process_id(&self) -> Option<u32> {
        Some(self.pid)
    }

    fn as_raw_handle(&self) -> Option<RawHandle> {
        Some(self.process.as_raw_handle())
    }
}

fn anonymous_pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    let mut read: HANDLE = null_mut();
    let mut write: HANDLE = null_mut();
    // SAFETY: non-inheritable pipe (null attributes); both ends owned below.
    if unsafe { CreatePipe(&mut read, &mut write, null(), 0) } == 0 {
        return Err(last_error());
    }
    // SAFETY: both handles were just created.
    Ok(unsafe { (owned(read), owned(write)) })
}

fn kill_on_close_job() -> io::Result<OwnedHandle> {
    // SAFETY: an unnamed job with default security; configured below.
    let job = unsafe { CreateJobObjectW(null(), null()) };
    if job.is_null() {
        return Err(last_error());
    }
    // SAFETY: just created.
    let job = unsafe { owned(job) };
    // SAFETY: plain data, zero is "no limits".
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: the struct and size match the information class.
    let ok = unsafe {
        SetInformationJobObject(
            raw(&job),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if ok == 0 {
        return Err(last_error());
    }
    Ok(job)
}

/// An initialised one-entry attribute list holding the pseudoconsole.
struct AttributeList {
    buf: Vec<u64>,
}

impl AttributeList {
    fn with_console(console: HPCON) -> io::Result<AttributeList> {
        let mut size = 0usize;
        // SAFETY: size query (expected to fail with ERROR_INSUFFICIENT_BUFFER).
        unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size) };
        if size == 0 {
            return Err(last_error());
        }
        let mut list = AttributeList {
            buf: vec![0u64; size.div_ceil(8)],
        };
        // SAFETY: the buffer is at least `size` bytes and 8-byte aligned.
        if unsafe { InitializeProcThreadAttributeList(list.ptr(), 1, 0, &mut size) } == 0 {
            list.buf.clear(); // not initialised: nothing to delete
            return Err(last_error());
        }
        // The pseudoconsole attribute takes the HPCON value itself.
        // SAFETY: initialised list; value and size as documented for ConPTY.
        let ok = unsafe {
            UpdateProcThreadAttribute(
                list.ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                console as *const c_void,
                std::mem::size_of::<HPCON>(),
                null_mut(),
                null(),
            )
        };
        if ok == 0 {
            return Err(last_error());
        }
        Ok(list)
    }

    fn ptr(&mut self) -> *mut c_void {
        self.buf.as_mut_ptr().cast()
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        if !self.buf.is_empty() {
            // SAFETY: initialised by InitializeProcThreadAttributeList.
            unsafe { DeleteProcThreadAttributeList(self.ptr()) };
        }
    }
}

pub(crate) type Started = (
    Box<dyn MasterPty + Send>,
    Box<dyn Child + Send + Sync>,
    Group,
);

/// Starts `spec` on a new pseudoconsole: suspended, placed in its own
/// kill-on-close job, then resumed, so nothing it starts can escape the job.
pub(crate) fn spawn_session(spec: &SpawnSpec, size: PtySize) -> Result<Started, String> {
    spawn_session_io(spec, size).map_err(|e| e.to_string())
}

fn spawn_session_io(spec: &SpawnSpec, size: PtySize) -> io::Result<Started> {
    let program = spec
        .argv
        .first()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "empty argv"))?;
    let (in_read, in_write) = anonymous_pipe()?;
    let (out_read, out_write) = anonymous_pipe()?;
    let mut hpc: HPCON = 0;
    let coord = COORD {
        X: size.cols as i16,
        Y: size.rows as i16,
    };
    // SAFETY: valid pipe ends; conhost duplicates them.
    let hr = unsafe {
        CreatePseudoConsole(
            coord,
            raw(&in_read),
            raw(&out_write),
            PSEUDOCONSOLE_FLAGS,
            &mut hpc,
        )
    };
    if hr != S_OK {
        return Err(io::Error::other(format!(
            "CreatePseudoConsole failed: HRESULT {hr:#x}"
        )));
    }
    let console = Console(hpc);
    // conhost holds its own copies; ours would keep the output pipe from EOF.
    drop(in_read);
    drop(out_write);

    let cwd = spec
        .cwd
        .as_deref()
        .map(Path::new)
        .filter(|p| p.is_dir())
        .map(Path::to_path_buf)
        .or_else(|| {
            env_lookup(&spec.env, "USERPROFILE")
                .map(PathBuf::from)
                .filter(|p| p.is_dir())
        });
    let application = resolve_program(program, &spec.env, cwd.as_deref());
    let mut argv: Vec<OsString> = spec.argv.iter().map(OsString::from).collect();
    if let Some(app) = &application {
        argv[0] = app.clone().into_os_string();
    }
    let mut cmdline = command_line(&argv)?;
    let application = application.map(|p| wide(p.as_os_str()));
    let env = environment_block(&spec.env);
    let cwd = cwd.map(|p| wide(p.as_os_str()));

    let mut attributes = AttributeList::with_console(console.0)?;
    // SAFETY: plain data.
    let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    // No std handles of the host's: the child's console is the pseudoconsole.
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
    si.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
    si.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
    si.lpAttributeList = attributes.ptr();
    // SAFETY: plain data.
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: every pointer is to a live, nul-terminated buffer or null, and no
    // handles are inherited.
    let ok = unsafe {
        CreateProcessW(
            application.as_ref().map_or(null(), |a| a.as_ptr()),
            cmdline.as_mut_ptr(),
            null(),
            null(),
            0,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
            env.as_ptr().cast(),
            cwd.as_ref().map_or(null(), |c| c.as_ptr()),
            &si.StartupInfo as *const STARTUPINFOW,
            &mut pi,
        )
    };
    if ok == 0 {
        let error = last_error();
        return Err(io::Error::new(
            error.kind(),
            format!("CreateProcessW {program:?}: {error}"),
        ));
    }
    drop(attributes);
    // SAFETY: both handles were just returned to us.
    let (process, thread) = unsafe { (owned(pi.hProcess), owned(pi.hThread)) };
    let fail = |error: io::Error| {
        // SAFETY: still suspended; terminate the process we created.
        unsafe { TerminateProcess(raw(&process), 1) };
        error
    };
    let job = kill_on_close_job().map_err(fail)?;
    // SAFETY: both handles are ours.
    if unsafe { AssignProcessToJobObject(raw(&job), raw(&process)) } == 0 {
        return Err(fail(last_error()));
    }
    // SAFETY: the primary thread of the suspended child.
    if unsafe { ResumeThread(raw(&thread)) } == u32::MAX {
        return Err(fail(last_error()));
    }
    drop(thread);

    let console: ConsoleSlot = Arc::new(Mutex::new(Some(console)));
    let job = Arc::new(job);
    let master = ConPtyMaster {
        console: Arc::clone(&console),
        reader: File::from(out_read),
        writer: Mutex::new(Some(File::from(in_write))),
        size: Mutex::new(size),
    };
    let child = ConPtyChild {
        process,
        pid: pi.dwProcessId,
        killer: JobKiller(Arc::clone(&job)),
    };
    Ok((Box::new(master), Box::new(child), Group { console, job }))
}

// ---------------------------------------------------------------------------
// Detached launch (client side)
// ---------------------------------------------------------------------------

/// Starts the host so it outlives the launching app: no console, its own process
/// group, out of the launcher's job when the job allows it, no inherited
/// handles (a host holding the launcher's stdout pipe would keep it open for
/// days), and the system directory as its working directory.
pub(crate) fn launch_detached(exe: &Path, args: &[OsString]) -> io::Result<OwnedHandle> {
    let mut argv: Vec<OsString> = vec![exe.as_os_str().to_owned()];
    argv.extend(args.iter().cloned());
    let application = wide(exe.as_os_str());
    let cwd = system_directory().map(|d| wide(d.as_os_str()));
    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT;
    let mut last = None;
    for flags in [base | CREATE_BREAKAWAY_FROM_JOB, base] {
        let mut cmdline = command_line(&argv)?;
        // SAFETY: plain data.
        let mut si: STARTUPINFOW = unsafe { std::mem::zeroed() };
        si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        // SAFETY: plain data.
        let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: live nul-terminated buffers; bInheritHandles is FALSE.
        let ok: BOOL = unsafe {
            CreateProcessW(
                application.as_ptr(),
                cmdline.as_mut_ptr(),
                null(),
                null(),
                0,
                flags,
                null(),
                cwd.as_ref().map_or(null(), |c| c.as_ptr()),
                &si,
                &mut pi,
            )
        };
        if ok != 0 {
            // SAFETY: both handles were just returned to us.
            unsafe { CloseHandle(pi.hThread) };
            return Ok(unsafe { owned(pi.hProcess) });
        }
        let error = last_error();
        // A job that does not allow breakaway refuses the flag; the host then
        // lives as long as that job does.
        let retry = error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32);
        last = Some(error);
        if !retry {
            break;
        }
    }
    Err(last.unwrap_or_else(|| io::Error::other("CreateProcessW failed")))
}

/// The process's exit code if it has exited.
pub(crate) fn exited(process: &OwnedHandle) -> Option<u32> {
    exit_code_now(process)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quoted(args: &[&str]) -> String {
        let line = command_line(args).unwrap();
        String::from_utf16(&line[..line.len() - 1]).unwrap()
    }

    #[test]
    fn command_lines_follow_msvc_quoting() {
        assert_eq!(quoted(&["a", "b c", ""]), r#"a "b c" """#);
        assert_eq!(quoted(&["x", r#"say "hi""#]), r#"x "say \"hi\"""#);
        assert_eq!(
            quoted(&["x", r"C:\dir with space\"]),
            r#"x "C:\dir with space\\""#
        );
        assert_eq!(quoted(&["x", r"C:\plain\"]), r"x C:\plain\");
    }

    #[test]
    fn environment_block_is_sorted_terminated_and_deduplicated() {
        let env = vec![
            ("b".to_string(), "2".to_string()),
            ("A".to_string(), "1".to_string()),
            ("B".to_string(), "3".to_string()),
        ];
        let block = environment_block(&env);
        let text = String::from_utf16(&block).unwrap();
        assert_eq!(text, "A=1\0B=3\0\0");
        assert_eq!(environment_block(&[]), vec![0, 0]);
    }

    #[test]
    fn the_default_pipe_name_carries_the_user_sid() {
        let name = default_pipe_name("dev").unwrap();
        let name = name.to_string_lossy();
        assert!(name.starts_with(r"\\.\pipe\canopy-pty-host-S-1-"), "{name}");
        assert!(name.ends_with("-dev"), "{name}");
    }

    #[test]
    fn a_second_listener_on_one_name_is_refused() {
        let name = format!(r"\\.\pipe\cph-unit-{}", std::process::id());
        let _first = PipeListener::bind(&name).unwrap();
        let second = PipeListener::bind(&name).err().expect("second bind");
        assert_eq!(second.kind(), io::ErrorKind::AddrInUse);
    }

    #[test]
    fn a_pipe_connection_reads_and_writes_from_two_threads_at_once() {
        // On a synchronous handle a pending read would block this write.
        let name = format!(r"\\.\pipe\cph-duplex-{}", std::process::id());
        let mut listener = PipeListener::bind(&name).unwrap();
        let client = PipeStream::connect(&name).unwrap();
        let server = loop {
            if let Some(s) = listener.accept_timeout(Duration::from_millis(100)).unwrap() {
                break s;
            }
        };
        let reader = client.try_clone().unwrap();
        let blocked = std::thread::spawn(move || {
            let mut buf = [0u8; 5];
            (&reader).read_exact(&mut buf).map(|_| buf)
        });
        std::thread::sleep(Duration::from_millis(200));
        // The client writes while its own read is pending.
        (&client).write_all(b"ping").unwrap();
        let mut got = [0u8; 4];
        (&server).read_exact(&mut got).unwrap();
        assert_eq!(&got, b"ping");
        (&server).write_all(b"pong!").unwrap();
        assert_eq!(&blocked.join().unwrap().unwrap(), b"pong!");
        // A read timeout surfaces as an error, not a hang.
        client
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        let mut one = [0u8; 1];
        assert!((&client).read(&mut one).is_err());
        // Shutdown ends the peer's reads after the bytes already sent.
        (&server).write_all(b"z").unwrap();
        server.shutdown(std::net::Shutdown::Write).unwrap();
        drop(server);
        client.set_read_timeout(None).unwrap();
        let mut rest = Vec::new();
        (&client).read_to_end(&mut rest).unwrap();
        assert_eq!(rest, b"z");
    }
}
