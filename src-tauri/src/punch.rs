//! Direct peer-to-peer UDP connection with no middleman.
//!
//! The old relay opened a TCP listener and waited for an inbound connection.
//! That is the one method a carrier-NAT ("CGNAT") blocks outright: an inbound
//! TCP SYN to a port nothing has ever sent out from is dropped, so every join
//! over the internet timed out. This module replaces it with the approach that
//! actually traverses NAT:
//!
//!   1. Open a UDP socket and send OUT first (a STUN query). That outbound
//!      packet makes the NAT create a mapping, so the public address it reveals
//!      is genuinely reachable — return traffic on that 5-tuple gets forwarded
//!      back. This is measured, not assumed: three independent STUN servers
//!      report the same public ip:port for one socket, i.e. endpoint-
//!      independent ("cone") mapping.
//!   2. Both peers exchange their discovered public address out of band (the
//!      user shares it — that is the "introduction", and why no lookup server
//!      is needed) and fire packets AT EACH OTHER on a fixed cadence. Each
//!      side's outbound opens its own NAT's filter for the other's address, so
//!      the two streams cross and a direct path is established. Mutual sending
//!      is what makes this work for restricted-cone filtering too, not only
//!      full-cone.
//!   3. Keepalives hold the mapping open (idle CGNAT mappings expire in ~30s).
//!
//! What this does NOT beat: symmetric NAT, where the external port is different
//! per destination so the address you shared is not the one your packets arrive
//! on. That is physics, not a bug; the caller falls back (or reports failure).
//! The local machine was measured as cone, so this path is viable for it.

use std::io;
use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

/// A public STUN server: `(host, port)`. Multiple, so one being down or lying
/// does not decide the mapping on its own.
const STUN_SERVERS: &[(&str, u16)] = &[
    ("stun.l.google.com", 19302),
    ("stun.cloudflare.com", 3478),
    ("stun1.l.google.com", 19302),
];

const STUN_MAGIC: u32 = 0x2112_A442;

/// Build a STUN binding request with a random transaction id, returning the
/// bytes and the id so the reply can be matched.
fn binding_request() -> ([u8; 20], [u8; 12]) {
    let mut tid = [0u8; 12];
    // Not security-sensitive — just needs to be unique enough to match a reply.
    // Derived from the address of a stack local plus the clock, xored per byte;
    // avoids pulling a rng crate for a transaction id.
    let seed = (&tid as *const _ as u64) ^ Instant::now().elapsed().as_nanos() as u64;
    for (i, b) in tid.iter_mut().enumerate() {
        *b = (seed >> (i % 8 * 8)) as u8 ^ (i as u8).wrapping_mul(31);
    }
    let mut buf = [0u8; 20];
    buf[0..2].copy_from_slice(&1u16.to_be_bytes()); // Binding Request
    buf[2..4].copy_from_slice(&0u16.to_be_bytes()); // length 0
    buf[4..8].copy_from_slice(&STUN_MAGIC.to_be_bytes());
    buf[8..20].copy_from_slice(&tid);
    (buf, tid)
}

/// Parse the XOR-MAPPED-ADDRESS (0x0020) out of a STUN success response,
/// verifying the transaction id first. Only IPv4 is handled — the transfer
/// path is IPv4 throughout.
fn parse_mapped(resp: &[u8], tid: &[u8; 12]) -> Option<SocketAddr> {
    if resp.len() < 20 || resp[8..20] != tid[..] {
        return None;
    }
    let mut i = 20usize;
    let end = 20 + u16::from_be_bytes([resp[2], resp[3]]) as usize;
    while i + 4 <= resp.len().min(end) {
        let atype = u16::from_be_bytes([resp[i], resp[i + 1]]);
        let alen = u16::from_be_bytes([resp[i + 2], resp[i + 3]]) as usize;
        let val = &resp[i + 4..(i + 4 + alen).min(resp.len())];
        if atype == 0x0020 && val.len() >= 8 && val[1] == 0x01 {
            let port = u16::from_be_bytes([val[2], val[3]]) ^ (STUN_MAGIC >> 16) as u16;
            let magic = STUN_MAGIC.to_be_bytes();
            let ip = std::net::Ipv4Addr::new(
                val[4] ^ magic[0],
                val[5] ^ magic[1],
                val[6] ^ magic[2],
                val[7] ^ magic[3],
            );
            return Some(SocketAddr::from((ip, port)));
        }
        // Attributes are padded to a 4-byte boundary.
        i += 4 + alen + ((4 - alen % 4) % 4);
    }
    None
}

