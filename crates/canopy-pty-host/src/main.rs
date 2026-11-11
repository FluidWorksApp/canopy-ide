//! `canopy-pty-host --socket PATH [--idle-secs N]`
//!
//! On Windows PATH is a pipe name (`\\.\pipe\...`, see
//! `windows::default_pipe_name`).

#[cfg(any(unix, windows))]
fn main() {
    canopy_pty_host::server::harden_process();
    // The socket path is configurable for containers: --socket, else the
    // CANOPY_PTY_HOST_SOCKET environment variable.
    let mut socket = std::env::var("CANOPY_PTY_HOST_SOCKET").ok();
    let mut idle = 60u64;
    let mut min_client = canopy_pty_host::protocol::MIN_CLIENT_VERSION;
    let mut exited_ttl = canopy_pty_host::server::EXITED_TTL.as_secs();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => socket = args.next().or(socket),
            "--min-client" => {
                min_client = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(min_client)
            }
            "--idle-secs" => idle = args.next().and_then(|v| v.parse().ok()).unwrap_or(idle),
            "--exited-ttl-secs" => {
                exited_ttl = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(exited_ttl)
            }
            other => {
                eprintln!("canopy-pty-host: unknown argument {other}");
                std::process::exit(2);
            }
        }
    }
    let Some(socket) = socket else {
        eprintln!("usage: canopy-pty-host --socket PATH [--idle-secs N]");
        std::process::exit(2);
    };
    let config = canopy_pty_host::server::ServerConfig {
        socket: socket.into(),
        min_client,
        idle_exit: std::time::Duration::from_secs(idle),
        exited_ttl: std::time::Duration::from_secs(exited_ttl),
    };
    if let Err(error) = canopy_pty_host::server::run(config) {
        eprintln!("canopy-pty-host: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(any(unix, windows)))]
fn main() {
    eprintln!("canopy-pty-host is not supported on this platform");
    std::process::exit(1);
}
