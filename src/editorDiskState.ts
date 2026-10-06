// Retain hashes, not another copy of every open document. Refreshing a remote
// workspace is an observation, not proof that an open file changed on disk.
async function fingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class EditorDiskState {
  private files = new Map<string, { hash?: string; revision: number; pending: number; tail: Promise<void> }>();
  private file(path: string) {
    let state = this.files.get(path);
    if (!state) { state = { revision: 0, pending: 0, tail: Promise.resolve() }; this.files.set(path, state); }
    return state;
  }
  async remember(path: string, text: string) {
    const state = this.file(path), revision = ++state.revision;
    const hash = await fingerprint(text);
    if (state.revision === revision) state.hash = hash;
  }
  beginRead(path: string): number | null {
    const state = this.file(path);
    return state.pending ? null : state.revision;
  }
  async changed(path: string, text: string, revision: number): Promise<boolean> {
    const state = this.file(path), hash = await fingerprint(text);
    if (state.pending || state.revision !== revision) return false;
    const changed = state.hash != null && state.hash !== hash;
    state.hash = hash;
    state.revision++;
    return changed;
  }
  async write(path: string, text: string, writer: () => Promise<unknown>) {
    const state = this.file(path);
    state.pending++; state.revision++;
    const save = state.tail.then(async () => {
      // Hash before writing so a hashing failure cannot report a successful
      // disk write as failed. Serialize writes to preserve save order.
      const hash = await fingerprint(text);
      await writer();
      state.hash = hash;
    });
    state.tail = save.catch(() => {});
    try { await save; } finally { state.pending--; state.revision++; }
  }
  retain(paths: Set<string>) {
    for (const [path, state] of this.files) if (!paths.has(path) && !state.pending) this.files.delete(path);
  }
}
