// The list of everything that has asked for your attention.
//
// A toast that faded used to be gone for good: no record, no "what did I miss",
// and — worse — no way to find the thing it was about, because it never carried
// one. This is the other half of the channel. Every item the app has posted is
// here, newest first, and every row is a click back to wherever it came from.
//
// Two sections, not one, because they answer different questions. "Waiting on
// you" is work: outstanding questions, oldest first, and the list is not empty
// until they are answered. Everything below it is history — already true,
// nothing to do. Merging them by timestamp would bury a stalled project under
// an afternoon of successful builds, which is the exact failure that made this
// necessary.
import { memo, useEffect, useState } from "react";
import {
  clearAttentionHistory,
  isOutstanding,
  markAllRead,
  outstandingQuestions,
  urgencyOf,
  type AttentionItem,
} from "../attention";
import { timeAgo } from "../dictationHistory";
import { Button } from "./ui";
import { useEscape } from "../useEscape";

/** Human label for the badge on a row. The source is what the user thinks in
 *  — "that was the task" — where the tone is only a colour. */
const SOURCE_LABEL: Record<AttentionItem["source"], string> = {
  app: "Canopy",
  team: "Team",
  task: "Task",
  agent: "Agent",
  project: "Project",
};

function Row({
  item,
  onFollow,
}: {
  item: AttentionItem;
  onFollow: (item: AttentionItem) => void;
}) {
  const waiting = isOutstanding(item);
  // A row with no target is not clickable, and says so by not looking it —
  // a click that lands nowhere is worse than one that isn't offered.
  const clickable = item.where != null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div
      className={`notif-row notif-${urgencyOf(item)}${waiting ? " notif-waiting" : ""}${
        item.readAt == null ? " notif-unread" : ""
      }${clickable ? " notif-clickable" : ""}`}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onFollow(item) : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onFollow(item);
              }
            }
          : undefined
      }
    >
      <div className="notif-head">
        <span className="notif-source">{SOURCE_LABEL[item.source]}</span>
        {item.projectName && (
          <span className="notif-project">{item.projectName}</span>
        )}
        <span className="notif-age">{timeAgo(item.ts, now)}</span>
      </div>
      <div className="notif-title">{item.title}</div>
      {item.body && <div className="notif-body">{item.body}</div>}
      {waiting && <div className="notif-cta">Waiting for you — open</div>}
      {/* Withdrawn says "it sorted itself out", which reads very differently a
          day later from "you never answered this". */}
      {item.kind === "question" && item.resolution === "withdrawn" && (
        <div className="notif-resolved">No longer needed</div>
      )}
    </div>
  );
}

function NotificationCenterImpl({
  items,
  onFollow,
  onClose,
}: {
  items: AttentionItem[];
  onFollow: (item: AttentionItem) => void;
  onClose: () => void;
}) {
  useEscape(onClose);
  const waiting = outstandingQuestions(items);
  const history = items.filter((x) => !isOutstanding(x));
  // Opening the list is what "read" means. Deliberately not on mount of each
  // row: a list you opened and scrolled past counts as seen, and an unread
  // count that only clears per-row never reaches zero.
  useEffect(() => {
    markAllRead();
  }, []);
  return (
    <div className="notif-backdrop" onMouseDown={onClose}>
      <div
        className="notif-panel"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Notifications"
      >
        <div className="notif-panel-head">
          <strong>Notifications</strong>
          <span className="notif-spacer" />
          {history.length > 0 && (
            <Button
              onClick={clearAttentionHistory}
              title="Clear history — anything still waiting on you stays"
            >
              Clear
            </Button>
          )}
        </div>

        {waiting.length > 0 && (
          <>
            <div className="notif-section">Waiting on you</div>
            {waiting.map((x) => (
              <Row key={x.id} item={x} onFollow={onFollow} />
            ))}
          </>
        )}

        {history.length > 0 && (
          <>
            {waiting.length > 0 && <div className="notif-section">Earlier</div>}
            {history.map((x) => (
              <Row key={x.id} item={x} onFollow={onFollow} />
            ))}
          </>
        )}

        {items.length === 0 && (
          <div className="notif-empty">Nothing has needed you.</div>
        )}
      </div>
    </div>
  );
}

export const NotificationCenter = memo(NotificationCenterImpl);
