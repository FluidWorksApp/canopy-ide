//! The tool contract a cloud agent's hook negotiates (`GET /ctx/tools`).
//!
//! `SUPPORTED_TOOLS` is the desktop bridge's list verbatim (protocol §2: the
//! hook reads it once at startup and `listChanged` stays false), so a tool
//! never appears or disappears as an IDE attaches; availability is answered
//! per call. A test pins it to `src-tauri/src/context.rs`.

/// Never served by a cloud service: devices and the vault stay on the laptop.
pub const LAPTOP_ONLY_TOOLS: &[&str] = &[
    "canopy_device_describe",
    "canopy_device_key",
    "canopy_device_list",
    "canopy_device_logcat",
    "canopy_device_run",
    "canopy_device_screenshot",
    "canopy_device_snapshot",
    "canopy_device_start",
    "canopy_device_swipe",
    "canopy_device_tap",
    "canopy_device_type",
    "canopy_vault_fill",
    "canopy_vault_list",
    "canopy_vault_read",
];

/// `/ctx/action` kinds this service executes. Every other kind answers 503.
pub const SERVICE_ACTIONS: &[&str] = &[
    "job_done",
    "task_named",
    "notify",
    "mesh_send",
    "message_agent",
    "close_session",
];

pub const SUPPORTED_TOOLS: &[&str] = &[
    "canopy_agents",
    "canopy_annotations",
    "canopy_ask_user",
    "canopy_browser_click",
    "canopy_browser_console",
    "canopy_browser_eval",
    "canopy_browser_navigate",
    "canopy_browser_network",
    "canopy_browser_point",
    "canopy_browser_resize",
    "canopy_browser_snapshot",
    "canopy_browser_type",
    "canopy_claim",
    "canopy_close_session",
    "canopy_component_files",
    "canopy_confirm",
    "canopy_definition",
    "canopy_device_describe",
    "canopy_device_key",
    "canopy_device_list",
    "canopy_device_logcat",
    "canopy_device_run",
    "canopy_device_screenshot",
    "canopy_device_snapshot",
    "canopy_device_start",
    "canopy_device_swipe",
    "canopy_device_tap",
    "canopy_device_type",
    "canopy_diagnostics",
    "canopy_editor_state",
    "canopy_hover",
    "canopy_job_done",
    "canopy_mesh",
    "canopy_mesh_send",
    "canopy_mesh_submit",
    "canopy_mesh_targets",
    "canopy_message_agent",
    "canopy_name_task",
    "canopy_notes",
    "canopy_notes_write",
    "canopy_notify",
    "canopy_open_file",
    "canopy_open_preview",
    "canopy_open_project",
    "canopy_pr_action",
    "canopy_pr_details",
    "canopy_project",
    "canopy_recall",
    "canopy_references",
    "canopy_remember",
    "canopy_research",
    "canopy_research_write",
    "canopy_resources",
    "canopy_restart_server",
    "canopy_reviews",
    "canopy_screenshot",
    "canopy_server_output",
    "canopy_show_diff",
    "canopy_spawn_agent",
    "canopy_start_server",
    "canopy_start_session",
    "canopy_stop_server",
    "canopy_symbols",
    "canopy_tickets",
    "canopy_vault_fill",
    "canopy_vault_list",
    "canopy_vault_read",
    "canopy_wait_for",
    "canopy_workspace",
    "canopy_workspace_agents",
    "canopy_workspace_git",
    "canopy_workspace_prs",
    "canopy_workspace_search",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tool_list_is_the_desktop_bridges() {
        let desktop = include_str!("../../../src-tauri/src/context.rs");
        let start = desktop
            .find("const SUPPORTED_TOOLS: &[&str] = &[")
            .expect("context.rs declares SUPPORTED_TOOLS");
        let end = start + desktop[start..].find("];").unwrap();
        let listed: Vec<&str> = desktop[start..end]
            .lines()
            .filter_map(|l| l.trim().strip_prefix('"')?.strip_suffix("\","))
            .collect();
        assert_eq!(listed, SUPPORTED_TOOLS);
        for tool in LAPTOP_ONLY_TOOLS {
            assert!(SUPPORTED_TOOLS.contains(tool), "{tool}");
        }
    }
}
