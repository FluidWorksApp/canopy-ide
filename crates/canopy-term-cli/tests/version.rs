//! Runs on every platform, Windows included: `--version` must work with no
//! host, no socket and an empty environment.

use std::process::Command;

#[test]
fn version_needs_no_host_and_no_env() {
    let out = Command::new(env!("CARGO_BIN_EXE_canopy-term"))
        .arg("--version")
        .env_clear()
        .output()
        .expect("runs");
    assert!(out.status.success());
    let text = String::from_utf8_lossy(&out.stdout);
    assert_eq!(
        text.trim(),
        format!("canopy-term {}", env!("CARGO_PKG_VERSION"))
    );
}
