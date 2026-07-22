// The seam between the shared components and each shell's backend. The desktop
// shell implements this over Tauri IPC (pty Channel / pty_write / pty_kill);
// the mobile portal implements it over the WebSocket protocol. Components never
// know which — they just attach, write, and kill.

export interface PtyHandlers {
  /** A chunk of raw terminal output. */
  onData: (bytes: Uint8Array) => void
  /** Clear and re-seed (a fresh snapshot follows). */
  onReset: () => void
  /** The PTY's authoritative grid, so the view can size to match. */
  onSize: (cols: number, rows: number) => void
  /** The session ended / is no longer attachable. */
  onGone: () => void
}

export interface Transport {
  /** Start streaming a PTY's output; returns a detach function. */
  attachPty(pty: number, handlers: PtyHandlers): () => void
  /** Send input (keystrokes / a prompt) to a PTY. */
  writePty(pty: number, data: string): void
  /** Terminate a PTY's process. */
  killPty(pty: number): void
}
