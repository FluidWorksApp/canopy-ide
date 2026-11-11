//! Where the host's socket is. The same rules as `canopy-term` (the CLI), so
//! both reach the same host.

use std::path::{Path, PathBuf};

/// The socket to use and whether this program may start a host there. Only the
/// default directory is launchable: starting a host makes its directory
/// private (mode 0700), which must never happen to a directory the user named.
///
/// Order: `--socket`, `CANOPY_PTY_HOST_SOCKET`, `CANOPY_PTY_HOST_DIR/host.sock`,
/// then `~/.canopy/pty-host/host.sock` (`pty-host-dev` with `--dev`). `env`
/// reads an environment variable; an empty value counts as unset.
pub fn socket_path(
    explicit: Option<&Path>,
    dev: bool,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<(PathBuf, bool), String> {
    let get = |key: &str| env(key).filter(|v| !v.is_empty());
    if let Some(path) = explicit {
        return Ok((path.to_path_buf(), false));
    }
    if let Some(path) = get("CANOPY_PTY_HOST_SOCKET") {
        return Ok((PathBuf::from(path), false));
    }
    if let Some(dir) = get("CANOPY_PTY_HOST_DIR") {
        return Ok((PathBuf::from(dir).join("host.sock"), false));
    }
    let home = get("HOME")
        .or_else(|| get("USERPROFILE"))
        .ok_or("no HOME; pass --socket or set CANOPY_PTY_HOST_DIR")?;
    let leaf = if dev { "pty-host-dev" } else { "pty-host" };
    Ok((
        PathBuf::from(home)
            .join(".canopy")
            .join(leaf)
            .join("host.sock"),
        true,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |key| {
            pairs
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn explicit_socket_wins_and_is_not_launchable() {
        let e = env(&[("CANOPY_PTY_HOST_SOCKET", "/x/h.sock"), ("HOME", "/home/u")]);
        let got = socket_path(Some(Path::new("/y/s.sock")), false, &e).unwrap();
        assert_eq!(got, (PathBuf::from("/y/s.sock"), false));
    }

    #[test]
    fn environment_socket_then_dir() {
        let e = env(&[
            ("CANOPY_PTY_HOST_SOCKET", "/x/h.sock"),
            ("CANOPY_PTY_HOST_DIR", "/d"),
        ]);
        assert_eq!(
            socket_path(None, false, &e).unwrap(),
            (PathBuf::from("/x/h.sock"), false)
        );
        let e = env(&[("CANOPY_PTY_HOST_DIR", "/d"), ("HOME", "/home/u")]);
        assert_eq!(
            socket_path(None, false, &e).unwrap(),
            (PathBuf::from("/d").join("host.sock"), false)
        );
    }

    #[test]
    fn default_is_under_home_and_launchable() {
        let e = env(&[("HOME", "/home/u")]);
        let expect = |leaf: &str| {
            PathBuf::from("/home/u")
                .join(".canopy")
                .join(leaf)
                .join("host.sock")
        };
        assert_eq!(
            socket_path(None, false, &e).unwrap(),
            (expect("pty-host"), true)
        );
        assert_eq!(
            socket_path(None, true, &e).unwrap(),
            (expect("pty-host-dev"), true)
        );
    }

    #[test]
    fn empty_values_count_as_unset() {
        let e = env(&[("CANOPY_PTY_HOST_SOCKET", ""), ("HOME", "/home/u")]);
        assert!(socket_path(None, false, &e).unwrap().1);
    }

    #[test]
    fn no_home_is_an_error() {
        let e = env(&[]);
        assert!(socket_path(None, false, &e).is_err());
    }
}
