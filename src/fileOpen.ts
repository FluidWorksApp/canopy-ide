// Should this file be opened at all, and if not, why.
//
// Every open used to be `fsReadFile` first, ask questions never: clicking a
// 2 GB .zip in the tree pulled the whole archive across IPC into the webview
// and then handed the bytes to Monaco, which tried to tokenize them. The tab
// froze, and the memory stayed spent until it was closed.
//
// So an open is now gated twice: on the stat, before a single byte is read
// (size and known-binary extension), and on the bytes for anything whose
// extension says nothing (a NUL byte means binary however it is named).
import type { ViewerKind } from "./components/viewers";

/**
 * Extensions whose contents no viewer here can render. Archives, executables,
 * media and model weights — opening one is always a mistake, at any size, so
 * these are refused before the size test.
 *
 * Deliberately absent: everything Canopy *does* render natively — .pdf, .docx,
 * .xlsx, .ipynb and the image formats are binary too, and they have viewers.
 */
const BINARY_EXTENSIONS = new Set([
  // archives
  "zip", "tar", "gz", "tgz", "bz2", "tbz", "xz", "7z", "rar", "zst", "lz4", "lzma",
  "jar", "war", "ear", "whl", "apk", "aab", "ipa", "dmg", "iso", "pkg", "deb", "rpm",
  "msi", "cab", "crx", "xpi", "nupkg", "gem", "egg",
  // executables, objects, bytecode
  "exe", "dll", "so", "dylib", "a", "o", "obj", "lib", "bin", "elf", "com", "sys",
  "wasm", "class", "pyc", "pyo", "pyd", "node", "rlib", "rmeta", "pdb", "idb", "ilk",
  // audio / video
  "mp3", "wav", "flac", "aac", "ogg", "oga", "opus", "m4a", "wma", "aiff", "mid", "midi",
  "mp4", "m4v", "mov", "avi", "mkv", "webm", "wmv", "flv", "mpg", "mpeg", "3gp", "ogv",
  // images no <img> will take (the ones that render live in viewers.tsx)
  "psd", "psb", "ai", "sketch", "fig", "xcf", "raw", "cr2", "nef", "arw", "dng",
  "heic", "heif", "avif", "tiff", "tif", "icns",
  // fonts
  "ttf", "otf", "ttc", "woff", "woff2", "eot",
  // databases and stores
  "db", "db3", "sqlite", "sqlite3", "mdb", "accdb", "realm", "idx", "pack",
  // ML weights and datasets
  "onnx", "safetensors", "gguf", "ggml", "pt", "pth", "ckpt", "h5", "hdf5", "npy",
  "npz", "pb", "tflite", "mlmodel", "parquet", "arrow", "feather", "avro",
  // misc opaque blobs
  "lockb", "swp", "swo", "pch", "gch",
]);
// Extensions that are usually-but-not-always binary (.dat, .bak) are left out
// on purpose: the NUL sniff below catches them from their contents, and being
// wrong there costs the user a file they can't open by any means.

/** Text-ish kinds go through Monaco or the DOM, and both fall over long before
 *  the file does. VS Code stops tokenizing well before this too. */
const TEXT_LIMIT = 8 * 1024 * 1024;
/** Kinds parsed in full by a JS library (SheetJS, mammoth, JSON.parse) — the
 *  parse peak is several times the file, so the cap is lower than it looks. */
const STRUCTURED_TEXT_LIMIT = 8 * 1024 * 1024;
const ARCHIVE_PARSE_LIMIT = 16 * 1024 * 1024;
/** Kinds handed straight to the platform as a blob URL. Cheap; the cap only
 *  exists so a mis-sized file can't blow the webview's memory. */
const MEDIA_LIMIT = 128 * 1024 * 1024;

export function sizeLimitFor(kind: ViewerKind): number {
  switch (kind) {
    case "image":
    case "pdf":
      return MEDIA_LIMIT;
    case "sheet":
    case "docx":
      return ARCHIVE_PARSE_LIMIT;
    case "notebook":
    case "json":
      return STRUCTURED_TEXT_LIMIT;
    default:
      return TEXT_LIMIT;
  }
}

export type BlockReason = "binary" | "too-large";

export interface OpenBlock {
  reason: BlockReason;
  /** Actual size on disk, for the message. */
  size: number;
  /** The cap that was exceeded; only meaningful for "too-large". */
  limit: number;
}

export function isBinaryExtension(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * The verdict from the stat alone — no bytes read yet. Null means "go ahead".
 *
 * Size is checked against the viewer that would render it, so a 40 MB PDF
 * still opens while a 40 MB .log does not.
 */
export function blockForOpen(path: string, kind: ViewerKind, size: number): OpenBlock | null {
  const limit = sizeLimitFor(kind);
  if (isBinaryExtension(path)) return { reason: "binary", size, limit };
  if (size > limit) return { reason: "too-large", size, limit };
  return null;
}

/**
 * Last line of defence for extensions that claim nothing: a NUL byte in the
 * head of the file means it isn't text, whatever it is called (`.pack`,
 * `.dat`, or no extension at all). Only worth asking for text-ish kinds —
 * every media viewer expects binary by definition.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const head = Math.min(bytes.length, 8192);
  for (let i = 0; i < head; i++) if (bytes[i] === 0) return true;
  return false;
}

/** "4.2 MB" — sized in the units the message is about to compare against. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Headline + explanation for the panel shown in place of the viewer. */
export function describeBlock(block: OpenBlock): { title: string; detail: string } {
  if (block.reason === "binary") {
    return {
      title: "Binary file — not shown",
      detail: `This file type has no viewer here, and rendering it as text would be noise. ${formatBytes(block.size)} on disk.`,
    };
  }
  return {
    title: "File too large to open",
    detail: `${formatBytes(block.size)}, past the ${formatBytes(block.limit)} limit for this file type. Opening it would freeze the tab while it loads.`,
  };
}
