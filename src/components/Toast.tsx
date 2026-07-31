import { memo } from "react";
import type { UpdateAvailability } from "../updater";
import type { AttentionItem } from "../attention";
import { CloseIcon } from "./icons";
import { Button } from "./ui";

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
          <Button variant="accent" onClick={onOpenDownloads}>
            Open downloads page
          </Button>
          <Button onClick={onDismiss}>
            Later
          </Button>
        </div>
      ) : progress === null ? (
        <div className="update-actions">
          <Button variant="accent" onClick={onInstall}>
            Install and restart
          </Button>
          <Button onClick={onDismiss}>
            Later
          </Button>
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
  item: AttentionItem;
  onDismiss: () => void;
  onFollow: () => void;
}

// One item from the attention channel, as a strip in the corner.
//
// The click used to mean "dismiss", because there was nothing else it could
// mean — a notice was a string with no idea what it was about. An item carries
// a target, so the body follows it and dismissing moves to its own affordance.
// Without a target it keeps the old behaviour rather than offering a click that
// would land nowhere.
function NoticeToastImpl({ item, onDismiss, onFollow }: NoticeToastProps) {
  const clickable = item.where != null;
  return (
    <div
      className={`notice notice-${item.tone}${
        item.kind === "question" ? " notice-question" : ""
      }${clickable ? " notice-clickable" : ""}`}
      onClick={clickable ? onFollow : onDismiss}
      title={clickable ? "Open" : "dismiss"}
    >
      <div className="notice-text">
        {item.projectName && (
          <span className="notice-project">{item.projectName}</span>
        )}
        {item.title}
        {item.body && <span className="notice-body">{item.body}</span>}
      </div>
      {clickable && (
        <button
          className="notice-x"
          title="Dismiss"
          aria-label="Dismiss"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
        >
          <CloseIcon size={11} />
        </button>
      )}
    </div>
  );
}

export const NoticeToast = memo(NoticeToastImpl);
