//! One small secret store for the account device token and saved workspace
//! connections, on every desktop platform:
//!
//! - macOS: the login Keychain (generic passwords), as before.
//! - Windows: Credential Manager (generic credentials, per user). A generic
//!   credential holds at most 2,560 bytes, so a larger value (the saved
//!   workspace list) is split across numbered entries.
//! - Linux and other Unix desktops: the freedesktop Secret Service (GNOME
//!   Keyring, KWallet, KeePassXC…) over D-Bus. Only when no Secret Service is
//!   running at all — a bare window manager, a minimal distro — does it fall
//!   back to a file encrypted with ChaCha20-Poly1305 under the app data
//!   directory, readable by this user only (0600 in a 0700 directory). That
//!   choice is logged once, with the path, so it is never silent. The file key
//!   is derived from this machine's id and the user id: it keeps the file
//!   useless when copied elsewhere, not safe from this user's own processes.
//!
//! Callers name an item by (service, account), exactly as the Keychain does.
//! A missing item is `Ok(None)`; `delete` of a missing item succeeds.

/// Where secrets go on this machine, for messages people read.
#[cfg(target_os = "macos")]
pub fn store_name() -> &'static str {
    "Keychain"
}
#[cfg(windows)]
pub fn store_name() -> &'static str {
    "Credential Manager"
}
#[cfg(all(unix, not(target_os = "macos")))]
pub fn store_name() -> &'static str {
    if linux::secret_service_available() {
        "the system keyring"
    } else {
        "encrypted local storage"
    }
}

#[cfg(target_os = "macos")]
pub fn get(service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
    match security_framework::passwords::get_generic_password(service, account) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.code() == -25300 => Ok(None),
        Err(_) => Err("unreadable".into()),
    }
}
#[cfg(target_os = "macos")]
pub fn set(service: &str, account: &str, secret: &[u8]) -> Result<(), String> {
    security_framework::passwords::set_generic_password(service, account, secret)
        .map_err(|_| "unwritable".into())
}
#[cfg(target_os = "macos")]
pub fn delete(service: &str, account: &str) -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(service, account) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == -25300 => Ok(()),
        Err(_) => Err("undeletable".into()),
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
pub use linux::{delete, get, set};
#[cfg(windows)]
pub use windows_store::{delete, get, set};

