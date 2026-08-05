// "Cleanup resources": the built-in task that gives back the disk twenty
// worktrees are holding.
//
// It scans on open — read-only, so there is nothing to confirm before looking —
// and then the whole screen is one question: here is what a build can make
// again, here is what it costs, untick anything you want to keep. What Canopy
// thinks is idle comes ticked; everything else is listed anyway with the reason
// it isn't, because "why is my workspace not in the list" is the question a
// cleanup tool that hides rows can never answer.
//
// Two things are deliberate. Nothing is ever cleaned automatically — not on
// hibernation, not on a schedule; a hibernating project is held *out* of the
// default selection wherever it does reach the scan, since waking it expects
// its installs back. (Usually it does not reach the scan at all: sleeping is
// what releasing the folders means, so Rust lists it among the places it did
// not look rather than failing the whole scan over it.) And the default is the
// Trash, not `rm`: reversible, at the cost of the space only coming back when
// the Trash is emptied, which the footer says out loud.
import { useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "../ipc";
import { basename } from "../paths";
import {
  bytesOf,
  countOf,
  fmtBytes,
  groupState,
  groupTargets,
  defaultSelection,
  outcomeSummary,
  rememberScan,
  scanSummary,
  stateChips,
  toggleGroup,
  toggleTarget,
  reclaimLabel,
  workspaceLabel,
} from "../cleanup";
import { Dialog } from "./Dialog";
import { BroomIcon } from "./icons";

interface CleanupDialogProps {
  open: boolean;
  /** Project roots to scan — every open project's folders. */
  roots: string[];
  /** cwds with something live in them (terminals, agents, server runs). */
  busy: string[];
  /** Roots of hibernating projects. */
  asleep: string[];
  onClose: () => void;
}

const CATEGORY_LABEL: Record<ipc.CleanupTarget["category"], string> = {
  deps: "install",
  build: "build output",
  cache: "cache",
};

export function CleanupDialog({
  open,
  roots,
  busy,
  asleep,
  onClose,
}: CleanupDialogProps) {
  const [scan, setScan] = useState<ipc.CleanupScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ipc.CleanupProgress | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [trash, setTrash] = useState(true);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<ipc.CleanupOutcome | null>(null);
  // Guards the async scan against a dialog that closed while it ran.
  const liveRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    liveRef.current = true;
    setScan(null);
    setOutcome(null);
    setError(null);
    setProgress(null);
    const un = ipc.onCleanupProgress((p) => {
      if (liveRef.current) setProgress(p);
    });
    void ipc
      .cleanupScan(roots, busy, asleep)
      .then((s) => {
        if (!liveRef.current) return;
        setScan(s);
        setSelected(defaultSelection(s));
        rememberScan(s);
      })
      .catch((e: unknown) => {
        if (liveRef.current) setError(String(e));
      });
    return () => {
      liveRef.current = false;
      void un.then((f) => f());
    };
    // Re-scanning on every roots/busy change would restart the walk under the
    // user; the scan belongs to the moment the dialog opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const groups = useMemo(() => (scan ? groupTargets(scan) : []), [scan]);
  const chosen = scan ? bytesOf(scan.targets, selected) : 0;
  const chosenCount = scan ? countOf(scan.targets, selected) : 0;

  async function run() {
    if (!scan || chosenCount === 0) return;
    setRunning(true);
    try {
      const paths = scan.targets
        .filter((t) => selected.has(t.path))
        .map((t) => t.path);
      const result = await ipc.cleanupRun(paths, trash);
      setOutcome(result);
      // The rows that went are gone; what is left is still true, so the list
      // stays put rather than sending the user back to a fresh scan.
      const removed = new Set(result.removed);
      const kept = scan.targets.filter((t) => !removed.has(t.path));
      const next: ipc.CleanupScan = {
        ...scan,
        targets: kept,
        bytes: kept.reduce((n, t) => n + t.bytes, 0),
        recommended_bytes: kept.reduce(
          (n, t) => (t.recommended ? n + t.bytes : n),
          0,
        ),
      };
      setScan(next);
      setSelected(new Set());
      rememberScan(next);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  const body = error ? (
    <span className="cln-error">{error}</span>
  ) : outcome ? (
    outcomeSummary(outcome)
  ) : scan ? (
    scanSummary(scan)
  ) : (
    "Looking for build output, installs and caches…"
  );

  return (
    <Dialog
      open={open}
      title="Cleanup resources"
      size="lg"
      icon={<BroomIcon size={14} />}
      variant={trash ? "accent" : "danger"}
      body={body}
      meta={
        scan && scan.targets.length > 0 ? (
          <>
            {chosenCount === 0
              ? "Nothing selected."
              : `${chosenCount} director${chosenCount === 1 ? "y" : "ies"} · ${fmtBytes(chosen)}`}
            {trash
              ? " · to the Trash, so the space comes back when you empty it"
              : " · deleted outright, no Trash"}
          </>
        ) : undefined
      }
      dismissLabel={outcome ? "Done" : "Cancel"}
      onDismiss={onClose}
      actions={
        scan && scan.targets.length > 0
          ? [
              {
                label: running ? "Working…" : reclaimLabel(chosen, trash),
                primary: true,
                disabled: running || chosenCount === 0,
                onClick: () => void run(),
              },
            ]
          : []
      }
    >
      <div className="cln-body">
        {!scan && !error && (
          <div
            className="cln-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress?.total ?? 0}
            aria-valuenow={progress?.done ?? 0}
          >
            <div className="cln-progress-track">
              <div
                className="cln-progress-fill"
                style={{
                  width: progress
                    ? `${(progress.done / Math.max(progress.total, 1)) * 100}%`
                    : "0%",
                }}
              />
            </div>
            <div className="cln-progress-where">
              {progress
                ? `${progress.done} of ${progress.total} · ${basename(progress.workspace)}`
                : "finding workspaces…"}
            </div>
          </div>
        )}

        {scan && scan.targets.length > 0 && (
          <label className="cln-mode" title="Trash keeps a way back; deleting frees the space now.">
            <input
              type="checkbox"
              checked={trash}
              onChange={(e) => setTrash(e.target.checked)}
            />
            <span>Move to Trash instead of deleting</span>
          </label>
        )}

        {groups.map((g) => {
          const state = groupState(g, selected);
          const chips = stateChips(g.workspace);
          return (
            <div className="cln-group" key={g.workspace.path}>
              <div className="cln-group-head">
                <label className="cln-check">
                  <input
                    type="checkbox"
                    checked={state === "all"}
                    ref={(el) => {
                      if (el) el.indeterminate = state === "some";
                    }}
                    onChange={() => setSelected(toggleGroup(g, selected))}
                  />
                  <span className="cln-ws" title={g.workspace.path}>
                    {workspaceLabel(g.workspace)}
                  </span>
                </label>
                {chips.map((c) => (
                  <span
                    key={c.label}
                    className={`cln-chip cln-chip-${c.tone}`}
                    title={c.title}
                  >
                    {c.label}
                  </span>
                ))}
                <span className="cln-spacer" />
                <span className="cln-nums">{fmtBytes(g.workspace.bytes)}</span>
              </div>
              {g.targets.map((t) => (
                <label className="cln-row" key={t.path} title={t.path}>
                  <input
                    type="checkbox"
                    checked={selected.has(t.path)}
                    onChange={() => setSelected(toggleTarget(t.path, selected))}
                  />
                  <span className="cln-rel">{t.rel}</span>
                  <span className="cln-cat">{CATEGORY_LABEL[t.category]}</span>
                  {/* The reason it is not ticked, and what it costs to get back
                      — the two things that decide the answer, on the row. */}
                  <span className="cln-why">
                    {t.hold ?? `back with: ${t.regenerate}`}
                  </span>
                  <span className="cln-spacer" />
                  <span className="cln-nums">
                    {t.partial ? "≥ " : ""}
                    {fmtBytes(t.bytes)}
                  </span>
                </label>
              ))}
            </div>
          );
        })}

        {scan && scan.targets.length === 0 && !outcome && (
          <div className="cln-empty">
            Nothing to reclaim. No installs, build output or caches were found in
            your open projects.
          </div>
        )}

        {outcome && outcome.failed.length > 0 && (
          <div className="cln-notes">
            {outcome.failed.map(([path, why]) => (
              <div key={path} className="cln-note">
                {path} — {why}
              </div>
            ))}
          </div>
        )}
        {outcome && outcome.refused.length > 0 && (
          <div className="cln-notes">
            {outcome.refused.map((r) => (
              <div key={r} className="cln-note">
                refused: {r}
              </div>
            ))}
          </div>
        )}

        {scan && scan.skipped.length > 0 && (
          <div className="cln-notes">
            {scan.skipped.map((s) => (
              <div key={s} className="cln-note">
                skipped: {s}
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
