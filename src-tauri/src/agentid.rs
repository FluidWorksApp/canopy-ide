//! What is this terminal actually running?
//!
//! The Agents panel used to answer that by scanning a session's whole process
//! tree for a name matching a regex of known agent CLIs. Three things made that
//! wrong: the pattern was tested against full executable paths (so anything
//! living under `~/.omp/` or `/goose/` matched), a *descendant* could name the
//! row instead of the thing you launched, and a language runtime reports the
//! runtime's name, so `python foo.py` is only ever "Python" — identity lives in
//! the script, which the tree scan never looked at.
//!
//! So this module answers a narrower question with a definite answer: given the
//! process in the pty's foreground, what binary is it *really*? That means
//! following two indirections the name hides:
//!
//!   1. **Runtimes.** `node .../cli.js`, `python foo.py` — the executable is the
//!      interpreter and says nothing. The first argument that is a real file is
//!      the thing with an identity.
//!   2. **Symlinks and wrappers.** A CLI installed as `acme-claude`, or reached
//!      through a shim in `~/.local/bin`, resolves to the package that actually
//!      ships it.
//!
//! What it deliberately does not do is decide *which agent* that is. Mapping a
//! package or a binary name to a registry id belongs with the registry, which
//! lives in the frontend (AGENT_CLIS in projects.ts); this side supplies the
//! evidence, because resolving it needs the filesystem. Nothing here guesses:
//! an unrecognised binary yields its own name and no package, and the caller is
//! expected to render that as a plain terminal rather than invent a brand.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// What the process in a terminal's foreground actually is.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct AgentHint {
    /// Basename of the thing being run, after resolving through any runtime —
    /// `claude`, `omp`, `cli.js`, `train.py`. Taken before symlinks are
    /// followed, because the name you invoked is the name you recognise.
    pub bin: String,
    /// Package that ships the resolved executable, when one can be determined:
    /// `npm:@anthropic-ai/claude-code`, `brew:omp`, `pypi:aider-chat`. This is
    /// what survives an enterprise wrapper renaming the binary.
    pub pkg: Option<String>,
    /// Canonical path of the resolved executable — stable across the shims that
    /// point at it, so it can key a learned binary -> agent mapping.
    pub path: Option<String>,
    /// The foreground app has taken the tty out of line mode: something
    /// full-screen and interactive is in control, not a batch script.
    pub interactive: bool,
}

/// Language runtimes: their own name identifies the interpreter, never the
/// program. Python is matched by prefix because it ships as `python3`,
/// `python3.14`, and (in macOS framework builds) `Python`.
const RUNTIMES: &[&str] = &[
    "node", "nodejs", "deno", "bun", "ruby", "perl", "php", "java", "uv", "uvx", "pipx", "tsx",
    "ts-node", "electron",
];

/// Flags that swallow the next argument, so it is never the script.
const VALUE_FLAGS: &[&str] = &[
    "-m",
    "-c",
    "-e",
    "--eval",
    "-r",
    "--require",
    "--import",
    "--loader",
    "--experimental-loader",
    "-jar",
    "-cp",
    "-classpath",
    "--with",
    "--python",
];

/// Imports every setuptools console script carries, which say nothing about
/// which distribution it belongs to.
const STDLIB_NOISE: &[&str] = &["re", "sys", "os", "importlib", "pathlib", "__future__"];

/// Interactive shells — the process sitting at the root of a plain terminal.
/// Login shells arrive as `-zsh`, hence the leading dash. Mirrors
/// SHELL_PATTERN in projects.ts.
pub fn is_shell(name: &str) -> bool {
    matches!(
        name.trim_start_matches('-').to_ascii_lowercase().as_str(),
        "zsh"
            | "bash"
            | "sh"
            | "fish"
            | "dash"
            | "tcsh"
            | "csh"
            | "ksh"
            | "nu"
            | "pwsh"
            | "powershell"
            | "cmd"
            | "cmd.exe"
    )
}

