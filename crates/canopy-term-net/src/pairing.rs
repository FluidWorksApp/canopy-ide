//! Pairing: how a new device gets onto the allowlist. Pure logic, no I/O, no
//! clock and no randomness of its own (both are passed in), so every rule is
//! testable.
//!
//! Flow. The host creates an [`Offer`]: a one-time code, shown as text or a QR
//! payload that also carries the host's own public key. The joining device
//! scans it, so it now knows (and can pin) the host's key. It then dials the
//! host over an authenticated transport and presents the code. The host adds
//! the key the TRANSPORT proved for that connection, never a key the joiner
//! claims in a message. That is the exchange: the joiner learns the host key
//! from the payload, the host learns the joiner key from the handshake, and the
//! code only authorises that one addition.
//!
//! Rules enforced here:
//! - a code is single use and burns on success;
//! - it expires (`now_ms >= expires_at_ms` is expired);
//! - wrong guesses are counted across all live offers, and after
//!   [`MAX_FAILED_ATTEMPTS`] every live offer is burned (a short code is
//!   guessable by brute force otherwise);
//! - codes compare in constant time, with no early exit on the first match;
//! - secrets never appear in `Debug` output, and this crate logs nothing.

use crate::allowlist::{canonical_key, Allowlist};

/// Characters in a code. 16 characters of a 32 symbol alphabet is 80 bits.
pub const CODE_LEN: usize = 16;
/// Wrong codes tolerated before all live offers are burned.
pub const MAX_FAILED_ATTEMPTS: u32 = 5;
/// Crockford base32: no I, L, O, U, so a typed code is not misread.
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAYLOAD_PREFIX: &str = "canopy-pair:v1:";

/// Source of random bytes, injected so tests are deterministic.
pub trait Entropy {
    fn fill(&mut self, buf: &mut [u8]);
}

/// The operating system's random source.
pub struct OsEntropy;

impl Entropy for OsEntropy {
    fn fill(&mut self, buf: &mut [u8]) {
        // A host that cannot get randomness must not mint a guessable code.
        getrandom::getrandom(buf).expect("operating system random source unavailable");
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum PairError {
    /// No live offer matches. Also the answer for a code already used.
    Invalid,
    Expired,
    /// Too many wrong codes; every live offer has been burned.
    TooManyAttempts,
    /// The transport-proven key is not a valid device key.
    BadPeerKey,
    /// A payload that does not parse.
    BadPayload,
}

/// What the host shows the joiner. The secret is reachable only through
/// explicit accessors, and `Debug` redacts it.
pub struct Offer {
    code: String,
    host_key: String,
    expires_at_ms: u64,
}

impl Offer {
    /// The code to type, grouped for reading: `XXXX-XXXX-XXXX-XXXX`.
    pub fn reveal_code(&self) -> String {
        self.code
            .as_bytes()
            .chunks(4)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect::<Vec<_>>()
            .join("-")
    }

    /// The QR text: host key plus code.
    pub fn reveal_payload(&self) -> String {
        format!("{PAYLOAD_PREFIX}{}:{}", self.host_key, self.code)
    }

    pub fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }
}

impl std::fmt::Debug for Offer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Offer")
            .field("code", &"<redacted>")
            .field("host_key", &self.host_key)
            .field("expires_at_ms", &self.expires_at_ms)
            .finish()
    }
}

/// Joiner side: split a scanned payload into the host's key (to pin) and the
/// code (to present).
pub fn parse_payload(payload: &str) -> Result<(String, String), PairError> {
    let rest = payload
        .trim()
        .strip_prefix(PAYLOAD_PREFIX)
        .ok_or(PairError::BadPayload)?;
    let (key, code) = rest.split_once(':').ok_or(PairError::BadPayload)?;
    let key = canonical_key(key).ok_or(PairError::BadPayload)?;
    let code = normalize_code(code).ok_or(PairError::BadPayload)?;
    Ok((key, code))
}

/// Uppercase, drop group separators and spaces, and check shape.
fn normalize_code(raw: &str) -> Option<String> {
    let c: String = raw
        .chars()
        .filter(|c| *c != '-' && !c.is_whitespace())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if c.len() == CODE_LEN && c.bytes().all(|b| ALPHABET.contains(&b)) {
        Some(c)
    } else {
        None
    }
}

/// Equal-length byte comparison that does not stop at the first difference.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

struct Live {
    code: String,
    expires_at_ms: u64,
}

/// The host's pairing state: live offers, the failure count, and the allowlist
/// a successful redeem adds to.
pub struct Pairing<E: Entropy> {
    allow: Allowlist,
    host_key: String,
    entropy: E,
    live: Vec<Live>,
    failures: u32,
}

