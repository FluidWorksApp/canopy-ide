import * as ipc from "./ipc";
import { type IoBudget, rendererIoBudget } from "./ioBudget";

export class FileReadLimitError extends Error {
  readonly path: string;
  readonly bytes: number;
  readonly limit: number;

  constructor(path: string, bytes: number, limit: number) {
    super(`${path} is ${bytes} bytes, past the ${limit}-byte read limit`);
    this.name = "FileReadLimitError";
    this.path = path;
    this.bytes = bytes;
    this.limit = limit;
  }
}

interface FileReader {
  stat(path: string): Promise<{ is_dir: boolean; size: number }>;
  read(path: string): Promise<Uint8Array>;
}

export interface BoundedFileReadOptions {
  scope: string;
  maxBytes: number;
  signal?: AbortSignal;
  budget?: IoBudget;
  reader?: FileReader;
}

/** Gate a whole-file IPC read before the native byte array crosses into the
 * renderer. The post-read check closes ordinary metadata drift for retention;
 * preventing a malicious/stat-read growth race allocation requires a bounded
 * native read command and remains a separate backend item. */
export async function readBoundedFile(
  path: string,
  options: BoundedFileReadOptions,
): Promise<Uint8Array> {
  const reader = options.reader ?? { stat: ipc.fsStat, read: ipc.fsReadFile };
  const stat = await reader.stat(path);
  if (stat.is_dir) throw new Error(`${path} is a directory`);
  if (stat.size > options.maxBytes) {
    throw new FileReadLimitError(path, stat.size, options.maxBytes);
  }
  const bytes = await (options.budget ?? rendererIoBudget).run(
    { scope: options.scope, bytes: stat.size, signal: options.signal },
    () => reader.read(path),
  );
  if (bytes.byteLength > options.maxBytes) {
    throw new FileReadLimitError(path, bytes.byteLength, options.maxBytes);
  }
  return bytes;
}
