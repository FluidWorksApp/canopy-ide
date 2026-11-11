//! The local transport: a unix socket where the operating system proves who
//! the peer is (SO_PEERCRED on Linux, getpeereid on macOS and the BSDs). This is
//! the reference implementation of the contract and the test double for the
//! network transports. It stays its own transport: it never goes through the
//! device allowlist, because its trust is "same user on this machine".
//!
//! Windows: a named pipe transport is the planned counterpart, with the peer
//! checked through `GetNamedPipeClientProcessId` plus the process token's user
//! SID, and a pipe ACL limited to the current user. It is not implemented here;
//! this module is `cfg(unix)` and Windows builds simply do not have it.
//!
//! Both ends check the uid: the server refuses a client of another user, and
//! the client refuses a socket owned by another user (a rogue process cannot
//! pose as the host by binding the path first).

use crate::{Connection, FailedHalf, PeerIdentity, Refusal, Transport, TIMEOUT_KIND};
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// Serialises the umask change in `bind`, so two binds never restore each
/// other's value.
static UMASK_LOCK: Mutex<()> = Mutex::new(());

/// The decision, pure so it can be tested without a second user: only the same
/// effective uid is served.
pub fn uid_allowed(peer_uid: u32, our_uid: u32) -> bool {
    peer_uid == our_uid
}

pub fn current_uid() -> u32 {
    // SAFETY: geteuid(2) has no preconditions and cannot fail.
    unsafe { libc::geteuid() as u32 }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: `cred` and `len` are valid for the call and sized for ucred.
    let r = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut libc::ucred as *mut libc::c_void,
            &mut len,
        )
    };
    if r != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(cred.uid as u32)
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    // SAFETY: both out-pointers are valid for the call.
    let r = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    if r != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(uid as u32)
}

pub struct LocalUnix {
    listener: Option<UnixListener>,
    /// The socket path and the (device, inode) it had when bound, so `Drop`
    /// never unlinks a file someone else put there since.
    path: Option<(PathBuf, (u64, u64))>,
}

fn dev_ino(path: &Path) -> io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::symlink_metadata(path)?;
    Ok((m.dev(), m.ino()))
}

impl LocalUnix {
    /// Listen on `path` (mode 0600). The path must be short: macOS limits a
    /// socket path to about 104 bytes.
    ///
    /// The socket file is created under a umask of 0o177, so it never exists
    /// with a wider mode, not even for an instant. The umask is process wide:
    /// a file another thread creates during the few microseconds of the bind
    /// gets a stricter mode than usual, which is harmless. The previous umask
    /// is restored before returning, and binds in this crate are serialised.
    pub fn bind(path: &Path) -> io::Result<Self> {
        let listener = {
            let _serial = UMASK_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            // SAFETY: umask(2) has no preconditions and cannot fail.
            let previous = unsafe { libc::umask(0o177) };
            let bound = UnixListener::bind(path);
            // SAFETY: as above; restores the value read just before.
            unsafe { libc::umask(previous) };
            bound?
        };
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        let id = dev_ino(path)?;
        Ok(Self {
            listener: Some(listener),
            path: Some((path.to_path_buf(), id)),
        })
    }

    /// A dial-only transport.
    pub fn client() -> Self {
        Self {
            listener: None,
            path: None,
        }
    }
}

impl Drop for LocalUnix {
    fn drop(&mut self) {
        if let Some((p, id)) = &self.path {
            // Only our own socket: a replaced path is left alone.
            if dev_ino(p).ok().as_ref() == Some(id) {
                let _ = std::fs::remove_file(p);
            }
        }
    }
}

impl Transport for LocalUnix {
    /// `address` is the socket path.
    fn connect(&self, address: &str) -> io::Result<Box<dyn Connection>> {
        let stream = UnixStream::connect(address)?;
        let uid = peer_uid(&stream)?;
        if !uid_allowed(uid, current_uid()) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "socket is owned by another user",
            ));
        }
        Ok(Box::new(UnixConn::new(stream, uid)))
    }

    fn accept(&self) -> io::Result<Result<Box<dyn Connection>, Refusal>> {
        let listener = self.listener.as_ref().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::Unsupported,
                "dial-only transport cannot accept",
            )
        })?;
        let (stream, _) = listener.accept()?;
        let uid = peer_uid(&stream)?;
        if !uid_allowed(uid, current_uid()) {
            // No bytes are read or written: the stream is dropped.
            return Ok(Err(Refusal::UnknownPeer));
        }
        Ok(Ok(Box::new(UnixConn::new(stream, uid))))
    }
}

struct UnixConn {
    stream: UnixStream,
    peer: PeerIdentity,
}

impl UnixConn {
    fn new(stream: UnixStream, uid: u32) -> Self {
        Self {
            stream,
            peer: PeerIdentity::LocalUser(uid),
        }
    }
}

impl Connection for UnixConn {
    fn peer(&self) -> &PeerIdentity {
        &self.peer
    }

    fn set_read_deadline(&mut self, deadline: Option<Duration>) -> io::Result<()> {
        // A zero timeout is an error for the OS call; the shortest real bound.
        let d = deadline.map(|d| d.max(Duration::from_millis(1)));
        self.stream.set_read_timeout(d)
    }

