// Bridges monaco-vscode-api's file service to the Rust core's scoped fs
// commands. Without this, the vscode layer (used by the language client for
// tsconfig discovery, go-to-definition into unopened files, etc.) has no way
// to read real files and throws unhandled "Unable to resolve nonexistent file"
// rejections. Reads/writes remain scope-checked to workspace roots in Rust.
import {
  FileSystemProviderCapabilities,
  FileSystemProviderError,
  FileSystemProviderErrorCode,
  FileType,
  registerFileSystemOverlay,
} from "@codingame/monaco-vscode-files-service-override";
import { Emitter, type Uri } from "monaco-editor";
import * as ipc from "../ipc";

interface Stat {
  type: FileType;
  ctime: number;
  mtime: number;
  size: number;
}

const notFound = (path: string) =>
  FileSystemProviderError.create(
    `file not found: ${path}`,
    FileSystemProviderErrorCode.FileNotFound,
  );
const noPerm = (op: string) =>
  FileSystemProviderError.create(
    `${op} not supported`,
    FileSystemProviderErrorCode.NoPermissions,
  );

class TauriFileSystemProvider {
  capabilities =
    FileSystemProviderCapabilities.FileReadWrite |
    FileSystemProviderCapabilities.PathCaseSensitive;

  private capabilitiesEmitter = new Emitter<void>();
  onDidChangeCapabilities = this.capabilitiesEmitter.event;
  private fileChangeEmitter = new Emitter<never[]>();
  onDidChangeFile = this.fileChangeEmitter.event;

  watch() {
    // The Rust notify watcher drives our own diff-first flow; the vscode layer
    // doesn't need change events for LSP reads.
    return { dispose() {} };
  }

  async stat(resource: Uri): Promise<Stat> {
    try {
      const s = await ipc.fsStat(resource.fsPath);
      return {
        type: s.is_dir ? FileType.Directory : FileType.File,
        ctime: s.modified_ms ?? 0,
        mtime: s.modified_ms ?? 0,
        size: s.size,
      };
    } catch {
      throw notFound(resource.fsPath);
    }
  }

  async readdir(resource: Uri): Promise<[string, FileType][]> {
    try {
      const entries = await ipc.fsReadDir(resource.fsPath);
      return entries.map((e) => [
        e.name,
        e.is_dir ? FileType.Directory : FileType.File,
      ]);
    } catch {
      throw notFound(resource.fsPath);
    }
  }

  async readFile(resource: Uri): Promise<Uint8Array> {
    try {
      return await ipc.fsReadFile(resource.fsPath);
    } catch {
      throw notFound(resource.fsPath);
    }
  }

  async writeFile(resource: Uri, content: Uint8Array): Promise<void> {
    try {
      await ipc.fsWriteFile(resource.fsPath, new TextDecoder().decode(content));
    } catch {
      throw noPerm("write outside workspace");
    }
  }

  async mkdir(): Promise<void> {
    throw noPerm("mkdir");
  }
  async delete(): Promise<void> {
    throw noPerm("delete");
  }
  async rename(): Promise<void> {
    throw noPerm("rename");
  }
}

export function registerTauriFileSystem(): void {
  registerFileSystemOverlay(1, new TauriFileSystemProvider());
}