fn base(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn is_runtime(name: &str) -> bool {
    let n = name.trim_end_matches(".exe").to_ascii_lowercase();
    if RUNTIMES.contains(&n.as_str()) {
        return true;
    }
    // python, python3, python3.14 — but not "pythonish-tool".
    n.strip_prefix("python")
        .is_some_and(|rest| rest.chars().all(|c| c.is_ascii_digit() || c == '.'))
}

/// The first argument that is a program rather than a flag or a subcommand.
///
/// `uv run train.py` and `node --inspect cli.js` both have to land on the last
/// token; existence on disk is the test that separates a path from a
/// subcommand, with a shape check as the fallback for a script that has since
/// been moved or is relative to a directory the terminal has cd'd out of.
fn script_arg(argv: &[String], cwd: &Path) -> Option<PathBuf> {
    let mut i = 1;
    while i < argv.len() {
        let arg = &argv[i];
        if arg.starts_with('-') {
            i += if VALUE_FLAGS.contains(&arg.as_str()) {
                2
            } else {
                1
            };
            continue;
        }
        let path = if Path::new(arg).is_absolute() {
            PathBuf::from(arg)
        } else {
            cwd.join(arg)
        };
        if path.is_file() {
            return Some(path);
        }
        if arg.contains('/') || arg.contains('.') {
            return Some(PathBuf::from(arg));
        }
        i += 1;
    }
    None
}

/// Homebrew keeps every formula at `.../Cellar/<formula>/<version>/...`, so the
/// component after Cellar is the package name.
fn brew_formula(path: &Path) -> Option<String> {
    let parts: Vec<String> = path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    let idx = parts.iter().position(|p| p == "Cellar")?;
    parts.get(idx + 1).cloned()
}

/// Nearest `package.json` above the executable, which is the package that ships
/// it however it was installed — npm, pnpm's content-addressed store, bun, a
/// global prefix, or a checkout someone `npm link`ed.
fn npm_package(path: &Path) -> Option<String> {
    let mut dir = path.parent()?;
    // Deep enough for `dist/`, `bin/`, `lib/` layouts; shallow enough that we
    // never wander out of a package and adopt an unrelated manifest.
    for _ in 0..5 {
        let manifest = dir.join("package.json");
        if manifest.is_file() {
            let text = std::fs::read_to_string(&manifest).ok()?;
            let json: serde_json::Value = serde_json::from_str(&text).ok()?;
            return json.get("name")?.as_str().map(str::to_string);
        }
        dir = dir.parent()?;
    }
    None
}

/// The distribution behind a Python console script. Those are generated stubs
/// whose real content is one import of the package's entry point, so the last
/// non-boilerplate `from X import` names the distribution.
fn python_dist(path: &Path) -> Option<String> {
    let head = read_head(path, 4096)?;
    if !head.starts_with("#!") || !head.lines().next()?.contains("python") {
        return None;
    }
    let mut found = None;
    for line in head.lines() {
        let Some(rest) = line.strip_prefix("from ") else {
            continue;
        };
        let module = rest.split(['.', ' ']).next().unwrap_or("").trim();
        if module.is_empty() || STDLIB_NOISE.contains(&module) {
            continue;
        }
        found = Some(module.to_string());
    }
    found
}

/// First `n` bytes of a file as text, or None if it is not text at all — this
/// runs against arbitrary executables, most of which are binaries.
fn read_head(path: &Path, n: usize) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0_u8; n];
    let read = file.read(&mut buf).ok()?;
    buf.truncate(read);
    if buf.starts_with(b"\x7fELF") || buf.starts_with(&[0xcf, 0xfa, 0xed, 0xfe]) {
        return None;
    }
    String::from_utf8(buf).ok()
}

fn package_of(path: &Path) -> Option<String> {
    if let Some(formula) = brew_formula(path) {
        return Some(format!("brew:{formula}"));
    }
    if let Some(pkg) = npm_package(path) {
        return Some(format!("npm:{pkg}"));
    }
    // `py:` names the import package visible in a generated console script;
    // the PyPI distribution name (for example aider-chat) is not present there.
    python_dist(path).map(|dist| format!("py:{dist}"))
}

/// Resolves executables to identities, remembering what it has already looked
/// up. Every input is a path that changes only when a CLI is reinstalled, so
/// the steady-state cost of identification is a hash lookup — the filesystem
/// work happens once per binary, not once per terminal per tick.
#[derive(Default)]
pub struct Resolver {
    cache: HashMap<String, (Option<SystemTime>, AgentHint)>,
}

