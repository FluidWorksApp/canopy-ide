//! The host's own log: why it started, why it stopped, and what happened to
//! each session. The host runs detached with stdout and stderr discarded, so
//! without this a host that vanished (and took its terminals with it) leaves
//! no trace at all.
//!
//! Content-free by design, like the app's resilience log: ids, pids, exit
//! codes, durations and reason words only. Never argv, environment, working
//! directories, spawn keys, metadata (it carries a sealed credential) or
//! terminal output.
//!
//! One line per event, UTC timestamps (they line up with the app's
//! resilience log), mode 0600, at most [`MAX_BYTES`] before the file is moved
//! to `host.log.1` (one generation kept). A start line with no `exit` line
//! before the next start means the process was killed outright (SIGKILL,
//! crash, power loss).
//!
//! Off until [`init`] is called, so hosts run on test threads write nothing.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Largest log before it is rotated.
pub const MAX_BYTES: u64 = 1024 * 1024;

static PATH: OnceLock<PathBuf> = OnceLock::new();
/// Serialises writers so rotation and append never interleave.
static WRITE: Mutex<()> = Mutex::new(());

/// Where the log goes for a host on `socket`: `CANOPY_PTY_HOST_LOG` if set
/// (empty turns logging off), else `host.log` beside a Unix socket, else
/// `%LOCALAPPDATA%\Canopy\pty-host\host.log` on Windows (the socket there is
/// a pipe name, not a path).
pub fn path_for(socket: &Path) -> Option<PathBuf> {
    path_from(socket, std::env::var_os("CANOPY_PTY_HOST_LOG"))
}

fn path_from(socket: &Path, overridden: Option<std::ffi::OsString>) -> Option<PathBuf> {
    if let Some(v) = overridden {
        return (!v.is_empty()).then(|| PathBuf::from(v));
    }
    #[cfg(unix)]
    {
        socket.parent().map(|dir| dir.join("host.log"))
    }
    #[cfg(windows)]
    {
        let _ = socket;
        std::env::var_os("LOCALAPPDATA").map(|d| {
            PathBuf::from(d)
                .join("Canopy")
                .join("pty-host")
                .join("host.log")
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = socket;
        None
    }
}

/// Turn the log on. Later calls are ignored.
pub fn init(path: PathBuf) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = PATH.set(path);
}

/// Append one line. Never fails the caller: a log that cannot be written is
/// simply not written.
pub fn write(args: std::fmt::Arguments<'_>) {
    let Some(path) = PATH.get() else {
        return;
    };
    let line = format!("{} pid={} {}\n", utc_now(), std::process::id(), args);
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    if std::fs::metadata(path).is_ok_and(|m| m.len() >= MAX_BYTES) {
        let mut old = path.clone().into_os_string();
        old.push(".1");
        let _ = std::fs::rename(path, old);
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(path) {
        // One write per line, so concurrent hosts (a loser exiting while the
        // winner runs) never interleave inside a line.
        let _ = file.write_all(line.as_bytes());
    }
}

/// `hostlog!("spawn id={id}")`: a line in the host log (no-op until `init`).
#[macro_export]
macro_rules! hostlog {
    ($($t:tt)*) => {
        $crate::hostlog::write(format_args!($($t)*))
    };
}

/// `2026-11-13T01:50:24.123Z`, without a date crate.
fn utc_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format_utc(now.as_secs(), now.subsec_millis())
}

fn format_utc(secs: u64, millis: u32) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian
/// (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_formatting_matches_known_instants() {
        assert_eq!(format_utc(0, 0), "1970-01-01T00:00:00.000Z");
        // 2026-11-13T01:50:24Z
        assert_eq!(format_utc(1_794_534_624, 123), "2026-11-13T01:50:24.123Z");
        // Leap day.
        assert_eq!(format_utc(951_782_400, 0), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn the_override_wins_and_empty_turns_logging_off() {
        let socket = Path::new("/tmp/x/host.sock");
        assert_eq!(path_from(socket, Some("".into())), None);
        assert_eq!(
            path_from(socket, Some("/var/log/h.log".into())),
            Some(PathBuf::from("/var/log/h.log"))
        );
        #[cfg(unix)]
        assert_eq!(
            path_from(socket, None),
            Some(PathBuf::from("/tmp/x/host.log"))
        );
    }
}
