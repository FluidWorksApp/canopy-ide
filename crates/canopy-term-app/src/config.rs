//! The config file: fonts, spacing, cursor and colours, read once at startup.
//!
//! Where it is (the first that applies):
//! 1. `$CANOPY_TERM_CONFIG`, a file that must exist;
//! 2. `$XDG_CONFIG_HOME/canopy-term/config.toml`, else
//!    `~/.config/canopy-term/config.toml` (Linux and macOS);
//!    `%APPDATA%\canopy-term\config.toml` (Windows). A missing file here is
//!    not an error: the built-in defaults apply, exactly as before this file
//!    existed.
//!
//! Precedence per setting: command-line flag, then the file, then the default.
//!
//! Pure: the environment and the file read are passed in, so every case is a
//! unit test. The TOML is parsed into a `toml::Table` and walked by hand so
//! that every error names the key it is about.

use std::path::{Path, PathBuf};

use canopy_term_window::window::{RenderTheme as Theme, Rgb};
use toml::{Table, Value};

use crate::args::Options;

pub const DEFAULT_FONT_PX: f32 = 14.0;
pub const DEFAULT_PADDING_PX: f32 = 8.0;
pub const DEFAULT_LINE_HEIGHT: f32 = 1.0;
pub const FONT_PX_RANGE: (f32, f32) = (4.0, 200.0);
pub const PADDING_RANGE: (f32, f32) = (0.0, 200.0);
pub const LINE_HEIGHT_RANGE: (f32, f32) = (0.5, 3.0);

/// The keys of the file's top level, for the unknown-key message.
const KEYS: &str = "font_family, font_px, line_height, padding, blink, theme";
/// The keys of a `[theme]` table.
const THEME_KEYS: &str = "base, foreground, background, cursor, selection, ansi";

/// A built-in theme.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThemeName {
    Dark,
    Light,
}

impl ThemeName {
    pub fn parse(text: &str) -> Option<ThemeName> {
        match text {
            "dark" => Some(ThemeName::Dark),
            "light" => Some(ThemeName::Light),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ThemeName::Dark => "dark",
            ThemeName::Light => "light",
        }
    }

    pub fn theme(self) -> Theme {
        match self {
            ThemeName::Dark => Theme::dark(),
            ThemeName::Light => Theme::light(),
        }
    }
}

/// A theme choice: a built-in, or a table of colours (already filled in from
/// its base, so it is a whole theme).
#[derive(Clone, Debug, PartialEq)]
pub enum ThemeSetting {
    Named(ThemeName),
    Custom(Box<Theme>),
}

impl ThemeSetting {
    pub fn theme(&self) -> Theme {
        match self {
            ThemeSetting::Named(n) => n.theme(),
            ThemeSetting::Custom(t) => **t,
        }
    }
}

/// What the file sets. `None` is "not in the file".
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FileConfig {
    pub font_family: Option<String>,
    pub font_px: Option<f32>,
    pub line_height: Option<f32>,
    pub padding_px: Option<f32>,
    pub blink: Option<bool>,
    pub theme: Option<ThemeSetting>,
}

/// A config file that was found and read.
#[derive(Clone, Debug, PartialEq)]
pub struct Loaded {
    pub path: PathBuf,
    pub config: FileConfig,
}

/// The settings after flags, file and defaults are merged.
#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    pub font_family: Option<String>,
    pub font_px: f32,
    pub line_height: f32,
    pub padding_px: f32,
    pub cursor_blink: bool,
    pub theme: ThemeSetting,
    /// A theme was asked for (flag or file). Only then is it also told to the
    /// terminal engine, so programs' colour queries answer with it; with none
    /// asked for, queries behave as they always did.
    pub theme_chosen: bool,
}

// ---- validation, shared with the command line ----------------------------

fn in_range(v: f32, (lo, hi): (f32, f32)) -> bool {
    (lo..=hi).contains(&v)
}

fn bounds(range: (f32, f32)) -> String {
    format!("must be between {} and {}", range.0, range.1)
}

/// `Err` is the tail of a message: "must be between 4 and 200".
pub fn check_font_px(v: f32) -> Result<f32, String> {
    if in_range(v, FONT_PX_RANGE) {
        Ok(v)
    } else {
        Err(bounds(FONT_PX_RANGE))
    }
}

