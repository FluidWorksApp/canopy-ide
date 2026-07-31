// Scratchpad sidebar section: every thought this project has caught, grouped by
// how far along it is.
//
// The capture box is at the top and always focusable, because the entire value
// of this panel is measured in whether writing something down is faster than
// deciding not to bother. One field, Enter, done — no title/body split, no tag
// picker, no status choice. Everything a note can carry is added *after* it
// exists; nothing is asked for up front.
//
// The grouping is the other half. A flat list answers "what have I thought of",
// which is a list nobody reads twice. Grouped, it answers the question that
// makes a scratchpad worth keeping: of the two hundred things in here, which
// five did I decide were worth doing? That is what `ready` is for, and why it
// renders above the pile rather than under it.
import { useEffect, useState } from "react";
import * as ipc from "../ipc";
import {
  NOTES_EVENT,
  STATUS_BLURBS,
  STATUS_LABELS,
  STATUS_ORDER,
  cached,
  create,
  refresh,
} from "../notes";
import { ago } from "./ProjectView/helpers";
import { NoteIcon } from "./icons";
import { Button, TextInput } from "./ui";

interface NotesPanelProps {
  projectId: string;
  projectName: string;
  roots: string[];
  /** Open a note as a tab — every row leads somewhere native. */
  onOpen: (note: ipc.NoteSummary) => void;
}

export function NotesPanel({
  projectId,
  projectName,
  roots,
  onOpen,
}: NotesPanelProps) {
  const [rows, setRows] = useState<ipc.NoteSummary[]>(() => cached(projectId));
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    const sync = () => setRows(cached(projectId));
    window.addEventListener(NOTES_EVENT, sync);
    void refresh(projectId);
    return () => window.removeEventListener(NOTES_EVENT, sync);
  }, [projectId]);

  // The archive is fetched only when asked for: the panel is a worklist, and
  // things were archived precisely to get them off it.
  const [archived, setArchived] = useState<ipc.NoteSummary[]>([]);
  useEffect(() => {
    if (!showArchived) return;
    let live = true;
    void ipc
      .notesList(projectId, ["archived"])
      .then((r) => live && setArchived(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [showArchived, projectId, rows]);

  const all = showArchived ? [...rows, ...archived] : rows;
  const groups = STATUS_ORDER.map((status) => ({
    status,
    notes: all.filter((r) => r.status === status),
  })).filter((g) => g.notes.length > 0);

  const submit = () => {
    const body = text.trim();
    if (!body || saving) return;
    setSaving(true);
    setError(null);
    // Optimistically clear the field. If the write fails the text comes back
    // with the error — but the common case is that it works, and a field that
    // waits for a round trip before clearing is a field you type over.
    setText("");
    void create({
      projectId,
      projectName,
      roots,
      title: body,
      origin: "panel",
      cwd: roots[0],
    })
      .catch((e) => {
        setError(String(e));
        setText(body);
      })
      .finally(() => setSaving(false));
  };

  return (
    <div className="side-panel notes-panel">
      <div className="notes-new">
        <TextInput
          className="notes-input"
          size="sm"
          width="full"
          placeholder="Write it down…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <Button
          disabled={!text.trim() || saving}
          onClick={submit}
          title="Save this thought. Nothing runs — pick it up whenever you want."
          size="sm">
          Save
        </Button>
      </div>
      {error && <p className="tree-empty notes-error">{error}</p>}

      {all.length === 0 && (
        <p className="tree-empty">
          Nothing here yet. Write a thought above, or type one into ⌘K and pick
          “Save for later”. Paste a screenshot into ⌘K and it comes along with
          it.
        </p>
      )}

      {groups.map((g) => (
        <section key={g.status} className="notes-group">
          <h4 className="notes-state-head" title={STATUS_BLURBS[g.status]}>
            {STATUS_LABELS[g.status]}
            <span className="badge">{g.notes.length}</span>
          </h4>
          <ul className="notes-rows">
            {g.notes.map((n) => (
              <li key={n.id}>
                <button
                  className="notes-row"
                  onClick={() => onOpen(n)}
                  title={n.preview || n.title}
                >
                  <NoteIcon size={13} className="notes-row-mark" />
                  <span className="notes-row-num">{n.id.split("-")[0]}</span>
                  <span className="notes-row-title">{n.title}</span>
                  <span className="notes-row-age">{ago(n.updated_at)}</span>
                  {n.preview && (
                    <span className="notes-row-preview">{n.preview}</span>
                  )}
                  <span className="notes-row-facts">
                    {/* What is worth knowing before opening: whether the note
                        carries anything, and whether anything came of it. */}
                    {n.image_count > 0 && (
                      <span title={`${n.image_count} image(s) attached`}>
                        ▤ {n.image_count}
                      </span>
                    )}
                    {n.file_count > 0 && (
                      <span title={`${n.file_count} file(s) referenced`}>
                        ⌘ {n.file_count}
                      </span>
                    )}
                    {n.research_count > 0 && (
                      <span title={`${n.research_count} research entry(ies)`}>
                        ◍ {n.research_count}
                      </span>
                    )}
                    {n.pr_count > 0 && (
                      <span title={`${n.pr_count} linked pull request(s)`}>
                        ⇅ {n.pr_count}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {(all.length > 0 || showArchived) && (
        <button className="notes-more" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? "Hide archived" : "Show archived"}
        </button>
      )}
    </div>
  );
}
