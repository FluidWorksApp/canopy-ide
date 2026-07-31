// The desktop's binding of the shared file tree.
//
// The component itself lives in shared/FileTree.tsx so the remote portal can
// render the same one over its WebSocket RPC. All this does is say what "the
// filesystem" means here — the Rust core over Tauri IPC — and hand it the
// Material Icon Theme resolver, which is 1250 bundled SVGs and therefore a
// desktop-only luxury.
import * as ipc from "../ipc";
import { FileTree as SharedFileTree, type FileTreeFs } from "../../shared/FileTree";
import { fileIconUrl } from "./fileIcons";

export type { FileTreeFs } from "../../shared/FileTree";

/** The local disk, as the tree sees it. Every member is wired: this is the
 *  writable tree, unlike the portal's.
 *
 *  Each is a thunk rather than a direct reference so the `ipc.*` lookup happens
 *  when the tree calls it, not when this module loads. Binding eagerly meant a
 *  caller that only reads directories still had to provide every mutation on
 *  the way in — the module blew up at import time otherwise. */
const localFs: FileTreeFs = {
  readDir: (path) => ipc.fsReadDir(path),
  gitStatus: (root) => ipc.gitStatus(root),
  onFsChange: (cb) => ipc.onFsChange(cb),
  onGitChange: (cb) => ipc.onGitChange(cb),
  createFile: (path) => ipc.fsCreateFile(path),
  createDir: (path) => ipc.fsCreateDir(path),
  rename: (from, to) => ipc.fsRename(from, to),
  duplicate: (path) => ipc.fsDuplicate(path),
  trash: (path) => ipc.fsTrash(path),
  reveal: (path) => ipc.fsReveal(path),
};

type Props = Omit<Parameters<typeof SharedFileTree>[0], "fs" | "iconUrl">;

export function FileTree(props: Props) {
  return <SharedFileTree {...props} fs={localFs} iconUrl={fileIconUrl} />;
}