    fn split(self: Box<Self>) -> (Box<dyn Read + Send>, Box<dyn Write + Send>) {
        // try_clone dups the descriptor; the read timeout is a property of the
        // shared socket, so a deadline set before the split still applies. If
        // the dup fails (out of descriptors) both halves report that error.
        let UnixConn { stream, .. } = *self;
        match stream.try_clone() {
            Ok(read) => (Box::new(ReadHalf(read)), Box::new(WriteHalf(stream))),
            Err(e) => {
                let kind = e.kind();
                (Box::new(FailedHalf(kind)), Box::new(FailedHalf(kind)))
            }
        }
    }
}

struct ReadHalf(UnixStream);

impl Read for ReadHalf {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf).map_err(|e| {
            if e.kind() == io::ErrorKind::WouldBlock {
                io::Error::new(TIMEOUT_KIND, "read deadline")
            } else {
                e
            }
        })
    }
}

struct WriteHalf(UnixStream);

impl Write for WriteHalf {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

impl Drop for WriteHalf {
    /// Closing the write half is EOF for the peer's reader.
    fn drop(&mut self) {
        let _ = self.0.shutdown(Shutdown::Write);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::watchdog;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    fn sock_path() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        std::env::temp_dir().join(format!(
            "ctn-{}-{}.sock",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn drop_never_unlinks_a_file_that_replaced_the_socket() {
        let path = sock_path();
        let moved = path.with_extension("moved");
        let server = LocalUnix::bind(&path).unwrap();
        // Move our socket aside (keeping its inode alive) and put an impostor
        // at the path, so the two inodes differ.
        std::fs::rename(&path, &moved).unwrap();
        std::fs::write(&path, b"not ours").unwrap();
        drop(server);
        assert_eq!(std::fs::read(&path).unwrap(), b"not ours");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&moved);
    }

    #[test]
    fn the_bound_socket_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let path = sock_path();
        let server = LocalUnix::bind(&path).unwrap();
        let mode = std::fs::symlink_metadata(&path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
        drop(server);
    }

    #[test]
    fn drop_unlinks_its_own_socket() {
        let path = sock_path();
        let server = LocalUnix::bind(&path).unwrap();
        assert!(path.exists());
        drop(server);
        assert!(!path.exists());
    }

    #[test]
    fn only_the_same_uid_is_allowed() {
        assert!(uid_allowed(501, 501));
        assert!(!uid_allowed(0, 501));
        assert!(!uid_allowed(502, 501));
    }

    #[test]
    fn echo_with_local_user_identity() {
        watchdog(20, || {
            let path = sock_path();
            let server = Arc::new(LocalUnix::bind(&path).unwrap());
            let s = server.clone();
            let t = std::thread::spawn(move || {
                let conn = s.accept().unwrap().unwrap();
                assert_eq!(conn.peer(), &PeerIdentity::LocalUser(current_uid()));
                let (mut r, mut w) = conn.split();
                let mut buf = [0u8; 5];
                r.read_exact(&mut buf).unwrap();
                w.write_all(&buf).unwrap();
            });
            let client = LocalUnix::client();
            let conn = client.connect(path.to_str().unwrap()).unwrap();
            assert_eq!(conn.peer(), &PeerIdentity::LocalUser(current_uid()));
            let (mut r, mut w) = conn.split();
            w.write_all(b"hello").unwrap();
            let mut out = [0u8; 5];
            r.read_exact(&mut out).unwrap();
            assert_eq!(&out, b"hello");
            t.join().unwrap();
        });
    }

    #[test]
    fn deadline_times_out_and_survives_split() {
        watchdog(20, || {
            let path = sock_path();
            let server = Arc::new(LocalUnix::bind(&path).unwrap());
            let s = server.clone();
            let t = std::thread::spawn(move || {
                let conn = s.accept().unwrap().unwrap();
                let (mut r, mut w) = conn.split();
                // Stay silent until the client says it saw the timeout.
                let mut b = [0u8; 1];
                r.read_exact(&mut b).unwrap();
                w.write_all(b"late").unwrap();
            });
            let mut conn = LocalUnix::client().connect(path.to_str().unwrap()).unwrap();
            conn.set_read_deadline(Some(Duration::from_millis(150)))
                .unwrap();
            let (mut r, mut w) = conn.split();
            let mut buf = [0u8; 4];
            let err = r.read(&mut buf).unwrap_err();
            assert_eq!(err.kind(), TIMEOUT_KIND);
            // No bytes were lost: data sent after the timeout still arrives.
            w.write_all(b"x").unwrap();
            r.read_exact(&mut buf).unwrap();
            assert_eq!(&buf, b"late");
            t.join().unwrap();
        });
    }

    #[test]
    fn dropping_the_write_half_is_eof() {
        watchdog(20, || {
            let path = sock_path();
            let server = Arc::new(LocalUnix::bind(&path).unwrap());
            let s = server.clone();
            let t = std::thread::spawn(move || {
                let conn = s.accept().unwrap().unwrap();
                let (mut r, _w) = conn.split();
                let mut v = Vec::new();
                r.read_to_end(&mut v).unwrap();
                v
            });
            let conn = LocalUnix::client().connect(path.to_str().unwrap()).unwrap();
            let (_r, mut w) = conn.split();
            w.write_all(b"bye").unwrap();
            drop(w);
            assert_eq!(t.join().unwrap(), b"bye");
        });
    }
}
