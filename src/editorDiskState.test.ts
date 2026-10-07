import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { EditorDiskState } from './editorDiskState';
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

it('does not mistake unsaved edits for a disk change during repeated remote refreshes', async () => {
  const disk = new EditorDiskState();
  await disk.remember('file', 'original');
  expect(await disk.changed('file', 'original', disk.beginRead('file')!)).toBe(false);
  expect(await disk.changed('file', 'original', disk.beginRead('file')!)).toBe(false);
  expect(await disk.changed('file', '', disk.beginRead('file')!)).toBe(true);
  // Keeping the editor version must not re-open the same disk conflict.
  expect(await disk.changed('file', '', disk.beginRead('file')!)).toBe(false);
});
it('keeps a new empty document editable after typing or pasting into its editor',async()=>{
  const disk=new EditorDiskState();await disk.remember('new.env','');
  // The editor now has a pasted draft, while disk still contains an empty file.
  expect(await disk.changed('new.env','',disk.beginRead('new.env')!)).toBe(false);
  expect(await disk.changed('new.env','',disk.beginRead('new.env')!)).toBe(false);
  await disk.write('new.env','synthetic pasted draft',async()=>{});
  expect(await disk.changed('new.env','synthetic pasted draft',disk.beginRead('new.env')!)).toBe(false);
});
it('ignores a stale read completing after a successful save', async () => {
  const disk = new EditorDiskState(); await disk.remember('file', 'old');
  const read = disk.beginRead('file')!;
  await disk.write('file', 'new', async () => {});
  expect(await disk.changed('file', 'old', read)).toBe(false);
  expect(await disk.changed('file', 'new', disk.beginRead('file')!)).toBe(false);
});
it('serializes saves and retains the latest disk baseline', async () => {
  const disk = new EditorDiskState(), writes: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = disk.write('file', 'first', async () => { await gate; writes.push('first'); });
  const second = disk.write('file', 'second', async () => { writes.push('second'); });
  expect(disk.beginRead('file')).toBeNull();
  release(); await Promise.all([first, second]);
  expect(writes).toEqual(['first', 'second']);
  expect(await disk.changed('file', 'second', disk.beginRead('file')!)).toBe(false);
});
it('reports a failed write while preserving the last known disk baseline', async () => {
  const disk = new EditorDiskState(); await disk.remember('file', 'old');
  await expect(disk.write('file', 'new', async () => { throw Error('disconnected'); })).rejects.toThrow('disconnected');
  expect(await disk.changed('file', 'old', disk.beginRead('file')!)).toBe(false);
});
