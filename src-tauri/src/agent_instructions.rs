//! The one Canopy bootstrap shared by every agent-CLI integration.
//!
//! Delivery is deliberately capability-aware. Every CLI can be told where it
//! is and how repository instructions compose; only an MCP-capable CLI is told
//! to call `canopy_*` tools. Naming tools to a client that cannot receive them
//! is worse than no bootstrap at all: the model spends its first turn trying to
//! call an interface that does not exist.

// The app half installs the file; the standalone helper half serves the MCP
// prompt. Each target therefore uses only half this module by design.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

/// Context that is true for every coding agent launched in a Canopy PTY.
///
/// Aider receives this as a read-only conventions file and oh-my-pi appends it
/// to its system prompt. MCP clients receive it before the tool routing below.
pub const SESSION_CONTEXT: &str = "\
This coding-agent session is running inside the Canopy IDE. The current working \
directory is the active project component; use it as the workspace boundary \
unless the user explicitly names another component. Read and follow the \
repository's applicable agent-instruction files and keep unexpected existing \
changes intact because other sessions may share this checkout.\n\
\n\
Canopy integrations are available only when they appear in your actual tool \
inventory. Never invent a Canopy tool or imitate one through an unrelated \
shell command.";

/// Tool-routing instructions for clients that initialized Canopy's MCP server.
const TOOL_ROUTING: &str = "\
Prefer the Canopy tools below over shell or system equivalents. They act in the \
IDE the user is watching, and their results stay inspectable:\n\
\n\
- Start a dev server / build / worker -> canopy_start_server (not `npm run dev` \
  in bash; it runs in Canopy's RUNS rail, with logs via canopy_server_output)\n\
- Open or look at a page -> canopy_browser_navigate, then canopy_browser_snapshot \
  (not `open`/`xdg-open`, and never an external browser; the embedded preview is \
  what the user annotates and what you can drive)\n\
- Test responsive layouts -> canopy_browser_resize, then reset it when finished \
  (do not open Playwright just to change the viewport)\n\
- Interact with a page -> canopy_browser_click / _type / _eval; diagnose with \
  canopy_browser_console / _network\n\
- Stop or restart a server -> canopy_stop_server / canopy_restart_server (not \
  kill/pkill)\n\
- See what's running, CPU, memory -> canopy_resources (not ps/top/lsof)\n\
- Read a running server's logs -> canopy_server_output (don't re-run the command)\n\
- The user's marked-up feedback on a page or a device -> canopy_annotations\n\
- Run or look at an Android app -> canopy_device_list first, then \
  canopy_device_run / _screenshot / _snapshot (not adb in bash; these pick the \
  device and the launcher activity for you)\n\
- Interact with an Android app -> canopy_device_tap / _type / _key / _swipe \
  (coordinates from canopy_device_snapshot, never guessed off a screenshot); \
  diagnose with canopy_device_logcat\n\
\n\
- \"this\", \"here\", \"the other one\" in the user's request -> canopy_editor_state \
  (the file they have open, their caret and selection) before guessing\n\
- Check your own edit compiles -> canopy_diagnostics (the warm language server, \
  not a full `tsc --noEmit`); before changing a shared signature -> \
  canopy_references\n\
- What a symbol's type and docs are -> canopy_hover; where a symbol by that \
  name is -> canopy_symbols (not grep)\n\
- Wait for a server to come up, a build to finish -> canopy_wait_for (don't poll \
  canopy_server_output in a loop)\n\
- How something LOOKS -> canopy_screenshot (the DOM snapshot can't see overlap \
  or contrast)\n\
- Working in a checkout that other agents share -> canopy_agents first, then \
  canopy_mesh history; use canopy_claim before editing shared paths\n\
- Handing another agent more than one line, or files, or a message it should \
  be able to find again -> canopy_mesh_send (persistent, by message id); \
  what you've sent and received, or a message id someone gave you -> \
  canopy_mesh\n\
\n\
- Investigating anything worth writing down (how does X work, which approach, \
  what would break) -> canopy_research search FIRST, someone may already have \
  answered it; then canopy_research_write start, and put the findings there as \
  you go. Never leave research in a scratch markdown file — it is lost the \
  moment the session ends. Long raw material (file dumps, logs, fetched pages) \
  goes in `source`, not in the body: the body is what the next agent reads.\n\
- Noticing something real that is NOT the job you were given (a bug beside the \
  one you were sent for, a refactor the code obviously wants, a missing test) \
  -> canopy_notes_write create. Park it and carry on: writing it down is how it \
  survives, and chasing it is how you deliver the wrong change. Search \
  canopy_notes first so the same observation is not recorded twice. This is not \
  a progress log — do not narrate the work you were asked to do into it.\n\
\n\
At the start of a new session, call canopy_project for component paths, \
configured run commands, terminal ids, and listening ports. If it shows other \
live agents or a shared checkout, call canopy_agents and canopy_mesh history \
before editing. Fall back to the shell only for work these tools do not cover.";

/// The MCP server's system-prompt contribution.
pub fn mcp_instructions() -> String {
    format!("{SESSION_CONTEXT}\n\n{TOOL_ROUTING}")
}

/// A stable read-only context file for CLIs such as Aider that accept a file
/// rather than an MCP `instructions` field.
pub fn context_path(home: impl AsRef<Path>) -> PathBuf {
    home.as_ref().join(".canopy").join("agent-context.md")
}

/// Refresh the generated context on every app launch so wording changes reach
/// the next CLI session without modifying any repository-owned instruction file.
pub fn install_context(home: impl AsRef<Path>) -> Result<PathBuf, String> {
    let path = context_path(home);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if std::fs::read_to_string(&path).ok().as_deref() != Some(SESSION_CONTEXT) {
        std::fs::write(&path, SESSION_CONTEXT).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "canopy-agent-context-{}-{name}",
            std::process::id()
        ))
    }

    #[test]
    fn mcp_bootstrap_starts_with_workspace_and_mesh_discovery() {
        let prompt = mcp_instructions();
        assert!(prompt.starts_with("This coding-agent session is running inside the Canopy IDE"));
        assert!(prompt.contains("At the start of a new session, call canopy_project"));
        assert!(prompt.contains("call canopy_agents and canopy_mesh history before editing"));
        assert!(prompt.contains("canopy_mesh_send"));
    }

    #[test]
    fn base_context_does_not_promise_tools_to_clients_without_them() {
        assert!(!SESSION_CONTEXT.contains("canopy_project"));
        assert!(!SESSION_CONTEXT.contains("canopy_mesh"));
        assert!(SESSION_CONTEXT.contains("only when they appear in your actual tool inventory"));
    }

    #[test]
    fn installed_context_is_refreshed_without_touching_a_repository() {
        let home = scratch("refresh");
        let path = context_path(&home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "stale context").unwrap();

        assert_eq!(install_context(&home).unwrap(), path);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), SESSION_CONTEXT);
        assert!(path.starts_with(home.join(".canopy")));

        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(home.join(".canopy")).unwrap();
        std::fs::remove_dir(home).unwrap();
    }
}
