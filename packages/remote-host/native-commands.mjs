// The native command surface of this host runtime. The desktop imports it too
// (NativeWorkspaceHost.ts): a command listed here that a workspace answers with
// "does not support … yet" means the workspace runs an older host, which the
// IDE says plainly instead of reporting a missing feature. Bump HOST_PROTOCOL
// whenever commands are added, so a desktop can tell a stale host up front.
// native-commands.test.mjs keeps this list equal to what native.mjs handles.
export const HOST_PROTOCOL=2;
export const NATIVE_PREFIXES=['fs_upload_','claude_ide_'];
export const NATIVE_COMMANDS=new Set([
 // Files, projects and the workspace itself.
 'store_load','store_save','store_changes','instance_id','host_capabilities','channel_poll','channel_drop','task_spawn_binding','task_mark_spawned','task_mark_launch_failed','fs_read_dir','fs_read_file','fs_write_file','fs_create_file','fs_create_dir','fs_trash','fs_rename','fs_duplicate','fs_stat','fs_stat_many','fs_list_files','fs_search','fs_register_roots','fs_unregister_roots','workspace_add','workspace_list','workspace_remove','workspace_register','workspace_unregister','workspace_activity','workspace_metrics','workspace_browser_open','workspace_browser_request','workspace_preview_open','workspace_chrome_stream_open','workspace_chrome_stream_close','desktop_session','which_check','cli_versions','cli_take_pending_open','cli_take_pending_link','oauth_callback','terminal_governor_status','relay_status','session_process_stats','pty_metadata_get','pty_metadata_set',
 // Git.
 'git_head_content','git_log','git_checkout','git_clone','git_clone_start','git_clone_status','git_clone_cancel','git_stage','git_unstage','git_commit_detail','git_commit_patch','git_branch_commits','git_branch_patch','git_commit_paths','git_commit','git_fetch','git_pull','git_push','git_repos','git_status','git_repo_status','git_branches','git_worktrees','git_diff','git_remote_url','git_branch_current',
 // Agents, accounts and their integrations.
 'agent_workspace_at','agent_events_poll','agent_health_report','agent_hooks_installed','agent_integration_health','agent_session_summaries','agent_usage','claude_session_stats','opencode_session_stats','plan_usage','hook_bridge_path','setup_agent_hooks','session_digests','session_history','profiles_list','profile_create','profile_delete','profile_env','profile_activate','profile_accounts','profile_import_git','profile_import_credentials','profile_prepare_session','mcp_servers','mcp_update_sources',
 // Small metadata stores.
 'notes_list','notes_due','research_list','task_list_history','context_tools','context_publish','set_context_scopes','pr_watch_set','pr_watch_list',
 // Agent instructions, model catalogs, readiness probes, processes.
 'instructions_scan','instructions_read','instructions_write','model_catalog','probe_http_readiness','kill_process',
 // Disk cleanup.
 'cleanup_scan','cleanup_run','cleanup_disk',
 // Language servers.
 'lsp_start','lsp_send','lsp_stop',
 // GitHub (gh CLI, authenticated by profile_import_git).
 'gh_available','gh_auth','gh_pr_list','gh_pr_diff','gh_pr_body','gh_pr_state','gh_pr_review','gh_pr_checkout','gh_pr_merge','gh_pr_close','gh_pr_ready','gh_pr_conversation','gh_pr_links','gh_pr_thread_reply','gh_pr_thread_resolved','gh_pr_file_viewed','gh_pr_review_batch','gh_pr_update_branch','gh_pr_request_review','gh_pr_retarget','gh_pr_reviewer_candidates','gh_pr_auto_merge','gh_pr_failing_logs','gh_pr_diff_since','gh_issue_list','gh_issue_detail','gh_issue_set_state','gh_issue_comment',
 // Task envelopes.
 'task_reserve','task_attempt_reserve','task_attempt_start','task_attempt_settle','task_attempt_wait','task_list','task_get','task_get_for_attempt','task_list_all','task_update_metadata','task_interrupt_stale','task_delete','task_clear_history','task_transcript_append','task_transcript_list','task_event_append','task_event_list','task_artifact_write','task_artifact_read',
 // Workflow runs.
 'workflow_run_create','workflow_step_record','workflow_run_advance','workflow_run_resume','workflow_run_list','workflow_run_get',
 // Structured agent runners.
 'structured_runner_spawn','structured_runner_write','structured_runner_kill',
 // Undo-turn snapshots.
 'turn_snapshot','turn_list','turn_preview','turn_restore','turn_native_checkpoint',
 // Pull request provenance.
 'provenance_record','provenance_for_pr','provenance_for_session','provenance_backfill',
 // Git operations: worktrees, sync, branches, discard.
 'git_checkout_detached','git_branch_release','git_checkout_carry','git_discard','git_operation_quit','git_branch_at','git_branch_delete','git_branch_delete_remote','git_rev_count','git_show_at','git_share_context','git_work_audit','git_worktree_add','git_worktree_add_pr','git_worktree_bootstrap','git_worktree_remove','git_worktree_realign','git_worktree_prune','git_sync_probe','git_sync_apply','git_sync_abort','git_pr_merge_probe','fs_repo_path','fs_snapshot_files',
 // Agent changes panel.
 'agent_workspace','agent_edits',
]);
export const isNativeCommand=command=>typeof command==='string'&&(NATIVE_COMMANDS.has(command)||NATIVE_PREFIXES.some(prefix=>command.startsWith(prefix)));
/** How long the gateway waits for a command's answer: network Git and GitHub
 *  work, worktree setup and disk scans outlast the default 15 seconds. The
 *  desktop allows 15 seconds more for the trip itself. */
const LONG_NATIVE=new Set(['git_clone','git_fetch','git_pull','git_push','git_worktree_add','git_worktree_add_pr','git_worktree_bootstrap','git_sync_probe','git_sync_apply','git_pr_merge_probe','git_branch_delete_remote','git_share_context','git_work_audit','cleanup_scan','cleanup_run','provenance_backfill']);
export const nativeTimeoutMs=command=>LONG_NATIVE.has(command)?330_000:typeof command==='string'&&command.startsWith('gh_')?135_000:command==='profile_import_git'?45_000:15_000;
