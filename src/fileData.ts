import { IoBudget, rendererIoBudget } from "./ioBudget";

// readAsDataURL retains the selected File while materialising a second, 4/3
// base64 representation. Twelve MiB keeps that conservative peak below the
// shared 32 MiB per-project active-byte ceiling.
export const MAX_CONTEXT_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_COMPANION_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const DATA_URL_OVERHEAD_BYTES = 1024;

export function base64ReadAdmissionBytes(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return Number.MAX_SAFE_INTEGER;
  const encoded = Math.ceil(bytes / 3) * 4;
  if (encoded > Number.MAX_SAFE_INTEGER - bytes - DATA_URL_OVERHEAD_BYTES) {
    return Number.MAX_SAFE_INTEGER;
  }
  return bytes + encoded + DATA_URL_OVERHEAD_BYTES;
}

export interface Base64ReadOptions {
  scope: string;
  maxBytes: number;
  signal?: AbortSignal;
  budget?: IoBudget;
}

/** Read a user-selected file without letting several surfaces encode large
 * base64 copies at once. FileReader is genuinely cancellable, unlike a Tauri
 * invoke, so superseding/unmounting aborts both queued and admitted work. */
export async function readFileBase64(
  file: File,
  options: Base64ReadOptions,
): Promise<string> {
  if (file.size > options.maxBytes) {
    throw new Error(
      `${file.name || "file"} exceeds the ${Math.round(options.maxBytes / 1024 / 1024)} MB attachment limit`,
    );
  }
  return (options.budget ?? rendererIoBudget).run(
    {
      scope: options.scope,
      bytes: base64ReadAdmissionBytes(file.size),
      signal: options.signal,
    },
    (signal) =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        let settled = false;
        const finish = (value?: string, error?: unknown) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve(value ?? "");
        };
        const onAbort = () => {
          reader.abort();
          finish(undefined, Object.assign(new Error("file read was cancelled"), { name: "AbortError" }));
        };
        reader.onerror = () => finish(undefined, reader.error ?? new Error("file read failed"));
        reader.onabort = () =>
          finish(undefined, Object.assign(new Error("file read was cancelled"), { name: "AbortError" }));
        reader.onload = () => {
          const encoded = String(reader.result);
          finish(encoded.slice(encoded.indexOf(",") + 1));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        else reader.readAsDataURL(file);
      }),
  );
}