pub fn check_padding(v: f32) -> Result<f32, String> {
    if in_range(v, PADDING_RANGE) {
        Ok(v)
    } else {
        Err(bounds(PADDING_RANGE))
    }
}

pub fn check_line_height(v: f32) -> Result<f32, String> {
    if in_range(v, LINE_HEIGHT_RANGE) {
        Ok(v)
    } else {
        Err(bounds(LINE_HEIGHT_RANGE))
    }
}

pub fn check_font_family(v: &str) -> Result<String, String> {
    let v = v.trim();
    if v.is_empty() {
        Err("must not be empty".into())
    } else if v.chars().any(char::is_control) {
        Err("must not contain control characters".into())
    } else {
        Ok(v.to_string())
    }
}

// ---- colours ---------------------------------------------------------------

/// `#rrggbb` (either case) to a colour.
pub fn parse_hex(text: &str) -> Option<Rgb> {
    let digits = text.strip_prefix('#')?;
    if digits.len() != 6 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&digits[i..i + 2], 16).ok();
    Some([byte(0)?, byte(2)?, byte(4)?])
}

pub fn hex(c: Rgb) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

// ---- parsing the file ------------------------------------------------------

fn number(key: &str, v: &Value) -> Result<f32, String> {
    match v {
        Value::Integer(i) => Ok(*i as f32),
        Value::Float(f) => Ok(*f as f32),
        other => Err(format!(
            "{key}: expected a number, got {}",
            other.type_str()
        )),
    }
}

fn ranged(key: &str, v: &Value, check: fn(f32) -> Result<f32, String>) -> Result<f32, String> {
    let n = number(key, v)?;
    check(n).map_err(|tail| format!("{key} {tail}, got {v}"))
}

fn string<'a>(key: &str, v: &'a Value) -> Result<&'a str, String> {
    v.as_str()
        .ok_or_else(|| format!("{key}: expected a string, got {}", v.type_str()))
}

fn colour(key: &str, v: &Value) -> Result<Rgb, String> {
    let s = string(key, v)?;
    parse_hex(s).ok_or_else(|| format!("{key}: {s:?} is not a colour; write it as \"#rrggbb\""))
}

fn custom_theme(table: &Table) -> Result<Theme, String> {
    let base = match table.get("base") {
        None => ThemeName::Dark,
        Some(v) => {
            let s = string("theme.base", v)?;
            ThemeName::parse(s).ok_or_else(|| {
                format!("theme.base: unknown theme {s:?}; use \"dark\" or \"light\"")
            })?
        }
    };
    let mut theme = base.theme();
    for (k, v) in table {
        let key = format!("theme.{k}");
        match k.as_str() {
            "base" => {}
            "foreground" => theme.fg = colour(&key, v)?,
            "background" => theme.bg = colour(&key, v)?,
            "cursor" => theme.cursor = colour(&key, v)?,
            "selection" => theme.selection_bg = colour(&key, v)?,
            "ansi" => {
                let items = v.as_array().ok_or_else(|| {
                    format!(
                        "{key}: expected an array of 16 colours, got {}",
                        v.type_str()
                    )
                })?;
                if items.len() != 16 {
                    return Err(format!(
                        "{key}: needs exactly 16 colours (black, red, green, yellow, blue, \
                         magenta, cyan, white, then the 8 bright ones), got {}",
                        items.len()
                    ));
                }
                for (i, item) in items.iter().enumerate() {
                    theme.palette[i] = colour(&format!("{key}[{i}]"), item)?;
                }
            }
            other => {
                return Err(format!(
                    "theme: unknown key {other:?} (known keys: {THEME_KEYS})"
                ))
            }
        }
    }
    Ok(theme)
}

fn theme_setting(v: &Value) -> Result<ThemeSetting, String> {
    match v {
        Value::String(s) => ThemeName::parse(s).map(ThemeSetting::Named).ok_or_else(|| {
            format!(
                "theme: unknown theme {s:?}; use \"dark\", \"light\" or a [theme] table of colours"
            )
        }),
        Value::Table(t) => custom_theme(t).map(|t| ThemeSetting::Custom(Box::new(t))),
        other => Err(format!(
            "theme: expected \"dark\", \"light\" or a table of colours, got {}",
            other.type_str()
        )),
    }
}

