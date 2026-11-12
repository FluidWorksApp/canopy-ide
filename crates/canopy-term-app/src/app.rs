//! Wires the command line, the host adapter, the session and the window.

use std::io::Write;

use canopy_term_session::SessionConfig;
use canopy_term_window::window::WindowConfig;

use crate::args::{self, Options, Parsed, USAGE};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The window's settings from the command line.
pub fn window_config(o: &Options) -> WindowConfig {
    WindowConfig {
        font_px: o.font_px,
        initial_grid: (o.cols, o.rows),
        system_fonts: o.system_fonts,
        cursor_blink: o.cursor_blink,
        ..WindowConfig::default()
    }
}

/// The session's settings for a host session of this size. It starts in
/// replay: the host sends its history first, and the blank screen must not
/// be shown (or an early read taken for live output) before it ends.
pub fn session_config(cols: u16, rows: u16) -> SessionConfig {
    SessionConfig {
        cols: cols.max(1),
        rows: rows.max(1),
        starts_with_replay: true,
        ..SessionConfig::default()
    }
}

fn out(text: &str) {
    let _ = write!(std::io::stdout(), "{text}");
}

fn say(text: &str) {
    // Never panics, even with stderr gone.
    let _ = writeln!(std::io::stderr(), "{text}");
}

/// Runs the program with its arguments (after the program name) and returns
/// the exit code. Call it on the main thread.
pub fn run(args: Vec<String>) -> i32 {
    match args::parse(args) {
        Ok(Parsed::Help) => {
            out(USAGE);
            0
        }
        Ok(Parsed::Version) => {
            out(&format!("canopy-term-app {VERSION}\n"));
            0
        }
        Ok(Parsed::Run(options)) => match launch(&options) {
            Ok(()) => 0,
            Err(e) => {
                say(&format!("canopy-term-app: {e}"));
                1
            }
        },
        Err(e) => {
            say(&format!("canopy-term-app: {e} (see --help)"));
            2
        }
    }
}

#[cfg(unix)]
fn launch(o: &Options) -> Result<(), String> {
    use crate::args::Target;
    use crate::{host, paths};
    use canopy_term_session::Session;
    use canopy_term_window::window;

    let env = |key: &str| std::env::var(key).ok();
    let (socket, launchable) = paths::socket_path(o.socket.as_deref(), o.dev, &env)?;
    let client = host::client_for(&socket, launchable);
    let opened = match &o.target {
        Target::New { argv, cwd, key } => {
            let cwd = match cwd {
                Some(dir) => std::path::absolute(dir).map_err(|e| e.to_string())?,
                None => std::env::current_dir().map_err(|e| e.to_string())?,
            };
            let new = host::NewSession {
                argv: argv.clone(),
                cwd,
                key: key.clone(),
                linger_secs: o.linger_secs,
                cols: o.cols,
                rows: o.rows,
            };
            // Entries that are not valid UTF-8 cannot go over the JSON wire.
            let vars = std::env::vars_os()
                .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)));
            let spec = host::build_spec(&new, std::env::var("SHELL").ok(), vars);
            host::open_new(&client, spec).map_err(|e| host::explain(&e, &socket, None))?
        }
        Target::Attach { id, force } => host::open_attached(&client, *id, *force, true)
            .map_err(|e| host::explain(&e, &socket, Some(*id)))?,
    };
    let id = opened.id;
    say(&format!(
        "canopy-term-app: session {id}; closing the window detaches it \
         (show it again with --attach {id})"
    ));
    let session = Session::new(opened.link, session_config(opened.cols, opened.rows));
    let result = window::run(session, window_config(o));
    if o.kill_on_close {
        let _ = client.kill(id);
    }
    result.map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn launch(_: &Options) -> Result<(), String> {
    Err(
        "the persistent terminal host is not available on this platform yet (it is \
         unix only), so no session can be started or attached. `cargo run --example \
         memory_demo` shows the window on a built-in toy program."
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(args: &[&str]) -> Options {
        match args::parse(args.iter().map(|s| s.to_string())).unwrap() {
            Parsed::Run(o) => *o,
            other => panic!("not a run: {other:?}"),
        }
    }

    #[test]
    fn the_command_line_reaches_the_window() {
        let o = options(&[
            "--cols",
            "120",
            "--rows",
            "40",
            "--font-px",
            "18",
            "--no-blink",
            "--no-system-fonts",
        ]);
        let w = window_config(&o);
        assert_eq!(w.initial_grid, (120, 40));
        assert_eq!(w.font_px, 18.0);
        assert!(!w.cursor_blink && !w.system_fonts);
        // What the command line does not set keeps the window's default.
        assert_eq!(w.title, WindowConfig::default().title);
    }

    #[test]
    fn the_session_waits_for_the_hosts_history() {
        let c = session_config(80, 24);
        assert!(c.starts_with_replay);
        assert_eq!((c.cols, c.rows), (80, 24));
        // A host that reports no size cannot make a zero grid.
        let c = session_config(0, 0);
        assert_eq!((c.cols, c.rows), (1, 1));
    }

    #[test]
    fn help_version_and_usage_errors_have_exit_codes() {
        assert_eq!(run(vec!["--help".into()]), 0);
        assert_eq!(run(vec!["--version".into()]), 0);
        assert_eq!(run(vec!["--no-such-option".into()]), 2);
    }
}