/// Discover this socket's public address by querying STUN. Sends on the socket
/// the caller will keep using, so the mapping the reply reveals is the same one
/// later traffic arrives on — binding a fresh socket would get a different port.
pub fn discover(sock: &UdpSocket) -> io::Result<SocketAddr> {
    sock.set_read_timeout(Some(Duration::from_secs(2)))?;
    for (host, port) in STUN_SERVERS {
        let Ok(mut addrs) = std::net::ToSocketAddrs::to_socket_addrs(&(*host, *port)) else {
            continue;
        };
        let Some(server) = addrs.find(|a| a.is_ipv4()) else { continue };
        let (req, tid) = binding_request();
        if sock.send_to(&req, server).is_err() {
            continue;
        }
        let mut buf = [0u8; 512];
        // A wrong-source or malformed packet shouldn't abort the whole probe.
        for _ in 0..3 {
            match sock.recv_from(&mut buf) {
                Ok((n, src)) if src == server => {
                    if let Some(addr) = parse_mapped(&buf[..n], &tid) {
                        return Ok(addr);
                    }
                }
                Ok(_) => continue,
                Err(_) => break,
            }
        }
    }
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "no STUN server revealed our public address",
    ))
}

/// Fire packets at `peer` on a fixed cadence while watching for one of theirs,
/// until the direct path is confirmed both ways or the deadline passes.
///
/// `probe` is a small opaque marker the caller recognises (so a stray packet
/// isn't mistaken for the peer). Returns Ok once we have both sent to and
/// received from `peer` — at which point both NATs' filters are open and the
/// socket is a working two-way channel the caller can hand to a reliable layer.
pub fn punch(sock: &UdpSocket, peer: SocketAddr, probe: &[u8], timeout: Duration) -> io::Result<()> {
    sock.set_read_timeout(Some(Duration::from_millis(250)))?;
    let deadline = Instant::now() + timeout;
    let mut last_send = Instant::now() - Duration::from_secs(1);
    let mut heard = false;
    let mut buf = [0u8; 512];
    while Instant::now() < deadline {
        if last_send.elapsed() >= Duration::from_millis(200) {
            let _ = sock.send_to(probe, peer);
            last_send = Instant::now();
        }
        match sock.recv_from(&mut buf) {
            Ok((n, src)) if src == peer && buf[..n].starts_with(probe) => {
                heard = true;
                // Answer a few times so the peer also sees us before we return.
                for _ in 0..3 {
                    let _ = sock.send_to(probe, peer);
                }
                return Ok(());
            }
            Ok(_) => {}
            Err(ref e) if e.kind() == io::ErrorKind::WouldBlock || e.kind() == io::ErrorKind::TimedOut => {}
            Err(e) => return Err(e),
        }
    }
    let _ = heard;
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "hole punch failed — the other side's network is likely symmetric NAT",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// STUN discovery works against the real public servers. This is the exact
    /// mechanism that makes an inbound-blocked machine reachable, so it is worth
    /// pinning: if the encoding regresses, the whole transport regresses.
    #[test]
    fn discovers_a_public_address() {
        let sock = UdpSocket::bind("0.0.0.0:0").expect("bind");
        match discover(&sock) {
            Ok(addr) => {
                assert!(addr.is_ipv4(), "expected an IPv4 public address");
                assert_ne!(addr.port(), 0);
            }
            // Don't fail CI when the sandbox has no UDP egress; the encoding is
            // covered by the round-trip test below regardless.
            Err(e) => eprintln!("STUN unavailable in this environment: {e}"),
        }
    }

    /// The XOR-MAPPED-ADDRESS decoder round-trips a hand-built response,
    /// independent of network access.
    #[test]
    fn parses_xor_mapped_address() {
        let (_, tid) = ([0u8; 20], [7u8; 12]);
        let want = SocketAddr::from(([203, 0, 113, 9], 51_820));
        let magic = STUN_MAGIC.to_be_bytes();
        let SocketAddr::V4(v4) = want else { unreachable!() };
        let ipo = v4.ip().octets();
        let xport = want.port() ^ (STUN_MAGIC >> 16) as u16;
        let mut resp = vec![0u8; 20];
        resp[8..20].copy_from_slice(&tid);
        resp[2..4].copy_from_slice(&12u16.to_be_bytes()); // one 12-byte attr
        resp.extend_from_slice(&0x0020u16.to_be_bytes());
        resp.extend_from_slice(&8u16.to_be_bytes());
        resp.extend_from_slice(&[0x00, 0x01]);
        resp.extend_from_slice(&xport.to_be_bytes());
        resp.extend_from_slice(&[ipo[0] ^ magic[0], ipo[1] ^ magic[1], ipo[2] ^ magic[2], ipo[3] ^ magic[3]]);
        assert_eq!(parse_mapped(&resp, &tid), Some(want));
    }
}
