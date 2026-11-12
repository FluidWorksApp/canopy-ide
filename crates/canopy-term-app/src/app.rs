//! Wires the command line, the host adapter, the session and the window.

use std::io::Write;

use canopy_term_session::SessionConfig;
use canopy_term_window::window::WindowConfig;

use crate::args::{self, Options, Parsed, USAGE};
use crate::config::{self, Resolved};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The window's settings from the command line and the resolved config.
pub fn window_config(o: &Options, r: &Resolved) -> WindowConfig {
    WindowConfig {
        font_px: r.font_px,
        font_family: r.font_family.clone(),
        line_height: r.line_height,
        padding_px: r.padding_px,
        theme: r.theme.theme(),
        initial_grid: (o.cols, o.rows),
        system_fonts: o.system_fonts,
        cursor_blink: r.cursor_blink,
        ..WindowConfig::default()
    }
}

/// The colours the terminal engine answers programs' colour queries with
/// (OSC 4, 10, 11, 12): the renderer's own, so a program sees what is drawn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineColors {
    pub fg: (u8, u8, u8),
    pub bg: (u8, u8, u8),
    pub cursor: (u8, u8, u8),
    /// ANSI colours 0 to 15.
    pub palette: [(u8, u8, u8); 16],
}

/// The engine's colours, when a theme was asked for. With none asked for the
/// engine is left alone, as it was before the config file existed.
pub fn engine_colors(r: &Resolved) -> Option<EngineColors> {
    if !r.theme_chosen {
        return None;
    }
    let t = r.theme.theme();
    let c = |v: [u8; 3]| (v[0], v[1], v[2]);
    Some(EngineColors {
        fg: c(t.fg),
        bg: c(t.bg),
        cursor: c(t.cursor),
        palette: t.palette.map(c),
    })
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
    run_with(args, &|k| std::env::var(k).ok(), &|p| {
        std::fs::read_to_string(p)
    })
}

/// [`run`] with the environment and the file read passed in.
pub fn run_with(
    args: Vec<String>,
    env: &dyn Fn(&str) -> Option<String>,
    read: &dyn Fn(&std::path::Path) -> std::io::Result<String>,
) -> i32 {
    match args::parse(args) {
        Ok(Parsed::Help) => {
            out(USAGE);
            0
        }
        Ok(Parsed::Version) => {
            out(&format!("canopy-term-app {VERSION}\n"));
            0
        }
        Ok(Parsed::Run(options)) => {
            let loaded = match config::load(env, cfg!(windows), read) {
                Ok(l) => l,
                Err(e) => {
                    say(&format!("canopy-term-app: {e} (see config.example.toml)"));
                    return 2;
                }
            };
            let resolved = config::resolve(loaded.as_ref().map(|l| &l.config), &options);
            if options.print_config {
                out(&config::render(
                    &resolved,
                    loaded.as_ref().map(|l| l.path.as_path()),
                ));
                return 0;
            }
            match launch(&options, &resolved) {
                Ok(()) => 0,
                Err(e) => {
                    say(&format!("canopy-term-app: {e}"));
                    1
                }
            }
        }
        Err(e) => {
            say(&format!("canopy-term-app: {e} (see --help)"));
            2
        }
    }
}

