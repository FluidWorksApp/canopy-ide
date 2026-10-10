//! This host's relay device: P-256 agreement and signing keys, generated once
//! and kept in the workspace-independent service state with mode 0600. They
//! never enter a container and never leave the host.

use super::crypto::{jwk_of, random_secret, Jwk, PublicIdentity};
use crate::util::{b64, b64url, write_private};
use base64::Engine;
use p256::ecdsa::signature::Signer;
use p256::{PublicKey, SecretKey};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub struct DeviceKeys {
    pub device_id: String,
    pub agreement: SecretKey,
    pub signing: p256::ecdsa::SigningKey,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    device_id: String,
    agreement: Jwk,
    signing: Jwk,
}

fn private_jwk(secret: &SecretKey) -> Jwk {
    let mut jwk = jwk_of(&secret.public_key());
    jwk.d = Some(b64url().encode(secret.to_bytes()));
    jwk
}

fn secret_of(jwk: &Jwk) -> Result<SecretKey, String> {
    let d = jwk.d.as_deref().ok_or("device key has no private part")?;
    let bytes = b64url().decode(d).map_err(|e| e.to_string())?;
    let secret = SecretKey::from_slice(&bytes).map_err(|e| e.to_string())?;
    if jwk_of(&secret.public_key()).x != jwk.x {
        return Err("device key does not match its public part".into());
    }
    Ok(secret)
}

impl DeviceKeys {
    /// Load the host's device, creating it on first start. A file that exists
    /// but cannot be read is an error: silently minting a new identity would
    /// strand every envelope encrypted to the old one.
    pub fn load_or_create(path: &Path) -> Result<Self, String> {
        match std::fs::read(path) {
            Ok(raw) => {
                let stored: Stored =
                    serde_json::from_slice(&raw).map_err(|e| format!("{}: {e}", path.display()))?;
                if !crate::util::is_uuid(&stored.device_id) {
                    return Err(format!("{}: invalid device id", path.display()));
                }
                Ok(Self {
                    device_id: stored.device_id,
                    agreement: secret_of(&stored.agreement)?,
                    signing: p256::ecdsa::SigningKey::from(secret_of(&stored.signing)?),
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let keys = Self {
                    device_id: crate::util::uuid_v4(),
                    agreement: random_secret(),
                    signing: p256::ecdsa::SigningKey::from(random_secret()),
                };
                let stored = Stored {
                    device_id: keys.device_id.clone(),
                    agreement: private_jwk(&keys.agreement),
                    signing: private_jwk(&SecretKey::from(&keys.signing)),
                };
                let bytes = serde_json::to_vec_pretty(&stored).map_err(|e| e.to_string())?;
                write_private(path, &bytes, 0o600).map_err(|e| e.to_string())?;
                Ok(keys)
            }
            Err(error) => Err(format!("{}: {error}", path.display())),
        }
    }

    pub fn public(&self) -> PublicIdentity {
        PublicIdentity {
            agreement: jwk_of(&self.agreement.public_key()),
            signing: jwk_of(&PublicKey::from(self.signing.verifying_key())),
        }
    }

    /// A possession proof over `[tag, subject, deviceId, created, ax, ay, sx,
    /// sy]` — `canopy-host-device-v1` with the workspace id for `register-host`.
    pub fn registration_proof(&self, tag: &str, subject: &str, created: u64) -> String {
        let keys = self.public();
        let payload = serde_json::json!([
            tag,
            subject,
            self.device_id,
            created,
            keys.agreement.x,
            keys.agreement.y,
            keys.signing.x,
            keys.signing.y
        ])
        .to_string();
        let signature: p256::ecdsa::Signature = self.signing.sign(payload.as_bytes());
        b64().encode(signature.to_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_once_private_and_stable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device.json");
        let first = DeviceKeys::load_or_create(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let second = DeviceKeys::load_or_create(&path).unwrap();
        assert_eq!(first.device_id, second.device_id);
        assert_eq!(first.public(), second.public());
        assert!(first.public().agreement.d.is_none());
        std::fs::write(&path, b"garbage").unwrap();
        assert!(DeviceKeys::load_or_create(&path).is_err());
    }
}