impl<E: Entropy> std::fmt::Debug for Pairing<E> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pairing")
            .field("live_offers", &self.live.len())
            .field("failures", &self.failures)
            .finish()
    }
}

impl<E: Entropy> Pairing<E> {
    /// `host_key` is this device's own public key, put in each payload.
    pub fn new(allow: Allowlist, host_key: &str, entropy: E) -> Result<Self, PairError> {
        Ok(Self {
            allow,
            host_key: canonical_key(host_key).ok_or(PairError::BadPeerKey)?,
            entropy,
            live: Vec::new(),
            failures: 0,
        })
    }

    pub fn live_offers(&self) -> usize {
        self.live.len()
    }

    pub fn create_offer(&mut self, now_ms: u64, ttl_ms: u64) -> Offer {
        self.prune(now_ms);
        let mut raw = [0u8; CODE_LEN];
        self.entropy.fill(&mut raw);
        // 256 is a multiple of 32, so masking is unbiased.
        let code: String = raw
            .iter()
            .map(|b| ALPHABET[(*b & 31) as usize] as char)
            .collect();
        let expires_at_ms = now_ms.saturating_add(ttl_ms);
        self.live.push(Live {
            code: code.clone(),
            expires_at_ms,
        });
        // A fresh offer is the host's own act: start the guess budget over.
        self.failures = 0;
        Offer {
            code,
            host_key: self.host_key.clone(),
            expires_at_ms,
        }
    }

    /// Redeem `code` for the device the transport authenticated as
    /// `proven_peer_key`. On success that key joins the allowlist and the offer
    /// is burned. Returns the key as stored.
    pub fn redeem(
        &mut self,
        code: &str,
        proven_peer_key: &str,
        now_ms: u64,
    ) -> Result<String, PairError> {
        let peer = canonical_key(proven_peer_key).ok_or(PairError::BadPeerKey)?;
        self.prune(now_ms);
        let candidate = normalize_code(code);
        // Compare against every live offer, never stopping at a match.
        let mut hit: Option<usize> = None;
        if let Some(c) = &candidate {
            for (i, l) in self.live.iter().enumerate() {
                if ct_eq(c.as_bytes(), l.code.as_bytes()) {
                    hit = Some(i);
                }
            }
        }
        // Once the budget is spent nothing redeems until the host makes a new
        // offer, even a correct code that raced the lockout.
        let locked = self.failures >= MAX_FAILED_ATTEMPTS;
        match hit.filter(|_| !locked) {
            Some(i) => {
                self.live.swap_remove(i);
                self.allow.add(&peer).map_err(|_| PairError::BadPeerKey)?;
                self.failures = 0;
                Ok(peer)
            }
            None => {
                self.failures += 1;
                if self.failures >= MAX_FAILED_ATTEMPTS {
                    self.live.clear();
                    Err(PairError::TooManyAttempts)
                } else {
                    Err(PairError::Invalid)
                }
            }
        }
    }

