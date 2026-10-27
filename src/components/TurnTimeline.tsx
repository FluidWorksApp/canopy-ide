// The agent tab's turn timeline: one point per turn, each offering "Undo this
// turn" (back to how the tree was before it) and "Back to here" (how it left
// the tree), always through a diff preview first. Snapshots and restores are
// src-tauri/src/turn_rollback.rs; which snapshot each button means is
// turnRollback.ts buildTimeline, tested there.
import { useCallback, useEffect, useMemo, useState } from "react";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import * as ipc from "../ipc";
import type { Notify } from "../types";
import { agentCliFor } from "../projects";
import { supportsTurnRollback } from "../harness";
import { getSettings } from "../settings";
import { useEscape } from "../useEscape";
import { patchStats, HIGHLIGHT_MAX } from "../patchBudget";
import { splitPatch } from "./PrView";
import { Button } from "./ui";
import {
  IRREVERSIBLE_NOTE,
  TURNS_CHANGED_EVENT,
  buildTimeline,
  timelineWords,
  type TimelineAction,
} from "../turnRollback";
import { irreversibleByTurn } from "../gates/timeline";
import "./gates.css";

interface Props {
  cwd: string;
  sessionId: string;
  agent: string;
  /** Build lens: plain words, no git vocabulary. */
  builder?: boolean;
  /** Changes whenever the session's digest moves, so the list refreshes even
   *  if a snapshot event was missed. */
  refreshKey?: number;
  onNotice: Notify;
}

interface Pending {
  label: string;
  action: TimelineAction;
}

const clock = (ms: number | null) =>
  ms ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

