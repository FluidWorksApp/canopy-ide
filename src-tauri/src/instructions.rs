//! Agent instruction files: discovery, reading and writing.
//!
//! Every agent Canopy launches is shaped by markdown on disk it never shows the
//! user — `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/*.mdc`, `SKILL.md` packs,
//! subagent definitions — spread across the project *and* the home directory, in
//! locations that differ per CLI. This module is the map.
//!
//! Two cross-agent standards carry most of it. `AGENTS.md` is the vendor-neutral
//! one (Agentic AI Foundation), read by Codex, Cursor, Copilot, Gemini CLI,
//! Aider, Amp, opencode, Factory and others. `SKILL.md` is Anthropic's Agent
//! Skills spec, open since Dec 2025 and now read by 30-odd tools — hence the
//! `skills/` directory under `~/.claude`, `~/.codex`, `~/.gemini`, `~/.cursor`,
//! `~/.config/opencode`, `~/.config/goose`, `~/.factory` and `~/.qwen` alike.
//!
//! ## Why this isn't in fsx.rs
//!
//! `~/.claude/CLAUDE.md` sits outside every workspace root, so `fsx::check_scope`
//! refuses it — correctly. Widening the workspace roots to `$HOME` to reach it
//! would hand every agent-facing fs command the user's whole home directory, so
//! instead this module carries its own, far narrower gate: a path is reachable
//! only if it is, *by name and location*, one of the instruction files below.
//! The gate is recomputed here on every read and write and never trusted from
//! the frontend. Config files (`settings.json`, `config.toml`, `.mcp.json`) are
//! deliberately not in the table: this is the instruction surface, and handing
//! out an editor for an agent's permissions file is a different decision.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Agents that read the vendor-neutral `AGENTS.md`. Claude Code is in here too:
/// it reads `AGENTS.md` alongside its own `CLAUDE.md`.
const AGENTS_MD: &[&str] = &[
    "claude",
    "codex",
    "cursor-agent",
    "copilot",
    "gemini",
    "amp",
    "aider",
    "opencode",
    "goose",
    "qwen",
    "droid",
    "omp",
];

/// Agents that read the Agent Skills standard (`<name>/SKILL.md`).
const SKILL_MD: &[&str] = &[
    "claude",
    "codex",
    "cursor-agent",
    "copilot",
    "gemini",
    "opencode",
    "goose",
    "droid",
    "qwen",
];

const CLAUDE: &[&str] = &["claude"];
const CODEX: &[&str] = &["codex"];
const GEMINI: &[&str] = &["gemini", "agy"];
const CURSOR: &[&str] = &["cursor-agent"];
const COPILOT: &[&str] = &["copilot"];
const OPENCODE: &[&str] = &["opencode"];
const GOOSE: &[&str] = &["goose"];
const QWEN: &[&str] = &["qwen"];
const DROID: &[&str] = &["droid"];
const AMP: &[&str] = &["amp"];
const AIDER: &[&str] = &["aider"];
const WINDSURF: &[&str] = &["windsurf"];
const JUNIE: &[&str] = &["junie"];
const CLINE: &[&str] = &["cline"];
const KIRO: &[&str] = &["kiro"];
const ROO: &[&str] = &["roo"];
const CONTINUE: &[&str] = &["continue"];
const ZED: &[&str] = &["zed"];

/// Where a spec's files live relative to their root.
#[derive(Clone, Copy)]
enum Loc {
    /// One file at a fixed relative path — the only shape that gets a "missing,
    /// create it?" row, since a glob with no matches names no file to create.
    File(&'static str),
    /// Every `<dir>/*.<ext>`, one level down. Claude namespaces commands in
    /// subdirectories; those are reachable through the file tree, not here.
    Dir(&'static str, &'static str),
    /// Every `<dir>/*/<file>` — the Agent Skills shape.
    Pack(&'static str, &'static str),
    /// A file that may appear at any depth in the project (`AGENTS.md` is
    /// per-directory, closest-wins). Walked to `MAX_NEST` levels.
    Nested(&'static str),
}

#[derive(Clone, Copy, PartialEq)]
enum Scope {
    Project,
    Global,
}

struct Spec {
    loc: Loc,
    kind: &'static str,
    agents: &'static [&'static str],
    scope: Scope,
}

/// How deep to look for nested `AGENTS.md`/`CLAUDE.md`. Four covers the
/// `packages/<pkg>/src/<area>` shape without turning discovery into a full tree
/// walk of a monorepo.
const MAX_NEST: usize = 4;

/// Never descended into. Everything here is either machine-generated or someone
/// else's source — a vendored `AGENTS.md` is not this project's instruction.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    "target",
    "vendor",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".cache",
    "coverage",
];

