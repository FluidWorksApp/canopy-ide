//! The command line. Pure: no environment and no I/O, so every case is a unit
//! test.

use std::path::PathBuf;

pub const USAGE: &str = "\
canopy-term-app: Canopy's own terminal window

usage: canopy-term-app [OPTIONS] [-- COMMAND [ARGS...]]
       canopy-term-app [OPTIONS] --attach ID [--force]

With no --attach, starts a new session in the PTY host (COMMAND, else $SHELL)
and shows it. With --attach ID, shows a session that is already running (see
`canopy-term ls`). Closing the window detaches: the session keeps running in
the host until its linger time ends, and can be shown again with --attach.

options:
  --attach ID         show an existing session instead of starting one
  --force             with --attach: take the session over if another client
                      (for example the Canopy app) is attached
  --key KEY           with a new session: an idempotency key; a repeated KEY
                      shows the existing session
  --cwd DIR           with a new session: its working directory
  --linger SECS       with a new session: seconds it lives after the window
                      closes (default 7200)
  --kill-on-close     stop the session when the window closes
  --socket PATH       host socket (default: $CANOPY_PTY_HOST_SOCKET, else
                      $CANOPY_PTY_HOST_DIR/host.sock, else
                      ~/.canopy/pty-host/host.sock)
  --dev               use the debug-build directory ~/.canopy/pty-host-dev
  --cols N, --rows N  the grid a new window opens at (default 100x30)
  --font-px N         font size in logical pixels (default 14)
  --padding PX        space between the window edge and the text, on every side,
                      in logical pixels (default 8; 0 for none)
  --no-blink          never blink the cursor
  --no-system-fonts   use only the bundled font (no CJK or emoji fallback)
  -h, --help          this text
  -V, --version       print the version

The host is unix only for now (macOS and Linux); on Windows the window opens
nothing and says so.
";