// ---------------------------------------------------------------------------
// Windows: Credential Manager.
// ---------------------------------------------------------------------------
#[cfg(windows)]
mod windows_store {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{ERROR_NOT_FOUND, FILETIME};
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS,
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    /// CRED_MAX_CREDENTIAL_BLOB_SIZE (5 * 512).
    const MAX_BLOB: usize = 2560;
    /// A value split across entries starts with this, then the part count.
    const PARTS: &[u8] = b"canopy-parts:";

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }
    fn target(service: &str, account: &str, part: Option<usize>) -> String {
        match part {
            None => format!("{service}/{account}"),
            Some(n) => format!("{service}/{account}#{n}"),
        }
    }
    fn not_found(error: &windows::core::Error) -> bool {
        error.code() == ERROR_NOT_FOUND.to_hresult()
    }

    fn read(name: &str) -> Result<Option<Vec<u8>>, String> {
        let name = wide(name);
        let mut found: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: `name` is NUL-terminated and outlives the call; on success
        // the API allocates `found`, which is copied out and freed below.
        match unsafe { CredReadW(PCWSTR(name.as_ptr()), CRED_TYPE_GENERIC, None, &mut found) } {
            Ok(()) => {
                // SAFETY: CredReadW succeeded, so `found` points at a valid
                // CREDENTIALW whose blob is `CredentialBlobSize` bytes long.
                let bytes = unsafe {
                    let credential = &*found;
                    let bytes = if credential.CredentialBlob.is_null() {
                        Vec::new()
                    } else {
                        std::slice::from_raw_parts(
                            credential.CredentialBlob,
                            credential.CredentialBlobSize as usize,
                        )
                        .to_vec()
                    };
                    CredFree(found as *const _);
                    bytes
                };
                Ok(Some(bytes))
            }
            Err(error) if not_found(&error) => Ok(None),
            Err(_) => Err("unreadable".into()),
        }
    }
    fn write(name: &str, user: &str, blob: &[u8]) -> Result<(), String> {
        let mut name = wide(name);
        let mut user = wide(user);
        let mut blob = blob.to_vec();
        let credential = CREDENTIALW {
            Flags: CRED_FLAGS(0),
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(name.as_mut_ptr()),
            Comment: PWSTR::null(),
            LastWritten: FILETIME::default(),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: PWSTR::null(),
            UserName: PWSTR(user.as_mut_ptr()),
        };
        // SAFETY: every pointer in `credential` borrows a local buffer that
        // lives until after the call; CredWriteW copies what it keeps.
        unsafe { CredWriteW(&credential, 0) }.map_err(|_| "unwritable".to_string())
    }
    fn remove(name: &str) -> Result<(), String> {
        let name = wide(name);
        // SAFETY: `name` is NUL-terminated and outlives the call.
        match unsafe { CredDeleteW(PCWSTR(name.as_ptr()), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            Err(error) if not_found(&error) => Ok(()),
            Err(_) => Err("undeletable".into()),
        }
    }
    fn part_count(head: &[u8]) -> Option<usize> {
        let count = head.strip_prefix(PARTS)?;
        std::str::from_utf8(count).ok()?.parse().ok()
    }

    pub fn get(service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
        let Some(head) = read(&target(service, account, None))? else {
            return Ok(None);
        };
        let Some(count) = part_count(&head) else {
            return Ok(Some(head));
        };
        let mut value = Vec::new();
        for n in 0..count {
            value.extend(read(&target(service, account, Some(n)))?.ok_or("unreadable")?);
        }
        Ok(Some(value))
    }
    pub fn set(service: &str, account: &str, secret: &[u8]) -> Result<(), String> {
        let previous = read(&target(service, account, None))?
            .and_then(|head| part_count(&head))
            .unwrap_or(0);
        let parts: Vec<&[u8]> = if secret.len() <= MAX_BLOB && !secret.starts_with(PARTS) {
            Vec::new()
        } else {
            secret.chunks(MAX_BLOB).collect()
        };
        // Parts first, head last: a reader never sees a head that names parts
        // which are not written yet.
        for (n, part) in parts.iter().enumerate() {
            write(&target(service, account, Some(n)), account, part)?;
        }
        if parts.is_empty() {
            write(&target(service, account, None), account, secret)?;
        } else {
            let head = [PARTS, parts.len().to_string().as_bytes()].concat();
            write(&target(service, account, None), account, &head)?;
        }
        for n in parts.len()..previous {
            remove(&target(service, account, Some(n)))?;
        }
        Ok(())
    }
    pub fn delete(service: &str, account: &str) -> Result<(), String> {
        let previous = read(&target(service, account, None))?
            .and_then(|head| part_count(&head))
            .unwrap_or(0);
        remove(&target(service, account, None))?;
        for n in 0..previous {
            remove(&target(service, account, Some(n)))?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Linux / other Unix: Secret Service, else an encrypted 0600 file.
// ---------------------------------------------------------------------------
#[cfg(all(unix, not(target_os = "macos")))]
mod linux {
    use super::file_store::FileStore;
    use dbus_secret_service::{EncryptionType, Error as SsError, SecretService};
    use std::collections::HashMap;
    use std::sync::OnceLock;

    /// Whether a Secret Service answered the first time this process asked.
    /// Decided once: a keyring daemon appearing mid-run would otherwise split
    /// one person's credentials across two stores.
    fn decided() -> &'static bool {
        static AVAILABLE: OnceLock<bool> = OnceLock::new();
        AVAILABLE.get_or_init(|| {
            if std::env::var_os("CANOPY_SECURE_STORE").is_some_and(|v| v == "file") {
                log::warn!("secure store: CANOPY_SECURE_STORE=file, not using the system keyring");
                return false;
            }
            match SecretService::connect(EncryptionType::Plain) {
                Ok(_) => true,
                Err(error) => {
                    log::warn!(
                        "secure store: no Secret Service on this desktop ({error}); \
                         Canopy credentials will be kept in an encrypted file readable \
                         only by you, in {}",
                        FileStore::default_dir()
                            .map(|d| d.display().to_string())
                            .unwrap_or_else(|| "the app data directory".into())
                    );
                    false
                }
            }
        })
    }
    pub fn secret_service_available() -> bool {
        *decided()
    }

    fn attributes<'a>(service: &'a str, account: &'a str) -> HashMap<&'a str, &'a str> {
        HashMap::from([
            ("application", "app.causeconnect.canopy"),
            ("service", service),
            ("account", account),
        ])
    }
    /// Interactive unlock prompts wait this long before giving up, so a
    /// dismissed keyring dialog fails the request instead of hanging it.
    const PROMPT_SECONDS: u64 = 120;
    fn connect() -> Result<SecretService, String> {
        SecretService::connect_with_max_prompt_timeout(EncryptionType::Plain, PROMPT_SECONDS)
            .map_err(|_| "keyring unavailable".to_string())
    }
    fn ss_err(error: SsError) -> String {
        match error {
            SsError::Locked | SsError::Prompt => "keyring locked".into(),
            _ => "keyring error".into(),
        }
    }

    pub fn get(service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
        if !secret_service_available() {
            return FileStore::open()?.get(service, account);
        }
        let ss = connect()?;
        let found = ss
            .search_items(attributes(service, account))
            .map_err(ss_err)?;
        let item = match (
            found.unlocked.into_iter().next(),
            found.locked.into_iter().next(),
        ) {
            (Some(item), _) => item,
            (None, Some(item)) => {
                item.unlock().map_err(ss_err)?;
                item
            }
            (None, None) => return Ok(None),
        };
        item.get_secret().map(Some).map_err(ss_err)
    }
    pub fn set(service: &str, account: &str, secret: &[u8]) -> Result<(), String> {
        if !secret_service_available() {
            return FileStore::open()?.set(service, account, secret);
        }
        let ss = connect()?;
        let collection = ss.get_any_collection().map_err(ss_err)?;
        collection.ensure_unlocked().map_err(ss_err)?;
        collection
            .create_item(
                &format!("Canopy ({service})"),
                attributes(service, account),
                secret,
                true,
                "application/octet-stream",
            )
            .map(|_| ())
            .map_err(ss_err)
    }
    pub fn delete(service: &str, account: &str) -> Result<(), String> {
        if !secret_service_available() {
            return FileStore::open()?.delete(service, account);
        }
        let ss = connect()?;
        let found = ss
            .search_items(attributes(service, account))
            .map_err(ss_err)?;
        for item in found.unlocked.iter().chain(found.locked.iter()) {
            item.delete().map_err(ss_err)?;
        }
        Ok(())
    }
}

/// The no-keyring fallback. Each item is one file named by a hash of its
/// (service, account), holding `nonce || ciphertext`. Kept outside the
/// Linux module so its tests run everywhere.
#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
mod file_store {
    use chacha20poly1305::aead::{Aead, KeyInit, Payload};
    use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
    use sha2::{Digest, Sha256};
    use std::path::{Path, PathBuf};

    const SALT: &str = "salt";
    const NONCE: usize = 24;

    pub struct FileStore {
        dir: PathBuf,
        cipher: XChaCha20Poly1305,
    }

    fn private_dir(dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|_| "storage unavailable")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "storage unavailable")?;
        }
        Ok(())
    }
    /// Write via a sibling temp file created 0600, then rename: the secret is
    /// never readable by others, even for a moment, and never half-written.
    fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
        use std::io::Write;
        let tmp = path.with_extension("next");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp).map_err(|_| "unwritable")?;
        file.write_all(bytes).map_err(|_| "unwritable")?;
        file.sync_all().map_err(|_| "unwritable")?;
        drop(file);
        std::fs::rename(&tmp, path).map_err(|_| "unwritable".to_string())
    }

    /// The machine this file is bound to: systemd's machine id, else the
    /// D-Bus one, else the host name.
    fn machine_id() -> Vec<u8> {
        for path in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
            if let Ok(id) = std::fs::read_to_string(path) {
                if !id.trim().is_empty() {
                    return id.trim().as_bytes().to_vec();
                }
            }
        }
        std::env::var("HOSTNAME").unwrap_or_default().into_bytes()
    }
    fn user_id() -> Vec<u8> {
        #[cfg(unix)]
        // SAFETY: getuid has no preconditions and cannot fail.
        return unsafe { libc::getuid() }.to_string().into_bytes();
        #[cfg(not(unix))]
        return std::env::var("USERNAME").unwrap_or_default().into_bytes();
    }

    impl FileStore {
        /// `$XDG_DATA_HOME/app.causeconnect.canopy/credentials`, the same app
        /// data directory Tauri uses on Linux.
        pub fn default_dir() -> Option<PathBuf> {
            let base = std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .or_else(|| {
                    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share"))
                })?;
            Some(base.join("app.causeconnect.canopy").join("credentials"))
        }
        pub fn open() -> Result<Self, String> {
            let dir = Self::default_dir().ok_or("storage unavailable")?;
            Self::open_in(dir, &machine_id(), &user_id())
        }
        pub fn open_in(dir: PathBuf, machine: &[u8], user: &[u8]) -> Result<Self, String> {
            private_dir(&dir)?;
            let salt_path = dir.join(SALT);
            let salt = match std::fs::read(&salt_path) {
                Ok(salt) if salt.len() == 32 => salt,
                _ => {
                    let mut salt = vec![0u8; 32];
                    getrandom::getrandom(&mut salt).map_err(|_| "storage unavailable")?;
                    write_private(&salt_path, &salt)?;
                    salt
                }
            };
            let hk = hkdf::Hkdf::<Sha256>::new(Some(&salt), &[machine, b"\0", user].concat());
            let mut key = [0u8; 32];
            hk.expand(b"canopy-credential-file-v1", &mut key)
                .map_err(|_| "storage unavailable")?;
            let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
            zeroize::Zeroize::zeroize(&mut key);
            Ok(Self { dir, cipher })
        }
        fn path(&self, service: &str, account: &str) -> PathBuf {
            let name = Sha256::digest(format!("{service}\0{account}").as_bytes());
            self.dir.join(format!("{}.enc", hex::encode(&name[..16])))
        }
        /// The item's name is bound into the ciphertext, so one item's file
        /// renamed over another's fails to open instead of answering for it.
        fn aad(service: &str, account: &str) -> Vec<u8> {
            format!("{service}\0{account}").into_bytes()
        }
        pub fn get(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
            let bytes = match std::fs::read(self.path(service, account)) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(_) => return Err("unreadable".into()),
            };
            if bytes.len() < NONCE {
                return Err("unreadable".into());
            }
            let (nonce, sealed) = bytes.split_at(NONCE);
            let aad = Self::aad(service, account);
            self.cipher
                .decrypt(
                    XNonce::from_slice(nonce),
                    Payload {
                        msg: sealed,
                        aad: &aad,
                    },
                )
                .map(Some)
                .map_err(|_| "unreadable".into())
        }
        pub fn set(&self, service: &str, account: &str, secret: &[u8]) -> Result<(), String> {
            let mut nonce = [0u8; NONCE];
            getrandom::getrandom(&mut nonce).map_err(|_| "unwritable")?;
            let aad = Self::aad(service, account);
            let sealed = self
                .cipher
                .encrypt(
                    XNonce::from_slice(&nonce),
                    Payload {
                        msg: secret,
                        aad: &aad,
                    },
                )
                .map_err(|_| "unwritable")?;
            write_private(
                &self.path(service, account),
                &[&nonce[..], &sealed].concat(),
            )
        }
        pub fn delete(&self, service: &str, account: &str) -> Result<(), String> {
            match std::fs::remove_file(self.path(service, account)) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err("undeletable".into()),
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::FileStore;

        fn scratch(name: &str) -> std::path::PathBuf {
            let dir = std::env::temp_dir()
                .join(format!("canopy-secure-store-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            dir
        }

        #[test]
        fn round_trips_overwrites_and_deletes() {
            let dir = scratch("roundtrip");
            let store = FileStore::open_in(dir.clone(), b"machine", b"1000").unwrap();
            assert_eq!(store.get("svc", "device").unwrap(), None);
            store.set("svc", "device", b"first").unwrap();
            store.set("svc", "device", b"second").unwrap();
            assert_eq!(
                store.get("svc", "device").unwrap().as_deref(),
                Some(&b"second"[..])
            );
            // A fresh open (a restart) reads the same value.
            let again = FileStore::open_in(dir.clone(), b"machine", b"1000").unwrap();
            assert_eq!(
                again.get("svc", "device").unwrap().as_deref(),
                Some(&b"second"[..])
            );
            again.delete("svc", "device").unwrap();
            again.delete("svc", "device").unwrap();
            assert_eq!(again.get("svc", "device").unwrap(), None);
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn file_is_ciphertext_and_bound_to_machine_and_name() {
            let dir = scratch("bound");
            let store = FileStore::open_in(dir.clone(), b"machine", b"1000").unwrap();
            let secret = format!("tok_{}", "a1".repeat(16));
            store.set("svc", "device", secret.as_bytes()).unwrap();
            let path = store.path("svc", "device");
            let raw = std::fs::read(&path).unwrap();
            assert!(!raw.windows(secret.len()).any(|w| w == secret.as_bytes()));
            // Another machine (or user) cannot open it.
            let elsewhere = FileStore::open_in(dir.clone(), b"other", b"1000").unwrap();
            assert!(elsewhere.get("svc", "device").is_err());
            // One item's file copied over another's does not answer for it.
            std::fs::copy(&path, store.path("svc", "other")).unwrap();
            assert!(store.get("svc", "other").is_err());
            let _ = std::fs::remove_dir_all(dir);
        }

        #[cfg(unix)]
        #[test]
        fn files_are_private_to_the_user() {
            use std::os::unix::fs::PermissionsExt;
            let dir = scratch("perms");
            let store = FileStore::open_in(dir.clone(), b"machine", b"1000").unwrap();
            store.set("svc", "device", b"secret").unwrap();
            let mode =
                |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&dir), 0o700);
            assert_eq!(mode(&store.path("svc", "device")), 0o600);
            assert_eq!(mode(&dir.join("salt")), 0o600);
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}
