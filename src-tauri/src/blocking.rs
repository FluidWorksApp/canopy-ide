//! Keeping blocking work off the async runtime's worker threads.
//!
//! Every `#[tauri::command]` declared `async fn` is dispatched as a *future* —
//! `tauri-macros` maps an async command to `respond_async_serialized`, which is
//! `tokio::spawn` on Tauri's shared multi-threaded runtime. A command that then
//! calls `Command::output()` does not await anything; it parks a tokio worker
//! for the whole life of the subprocess. `git.rs` is 60 such commands, and its
//! network ones (`fetch`, `pull`, `push`, `gh`) can sit there for up to two
//! minutes. With the runtime's worker count on the order of the core count, a
//! handful of slow repos is enough to stall unrelated async work — PTY writes,
//! the MCP client's stdio pumps, the relay — behind a `git fetch`.
//!
//! `io` is the one-line fix at the call site: it tells tokio the current thread
//! is about to block, so the runtime hands this worker's queued tasks to
//! another thread and picks them up there. The blocking call itself is
//! unchanged, which is the point — these are deep, synchronous call graphs
//! (`run` → `run_verbose` → `output`), and rewriting them around
//! `spawn_blocking` would mean threading `'static` ownership through every
//! helper for the same effect.
//!
//! Outside a multi-threaded runtime it just calls the function: the same code
//! is reached from the `canopy-hook` binary, from the relay's own
//! current-thread runtimes (`wsbridge.rs`), and from `#[tokio::test]`, which is
//! current-thread by default — and `block_in_place` panics on all of those.

/// Run a blocking call, yielding this runtime worker to other tasks first.
pub(crate) fn io<T>(f: impl FnOnce() -> T) -> T {
    use tokio::runtime::{Handle, RuntimeFlavor};
    match Handle::try_current() {
        Ok(h) if h.runtime_flavor() == RuntimeFlavor::MultiThread => tokio::task::block_in_place(f),
        _ => f(),
    }
}

#[cfg(test)]
mod tests {
    use super::io;

    #[test]
    fn runs_the_call_with_no_runtime_at_all() {
        assert_eq!(io(|| 7), 7);
    }

    // The relay's websocket pumps and every `#[tokio::test]` are current-thread
    // runtimes, where `block_in_place` is a panic rather than a hint.
    #[test]
    fn runs_the_call_on_a_current_thread_runtime() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        assert_eq!(rt.block_on(async { io(|| 7) }), 7);
    }

    #[test]
    fn runs_the_call_on_a_multi_thread_runtime() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .build()
            .unwrap();
        assert_eq!(rt.block_on(async { io(|| 7) }), 7);
    }
}
