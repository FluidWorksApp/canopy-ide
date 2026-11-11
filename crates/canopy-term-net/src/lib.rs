//! The transport contract: a byte stream to a peer whose identity has been
//! verified, so the same session protocol runs over a local socket, a tailnet or
//! an iroh connection without knowing which.
//!
//! The local unix-socket, same-uid transport stays its own transport; network
//! transports sit beside it. The protocol version check and the caller-supplied
//! spawn key live in the session protocol (hello and attach), not here, so they
//! behave the same on every transport.

use std::io::{Read, Write};
use std::time::Duration;

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

#[cfg(test)]
mod tests {
    use super::*;

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
