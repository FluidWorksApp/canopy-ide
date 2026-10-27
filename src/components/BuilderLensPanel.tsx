// The builder lens's own tools, above the Build chat: plain-language history
// ("Go back to when it worked"), the diagnose-first "Something's wrong" flow,
// and the Data / Logic / View map with layer owners. It reads the same project,
// sessions and files the engineer lens does — nothing here owns state the
// engineer lens can't see. All judgment comes from the brain (askBrain). Fixes
// go through the Build session; going back to a saved version doesn't need
// one (lensRestore.ts commits the restored files as a new version).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as ipc from "../ipc";
import type { Project } from "../projects";
import type { BuilderSession } from "../vibeBuilderSessionTypes";
import { getSettings, subscribeSettings } from "../settings";
import { onAgentTurnEnd } from "../agentTurns";
import { queryLedger } from "../ledger";
import { timelineWords } from "../turnRollback";
import { builderRoot } from "../projectLens";
import { lensSteps, lensStepsVersion, subscribeLensSteps } from "../lensSteps";
import { previewRestore, restoreVersion, type RestorePreview } from "../lensRestore";
import { gateNotices, leadFinding, subscribeGateNotices } from "../gates/events";
import { isActiveGate, loadRules, republishPolicy } from "../gates/rules";
import { layerApprovals, layerOfGateId, APPROVAL_TTL_MS, type LayerApprovalData } from "../lensGates";
import { requestLayerApproval, subscribeLayerApprovals } from "../lensApprovals";
import { peekTeamIdentity, subscribeTeamIdentity, teamIdentity, type TeamIdentity } from "../teamIdentity";
import {
  RISK_LABEL,
  checkpointTitle,
  checkpointsFromLog,
  filesInPatch,
  peekCheckpointSummary,
  summarizeCheckpoint,
  type CheckpointSummary,
  type LensCheckpoint,
} from "../lensCheckpoints";
import {
  FIX_STRIKE_LIMIT,
  canTryAnotherFix,
  diagnose,
  fixAttempts,
  fixRequest,
  previewEvidence,
  restartFromPlanRequest,
  settleFixAttempt,
  startFixAttempt,
  strikesFrom,
  type Convergence,
  type Diagnosis,
  type FixAttempt,
} from "../lensDiagnose";
import {
  LAYER_EXPLAINER,
  LAYER_LABEL,
  OWNABLE_LAYERS,
  cachedLayerMap,
  claimLayer,
  ensureLayerMap,
  layerOwners,
  ownedLayerHits,
  ownershipNotice,
  ownsLayer,
  releaseLayer,
  saveLayerGlobs,
  teamRulesAvailable,
  type LayerMap,
  type LayerOwners,
  type OwnedLayer,
  type OwnedLayerHit,
} from "../lensLayers";
import type { LedgerEntry } from "../ledger";
import { Button, Checkbox } from "./ui";
import "./builderLens.css";

type Section = "changes" | "wrong" | "layers";

export interface BuilderLensPanelProps {
  project: Pick<Project, "id" | "name" | "components" | "vibe">;
  /** The live Build session — the only thing allowed to change files. */
  session: BuilderSession | null;
}

const useAutoSummaries = () =>
  useSyncExternalStore(subscribeSettings, () => getSettings().lensAutoSummaries);

/** The signed-in team identity: who "I own this" and "is it mine" mean. */
function useTeamIdentity(): { me: TeamIdentity | null; known: boolean } {
  const me = useSyncExternalStore(subscribeTeamIdentity, peekTeamIdentity);
  const [known, setKnown] = useState(me !== null);
  useEffect(() => {
    let live = true;
    void teamIdentity().then(() => live && setKnown(true));
    return () => {
      live = false;
    };
  }, [me]);
  return { me, known };
}

