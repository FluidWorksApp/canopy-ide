// A commit opened as a tab: message, metadata, and the patch it introduced.
// Same renderer as the PR view — a commit's patch is the same shape as a
// PR's, so it gets the same treatment rather than a second diff widget.
import { useEffect, useState } from "react";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import * as ipc from "../ipc";
import { splitPatch } from "./PrView";

interface CommitViewProps {
  repo: string;
  /** Full hash — the panel row carries it; short hashes are display only. */
  hash: string;
  onNotice: (msg: string) => void;
}

export function CommitView({ repo, hash, onNotice }: CommitViewProps) {
  const [detail, setDetail] = useState<ipc.CommitDetail | null>(null);
  const [patch, setPatch] = useState<ipc.CommitPatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [split, setSplit] = useState(true);

  // Two phases on purpose: metadata is a `git show -s` (milliseconds) so the
  // header paints at once, while the patch — the part that actually costs
  // something on a large commit — fills in behind it.
  useEffect(() => {
    let live = true;
    setDetail(null);
    setPatch(null);
    setError(null);
    void ipc
      .gitCommitDetail(repo, hash)
      .then((d) => live && setDetail(d))
      .catch((e) => live && setError(String(e)));
    void ipc
      .gitCommitPatch(repo, hash)
      .then((p) => live && setPatch(p))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [repo, hash]);

  if (error) return <div className="tree-empty">{error}</div>;
  if (!detail) return <div className="tree-empty">Loading commit…</div>;

  const files = patch?.patch ? splitPatch(patch.patch) : [];
  const isMerge = detail.parents.length > 1;

  return (
    <div className="commit-view">
      <div className="commit-head">
        <div className="commit-subject">{detail.subject}</div>
        <div className="commit-meta">
          <code className="commit-hash" title={detail.hash}>
            {detail.short}
          </code>
          <span>{detail.author}</span>
          <span className="commit-date">{detail.date}</span>
          {isMerge && <span className="commit-chip">merge</span>}
          {detail.refs && <span className="commit-chip">{detail.refs}</span>}
          {patch && (
            <>
              <span className="commit-stat commit-add">+{patch.insertions}</span>
              <span className="commit-stat commit-del">−{patch.deletions}</span>
            </>
          )}
          <span className="git-spacer" />
          <button
            className="btn-mini"
            title="Copy the full hash"
            onClick={() => {
              void navigator.clipboard
                .writeText(detail.hash)
                .then(() => onNotice(`Copied ${detail.short}`))
                .catch(() => {});
            }}
          >
            Copy hash
          </button>
          {files.length > 0 && (
            <button className="btn-mini" onClick={() => setSplit((v) => !v)}>
              {split ? "Unified" : "Split"}
            </button>
          )}
        </div>
        {detail.body && <pre className="commit-body">{detail.body}</pre>}
      </div>

      <div className="commit-files">
        {!patch ? (
          <div className="tree-empty">Loading diff…</div>
        ) : files.length === 0 ? (
          <div className="tree-empty">
            {isMerge
              ? "Merge commit — no patch of its own. Open its parents to see the changes."
              : "No file changes in this commit."}
          </div>
        ) : (
          files.map((f) => (
            <div key={f.path} className="pr-file">
              <div className="pr-file-name">{f.path}</div>
              <DiffView
                data={{
                  hunks: [f.patch],
                  oldFile: { fileName: f.path },
                  newFile: { fileName: f.path },
                }}
                diffViewMode={split ? DiffModeEnum.Split : DiffModeEnum.Unified}
                diffViewHighlight
                diffViewTheme="dark"
                diffViewWrap
                diffViewAddWidget={false}
                diffViewFontSize={12}
              />
            </div>
          ))
        )}
        {patch?.truncated && (
          <div className="tree-empty">
            Patch truncated — this commit is larger than 2 MB. Use{" "}
            <code>git show {detail.short}</code> for the whole thing.
          </div>
        )}
      </div>
    </div>
  );
}
