// Side-by-side diff, used for git diffs (HEAD vs working tree) and for
// external-change review (an agent edited a file under you).
//
// This deliberately does NOT use Monaco's DiffEditor. Under monaco-vscode-api
// the diff never computes — `onDidUpdateDiff` never fires and `getLineChanges()`
// stays null, so it silently renders two plain editors side by side with no
// highlighting and no aligned filler. Rather than debug that worker, we diff
// the two contents into a unified patch (jsdiff) and render it with the same
// component the PR view uses, so every diff in the app looks and behaves alike.
import { useMemo, useState } from "react";
import { DiffView as GitDiffView, DiffModeEnum } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import { createPatch } from "diff";

export interface DiffAction {
  label: string;
  accent?: boolean;
  onClick: () => void;
}

interface DiffViewProps {
  path: string;
  title: string;
  original: string;
  modified: string;
  actions: DiffAction[];
}

export function DiffView({ path, title, original, modified, actions }: DiffViewProps) {
  const [split, setSplit] = useState(true);
  const name = path.split("/").pop() ?? path;

  // Patch generation is the expensive part; only redo it when content changes.
  const patch = useMemo(
    () => createPatch(name, original, modified, "", ""),
    [name, original, modified],
  );
  const unchanged = original === modified;

  return (
    <div className="diff-view">
      <div className="diff-bar">
        <span className="diff-label">{title}</span>
        <button className="btn-mini" onClick={() => setSplit((v) => !v)}>
          {split ? "Unified" : "Split"}
        </button>
        {actions.map((a) => (
          <button
            key={a.label}
            className={`btn ${a.accent ? "btn-accent" : ""}`}
            onClick={a.onClick}
          >
            {a.label}
          </button>
        ))}
      </div>
      <div className="diff-body">
        {unchanged ? (
          <div className="diff-empty">No changes against HEAD.</div>
        ) : (
          <GitDiffView
            data={{
              hunks: [patch],
              oldFile: { fileName: name, content: original },
              newFile: { fileName: name, content: modified },
            }}
            diffViewMode={split ? DiffModeEnum.Split : DiffModeEnum.Unified}
            diffViewHighlight
            diffViewTheme="dark"
            diffViewWrap
            diffViewAddWidget={false}
            diffViewFontSize={12}
          />
        )}
      </div>
    </div>
  );
}
