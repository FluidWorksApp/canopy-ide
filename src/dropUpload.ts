/** State for the progress strip shown while dropped files upload to a remote workspace. */
export interface DropUploadState {
  id: string;
  status: "uploading" | "error";
  name: string;
  bytes: number;
  totalBytes: number;
  files: number;
  totalFiles: number;
  error?: string;
}

export type DropUploadAction =
  | { type: "start"; id: string; totalFiles: number; name?: string }
  | {
      type: "progress";
      id: string;
      name: string;
      bytes: number;
      totalBytes: number;
      files: number;
      totalFiles: number;
    }
  | { type: "done"; id: string }
  | { type: "fail"; id: string; error: string }
  | { type: "dismiss" };

/** Reducer: null means nothing to show. Events for a stale id are ignored. */
export function dropUploadReducer(
  state: DropUploadState | null,
  action: DropUploadAction,
): DropUploadState | null {
  switch (action.type) {
    case "start":
      return {
        id: action.id,
        status: "uploading",
        name: action.name ?? "",
        bytes: 0,
        totalBytes: 0,
        files: 0,
        totalFiles: action.totalFiles,
      };
    case "progress":
      if (!state || state.id !== action.id || state.status !== "uploading") return state;
      return {
        ...state,
        name: action.name || state.name,
        bytes: action.bytes,
        totalBytes: action.totalBytes,
        files: action.files,
        totalFiles: action.totalFiles,
      };
    case "done":
      return state && state.id === action.id ? null : state;
    case "fail":
      if (!state || state.id !== action.id) return state;
      return { ...state, status: "error", error: action.error };
    case "dismiss":
      return null;
  }
}

/** 0..100 while bytes are known, null (indeterminate) before the first event. */
export function dropUploadPercent(state: DropUploadState): number | null {
  if (state.totalBytes <= 0) return null;
  return Math.min(100, Math.round((state.bytes / state.totalBytes) * 100));
}

export function dropUploadErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text || "Upload failed";
}
