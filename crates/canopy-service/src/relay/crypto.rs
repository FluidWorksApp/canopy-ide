//! Relay envelopes, byte-compatible with `src/teamMessaging/crypto.ts`.
//!
//! P-256 ECDH from an ephemeral key to the recipient's agreement key, HKDF-
//! SHA-256 (salt `canopy-im-v1`, info = the header bytes), AES-256-GCM with
//! the header as associated data, and an ECDSA P-256/SHA-256 signature in
//! IEEE P1363 form over `JSON.stringify([header, ciphertext])`.
//!
//! Version 2 (protocol §6) binds the recipient workspace and the envelope
//! kind into the header: `[2, id, [from…], [to.team, to.user, to.device,
//! to.workspace ?? null], kind, created, expires, x, y, iv]`. Everything else
//! is version 1 unchanged.

use crate::util::{b64, b64url};
use base64::Engine;
use p256::ecdsa::signature::{Signer, Verifier};
use p256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use p256::{PublicKey, SecretKey};
use serde::{Deserialize, Serialize};

pub const V1_LIFETIME_MS: u64 = 300_000;
pub const V2_MAX_LIFETIME_MS: u64 = 604_800_000;
const MAX_PLAINTEXT: usize = 32_000;
const MAX_CIPHERTEXT: usize = 32_016;
const CLOCK_SKEW_MS: u64 = 30_000;
pub const KINDS: &[&str] = &["chat", "mesh", "job", "job-status"];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Jwk {
    pub kty: String,
    pub crv: String,
    pub x: String,
    pub y: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub d: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicIdentity {
    pub agreement: Jwk,
    pub signing: Jwk,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Address {
    pub team: String,
    pub user: String,
    pub device: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Envelope {
    pub version: u32,
    pub id: String,
    pub from: Address,
    pub to: Address,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub created: u64,
    pub expires: u64,
    pub ephemeral: Jwk,
    pub iv: String,
    pub ciphertext: String,
    pub signature: String,
}

pub struct Opened {
    pub text: String,
    /// `JSON.stringify([from, to, id])` — the dedupe key crypto.ts uses.
    pub replay_id: String,
}

fn err(message: &str) -> String {
    message.to_string()
}

/// A public JWK as crypto.ts accepts it: P-256, 43-character coordinates,
/// never a private component.
pub fn public_jwk(jwk: &Jwk) -> Result<PublicKey, String> {
    if jwk.kty != "EC"
        || jwk.crv != "P-256"
        || jwk.x.len() != 43
        || jwk.y.len() != 43
        || jwk.d.is_some()
    {
        return Err(err("Invalid public identity"));
    }
    let x = b64url()
        .decode(&jwk.x)
        .map_err(|_| err("Invalid public identity"))?;
    let y = b64url()
        .decode(&jwk.y)
        .map_err(|_| err("Invalid public identity"))?;
    if x.len() != 32 || y.len() != 32 {
        return Err(err("Invalid public identity"));
    }
    let point = p256::EncodedPoint::from_affine_coordinates(
        p256::FieldBytes::from_slice(&x),
        p256::FieldBytes::from_slice(&y),
        false,
    );
    Option::from(PublicKey::from_encoded_point(&point))
        .ok_or_else(|| err("Invalid public identity"))
}

pub fn jwk_of(public: &PublicKey) -> Jwk {
    let point = public.to_encoded_point(false);
    Jwk {
        kty: "EC".into(),
        crv: "P-256".into(),
        x: b64url().encode(point.x().expect("uncompressed point")),
        y: b64url().encode(point.y().expect("uncompressed point")),
        d: None,
    }
}

pub fn random_secret() -> SecretKey {
    loop {
        let bytes = crate::util::random_bytes::<32>();
        if let Ok(key) = SecretKey::from_slice(&bytes) {
            return key;
        }
    }
}

/// Protocol §6.1: control-plane workspace ids, `^[A-Za-z0-9_-]{1,128}$`.
pub fn valid_workspace(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn address_parts(a: &Address) -> Result<[&str; 3], String> {
    let parts = [a.team.as_str(), a.user.as_str(), a.device.as_str()];
    if parts.iter().any(|v| v.is_empty() || v.len() > 256) {
        return Err(err("Invalid peer address"));
    }
    Ok(parts)
}

/// The authenticated header, as the exact string both ends hash.
pub fn header(e: &Envelope) -> Result<String, String> {
    public_jwk(&e.ephemeral)?;
    let key = &e.ephemeral;
    let from = address_parts(&e.from)?;
    let to = address_parts(&e.to)?;
    let value = match e.version {
        1 => serde_json::json!([1, e.id, from, to, e.created, e.expires, key.x, key.y, e.iv]),
        2 => serde_json::json!([
            2,
            e.id,
            from,
            [to[0], to[1], to[2], e.to.workspace],
            e.kind,
            e.created,
            e.expires,
            key.x,
            key.y,
            e.iv
        ]),
        _ => return Err(err("Unsupported envelope version")),
    };
    Ok(value.to_string())
}

fn signed(header: &str, ciphertext: &str) -> String {
    serde_json::json!([header, ciphertext]).to_string()
}

fn encryption_key(secret: &SecretKey, other: &PublicKey, context: &[u8]) -> [u8; 32] {
    let shared = p256::ecdh::diffie_hellman(secret.to_nonzero_scalar(), other.as_affine());
    let hkdf = hkdf::Hkdf::<sha2::Sha256>::new(Some(b"canopy-im-v1"), shared.raw_secret_bytes());
    let mut key = [0u8; 32];
    hkdf.expand(context, &mut key)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    key
}

/// crypto.ts's `decode`: canonical standard base64, bounded.
fn decode(value: &str, maximum: usize) -> Result<Vec<u8>, String> {
    if value.len() > maximum * 2 {
        return Err(err("Invalid message encoding"));
    }
    let bytes = b64()
        .decode(value)
        .map_err(|_| err("Invalid message encoding"))?;
    if bytes.len() > maximum || b64().encode(&bytes) != value {
        return Err(err("Invalid message encoding"));
    }
    Ok(bytes)
}

fn aead(key: &[u8; 32]) -> aes_gcm::Aes256Gcm {
    use aes_gcm::KeyInit;
    aes_gcm::Aes256Gcm::new(aes_gcm::Key::<aes_gcm::Aes256Gcm>::from_slice(key))
}

pub struct SealInput<'a> {
    pub signing: &'a p256::ecdsa::SigningKey,
    pub recipient: &'a PublicIdentity,
    pub from: Address,
    pub to: Address,
    /// None seals version 1 (person chat); Some seals version 2.
    pub kind: Option<&'a str>,
    pub text: &'a str,
    pub now: u64,
    pub lifetime_ms: u64,
}

pub fn seal(input: SealInput) -> Result<Envelope, String> {
    use aes_gcm::aead::{Aead, Payload};
    address_parts(&input.from)?;
    address_parts(&input.to)?;
    if input.from.team != input.to.team
        || input.text.trim().is_empty()
        || input.text.len() > MAX_PLAINTEXT
    {
        return Err(err("Invalid message"));
    }
    let version = if input.kind.is_some() { 2 } else { 1 };
    let ephemeral = random_secret();
    let mut envelope = Envelope {
        version,
        id: crate::util::uuid_v4(),
        from: input.from,
        to: input.to,
        kind: input.kind.map(str::to_string),
        created: input.now,
        expires: input.now + input.lifetime_ms,
        ephemeral: jwk_of(&ephemeral.public_key()),
        iv: b64().encode(crate::util::random_bytes::<12>()),
        ciphertext: String::new(),
        signature: String::new(),
    };
    if version == 1 {
        envelope.to.workspace = None;
    }
    let context = header(&envelope)?;
    let key = encryption_key(
        &ephemeral,
        &public_jwk(&input.recipient.agreement)?,
        context.as_bytes(),
    );
    let iv = decode(&envelope.iv, 12)?;
    let ciphertext = aead(&key)
        .encrypt(
            aes_gcm::Nonce::from_slice(&iv),
            Payload {
                msg: input.text.as_bytes(),
                aad: context.as_bytes(),
            },
        )
        .map_err(|_| err("Encryption failed"))?;
    envelope.ciphertext = b64().encode(ciphertext);
    let signature: p256::ecdsa::Signature = input
        .signing
        .sign(signed(&context, &envelope.ciphertext).as_bytes());
    envelope.signature = b64().encode(signature.to_bytes());
    Ok(envelope)
}

/// Shape and timing checks, before any key is touched.
pub fn validate(e: &Envelope, now: u64) -> Result<(), String> {
    let id_ok = e.id.len() == 36
        && e.id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-');
    let lifetime = e.expires.saturating_sub(e.created);
    let lifetime_ok = match (e.version, e.to.workspace.is_some()) {
        (1, _) => e.expires >= e.created && lifetime == V1_LIFETIME_MS,
        // Version 2 without a workspace is person chat and keeps five minutes.
        (2, false) => e.expires >= e.created && lifetime == V1_LIFETIME_MS,
        (2, true) => e.expires > e.created && lifetime <= V2_MAX_LIFETIME_MS,
        _ => return Err(err("Unsupported envelope version")),
    };
    const MAX_SAFE: u64 = (1 << 53) - 1;
    if !id_ok
        || e.from.team != e.to.team
        || e.created > MAX_SAFE
        || e.expires > MAX_SAFE
        || e.created > now + CLOCK_SKEW_MS
        || e.expires <= now
        || !lifetime_ok
    {
        return Err(err("Invalid or expired message"));
    }
    address_parts(&e.from)?;
    address_parts(&e.to)?;
    if e.version == 2 {
        let kind = e.kind.as_deref().unwrap_or_default();
        if !KINDS.contains(&kind) {
            return Err(err("Invalid envelope kind"));
        }
        match e.to.workspace.as_deref() {
            Some(ws) if !valid_workspace(ws) => return Err(err("Invalid workspace")),
            None if kind != "chat" => return Err(err("Workspace traffic names no workspace")),
            _ => {}
        }
    } else if e.kind.is_some() || e.to.workspace.is_some() {
        return Err(err("Version 1 envelopes carry no kind or workspace"));
    }
    Ok(())
}

/// Verify the sender's signature and decrypt. The caller resolves `sender`
/// from the authenticated directory and dedupes on `replay_id` durably before
/// acting on the text.
pub fn open(
    agreement: &SecretKey,
    sender: &PublicIdentity,
    e: &Envelope,
    now: u64,
) -> Result<Opened, String> {
    use aes_gcm::aead::{Aead, Payload};
    validate(e, now)?;
    let context = header(e)?;
    let ciphertext = decode(&e.ciphertext, MAX_CIPHERTEXT)?;
    let iv = decode(&e.iv, 12)?;
    if iv.len() != 12 {
        return Err(err("Invalid message nonce"));
    }
    let verifying = p256::ecdsa::VerifyingKey::from(public_jwk(&sender.signing)?);
    let signature_bytes = decode(&e.signature, 64)?;
    let signature = p256::ecdsa::Signature::from_slice(&signature_bytes)
        .map_err(|_| err("Message authentication failed"))?;
    verifying
        .verify(signed(&context, &e.ciphertext).as_bytes(), &signature)
        .map_err(|_| err("Message authentication failed"))?;
    let key = encryption_key(agreement, &public_jwk(&e.ephemeral)?, context.as_bytes());
    let plaintext = aead(&key)
        .decrypt(
            aes_gcm::Nonce::from_slice(&iv),
            Payload {
                msg: &ciphertext,
                aad: context.as_bytes(),
            },
        )
        .map_err(|_| err("Message authentication failed"))?;
    let text = String::from_utf8(plaintext).map_err(|_| err("Invalid message text"))?;
    let replay_id =
        serde_json::json!([address_parts(&e.from)?, address_parts(&e.to)?, e.id]).to_string();
    Ok(Opened { text, replay_id })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub struct TestDevice {
        pub agreement: SecretKey,
        pub signing: p256::ecdsa::SigningKey,
    }

    impl TestDevice {
        pub fn new() -> Self {
            Self {
                agreement: random_secret(),
                signing: p256::ecdsa::SigningKey::from(random_secret()),
            }
        }
        pub fn public(&self) -> PublicIdentity {
            PublicIdentity {
                agreement: jwk_of(&self.agreement.public_key()),
                signing: jwk_of(&PublicKey::from(self.signing.verifying_key())),
            }
        }
    }

    fn addr(user: &str, device: &str, workspace: Option<&str>) -> Address {
        Address {
            team: "11111111-1111-4111-8111-111111111111".into(),
            user: user.into(),
            device: device.into(),
            workspace: workspace.map(str::to_string),
        }
    }

    #[test]
    fn v2_round_trip_binds_workspace_and_kind() {
        let alice = TestDevice::new();
        let host = TestDevice::new();
        let ws = "ws-22222222-2222-4222-8222-222222222222";
        let now = 1_700_000_000_000;
        let envelope = seal(SealInput {
            signing: &alice.signing,
            recipient: &host.public(),
            from: addr("alice", "dev-a", None),
            to: addr("owner", "host", Some(ws)),
            kind: Some("mesh"),
            text: "hello",
            now,
            lifetime_ms: V2_MAX_LIFETIME_MS,
        })
        .unwrap();
        let opened = open(&host.agreement, &alice.public(), &envelope, now + 1).unwrap();
        assert_eq!(opened.text, "hello");

        let mut moved = envelope.clone();
        moved.to.workspace = Some("ws-33333333-3333-4333-8333-333333333333".into());
        assert!(open(&host.agreement, &alice.public(), &moved, now + 1).is_err());
        let mut rekinded = envelope.clone();
        rekinded.kind = Some("job".into());
        assert!(open(&host.agreement, &alice.public(), &rekinded, now + 1).is_err());
        let mallory = TestDevice::new();
        assert!(open(&host.agreement, &mallory.public(), &envelope, now + 1).is_err());
        assert!(open(
            &host.agreement,
            &alice.public(),
            &envelope,
            envelope.expires
        )
        .is_err());
        let mut v3 = envelope;
        v3.version = 3;
        assert!(open(&host.agreement, &alice.public(), &v3, now + 1).is_err());
    }
}
