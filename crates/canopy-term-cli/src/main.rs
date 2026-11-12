//! `canopy-term`: a thin command-line client for the persistent PTY host.
//! Run `canopy-term --help` for the commands.

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // First thing, before any environment, socket or host is touched.
    if args
        .iter()
        .take_while(|a| a.as_str() != "--")
        .any(|a| a == "--version" || a == "-V")
    {
        use std::io::Write;
        let _ = writeln!(std::io::stdout(), "canopy-term {VERSION}");
        return;
    }
    run(args);
}

#[cfg(unix)]
mod unix;

#[cfg(unix)]
fn run(args: Vec<String>) {
    std::process::exit(unix::run(args));
}

#[cfg(not(unix))]
fn run(_args: Vec<String>) {
    use std::io::Write;
    let _ = writeln!(
        std::io::stderr(),
        "canopy-term: the persistent terminal host is not available on this platform (it is unix only)"
    );
    std::process::exit(4);
}
