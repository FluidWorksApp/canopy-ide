//! The context bridge at a stable address, for terminals that outlive the app.
//!
//! The bridge's TCP port is ephemeral, so an agent left running in the PTY host
//! (`CANOPY_PTY_HOST=1`) keeps a port that is dead, or someone else's, after a
//! relaunch. With the host on, the bridge also listens on a Unix socket at a
//! fixed path beside the host's own socket, and terminals get
//! `CANOPY_CTX_SOCKET`. `canopy-hook` prefers the socket and reads its
//! environment on every call, so the next launch answers the same agent.
//!
//! Who may call is unchanged: the directory is 0700 and owned by us, the socket
//! is 0600, a connection from another uid is dropped, and every request still
//! needs the same bearer credential as the TCP listener. There is never a TCP
//! fallback to the old port: after a relaunch it can belong to anything.
//!
//! One app per directory holds the socket: an exclusive `flock` on `ctx.lock`,
//! held for as long as the listener lives and released by the kernel when the
//! process dies. An instance that cannot take it (a second debug app sharing
//! `pty-host-dev`) serves TCP only, exports no socket, and never unlinks a
//! socket it does not hold the lock for.

use std::fs::File;
use std::io;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};

pub const SOCKET_NAME: &str = "ctx.sock";
const LOCK_NAME: &str = "ctx.lock";

/// `sun_path` is 104 bytes on macOS and 108 on Linux, including the NUL.
const MAX_SOCKET_PATH: usize = 100;

/// A bound socket and the lock that makes it ours. Dropping it releases the
/// lock and leaves the file: the next owner removes a stale one before binding,
/// and removing it here could race a new owner that already rebound it.
pub struct Owned {
    pub listener: UnixListener,
    pub path: PathBuf,
    _lock: File,
}

/// Take the socket in `dir`, or `Ok(None)` if another live instance holds it.
pub fn claim(dir: &Path) -> io::Result<Option<Owned>> {
    private_dir(dir)?;
    let path = dir.join(SOCKET_NAME);
    if path.as_os_str().len() > MAX_SOCKET_PATH {
        return Err(io::Error::other(format!(
            "socket path too long for a Unix socket: {}",
            path.display()
        )));
    }
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .open(dir.join(LOCK_NAME))?;
    // SAFETY: flock on a descriptor we own; the kernel drops it with the fd.
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let error = io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(code) if code == libc::EWOULDBLOCK => Ok(None),
            _ => Err(error),
        };
    }
    // Ours now. Whatever is at the path was left by an owner that is gone.
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let listener = UnixListener::bind(&path)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    Ok(Some(Owned {
        listener,
        path,
        _lock: lock,
    }))
}

/// Create `dir` if needed and make it 0700. Refused if it is a symlink or
/// belongs to another user, since then its mode says nothing about who can
/// reach the socket inside. The checks and the chmod all go through one
/// descriptor opened with `O_NOFOLLOW`, so the path cannot be swapped for a
/// symlink between the check and the mode change.
fn private_dir(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let handle = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(dir)
        .map_err(|e| {
            io::Error::other(format!(
                "{} is not a plain directory of ours ({e})",
                dir.display()
            ))
        })?;
    let meta = handle.metadata()?;
    if !meta.file_type().is_dir() {
        return Err(io::Error::other(format!(
            "{} is not a directory",
            dir.display()
        )));
    }
    // SAFETY: geteuid has no preconditions and cannot fail.
    if meta.uid() != unsafe { libc::geteuid() } {
        return Err(io::Error::other(format!(
            "{} belongs to another user",
            dir.display()
        )));
    }
    handle.set_permissions(std::fs::Permissions::from_mode(0o700))
}

/// Whether a peer may talk to the bridge at all: only our own uid.
pub fn same_user(peer_uid: u32, our_uid: u32) -> bool {
    peer_uid == our_uid
}

/// Serve on an owned socket, holding its lock exactly as long as the listener.
pub async fn serve_owned(owned: Owned, router: axum::Router) {
    let Owned {
        listener, _lock, ..
    } = owned;
    serve(listener, router).await;
    drop(_lock);
}

