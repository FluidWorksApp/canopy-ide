// Hand-off point between ProjectView (which receives an agent's browser op and
// decides which preview tab it targets — creating and focusing one if needed)
// and PreviewView (which executes it against the live iframe). The two can't
// talk directly: the target view may not be mounted yet when the op arrives,
// since activating the tab is what mounts it. So ops are queued per tab id and
// flushed the moment that tab's PreviewView registers.
import type { AgentBrowserOp } from "./ipc";

const handlers = new Map<string, (op: AgentBrowserOp) => void>();
const queued = new Map<string, AgentBrowserOp[]>();

/** Route an op to a preview tab, queueing it if the view isn't mounted yet. */
export function dispatchBrowserOp(tabId: string, op: AgentBrowserOp) {
  const handler = handlers.get(tabId);
  if (handler) {
    handler(op);
    return;
  }
  const q = queued.get(tabId) ?? [];
  q.push(op);
  queued.set(tabId, q);
}

/** Called by a mounting PreviewView; drains anything queued for its tab.
 *  Returns the unregister cleanup. */
export function registerBrowserTarget(tabId: string, handler: (op: AgentBrowserOp) => void) {
  handlers.set(tabId, handler);
  const q = queued.get(tabId);
  queued.delete(tabId);
  q?.forEach(handler);
  return () => {
    if (handlers.get(tabId) === handler) handlers.delete(tabId);
  };
}
