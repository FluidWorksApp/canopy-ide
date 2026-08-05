// One unified patch, rendered file by file — the list CommitView, BranchView
// and ReviewView all show.
//
// It exists because those three had a copy each of "map the files, mount a
// DiffView per file", every one of them expanded and syntax-highlighted with
// no budget at all. A PR of the same size paints instantly, because PrView has
// always opened only what is worth opening and left the rest collapsed; a
// commit touching a lockfile froze the window for seconds. The difference was
// never the diff, it was who had the budget — so they share one now
// (src/patchBudget.ts), PrView included.
//
// PrFileCard itself is deliberately not what got lifted: it carries review
// threads, draft comments, viewed checkboxes and a comment composer, none of
// which a commit has. What these three share is the smaller thing underneath.
import { memo, useCallback, useMemo, useState } from "react";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import { useDiffData, type DiffData } from "../diffData";
import {
  autoExpanded,
  patchStats,
  HIGHLIGHT_MAX,
  type PatchFileStats,
} from "../patchBudget";

export interface PatchFile {
  path: string;
  patch: string;
}

const PatchFileCard = memo(function PatchFileCard({
  file,
  stats,
  open,
  split,
  data,
  onToggle,
}: {
  file: PatchFile;
  stats: PatchFileStats;
  open: boolean;
  split: boolean;
  data: DiffData;
  onToggle: (path: string) => void;
}) {
  return (
    <div className="pr-file">
      <div className="pr-file-head" onClick={() => onToggle(file.path)}>
        <span className="pr-file-chevron">{open ? "▾" : "▸"}</span>
        <span className="pr-file-path" title={file.path}>
          {file.path}
        </span>
        {stats.binary ? (
          <span className="pr-file-stat">binary</span>
        ) : (
          <>
            <span className="pr-file-stat pr-add">+{stats.additions}</span>
            <span className="pr-file-stat pr-del">−{stats.deletions}</span>
          </>
        )}
      </div>
      {open &&
        (stats.binary ? (
          <div className="pr-file-note">Binary file — not shown.</div>
        ) : (
          <DiffView
            data={data}
            diffViewMode={split ? DiffModeEnum.Split : DiffModeEnum.Unified}
            diffViewHighlight={stats.changed <= HIGHLIGHT_MAX}
            diffViewTheme="dark"
            diffViewWrap
            diffViewAddWidget={false}
            diffViewFontSize={12}
          />
        ))}
    </div>
  );
});

export function PatchFileList({
  files,
  split,
}: {
  files: PatchFile[];
  split: boolean;
}) {
  // Stable diff `data` identities; see diffData.ts.
  const dataFor = useDiffData();
  const withStats = useMemo(
    () => files.map((f) => ({ file: f, stats: patchStats(f.patch) })),
    [files],
  );
  // Seeded per patch, and identified by what is in it rather than by the array's
  // identity: a caller that rebuilds that array every render would otherwise
  // slam a file shut the moment anything else on the tab re-rendered. A
  // different commit is a different signature; a file the user opened by hand
  // stays open until then.
  const signature = useMemo(
    () => files.map((f) => `${f.path}:${f.patch.length}`).join(" "),
    [files],
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seededFor !== signature) {
    setSeededFor(signature);
    setExpanded(
      autoExpanded(
        withStats.map((f) => ({
          path: f.file.path,
          changed: f.stats.changed,
          binary: f.stats.binary,
        })),
      ),
    );
  }

  const toggle = useCallback(
    (path: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (!next.delete(path)) next.add(path);
        return next;
      }),
    [],
  );

  return (
    <>
      {withStats.map(({ file, stats }) => (
        <PatchFileCard
          key={file.path}
          file={file}
          stats={stats}
          open={expanded.has(file.path)}
          split={split}
          data={dataFor(file)}
          onToggle={toggle}
        />
      ))}
    </>
  );
}
