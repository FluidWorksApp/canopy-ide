// A note opened as a tab: the thought, everything attached to it, and the two
// things you do with it — move it along, or hand it to an agent.
//
// The body is directly editable here, which research entries deliberately are
// not. A research entry is a record of what an agent found and editing it by
// hand would falsify the record; a note is your own sentence, and the most
// common thing you do with a thought you parked is add to it. So the body is a
// textarea that saves when you leave it, and renders as markdown when you're
// not in it.
import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";
import {
  NEXT_STATUSES,
  NOTES_EVENT,
  STATUS_BLURBS,
  STATUS_LABELS,
  STATUS_STEP,
  remove as removeNote,
  rename,
  setStatus,
  update,
} from "../notes";
import type { Notify } from "../types";
import { ago } from "./ProjectView/helpers";
import { AgentLaunchButton } from "./AgentLaunchButton";
import { Markdown } from "./Markdown";
import {
  ArchiveIcon,
  BlockedIcon,
  CheckIcon,
  NoteIcon,
  PlayIcon,
  RestartIcon,
  TrashIcon,
} from "./icons";
import type { AgentTarget } from "./TicketsPanel";
import { Button } from "./ui";

interface NoteViewProps {
  projectId: string;
  id: string;
  agentTargets: AgentTarget[];
  installed: Record<string, boolean>;
  /** Start an agent on this note (noteTask). */
  onStartNew: (note: ipc.NoteDetail, agentId: string) => void;
  onSendToAgent: (note: ipc.NoteDetail, target: AgentTarget) => void;
  /** Open a research entry this note produced. */
  onOpenResearch?: (id: string) => void;
  /** Follow a [[wikilink]] in the body. Resolved centrally (wikilinks.ts) so a
   *  link means the same thing here as it does in a research write-up. */
  onWikilink?: (target: string) => void;
  onNotice?: Notify;
  /** The tab should close — the note was deleted. */
  onClosed?: () => void;
}