export function TurnTimeline({ cwd, sessionId, agent, builder, refreshKey, onNotice }: Props) {
  const [list, setList] = useState<ipc.TurnList | null>(null);
  const [tick, setTick] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [onlyMine, setOnlyMine] = useState(true);
  const words = timelineWords(!!builder);

  useEffect(() => {
    let live = true;
    void ipc
      .turnList(cwd, sessionId)
      .then((l) => live && setList(l))
      .catch(() => live && setList(null));
    return () => {
      live = false;
    };
  }, [cwd, sessionId, refreshKey, tick]);

  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail === sessionId) setTick((t) => t + 1);
    };
    window.addEventListener(TURNS_CHANGED_EVENT, on);
    return () => window.removeEventListener(TURNS_CHANGED_EVENT, on);
  }, [sessionId]);

  const entries = useMemo(() => (list ? buildTimeline(list).reverse() : []), [list]);
  // Turns that ran something a person approved as irreversible. Best effort:
  // a ledger that can't be read just leaves the marks off.
  const [irreversible, setIrreversible] = useState<Map<number, string[]>>(new Map());
  useEffect(() => {
    let live = true;
    void irreversibleByTurn(cwd, sessionId, entries)
      .then((m) => live && setIrreversible(m))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [cwd, sessionId, entries]);
  const lastRestore = list?.restores[list.restores.length - 1];
  const scope: ipc.TurnScope = list?.shared && onlyMine ? "session" : list?.shared ? "all" : "auto";

  // Nothing to say: a CLI this isn't wired for, with no history either.
  if (!list) return null;
  if (!list.git) {
    return supportsTurnRollback(agent) ? (
      <div className="aw-turns">
        <div className="ticket-state-head">{words.title}</div>
        <div className="aw-turns-note">
          Rollback needs git — this folder isn't a git repository, so turns aren't saved.
        </div>
      </div>
    ) : null;
  }
  if (entries.length === 0 && !lastRestore) {
    if (!supportsTurnRollback(agent) || !getSettings().turnRollback) return null;
    return (
      <div className="aw-turns">
        <div className="ticket-state-head">{words.title}</div>
        <div className="aw-turns-note">
          Each turn is saved as it starts and ends. Points appear here after the next prompt.
        </div>
      </div>
    );
  }

  return (
    <div className="aw-turns">
      <div className="ticket-state-head">
        {words.title}
        {lastRestore && (
          <Button
            size="sm"
            variant="ghost"
            className="aw-turns-redo"
            title="Put the files back the way they were before the last restore"
            onClick={() =>
              setPending({
                label: words.redo,
                action: { target: lastRestore.ref, nativeUuid: null, caveat: null },
              })
            }
          >
            {words.redo}
          </Button>
        )}
      </div>
      {list.shared && (
        <label className="aw-turns-scope" title={`Other agents in this checkout: ${list.peers.join(", ")}`}>
          <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
          Only files this agent changed (another agent is working in this checkout)
        </label>
      )}
      <ol className="aw-turns-list">
        {entries.map((t) => (
          <li key={t.n} className={`aw-turn ${t.running ? "aw-turn-running" : ""}`}>
            <span className="aw-turn-dot" aria-hidden />
            <div className="aw-turn-body">
              <div className="aw-turn-head">
                <span className="aw-turn-n">{builder ? `Step ${t.n}` : `Turn ${t.n}`}</span>
                <span className="aw-turn-time">{clock(t.startedMs ?? t.endedMs)}</span>
                {t.running && <span className="loose-chip">working</span>}
                {irreversible.has(t.n) && (
                  <span
                    className="loose-chip aw-turn-irreversible"
                    title={`Approved and run during this turn — restoring files won't reverse it:\n${irreversible.get(t.n)!.join("\n")}`}
                  >
                    can't be undone
                  </span>
                )}
              </div>
              {t.prompt && (
                <div className="aw-turn-prompt" title={t.prompt}>
                  {t.prompt}
                </div>
              )}
              <div className="aw-turn-actions">
                {t.undo && (
                  <Button
                    size="sm"
                    title={t.undo.caveat ?? "Preview, then restore the files to how they were before this turn"}
                    onClick={() => setPending({ label: words.undo, action: t.undo! })}
                  >
                    {words.undo}
                  </Button>
                )}
                {t.backToHere && !t.running && (
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Preview, then restore the files to how this turn left them"
                    onClick={() => setPending({ label: words.back, action: t.backToHere! })}
                  >
                    {words.back}
                  </Button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
      <div className="aw-turns-note">{IRREVERSIBLE_NOTE}</div>
      {pending && (
        <RestorePreview
          cwd={cwd}
          sessionId={sessionId}
          agent={agent}
          pending={pending}
          scope={scope}
          onClose={() => setPending(null)}
          onDone={() => {
            setPending(null);
            setTick((t) => t + 1);
          }}
          onNotice={onNotice}
        />
      )}
    </div>
  );
}

function RestorePreview({
  cwd,
  sessionId,
  agent,
  pending,
  scope,
  onClose,
  onDone,
  onNotice,
}: {
  cwd: string;
  sessionId: string;
  agent: string;
  pending: Pending;
  scope: ipc.TurnScope;
  onClose: () => void;
  onDone: () => void;
  onNotice: Notify;
}) {
  useEscape(onClose);
  const [preview, setPreview] = useState<ipc.TurnPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void ipc
      .turnPreview(cwd, sessionId, pending.action.target, scope)
      .then((p) => live && setPreview(p))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [cwd, sessionId, pending.action.target, scope]);

  const files = useMemo(() => (preview ? splitPatch(preview.patch) : []), [preview]);

  const apply = useCallback(async () => {
    setBusy(true);
    try {
      const claudeBin = agentCliFor(agent)?.bin ?? null;
      const out = await ipc.turnRestore({
        cwd,
        sessionId,
        target: pending.action.target,
        scope,
        claudeBin: pending.action.nativeUuid ? claudeBin : null,
        nativeUuid: pending.action.nativeUuid,
      });
      const n = out.written.length + out.deleted.length;
      if (out.failed.length) {
        onNotice(`Restored ${n} file${n === 1 ? "" : "s"}; ${out.failed.length} could not be written: ${out.failed[0]}`, "warn");
      } else {
        onNotice(`Restored ${n} file${n === 1 ? "" : "s"}. Use “Redo” to put them back.`, "success");
      }
      onDone();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }, [agent, cwd, sessionId, pending, scope, onNotice, onDone]);

  const count = preview?.changes.length ?? 0;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal aw-turns-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{pending.label}</h3>
        {pending.action.caveat && <p className="aw-turns-caveat">{pending.action.caveat}</p>}
        {error && <p className="aw-turns-error">{error}</p>}
        {!preview && !error && <p className="aw-turns-note">Comparing with the saved snapshot…</p>}
        {preview && (
          <>
            {count === 0 ? (
              <p className="aw-turns-note">Nothing to change — the files already match this point.</p>
            ) : (
              <ul className="aw-turns-files">
                {preview.changes.map((c) => (
                  <li key={c.path}>
                    <span className={`aw-turns-st aw-turns-st-${c.status}`}>
                      {c.status === "add" ? "restore" : c.status === "delete" ? "remove" : "revert"}
                    </span>
                    <code>{c.path}</code>
                  </li>
                ))}
              </ul>
            )}
            {preview.excluded.length > 0 && (
              <p className="aw-turns-note">
                Left alone: {preview.excluded.length} other changed file
                {preview.excluded.length === 1 ? "" : "s"} not attributed to this agent
                (another agent's work, or files made by shell commands).
              </p>
            )}
            {files.map((f) => (
              <div key={f.path} className="aw-turns-diff">
                <DiffView
                  data={{ hunks: [f.patch], oldFile: { fileName: f.path }, newFile: { fileName: f.path } }}
                  diffViewMode={DiffModeEnum.Unified}
                  diffViewHighlight={patchStats(f.patch).changed <= HIGHLIGHT_MAX}
                  diffViewTheme="dark"
                  diffViewWrap
                  diffViewFontSize={12}
                />
              </div>
            ))}
            {preview.truncated && <p className="aw-turns-note">Diff truncated; the file list above is complete.</p>}
          </>
        )}
        <p className="aw-turns-note">{IRREVERSIBLE_NOTE}</p>
        <div className="modal-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!preview || count === 0 || busy} onClick={() => void apply()}>
            {busy ? "Restoring…" : `Restore ${count} file${count === 1 ? "" : "s"}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
