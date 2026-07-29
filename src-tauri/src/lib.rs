mod agentid;
mod agents;
mod android;
mod blocking;
mod browser;
mod cleanup;
mod cli;
mod context;
mod crash;
#[cfg(feature = "dictation")]
mod dictation;
// Intel macOS builds compile dictation out (no compatible ONNX Runtime); a stub
// keeps the command surface identical so the rest of this file is unchanged.
#[cfg(not(feature = "dictation"))]
#[path = "dictation_stub.rs"]
mod dictation;
mod fsx;
mod git;
mod instructions;
mod lsp;
mod mcp;
mod mcp_client;
mod notify;
mod portal;
mod preview;
mod prwatch;
mod pty;
mod punch;
mod relay;
mod remote;
mod research;
mod selftest;
mod snapshot;
mod spot;
mod stores;
mod sysaudio;
mod tunnel;
mod vault;
mod vault_kdbx;
mod winproc;
mod wsbridge;

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
            // Custom About (not PredefinedMenuItem::about): the native panel
            // can't carry the Terms/Privacy/Support links we show, so this
            // emits a "menu" event the frontend answers with its own dialog.
            &MenuItem::with_id(app, "about", "About Canopy", true, None::<&str>)?,
            &MenuItem::with_id(
                app,
                "check-updates",
                "Check for Updates…",
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(
                app,
                "install-cli",
                "Install 'canopy' Command…",
                true,
                None::<&str>,
            )?,
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
            // The launcher (shell, preview, every agent CLI) as a typed list —
            // the ＋ menu's keyboard twin. Cmd/Ctrl+T stays the straight-to-a-
            // shell shortcut for when you already know what you want.
            &MenuItem::with_id(app, "new-launcher", "New…", true, Some("CmdOrCtrl+N"))?,
            &MenuItem::with_id(
                app,
                "new-terminal",
                "New Terminal",
                true,
                Some("CmdOrCtrl+T"),
            )?,
            &MenuItem::with_id(app, "close-tab", "Close Tab", true, Some("CmdOrCtrl+W"))?,
            &PredefinedMenuItem::separator(app)?,
            // Tabs and projects share one mental model: Ctrl+Cmd moves between
            // tabs, Cmd+Alt between projects. Cmd+1..9 used to jump to a tab by
            // position — nine menu rows for something nobody counts to.
            &MenuItem::with_id(
                app,
                "next-tab",
                "Next Tab",
                true,
                Some("Control+CmdOrCtrl+Right"),
            )?,
            &MenuItem::with_id(
                app,
                "prev-tab",
                "Previous Tab",
                true,
                Some("Control+CmdOrCtrl+Left"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "close-project",
                "Close Project",
                true,
                Some("CmdOrCtrl+Shift+W"),
            )?,
            &MenuItem::with_id(
                app,
                "next-project",
                "Next Project",
                true,
                Some("CmdOrCtrl+Alt+Right"),
            )?,
            &MenuItem::with_id(
                app,
                "prev-project",
                "Previous Project",
                true,
                Some("CmdOrCtrl+Alt+Left"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "toggle-sidebar",
                "Toggle Sidebar",
                true,
                Some("CmdOrCtrl+B"),
            )?,
            &MenuItem::with_id(
                app,
                "toggle-zen",
                "Focus Mode",
                true,
                Some("CmdOrCtrl+Shift+Enter"),
            )?,
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
            &MenuItem::with_id(
                app,
                "new-project",
                "New Project…",
                true,
                // Cmd/Ctrl+N is the new-tab launcher (Tabs menu); a whole new
                // project is the rarer, bigger thing, so it takes the Shift.
                Some("CmdOrCtrl+Shift+N"),
            )?,
            &MenuItem::with_id(
                app,
                "open-project",
                "Open Project…",
                true,
                Some("CmdOrCtrl+O"),
            )?,
            &MenuItem::with_id(
                app,
                "manage-projects",
                "Manage Projects…",
                true,
                Some("CmdOrCtrl+Shift+M"),
            )?,
            &MenuItem::with_id(app, "save-project", "Save Project As…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "open-workspace",
                "Open Workspace…",
                true,
                Some("CmdOrCtrl+Shift+O"),
            )?,
            &MenuItem::with_id(
                app,
                "save-workspace",
                "Save Workspace As…",
                true,
                Some("CmdOrCtrl+Shift+S"),
            )?,
        ],
    )?;
    // VS Code-standard navigation accelerators. Tauri has no chord support, so
    // Zen's Cmd+K Z isn't reproducible — Focus Mode lives on Cmd+Shift+Enter.
    let go = Submenu::with_items(
        app,
        "Go",
        true,
        &[
            &MenuItem::with_id(
                app,
                "quick-open",
                "Quick Open File…",
                true,
                Some("CmdOrCtrl+P"),
            )?,
            &MenuItem::with_id(
                app,
                "find-in-files",
                "Find in Files…",
                true,
                Some("CmdOrCtrl+Shift+F"),
            )?,
            &MenuItem::with_id(
                app,
                "spot-search",
                "SpotSearch Everything…",
                true,
                Some("CmdOrCtrl+K"),
            )?,
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
        &[
            &MenuItem::with_id(app, "help", "Canopy Help", true, Some("CmdOrCtrl+Shift+H"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "support", "Support Us", true, None::<&str>)?,
        ],
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
    // Install the ring crypto provider process-wide so rustls has a default —
    // the team relay's internet path dials wss:// through a tunnel via
    // tokio-tungstenite, whose rustls connector builds its config from the
    // process-default provider and would otherwise panic on first connect.
    // Idempotent: an Err just means it was already set.
    let _ = rustls::crypto::ring::default_provider().install_default();

    // Park a native panic on disk (opt-in reporting flushes it next launch),
    // keeping the default hook's stderr/log behaviour. Installed before any
    // Tauri machinery so a panic during setup is captured too.
    crash::install_panic_hook();

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
        .manage(preview::PreviewManager::default())
        .manage(browser::BrowserManager::default())
        .manage(context::ContextBridge::default())
        .manage(agents::StatsCache::default())
        .manage(tunnel::TunnelManager::default())
        .manage(prwatch::PrWatcher::default())
        .manage(dictation::DictationManager::default())
        .manage(selftest::SelftestState::default())
        .manage(spot::SpotIndex::default())
        .manage(research::ResearchStore::default())
        .manage(vault::Vault::default())
        .manage(cli::pending_from_env())
        .setup(|app| {
            // ONNX Runtime is loaded dynamically on every platform (Cargo.toml
            // builds ort with `load-dynamic`). Point ort at the libonnxruntime
            // bundled as an app resource before any dictation touches it. If it
            // isn't there (a dev build without the bundled lib), leave the var
            // unset — ort then falls back to a system search.
            #[cfg(feature = "dictation")]
            if std::env::var_os("ORT_DYLIB_PATH").is_none() {
                let lib = if cfg!(target_os = "windows") {
                    "onnxruntime/onnxruntime.dll"
                } else if cfg!(target_os = "macos") {
                    "onnxruntime/libonnxruntime.dylib"
                } else {
                    "onnxruntime/libonnxruntime.so"
                };
                if let Ok(p) = app
                    .path()
                    .resolve(lib, tauri::path::BaseDirectory::Resource)
                {
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
            // Then re-apply the integrations this machine already opted into.
            // Every launch is also every update, which is when a generated hook
            // file goes stale or a newly shipped step (the MCP registration was
            // one) is missing from a config set up by an older version. Off the
            // main thread: it shells out to find the CLIs.
            agents::heal_integrations(app.handle().clone());
            agents::start_monitor(app.handle().clone());
            agents::start_hook_bridge(app.handle().clone());
            context::start(app.handle().clone());
            // Only does anything when this launch asked to test itself.
            selftest::start(app.handle());
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                let _ = app.emit("menu", event.id().0.clone());
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            js_log,
            crash::report_crash,
            crash::send_crash,
            crash::take_pending_crash,
            crash::crash_issue_draft,
            crash::file_crash_issue,
            cli::cli_take_pending_open,
            cli::cli_install_shim,
            notify::notify_native,
            selftest::selftest_config,
            selftest::selftest_finish,
            pty::pty_spawn,
            pty::pty_spawn_detached,
            pty::pty_output,
            pty::pty_attach,
            pty::pty_write,
            pty::pty_ack,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_all,
            pty::pty_set_title,
            pty::instance_id,
            android::android_sdk_status,
            android::android_devices,
            android::android_avds,
            android::android_emulator_start,
            android::android_emulator_stop,
            android::android_screencap,
            android::android_ui_dump,
            android::android_layout,
            android::android_foreground,
            android::android_tap,
            android::android_text,
            android::android_swipe,
            android::android_key,
            android::android_logcat,
            android::android_describe,
            android::android_run,
            spot::spot_ingest,
            spot::spot_search,
            spot::spot_index_stats,
            spot::spot_index_clear,
            spot::spot_save_context_image,
            vault::vault_status,
            vault::vault_create,
            vault::vault_unlock,
            vault::vault_lock,
            vault::vault_change_passphrase,
            vault::vault_list,
            vault::vault_matches,
            vault::vault_save,
            vault::vault_delete,
            vault::vault_reveal,
            vault::vault_fill,
            vault::vault_read,
            vault::vault_approve,
            vault::vault_import_kdbx,
            vault::vault_approvals,
            vault::vault_revoke,
            research::research_list,
            research::research_search,
            research::research_get,
            research::research_start,
            research::research_update,
            research::research_add_source,
            research::research_set_status,
            research::research_link,
            research::research_read_file,
            research::research_dir,
            research::research_import,
            research::research_for_file,
            research::research_delete,
            spot::spot_save_context_text,
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
            instructions::instructions_scan,
            instructions::instructions_read,
            instructions::instructions_write,
            git::git_repos,
            git::git_repo_status,
            git::git_branches,
            git::git_checkout,
            git::git_checkout_detached,
            git::git_checkout_carry,
            git::git_branch_release,
            git::git_operation_quit,
            git::git_branch_at,
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
            git::agent_workspace_at,
            git::agent_edits,
            git::git_worktree_add,
            git::git_worktree_add_pr,
            git::git_worktree_bootstrap,
            git::git_worktree_remove,
            git::git_worktree_prune,
            git::gh_available,
            git::gh_auth,
            git::gh_pr_list,
            git::gh_pr_diff,
            git::gh_pr_body,
            git::gh_pr_state,
            git::gh_pr_review,
            git::gh_pr_checkout,
            git::gh_pr_merge,
            git::gh_pr_close,
            git::gh_pr_ready,
            git::gh_pr_conversation,
            git::gh_pr_thread_reply,
            git::gh_pr_thread_resolved,
            git::gh_pr_file_viewed,
            git::gh_pr_review_batch,
            git::gh_pr_update_branch,
            git::gh_pr_request_review,
            git::gh_pr_auto_merge,
            git::gh_pr_failing_logs,
            git::gh_pr_diff_since,
            git::gh_pr_reviewer_candidates,
            prwatch::pr_watch_set,
            prwatch::pr_watch_now,
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
            agents::model_catalog,
            agents::cli_versions,
            agents::setup_agent_hooks,
            agents::agent_hooks_installed,
            agents::agent_integration_health,
            agents::agent_health_report,
            mcp::mcp_servers,
            mcp_client::mcp_connect,
            mcp_client::mcp_call_tool,
            mcp_client::mcp_disconnect,
            mcp_client::mcp_connected,
            agents::claude_session_stats,
            agents::agent_usage,
            agents::plan_usage,
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
            preview::preview_start,
            preview::preview_stop,
            browser::browser_supported,
            browser::browser_open,
            browser::browser_navigate,
            browser::browser_painted,
            browser::browser_set_bounds,
            browser::browser_set_visible,
            browser::browser_close,
            browser::browser_run_op,
            browser::browser_command,
            browser::browser_here,
            browser::browser_clear_data,
            cleanup::cleanup_scan,
            cleanup::cleanup_run,
            cleanup::cleanup_disk,
            context::context_publish,
            context::context_remove,
            context::context_tools,
            context::context_claims,
            context::context_release_claim,
            context::browser_result,
            snapshot::webview_snapshot,
            snapshot::browser_snapshot,
            snapshot::browser_frame,
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
            dictation::dictation_supported,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Before anything else: never leave the speakers muted because
                // the app quit mid-dictation. Cheap, and the one piece of state
                // here that outlives the process.
                sysaudio::restore();
                // Guarantee no child processes outlive the app.
                app.state::<pty::PtyManager>().kill_all();
                app.state::<lsp::LspManager>().kill_all();
                // ... and no relay socket either.
                app.state::<relay::RelayManager>().shutdown();
                // ... and stop the remote-access server.
                app.state::<portal::RemoteManager>().shutdown();
                // ... and any preview proxies.
                app.state::<preview::PreviewManager>().shutdown_all();
                // ... and any embedded-browser views.
                app.state::<browser::BrowserManager>().shutdown_all(app);
                // ... and any public-link tunnel process.
                app.state::<tunnel::TunnelManager>().kill_all();
                // ... and stop polling GitHub for pull requests.
                app.state::<prwatch::PrWatcher>().shutdown();
            }
        });
}
