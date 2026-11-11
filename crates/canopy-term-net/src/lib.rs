//! The transport contract: a byte stream to a peer whose identity has been
//! verified, so the same session protocol runs over a local socket, a tailnet or
//! an iroh connection without knowing which.
//!
//! The local unix-socket, same-uid transport stays its own transport; network
//! transports sit beside it. The protocol version and the caller-supplied spawn
//! key behave the same on every transport.

use std::io::{Read, Write};

/// Who is on the other end, as the transport proved it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PeerIdentity {
    /// Same machine, same user: proved by the operating system.
    LocalUser(u32),
    /// A remote device, by the public key it authenticated with.
    Device(String),
}

/// An established, authenticated connection.
pub trait Connection: Read + Write + Send {
    fn peer(&self) -> &PeerIdentity;
}

/// Why a connection was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The peer is not in the allowlist.
    UnknownPeer,
    /// The peer's protocol version is outside what this side serves.
    Version { theirs: u32, min: u32 },
}

/// Dials and accepts connections. `accept` returns `Err(Refusal)` for a peer it
/// will not serve, never a connection with an unverified identity.
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
