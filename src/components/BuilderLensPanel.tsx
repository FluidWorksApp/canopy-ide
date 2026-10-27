// The builder lens's own tools, above the Build chat: plain-language history
// ("Go back to when it worked"), the diagnose-first "Something's wrong" flow,
// and the Data / Logic / View map with layer owners. It reads the same project,
// sessions and files the engineer lens does — nothing here owns state the
// engineer lens can't see. All judgment comes from the brain (askBrain); all
// edits go through the existing Build session.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as ipc from "../ipc";
import type { Project } from "../projects";
import type { BuilderSession } from "../vibeBuilderSessionTypes";
import { getSettings, subscribeSettings } from "../settings";
import { onAgentTurnEnd } from "../agentTurns";
import { queryLedger } from "../ledger";
import { buildReportCard, openShareDialog } from "../shareCards";
import { timelineWords } from "../turnRollback";
import { builderRoot } from "../projectLens";
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
  goBackRequest,
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
  lensIdentity,
  layerOwners,
  ownedLayerHits,
  ownershipNotice,
  releaseLayer,
  saveLayerGlobs,
  setLensIdentity,
  teamRulesAvailable,
  type LayerMap,
  type LayerOwners,
  type OwnedLayer,
  type OwnedLayerHit,
} from "../lensLayers";
import type { LedgerEntry } from "../ledger";
import { Button, Checkbox, TextInput } from "./ui";
import "./builderLens.css";

type Section = "changes" | "wrong" | "layers";

export interface BuilderLensPanelProps {
  project: Pick<Project, "id" | "name" | "components" | "vibe">;
  /** The live Build session — the only thing allowed to change files. */
  session: BuilderSession | null;
}

const useAutoSummaries = () =>
  useSyncExternalStore(subscribeSettings, () => getSettings().lensAutoSummaries);

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

/** A builder lens on a shared repository, before team rules exist, is the
 *  report's warning case. Not a block: a notice with the way to fix it. */