impl Resolver {
    /// Identify the process running `argv`. `exe` is the executable path when
    /// the OS gave us one (it is more trustworthy than argv[0], which the
    /// process chooses); `cwd` anchors relative script paths.
    pub fn hint(&mut self, argv: &[String], exe: Option<&Path>, cwd: &Path) -> Option<AgentHint> {
        let invoked = exe
            .map(Path::to_path_buf)
            .or_else(|| argv.first().map(PathBuf::from))?;
        let target = if is_runtime(&base(&invoked)) {
            script_arg(argv, cwd).unwrap_or(invoked)
        } else {
            invoked
        };
        let key = target.to_string_lossy().to_string();
        if key.is_empty() {
            return None;
        }
        // Reinstalls and upgrades land a new binary at the same path, so the
        // cache is keyed on the path *and* what is at it.
        let stamp = std::fs::metadata(&target).and_then(|m| m.modified()).ok();
        if let Some((seen, hint)) = self.cache.get(&key) {
            if *seen == stamp {
                return Some(hint.clone());
            }
        }
        let resolved = std::fs::canonicalize(&target).ok();
        let hint = AgentHint {
            // The invoked name, not the resolved one: npm bins are symlinks to
            // a `cli.js`, and "claude" is what the user typed and recognises.
            bin: base(&target),
            pkg: resolved.as_deref().and_then(package_of),
            path: resolved.map(|p| p.to_string_lossy().to_string()),
            interactive: false,
        };
        self.cache.insert(key, (stamp, hint.clone()));
        Some(hint)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("canopy-agentid-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn runtimes_are_recognised_without_swallowing_neighbours() {
        for name in ["node", "Python", "python3", "python3.14", "bun", "uv"] {
            assert!(is_runtime(name), "{name} should be a runtime");
        }
        for name in ["claude", "omp", "pythonic", "nodemon", "codex"] {
            assert!(!is_runtime(name), "{name} should not be a runtime");
        }
    }

    #[test]
    fn script_arg_skips_flags_and_subcommands() {
        let dir = scratch("script-arg");
        let script = dir.join("train.py");
        std::fs::write(&script, "print(1)").unwrap();
        // A subcommand ("run") is not a file, so the scan keeps going.
        assert_eq!(
            script_arg(&argv(&["uv", "run", "train.py"]), &dir),
            Some(script.clone())
        );
        // Flags that take a value never contribute the value.
        assert_eq!(
            script_arg(&argv(&["python3", "-m", "http.server"]), &dir),
            None
        );
        assert_eq!(
            script_arg(&argv(&["node", "--inspect", "train.py"]), &dir),
            Some(script)
        );
    }

    #[test]
    fn npm_package_survives_a_renamed_binary() {
        let dir = scratch("npm");
        let pkg = dir.join("node_modules/@anthropic-ai/claude-code");
        std::fs::create_dir_all(pkg.join("dist")).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"name":"@anthropic-ai/claude-code","version":"1.0.0"}"#,
        )
        .unwrap();
        let cli = pkg.join("dist/cli.js");
        std::fs::write(&cli, "#!/usr/bin/env node\n").unwrap();
        assert_eq!(
            package_of(&cli).as_deref(),
            Some("npm:@anthropic-ai/claude-code")
        );
    }

    #[test]
    fn brew_formula_comes_from_the_cellar_path() {
        assert_eq!(
            brew_formula(Path::new("/opt/homebrew/Cellar/omp/17.0.5/bin/omp")).as_deref(),
            Some("omp")
        );
        assert_eq!(brew_formula(Path::new("/usr/local/bin/omp")), None);
    }

    #[test]
    fn python_console_script_names_its_distribution() {
        let dir = scratch("pydist");
        let script = dir.join("aider");
        std::fs::write(
            &script,
            "#!/usr/bin/env python3\nimport re\nimport sys\nfrom aider.main import main\n",
        )
        .unwrap();
        assert_eq!(python_dist(&script).as_deref(), Some("aider"));
        assert_eq!(package_of(&script).as_deref(), Some("py:aider"));
    }

    #[test]
    fn a_python_script_is_itself_not_its_interpreter() {
        let dir = scratch("hint-python");
        let script = dir.join("train.py");
        std::fs::write(&script, "print(1)").unwrap();
        let mut resolver = Resolver::default();
        let hint = resolver
            .hint(
                &argv(&["/usr/bin/python3", "train.py"]),
                Some(Path::new("/usr/bin/python3")),
                &dir,
            )
            .unwrap();
        // The bug this module exists for: identity is the script, and a script
        // nobody ships carries no package to mistake for an agent.
        assert_eq!(hint.bin, "train.py");
        assert_eq!(hint.pkg, None);
    }

    #[test]
    fn a_node_hosted_cli_resolves_to_its_package() {
        let dir = scratch("hint-node");
        let pkg = dir.join("node_modules/@sourcegraph/amp");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("package.json"), r#"{"name":"@sourcegraph/amp"}"#).unwrap();
        let cli = pkg.join("cli.js");
        std::fs::write(&cli, "// entry\n").unwrap();
        let mut resolver = Resolver::default();
        let hint = resolver
            .hint(
                &argv(&["node", cli.to_str().unwrap()]),
                Some(Path::new("/opt/homebrew/bin/node")),
                &dir,
            )
            .unwrap();
        assert_eq!(hint.bin, "cli.js");
        assert_eq!(hint.pkg.as_deref(), Some("npm:@sourcegraph/amp"));
    }

    #[test]
    fn results_are_cached_per_binary() {
        let dir = scratch("cache");
        let bin = dir.join("claude");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        let mut resolver = Resolver::default();
        let first = resolver.hint(&argv(&["claude"]), Some(&bin), &dir).unwrap();
        assert_eq!(first.bin, "claude");
        // Unchanged on disk: answered from the cache rather than re-walked.
        // Poisoning the entry is the only way to observe that from outside.
        let stamp = std::fs::metadata(&bin).and_then(|m| m.modified()).ok();
        resolver.cache.insert(
            bin.to_string_lossy().to_string(),
            (
                stamp,
                AgentHint {
                    bin: "sentinel".into(),
                    ..Default::default()
                },
            ),
        );
        let cached = resolver.hint(&argv(&["claude"]), Some(&bin), &dir).unwrap();
        assert_eq!(cached.bin, "sentinel");
        // A reinstall lands a new binary at the same path and must invalidate.
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(&bin, "#!/bin/sh\n# v2\n").unwrap();
        let fresh = resolver.hint(&argv(&["claude"]), Some(&bin), &dir).unwrap();
        assert_eq!(fresh.bin, "claude");
    }
}
