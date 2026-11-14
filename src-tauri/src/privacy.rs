//! The privacy permissions desk.rs does not already answer: Full Disk Access
//! and the microphone. First-run setup shows each with its real state, so a
//! row never says "Allowed" unless the OS said so here.
//!
//! Only macOS gates these per app; elsewhere both read as granted and the
//! setup step hides the rows.

use serde::Serialize;

/// "granted", "denied", "unasked" (macOS has not asked yet; it will on first
/// use) or "unknown" (could not tell).
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct PrivacyStatus {
    pub full_disk: &'static str,
    pub microphone: &'static str,
}

/// What opening a file that only Full Disk Access unlocks says about the grant.
/// There is no API for this permission and no prompt: the read just fails.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn full_disk_from(read: std::io::Result<()>) -> &'static str {
    match read {
        Ok(()) => "granted",
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => "denied",
        Err(_) => "unknown",
    }
}

/// AVAuthorizationStatus: 0 not determined, 1 restricted, 2 denied, 3 authorized.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn microphone_from(status: isize) -> &'static str {
    match status {
        3 => "granted",
        1 | 2 => "denied",
        0 => "unasked",
        _ => "unknown",
    }
}

#[cfg(target_os = "macos")]
mod os {
    // Nothing else links AVFoundation; the class lookup below needs it loaded.
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    pub fn full_disk() -> &'static str {
        let Some(home) = std::env::var_os("HOME") else {
            return "unknown";
        };
        // The user's TCC database: readable only with Full Disk Access.
        let db =
            std::path::Path::new(&home).join("Library/Application Support/com.apple.TCC/TCC.db");
        super::full_disk_from(std::fs::File::open(db).map(|_| ()))
    }

    pub fn microphone() -> &'static str {
        use objc2::msg_send;
        use objc2::runtime::AnyClass;
        let Some(cls) = AnyClass::get(c"AVCaptureDevice") else {
            return "unknown";
        };
        // AVMediaTypeAudio.
        let audio = objc2_foundation::NSString::from_str("soun");
        // SAFETY: a class method taking one NSString and returning an
        // NSInteger; it reads the status and never prompts.
        let status: isize = unsafe { msg_send![cls, authorizationStatusForMediaType: &*audio] };
        super::microphone_from(status)
    }

    pub fn open(kind: &str) -> Result<(), String> {
        let url = match kind {
            "full_disk" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
            }
            "microphone" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            "notifications" => {
                "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
            }
            other => return Err(format!("No settings page for {other}")),
        };
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Couldn't open System Settings: {e}"))
    }
}

#[cfg(not(target_os = "macos"))]
mod os {
    pub fn full_disk() -> &'static str {
        "granted"
    }
    pub fn microphone() -> &'static str {
        "granted"
    }
    pub fn open(_kind: &str) -> Result<(), String> {
        Ok(())
    }
}

/// Full Disk Access and the microphone, as the OS reports them right now.
#[tauri::command]
pub fn privacy_status() -> PrivacyStatus {
    PrivacyStatus {
        full_disk: os::full_disk(),
        microphone: os::microphone(),
    }
}

/// Open the System Settings page for "full_disk", "microphone" or "notifications".
#[tauri::command]
pub fn privacy_open_settings(kind: String) -> Result<(), String> {
    os::open(&kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Error, ErrorKind};

    #[test]
    fn full_disk_is_only_granted_when_the_protected_read_works() {
        assert_eq!(full_disk_from(Ok(())), "granted");
        assert_eq!(
            full_disk_from(Err(Error::from(ErrorKind::PermissionDenied))),
            "denied"
        );
        // A missing file says nothing about the permission.
        assert_eq!(
            full_disk_from(Err(Error::from(ErrorKind::NotFound))),
            "unknown"
        );
    }

    #[test]
    fn microphone_status_never_reads_an_unasked_mic_as_allowed() {
        assert_eq!(microphone_from(3), "granted");
        assert_eq!(microphone_from(2), "denied");
        assert_eq!(microphone_from(1), "denied");
        assert_eq!(microphone_from(0), "unasked");
        assert_eq!(microphone_from(9), "unknown");
    }
}