/// The map itself: who reads what, and where it lives.
///
/// `rustfmt::skip` because this is a data table, and one row per line is what
/// makes it checkable against the CLIs' own documentation. Formatted normally
/// each row becomes six lines and the table becomes 280 lines of punctuation.
#[rustfmt::skip]
fn specs() -> Vec<Spec> {
    vec![
        // ---- project, cross-agent ----
        Spec { loc: Loc::Nested("AGENTS.md"), kind: "instructions", agents: AGENTS_MD, scope: Scope::Project },
        Spec { loc: Loc::File("AGENTS.override.md"), kind: "instructions", agents: CODEX, scope: Scope::Project },
        Spec { loc: Loc::Nested("CLAUDE.md"), kind: "instructions", agents: CLAUDE, scope: Scope::Project },
        Spec { loc: Loc::File("CLAUDE.local.md"), kind: "instructions", agents: CLAUDE, scope: Scope::Project },
        Spec { loc: Loc::File("GEMINI.md"), kind: "instructions", agents: GEMINI, scope: Scope::Project },
        Spec { loc: Loc::File("AGENT.md"), kind: "instructions", agents: AMP, scope: Scope::Project },
        Spec { loc: Loc::File("QWEN.md"), kind: "instructions", agents: QWEN, scope: Scope::Project },
        Spec { loc: Loc::File("CONVENTIONS.md"), kind: "instructions", agents: AIDER, scope: Scope::Project },
        // ---- project, Claude Code ----
        Spec { loc: Loc::Dir(".claude/rules", "md"), kind: "rule", agents: CLAUDE, scope: Scope::Project },
        Spec { loc: Loc::Pack(".claude/skills", "SKILL.md"), kind: "skill", agents: SKILL_MD, scope: Scope::Project },
        Spec { loc: Loc::Dir(".claude/agents", "md"), kind: "subagent", agents: CLAUDE, scope: Scope::Project },
        Spec { loc: Loc::Dir(".claude/commands", "md"), kind: "command", agents: CLAUDE, scope: Scope::Project },
        Spec { loc: Loc::Dir(".claude/output-styles", "md"), kind: "style", agents: CLAUDE, scope: Scope::Project },
        // ---- project, other CLIs ----
        Spec { loc: Loc::Dir(".cursor/rules", "mdc"), kind: "rule", agents: CURSOR, scope: Scope::Project },
        Spec { loc: Loc::File(".cursorrules"), kind: "instructions", agents: CURSOR, scope: Scope::Project },
        Spec { loc: Loc::File(".github/copilot-instructions.md"), kind: "instructions", agents: COPILOT, scope: Scope::Project },
        Spec { loc: Loc::Dir(".github/instructions", "md"), kind: "rule", agents: COPILOT, scope: Scope::Project },
        Spec { loc: Loc::Dir(".github/prompts", "md"), kind: "command", agents: COPILOT, scope: Scope::Project },
        Spec { loc: Loc::Pack(".github/skills", "SKILL.md"), kind: "skill", agents: SKILL_MD, scope: Scope::Project },
        Spec { loc: Loc::File(".goosehints"), kind: "instructions", agents: GOOSE, scope: Scope::Project },
        Spec { loc: Loc::File(".windsurfrules"), kind: "instructions", agents: WINDSURF, scope: Scope::Project },
        Spec { loc: Loc::Dir(".windsurf/rules", "md"), kind: "rule", agents: WINDSURF, scope: Scope::Project },
        Spec { loc: Loc::File(".junie/guidelines.md"), kind: "instructions", agents: JUNIE, scope: Scope::Project },
        Spec { loc: Loc::Dir(".clinerules", "md"), kind: "rule", agents: CLINE, scope: Scope::Project },
        Spec { loc: Loc::Dir(".kiro/steering", "md"), kind: "rule", agents: KIRO, scope: Scope::Project },
        Spec { loc: Loc::Dir(".roo/rules", "md"), kind: "rule", agents: ROO, scope: Scope::Project },
        Spec { loc: Loc::Dir(".continue/rules", "md"), kind: "rule", agents: CONTINUE, scope: Scope::Project },
        Spec { loc: Loc::File(".rules"), kind: "instructions", agents: ZED, scope: Scope::Project },
        // ---- global (relative to $HOME) ----
        Spec { loc: Loc::File(".claude/CLAUDE.md"), kind: "instructions", agents: CLAUDE, scope: Scope::Global },
        Spec { loc: Loc::Dir(".claude/rules", "md"), kind: "rule", agents: CLAUDE, scope: Scope::Global },
        Spec { loc: Loc::Pack(".claude/skills", "SKILL.md"), kind: "skill", agents: CLAUDE, scope: Scope::Global },
        Spec { loc: Loc::Dir(".claude/agents", "md"), kind: "subagent", agents: CLAUDE, scope: Scope::Global },
        Spec { loc: Loc::Dir(".claude/commands", "md"), kind: "command", agents: CLAUDE, scope: Scope::Global },
        Spec { loc: Loc::Dir(".claude/output-styles", "md"), kind: "style", agents: CLAUDE, scope: Scope::Global },
        Spec { loc: Loc::File(".codex/AGENTS.md"), kind: "instructions", agents: CODEX, scope: Scope::Global },
        Spec { loc: Loc::File(".codex/AGENTS.override.md"), kind: "instructions", agents: CODEX, scope: Scope::Global },
        Spec { loc: Loc::Dir(".codex/rules", "rules"), kind: "rule", agents: CODEX, scope: Scope::Global },
        Spec { loc: Loc::Dir(".codex/rules", "md"), kind: "rule", agents: CODEX, scope: Scope::Global },
        Spec { loc: Loc::Pack(".codex/skills", "SKILL.md"), kind: "skill", agents: CODEX, scope: Scope::Global },
        Spec { loc: Loc::File(".gemini/GEMINI.md"), kind: "instructions", agents: GEMINI, scope: Scope::Global },
        Spec { loc: Loc::Pack(".gemini/skills", "SKILL.md"), kind: "skill", agents: GEMINI, scope: Scope::Global },
        Spec { loc: Loc::Pack(".cursor/skills", "SKILL.md"), kind: "skill", agents: CURSOR, scope: Scope::Global },
        Spec { loc: Loc::File(".config/opencode/AGENTS.md"), kind: "instructions", agents: OPENCODE, scope: Scope::Global },
        Spec { loc: Loc::Pack(".config/opencode/skills", "SKILL.md"), kind: "skill", agents: OPENCODE, scope: Scope::Global },
        Spec { loc: Loc::File(".config/goose/.goosehints"), kind: "instructions", agents: GOOSE, scope: Scope::Global },
        Spec { loc: Loc::Pack(".config/goose/skills", "SKILL.md"), kind: "skill", agents: GOOSE, scope: Scope::Global },
        Spec { loc: Loc::File(".config/amp/AGENTS.md"), kind: "instructions", agents: AMP, scope: Scope::Global },
        Spec { loc: Loc::File(".factory/AGENTS.md"), kind: "instructions", agents: DROID, scope: Scope::Global },
        Spec { loc: Loc::Pack(".factory/skills", "SKILL.md"), kind: "skill", agents: DROID, scope: Scope::Global },
        Spec { loc: Loc::File(".qwen/QWEN.md"), kind: "instructions", agents: QWEN, scope: Scope::Global },
        Spec { loc: Loc::Pack(".qwen/skills", "SKILL.md"), kind: "skill", agents: QWEN, scope: Scope::Global },
    ]
}