function RemoteNotice({ projectId, root }: { projectId: string; root: string }) {
  const [remote, setRemote] = useState(false);
  const [rules, setRules] = useState(false);
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
    void teamRulesAvailable(root).then((on) => live && setRules(on));
    return () => {
      live = false;
    };
  }, [root]);
  if (!remote || dismissed) return null;
  return (
    <div className="builder-lens-notice" role="note">
      <span>
        This project is shared with others through its online repository. Changes made here
        aren’t checked against team rules yet — ask an engineer to turn them on.
      </span>
      <span className="builder-lens-notice-actions">
        {rules && (
          <Button
            size="sm"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("canopy:open-settings", { detail: { tab: "rules" } }))
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
  const [saved, setSaved] = useState<LensCheckpoint[]>([]);
  const [steps, setSteps] = useState<LensCheckpoint[]>([]);
  const [summaries, setSummaries] = useState<Record<string, CheckpointSummary | null>>({});
  const [hits, setHits] = useState<OwnedLayerHit[]>([]);
  const [tick, setTick] = useState(0);
  const words = timelineWords(true);

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
        if (!sameTree(root, turn.cwd)) return;
        setSteps((cur) =>
          [
            {
              key: `turn:${turn.turnId}`,
              kind: "step" as const,
              goal: turn.prompt?.trim() ?? "",
              at: turn.endedAt,
              files: turn.filesTouched,
            },
            ...cur.filter((s) => s.key !== `turn:${turn.turnId}`),
          ].slice(0, 15),
        );
        setTick((t) => t + 1);
      }),
    [root],
  );

  const items = useMemo(
    () => [...steps, ...saved].sort((a, b) => b.at - a.at).slice(0, 20),
    [steps, saved],
  );

  // Cached summaries show at once; missing ones are asked for in the
  // background when the person allows it. summarizeCheckpoint dedupes.
  useEffect(() => {
    let live = true;
    for (const cp of items) {
      if (cp.key in summaries) continue;
      const cached = peekCheckpointSummary(root, cp.key);
      if (cached) {
        setSummaries((cur) => ({ ...cur, [cp.key]: cached }));
        continue;
      }
      if (!auto) continue;
      void summarizeCheckpoint(root, cp).then((s) => {
        if (live) setSummaries((cur) => ({ ...cur, [cp.key]: s }));
      });
    }
    return () => {
      live = false;
    };
  }, [items, auto, root]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ownership watch: the newest step's files, or the newest saved version's.
  useEffect(() => {
    let live = true;
    const newest = items[0];
    if (!newest) return;
    void (async () => {
      const [map, owners] = await Promise.all([cachedLayerMap(root), layerOwners(root)]);
      if (!map || Object.keys(owners).length === 0) return;
      const files = newest.files.length
        ? newest.files
        : newest.sha
          ? filesInPatch((await ipc.gitCommitPatch(root, newest.sha).catch(() => null))?.patch ?? "")
          : [];
      if (live) setHits(ownedLayerHits(root, files, map.globs, owners, lensIdentity()));
    })();
    return () => {
      live = false;
    };
  }, [items, root]);

  const send = (req: { text: string; context: string }) => void session?.send(req.text, { context: req.context });

  return (
    <div className="builder-lens-body">
      {hits.map((hit) => (
        <OwnershipBanner key={hit.layer} hit={hit} root={root} projectName={project.name} />
      ))}
      <div className="builder-lens-head">{words.title}</div>
      {items.length === 0 ? (
        <p className="builder-lens-note">Saved versions appear here after your first change.</p>
      ) : (
        <ol className="builder-lens-list">
          {items.map((cp) => {
            const summary = summaries[cp.key] ?? null;
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
                    disabled={!session}
                    title={session ? `Restore the project to “${title}”` : "Build is still getting ready"}
                    onClick={() => send(goBackRequest({ sha: cp.sha!, title }))}
                  >
                    {words.back}
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function OwnershipBanner({ hit, root, projectName }: { hit: OwnedLayerHit; root: string; projectName: string }) {
  return (
    <div className="builder-lens-owned" role="status">
      <span>{ownershipNotice(hit)}</span>
      <Button
        size="sm"
        variant="accent"
        onClick={() =>
          void buildReportCard(
            "Builder",
            `Approval needed: ${LAYER_LABEL[hit.layer]} change in ${projectName}`,
            [
              `${hit.owner}, a builder change touched ${LAYER_LABEL[hit.layer]}, which you own. Please review and approve.`,
              "",
              "Files:",
              ...hit.files.slice(0, 30).map((f) => `- ${f}`),
            ].join("\n"),
            root,
          ).then(
            (card) => openShareDialog({ kind: "share", card }),
            (e: unknown) => openShareDialog({ kind: "error", message: String(e instanceof Error ? e.message : e) }),
          )
        }
      >
        Send for approval
      </Button>
    </div>
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

  const restart = async () => {
    if (!session) return;
    const [log, plans] = await Promise.all([
      ipc.gitLog(root, 40).catch(() => []),
      queryLedger(root, { kinds: ["plan"], limit: 1 }).catch(() => []),
    ]);
    const last = checkpointsFromLog(log)[0] ?? null;
    const plan = plans[0] ? JSON.stringify(plans[0].data).slice(0, 4000) : null;
    const req = restartFromPlanRequest({
      symptom,
      checkpoint: last?.sha ? { sha: last.sha, title: checkpointTitle(last, peekCheckpointSummary(root, last.key)) } : null,
      plan,
      tried,
    });
    void session.send(req.text, { context: req.context });
    setPhase({ kind: "idle" });
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
              <Button size="sm" variant="accent" disabled={!session} onClick={() => void restart()}>
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
  const [me, setMe] = useState(() => lensIdentity() ?? "");
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
    void layerOwners(root).then((o) => live && setOwners(o));
    return () => {
      live = false;
    };
  }, [root, auto, load]);

  const claim = async (layer: OwnedLayer) => {
    const name = me.trim();
    if (!name) return;
    setLensIdentity(name);
    await claimLayer(root, layer, name).catch(() => undefined);
    setOwners(await layerOwners(root));
  };
  const release = async (layer: OwnedLayer) => {
    const c = owners[layer];
    if (!c) return;
    await releaseLayer(root, c).catch(() => undefined);
    setOwners(await layerOwners(root));
  };
  const saveGlobs = async (layer: OwnedLayer) => {
    const next = await saveLayerGlobs(root, layer, draft.split(/\n|,/).map((g) => g.trim()));
    if (next) setMap(next);
    setEditing(null);
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
      <label className="builder-lens-label">
        Your name
        <TextInput size="sm" width="full" aria-label="Your name" value={me} onChange={(e) => setMe(e.target.value)} />
      </label>
      <ul className="builder-lens-owners">
        {OWNABLE_LAYERS.map((layer) => {
          const owner = owners[layer]?.data.owner ?? null;
          const mine = owner && me.trim() && owner.toLowerCase() === me.trim().toLowerCase();
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
                    disabled={!me.trim()}
                    title={me.trim() ? undefined : "Enter your name first"}
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
