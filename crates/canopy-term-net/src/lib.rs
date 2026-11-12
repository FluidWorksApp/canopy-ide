//! The transport contract: a byte stream to a peer whose identity has been
//! verified, so the same session protocol runs over a local socket, a tailnet or
//! an iroh connection without knowing which.
//!
//! The local unix-socket, same-uid transport stays its own transport; network
//! transports sit beside it. The protocol version check and the caller-supplied
//! spawn key live in the session protocol (hello and attach), not here, so they
//! behave the same on every transport.

pub mod allowlist;
#[cfg(feature = "iroh")]
pub mod iroh_transport;
mod json;
#[cfg(unix)]
pub mod local_unix;
pub mod pairing;
pub mod tailnet_tcp;
pub mod tailscale;

use std::io::{Read, Write};
use std::time::Duration;

/// The error kind every transport returns when a read deadline expires, so the
/// session protocol handles a silent peer the same way on each of them.
pub const TIMEOUT_KIND: std::io::ErrorKind = std::io::ErrorKind::TimedOut;

/// Who is on the other end, as the transport proved it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PeerIdentity {
    /// Same machine, same user: proved by the operating system.
    LocalUser(u32),
    /// A remote device, by the public key it authenticated with.
    Device(String),
}

/// An established, authenticated connection.
pub trait Connection: Send {
    fn peer(&self) -> &PeerIdentity;

    /// Bound how long a read may block, so a silent peer cannot hold a handler
    /// forever. `None` removes the bound.
    fn set_read_deadline(&mut self, deadline: Option<Duration>) -> std::io::Result<()>;

    /// Split into independent read and write halves. A session attach streams
    /// output on one thread while another reads input, so one `Read + Write`
    /// object is not enough.
    fn split(self: Box<Self>) -> (Box<dyn Read + Send>, Box<dyn Write + Send>);
}

/// What `Connection::split` returns when the socket cannot be duplicated (out of
/// descriptors, say). `split` has no error channel in the contract, so rather
/// than panic each half reports the failure on its first use.
#[allow(dead_code)]
pub(crate) struct FailedHalf(pub(crate) std::io::ErrorKind);

#[allow(dead_code)]
impl FailedHalf {
    fn error(&self) -> std::io::Error {
        std::io::Error::new(self.0, "the connection could not be split")
    }
}

impl Read for FailedHalf {
    fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
        Err(self.error())
    }
}

impl Write for FailedHalf {
    fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
        Err(self.error())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Err(self.error())
    }
}

/// A peer this side will not serve.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The peer is not in the allowlist.
    UnknownPeer,
}

/// Dials and accepts connections. The session protocol opens a connection per
/// control operation and per attached session, so `connect` must be cheap: a new
/// stream on an existing peer link, not a new handshake each time. `accept`
/// returns `Err(Refusal)` for a peer it will not serve, never a connection with
/// an unverified identity.
pub trait Transport {
    fn connect(&self, address: &str) -> std::io::Result<Box<dyn Connection>>;
    fn accept(&self) -> std::io::Result<Result<Box<dyn Connection>, Refusal>>;
}

/// Test helper: run a test body on its own thread and fail instead of hanging
/// forever, so a stuck transport costs seconds, not a whole CI run.
#[cfg(test)]
pub(crate) fn watchdog<F: FnOnce() + Send + 'static>(secs: u64, body: F) {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        body();
        let _ = tx.send(());
    });
    match rx.recv_timeout(Duration::from_secs(secs)) {
        Ok(()) => handle.join().unwrap(),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            // The body panicked: surface its panic.
            if let Err(e) = handle.join() {
                std::panic::resume_unwind(e);
            }
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            panic!("test hung for more than {secs}s")
        }
    }
}

/// Test helper: print a skip reason where a passing test's output still shows
/// it (`eprintln!` is captured, a direct stderr write is not).
#[cfg(test)]
pub(crate) fn skip(reason: &str) {
    use std::io::Write as _;
    let _ = writeln!(std::io::stderr(), "SKIPPED: {reason}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_split_reports_errors_instead_of_panicking() {
        let mut half = FailedHalf(std::io::ErrorKind::Other);
        let mut buf = [0u8; 4];
        assert!(half.read(&mut buf).is_err());
        assert!(half.write(b"x").is_err());
        assert!(half.flush().is_err());
    }

    #[test]
    fn identities_compare_by_kind_and_value() {
        assert_ne!(
            PeerIdentity::LocalUser(501),
            PeerIdentity::Device("501".into())
        );
        assert_eq!(
            PeerIdentity::Device("k".into()),
            PeerIdentity::Device("k".into())
        );
    }
}