#[derive(Serialize, Clone)]
pub struct InstructionFile {
    pub path: String,
    /// instructions | rule | skill | subagent | command | style
    pub kind: String,
    /// project | global
    pub scope: String,
    /// Agent ids that read this file (projects.ts registry ids).
    pub agents: Vec<String>,
    /// Display name: relative to its root, `~`-prefixed when global.
    pub label: String,
    /// Which workspace root it belongs to; empty for global files.
    pub root: String,
    pub exists: bool,
    pub bytes: u64,
    /// Unix seconds.
    pub modified: Option<u64>,
    /// `name`/`description` from YAML frontmatter — what a skill or subagent
    /// calls itself, which is far more use in a list than its filename.
    pub title: Option<String>,
    pub description: Option<String>,
}

fn home() -> Option<PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(PathBuf::from)
}

/// `name:` and `description:` from a leading `---` YAML block. Deliberately not
/// a YAML parser: two scalar keys out of a frontmatter block is the whole job,
/// and a malformed block should degrade to "no title", never to an error.
fn frontmatter_fields(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return (None, None);
    };
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let (mut name, mut desc) = (None, None);
    for line in lines.take(40) {
        let t = line.trim();
        if t == "---" {
            break;
        }
        if let Some(v) = t.strip_prefix("name:") {
            name = Some(unquote(v));
        } else if let Some(v) = t.strip_prefix("description:") {
            desc = Some(unquote(v));
        }
    }
    (name, desc)
}