/// Parses the file's text. `Err` names the key (or the line, for text that is
/// not TOML at all).
pub fn parse_file(text: &str) -> Result<FileConfig, String> {
    let table: Table = text.parse().map_err(|e: toml::de::Error| {
        let line = e.span().map(|s| {
            let end = s.start.min(text.len());
            text.as_bytes()[..end]
                .iter()
                .filter(|&&b| b == b'\n')
                .count()
                + 1
        });
        match line {
            Some(line) => format!("not valid TOML at line {line}: {}", e.message()),
            None => format!("not valid TOML: {}", e.message()),
        }
    })?;
    let mut out = FileConfig::default();
    for (key, v) in &table {
        match key.as_str() {
            "font_family" => {
                out.font_family =
                    Some(check_font_family(string(key, v)?).map_err(|t| format!("{key} {t}"))?)
            }
            "font_px" => out.font_px = Some(ranged(key, v, check_font_px)?),
            "line_height" => out.line_height = Some(ranged(key, v, check_line_height)?),
            "padding" => out.padding_px = Some(ranged(key, v, check_padding)?),
            "blink" => {
                out.blink = Some(v.as_bool().ok_or_else(|| {
                    format!("{key}: expected true or false, got {}", v.type_str())
                })?)
            }
            "theme" => out.theme = Some(theme_setting(v)?),
            other => return Err(format!("unknown key {other:?} (known keys: {KEYS})")),
        }
    }
    Ok(out)
}

// ---- finding and reading it -----------------------------------------------

/// The default location for this OS, from the environment. `windows` picks the
/// Windows layout (a parameter so both are tested on any host).
pub fn default_path(env: &dyn Fn(&str) -> Option<String>, windows: bool) -> Option<PathBuf> {
    let get = |key: &str| env(key).filter(|v| !v.is_empty());
    let base = if windows {
        PathBuf::from(get("APPDATA")?)
    } else if let Some(xdg) = get("XDG_CONFIG_HOME") {
        PathBuf::from(xdg)
    } else {
        PathBuf::from(get("HOME")?).join(".config")
    };
    Some(base.join("canopy-term").join("config.toml"))
}

/// Reads the config file, if there is one. `read` is `std::fs::read_to_string`
/// outside tests. `Err` is a message ready to print.
pub fn load(
    env: &dyn Fn(&str) -> Option<String>,
    windows: bool,
    read: &dyn Fn(&Path) -> std::io::Result<String>,
) -> Result<Option<Loaded>, String> {
    let explicit = env("CANOPY_TERM_CONFIG").filter(|v| !v.is_empty());
    let required = explicit.is_some();
    let Some(path) = explicit
        .map(PathBuf::from)
        .or_else(|| default_path(env, windows))
    else {
        return Ok(None);
    };
    let text = match read(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !required => return Ok(None),
        Err(e) => {
            let from = if required {
                " (from CANOPY_TERM_CONFIG)"
            } else {
                ""
            };
            return Err(format!("cannot read config {}{from}: {e}", path.display()));
        }
    };
    let config = parse_file(&text).map_err(|e| format!("config {}: {e}", path.display()))?;
    Ok(Some(Loaded { path, config }))
}

// ---- merging ---------------------------------------------------------------

/// Flags over file over defaults.
pub fn resolve(file: Option<&FileConfig>, o: &Options) -> Resolved {
    let empty = FileConfig::default();
    let f = file.unwrap_or(&empty);
    let flag_theme = o.theme.map(ThemeSetting::Named);
    let theme_chosen = flag_theme.is_some() || f.theme.is_some();
    Resolved {
        font_family: o.font_family.clone().or_else(|| f.font_family.clone()),
        font_px: o.font_px.or(f.font_px).unwrap_or(DEFAULT_FONT_PX),
        line_height: o
            .line_height
            .or(f.line_height)
            .unwrap_or(DEFAULT_LINE_HEIGHT),
        padding_px: o.padding_px.or(f.padding_px).unwrap_or(DEFAULT_PADDING_PX),
        cursor_blink: o.cursor_blink.or(f.blink).unwrap_or(true),
        theme: flag_theme
            .or_else(|| f.theme.clone())
            .unwrap_or(ThemeSetting::Named(ThemeName::Dark)),
        theme_chosen,
    }
}

