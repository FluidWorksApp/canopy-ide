// Browser ops Canopy asks of its own preview, not on an agent's behalf.
//
// An agent's canopy_browser_* call arrives from the MCP bridge with a positive
// id and is answered through `ipc.browserResult`, which releases the agent's
// held HTTP request. The workspace sometimes wants the same answers for itself
// — a proof receipt photographs the preview before and after a turn — and must
// not invent a bridge request to get them. So it sends the op down the very
// same path (the `canopy:agent-browser` window event ProjectView routes to a
// PreviewView) under a negative id, and `browserResult` hands any negative id
// back here instead of to the bridge. Same routing, same engines (webview,
// proxy, chrome-stream), no second capture implementation to drift.
//
// No IPC import: ipc.ts calls `settleLocalBrowserOp`, so this module must not
// pull ipc.ts in.

export type LocalOp = "screenshot" | "snapshot";

export interface LocalOpResult {
  ok: boolean;
  data: unknown;
}

let nextId = -1;
const waiting = new Map<number, { resolve(r: LocalOpResult): void; timer: ReturnType<typeof setTimeout> }>();

/** Called by ipc.browserResult. True when the id was one of ours. */
export function settleLocalBrowserOp(id: number, ok: boolean, data: unknown): boolean {
  if (id >= 0) return false;
  const w = waiting.get(id);
  if (!w) return true; // ours, but already timed out: never send it to the bridge
  waiting.delete(id);
  clearTimeout(w.timer);
  w.resolve({ ok, data });
  return true;
}

/** Ask the preview for `route`'s project (the project containing that folder)
 *  for one op. `quiet`: no picture-in-picture, no claiming the tab for an
 *  agent — the person never sees this happen. Resolves `{ok:false}` when no
 *  preview is open or nothing answers in time; never rejects. */
export function localBrowserOp(
  op: LocalOp,
  route: string,
  opts: { ptyId?: number | null; max?: number; timeoutMs?: number } = {},
): Promise<LocalOpResult> {
  if (typeof window === "undefined") return Promise.resolve({ ok: false, data: "no window" });
  const id = nextId--;
  if (nextId < -1_000_000_000) nextId = -1;
  return new Promise<LocalOpResult>((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve({ ok: false, data: "The preview did not answer in time." });
    }, opts.timeoutMs ?? 8000);
    waiting.set(id, { resolve, timer });
    window.dispatchEvent(
      new CustomEvent("canopy:agent-browser", {
        detail: {
          projectId: null,
          op: {
            id,
            op,
            route,
            ptyId: opts.ptyId ?? null,
            quiet: true,
            ...(opts.max ? { max: opts.max } : {}),
          },
        },
      }),
    );
  });
}

/** Tests only. */
export function resetLocalBrowserOpsForTests(): void {
  for (const w of waiting.values()) clearTimeout(w.timer);
  waiting.clear();
  nextId = -1;
}