fn unquote(v: &str) -> String {
    let t = v.trim();
    t.strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| t.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
        .unwrap_or(t)
        .to_string()
}

fn describe(
    path: &Path,
    spec_kind: &str,
    agents: &[&str],
    scope: Scope,
    root: &Path,
    label: String,
) -> InstructionFile {
    let meta = std::fs::metadata(path).ok();
    let exists = meta.as_ref().map(|m| m.is_file()).unwrap_or(false);
    // Only the shapes that actually carry frontmatter pay for the read.
    let (title, description) = if exists
        && matches!(
            spec_kind,
            "skill" | "subagent" | "command" | "rule" | "style"
        ) {
        frontmatter_fields(path)
    } else {
        (None, None)
    };
    InstructionFile {
        path: path.to_string_lossy().to_string(),
        kind: spec_kind.to_string(),
        scope: if scope == Scope::Global {
            "global"
        } else {
            "project"
        }
        .to_string(),
        agents: agents.iter().map(|s| s.to_string()).collect(),
        label,
        root: if scope == Scope::Global {
            String::new()
        } else {
            root.to_string_lossy().to_string()
        },
        exists,
        bytes: meta.as_ref().map(|m| m.len()).unwrap_or(0),
        modified: meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs()),
        title,
        description,
    }
}

/// Files matching `name` at any depth up to `MAX_NEST` below `root`.
fn walk_nested(root: &Path, name: &str, depth: usize, out: &mut Vec<PathBuf>) {
    let candidate = root.join(name);
    if candidate.is_file() {
        out.push(candidate);
    }
    if depth >= MAX_NEST {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        // Symlinks deliberately NOT followed here, unlike the skills case: this
        // recurses, and a link pointing at an ancestor would walk forever.
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir_name = entry.file_name();
        let dir_name = dir_name.to_string_lossy();
        // Dotdirs are the agents' own config, enumerated by their own specs —
        // walking them here would list `.claude/worktrees/<x>/CLAUDE.md`, which
        // is a checkout of this same file, not a second instruction.
        if dir_name.starts_with('.') || SKIP_DIRS.contains(&dir_name.as_ref()) {
            continue;
        }
        walk_nested(&entry.path(), name, depth + 1, out);
    }
}

fn expand(spec: &Spec, root: &Path) -> Vec<(PathBuf, String)> {
    match spec.loc {
        Loc::File(rel) => vec![(root.join(rel), rel.to_string())],
        Loc::Nested(name) => {
            let mut found = Vec::new();
            walk_nested(root, name, 0, &mut found);
            if found.is_empty() {
                // Nothing on disk: still offer the root one, so a project with no
                // AGENTS.md has somewhere to create it.
                return vec![(root.join(name), name.to_string())];
            }
            found
                .into_iter()
                .map(|p| {
                    let label = p
                        .strip_prefix(root)
                        .map(|r| r.to_string_lossy().to_string())
                        .unwrap_or_else(|_| name.to_string());
                    (p, label)
                })
                .collect()
        }
        Loc::Dir(dir, ext) => {
            let mut out = Vec::new();
            if let Ok(entries) = std::fs::read_dir(root.join(dir)) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.extension().map(|e| e == ext).unwrap_or(false) && p.is_file() {
                        let name = p
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string();
                        out.push((p, format!("{dir}/{name}")));
                    }
                }
            }
            out
        }
        Loc::Pack(dir, file) => {
            let mut out = Vec::new();
            if let Ok(entries) = std::fs::read_dir(root.join(dir)) {
                for entry in entries.flatten() {
                    // `path().is_dir()` follows symlinks where `file_type()`
                    // reports the link itself. That distinction is the whole
                    // feature here: sharing one skill across CLIs by symlinking
                    // it into each `skills/` dir is the normal setup, and
                    // checking the link type skips every shared skill.
                    if !entry.path().is_dir() {
                        continue;
                    }
                    let p = entry.path().join(file);
                    if p.is_file() {
                        let pack = entry.file_name().to_string_lossy().to_string();
                        out.push((p, format!("{dir}/{pack}/{file}")));
                    }
                }
            }
            out
        }
    }
}