    /// Drop expired offers. An offer expired exactly at `now_ms`.
    fn prune(&mut self, now_ms: u64) {
        self.live.retain(|l| now_ms < l.expires_at_ms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const PEER: &str = "2222222222222222222222222222222222222222222222222222222222222222";
    const OTHER: &str = "3333333333333333333333333333333333333333333333333333333333333333";

    /// Deterministic, and different on every call.
    struct Counter(u8);
    impl Entropy for Counter {
        fn fill(&mut self, buf: &mut [u8]) {
            for b in buf {
                self.0 = self.0.wrapping_mul(31).wrapping_add(7);
                *b = self.0;
            }
        }
    }

    fn pairing() -> (Pairing<Counter>, Allowlist) {
        let allow = Allowlist::new();
        (
            Pairing::new(allow.clone(), HOST, Counter(1)).unwrap(),
            allow,
        )
    }

    #[test]
    fn redeem_adds_the_proven_key_and_burns_the_offer() {
        let (mut p, allow) = pairing();
        let offer = p.create_offer(1_000, 60_000);
        let code = offer.reveal_code();
        assert_eq!(p.redeem(&code, PEER, 2_000), Ok(PEER.to_string()));
        assert!(allow.contains(PEER));
        // Single use: the same code, even from the same device, is now invalid.
        assert_eq!(p.redeem(&code, OTHER, 3_000), Err(PairError::Invalid));
        assert!(!allow.contains(OTHER));
    }

    #[test]
    fn only_the_proven_key_is_ever_added() {
        let (mut p, allow) = pairing();
        let offer = p.create_offer(0, 60_000);
        // Whatever the joiner says elsewhere, the stored key is the one passed.
        p.redeem(&offer.reveal_code(), PEER, 1).unwrap();
        assert_eq!(allow.keys(), vec![PEER.to_string()]);
        assert!(!allow.contains(HOST));
    }

    #[test]
    fn expired_offers_do_not_redeem() {
        let (mut p, allow) = pairing();
        let offer = p.create_offer(1_000, 500);
        let code = offer.reveal_code();
        // Exactly at the expiry instant counts as expired.
        assert_eq!(p.redeem(&code, PEER, 1_500), Err(PairError::Invalid));
        assert!(allow.is_empty());
        assert_eq!(p.live_offers(), 0);
    }

    #[test]
    fn last_instant_before_expiry_still_works() {
        let (mut p, _) = pairing();
        let offer = p.create_offer(1_000, 500);
        assert!(p.redeem(&offer.reveal_code(), PEER, 1_499).is_ok());
    }

    #[test]
    fn repeated_wrong_codes_burn_every_live_offer() {
        let (mut p, allow) = pairing();
        let a = p.create_offer(0, 60_000);
        let b = p.create_offer(0, 60_000);
        for _ in 0..MAX_FAILED_ATTEMPTS - 1 {
            assert_eq!(
                p.redeem("0000-0000-0000-0000", OTHER, 1),
                Err(PairError::Invalid)
            );
        }
        assert_eq!(
            p.redeem("0000-0000-0000-0000", OTHER, 1),
            Err(PairError::TooManyAttempts)
        );
        // The right codes no longer work: the budget is spent.
        assert_eq!(
            p.redeem(&a.reveal_code(), PEER, 2),
            Err(PairError::TooManyAttempts)
        );
        assert_eq!(
            p.redeem(&b.reveal_code(), PEER, 2),
            Err(PairError::TooManyAttempts)
        );
        assert!(allow.is_empty());
    }

    #[test]
    fn malformed_codes_count_as_failures() {
        let (mut p, _) = pairing();
        p.create_offer(0, 60_000);
        for _ in 0..MAX_FAILED_ATTEMPTS - 1 {
            assert_eq!(p.redeem("short", OTHER, 1), Err(PairError::Invalid));
        }
        assert_eq!(p.redeem("", OTHER, 1), Err(PairError::TooManyAttempts));
    }

    #[test]
    fn new_offer_resets_the_guess_budget() {
        let (mut p, _) = pairing();
        p.create_offer(0, 60_000);
        for _ in 0..MAX_FAILED_ATTEMPTS {
            let _ = p.redeem("0000-0000-0000-0000", OTHER, 1);
        }
        let fresh = p.create_offer(2, 60_000);
        assert!(p.redeem(&fresh.reveal_code(), PEER, 3).is_ok());
    }

    #[test]
    fn code_is_forgiving_about_case_and_separators() {
        let (mut p, _) = pairing();
        let offer = p.create_offer(0, 60_000);
        let typed = offer.reveal_code().to_lowercase().replace('-', " ");
        assert!(p.redeem(&typed, PEER, 1).is_ok());
    }

    #[test]
    fn bad_peer_key_is_rejected_without_burning_the_offer() {
        let (mut p, _) = pairing();
        let offer = p.create_offer(0, 60_000);
        assert_eq!(
            p.redeem(&offer.reveal_code(), "not-a-key", 1),
            Err(PairError::BadPeerKey)
        );
        assert!(p.redeem(&offer.reveal_code(), PEER, 2).is_ok());
    }

    #[test]
    fn payload_round_trips_for_the_joiner() {
        let (mut p, _) = pairing();
        let offer = p.create_offer(0, 60_000);
        let (host, code) = parse_payload(&offer.reveal_payload()).unwrap();
        assert_eq!(host, HOST);
        assert!(p.redeem(&code, PEER, 1).is_ok());
        assert_eq!(parse_payload("nope"), Err(PairError::BadPayload));
        assert_eq!(
            parse_payload(&format!("canopy-pair:v1:{HOST}:short")),
            Err(PairError::BadPayload)
        );
    }

    #[test]
    fn codes_differ_between_offers() {
        let (mut p, _) = pairing();
        let a = p.create_offer(0, 60_000);
        let b = p.create_offer(0, 60_000);
        assert_ne!(a.reveal_code(), b.reveal_code());
        assert_eq!(a.reveal_code().len(), CODE_LEN + 3);
    }

    #[test]
    fn debug_output_never_contains_the_secret() {
        let (mut p, _) = pairing();
        let offer = p.create_offer(0, 60_000);
        let raw = offer.reveal_code().replace('-', "");
        let shown = format!("{offer:?} {p:?}");
        assert!(!shown.contains(&raw));
        assert!(!shown.contains(&offer.reveal_code()));
        assert!(shown.contains("redacted"));
    }

    #[test]
    fn constant_time_compare_semantics() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"abcd"));
        assert!(ct_eq(b"", b""));
    }
}
