# Workspace panel and startup feedback

Workspace management opens in a nonmodal utility panel. It has no scrim, body scroll lock or focus trap, so the editor remains usable. Collapse the panel with the header control or Continue working; startup continues and moves into a floating progress bar. Expand Details to return to the same operation. On completion, workspace controls replace the progress in the panel.

The five stages come from the control plane's reported operation phase. The stage track represents those stages, not an estimated completion percentage. Elapsed time is informational. Readiness and connection still require a successful authenticated response.

Workspace lists are cached in memory and in bounded local storage, namespaced by a native SHA-256 credential fingerprint. Credentials themselves are never stored in the display cache. Opening the panel restores cached details immediately, then refreshes in the background. Requests from multiple mounted surfaces share one pending request; status refreshes every ten seconds. Initial loading shows a shimmer; failed background refresh retains the last display with an error and Retry. Persisted snapshots expire after 24 hours and cannot replace a newer live response.

Account changes and authentication rejection discard cached data. Responses arriving from a previous account are ignored. Cached permissions and state are display hints: every connection, lifecycle and sharing action remains authorized by the server.

Focused validation covers cached restore, concurrent request deduplication, offline refresh, stale-snapshot rejection, revoked access, late responses from a previous account, nonmodal editor access, collapse/expand, and readiness continuing while the panel is hidden.

Stop and Delete remain available while a managed workspace is preparing, including on expanded floating progress. Both open an explicit confirmation in the workspace panel. Stop retains files and installed tools; Delete requires the exact workspace name and permanently removes compute, storage and backups. A confirmed shutdown cancels pending IDE auto-connect. Only server-provided owner deletion permissions expose Delete. Saved connections to an externally managed host can be removed from this Mac; this does not delete host resources.

The server supersedes a pending or failed resume only after acquiring the provider worker's advisory lock. The shutdown carries the interrupted generation's storage and instance names so an allocation with a lost response is still discovered and ownership-checked. A provider step already in progress returns a retryable conflict; the IDE retries for up to 30 seconds, then leaves a visible retryable error. Resize and an existing deletion remain protected from competing operations.