/// Every instruction file the given project roots and this user's home carry —
/// plus, for the fixed-path specs, the ones that *aren't* there yet, so a
/// project set up with a CLI that has no instruction file still shows the row
/// and can create it.
#[tauri::command]
pub async fn instructions_scan(roots: Vec<String>) -> Result<Vec<InstructionFile>, String> {
    let all = specs();
    let mut out: Vec<InstructionFile> = Vec::new();
    // Keyed on the *canonical* path, so one file reached by several routes is
    // one row. This is not a nicety: sharing a skill across CLIs by symlinking
    // it into each tool's `skills/` is the normal setup, and without this a
    // single `nano-banana-pro` lists eight times — once per agent — when what
    // it actually is, is one skill that eight agents read. Merging the agent
    // lists says that, and the chips on the row show it.
    let mut seen: Vec<(PathBuf, usize)> = Vec::new();

    let mut add =
        |path: PathBuf, label: String, spec: &Spec, root: &Path, out: &mut Vec<InstructionFile>| {
            let key = path.canonicalize().unwrap_or_else(|_| path.clone());
            if let Some((_, i)) = seen.iter().find(|(p, _)| *p == key) {
                let row = &mut out[*i];
                for a in spec.agents {
                    if !row.agents.iter().any(|x| x == a) {
                        row.agents.push(a.to_string());
                    }
                }
                return;
            }
            seen.push((key, out.len()));
            out.push(describe(
                &path,
                spec.kind,
                spec.agents,
                spec.scope,
                root,
                label,
            ));
        };

    for spec in all.iter().filter(|s| s.scope == Scope::Project) {
        for root in &roots {
            let root = PathBuf::from(root);
            if !root.is_dir() {
                continue;
            }
            for (path, label) in expand(spec, &root) {
                add(path, label, spec, &root, &mut out);
            }
        }
    }

    if let Some(home) = home() {
        for spec in all.iter().filter(|s| s.scope == Scope::Global) {
            for (path, label) in expand(spec, &home) {
                add(path, format!("~/{label}"), spec, &home, &mut out);
            }
        }
    }

    Ok(out)
}

/// The gate. A path is reachable only if some spec, resolved against a passed
/// workspace root or against `$HOME`, produces exactly it.
///
/// Recomputed from the table rather than trusting anything the frontend sends,
/// and matched on the canonical path so `..` can't walk out of a root. New files
/// canonicalize their deepest existing ancestor, same trick as `fsx::check_scope`,
/// so "create the AGENTS.md this project lacks" still validates.
fn gate(path: &str, roots: &[String]) -> Result<PathBuf, String> {
    let target = canonical_ish(Path::new(path))?;

    for spec in specs().iter().filter(|s| s.scope == Scope::Project) {
        for root in roots {
            let Ok(root) = PathBuf::from(root).canonicalize() else {
                continue;
            };
            match spec.loc {
                // A nested spec is a *shape*, not a fixed path: any directory
                // under the root may hold one. Check the name and that it is
                // genuinely inside the root, rather than expanding the walk —
                // which would refuse to create the very file being created.
                Loc::Nested(name) => {
                    if target.file_name().map(|f| f == name).unwrap_or(false)
                        && target.starts_with(&root)
                        && !target
                            .components()
                            .any(|c| SKIP_DIRS.contains(&c.as_os_str().to_string_lossy().as_ref()))
                    {
                        return Ok(target);
                    }
                }
                _ => {
                    if expand(spec, &root).iter().any(|(p, _)| *p == target)
                        || matches!(spec.loc, Loc::File(rel) if root.join(rel) == target)
                    {
                        return Ok(target);
                    }
                }
            }
        }
    }

    if let Some(home) = home().and_then(|h| h.canonicalize().ok()) {
        for spec in specs().iter().filter(|s| s.scope == Scope::Global) {
            if expand(spec, &home).iter().any(|(p, _)| *p == target)
                || matches!(spec.loc, Loc::File(rel) if home.join(rel) == target)
            {
                return Ok(target);
            }
            // A skill or rule being created inside a directory that is itself an
            // instruction location: `~/.claude/skills/<new>/SKILL.md`.
            if let Loc::Pack(dir, file) = spec.loc {
                if target.file_name().map(|f| f == file).unwrap_or(false)
                    && target.parent().and_then(|p| p.parent()) == Some(home.join(dir).as_path())
                {
                    return Ok(target);
                }
            }
            if let Loc::Dir(dir, ext) = spec.loc {
                if target.extension().map(|e| e == ext).unwrap_or(false)
                    && target.parent() == Some(home.join(dir).as_path())
                {
                    return Ok(target);
                }
            }
        }
    }

    Err(format!(
        "not an agent instruction file: {}",
        target.display()
    ))
}

