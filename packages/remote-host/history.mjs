import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

/** Bounded, serialized atomic replacement. Acceptance is durable before spawn.
 * A restart reports interrupted work rather than executing an ambiguous retry. */
export class SessionHistory {
  constructor(file) { this.file = file; this.queue = Promise.resolve(); }
  async load() {
    if (!this.file) return [];
    try {
      const text = await readFile(this.file, 'utf8');
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Session history too large');
      const entries = JSON.parse(text);
      if (!Array.isArray(entries) || entries.length > 256 || entries.some(e =>
        !Number.isInteger(e.session?.id) || e.session.id < 1 || typeof e.requestId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(e.fingerprint))) throw new Error('Invalid session history');
      return entries;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  save(entries) {
    if (!this.file) return Promise.resolve();
    const snapshot = JSON.stringify(entries);
    const operation = this.queue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.next`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, this.file);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
