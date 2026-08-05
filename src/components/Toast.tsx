import { memo } from "react";
import { releaseHighlights, type UpdateAvailability, type UpdateInfo } from "../updater";
import { ashStateFor, type AttentionItem } from "../attention";
import { Mascot } from "./Mascot";
import { CloseIcon } from "./icons";
import { Button } from "./ui";
import "../releaseNotes.css";

interface UpdateToastProps {
  /** Non-null when an update is available; the toast renders nothing otherwise. */
  update: NonNullable<UpdateAvailability>;
  /** Install progress 0..1, or null before install has started. */
  progress: number | null;
  onOpenDownloads: () => void;
  onInstall: () => void;
  onOpenReleaseNotes: () => void;
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
  onOpenReleaseNotes,
  onDismiss,
}: UpdateToastProps) {
  return (
    <div className="update-toast">
      <div className="update-head">
        <strong>Canopy {update.info.version}</strong> is available
      </div>
      <p className="update-summary">A new build is ready. Review what changed, then update when your agents are at a safe stopping point.</p>
      <button className="update-release-link" onClick={onOpenReleaseNotes}>
        View release notes <span aria-hidden="true">↗</span>
      </button>
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

interface ReleaseNotesToastProps {
  release: UpdateInfo;
  onOpen: () => void;
  onDismiss: () => void;
}

/** Shown once for a fresh install and once after each update relaunch. It is a
 * concise index into the canonical GitHub release, not a second markdown
 * renderer that can drift from it. */
function ReleaseNotesToastImpl({ release, onOpen, onDismiss }: ReleaseNotesToastProps) {
  const highlights = releaseHighlights(release.notes);
  const date = release.date
    ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(
        new Date(release.date),
      )
    : null;
  return (
    <section className="release-notes-toast" aria-label={`What's new in Canopy ${release.version}`}>
      <div className="release-notes-kicker">WHAT'S NEW</div>
      <div className="release-notes-title">
        <div>
          <strong>Canopy {release.version}</strong>
          <span>{date ? `Released ${date}` : "You’re running the latest build"}</span>
        </div>
        <button className="release-notes-close" aria-label="Dismiss release notes" onClick={onDismiss}>
          <CloseIcon size={12} />
        </button>
      </div>
      {highlights.length > 0 ? (
        <ul className="release-notes-list">
          {highlights.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : (
        <p className="release-notes-fallback">See the improvements, fixes, and technical details in the full release notes.</p>
      )}
      <button className="release-notes-open" onClick={onOpen}>
        Read the full release on GitHub <span aria-hidden="true">↗</span>
      </button>
    </section>
  );
}

export const ReleaseNotesToast = memo(ReleaseNotesToastImpl);

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
      {/* Compact tier, for the same reason as the list rows: below 25 the
          ladder turns expression off and a question would read as a tinted
          blob rather than a face. */}
      <Mascot state={ashStateFor(item)} size={26} className="notice-ash" />
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