/// Canonicalize the deepest existing ancestor and re-append the rest, so a file
/// that doesn't exist yet still resolves (and still can't contain `..`).
fn canonical_ish(path: &Path) -> Result<PathBuf, String> {
    let mut existing = path.to_path_buf();
    let mut suffix = PathBuf::new();
    while !existing.exists() {
        let name = existing
            .file_name()
            .map(|n| n.to_owned())
            .ok_or_else(|| "invalid path".to_string())?;
        suffix = if suffix.as_os_str().is_empty() {
            PathBuf::from(&name)
        } else {
            Path::new(&name).join(&suffix)
        };
        existing = existing
            .parent()
            .ok_or_else(|| "invalid path".to_string())?
            .to_path_buf();
    }
    let mut canonical = existing.canonicalize().map_err(|e| e.to_string())?;
    if !suffix.as_os_str().is_empty() {
        canonical = canonical.join(suffix);
    }
    Ok(canonical)
}

#[tauri::command]
pub async fn instructions_read(path: String, roots: Vec<String>) -> Result<String, String> {
    let file = gate(&path, &roots)?;
    std::fs::read_to_string(&file).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn instructions_write(
    path: String,
    roots: Vec<String>,
    content: String,
) -> Result<(), String> {
    let file = gate(&path, &roots)?;
    // Creating `.claude/skills/<new>/SKILL.md` means creating its directory too.
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, content).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots() -> Vec<String> {
        vec![std::env::temp_dir().to_string_lossy().to_string()]
    }

    #[test]
    fn gate_admits_a_project_agents_md() {
        let dir = std::env::temp_dir().join("canopy-instr-test");
        std::fs::create_dir_all(&dir).unwrap();
        let roots = vec![dir.to_string_lossy().to_string()];
        // Doesn't exist yet — creating it is the point.
        let p = dir.join("AGENTS.md");
        assert!(gate(&p.to_string_lossy(), &roots).is_ok());
        assert!(gate(&dir.join("CLAUDE.md").to_string_lossy(), &roots).is_ok());
        assert!(gate(
            &dir.join(".github/copilot-instructions.md")
                .to_string_lossy(),
            &roots
        )
        .is_ok());
    }

    #[test]
    fn gate_admits_nested_agents_md_but_not_in_vendored_trees() {
        let dir = std::env::temp_dir().join("canopy-instr-nested");
        std::fs::create_dir_all(dir.join("packages/api")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/dep")).unwrap();
        let roots = vec![dir.to_string_lossy().to_string()];
        assert!(gate(
            &dir.join("packages/api/AGENTS.md").to_string_lossy(),
            &roots
        )
        .is_ok());
        assert!(gate(
            &dir.join("node_modules/dep/AGENTS.md").to_string_lossy(),
            &roots
        )
        .is_err());
    }

    #[test]
    fn gate_refuses_anything_that_is_not_an_instruction_file() {
        let dir = std::env::temp_dir().join("canopy-instr-test");
        std::fs::create_dir_all(&dir).unwrap();
        let roots = vec![dir.to_string_lossy().to_string()];
        // Right place, wrong file.
        assert!(gate(&dir.join("README.md").to_string_lossy(), &roots).is_err());
        assert!(gate(&dir.join(".env").to_string_lossy(), &roots).is_err());
        // The agent's own settings are not instructions, and are not editable here.
        assert!(gate(&dir.join(".claude/settings.json").to_string_lossy(), &roots).is_err());
    }

    #[test]
    fn gate_refuses_paths_outside_every_root() {
        assert!(gate("/etc/passwd", &roots()).is_err());
        if let Some(home) = home() {
            // Right *name* shape, nowhere near an instruction location.
            assert!(gate(&home.join(".ssh/config").to_string_lossy(), &roots()).is_err());
            assert!(gate(&home.join("AGENTS.md").to_string_lossy(), &roots()).is_err());
        }
    }

    #[test]
    fn gate_refuses_a_traversal_out_of_a_root() {
        let dir = std::env::temp_dir().join("canopy-instr-esc");
        std::fs::create_dir_all(&dir).unwrap();
        let roots = vec![dir.to_string_lossy().to_string()];
        let escape = dir.join("../../etc/AGENTS.md");
        assert!(gate(&escape.to_string_lossy(), &roots).is_err());
    }

    #[test]
    fn gate_admits_a_new_global_skill() {
        let Some(home) = home() else { return };
        let p = home.join(".claude/skills/brand-new-skill/SKILL.md");
        assert!(gate(&p.to_string_lossy(), &[]).is_ok());
        // But not an arbitrary file smuggled into the same tree.
        let bad = home.join(".claude/skills/brand-new-skill/payload.sh");
        assert!(gate(&bad.to_string_lossy(), &[]).is_err());
    }

    #[test]
    fn frontmatter_is_read_and_a_broken_block_degrades_quietly() {
        let dir = std::env::temp_dir().join("canopy-instr-fm");
        std::fs::create_dir_all(&dir).unwrap();
        let good = dir.join("good.md");
        std::fs::write(
            &good,
            "---\nname: caveman\ndescription: \"Speak plainly\"\n---\n\nBody\n",
        )
        .unwrap();
        let (n, d) = frontmatter_fields(&good);
        assert_eq!(n.as_deref(), Some("caveman"));
        assert_eq!(d.as_deref(), Some("Speak plainly"));

        let plain = dir.join("plain.md");
        std::fs::write(&plain, "# Just a heading\n").unwrap();
        assert_eq!(frontmatter_fields(&plain), (None, None));
    }

    /// Skills are routinely shared between CLIs by symlinking one directory into
    /// each tool's `skills/`. `DirEntry::file_type()` reports the *link*, not its
    /// target, so checking it there silently skipped every shared skill — which
    /// on a real multi-agent machine is most of them.
    #[test]
    fn a_symlinked_skill_is_found_like_a_real_one() {
        let base = std::env::temp_dir().join("canopy-instr-symlink");
        let _ = std::fs::remove_dir_all(&base);
        let real = base.join("shared/caveman");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("SKILL.md"), "---\nname: caveman\n---\n\nBody\n").unwrap();

        let skills = base.join("root/.claude/skills");
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::create_dir_all(skills.join("plain-one")).unwrap();
        std::fs::write(skills.join("plain-one/SKILL.md"), "---\nname: plain\n---\n").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, skills.join("caveman")).unwrap();
        #[cfg(not(unix))]
        return;

        let spec = Spec {
            loc: Loc::Pack(".claude/skills", "SKILL.md"),
            kind: "skill",
            agents: SKILL_MD,
            scope: Scope::Project,
        };
        let mut found: Vec<String> = expand(&spec, &base.join("root"))
            .into_iter()
            .map(|(_, label)| label)
            .collect();
        found.sort();
        assert_eq!(
            found,
            vec![
                ".claude/skills/caveman/SKILL.md".to_string(),
                ".claude/skills/plain-one/SKILL.md".to_string(),
            ]
        );
    }

    /// A symlink that points back up its own tree must not send the nested walk
    /// round forever — which is why walk_nested, unlike the skills scan, checks
    /// the link type rather than following it.
    #[test]
    fn a_symlink_cycle_does_not_hang_the_nested_walk() {
        let base = std::env::temp_dir().join("canopy-instr-cycle");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("packages")).unwrap();
        std::fs::write(base.join("packages/AGENTS.md"), "nested\n").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&base, base.join("packages/loop")).unwrap();

        let mut out = Vec::new();
        walk_nested(&base, "AGENTS.md", 0, &mut out);
        assert_eq!(out.len(), 1);
        assert!(out[0].ends_with("packages/AGENTS.md"));
    }
}