/// `--print-config`: the resolved settings as TOML that this program reads back
/// to the same result (apart from the comment lines).
pub fn render(r: &Resolved, source: Option<&Path>) -> String {
    let mut out = String::new();
    match source {
        Some(p) => out.push_str(&format!("# config file: {}\n", p.display())),
        None => out.push_str("# config file: none (built-in defaults)\n"),
    }
    out.push_str("# command-line flags override the file\n");
    match &r.font_family {
        Some(f) => out.push_str(&format!("font_family = {:?}\n", f)),
        None => out.push_str("# font_family: not set (the bundled JetBrains Mono)\n"),
    }
    out.push_str(&format!("font_px = {:?}\n", r.font_px));
    out.push_str(&format!("line_height = {:?}\n", r.line_height));
    out.push_str(&format!("padding = {:?}\n", r.padding_px));
    out.push_str(&format!("blink = {}\n", r.cursor_blink));
    match &r.theme {
        ThemeSetting::Named(n) => out.push_str(&format!("theme = {:?}\n", n.as_str())),
        ThemeSetting::Custom(t) => {
            out.push_str("\n[theme]\n");
            out.push_str(&format!("foreground = {:?}\n", hex(t.fg)));
            out.push_str(&format!("background = {:?}\n", hex(t.bg)));
            out.push_str(&format!("cursor = {:?}\n", hex(t.cursor)));
            out.push_str(&format!("selection = {:?}\n", hex(t.selection_bg)));
            let ansi: Vec<String> = t.palette.iter().map(|c| format!("{:?}", hex(*c))).collect();
            out.push_str(&format!("ansi = [{}]\n", ansi.join(", ")));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::args::{self, Parsed};

    fn flags(args: &[&str]) -> Options {
        match args::parse(args.iter().map(|s| s.to_string())).unwrap() {
            Parsed::Run(o) => *o,
            other => panic!("not a run: {other:?}"),
        }
    }

    fn file(text: &str) -> FileConfig {
        parse_file(text).unwrap_or_else(|e| panic!("{text:?}: {e}"))
    }

    fn err(text: &str) -> String {
        parse_file(text).expect_err(text)
    }

    const ANSI: &str = r##"["#000001", "#000002", "#000003", "#000004", "#000005", "#000006",
        "#000007", "#000008", "#000009", "#00000a", "#00000b", "#00000c", "#00000d",
        "#00000e", "#00000f", "#000010"]"##;

    #[test]
    fn an_empty_file_sets_nothing() {
        assert_eq!(file(""), FileConfig::default());
        assert_eq!(file("# just a comment\n"), FileConfig::default());
    }

    #[test]
    fn every_key_is_read() {
        let c = file(
            "font_family = \"Fira Code\"\nfont_px = 15.5\nline_height = 1.25\n\
             padding = 4\nblink = false\ntheme = \"light\"\n",
        );
        assert_eq!(c.font_family.as_deref(), Some("Fira Code"));
        assert_eq!(c.font_px, Some(15.5));
        assert_eq!(c.line_height, Some(1.25));
        assert_eq!(c.padding_px, Some(4.0));
        assert_eq!(c.blink, Some(false));
        assert_eq!(c.theme, Some(ThemeSetting::Named(ThemeName::Light)));
    }

    #[test]
    fn whole_numbers_are_numbers() {
        let c = file("font_px = 16\nline_height = 2\npadding = 0\n");
        assert_eq!(
            (c.font_px, c.line_height, c.padding_px),
            (Some(16.0), Some(2.0), Some(0.0))
        );
    }

    #[test]
    fn a_colour_table_overrides_the_base_and_keeps_the_rest() {
        let c = file(&format!(
            "[theme]\nforeground = \"#AABBCC\"\nbackground = \"#010203\"\n\
             cursor = \"#ff0000\"\nselection = \"#00ff00\"\nansi = {ANSI}\n"
        ));
        let Some(ThemeSetting::Custom(t)) = c.theme else {
            panic!("custom theme");
        };
        assert_eq!(t.fg, [0xaa, 0xbb, 0xcc]);
        assert_eq!(t.bg, [1, 2, 3]);
        assert_eq!(t.cursor, [0xff, 0, 0]);
        assert_eq!(t.selection_bg, [0, 0xff, 0]);
        assert_eq!(t.palette[0], [0, 0, 1]);
        assert_eq!(t.palette[15], [0, 0, 0x10]);
        // What the table leaves out comes from the base (dark by default).
        assert_eq!(t.selection_fg, Theme::dark().selection_fg);
    }

    #[test]
    fn a_partial_table_starts_from_its_base() {
        let c = file("[theme]\nbase = \"light\"\ncursor = \"#123456\"\n");
        let Some(ThemeSetting::Custom(t)) = c.theme else {
            panic!("custom theme");
        };
        let light = Theme::light();
        assert_eq!((t.fg, t.bg, t.palette), (light.fg, light.bg, light.palette));
        assert_eq!(t.cursor, [0x12, 0x34, 0x56]);
        // Without a base it is the dark one.
        let c = file("[theme]\ncursor = \"#123456\"\n");
        let Some(ThemeSetting::Custom(t)) = c.theme else {
            panic!("custom theme");
        };
        assert_eq!(t.bg, Theme::dark().bg);
    }

    #[test]
    fn hex_colours_are_strict() {
        assert_eq!(parse_hex("#000000"), Some([0, 0, 0]));
        assert_eq!(parse_hex("#FfA0b1"), Some([0xff, 0xa0, 0xb1]));
        for bad in [
            "", "#", "000000", "#fff", "#12345", "#1234567", "#gggggg", "red", "# 12345", "#+12345",
        ] {
            assert_eq!(parse_hex(bad), None, "{bad:?}");
        }
        assert_eq!(hex([0xaa, 0, 0x0f]), "#aa000f");
    }

    #[test]
    fn errors_name_the_key() {
        let cases: Vec<(&str, Vec<&str>)> = vec![
            ("font_px = 3", vec!["font_px", "between 4 and 200", "got 3"]),
            ("font_px = 300.5", vec!["font_px", "between 4 and 200"]),
            (
                "font_px = \"big\"",
                vec!["font_px", "expected a number", "string"],
            ),
            (
                "line_height = 0.1",
                vec!["line_height", "between 0.5 and 3"],
            ),
            (
                "line_height = true",
                vec!["line_height", "expected a number", "boolean"],
            ),
            ("padding = -1", vec!["padding", "between 0 and 200"]),
            ("blink = \"no\"", vec!["blink", "true or false", "string"]),
            (
                "font_family = 3",
                vec!["font_family", "expected a string", "integer"],
            ),
            ("font_family = \"  \"", vec!["font_family", "empty"]),
            ("theme = \"solarized\"", vec!["theme", "solarized", "dark"]),
            ("theme = 3", vec!["theme", "expected"]),
            ("fontsize = 3", vec!["fontsize", "known keys", "font_px"]),
            (
                "[theme]\nforeground = \"red\"",
                vec!["theme.foreground", "red", "#rrggbb"],
            ),
            (
                "[theme]\nbackground = 5",
                vec!["theme.background", "expected a string"],
            ),
            ("[theme]\nbase = \"neon\"", vec!["theme.base", "neon"]),
            (
                "[theme]\nfg = \"#000000\"",
                vec!["theme", "fg", "known keys", "foreground"],
            ),
            ("[theme]\nansi = \"#000000\"", vec!["theme.ansi", "array"]),
            (
                "[theme]\nansi = [\"#000000\"]",
                vec!["theme.ansi", "16", "got 1"],
            ),
        ];
        for (text, needles) in &cases {
            let e = err(text);
            for n in needles {
                assert!(e.contains(n), "{text:?}: {e:?} should mention {n:?}");
            }
        }
        // The bad entry of the array is named by index.
        let mut items = vec!["\"#000000\""; 16];
        items[7] = "\"nope\"";
        let e = err(&format!("[theme]\nansi = [{}]", items.join(",")));
        assert!(e.contains("theme.ansi[7]") && e.contains("nope"), "{e}");
    }

    #[test]
    fn text_that_is_not_toml_names_its_line() {
        let e = err("font_px = 14\nfont_px = = 3\n");
        assert!(e.starts_with("not valid TOML at line 2"), "{e}");
    }

    #[test]
    fn flags_beat_the_file_and_the_file_beats_the_defaults() {
        let f = file(
            "font_family = \"A\"\nfont_px = 20\nline_height = 1.5\npadding = 2\n\
             blink = false\ntheme = \"light\"\n",
        );
        // Nothing on the command line: the file.
        let r = resolve(Some(&f), &flags(&[]));
        assert_eq!(r.font_family.as_deref(), Some("A"));
        assert_eq!((r.font_px, r.line_height, r.padding_px), (20.0, 1.5, 2.0));
        assert!(!r.cursor_blink);
        assert_eq!(r.theme, ThemeSetting::Named(ThemeName::Light));
        assert!(r.theme_chosen);
        // Every flag overrides its key.
        let r = resolve(
            Some(&f),
            &flags(&[
                "--font-family",
                "B",
                "--font-px",
                "11",
                "--line-height",
                "1.1",
                "--padding",
                "9",
                "--theme",
                "dark",
            ]),
        );
        assert_eq!(r.font_family.as_deref(), Some("B"));
        assert_eq!((r.font_px, r.line_height, r.padding_px), (11.0, 1.1, 9.0));
        assert_eq!(r.theme, ThemeSetting::Named(ThemeName::Dark));
        // `--no-blink` and `blink = true` in the file: the flag wins.
        let on = file("blink = true");
        assert!(!resolve(Some(&on), &flags(&["--no-blink"])).cursor_blink);
        assert!(resolve(Some(&on), &flags(&[])).cursor_blink);
        // A flag does not disturb the keys it does not name.
        let r = resolve(Some(&f), &flags(&["--font-px", "11"]));
        assert_eq!((r.line_height, r.padding_px), (1.5, 2.0));
        assert_eq!(r.font_family.as_deref(), Some("A"));
    }

    #[test]
    fn a_flag_theme_replaces_a_colour_table() {
        let f = file("[theme]\ncursor = \"#123456\"\n");
        let r = resolve(Some(&f), &flags(&["--theme", "light"]));
        assert_eq!(r.theme, ThemeSetting::Named(ThemeName::Light));
    }

    #[test]
    fn with_no_file_and_no_flags_nothing_changes() {
        let r = resolve(None, &flags(&[]));
        assert_eq!(r.font_family, None);
        assert_eq!(r.font_px, 14.0);
        assert_eq!(r.line_height, 1.0);
        assert_eq!(r.padding_px, 8.0);
        assert!(r.cursor_blink);
        assert_eq!(r.theme, ThemeSetting::Named(ThemeName::Dark));
        assert_eq!(r.theme.theme(), Theme::default());
        assert!(
            !r.theme_chosen,
            "the engine is not told a theme nobody chose"
        );
    }

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |key| {
            pairs
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn the_default_path_follows_the_os() {
        let tail = |base: &str| PathBuf::from(base).join("canopy-term").join("config.toml");
        let e = env(&[("HOME", "/home/u")]);
        assert_eq!(
            default_path(&e, false),
            Some(tail(
                &PathBuf::from("/home/u").join(".config").to_string_lossy()
            ))
        );
        let e = env(&[("HOME", "/home/u"), ("XDG_CONFIG_HOME", "/x/cfg")]);
        assert_eq!(default_path(&e, false), Some(tail("/x/cfg")));
        let e = env(&[("HOME", "/home/u"), ("XDG_CONFIG_HOME", "")]);
        assert!(default_path(&e, false)
            .unwrap()
            .starts_with(PathBuf::from("/home/u").join(".config")));
        let e = env(&[
            ("APPDATA", "C:\\Users\\u\\AppData\\Roaming"),
            ("HOME", "/h"),
        ]);
        assert_eq!(
            default_path(&e, true),
            Some(tail("C:\\Users\\u\\AppData\\Roaming"))
        );
        assert_eq!(default_path(&env(&[]), false), None);
        assert_eq!(default_path(&env(&[("HOME", "/h")]), true), None);
    }

    fn reader(path: &'static str, text: &'static str) -> impl Fn(&Path) -> std::io::Result<String> {
        move |p| {
            if p == Path::new(path) {
                Ok(text.to_string())
            } else {
                Err(std::io::ErrorKind::NotFound.into())
            }
        }
    }

    #[test]
    fn the_environment_names_the_file_and_beats_the_default_location() {
        let e = env(&[("CANOPY_TERM_CONFIG", "/etc/t.toml"), ("HOME", "/home/u")]);
        let got = load(&e, false, &reader("/etc/t.toml", "font_px = 18")).unwrap();
        let got = got.expect("found");
        assert_eq!(got.path, PathBuf::from("/etc/t.toml"));
        assert_eq!(got.config.font_px, Some(18.0));
    }

    #[test]
    fn a_missing_default_file_is_fine_but_a_missing_named_one_is_not() {
        let e = env(&[("HOME", "/home/u")]);
        assert_eq!(load(&e, false, &reader("/nowhere", "")).unwrap(), None);
        // No HOME at all: no file to look for.
        assert_eq!(
            load(&env(&[]), false, &reader("/nowhere", "")).unwrap(),
            None
        );
        let e = env(&[("CANOPY_TERM_CONFIG", "/etc/t.toml")]);
        let m = load(&e, false, &reader("/nowhere", "")).unwrap_err();
        assert!(
            m.contains("/etc/t.toml") && m.contains("CANOPY_TERM_CONFIG"),
            "{m}"
        );
        // An empty value counts as unset.
        let e = env(&[("CANOPY_TERM_CONFIG", ""), ("HOME", "/home/u")]);
        assert_eq!(load(&e, false, &reader("/nowhere", "")).unwrap(), None);
    }

    #[test]
    fn a_bad_file_error_names_the_file_and_the_key() {
        let e = env(&[("CANOPY_TERM_CONFIG", "/etc/t.toml")]);
        let m = load(&e, false, &reader("/etc/t.toml", "font_px = 1")).unwrap_err();
        assert!(m.contains("/etc/t.toml") && m.contains("font_px"), "{m}");
    }

    #[test]
    fn an_unreadable_default_file_is_reported() {
        let e = env(&[("HOME", "/home/u")]);
        let deny = |_: &Path| -> std::io::Result<String> {
            Err(std::io::ErrorKind::PermissionDenied.into())
        };
        let m = load(&e, false, &deny).unwrap_err();
        assert!(m.contains("cannot read config"), "{m}");
    }

    const EXAMPLE: &str = include_str!("../config.example.toml");

    #[test]
    fn the_example_file_parses_and_says_the_defaults() {
        let c = file(EXAMPLE);
        let r = resolve(Some(&c), &flags(&[]));
        let d = resolve(None, &flags(&[]));
        assert_eq!(
            (r.font_px, r.line_height, r.padding_px, r.cursor_blink),
            (d.font_px, d.line_height, d.padding_px, d.cursor_blink)
        );
        assert_eq!(r.font_family, d.font_family);
        assert_eq!(r.theme, d.theme);
    }

    #[test]
    fn the_samples_in_the_example_file_work_when_uncommented() {
        let text: String = EXAMPLE
            .lines()
            .filter(|l| !l.starts_with("theme = "))
            .map(|l| format!("{}\n", l.strip_prefix("#~ ").unwrap_or(l)))
            .collect();
        let c = file(&text);
        assert_eq!(c.font_family.as_deref(), Some("Fira Code"));
        // The sample colour table is the dark theme written out.
        assert_eq!(c.theme, Some(ThemeSetting::Custom(Box::new(Theme::dark()))),);
    }

    #[test]
    fn print_config_round_trips() {
        let f = file(&format!(
            "font_family = \"Fira Code\"\nfont_px = 15.5\nline_height = 1.25\npadding = 4\n\
             blink = false\n[theme]\nbase = \"light\"\nforeground = \"#102030\"\nansi = {ANSI}\n"
        ));
        let r = resolve(Some(&f), &flags(&[]));
        let text = render(&r, Some(Path::new("/c.toml")));
        assert!(text.starts_with("# config file: /c.toml\n"));
        let again = resolve(Some(&file(&text)), &flags(&[]));
        assert_eq!(again, r);
        // A built-in theme and the defaults round-trip too.
        let r = resolve(None, &flags(&["--theme", "light"]));
        let text = render(&r, None);
        assert!(text.contains("config file: none") && text.contains("theme = \"light\""));
        assert_eq!(resolve(Some(&file(&text)), &flags(&[])), r);
    }
}
