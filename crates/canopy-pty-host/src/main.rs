//! `canopy-pty-host --socket PATH [--idle-secs N]`

#[cfg(unix)]
fn main() {
    let mut socket = None;
    let mut idle = 60u64;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => socket = args.next(),
            "--idle-secs" => idle = args.next().and_then(|v| v.parse().ok()).unwrap_or(idle),
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
        idle_exit: std::time::Duration::from_secs(idle),
    };
    if let Err(error) = canopy_pty_host::server::run(config) {
        eprintln!("canopy-pty-host: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(unix))]
fn main() {
    eprintln!("canopy-pty-host is not supported on this platform");
    std::process::exit(1);
}