export function NoteView({
  projectId,
  id,
  agentTargets,
  installed,
  onStartNew,
  onSendToAgent,
  onOpenResearch,
  onWikilink,
  onNotice,
  onClosed,
}: NoteViewProps) {
  const [note, setNote] = useState<ipc.NoteDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Non-null while the title is being edited. */
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  /** Non-null while the body is being edited. */
  const [bodyDraft, setBodyDraft] = useState<string | null>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  /** Delete asks twice. There is no shared confirm dialog to reach from here,
   *  and a second click on the same button is a better guard than a modal
   *  anyway: it costs nothing to arm and nothing to abandon. */
  const [armed, setArmed] = useState(false);

  const load = useCallback(() => {
    void ipc
      .notesGet(projectId, id)
      .then((n) => {
        setNote(n);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [projectId, id]);

  useEffect(() => {
    load();
    window.addEventListener(NOTES_EVENT, load);
    return () => window.removeEventListener(NOTES_EVENT, load);
  }, [load]);

  useEffect(() => {
    if (titleDraft !== null) titleInput.current?.select();
  }, [titleDraft]);

  if (error) {
    return (
      <div className="note-view">
        <p className="note-empty">
          This note could not be read — it may have been deleted.
        </p>
      </div>
    );
  }
  if (!note) return <div className="note-view" />;

  const moves = NEXT_STATUSES[note.status] ?? [];
  const step = STATUS_STEP[note.status] ?? 0;
  const fail = (e: unknown) => onNotice?.(String(e), "error");

  const move = (to: ipc.NoteStatus) => {
    void setStatus(projectId, note.id, to).catch(fail);
  };

  const commitTitle = () => {
    const next = titleDraft;
    setTitleDraft(null);
    if (next == null || next.trim() === note.title) return;
    void rename(projectId, note.id, next).catch(fail);
  };

  const commitBody = () => {
    const next = bodyDraft;
    setBodyDraft(null);
    if (next == null || next === note.body) return;
    void update({ projectId, id: note.id, body: next }).catch(fail);
  };

  // Deleting is the one irreversible move here — archiving is what the
  // reversible one is for — so it takes two clicks and says what goes with it.
  const del = () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    void removeNote(projectId, note.id)
      .then(() => onClosed?.())
      .catch(fail);
  };

  return (
    <div className="note-view">
      <div className="note-head">
        <div className="note-title">
          <NoteIcon size={15} className="note-mark" />
          <span className="note-num">{note.id.split("-")[0]}</span>
          {titleDraft !== null ? (
            <input
              ref={titleInput}
              className="note-title-input"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitTitle();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setTitleDraft(null);
                }
              }}
            />
          ) : (
            <button
              className="note-title-text"
              title="Rename — a note captured in a hurry rarely names itself well"
              onClick={() => setTitleDraft(note.title)}
            >
              {note.title}
            </button>
          )}
        </div>
        <div className="note-meta">
          <span className={`note-status note-status-${note.status}`}>
            {STATUS_LABELS[note.status]}
          </span>
          {/* Where it is between having the thought and being done with it. */}
          <span className="note-steps" title={STATUS_BLURBS[note.status]}>
            {[0, 1, 2, 3].map((i) => (
              <i key={i} className={i <= step ? "on" : ""} />
            ))}
          </span>
          <span
            className="note-chip"
            title={new Date(note.created_at * 1000).toLocaleString()}
          >
            captured {ago(note.created_at)}
          </span>
          {note.tags.map((t) => (
            <span key={t} className="note-tag">
              {t}
            </span>
          ))}
          <span className="status-spacer" />
          {/* The note's CRUD, as marks — the same row and the same shape the
              research tab uses. They are small and frequent, and as six
              equal-weight buttons they drowned the one action that matters,
              which lives in the footer. */}
          <span className="note-crud">
            {moves.includes("ready") && (
              <Button icon title="Ready — you decided this is worth doing"
                onClick={() => move("ready")}>
                <CheckIcon />
              </Button>
            )}
            {moves.includes("doing") && (
              <Button icon title="In progress — you or an agent is on it"
                onClick={() => move("doing")}>
                <PlayIcon />
              </Button>
            )}
            {moves.includes("done") && (
              <Button icon title="Done — it landed"
                onClick={() => move("done")}>
                <CheckIcon />
              </Button>
            )}
            {moves.includes("ideation") && (
              <Button icon title="Back to an idea — untriaged again"
                onClick={() => move("ideation")}>
                <RestartIcon />
              </Button>
            )}
            {moves.includes("parked") && (
              <Button icon title="Park it — not now, but still real"
                onClick={() => move("parked")}>
                <BlockedIcon />
              </Button>
            )}
            {moves.includes("archived") && (
              <Button icon title="Archive — put it down without deleting it"
                onClick={() => move("archived")}>
                <ArchiveIcon />
              </Button>
            )}
            <Button
              icon
              variant="danger"
              onClick={del}
              onBlur={() => setArmed(false)}
              title={
                armed
                  ? "Click again to delete"
                  : note.attachments.length
                    ? `Delete this note and its ${note.attachments.length} attachment${note.attachments.length === 1 ? "" : "s"} — archive instead to keep it`
                    : "Delete this note — archive instead if you might want it back"
              }
            >
              {armed ? <span className="note-del-armed">Really?</span> : <TrashIcon />}
            </Button>
          </span>
        </div>
      </div>

      {/* Body and everything hanging off it scroll as one region. The body
          must not be the flex child that grows: a two-line note would then
          stretch to fill the tab and push its own attachments to the bottom
          edge, far from the text they belong to. */}
      <div className="note-scroll">
      {/* The thought itself. Click to edit — the commonest thing you do with a
          parked note is add the bit you remembered afterwards. */}
      {bodyDraft !== null ? (
        <textarea
          className="note-body-input"
          autoFocus
          value={bodyDraft}
          onChange={(e) => setBodyDraft(e.target.value)}
          onBlur={commitBody}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setBodyDraft(null);
            }
          }}
        />
      ) : (
        <div
          className="note-body"
          role="button"
          tabIndex={0}
          title="Click to edit"
          // A click that lands on something interactive inside the note — a
          // checkbox, a wikilink, an image — is that thing's click, not a
          // request to start editing over the top of it.
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("input, a, img")) return;
            setBodyDraft(note.body);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") setBodyDraft(note.body);
          }}
        >
          {note.body.trim() ? (
            <Markdown
              text={note.body}
              origin="owned"
              onWikilink={onWikilink}
              onToggleTask={(next) =>
                void update({ projectId, id: note.id, body: next }).catch(fail)
              }
            />
          ) : (
            <p className="note-body-empty">Nothing written yet — click to add.</p>
          )}
        </div>
      )}

      {note.attachments.length > 0 && (
        <section className="note-section">
          <h4>Attached</h4>
          <div className="note-attachments">
            {note.attachments.map((a) => (
              <Attachment
                key={a.file}
                projectId={projectId}
                noteId={note.id}
                attachment={a}
              />
            ))}
          </div>
        </section>
      )}

      {note.links.files.length > 0 && (
        <section className="note-section">
          <h4>Points at</h4>
          <ul className="note-files">
            {note.links.files.map((f) => (
              <li key={`${f.path}:${f.start_line ?? ""}`}>
                <code>{f.path}</code>
                {f.start_line != null && (
                  <span className="note-file-lines">
                    :{f.start_line}
                    {f.end_line != null && f.end_line !== f.start_line
                      ? `-${f.end_line}`
                      : ""}
                  </span>
                )}
                {/* The rev is the honest part: it says the lines above are from
                    then, not now, which is the difference between a useful
                    pointer and a confidently wrong one. */}
                {f.rev && (
                  <span
                    className="note-chip"
                    title="The commit this was captured at — the file has probably moved since"
                  >
                    @{f.rev}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(note.links.research.length > 0 || note.links.prs.length > 0) && (
        <section className="note-section">
          <h4>What came of it</h4>
          <ul className="note-links">
            {note.links.research.map((r) => (
              <li key={r}>
                <button
                  className="note-link"
                  onClick={() => onOpenResearch?.(r)}
                  title="Open the research this note started"
                >
                  ◍ {r}
                </button>
              </li>
            ))}
            {note.links.prs.map((pr) => (
              <li key={`${pr.repo}#${pr.number}`}>
                <span className="note-link-static">
                  ⇅ #{pr.number}
                  <span className={`note-pr-state note-pr-${pr.state}`}>
                    {pr.state}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* What was on screen when this was written. Collapsed by default and
          labelled as history: it is often the thing that makes a three-week-old
          note legible, and just as often noise. */}
      {note.context.trim() && (
        <details className="note-section note-context">
          <summary>What was on screen when you wrote this</summary>
          <p>{note.context}</p>
        </details>
      )}

      </div>

      {/* Note left, control hard right — the same footer the research tab
          has, so the primary action is where the eye already looks for it. */}
      <div className="note-actions">
        <span className="note-actions-note">
          Starts in a terminal you can watch. No branch, no commit, no PR — this
          is a starting point, not an approved change.
        </span>
        <span className="status-spacer" />
        <AgentLaunchButton
          label="Work on it"
          agentTargets={agentTargets}
          installed={installed}
          newAgentLabel="New agent on this note"
          primaryTitle={(cli) =>
            `Start ${cli} on this note, with everything attached to it`
          }
          onStart={(agentId) => onStartNew(note, agentId)}
          onSend={(target) => onSendToAgent(note, target)}
        />
      </div>
    </div>
  );
}

/** One attachment. Images decode to a data URL on demand — they live outside
 *  every workspace root, so the editor's reader cannot reach them and this is
 *  the only path; text opens inline. Neither is fetched until the note is
 *  actually open, which is why this is a component rather than part of the
 *  parent's load. */
function Attachment({
  projectId,
  noteId,
  attachment,
}: {
  projectId: string;
  noteId: string;
  attachment: ipc.NoteAttachment;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const isImage = attachment.kind === "image";

  useEffect(() => {
    let live = true;
    if (isImage) {
      void ipc
        .notesReadImage(projectId, noteId, attachment.file)
        .then((b64) => live && setSrc(`data:image/*;base64,${b64}`))
        .catch(() => live && setFailed(true));
    } else {
      void ipc
        .notesReadFile(projectId, noteId, attachment.file)
        .then((t) => live && setText(t))
        .catch(() => live && setFailed(true));
    }
    return () => {
      live = false;
    };
  }, [projectId, noteId, attachment.file, isImage]);

  return (
    <figure className={`note-attachment note-attachment-${attachment.kind}`}>
      {isImage ? (
        src ? (
          <img src={src} alt={attachment.title} />
        ) : (
          <div className="note-attachment-blank">
            {failed ? "could not read" : "…"}
          </div>
        )
      ) : (
        <pre className="note-attachment-text">
          {failed ? "could not read" : (text ?? "…")}
        </pre>
      )}
      <figcaption title={attachment.origin || attachment.file}>
        {attachment.title}
      </figcaption>
    </figure>
  );
}
