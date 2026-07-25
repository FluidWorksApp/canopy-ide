import { memo } from "react";
import type { UpdateAvailability } from "../updater";

interface UpdateToastProps {
  /** Non-null when an update is available; the toast renders nothing otherwise. */
  update: NonNullable<UpdateAvailability>;
  /** Install progress 0..1, or null before install has started. */
  progress: number | null;
  onOpenDownloads: () => void;
  onInstall: () => void;
  onDismiss: () => void;
}

// Update-available toast. Split by install kind: `manual` (.deb/.rpm) can only
// point at the downloads page; `auto` installs in place but never without a
// click — terminals hold live agent scrollback that a relaunch would destroy.
function UpdateToastImpl({
  update,
  progress,
  onOpenDownloads,
  onInstall,
  onDismiss,
}: UpdateToastProps) {
  return (
    <div className="update-toast">
      <div className="update-head">
        <strong>Canopy {update.info.version}</strong> is available
      </div>
      {update.info.notes && <div className="update-notes">{update.info.notes}</div>}
      {update.kind === "manual" ? (
        <div className="update-actions">
          <button className="btn btn-accent" onClick={onOpenDownloads}>
            Open downloads page
          </button>
          <button className="btn" onClick={onDismiss}>
            Later
          </button>
        </div>
      ) : progress === null ? (
        <div className="update-actions">
          <button className="btn btn-accent" onClick={onInstall}>
            Install and restart
          </button>
          <button className="btn" onClick={onDismiss}>
            Later
          </button>
        </div>
      ) : (
        <div className="update-progress">
          <div className="update-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
          <span className="update-pct">
            {Math.round(progress * 100)}% — Canopy will restart itself
          </span>
        </div>
      )}
    </div>
  );
}

export const UpdateToast = memo(UpdateToastImpl);

interface NoticeToastProps {
  text: string;
  kind: string;
  onDismiss: () => void;
}

// The lightweight click-to-dismiss notice strip (info/success/warn/error).
function NoticeToastImpl({ text, kind, onDismiss }: NoticeToastProps) {
  return (
    <div className={`notice notice-${kind}`} onClick={onDismiss} title="dismiss">
      {text}
    </div>
  );
}

export const NoticeToast = memo(NoticeToastImpl);