#[cfg(unix)]
fn launch(o: &Options, r: &Resolved) -> Result<(), String> {
    use crate::args::Target;
    use crate::{host, paths};
    use canopy_term_session::Session;
    use canopy_term_window::window;
    use std::io::IsTerminal;

    let env = |key: &str| std::env::var(key).ok();
    let (socket, launchable) = paths::socket_path(o.socket.as_deref(), o.dev, &env)?;
    let client = host::prepare_client(&socket, launchable)?;
    let opened = match &o.target {
        Target::New { argv, cwd, key } => {
            // Started by the Finder or a launcher (not from a shell): the
            // directory is `/` and there is no terminal. Only then is the shell a
            // login shell, so a window the IDE opens keeps the environment it gave.
            let from_launcher = cwd.is_none()
                && !std::io::stdin().is_terminal()
                && std::env::current_dir().is_ok_and(|d| d == std::path::Path::new("/"));
            let cwd = match cwd {
                Some(dir) => std::path::absolute(dir).map_err(|e| e.to_string())?,
                None => host::default_cwd(
                    std::env::current_dir().map_err(|e| e.to_string())?,
                    std::env::var("HOME").ok(),
                ),
            };
            let new = host::NewSession {
                argv: argv.clone(),
                cwd,
                key: key.clone(),
                linger_secs: o.linger_secs,
                cols: o.cols,
                rows: o.rows,
                login: from_launcher,
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
    let mut session = Session::new(opened.link, session_config(opened.cols, opened.rows));
    if let Some(c) = engine_colors(r) {
        session.set_reply_colors(Some(c.fg), Some(c.bg), Some(c.cursor));
        session.set_default_palette(c.palette);
    }
    let result = window::run(session, window_config(o, r));
    if o.kill_on_close {
        let _ = client.kill(id);
    }
    result.map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn launch(_: &Options, _: &Resolved) -> Result<(), String> {
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

    fn resolved(args: &[&str]) -> (Options, Resolved) {
        let o = options(args);
        let r = config::resolve(None, &o);
        (o, r)
    }

    #[test]
    fn the_command_line_reaches_the_window() {
        let (o, r) = resolved(&[
            "--cols",
            "120",
            "--rows",
            "40",
            "--font-px",
            "18",
            "--padding",
            "6",
            "--line-height",
            "1.4",
            "--font-family",
            "Fira Code",
            "--theme",
            "light",
            "--no-blink",
            "--no-system-fonts",
        ]);
        let w = window_config(&o, &r);
        assert_eq!(w.padding_px, 6.0);
        assert_eq!(w.initial_grid, (120, 40));
        assert_eq!(w.font_px, 18.0);
        assert_eq!(w.line_height, 1.4);
        assert_eq!(w.font_family.as_deref(), Some("Fira Code"));
        assert_eq!(w.theme, canopy_term_window::window::RenderTheme::light());
        assert!(!w.cursor_blink && !w.system_fonts);
        // What the command line does not set keeps the window's default.
        assert_eq!(w.title, WindowConfig::default().title);
    }

    #[test]
    fn with_no_flags_and_no_file_the_window_keeps_its_own_defaults() {
        let (o, r) = resolved(&[]);
        let w = window_config(&o, &r);
        let d = WindowConfig::default();
        assert_eq!(w.padding_px, d.padding_px);
        assert_eq!(w.font_px, d.font_px);
        assert_eq!(w.line_height, d.line_height);
        assert_eq!(w.font_family, d.font_family);
        assert_eq!(w.theme, d.theme);
        assert_eq!(w.initial_grid, d.initial_grid);
        assert_eq!(
            (w.cursor_blink, w.system_fonts),
            (d.cursor_blink, d.system_fonts)
        );
        assert_eq!(engine_colors(&r), None, "the engine is left alone");
    }

    #[test]
    fn a_chosen_theme_reaches_the_engine_as_the_renderers_colours() {
        let (_, r) = resolved(&["--theme", "light"]);
        let c = engine_colors(&r).expect("a theme was chosen");
        let t = canopy_term_window::window::RenderTheme::light();
        assert_eq!(c.fg, (t.fg[0], t.fg[1], t.fg[2]));
        assert_eq!(c.bg, (t.bg[0], t.bg[1], t.bg[2]));
        assert_eq!(c.cursor, (t.cursor[0], t.cursor[1], t.cursor[2]));
        for i in 0..16 {
            let p = t.palette[i];
            assert_eq!(c.palette[i], (p[0], p[1], p[2]), "colour {i}");
        }
    }

    fn run_env(args: &[&str], file: Option<&'static str>) -> i32 {
        let env = |k: &str| (k == "CANOPY_TERM_CONFIG").then(|| "/c.toml".to_string());
        let read = move |_: &std::path::Path| -> std::io::Result<String> {
            match file {
                Some(t) => Ok(t.to_string()),
                None => Err(std::io::ErrorKind::NotFound.into()),
            }
        };
        run_with(args.iter().map(|s| s.to_string()).collect(), &env, &read)
    }

    #[test]
    fn a_bad_config_file_exits_2_and_never_panics() {
        for bad in [
            "font_px = 1",
            "font_px = \"x\"",
            "theme = \"neon\"",
            "[theme]\nforeground = \"nope\"",
            "nonsense = 1",
            "= = =",
        ] {
            assert_eq!(run_env(&["--print-config"], Some(bad)), 2, "{bad:?}");
        }
        // A named file that is not there is a mistake too.
        assert_eq!(run_env(&["--print-config"], None), 2);
    }

    #[test]
    fn print_config_exits_0_with_a_good_file_and_flags_still_win() {
        assert_eq!(run_env(&["--print-config"], Some("font_px = 20")), 0);
        // A flag fixes nothing about a bad file: the file is still checked.
        assert_eq!(
            run_env(&["--print-config", "--font-px", "12"], Some("font_px = 1")),
            2
        );
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