export function BuilderLensPanel({ project, session }: BuilderLensPanelProps) {
  const root = builderRoot(project);
  const [open, setOpen] = useState<Section | null>(null);
  const toggle = (s: Section) => setOpen((cur) => (cur === s ? null : s));
  if (!root) return null;
  return (
    <section className="builder-lens" aria-label="Builder tools">
      <RemoteNotice projectId={project.id} root={root} />
      <div className="builder-lens-tabs" role="tablist" aria-label="Builder tools">
        {([
          ["changes", "What changed"],
          ["wrong", "Something’s wrong"],
          ["layers", "How it’s built"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={open === id}
            aria-controls={`builder-lens-${id}`}
            className={`builder-lens-tab ${open === id ? "active" : ""}`}
            onClick={() => toggle(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {/* Mounted while closed so the history keeps collecting steps and the
          ownership watch keeps running; only the open one is shown. */}
      <div id="builder-lens-changes" role="tabpanel" hidden={open !== "changes"}>
        <ChangesSection project={project} root={root} session={session} />
      </div>
      <div id="builder-lens-wrong" role="tabpanel" hidden={open !== "wrong"}>
        {open === "wrong" && <WrongSection project={project} root={root} session={session} />}
      </div>
      <div id="builder-lens-layers" role="tabpanel" hidden={open !== "layers"}>
        {open === "layers" && <LayersSection project={project} root={root} />}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ notice

const dismissKey = (projectId: string) => `canopy.lens.remoteNotice.${projectId}`;

/** A builder lens on a shared repository with no enforced team rules is the
 *  report's warning case. Not a block: a notice with the way to fix it. The
 *  Team rules button is offered when this project's Rules panel is really
 *  there to open (gates/events.ts registerRulesEditor). */
function RemoteNotice({ projectId, root }: { projectId: string; root: string }) {
  const [remote, setRemote] = useState(false);
  const [enforced, setEnforced] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(dismissKey(projectId)) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let live = true;
    void ipc.gitRemoteUrl(root).then(
      (url) => live && setRemote(Boolean(url && url.trim())),
      () => undefined,
    );
    void loadRules(root).then(
      (set) => live && setEnforced(set.rules.some(isActiveGate)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [root]);
  if (!remote || dismissed || enforced) return null;
  const editor = teamRulesAvailable(root);
  return (
    <div className="builder-lens-notice" role="note">
      <span>
        This project is shared with others through its online repository. Changes made here
        aren’t checked against team rules yet — {editor ? "add one, or ask an engineer to." : "ask an engineer to turn them on."}
      </span>
      <span className="builder-lens-notice-actions">
        {editor && (
          <Button
            size="sm"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("canopy:open-settings", { detail: { tab: "rules", cwd: root } }))
            }
          >
            Team rules
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDismissed(true);
            try {
              localStorage.setItem(dismissKey(projectId), "1");
            } catch {
              /* shown again next time — harmless */
            }
          }}
        >
          Got it
        </Button>
      </span>
    </div>
  );
}

// ----------------------------------------------------------------- changes

const sameTree = (root: string, cwd: string) => {
  const r = root.replace(/\/+$/, "");
  return cwd === r || cwd.startsWith(`${r}/`);
};

/** Layers a gate stopped an agent from writing into, from the gate notices
 *  (the hook's verdicts) for this project: the change that needs approval
 *  before it can happen at all. */
function blockedHits(root: string, owners: LayerOwners): (OwnedLayerHit & { attempted: string[] })[] {
  const by = new Map<OwnedLayer, OwnedLayerHit & { attempted: string[] }>();
  for (const n of gateNotices()) {
    if (n.resolved || !sameTree(root, n.cwd) || n.stamp.status !== "blocked") continue;
    const f = leadFinding(n.stamp);
    const layer = layerOfGateId(f?.ruleId);
    const claim = layer ? owners[layer] : undefined;
    if (!layer || !claim) continue;
    const file = /\(([^()]+)\)$/.exec(f?.label ?? "")?.[1];
    const hit = by.get(layer) ?? { layer, owner: claim.data.owner, ownerId: claim.data.ownerId ?? null, files: [], attempted: [] };
    if (file && !hit.files.includes(file)) hit.files.push(file);
    hit.attempted.push(n.stamp.action.replace(/^write:/, "change "));
    by.set(layer, hit);
  }
  return [...by.values()].filter((h) => h.files.length);
}

function ChangesSection({
  project,
  root,
  session,
}: {
  project: BuilderLensPanelProps["project"];
  root: string;
  session: BuilderSession | null;
}) {
  const auto = useAutoSummaries();
  const { me } = useTeamIdentity();
  const [saved, setSaved] = useState<LensCheckpoint[]>([]);
  const [summaries, setSummaries] = useState<Record<string, CheckpointSummary | null>>({});
  const [hits, setHits] = useState<OwnedLayerHit[]>([]);
  const [owners, setOwners] = useState<LayerOwners>({});
  const [tick, setTick] = useState(0);
  const [restoring, setRestoring] = useState<{ sha: string; title: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const words = timelineWords(true);
  // Steps are collected app-wide (lensSteps.ts), so turns that ended while
  // this panel wasn't on screen are here, summaries included.
  const stepsVersion = useSyncExternalStore(subscribeLensSteps, lensStepsVersion);
  const steps = useMemo(() => lensSteps(root), [root, stepsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const notices = useSyncExternalStore(subscribeGateNotices, gateNotices);

  // Saved versions come from git; refreshed whenever a turn ends.
  useEffect(() => {
    let live = true;
    void ipc.gitLog(root, 40).then(
      (log) => live && setSaved(checkpointsFromLog(log).slice(0, 15)),
      () => live && setSaved([]),
    );
    return () => {
      live = false;
    };
  }, [root, tick]);

  useEffect(
    () =>
      onAgentTurnEnd((turn) => {
        if (sameTree(root, turn.cwd)) setTick((t) => t + 1);
      }),
    [root],
  );

  const items = useMemo(
    () => [...steps, ...saved].sort((a, b) => b.at - a.at).slice(0, 20),
    [steps, saved],
  );

  // Cached summaries show at once; missing saved-version summaries are asked
  // for in the background when the person allows it (steps are summarised by
  // lensSteps as they end). summarizeCheckpoint dedupes.
  useEffect(() => {
    let live = true;
    for (const cp of items) {
      if (summaries[cp.key]) continue;
      const cached = peekCheckpointSummary(root, cp.key);
      if (cached) {
        setSummaries((cur) => ({ ...cur, [cp.key]: cached }));
        continue;
      }
      if (!auto || cp.key in summaries) continue;
      void summarizeCheckpoint(root, cp).then((s) => {
        if (live) setSummaries((cur) => ({ ...cur, [cp.key]: s }));
      });
    }
    return () => {
      live = false;
    };
  }, [items, auto, root, stepsVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ownership watch: the newest step's files (or the newest saved version's),
  // and any write a layer gate stopped.
  useEffect(() => {
    let live = true;
    const newest = items[0];
    void (async () => {
      const [map, current] = await Promise.all([cachedLayerMap(root), layerOwners(root)]);
      if (!live) return;
      setOwners(current);
      if (!map || Object.keys(current).length === 0) {
        setHits([]);
        return;
      }
      const files = !newest
        ? []
        : newest.files.length
          ? newest.files
          : newest.sha
            ? filesInPatch((await ipc.gitCommitPatch(root, newest.sha).catch(() => null))?.patch ?? "")
            : [];
      if (live) setHits(ownedLayerHits(root, files, map.globs, current, me));
    })();
    return () => {
      live = false;
    };
  }, [items, root, me]);

  const blocked = useMemo(() => blockedHits(root, owners), [root, owners, notices]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => {
    const by = new Map<OwnedLayer, OwnedLayerHit & { attempted?: string[] }>();
    for (const h of [...blocked, ...hits]) {
      const prev = by.get(h.layer);
      by.set(h.layer, prev ? { ...prev, files: [...new Set([...prev.files, ...h.files])] } : h);
    }
    return [...by.values()];
  }, [blocked, hits]);

  return (
    <div className="builder-lens-body">
      {shown.map((hit) => (
        <OwnershipBanner
          key={hit.layer}
          hit={hit}
          root={root}
          projectName={project.name}
          goal={items[0]?.goal ?? ""}
        />
      ))}
      <ApprovalStatus root={root} session={session} />
      {note && (
        <p className="builder-lens-note" role="status">
          {note}
        </p>
      )}
      <div className="builder-lens-head">{words.title}</div>
      {items.length === 0 ? (
        <p className="builder-lens-note">Saved versions appear here after your first change.</p>
      ) : (
        <ol className="builder-lens-list">
          {items.map((cp) => {
            const summary = summaries[cp.key] ?? peekCheckpointSummary(root, cp.key);
            const title = checkpointTitle(cp, summary);
            return (
              <li key={cp.key} className="builder-lens-item">
                <div className="builder-lens-item-head">
                  <strong>{title}</strong>
                  {summary && (
                    <span className={`builder-lens-chip layer-${summary.layer}`}>{LAYER_LABEL[summary.layer]}</span>
                  )}
                </div>
                {summary ? (
                  <p className="builder-lens-item-text">
                    {summary.whatChanged}{" "}
                    <span className={`builder-lens-risk risk-${summary.risk}`}>{RISK_LABEL[summary.risk]}</span>
                  </p>
                ) : (
                  !(cp.key in summaries) && auto && <p className="builder-lens-note">Writing a summary…</p>
                )}
                {cp.sha && (
                  <Button
                    size="sm"
                    variant="ghost"
                    title={`See what changes, then restore the project to “${title}”`}
                    onClick={() => setRestoring({ sha: cp.sha!, title })}
                  >
                    {words.back}
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {restoring && (
        <RestoreDialog
          root={root}
          target={restoring}
          onClose={() => setRestoring(null)}
          onDone={(message) => {
            setRestoring(null);
            setNote(message);
            setTick((t) => t + 1);
          }}
        />
      )}
    </div>
  );
}

const STATUS_WORDS: Record<"restore" | "remove" | "revert", string> = {
  restore: "bring back",
  remove: "remove",
  revert: "change back",
};

/** "Go back to here": what will change, then the restore itself, committed as
 *  a new version (lensRestore.ts). Works with or without a Build session. */
function RestoreDialog({
  root,
  target,
  onClose,
  onDone,
  after,
  confirmLabel,
}: {
  root: string;
  target: { sha: string; title: string };
  onClose: () => void;
  onDone: (message: string) => void;
  /** Runs after a successful restore (Restart from plan sends the rebuild). */
  after?: () => void;
  confirmLabel?: string;
}) {
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPatch, setShowPatch] = useState(false);
  useEffect(() => {
    let live = true;
    void previewRestore(root, target.sha).then(
      (p) => live && setPreview(p),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [root, target.sha]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await restoreVersion(root, target.sha, target.title);
      after?.();
      onDone(
        out.commit
          ? `Back to “${target.title}”: ${out.changed} file${out.changed === 1 ? "" : "s"} restored and saved as a new version${
              out.savedFirst ? ", after saving your unsaved changes as their own version" : ""
            }. You can go back from this one too.`
          : `The project already matches “${target.title}”. Nothing to change.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const count = preview?.changes.length ?? 0;
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="modal builder-lens-restore"
        role="dialog"
        aria-modal="true"
        aria-label={`Go back to ${target.title}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Go back to “{target.title}”</h3>
        {error && (
          <p className="builder-lens-note" role="alert">
            Couldn’t go back: {error}
          </p>
        )}
        {!preview && !error && <p className="builder-lens-note">Comparing with that version…</p>}
        {preview && (
          <>
            {count === 0 ? (
              <p className="builder-lens-note">The project already matches this version.</p>
            ) : (
              <>
                <p className="builder-lens-note">
                  {count} file{count === 1 ? "" : "s"} will change. Nothing is lost: this is saved as a new version
                  {preview.unsaved ? ", and your unsaved changes are saved as their own version first" : ""}.
                </p>
                <ul className="builder-lens-files" aria-label="What changes">
                  {preview.changes.slice(0, 80).map((c) => (
                    <li key={c.path}>
                      <span className={`builder-lens-restore-st st-${c.status}`}>{STATUS_WORDS[c.status]}</span>{" "}
                      <code>{c.path}</code>
                    </li>
                  ))}
                  {preview.changes.length > 80 && <li className="builder-lens-note">…and {preview.changes.length - 80} more</li>}
                </ul>
                {preview.patch && (
                  <Button size="sm" variant="ghost" aria-expanded={showPatch} onClick={() => setShowPatch((v) => !v)}>
                    {showPatch ? "Hide the details" : "Show the details"}
                  </Button>
                )}
                {showPatch && (
                  <pre className="builder-lens-patch" aria-label="Details" tabIndex={0}>
                    {preview.patch}
                    {preview.truncated ? "\n… (shortened)" : ""}
                  </pre>
                )}
              </>
            )}
          </>
        )}
        <div className="modal-actions">
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="accent" disabled={!preview || busy || (count === 0 && !after)} onClick={() => void apply()}>
            {busy ? "Going back…" : (confirmLabel ?? "Go back")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function OwnershipBanner({
  hit,
  root,
  projectName,
  goal,
}: {
  hit: OwnedLayerHit & { attempted?: string[] };
  root: string;
  projectName: string;
  goal: string;
}) {
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const send = async () => {
    setState({ busy: true, error: null });
    const diff = (
      await Promise.all(hit.files.slice(0, 8).map((f) => ipc.gitDiff(root, f, false).catch(() => "")))
    ).join("\n");
    const result = await requestLayerApproval({ root, projectName, hit, goal, attempted: hit.attempted, diff }).catch(
      (e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) }),
    );
    setState({ busy: false, error: result.ok ? null : result.message });
  };
  return (
    <div className="builder-lens-owned" role="status">
      <span>
        {ownershipNotice(hit)}
        {hit.attempted?.length ? " Build was stopped before changing it." : ""}
      </span>
      <Button size="sm" variant="accent" disabled={state.busy} onClick={() => void send()}>
        {state.busy ? "Preparing…" : "Send for approval"}
      </Button>
      {state.error && (
        <span className="builder-lens-note" role="alert">
          {state.error}
        </span>
      )}
    </div>
  );
}

/** Approval requests from the last day and where each stands. An approved
 *  one offers to tell Build it can go ahead. */
function ApprovalStatus({ root, session }: { root: string; session: BuilderSession | null }) {
  const [rows, setRows] = useState<LayerApprovalData[]>([]);
  const [told, setTold] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);
  useEffect(() => subscribeLayerApprovals(() => setTick((t) => t + 1)), []);
  useEffect(() => {
    let live = true;
    void layerApprovals(root).then((all) => {
      if (!live) return;
      const now = Date.now();
      setRows(all.map((e) => e.data).filter((d) => now - (d.decidedAt ?? d.requestedAt) < APPROVAL_TTL_MS).slice(0, 5));
    });
    return () => {
      live = false;
    };
  }, [root, tick]);
  if (!rows.length) return null;
  return (
    <ul className="builder-lens-approvals" aria-label="Approvals">
      {rows.map((a) => (
        <li key={a.approvalId} className={`builder-lens-approval is-${a.status}`}>
          <span>
            {a.status === "pending"
              ? `Waiting for ${a.owner} to approve the ${LAYER_LABEL[a.layer]} change.`
              : a.status === "approved"
                ? `${a.decidedBy ?? a.owner} approved the ${LAYER_LABEL[a.layer]} change.`
                : `${a.decidedBy ?? a.owner} said no to the ${LAYER_LABEL[a.layer]} change${a.note ? `: ${a.note}` : "."}`}
          </span>
          {a.status !== "pending" && session && !told.has(a.approvalId) && (
            <Button
              size="sm"
              variant={a.status === "approved" ? "accent" : "default"}
              onClick={() => {
                setTold((cur) => new Set(cur).add(a.approvalId));
                void session.send(
                  a.status === "approved"
                    ? `${a.decidedBy ?? a.owner} approved the ${LAYER_LABEL[a.layer]} change. Go ahead.`
                    : `${a.decidedBy ?? a.owner} didn't approve the ${LAYER_LABEL[a.layer]} change. Find another way.`,
                  {
                    context:
                      a.status === "approved"
                        ? `The owner approved changes to these files, and they are no longer blocked: ${a.files.join(", ")}. Make the change you were stopped from making, and nothing else in that layer.`
                        : `The owner rejected changes to: ${a.files.join(", ")}.${a.note ? ` Their reason: ${a.note}.` : ""} Don't edit those files; propose an approach that leaves them alone.`,
                  },
                );
              }}
            >
              {a.status === "approved" ? "Tell Build to go ahead" : "Tell Build"}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

// ----------------------------------------------------------- something's wrong

type Phase =
  | { kind: "idle" }
  | { kind: "diagnosing" }
  | { kind: "failed"; message: string }
  | { kind: "diagnosed"; primary: Diagnosis; second?: Diagnosis | null; convergence?: Convergence }
  | { kind: "fixing"; diagnosis: Diagnosis; attempt: LedgerEntry<FixAttempt> | null };

const CONVERGENCE_TEXT: Record<Convergence, string> = {
  agree: "Both looks agree on the cause.",
  partly: "Both looks point at the same part of the app, but explain it differently.",
  disagree: "The two looks disagree — treat this as a guess and check before fixing.",
};

function DiagnosisCard({ d, label }: { d: Diagnosis; label?: string }) {
  return (
    <div className="builder-lens-diagnosis">
      {label && <div className="builder-lens-note">{label}</div>}
      <div className="builder-lens-item-head">
        <strong>{d.likelyCause}</strong>
        <span className={`builder-lens-chip layer-${d.layer}`}>{LAYER_LABEL[d.layer]}</span>
      </div>
      {d.evidence.length > 0 && (
        <ul className="builder-lens-evidence" aria-label="Evidence">
          {d.evidence.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <p className="builder-lens-item-text">
        <em>Suggested fix:</em> {d.suggestedFix}
      </p>
      <p className="builder-lens-note">Confidence: {d.confidence}</p>
    </div>
  );
}

function WrongSection({
  project,
  root,
  session,
}: {
  project: BuilderLensPanelProps["project"];
  root: string;
  session: BuilderSession | null;
}) {
  const [symptom, setSymptom] = useState("");
  const [second, setSecond] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [strikes, setStrikes] = useState(0);
  const [tried, setTried] = useState<Diagnosis[]>([]);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const refreshStrikes = useCallback(async (text: string) => {
    const attempts = text.trim() ? await fixAttempts(root, text) : [];
    setStrikes(strikesFrom(attempts));
    setTried(attempts.map((a) => a.data?.diagnosis).filter(Boolean) as Diagnosis[]);
  }, [root]);

  const run = async () => {
    const text = symptom.trim();
    if (!text) return;
    abort.current?.abort();
    abort.current = new AbortController();
    setPhase({ kind: "diagnosing" });
    void refreshStrikes(text);
    const [evidence, log] = await Promise.all([
      previewEvidence(project.id),
      ipc.gitLog(root, 20).catch(() => []),
    ]);
    const recentChanges = checkpointsFromLog(log)
      .slice(0, 8)
      .map((cp) => checkpointTitle(cp, peekCheckpointSummary(root, cp.key)));
    const result = await diagnose(
      root,
      { symptom: text, ...evidence, recentChanges },
      { secondOpinion: second, signal: abort.current.signal },
    );
    setPhase(result.ok ? { kind: "diagnosed", ...result } : { kind: "failed", message: result.message });
  };

  const fix = async (d: Diagnosis) => {
    if (!session) return;
    const attempt = await startFixAttempt(root, { symptom, diagnosis: d });
    const req = fixRequest(symptom, d);
    void session.send(req.text, { context: req.context });
    setPhase({ kind: "fixing", diagnosis: d, attempt });
    void refreshStrikes(symptom);
  };

  const settle = async (result: "fixed" | "failed") => {
    if (phase.kind !== "fixing") return;
    if (phase.attempt) await settleFixAttempt(root, phase.attempt, result);
    await refreshStrikes(symptom);
    setPhase(result === "fixed" ? { kind: "idle" } : { kind: "diagnosed", primary: phase.diagnosis });
    if (result === "fixed") setSymptom("");
  };

  // Restart from plan: go back to the last saved version directly (with a
  // preview), then hand the rebuild to Build when it's there. Without a Build
  // session the restore still happens; the rebuild waits for it.
  const [restartTarget, setRestartTarget] = useState<{ sha: string; title: string } | null>(null);
  const [restartNote, setRestartNote] = useState<string | null>(null);
  const [rebuildPending, setRebuildPending] = useState<{ sha: string; title: string } | null>(null);
  const lastCheckpoint = async () => {
    const log = await ipc.gitLog(root, 40).catch(() => []);
    const last = checkpointsFromLog(log).find((c) => !c.goal.startsWith("Before going back to")) ?? null;
    return last?.sha ? { sha: last.sha, title: checkpointTitle(last, peekCheckpointSummary(root, last.key)) } : null;
  };
  const sendRebuild = async (checkpoint: { sha: string; title: string } | null, restored: boolean) => {
    if (!session) return false;
    const plans = await queryLedger(root, { kinds: ["plan"], limit: 1 }).catch(() => []);
    const plan = plans[0] ? JSON.stringify(plans[0].data).slice(0, 4000) : null;
    const req = restartFromPlanRequest({ symptom, checkpoint, plan, tried, restored });
    void session.send(req.text, { context: req.context });
    return true;
  };
  const restart = async () => {
    const checkpoint = await lastCheckpoint();
    if (checkpoint) {
      setRestartTarget(checkpoint);
      return;
    }
    // No saved version to go back to: rebuild from the plan in place.
    if (await sendRebuild(null, false)) setPhase({ kind: "idle" });
    else setRestartNote("There’s no saved version to go back to yet. When Build is ready, ask it to rebuild from the plan.");
  };

  const outOfTries = !canTryAnotherFix(strikes);
  return (
    <div className="builder-lens-body">
      <label className="builder-lens-label">
        What’s wrong?
        <textarea
          aria-label="What’s wrong?"
          rows={3}
          value={symptom}
          placeholder="e.g. The sign-up button does nothing"
          onChange={(e) => setSymptom(e.target.value)}
          onBlur={() => void refreshStrikes(symptom)}
        />
      </label>
      <Checkbox
        checked={second}
        onChange={setSecond}
        label="Get a second opinion"
        hint="Two separate looks at the problem, to see if they agree."
      />
      <div className="builder-lens-actions">
        <Button
          size="sm"
          variant="accent"
          disabled={!symptom.trim() || phase.kind === "diagnosing"}
          onClick={() => void run()}
        >
          {phase.kind === "diagnosing" ? "Looking into it…" : "Find the cause"}
        </Button>
      </div>
      <p className="builder-lens-note">Finding the cause never changes your project. Nothing is fixed until you say so.</p>
      {phase.kind === "failed" && <p className="builder-lens-note" role="alert">Couldn’t look into it: {phase.message}</p>}
      {phase.kind === "diagnosed" && (
        <>
          <DiagnosisCard d={phase.primary} label={phase.second ? "First look" : undefined} />
          {phase.second && <DiagnosisCard d={phase.second} label="Second look" />}
          {phase.convergence && (
            <p className={`builder-lens-convergence conv-${phase.convergence}`} role="status">
              {CONVERGENCE_TEXT[phase.convergence]}
            </p>
          )}
          {phase.second === null && (
            <p className="builder-lens-note">Only one look finished, so there’s nothing to compare.</p>
          )}
          {outOfTries ? (
            <div className="builder-lens-strikes" role="alert">
              <p>
                {FIX_STRIKE_LIMIT} fixes for this haven’t worked. Another patch is likely to make it worse —
                start over from the last version that worked and rebuild from the plan.
              </p>
              <Button size="sm" variant="accent" onClick={() => void restart()}>
                Restart from plan
              </Button>
            </div>
          ) : (
            <div className="builder-lens-actions">
              <Button size="sm" variant="accent" disabled={!session} onClick={() => void fix(phase.primary)}>
                Fix it
              </Button>
              {phase.second && phase.convergence !== "agree" && (
                <Button size="sm" disabled={!session} onClick={() => void fix(phase.second!)}>
                  Fix using the second look
                </Button>
              )}
              {strikes > 0 && (
                <span className="builder-lens-note">
                  Attempt {strikes + 1} of {FIX_STRIKE_LIMIT}
                </span>
              )}
            </div>
          )}
        </>
      )}
      {restartNote && (
        <p className="builder-lens-note" role="status">
          {restartNote}
        </p>
      )}
      {rebuildPending && session && (
        <div className="builder-lens-actions">
          <Button
            size="sm"
            variant="accent"
            onClick={() => {
              const target = rebuildPending;
              setRebuildPending(null);
              setRestartNote(null);
              void sendRebuild(target, true).then(() => setPhase({ kind: "idle" }));
            }}
          >
            Rebuild from the plan
          </Button>
        </div>
      )}
      {restartTarget && (
        <RestoreDialog
          root={root}
          target={restartTarget}
          confirmLabel="Go back and restart"
          onClose={() => setRestartTarget(null)}
          after={() => {
            const target = restartTarget;
            void sendRebuild(target, true).then((sent) => {
              if (sent) setPhase({ kind: "idle" });
              else setRebuildPending(target);
            });
          }}
          onDone={(message) => {
            setRestartTarget(null);
            setRestartNote(
              session
                ? `${message} Build is rebuilding from the plan.`
                : `${message} When Build is ready, press Rebuild from the plan.`,
            );
          }}
        />
      )}
      {phase.kind === "fixing" && (
        <div className="builder-lens-fixing" role="status">
          <p>Build is working on the fix. When it’s done, check the preview.</p>
          <div className="builder-lens-actions">
            <span>Did that fix it?</span>
            <Button size="sm" variant="accent" onClick={() => void settle("fixed")}>
              Yes, it works
            </Button>
            <Button size="sm" onClick={() => void settle("failed")}>
              Still broken
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- layers

function LayersSection({ project, root }: { project: BuilderLensPanelProps["project"]; root: string }) {
  const auto = useAutoSummaries();
  const [map, setMap] = useState<LayerMap | null>(null);
  const [state, setState] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [owners, setOwners] = useState<LayerOwners>({});
  const { me, known } = useTeamIdentity();
  const [editing, setEditing] = useState<OwnedLayer | null>(null);
  const [draft, setDraft] = useState("");

  const load = useCallback(
    async (refresh: boolean) => {
      setState({ busy: true, message: null });
      const result = await ensureLayerMap(root, project.name, {
        refresh,
        tier: refresh ? "main" : "background",
      });
      if (result.ok) {
        setMap(result.map);
        setState({ busy: false, message: null });
      } else setState({ busy: false, message: result.message });
    },
    [root, project.name],
  );

  useEffect(() => {
    let live = true;
    void cachedLayerMap(root).then((cached) => {
      if (!live) return;
      if (cached) setMap(cached);
      else if (auto) void load(false);
    });
    void layerOwners(root).then((o) => {
      if (!live) return;
      setOwners(o);
      // Keep the enforced gates current (an approval's day can run out while
      // nothing else republishes): only where a layer is owned at all.
      if (Object.keys(o).length) void republishPolicy(root).catch(() => undefined);
    });
    return () => {
      live = false;
    };
  }, [root, auto, load, me]);

  // Ownership is enforced (lensGates.ts), so every change to it republishes
  // the policy the hook reads.
  const claim = async (layer: OwnedLayer) => {
    if (!me) return;
    await claimLayer(root, layer, me).catch(() => undefined);
    setOwners(await layerOwners(root));
    await republishPolicy(root).catch(() => undefined);
  };
  const release = async (layer: OwnedLayer) => {
    const c = owners[layer];
    if (!c) return;
    await releaseLayer(root, c).catch(() => undefined);
    setOwners(await layerOwners(root));
    await republishPolicy(root).catch(() => undefined);
  };
  const saveGlobs = async (layer: OwnedLayer) => {
    const next = await saveLayerGlobs(root, layer, draft.split(/\n|,/).map((g) => g.trim()));
    if (next) setMap(next);
    setEditing(null);
    if (owners[layer]) await republishPolicy(root).catch(() => undefined);
  };

  return (
    <div className="builder-lens-body">
      <div className="builder-lens-head">
        How your project is built
        <Button size="sm" variant="ghost" disabled={state.busy} onClick={() => void load(true)}>
          {state.busy ? "Reading…" : map ? "Refresh" : "Map it"}
        </Button>
      </div>
      {state.message && <p className="builder-lens-note" role="alert">Couldn’t map the project: {state.message}</p>}
      {!map && !state.busy && !state.message && (
        <p className="builder-lens-note">Map the project to see its data, logic and view layers.</p>
      )}
      {map && (
        <div className="builder-lens-layers">
          {(["data", "logic", "view"] as const).map((layer) => (
            <div key={layer} className={`builder-lens-layer layer-${layer}`}>
              <button
                type="button"
                className="builder-lens-layer-head"
                aria-expanded={expanded === layer}
                onClick={() => setExpanded((cur) => (cur === layer ? null : layer))}
              >
                <strong>{LAYER_LABEL[layer]}</strong>
                <span>{map.areas[layer].summary}</span>
                <small>{LAYER_EXPLAINER[layer]}</small>
              </button>
              {expanded === layer && (
                <ul className="builder-lens-files" aria-label={`${LAYER_LABEL[layer]} files`}>
                  {map.areas[layer].files.length ? (
                    map.areas[layer].files.map((f) => <li key={f}><code>{f}</code></li>)
                  ) : (
                    <li className="builder-lens-note">No files found for this layer.</li>
                  )}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="builder-lens-head">Who looks after what</div>
      {me ? (
        <p className="builder-lens-note">
          You’re signed in as {me.name}. Agents can’t change a layer someone else owns until its owner approves;
          your own agents can.
        </p>
      ) : (
        known && (
          <div className="builder-lens-notice" role="note">
            <span>Sign in to Canopy to own a layer, so your team knows it’s you.</span>
            <Button
              size="sm"
              onClick={() => window.dispatchEvent(new CustomEvent("canopy:open-settings", { detail: { tab: "account" } }))}
            >
              Sign in
            </Button>
          </div>
        )
      )}
      <ul className="builder-lens-owners">
        {OWNABLE_LAYERS.map((layer) => {
          const owner = owners[layer]?.data.owner ?? null;
          const mine = ownsLayer(me, owners[layer]);
          const globs = map?.globs[layer] ?? [];
          return (
            <li key={layer} className="builder-lens-owner">
              <div className="builder-lens-item-head">
                <strong>{LAYER_LABEL[layer]}</strong>
                <span>{owner ? `Owned by ${owner}` : "Nobody owns this yet"}</span>
                {mine ? (
                  <Button size="sm" variant="ghost" onClick={() => void release(layer)}>Let go</Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={!me || (!!owner && !mine)}
                    title={!me ? "Sign in to Canopy first" : owner ? `${owner} owns this` : undefined}
                    onClick={() => void claim(layer)}
                  >
                    {`I own ${LAYER_LABEL[layer].toLowerCase()}`}
                  </Button>
                )}
              </div>
              {editing === layer ? (
                <div className="builder-lens-globs-edit">
                  <textarea
                    aria-label={`${LAYER_LABEL[layer]} file patterns`}
                    rows={3}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  <div className="builder-lens-actions">
                    <Button size="sm" variant="accent" onClick={() => void saveGlobs(layer)}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="builder-lens-globs">
                  <small>{globs.length ? globs.join(", ") : map ? "No matching files found" : "Map the project to find its files"}</small>
                  {map && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setDraft(globs.join("\n"));
                        setEditing(layer);
                      }}
                    >
                      Edit
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
