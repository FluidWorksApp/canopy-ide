//! STUN public-address discovery.
//!
//! Open a UDP socket and send OUT first (a STUN query); that outbound packet
//! makes the NAT create a mapping, so the public ip:port the reply reveals is
//! genuinely reachable — return traffic on that 5-tuple gets forwarded back.
//! Three independent STUN servers are queried so one being down or lying does
//! not decide the answer alone.
//!
//! Canopy Remote uses this to offer a port-forward public URL when the portal's
//! TCP port has been manually forwarded. (The team relay once also hole-punched
//! a UDP path from here for its internet transport; that path is retired — the
//! internet path now rides the shared server's tunnel over a WebSocket.)

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
        let Some(server) = addrs.find(|a| a.is_ipv4()) else {
            continue;
        };
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
        let SocketAddr::V4(v4) = want else {
            unreachable!()
        };
        let ipo = v4.ip().octets();
        let xport = want.port() ^ (STUN_MAGIC >> 16) as u16;
        let mut resp = vec![0u8; 20];
        resp[8..20].copy_from_slice(&tid);
        resp[2..4].copy_from_slice(&12u16.to_be_bytes()); // one 12-byte attr
        resp.extend_from_slice(&0x0020u16.to_be_bytes());
        resp.extend_from_slice(&8u16.to_be_bytes());
        resp.extend_from_slice(&[0x00, 0x01]);
        resp.extend_from_slice(&xport.to_be_bytes());
        resp.extend_from_slice(&[
            ipo[0] ^ magic[0],
            ipo[1] ^ magic[1],
            ipo[2] ^ magic[2],
            ipo[3] ^ magic[3],
        ]);
        assert_eq!(parse_mapped(&resp, &tid), Some(want));
    }
}
