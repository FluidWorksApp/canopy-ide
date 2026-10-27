// Keep the instruction file's generated "Team memory" section in step with
// what is approved, so approving a memory is the only step.
//
// The section itself (between markers, nothing outside them touched) is
// memoryLedger.ts `renderMemorySection` / `spliceMemorySection`, the same one
// the Memory panel's "Update the instruction file" writes. That button
// remembers which file it wrote for the project; from then on — unless the
// person turned it off in Settings → Agents → Team memory — every approval,
// edit, rejection or expiry rewrites the section in that file.

import * as ipc from "./ipc";
import { listMemories, renderMemorySection, spliceMemorySection } from "./memoryLedger";
import { getSettings, updateSettings } from "./settings";

/** Whether approvals rewrite the section for the project keyed `key`: on
 *  once "Update the instruction file" has been used there, unless the person
 *  switched it off. */
export function instructionAutoUpdateOn(key: string): boolean {
  const s = getSettings();
  if (s.memoryInstructionAutoUpdate === false) return false;
  return !!s.memoryInstructionFiles[key];
}

/** Called after "Update the instruction file" wrote `path` for the project. */
export function rememberInstructionFile(key: string, path: string): void {
  const files = getSettings().memoryInstructionFiles;
  if (files[key] === path) return;
  updateSettings({ memoryInstructionFiles: { ...files, [key]: path } });
}

export interface InstructionSyncDeps {
  list: typeof listMemories;
  read: typeof ipc.instructionsRead;
  write: typeof ipc.instructionsWrite;
}

const realDeps: InstructionSyncDeps = {
  list: listMemories,
  read: (path, roots) => ipc.instructionsRead(path, roots),
  write: (path, roots, content) => ipc.instructionsWrite(path, roots, content),
};

/** Rewrite the section for the project keyed `key` (its first component)
 *  when auto-update is on, from the memory in every ledger the project spans.
 *  Resolves with the file written, or null when it is off or unchanged. */
export async function regenerateInstructionSection(
  key: string,
  roots: readonly string[],
  ledgerRoots: readonly string[],
  deps: InstructionSyncDeps = realDeps,
): Promise<string | null> {
  if (!instructionAutoUpdateOn(key)) return null;
  const path = getSettings().memoryInstructionFiles[key];
  const current = await deps.read(path, [...roots]).catch(() => "");
  const entries = (await Promise.all([...new Set(ledgerRoots)].map((r) => deps.list(r)))).flat();
  const next = spliceMemorySection(current, renderMemorySection(entries));
  if (next === current) return null;
  await deps.write(path, [...roots], next);
  return path;
}
