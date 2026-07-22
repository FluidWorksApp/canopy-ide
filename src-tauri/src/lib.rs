mod agents;
mod cli;
mod dictation;
mod fsx;
mod git;
mod lsp;
mod portal;
mod pty;
mod punch;
mod tunnel;
mod qstream;
mod relay;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

/// Custom menu: keeps Edit (clipboard in WKWebView needs it) but replaces the
/// default Cmd+W "Close Window" with tab-scoped shortcuts the frontend handles.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let app_menu = Submenu::with_items(
        app,
        "Canopy",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &MenuItem::with_id(app, "check-updates", "Check for Updates…", true, None::<&str>)?,
            &MenuItem::with_id(app, "install-cli", "Install 'canopy' Command…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let tabs = Submenu::with_items(
        app,
        "Tabs",
        true,
        &[
            &MenuItem::with_id(app, "new-terminal", "New Terminal", true, Some("CmdOrCtrl+T"))?,
            &MenuItem::with_id(app, "close-tab", "Close Tab", true, Some("CmdOrCtrl+W"))?,
            &PredefinedMenuItem::separator(app)?,
            // Tabs and projects share one mental model: Ctrl+Cmd moves between
            // tabs, Cmd+Alt between projects. Cmd+1..9 used to jump to a tab by
            // position — nine menu rows for something nobody counts to.
            &MenuItem::with_id(app, "next-tab", "Next Tab", true, Some("Control+CmdOrCtrl+Right"))?,
            &MenuItem::with_id(app, "prev-tab", "Previous Tab", true, Some("Control+CmdOrCtrl+Left"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "close-project", "Close Project", true, Some("CmdOrCtrl+Shift+W"))?,
            &MenuItem::with_id(app, "next-project", "Next Project", true, Some("CmdOrCtrl+Alt+Right"))?,
            &MenuItem::with_id(app, "prev-project", "Previous Project", true, Some("CmdOrCtrl+Alt+Left"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "toggle-sidebar", "Toggle Sidebar", true, Some("CmdOrCtrl+B"))?,
            &MenuItem::with_id(app, "toggle-zen", "Focus Mode", true, Some("CmdOrCtrl+Shift+Enter"))?,
        ],
    )?;
    // Projects and the workspace auto-persist to ~/.canopy/projects.json;
    // these items are explicit open/export on top of that, not the only way
    // state survives.
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "new-project", "New Project…", true, Some("CmdOrCtrl+N"))?,
            &MenuItem::with_id(app, "open-project", "Open Project…", true, Some("CmdOrCtrl+O"))?,
            &MenuItem::with_id(app, "manage-projects", "Manage Projects…", true, Some("CmdOrCtrl+Shift+M"))?,
            &MenuItem::with_id(app, "save-project", "Save Project As…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "open-workspace", "Open Workspace…", true, Some("CmdOrCtrl+Shift+O"))?,
            &MenuItem::with_id(app, "save-workspace", "Save Workspace As…", true, Some("CmdOrCtrl+Shift+S"))?,
        ],
    )?;
    // VS Code-standard navigation accelerators. Tauri has no chord support, so
    // Zen's Cmd+K Z isn't reproducible — Focus Mode lives on Cmd+Shift+Enter.
    let go = Submenu::with_items(
        app,
        "Go",
        true,
        &[
            &MenuItem::with_id(app, "quick-open", "Quick Open File…", true, Some("CmdOrCtrl+P"))?,
            &MenuItem::with_id(app, "find-in-files", "Find in Files…", true, Some("CmdOrCtrl+Shift+F"))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[&MenuItem::with_id(app, "help", "Canopy Help", true, Some("CmdOrCtrl+Shift+H"))?],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &go, &tabs, &window, &help])
}

