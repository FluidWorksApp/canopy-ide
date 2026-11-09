import { dropUploadPercent, type DropUploadState } from "../dropUpload";
import "./dropUploadProgress.css";

/** Small strip overlaid at the bottom of a terminal while dropped files upload. */
export function DropUploadProgress({
  state,
  onDismiss,
}: {
  state: DropUploadState;
  onDismiss: () => void;
}) {
  if (state.status === "error") {
    return (
      <div className="drop-upload is-error" role="alert">
        <span className="drop-upload-text">Upload failed{state.error ? `: ${state.error}` : ""}</span>
        <button type="button" className="drop-upload-close" aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      </div>
    );
  }
  const percent = dropUploadPercent(state);
  const current = Math.min(state.files + 1, Math.max(state.totalFiles, 1));
  return (
    <div className="drop-upload" role="status" aria-live="polite">
      <span className="drop-upload-text">
        Uploading {state.name || "files"} ({current} of {Math.max(state.totalFiles, 1)})
      </span>
      <div
        className={`drop-upload-bar${percent === null ? " is-indeterminate" : ""}`}
        role="progressbar"
        aria-label="Upload progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <div className="drop-upload-fill" style={percent === null ? undefined : { width: `${percent}%` }} />
      </div>
    </div>
  );
}
