// Claude Code's proposed edits, answered in Canopy.
//
// When `claude` in one of this project's terminals wants to edit a file, its
// IDE link (claude_ide.rs) sends the whole proposed file here and holds the
// edit open until someone answers. The terminal asks the same question at the
// same time, and whichever is answered first wins: answer here and the CLI
// writes what you accepted (including your edits to the right-hand side);
// answer in the terminal and this card closes on its own.
//
// A floating card rather than an editor tab on purpose. It is a permission
// prompt, not a document: it must not be restored with the session, saved,
// or left behind as a tab once the CLI has moved on — and the CLI closes it
// itself, which a tab the user owns should never have done to it.
//
// Closing the card is not an answer. The CLI reads anything but an explicit
// accept or reject as "accept as proposed", so dismissing it only hides it;
// the terminal prompt stays authoritative.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Notify } from "../types";
import * as ipc from "../ipc";
import { languageForPath, monaco } from "../monaco-setup";
import { readBoundedFile } from "../boundedFileRead";
import { sizeLimitFor } from "../fileOpen";
import { basename } from "../paths";
import {
  claudeIdeState,
  diffsForPtys,
  dismissClaudeDiff,
  subscribeClaudeIde,
  type PendingClaudeDiff,
} from "../claudeIde";
import { DiffView } from "./DiffView";
import { MonacoEditor } from "./MonacoEditor";

interface ClaudeDiffDockProps {
  /** The project's own terminals: only their diffs show here. */
  ptyIds: readonly number[];
  onNotice: Notify;
}

export function ClaudeDiffDock({ ptyIds, onNotice }: ClaudeDiffDockProps) {
  const state = useSyncExternalStore(subscribeClaudeIde, claudeIdeState);
  const key = ptyIds.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const owned = useMemo(() => new Set(ptyIds), [key]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const diffs = diffsForPtys(state, owned).filter((d) => !hidden.has(diffKey(d)));
  // The newest first: the CLI is blocked on the one it just asked about.
  const diff = diffs[diffs.length - 1];
  if (!diff) return null;
  return (
    <div className="claude-diff-dock" role="dialog" aria-label={diff.tabName}>
      <ClaudeDiffCard
        key={diffKey(diff)}
        diff={diff}
        queued={diffs.length - 1}
        onNotice={onNotice}
        onHide={() => setHidden((h) => new Set(h).add(diffKey(diff)))}
      />
    </div>
  );
}

const diffKey = (d: PendingClaudeDiff) => `${d.ptyId}\u0000${d.tabName}`;

/** The file as it is now: the open model if Canopy has one (unsaved edits
 *  included — that is what the user is comparing against), disk otherwise,
 *  and empty for a file Claude is creating. */
async function currentText(path: string): Promise<string> {
  const open = monaco.editor.getModel(monaco.Uri.file(path));
  if (open) return open.getValue();
  try {
    const bytes = await readBoundedFile(path, { scope: "claude-diff", maxBytes: sizeLimitFor("code") });
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function ClaudeDiffCard({
  diff,
  queued,
  onNotice,
  onHide,
}: {
  diff: PendingClaudeDiff;
  queued: number;
  onNotice: Notify;
  onHide: () => void;
}) {
  const [original, setOriginal] = useState<string | null>(null);
  const [modified, setModified] = useState(diff.proposed);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scratch, setScratch] = useState<monaco.editor.ITextModel | null>(null);

  useEffect(() => {
    let live = true;
    void currentText(diff.path).then((text) => live && setOriginal(text));
    return () => {
      live = false;
    };
  }, [diff.path]);

  // The editable right-hand side: a scratch model holding the proposal, never
  // the file's own model, so tweaking a proposal cannot dirty the open tab.
  // Its own scheme keeps it out of the language server and away from the
  // selection Claude is sent; the query keeps two diffs of one file apart.
  useEffect(() => {
    const uri = monaco.Uri.from({
      scheme: "claude-diff",
      path: diff.path,
      query: `${diff.ptyId}:${diff.tabName}`,
    });
    const model =
      monaco.editor.getModel(uri) ??
      monaco.editor.createModel(diff.proposed, languageForPath(diff.path), uri);
    setScratch(model);
    const sub = model.onDidChangeContent(() => setModified(model.getValue()));
    return () => {
      sub.dispose();
      model.dispose();
    };
  }, [diff.path, diff.ptyId, diff.tabName, diff.proposed]);

  const answer = async (accept: boolean) => {
    setBusy(true);
    try {
      await ipc.claudeIdeResolveDiff(
        diff.ptyId,
        diff.tabName,
        accept,
        accept ? (scratch?.getValue() ?? diff.proposed) : undefined,
      );
    } catch {
      onNotice("Claude Code had already moved on — this change was answered in the terminal.", "info");
    }
    dismissClaudeDiff(diff.ptyId, diff.tabName);
  };

  const name = basename(diff.path) || diff.path;
  const edited = modified !== diff.proposed;
  const actions = [
    { label: edited ? "Accept edited" : "Accept", accent: true, onClick: () => void answer(true) },
    { label: "Reject", onClick: () => void answer(false) },
    { label: editing ? "Show diff" : "Edit proposal", onClick: () => setEditing((v) => !v) },
    { label: "Hide", onClick: onHide },
  ];
  const title = `${diff.tabName}${queued ? ` · ${queued} more waiting` : ""}`;

  return (
    <div className={`claude-diff-card ${busy ? "is-busy" : ""}`}>
      <div className="claude-diff-note">
        Claude Code wants to change <strong>{name}</strong>. Answer here or in its terminal.
      </div>
      {editing && scratch ? (
        <div className="diff-view">
          <div className="diff-bar">
            <span className="diff-label">{title} — editing the proposal</span>
            {actions.map((a) => (
              <button
                key={a.label}
                className={`btn ${a.accent ? "btn-accent" : ""}`}
                onClick={a.onClick}
                disabled={busy}
              >
                {a.label}
              </button>
            ))}
          </div>
          <div className="diff-body">
            <MonacoEditor model={scratch} onSave={() => void answer(true)} onDirty={() => {}} />
          </div>
        </div>
      ) : original == null ? (
        <div className="viewer-loading">Loading…</div>
      ) : (
        <DiffView
          path={diff.path}
          title={title}
          original={original}
          modified={modified}
          actions={busy ? [] : actions}
        />
      )}
    </div>
  );
}