/// Serve `router` on the socket until the process exits. Each connection is
/// checked against our uid before a byte of it is read.
pub async fn serve(listener: UnixListener, router: axum::Router) {
    if let Err(e) = listener.set_nonblocking(true) {
        log::warn!("context bridge socket: {e}");
        return;
    }
    let listener = match tokio::net::UnixListener::from_std(listener) {
        Ok(listener) => listener,
        Err(e) => {
            log::warn!("context bridge socket: {e}");
            return;
        }
    };
    // SAFETY: geteuid has no preconditions and cannot fail.
    let uid = unsafe { libc::geteuid() };
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(e) => {
                // Out of descriptors and the like: back off rather than spin.
                log::warn!("context bridge socket accept: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
        };
        if !stream
            .peer_cred()
            .is_ok_and(|cred| same_user(cred.uid(), uid))
        {
            continue;
        }
        let service = hyper_util::service::TowerToHyperService::new(router.clone());
        tokio::spawn(async move {
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                .await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    /// Short on purpose: macOS temp dirs use most of the 104-byte socket limit.
    struct Dir(PathBuf);

    impl Dir {
        fn new(name: &str) -> Dir {
            let dir = std::env::temp_dir().join(format!("cxs{}{}", std::process::id(), name));
            let _ = std::fs::remove_dir_all(&dir);
            Dir(dir)
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap()
    }

    fn router(answer: &'static str) -> axum::Router {
        axum::Router::new().route(
            "/ctx/tools",
            axum::routing::get(move || async move { answer }),
        )
    }

    /// What `canopy-hook` sends: plain HTTP/1.1 with Connection: close.
    fn get(path: &Path) -> io::Result<String> {
        let mut stream = UnixStream::connect(path)?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.write_all(
            b"GET /ctx/tools HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer t\r\nConnection: close\r\n\r\n",
        )?;
        let mut out = String::new();
        stream.read_to_string(&mut out)?;
        Ok(out)
    }

    #[test]
    fn the_socket_and_its_directory_are_private() {
        let dir = Dir::new("perm");
        let owned = claim(&dir.0).unwrap().expect("nobody else holds it");
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir.0), 0o700);
        assert_eq!(mode(&owned.path), 0o600);
        assert_eq!(owned.path, dir.0.join(SOCKET_NAME));
    }

    #[test]
    fn a_second_claim_while_held_gets_nothing_and_leaves_the_socket_alone() {
        let dir = Dir::new("two");
        let rt = runtime();
        let first = claim(&dir.0).unwrap().expect("first claim");
        let path = first.path.clone();
        let Owned {
            listener, _lock, ..
        } = first;
        rt.spawn(serve(listener, router("first")));
        // flock conflicts between open file descriptions even in one process,
        // so this stands in for a second app.
        assert!(claim(&dir.0).unwrap().is_none());
        assert!(
            path.exists(),
            "the loser must not unlink the owner's socket"
        );
        let answer = get(&path).unwrap();
        assert!(
            answer.contains("200 OK") && answer.ends_with("first"),
            "{answer}"
        );
        drop(_lock);
    }

    #[test]
    fn a_stale_socket_file_is_replaced() {
        let dir = Dir::new("stale");
        std::fs::create_dir_all(&dir.0).unwrap();
        // A socket file nobody listens on, as a killed app leaves it.
        drop(UnixListener::bind(dir.0.join(SOCKET_NAME)).unwrap());
        assert!(UnixStream::connect(dir.0.join(SOCKET_NAME)).is_err());
        let owned = claim(&dir.0).unwrap().expect("a dead owner holds no lock");
        let rt = runtime();
        rt.spawn(serve(owned.listener, router("fresh")));
        assert!(get(&owned.path).unwrap().ends_with("fresh"));
    }

    /// The point of the module: a client that only knows the path reaches
    /// whichever launch holds it now.
    #[test]
    fn a_relaunch_answers_at_the_same_path() {
        let dir = Dir::new("relaunch");
        let path = dir.0.join(SOCKET_NAME);
        {
            let rt = runtime();
            let owned = claim(&dir.0).unwrap().unwrap();
            let Owned {
                listener, _lock, ..
            } = owned;
            rt.spawn(serve(listener, router("launch-1")));
            assert!(get(&path).unwrap().ends_with("launch-1"));
            // Quit: the runtime and the lock go, the file stays behind.
            rt.shutdown_timeout(Duration::from_secs(2));
            drop(_lock);
        }
        assert!(path.exists());
        assert!(get(&path).is_err(), "nobody is listening between launches");
        let rt = runtime();
        // Polled like `serve_stable` does: a child another test thread forked
        // but has not exec'd yet shares the lock's descriptor for a moment.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let owned = loop {
            match claim(&dir.0).unwrap() {
                Some(owned) => break owned,
                None if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                None => panic!("the old launch never released the socket"),
            }
        };
        rt.spawn(serve(owned.listener, router("launch-2")));
        assert!(get(&path).unwrap().ends_with("launch-2"));
    }

    #[test]
    fn a_symlinked_directory_is_refused() {
        let dir = Dir::new("link");
        let real = Dir::new("real");
        std::fs::create_dir_all(&real.0).unwrap();
        std::os::unix::fs::symlink(&real.0, &dir.0).unwrap();
        assert!(claim(&dir.0).is_err());
    }

    #[test]
    fn a_path_too_long_for_sun_path_is_refused() {
        let dir = Dir::new(&"x".repeat(120));
        assert!(claim(&dir.0).is_err());
    }

    #[test]
    fn only_our_own_uid_is_served() {
        assert!(same_user(501, 501));
        assert!(!same_user(0, 501));
        assert!(!same_user(502, 501));
    }
}
