//! Whether the host already running at the socket can be shared with this
//! program. The standalone Canopy Terminal and the Canopy IDE meet at one
//! `~/.canopy/pty-host/host.sock`; whichever starts the host first decides which
//! binary serves both. They share it only when the versions match.
//!
//! The host's `hello` carries its protocol version and the path it was started
//! from. Both the IDE and this program start a host from a directory named
//! `<app version>-<16 hex digits>`, so the app version that started the host is
//! in that path. Pure: no I/O, so every message here is unit tested.

use std::io;
use std::path::Path;

use canopy_pty_host::client::{classify_hello, HelloOutcome};
use canopy_pty_host::protocol::{Response, EXCLUSIVE_ATTACH_VERSION, PROTOCOL_VERSION};

/// The host binary's file name.
pub const HOST_BIN: &str = "canopy-pty-host";

/// Hex digits of the content hash in an install directory name.
pub const DIGEST_LEN: usize = 16;

/// `<version>-<digest>`: the directory a host copy lives in.
pub fn dir_name(version: &str, digest_hex: &str) -> String {
    let version: String = version
        .chars()
        .map(|c| if version_char(c) { c } else { '_' })
        .collect();
    let version = if version.is_empty() {
        "0".to_string()
    } else {
        version
    };
    let digest: String = digest_hex.chars().take(DIGEST_LEN).collect();
    format!("{version}-{digest}")
}

fn version_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '_' | '-')
}

/// The version part of `name` when it has the shape `dir_name` produces.
pub fn version_of_dir(name: &str) -> Option<&str> {
    let (version, digest) = name.rsplit_once('-')?;
    let ok = !version.is_empty()
        && version.chars().all(version_char)
        && digest.len() == DIGEST_LEN
        && digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    ok.then_some(version)
}

/// The app version that started a host from `exe`
/// (`.../<version>-<digest>/canopy-pty-host`), or `None` for any other path (a
/// development build, `CANOPY_PTY_HOST_EXE`): then nothing is known.
pub fn host_app_version(exe: &str) -> Option<String> {
    let exe = Path::new(exe);
    if exe.file_name()? != HOST_BIN {
        return None;
    }
    let dir = exe.parent()?.file_name()?.to_str()?;
    version_of_dir(dir).map(str::to_owned)
}

/// Why a running host cannot be used.
#[derive(Clone, Debug, PartialEq)]
pub enum Mismatch {
    /// Started by another app version. `host` is `None` when the host is too
    /// old to say where it came from (it predates that field).
    AppVersion { host: Option<String> },
    /// It speaks a protocol older than this program needs.
    ProtocolTooOld { host: Option<u32>, needed: u32 },
    /// It is newer than this program and refuses it as a client.
    RefusesClient { host: Option<u32>, min_client: u32 },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    /// Nothing is listening: start one.
    NoHost,
    /// Same version (or one that cannot be told apart): use it.
    Share,
    /// It cannot be used.
    Mismatch(Mismatch),
    /// It did not answer sensibly; carry on and let the real call report it.
    Unknown(String),
}

/// Judges a `hello` reply. `ours` is this program's app version.
pub fn judge(reply: io::Result<Response>, ours: &str) -> Verdict {
    let exe = reply.as_ref().ok().and_then(|r| r.exe.clone());
    let protocol = reply.as_ref().ok().and_then(|r| r.version);
    match classify_hello(reply) {
        HelloOutcome::NoHost => Verdict::NoHost,
        HelloOutcome::Unknown(e) => Verdict::Unknown(e.to_string()),
        HelloOutcome::Skewed {
            version,
            min_client,
            ..
        } => match min_client {
            Some(m) if m > PROTOCOL_VERSION => Verdict::Mismatch(Mismatch::RefusesClient {
                host: version,
                min_client: m,
            }),
            _ => Verdict::Mismatch(Mismatch::ProtocolTooOld {
                host: version,
                needed: EXCLUSIVE_ATTACH_VERSION,
            }),
        },
        HelloOutcome::Compatible => {
            // This program attaches exclusively, which older hosts lack.
            if protocol.is_some_and(|v| v < EXCLUSIVE_ATTACH_VERSION) {
                return Verdict::Mismatch(Mismatch::ProtocolTooOld {
                    host: protocol,
                    needed: EXCLUSIVE_ATTACH_VERSION,
                });
            }
            match exe {
                // A host that does not report its path is older than this
                // program's own release line.
                None => Verdict::Mismatch(Mismatch::AppVersion { host: None }),
                Some(exe) => match host_app_version(&exe) {
                    Some(v) if v != ours => {
                        Verdict::Mismatch(Mismatch::AppVersion { host: Some(v) })
                    }
                    _ => Verdict::Share,
                },
            }
        }
    }
}

