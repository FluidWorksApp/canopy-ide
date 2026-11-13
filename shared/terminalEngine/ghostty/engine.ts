// Loads canopy-term-wasm: the Ghostty engine (the one the native window
// uses) compiled for the webview. One module instance serves every terminal.
//
// The instance is loaded once at startup. A terminal that is created before
// it is ready, or after it failed, is an xterm terminal (see ../index.ts), so
// nothing ever waits on this.
import init, { initSync, Terminal as WasmTerminal } from "../pkg/canopy_term_wasm.js";
import type { InitOutput } from "../pkg/canopy_term_wasm.js";

export { WasmTerminal };

type State = "idle" | "loading" | "ready" | "failed";

let state: State = "idle";
let failure = "";
let output: InitOutput | null = null;
let loading: Promise<boolean> | null = null;
const failureListeners = new Set<(reason: string) => void>();

/** Short, content-free reason codes only: they end up in a log and a badge. */
export type GhosttyFailure =
  | "no-webassembly"
  | "load-failed"
  | "load-timeout"
  | "engine-trap"
  | "out-of-memory";

export function ghosttyReady(): boolean {
  return state === "ready";
}

/** Why the engine is unavailable; empty while it is fine or still loading. */
export function ghosttyFailure(): string {
  return state === "failed" ? failure : "";
}

/** Bytes of linear memory the engine holds for all terminals together. */
export function ghosttyMemoryBytes(): number {
  try {
    return output?.memory.buffer.byteLength ?? 0;
  } catch {
    return 0;
  }
}

export function onGhosttyFailure(listener: (reason: string) => void): () => void {
  failureListeners.add(listener);
  return () => failureListeners.delete(listener);
}

/** The engine trapped (a wasm `unreachable`, or memory it could not grow).
 *  Its memory can no longer be trusted, so every terminal on it stops and new
 *  terminals use xterm for the rest of the session. */
export function failGhostty(reason: GhosttyFailure): void {
  if (state === "failed") return;
  state = "failed";
  failure = reason;
  for (const listener of [...failureListeners]) {
    try {
      listener(reason);
    } catch {
      // One listener's failure must not hide the engine's from the others.
    }
  }
}

export function classifyTrap(error: unknown): GhosttyFailure {
  const text = error instanceof Error ? error.message : String(error);
  return /memory|allocation|out of bounds/i.test(text) ? "out-of-memory" : "engine-trap";
}

/** Start loading. Resolves true when terminals can use the engine. Safe to
 *  call repeatedly; never rejects. */
export function loadGhostty(url: string | URL): Promise<boolean> {
  if (state === "ready") return Promise.resolve(true);
  if (state === "failed") return Promise.resolve(false);
  if (loading) return loading;
  if (typeof WebAssembly !== "object") {
    failGhostty("no-webassembly");
    return Promise.resolve(false);
  }
  state = "loading";
  loading = init({ module_or_path: url }).then(
    (out) => {
      if (state !== "loading") return false;
      output = out;
      state = "ready";
      return true;
    },
    () => {
      failGhostty("load-failed");
      return false;
    },
  );
  return loading;
}

/** For tests and Node: instantiate from bytes already in hand. */
export function loadGhosttyFromBytes(bytes: BufferSource): void {
  if (state === "ready") return;
  output = initSync({ module: bytes });
  state = "ready";
  failure = "";
}

/** Tests only. */
export function resetGhosttyStateForTests(): void {
  if (output) state = "ready";
  failure = "";
}
