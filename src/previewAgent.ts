// Hand-off point between ProjectView (which receives an agent's browser op and
// decides which preview tab it targets — creating and focusing one if needed)
// and PreviewView (which executes it against the live iframe). The two can't
// talk directly: the target view may not be mounted yet when the op arrives,
// since activating the tab is what mounts it. So ops are queued per tab id and
// flushed the moment that tab's PreviewView registers.
import * as ipc from "./ipc";

const handlers = new Map<string, (op: ipc.AgentBrowserOp) => void>();
const queued = new Map<string, ipc.AgentBrowserOp[]>();
export const MAX_QUEUED_BROWSER_OPS_PER_TAB = 64;
export const MAX_QUEUED_BROWSER_TABS = 32;

function rejectQueued(tabId: string, reason: string) {
  const q = queued.get(tabId);
  queued.delete(tabId);
  q?.forEach((op) => void ipc.browserResult(op.id, false, reason));
}

/** Drop work for a preview that can no longer mount, answering every held MCP
 *  request instead of retaining it until the bridge's much longer timeout. */
export function forgetBrowserTarget(tabId: string) {
  rejectQueued(tabId, "The target preview was closed before the browser operation could run.");
}

/** Route an op to a preview tab, queueing it if the view isn't mounted yet. */
export function dispatchBrowserOp(tabId: string, op: ipc.AgentBrowserOp) {
  const handler = handlers.get(tabId);
  if (handler) {
    handler(op);
    return;
  }
  const q = queued.get(tabId) ?? [];
  if (!queued.has(tabId) && queued.size >= MAX_QUEUED_BROWSER_TABS) {
    const oldest = queued.keys().next();
    if (!oldest.done) {
      rejectQueued(
        oldest.value,
        "Too many previews were waiting to handle browser operations. Re-open the preview and retry.",
      );
    }
  }
  while (q.length >= MAX_QUEUED_BROWSER_OPS_PER_TAB) {
    const dropped = q.shift();
    if (dropped) {
      void ipc.browserResult(
        dropped.id,
        false,
        "Too many browser operations queued before the preview opened. Retry after the page is visible.",
      );
    }
  }
  q.push(op);
  // Updating a queue makes it the newest tab for global eviction purposes.
  queued.delete(tabId);
  queued.set(tabId, q);
}

/** Called by a mounting PreviewView; drains anything queued for its tab.
 *  Returns the unregister cleanup. */
export function registerBrowserTarget(tabId: string, handler: (op: ipc.AgentBrowserOp) => void) {
  handlers.set(tabId, handler);
  const q = queued.get(tabId);
  queued.delete(tabId);
  q?.forEach(handler);
  return () => {
    if (handlers.get(tabId) === handler) handlers.delete(tabId);
  };
}
