// The "this is research, put it somewhere findable" affordance, floating over
// an open markdown file.
//
// Research existed long before the store did, and it is sitting in the repo as
// loose markdown: a NOTES.md, a docs/spike.md, the file an agent wrote before
// the harness started refusing them. Those are findings — they are simply not
// findable, which is the whole complaint the store answers. This is how one
// gets adopted without anybody retyping it.
//
// Deliberately small and quiet. It sits over a document the user opened to
// read, so it must be reachable and ignorable at the same time: no dialog, no
// banner pushing the text down, and it takes itself away once the file has an
// entry — at which point it becomes the way back to it.
import { useEffect, useState } from "react";
import * as ipc from "../ipc";
import { RESEARCH_EVENT, refresh } from "../research";
import { ResearchIcon } from "./icons";

interface Props {
  projectId: string;
  projectName: string;
  roots: string[];
  /** The open file. Only markdown is offered — see the caller. */
  path: string;
  /** Open the entry this file became, or already was. */
  onOpen: (id: string) => void;
  onNotice?: (text: string, level?: "info" | "error") => void;
}

export function ResearchImportCta({
  projectId,
  projectName,
  roots,
  path,
  onOpen,
  onNotice,
}: Props) {
  /** The entry this file already is, `null` for none, `undefined` while we do
   *  not yet know — which is the state that must render nothing at all, or the
   *  button flickers "Import" onto a file that is already imported. */
  const [entryId, setEntryId] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setEntryId(undefined);
    const look = () =>
      void ipc
        .researchForFile(projectId, path)
        .then((id) => alive && setEntryId(id))
        .catch(() => alive && setEntryId(null));
    look();
    // An entry can appear from elsewhere — an agent linking this file, another
    // tab importing it — and this button would otherwise keep offering to.
    window.addEventListener(RESEARCH_EVENT, look);
    return () => {
      alive = false;
      window.removeEventListener(RESEARCH_EVENT, look);
    };
  }, [projectId, path]);

  if (entryId === undefined) return null;

  if (entryId) {
    return (
      <button
        className="research-import is-open"
        title={`This file is research entry ${entryId}`}
        onClick={() => onOpen(entryId)}
      >
        <ResearchIcon size={13} />
        In research
      </button>
    );
  }

  const go = () => {
    setBusy(true);
    void ipc
      .researchImport({ projectId, projectName, roots, path })
      .then((entry) => {
        void refresh(projectId);
        setEntryId(entry.id);
        onOpen(entry.id);
      })
      .catch((e) => onNotice?.(String(e), "error"))
      .finally(() => setBusy(false));
  };

  return (
    <button
      className="research-import"
      disabled={busy}
      title={
        "Adopt this file as a research entry — it keeps its text, gains a " +
        "status and a digest, and points back here. Nothing is moved or deleted."
      }
      onClick={go}
    >
      <ResearchIcon size={13} />
      {busy ? "Importing…" : "Import into research"}
    </button>
  );
}