/// What the user is told. `running` is how many terminals the host still runs
/// (`None`: it could not be listed), `socket` where it is. `ours` is this
/// program's version.
pub fn explain(m: &Mismatch, ours: &str, socket: &Path, running: Option<usize>) -> String {
    let who = match m {
        Mismatch::AppVersion { host: Some(v) } => format!("Canopy {v}"),
        Mismatch::AppVersion { host: None } => "an older Canopy".to_string(),
        Mismatch::ProtocolTooOld { host: Some(v), .. } => {
            format!("an older Canopy (host protocol {v})")
        }
        Mismatch::ProtocolTooOld { host: None, .. } => "an older Canopy".to_string(),
        Mismatch::RefusesClient { .. } => "a newer Canopy".to_string(),
    };
    let fix = match m {
        Mismatch::RefusesClient { .. } => {
            "Update Canopy Terminal to the version of Canopy that is running"
        }
        _ => {
            "Quit that Canopy (or its terminals) so the host can stop, or update both to the \
             same version"
        }
    };
    let busy = match running {
        Some(0) => String::new(),
        Some(n) => format!(" It is still running {n} terminal(s), so it was left alone."),
        None => " Its terminals could not be listed, so it was left alone.".to_string(),
    };
    format!(
        "the terminal host at {} was started by {who}, but this is Canopy Terminal {ours}.{busy} \
         {fix}, or pass --socket <path> to use a separate host.",
        socket.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello(version: u32, exe: Option<&str>) -> io::Result<Response> {
        Ok(Response {
            ok: true,
            version: Some(version),
            min_client: Some(1),
            exe: exe.map(str::to_owned),
            ..Default::default()
        })
    }

    const D: &str = "0123456789abcdef";

    fn exe(version: &str) -> String {
        format!("/home/u/.canopy/pty-host/bin/{version}-{D}/canopy-pty-host")
    }

    #[test]
    fn the_version_is_read_from_the_install_directory() {
        assert_eq!(host_app_version(&exe("0.5.15")).as_deref(), Some("0.5.15"));
        assert_eq!(
            host_app_version(&exe("0.5.16-beta.1")).as_deref(),
            Some("0.5.16-beta.1")
        );
        for other in [
            "/repo/target/debug/canopy-pty-host",
            "/x/0.5.15-zzzzzzzzzzzzzzzz/canopy-pty-host",
            "/x/0.5.15-0123/canopy-pty-host",
            "/x/0.5.15-0123456789abcdef/not-the-host",
        ] {
            assert_eq!(host_app_version(other), None, "{other}");
        }
        assert_eq!(
            dir_name("0.5.15", "0123456789abcdef00"),
            format!("0.5.15-{D}")
        );
    }

    #[test]
    fn the_same_version_is_shared() {
        assert_eq!(
            judge(hello(4, Some(&exe("0.5.15"))), "0.5.15"),
            Verdict::Share
        );
        // Exactly the protocol this program needs, no more.
        assert_eq!(
            judge(
                hello(EXCLUSIVE_ATTACH_VERSION, Some(&exe("0.5.15"))),
                "0.5.15"
            ),
            Verdict::Share
        );
    }

    #[test]
    fn a_host_from_another_app_version_is_a_mismatch() {
        assert_eq!(
            judge(hello(4, Some(&exe("0.5.14"))), "0.5.15"),
            Verdict::Mismatch(Mismatch::AppVersion {
                host: Some("0.5.14".into())
            })
        );
        // A newer IDE is skew too, not only an older one.
        assert_eq!(
            judge(hello(4, Some(&exe("0.6.0"))), "0.5.15"),
            Verdict::Mismatch(Mismatch::AppVersion {
                host: Some("0.6.0".into())
            })
        );
    }

    #[test]
    fn a_host_that_does_not_report_its_path_is_older() {
        assert_eq!(
            judge(hello(4, None), "0.5.15"),
            Verdict::Mismatch(Mismatch::AppVersion { host: None })
        );
    }

    #[test]
    fn a_development_host_is_not_judged_by_path() {
        assert_eq!(
            judge(
                hello(4, Some("/repo/target/debug/canopy-pty-host")),
                "0.5.15"
            ),
            Verdict::Share
        );
    }

    #[test]
    fn an_old_protocol_cannot_attach_exclusively() {
        assert_eq!(
            judge(hello(2, Some(&exe("0.5.15"))), "0.5.15"),
            Verdict::Mismatch(Mismatch::ProtocolTooOld {
                host: Some(2),
                needed: EXCLUSIVE_ATTACH_VERSION
            })
        );
    }

    #[test]
    fn a_host_that_refuses_this_client_is_named_as_newer() {
        let refused = Ok(Response {
            ok: false,
            error: Some("client too old".into()),
            version: Some(PROTOCOL_VERSION + 1),
            min_client: Some(PROTOCOL_VERSION + 1),
            ..Default::default()
        });
        assert_eq!(
            judge(refused, "0.5.15"),
            Verdict::Mismatch(Mismatch::RefusesClient {
                host: Some(PROTOCOL_VERSION + 1),
                min_client: PROTOCOL_VERSION + 1
            })
        );
    }

    #[test]
    fn no_host_and_unreadable_hosts() {
        let gone = Err(io::Error::from(io::ErrorKind::NotFound));
        assert_eq!(judge(gone, "0.5.15"), Verdict::NoHost);
        let refused = Err(io::Error::from(io::ErrorKind::ConnectionRefused));
        assert_eq!(judge(refused, "0.5.15"), Verdict::NoHost);
        let timeout = Err(io::Error::from(io::ErrorKind::TimedOut));
        assert!(matches!(judge(timeout, "0.5.15"), Verdict::Unknown(_)));
    }

    #[test]
    fn the_message_says_who_and_what_to_do() {
        let socket = Path::new("/home/u/.canopy/pty-host/host.sock");
        let m = Mismatch::AppVersion {
            host: Some("0.5.14".into()),
        };
        let text = explain(&m, "0.5.15", socket, Some(2));
        assert!(text.contains("Canopy 0.5.14"), "{text}");
        assert!(text.contains("Canopy Terminal 0.5.15"), "{text}");
        assert!(text.contains("2 terminal(s)"), "{text}");
        assert!(text.contains("--socket"), "{text}");
        assert!(text.contains(socket.to_str().unwrap()), "{text}");

        let text = explain(&m, "0.5.15", socket, Some(0));
        assert!(!text.contains("terminal(s)"), "{text}");

        let text = explain(&m, "0.5.15", socket, None);
        assert!(text.contains("could not be listed"), "{text}");

        let newer = Mismatch::RefusesClient {
            host: Some(9),
            min_client: 9,
        };
        let text = explain(&newer, "0.5.15", socket, Some(1));
        assert!(text.contains("a newer Canopy"), "{text}");
        assert!(text.contains("Update Canopy Terminal"), "{text}");

        let old = explain(
            &Mismatch::AppVersion { host: None },
            "0.5.15",
            socket,
            Some(0),
        );
        assert!(old.contains("an older Canopy"), "{old}");
    }
}