/// What the window shows.
#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    /// Start a session. An empty `argv` means the user's shell.
    New {
        argv: Vec<String>,
        cwd: Option<PathBuf>,
        key: Option<String>,
    },
    /// Show a running one.
    Attach { id: u32, force: bool },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Options {
    pub socket: Option<PathBuf>,
    pub dev: bool,
    pub target: Target,
    /// Seconds a new session outlives its last window.
    pub linger_secs: u64,
    pub kill_on_close: bool,
    pub cols: u16,
    pub rows: u16,
    pub font_px: f32,
    /// Space around the grid in logical pixels.
    pub padding_px: f32,
    pub cursor_blink: bool,
    pub system_fonts: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Parsed {
    Run(Box<Options>),
    Help,
    Version,
}

/// The default `--linger`: long enough to close the window, update and come
/// back, the same as the Canopy app's own.
pub const DEFAULT_LINGER_SECS: u64 = 2 * 60 * 60;

/// The default `--padding`, in logical pixels (the window's own default).
pub const DEFAULT_PADDING_PX: f32 = 8.0;

fn value(it: &mut std::vec::IntoIter<String>, flag: &str) -> Result<String, String> {
    it.next().ok_or_else(|| format!("{flag} needs a value"))
}

fn number<T: std::str::FromStr>(text: &str, flag: &str) -> Result<T, String> {
    text.parse()
        .map_err(|_| format!("{flag}: {text:?} is not a valid number"))
}

fn grid_edge(text: &str, flag: &str) -> Result<u16, String> {
    let n: u16 = number(text, flag)?;
    if (1..=1000).contains(&n) {
        Ok(n)
    } else {
        Err(format!("{flag} must be between 1 and 1000"))
    }
}

/// Parses the arguments after the program name.
pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Parsed, String> {
    let args: Vec<String> = args.into_iter().collect();
    let split = args.iter().position(|a| a == "--");
    let (head, command) = match split {
        Some(i) => (args[..i].to_vec(), args[i + 1..].to_vec()),
        None => (args, Vec::new()),
    };

    let mut socket = None;
    let mut dev = false;
    let mut attach: Option<u32> = None;
    let mut force = false;
    let mut key = None;
    let mut cwd = None;
    let mut linger_secs = DEFAULT_LINGER_SECS;
    let mut kill_on_close = false;
    let mut cols = 100;
    let mut rows = 30;
    let mut font_px = 14.0f32;
    let mut padding_px = DEFAULT_PADDING_PX;
    let mut cursor_blink = true;
    let mut system_fonts = true;

    let mut it = head.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(Parsed::Help),
            "-V" | "--version" => return Ok(Parsed::Version),
            "--socket" => socket = Some(PathBuf::from(value(&mut it, "--socket")?)),
            "--dev" => dev = true,
            "--attach" => {
                let v = value(&mut it, "--attach")?;
                attach = Some(number(&v, "--attach")?);
            }
            "--force" => force = true,
            "--key" => key = Some(value(&mut it, "--key")?),
            "--cwd" => cwd = Some(PathBuf::from(value(&mut it, "--cwd")?)),
            "--linger" => {
                let v = value(&mut it, "--linger")?;
                linger_secs = number(&v, "--linger")?;
            }
            "--kill-on-close" => kill_on_close = true,
            "--cols" => cols = grid_edge(&value(&mut it, "--cols")?, "--cols")?,
            "--rows" => rows = grid_edge(&value(&mut it, "--rows")?, "--rows")?,
            "--font-px" => {
                let v = value(&mut it, "--font-px")?;
                let px: f32 = number(&v, "--font-px")?;
                if !(4.0..=200.0).contains(&px) {
                    return Err("--font-px must be between 4 and 200".into());
                }
                font_px = px;
            }
            "--padding" => {
                let v = value(&mut it, "--padding")?;
                let px: f32 = number(&v, "--padding")?;
                if !(0.0..=200.0).contains(&px) {
                    return Err("--padding must be between 0 and 200".into());
                }
                padding_px = px;
            }
            "--no-blink" => cursor_blink = false,
            "--no-system-fonts" => system_fonts = false,
            other if other.starts_with('-') => {
                return Err(format!("unknown option {other:?}"));
            }
            other => {
                return Err(format!(
                    "unexpected argument {other:?}; put the command after --"
                ));
            }
        }
    }

    let target = match attach {
        Some(id) => {
            if key.is_some() || cwd.is_some() || !command.is_empty() {
                return Err(
                    "--attach shows an existing session; --key, --cwd and a command \
                            start a new one"
                        .into(),
                );
            }
            Target::Attach { id, force }
        }
        None => {
            if force {
                return Err("--force needs --attach".into());
            }
            Target::New {
                argv: command,
                cwd,
                key,
            }
        }
    };
    Ok(Parsed::Run(Box::new(Options {
        socket,
        dev,
        target,
        linger_secs,
        kill_on_close,
        cols,
        rows,
        font_px,
        padding_px,
        cursor_blink,
        system_fonts,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(args: &[&str]) -> Result<Options, String> {
        match parse(args.iter().map(|s| s.to_string()))? {
            Parsed::Run(o) => Ok(*o),
            other => Err(format!("not a run: {other:?}")),
        }
    }

    #[test]
    fn no_arguments_starts_the_shell() {
        let o = run(&[]).unwrap();
        assert_eq!(
            o.target,
            Target::New {
                argv: vec![],
                cwd: None,
                key: None
            }
        );
        assert_eq!((o.cols, o.rows), (100, 30));
        assert_eq!(o.padding_px, 8.0);
        assert_eq!(o.linger_secs, DEFAULT_LINGER_SECS);
        assert!(o.cursor_blink && o.system_fonts && !o.kill_on_close && !o.dev);
    }

    #[test]
    fn a_command_goes_after_the_double_dash_and_keeps_its_own_flags() {
        let o = run(&["--cwd", "/tmp", "--", "claude", "--resume", "--force"]).unwrap();
        assert_eq!(
            o.target,
            Target::New {
                argv: vec!["claude".into(), "--resume".into(), "--force".into()],
                cwd: Some(PathBuf::from("/tmp")),
                key: None
            }
        );
    }

    #[test]
    fn attach_with_force() {
        let o = run(&["--attach", "7", "--force", "--dev"]).unwrap();
        assert_eq!(o.target, Target::Attach { id: 7, force: true });
        assert!(o.dev);
    }

    #[test]
    fn options_are_read() {
        let o = run(&[
            "--socket",
            "/s/h.sock",
            "--key",
            "k1",
            "--linger",
            "30",
            "--kill-on-close",
            "--cols",
            "120",
            "--rows",
            "40",
            "--font-px",
            "16.5",
            "--no-blink",
            "--no-system-fonts",
        ])
        .unwrap();
        assert_eq!(o.socket, Some(PathBuf::from("/s/h.sock")));
        assert_eq!(o.linger_secs, 30);
        assert!(o.kill_on_close && !o.cursor_blink && !o.system_fonts);
        assert_eq!((o.cols, o.rows, o.font_px), (120, 40, 16.5));
        assert!(matches!(o.target, Target::New { key: Some(ref k), .. } if k == "k1"));
    }

    #[test]
    fn padding_takes_logical_pixels_and_allows_none() {
        assert_eq!(run(&["--padding", "12"]).unwrap().padding_px, 12.0);
        assert_eq!(run(&["--padding", "0"]).unwrap().padding_px, 0.0);
        assert_eq!(run(&["--padding", "2.5"]).unwrap().padding_px, 2.5);
        for bad in ["-1", "201", "nan", "abc", ""] {
            assert!(
                run(&["--padding", bad]).is_err(),
                "{bad:?} should be refused"
            );
        }
        assert!(run(&["--padding"]).is_err());
    }

    #[test]
    fn help_and_version_win_over_a_bad_rest() {
        assert_eq!(parse(["--help".to_string()]), Ok(Parsed::Help));
        assert_eq!(parse(["-V".to_string()]), Ok(Parsed::Version));
        // After `--` the words belong to the program, not to us.
        assert!(matches!(
            parse(["--".to_string(), "--help".to_string()]),
            Ok(Parsed::Run(_))
        ));
    }

    #[test]
    fn mistakes_are_refused_with_a_reason() {
        for bad in [
            &["--bogus"][..],
            &["stray"],
            &["--attach"],
            &["--attach", "x"],
            &["--attach", "-1"],
            &["--force"],
            &["--attach", "1", "--key", "k"],
            &["--attach", "1", "--cwd", "/"],
            &["--attach", "1", "--", "sh"],
            &["--cols", "0"],
            &["--rows", "1001"],
            &["--cols", "abc"],
            &["--font-px", "3"],
            &["--font-px", "nan"],
            &["--linger", "-5"],
            &["--socket"],
        ] {
            assert!(run(bad).is_err(), "{bad:?} should be refused");
        }
    }
}
