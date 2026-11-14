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
    if let Some(path) = canopy_pty_host::hostlog::path_for(std::path::Path::new(&socket)) {
        canopy_pty_host::hostlog::init(path);
    }
    // Before anything can panic: stderr is discarded, so without this a panic
    // (or a poisoned lock after one) ends the host with no trace.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_default();
        canopy_pty_host::hostlog!(
            "panic thread={} at={location} message={message:?}",
            thread.name().unwrap_or("unnamed")
        );
        default_hook(info);
    }));
    // The installed copy's folder names the app build (`0.5.15-<hash>`); the
    // folder name only, never the path (it holds the home directory).
    let build = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent()?.file_name()?.to_str().map(str::to_owned))
        .unwrap_or_default();
    canopy_pty_host::hostlog!(
        "start build={build} crate={} protocol={} idle_secs={idle} exited_ttl_secs={exited_ttl} min_client={min_client}",
        env!("CARGO_PKG_VERSION"),
        canopy_pty_host::protocol::PROTOCOL_VERSION
    );
    let config = canopy_pty_host::server::ServerConfig {
        socket: socket.into(),
        min_client,
        idle_exit: std::time::Duration::from_secs(idle),
        exited_ttl: std::time::Duration::from_secs(exited_ttl),
    };
    if let Err(error) = canopy_pty_host::server::run(config) {
        canopy_pty_host::hostlog!("exit status=1 error={:?}", error.kind());
        eprintln!("canopy-pty-host: {error}");
        std::process::exit(1);
    }
    canopy_pty_host::hostlog!("exit status=0");
}

#[cfg(not(any(unix, windows)))]
fn main() {
    eprintln!("canopy-pty-host is not supported on this platform");
    std::process::exit(1);
}