/// Frontend error bridge: WebView console/errors surface in the dev terminal.
#[tauri::command]
fn js_log(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!(target: "webview", "{message}"),
        "warn" => log::warn!(target: "webview", "{message}"),
        _ => log::info!(target: "webview", "{message}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Must be first: a second `canopy <dir>` invocation forwards its argv
    // here and exits, instead of starting an app that would fight this one
    // over the hook bridge and PTY ownership.
    //
    // Release builds only. Dev and release share the app identifier, so with
    // the guard active a `tauri dev` run hands its argv to the *installed*
    // Canopy.app and silently exits — you cannot develop while the app you
    // ship is running. In dev the instances coexist: they share
    // ~/.canopy (bridge, digests, projects.json) read-mostly, and the worst
    // real overlap — pty ids restarting from 1 in each instance — only
    // fuzzes per-tab event attribution, which cwd matching then covers.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        cli::open_forwarded(app, argv, cwd);
    }));
    builder
        .plugin(tauri_plugin_dialog::init())
        // Self-update (see plugins.updater in tauri.conf.json) and the restart
        // that has to follow an install.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Opens https links in the system browser — the update toast's
        // "Open downloads page" for installs that can't self-update.
        .plugin(tauri_plugin_opener::init())
        // Native (macOS/…) notifications for team-relay activity landing
        // while Canopy isn't the focused app.
        .plugin(tauri_plugin_notification::init())
        .manage(pty::PtyManager::default())
        .manage(fsx::WorkspaceManager::default())
        .manage(lsp::LspManager::default())
        .manage(relay::RelayManager::default())
        .manage(portal::RemoteManager::default())
        .manage(tunnel::TunnelManager::default())
        .manage(dictation::DictationManager::default())
        .manage(cli::pending_from_env())
        .setup(|app| {
            // ONNX Runtime is loaded dynamically on every platform (Cargo.toml
            // builds ort with `load-dynamic`). Point ort at the libonnxruntime
            // bundled as an app resource before any dictation touches it. If it
            // isn't there (a dev build without the bundled lib), leave the var
            // unset — ort then falls back to a system search.
            if std::env::var_os("ORT_DYLIB_PATH").is_none() {
                let lib = if cfg!(target_os = "windows") {
                    "onnxruntime/onnxruntime.dll"
                } else if cfg!(target_os = "macos") {
                    "onnxruntime/libonnxruntime.dylib"
                } else {
                    "onnxruntime/libonnxruntime.so"
                };
                if let Ok(p) = app.path().resolve(lib, tauri::path::BaseDirectory::Resource) {
                    if p.exists() {
                        std::env::set_var("ORT_DYLIB_PATH", &p);
                    }
                }
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Install the hook helper before hooks are (re)written, so the
            // path they point at exists.
            if let Err(e) = agents::install_hook_helper() {
                log::warn!("hook helper not installed: {e}");
            }
            agents::start_monitor(app.handle().clone());
            agents::start_hook_bridge(app.handle().clone());
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                let _ = app.emit("menu", event.id().0.clone());
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            js_log,
            cli::cli_take_pending_open,
            cli::cli_install_shim,
            pty::pty_spawn,
            pty::pty_attach,
            pty::pty_write,
            pty::pty_ack,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_all,
            pty::pty_set_title,
            pty::instance_id,
            fsx::workspace_add,
            fsx::workspace_remove,
            fsx::workspace_list,
            fsx::fs_read_dir,
            fsx::fs_read_file,
            fsx::fs_write_file,
            fsx::fs_stat,
            fsx::fs_list_files,
            fsx::fs_search,
            fsx::fs_create_file,
            fsx::fs_create_dir,
            fsx::fs_rename,
            fsx::fs_trash,
            fsx::fs_reveal,
            fsx::fs_duplicate,
            fsx::workspace_export,
            fsx::workspace_import,
            git::git_repos,
            git::git_repo_status,
            git::git_branches,
            git::git_checkout,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_fetch,
            git::git_pull,
            git::git_push,
            git::git_clone,
            git::git_diff,
            git::git_log,
            git::git_commit_detail,
            git::git_commit_patch,
            git::git_worktrees,
            git::git_work_audit,
            git::git_branch_delete,
            git::git_branch_delete_remote,
            git::git_remote_url,
            git::git_branch_commits,
            git::git_branch_patch,
            git::agent_workspace,
            git::git_worktree_add,
            git::git_worktree_remove,
            git::git_worktree_prune,
            git::gh_available,
            git::gh_auth,
            git::gh_pr_list,
            git::gh_pr_diff,
            git::gh_pr_body,
            git::gh_pr_review,
            git::gh_pr_checkout,
            git::gh_pr_merge,
            git::gh_pr_close,
            git::gh_pr_ready,
            git::gh_issue_list,
            git::linear_issues,
            fsx::git_status,
            fsx::git_head_content,
            fsx::store_load,
            fsx::store_save,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            agents::kill_process,
            agents::which_check,
            agents::cli_versions,
            agents::setup_agent_hooks,
            agents::agent_hooks_installed,
            agents::claude_session_stats,
            agents::agent_usage,
            agents::hook_bridge_path,
            agents::set_context_scopes,
            agents::session_digests,
            agents::session_forget,
            relay::relay_host_start,
            relay::relay_host_stop,
            relay::relay_regenerate_code,
            relay::relay_connect,
            relay::relay_disconnect,
            relay::relay_status,
            relay::relay_send_chat,
            relay::relay_send_command,
            relay::relay_send_collab,
            relay::relay_offer_file,
            relay::relay_accept_file,
            portal::remote_enable,
            portal::remote_disable,
            portal::remote_status,
            portal::remote_rotate_pin,
            portal::remote_set_theme,
            portal::remote_qr,
            tunnel::tunnel_start,
            tunnel::tunnel_stop,
            tunnel::tunnel_status,
            dictation::dictation_models,
            dictation::dictation_status,
            dictation::dictation_download,
            dictation::dictation_delete_model,
            dictation::dictation_start,
            dictation::dictation_stop,
            dictation::dictation_cancel,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Guarantee no child processes outlive the app.
                app.state::<pty::PtyManager>().kill_all();
                app.state::<lsp::LspManager>().kill_all();
                // ... and no relay socket either.
                app.state::<relay::RelayManager>().shutdown();
                // ... and stop the remote-access server.
                app.state::<portal::RemoteManager>().shutdown();
                // ... and any public-link tunnel process.
                app.state::<tunnel::TunnelManager>().kill_all();
            }
        });
}
