/** Preflight OOXML/ODS zip containers before SheetJS or mammoth inflate them. */
export interface ArchiveBudget {
  maxEntries: number;
  maxExpandedBytes: number;
  maxEntryBytes: number;
}

export const VIEWER_ARCHIVE_BUDGET: ArchiveBudget = {
  maxEntries: 4096,
  maxExpandedBytes: 32 * 1024 * 1024,
  maxEntryBytes: 16 * 1024 * 1024,
};

const EOCD = 0x06054b50;
const CENTRAL_FILE = 0x02014b50;

const u16 = (view: DataView, at: number) => view.getUint16(at, true);
const u32 = (view: DataView, at: number) => view.getUint32(at, true);

/** Null means either a bounded zip or a non-zip format such as CSV/XLS. */
export function archiveBudgetError(
  bytes: Uint8Array,
  budget: ArchiveBudget = VIEWER_ARCHIVE_BUDGET,
): string | null {
  if (
    bytes.byteLength < 4 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const searchStart = Math.max(0, bytes.byteLength - (65_535 + 22));
  let eocd = -1;
  for (let at = bytes.byteLength - 22; at >= searchStart; at--) {
    if (u32(view, at) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return "Zip central directory is missing or exceeds its comment limit.";

  const disk = u16(view, eocd + 4);
  const centralDisk = u16(view, eocd + 6);
  const entries = u16(view, eocd + 10);
  const centralBytes = u32(view, eocd + 12);
  const centralOffset = u32(view, eocd + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entries === 0xffff ||
    centralBytes === 0xffff_ffff ||
    centralOffset === 0xffff_ffff
  ) {
    return "Multi-disk and ZIP64 viewer archives are not supported.";
  }
  if (entries > budget.maxEntries) {
    return `Archive has ${entries} entries; the viewer limit is ${budget.maxEntries}.`;
  }
  if (
    centralOffset > bytes.byteLength ||
    centralBytes > bytes.byteLength - centralOffset
  ) {
    return "Zip central directory points outside the file.";
  }

  let at = centralOffset;
  let expanded = 0;
  for (let index = 0; index < entries; index++) {
    if (at + 46 > bytes.byteLength || u32(view, at) !== CENTRAL_FILE) {
      return "Zip central directory is truncated or malformed.";
    }
    const entryBytes = u32(view, at + 24);
    if (entryBytes === 0xffff_ffff) {
      return "ZIP64 viewer archive entries are not supported.";
    }
    if (entryBytes > budget.maxEntryBytes) {
      return `Archive entry expands to ${entryBytes} bytes; the per-entry limit is ${budget.maxEntryBytes}.`;
    }
    expanded += entryBytes;
    if (!Number.isSafeInteger(expanded) || expanded > budget.maxExpandedBytes) {
      return `Archive expands past the ${budget.maxExpandedBytes}-byte viewer limit.`;
    }
    const name = u16(view, at + 28);
    const extra = u16(view, at + 30);
    const comment = u16(view, at + 32);
    at += 46 + name + extra + comment;
  }
  return null;
}
