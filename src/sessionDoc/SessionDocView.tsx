// An agent session as a readable document, and the hand-off flow built on it.
//
// Sections: the brain's written summary (decisions and why, open questions,
// next steps, risks), the goal, the timeline of turns (prompt → files changed
// → proof receipt), files changed with how much of each survives, and what
// other tools filed about the session. Facts come from Canopy's stores
// (load.ts); the summary is the brain's (narrative.ts), cached per turn.
//
// Private by default. Nothing leaves this machine until the person presses a
// share button, and every share shows its exact text first: the hand-off
// packet is an editable preview, and "Send to a teammate" goes through the
// share dialog, which previews the card and its fallback text and warns about
// anything that looks like a credential.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { askBrain } from "../brainCall";
import { onAgentTurnEnd } from "../agentTurns";
import { watchPtyBirths } from "../ptyBirth";
import { appendLedger } from "../ledger";
import { getSettings } from "../settings";
import { openShareDialog } from "../shareCards";
import { useEscape } from "../useEscape";
import { activeWorkspace } from "../remoteExecution/workspace";
import { Button, Select } from "../components/ui";
import { basename } from "../paths";
import { VERDICT_LABEL, type ReceiptBadge, type SessionDocument } from "./assemble";
import { buildHandoffCard } from "./card";
import { OPEN_SESSION_DOC_EVENT, type SessionDocRequest } from "./events";
import { generateHandoff, takeoverBrief } from "./handoff";
import {
  installedAgents,
  launchAgent,
  launchProjects,
  type InstalledAgent,
  type LaunchRequest,
  type LaunchResult,
} from "./launcher";
import { loadSessionDoc, type LoadedSessionDoc, type SessionDocSource } from "./load";
import { brainDeclined, cachedNarrative, narrativeDue, writeNarrative, type SessionNarrative } from "./narrative";
import "./sessionDoc.css";

/** Everything the view reaches outside itself, injectable for tests. */
export interface SessionDocDeps {
  load(src: SessionDocSource): Promise<LoadedSessionDoc>;
  ask: typeof askBrain;
  append: typeof appendLedger;
  share(card: Awaited<ReturnType<typeof buildHandoffCard>>): void;
  buildCard: typeof buildHandoffCard;
  copy(text: string): Promise<void>;
  launch(req: LaunchRequest): Promise<LaunchResult>;
  agents(): Promise<InstalledAgent[]>;
  projects(): { name: string; dirs: string[] }[];
  autoSummary(): boolean;
  /** Calls back with the session id whenever an agent turn ends. */
  onTurnEnd(cb: (sessionId: string) => void): () => void;
}

const defaultDeps: SessionDocDeps = {
  load: (src) => loadSessionDoc(src),
  ask: askBrain,
  append: appendLedger,
  share: (card) => openShareDialog({ kind: "share", card }),
  buildCard: buildHandoffCard,
  copy: (text) => navigator.clipboard.writeText(text),
  launch: launchAgent,
  agents: installedAgents,
  projects: launchProjects,
  autoSummary: () => getSettings().sessionDocAutoSummary,
  onTurnEnd: (cb) => onAgentTurnEnd((turn) => cb(turn.sessionId)),
};

/** A running session's document also re-reads its facts this often, for CLIs
 *  whose turns Canopy cannot see end (no hooks). Facts only: the summary
 *  keeps to its own pace (narrativeDue). */
const LIVE_RELOAD_MS = 60_000;

/** Where brain calls run. In a cloud workspace the session's directory is on
 *  the workspace host, not on the computer the brain runs on. */
const brainCwd = (cwd: string) => (activeWorkspace() ? "" : cwd);

const clock = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

function Badge({ receipt }: { receipt: ReceiptBadge }) {
  return (
    <span className={`sdoc-receipt is-${receipt.verdict}`} title={receipt.label}>
      {receipt.verdict === "pass" ? "✓" : receipt.verdict === "fail" ? "✗" : receipt.verdict === "partial" ? "◐" : "•"}{" "}
      {VERDICT_LABEL[receipt.verdict]}
    </span>
  );
}

function List({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="sdoc-empty">{empty}</p>;
  return (
    <ul className="sdoc-list">
      {items.map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ul>
  );
}

type NarrativeState =
  | { phase: "idle" }
  | { phase: "writing"; previous?: SessionNarrative }
  | { phase: "ready"; narrative: SessionNarrative; stale: boolean; at: number }
  | { phase: "declined"; message: string; previous?: SessionNarrative };

// ------------------------------------------------------------ continue panel

/** Pick a CLI and a project folder, then start a fresh agent from a packet. */
export function ContinueInNewAgent({
  markdown,
  title,
  defaultDir,
  deps,
}: {
  markdown: string;
  title: string;
  defaultDir?: string;
  deps: Pick<SessionDocDeps, "launch" | "agents" | "projects">;
}) {
  const [agents, setAgents] = useState<InstalledAgent[] | null>(null);
  const [agent, setAgent] = useState("");
  const dirs = useMemo(
    () => deps.projects().flatMap((p) => p.dirs.map((d) => ({ label: p.dirs.length > 1 ? `${p.name} — ${basename(d)}` : p.name, dir: d }))),
    [deps],
  );
  const [dir, setDir] = useState(() => {
    const exact = dirs.find((d) => d.dir === defaultDir);
    return exact?.dir ?? dirs[0]?.dir ?? "";
  });
  const [result, setResult] = useState<LaunchResult | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void deps.agents().then((a) => {
      if (!live) return;
      setAgents(a);
      setAgent((cur) => cur || a[0]?.id || "");
    });
    return () => {
      live = false;
    };
  }, [deps]);
  const start = async () => {
    setBusy(true);
    setResult(null);
    const r = await deps.launch({
      dir,
      prompt: takeoverBrief(markdown),
      label: `Handoff: ${title}`.slice(0, 80),
      agent: agent || null,
    });
    setResult(r);
    setBusy(false);
  };
  return (
    <div className="sdoc-continue" role="group" aria-label="Continue in a new agent">
      <div className="sdoc-row">
        <label>
          Agent
          <Select size="sm" width="full" aria-label="Agent" value={agent} onChange={(e) => setAgent(e.target.value)}>
            {agents === null && <option value="">Looking…</option>}
            {agents?.length === 0 && <option value="">No agent CLI installed</option>}
            {agents?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.brain ? " (your brain)" : ""}
              </option>
            ))}
          </Select>
        </label>
        <label>
          Project
          <Select size="sm" width="full" aria-label="Project folder" value={dir} onChange={(e) => setDir(e.target.value)}>
            {dirs.length === 0 && <option value="">No projects open</option>}
            {dirs.map((d) => (
              <option key={d.dir} value={d.dir} title={d.dir}>
                {d.label}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <div className="sdoc-actions">
        <Button size="sm" variant="accent" disabled={!dir || !agent || busy} onClick={() => void start()}>
          {busy ? "Starting…" : "Start agent from this packet"}
        </Button>
      </div>
      {result && (
        <p className={result.started ? "sdoc-note" : "sdoc-error"} role="status">
          {result.note}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------ hand off

function HandOffPanel({
  doc,
  narrative,
  request,
  branch,
  deps,
}: {
  doc: SessionDocument;
  narrative?: SessionNarrative;
  request: Extract<SessionDocRequest, { kind: "session" }>;
  branch?: string;
  deps: SessionDocDeps;
}) {
  const [phase, setPhase] = useState<"preview" | "writing" | "ready" | "error">("preview");
  const [markdown, setMarkdown] = useState("");
  const [title, setTitle] = useState(doc.title);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [target, setTarget] = useState<"none" | "continue">("none");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const write = async () => {
    setPhase("writing");
    setError("");
    abort.current = new AbortController();
    const r = await generateHandoff(doc, {
      cwd: brainCwd(doc.cwd),
      narrative,
      branch,
      resumeCommand: request.resumeCommand,
      signal: abort.current.signal,
      ask: deps.ask,
      append: deps.append,
    });
    if (!r.ok) {
      setError(brainDeclined(r.reason, r.message));
      setPhase("error");
      return;
    }
    setMarkdown(r.markdown);
    setTitle(r.packet.title);
    setPhase("ready");
  };

  if (phase === "preview" || phase === "writing" || phase === "error") {
    return (
      <section className="sdoc-handoff" aria-label="Hand off">
        <h3>Hand off this session</h3>
        <p className="sdoc-note">
          Your brain reads this session — the goal, every turn's prompt, the files changed, the latest receipt and the
          end of the conversation — on this computer, and writes a packet someone else can continue from. Nothing is
          sent anywhere until you choose where it goes, and you can edit the packet first.
        </p>
        {error && (
          <p className="sdoc-error" role="alert">
            {error}
          </p>
        )}
        <div className="sdoc-actions">
          <Button variant="accent" size="sm" disabled={phase === "writing"} onClick={() => void write()}>
            {phase === "writing" ? "Writing the packet…" : phase === "error" ? "Try again" : "Write hand-off packet"}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="sdoc-handoff" aria-label="Hand off">
      <h3>Hand-off packet</h3>
      <p className="sdoc-note">
        This is exactly what will be shared. Edit anything you'd rather not pass on. Saved privately to this project's
        history.
      </p>
      <textarea
        className="sdoc-packet"
        aria-label="Hand-off packet"
        value={markdown}
        onChange={(e) => setMarkdown(e.target.value)}
        rows={14}
        spellCheck={false}
      />
      <div className="sdoc-actions">
        <Button
          size="sm"
          onClick={() =>
            void deps
              .copy(markdown)
              .then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => {})
          }
        >
          {copied ? "Copied" : "Copy as markdown"}
        </Button>
        <Button
          size="sm"
          onClick={() =>
            void deps
              .buildCard({ title, agent: doc.agent, sessionId: doc.sessionId, markdown, cwd: doc.cwd, repo: request.repo })
              .then((card) => deps.share(card))
          }
        >
          Send to a teammate…
        </Button>
        <Button size="sm" aria-expanded={target === "continue"} onClick={() => setTarget((t) => (t === "continue" ? "none" : "continue"))}>
          Continue in a new agent…
        </Button>
        {request.onResume && (
          <Button size="sm" variant="ghost" onClick={request.onResume} title={request.resumeCommand ?? undefined}>
            Resume the original session
          </Button>
        )}
      </div>
      {target === "continue" && <ContinueInNewAgent markdown={markdown} title={title} defaultDir={doc.cwd} deps={deps} />}
    </section>
  );
}

// ------------------------------------------------------------ document

export function SessionDocView({
  request,
  onClose,
  deps = defaultDeps,
}: {
  request: Extract<SessionDocRequest, { kind: "session" }>;
  onClose: () => void;
  deps?: SessionDocDeps;
}) {
  useEscape(onClose);
  const [loaded, setLoaded] = useState<LoadedSessionDoc | null>(null);
  const [loadError, setLoadError] = useState("");
  const [narrative, setNarrative] = useState<NarrativeState>({ phase: "idle" });
  const [handingOff, setHandingOff] = useState(false);
  const abort = useRef<AbortController | null>(null);
  // Bumped when the running session ends a turn: the document re-reads its
  // facts in place, keeping what it shows until the new reading lands.
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!request.live) return;
    const off = deps.onTurnEnd((sid) => sid === request.sessionId && setReload((n) => n + 1));
    const timer = window.setInterval(() => setReload((n) => n + 1), LIVE_RELOAD_MS);
    return () => {
      off();
      window.clearInterval(timer);
    };
  }, [deps, request.live, request.sessionId]);
  const firstLoad = useRef(true);
  useEffect(() => {
    firstLoad.current = true;
  }, [deps, request]);

  useEffect(() => {
    let live = true;
    if (firstLoad.current) setLoaded(null);
    firstLoad.current = false;
    void deps
      .load({
        sessionId: request.sessionId,
        agent: request.agent,
        cwd: request.cwd,
        repo: request.repo,
        digest: request.digest,
        live: request.live,
      })
      .then((l) => live && setLoaded(l))
      .catch((e: unknown) => live && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [deps, request, reload]);

  const summarize = useCallback(
    async (doc: SessionDocument, previous?: SessionNarrative) => {
      abort.current?.abort();
      abort.current = new AbortController();
      setNarrative({ phase: "writing", previous });
      const answer = await writeNarrative(doc, { cwd: brainCwd(doc.cwd), signal: abort.current.signal, ask: deps.ask });
      if (answer.ok && answer.value) setNarrative({ phase: "ready", narrative: answer.value, stale: false, at: Date.now() });
      else if (!answer.ok) setNarrative({ phase: "declined", message: brainDeclined(answer.reason, answer.message), previous });
      else setNarrative({ phase: "declined", message: brainDeclined("invalid-output"), previous });
    },
    [deps],
  );
  useEffect(() => () => abort.current?.abort(), []);

  // The cached reading when it is for this turn; otherwise a fresh one —
  // automatically when the setting allows, with the stale one shown meanwhile.
  // A running session re-reads its facts every turn but asks the brain again
  // only every few turns or minutes (narrativeDue); in between, the cached
  // reading shows marked as written earlier. Never a second call while one
  // is still being written.
  const writing = narrative.phase === "writing";
  useEffect(() => {
    if (!loaded || writing) return;
    const doc = loaded.doc;
    const hit = cachedNarrative(doc.sessionId);
    if (hit && hit.turnKey === doc.lastTurnKey) {
      setNarrative({ phase: "ready", narrative: hit.narrative, stale: false, at: hit.at });
      return;
    }
    const nothingToRead = !doc.turns.length && !doc.transcript.length && !doc.goal.text;
    const due = narrativeDue(hit, doc, { live: request.live });
    if (deps.autoSummary() && !nothingToRead && due) void summarize(doc, hit?.narrative);
    else if (hit) setNarrative({ phase: "ready", narrative: hit.narrative, stale: true, at: hit.at });
    // `writing` is read, not watched: a finished write must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, deps, summarize, request.live]);

  const doc = loaded?.doc;
  const shown =
    narrative.phase === "ready"
      ? narrative.narrative
      : narrative.phase === "writing" || narrative.phase === "declined"
        ? narrative.previous
        : undefined;
  const cloud = !!activeWorkspace();

  return (
    <div className="sdoc-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <article className="sdoc" role="dialog" aria-modal="true" aria-label="Session document">
        <header className="sdoc-head">
          <div className="sdoc-head-main">
            <h2>{doc?.title ?? "Session"}</h2>
            <div className="sdoc-meta">
              <span>{request.agent}</span>
              {doc?.cwd && <span title={doc.cwd}>{basename(doc.cwd)}</span>}
              {loaded?.digest?.branch && <span>⎇ {loaded.digest.branch}</span>}
              <span>{request.live ? "running" : "past session"}</span>
              <span className="sdoc-private" title="Only you can see this document. Sharing always shows you the exact text first.">
                🔒 Private to you
              </span>
            </div>
          </div>
          <div className="sdoc-head-actions">
            {doc && (
              <Button size="sm" variant="accent" aria-expanded={handingOff} onClick={() => setHandingOff((v) => !v)}>
                Hand off…
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close document">
              Close
            </Button>
          </div>
        </header>

        {!loaded && !loadError && <p className="sdoc-empty">Reading the session…</p>}
        {loadError && (
          <p className="sdoc-error" role="alert">
            Couldn't read this session: {loadError}
          </p>
        )}

        {doc && (
          <div className="sdoc-body">
            {handingOff && (
              <HandOffPanel doc={doc} narrative={shown} request={request} branch={loaded?.digest?.branch} deps={deps} />
            )}

            <section className="sdoc-summary" aria-label="Summary" aria-busy={narrative.phase === "writing"}>
              <div className="sdoc-section-head">
                <h3>Summary</h3>
                <span className="sdoc-by">written by your brain</span>
                <span className="sdoc-spacer" />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={narrative.phase === "writing"}
                  onClick={() => void summarize(doc, shown)}
                >
                  {narrative.phase === "writing" ? "Writing…" : shown ? "Refresh" : "Write summary"}
                </Button>
              </div>
              {narrative.phase === "writing" && !shown && <p className="sdoc-empty">Reading the session…</p>}
              {narrative.phase === "declined" && <p className="sdoc-state">{narrative.message}</p>}
              {narrative.phase === "ready" && narrative.stale && (
                <p className="sdoc-state">
                  {request.live && deps.autoSummary()
                    ? `Written at ${clock(narrative.at)}, before the latest turn — it is rewritten every few turns while the session runs, or press Refresh.`
                    : "Written before the latest turn — press Refresh to bring it up to date."}
                </p>
              )}
              {narrative.phase === "idle" && !shown && (
                <p className="sdoc-empty">No summary yet. “Write summary” asks your brain to read the session.</p>
              )}
              {shown && <p className="sdoc-summary-text">{shown.summary}</p>}
            </section>

            <section aria-label="Goal">
              <h3>Goal</h3>
              {doc.goal.text ? (
                <>
                  <p className="sdoc-goal">{doc.goal.text}</p>
                  <small className="sdoc-by">{doc.goal.source === "plan" ? "from the session's plan" : "the first thing asked"}</small>
                  {doc.goal.steps.length > 0 && (
                    <ol className="sdoc-list">
                      {doc.goal.steps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                  )}
                </>
              ) : (
                <p className="sdoc-empty">No prompt was captured for this session.</p>
              )}
            </section>

            <section aria-label="Timeline">
              <h3>
                Timeline <span className="badge">{doc.turns.length}</span>
              </h3>
              {doc.turns.length === 0 ? (
                <p className="sdoc-empty">No turns recorded — this agent's CLI doesn't report turns to Canopy.</p>
              ) : (
                <ol className="sdoc-turns">
                  {doc.turns.map((t) => (
                    <li key={t.n} className="sdoc-turn">
                      <div className="sdoc-turn-head">
                        <span className="sdoc-turn-n">{t.n}</span>
                        <span className="sdoc-turn-when">{clock(t.startedAt)}</span>
                        {t.receipt && <Badge receipt={t.receipt} />}
                      </div>
                      <p className="sdoc-turn-prompt">{t.prompt || <em>(no prompt captured)</em>}</p>
                      {t.files.length > 0 && (
                        <div className="sdoc-chips" aria-label="Files changed in this turn">
                          {t.files.slice(0, 12).map((f) => (
                            <span key={f} className="sdoc-chip" title={f}>
                              {basename(f)}
                            </span>
                          ))}
                          {t.files.length > 12 && <span className="sdoc-chip">+{t.files.length - 12}</span>}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section aria-label="Decisions">
              <h3>Decisions and why</h3>
              {!shown ? (
                <p className="sdoc-empty">Appears with the summary.</p>
              ) : shown.decisions.length === 0 ? (
                <p className="sdoc-empty">No decisions stood out.</p>
              ) : (
                <ul className="sdoc-list sdoc-decisions">
                  {shown.decisions.map((d, i) => (
                    <li key={i}>
                      <strong>{d.decision}</strong> — {d.why}
                      {d.alternativesRejected.length > 0 && (
                        <div className="sdoc-rejected">Not chosen: {d.alternativesRejected.join("; ")}</div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="Open questions">
              <h3>Open questions</h3>
              {shown ? <List items={shown.openQuestions} empty="Nothing left open." /> : <p className="sdoc-empty">Appears with the summary.</p>}
              {shown && shown.nextSteps.length > 0 && (
                <>
                  <h4>Next steps</h4>
                  <List items={shown.nextSteps} empty="" />
                </>
              )}
              {shown && shown.risks.length > 0 && (
                <>
                  <h4>Risks</h4>
                  <List items={shown.risks} empty="" />
                </>
              )}
            </section>

            <section aria-label="Files changed">
              <h3>
                Files changed <span className="badge">{doc.files.length}</span>
              </h3>
              {doc.files.length === 0 ? (
                <p className="sdoc-empty">No file changes recorded.</p>
              ) : (
                <>
                  <p className="sdoc-note">
                    Lines from this session: {doc.survivingEdits} edit{doc.survivingEdits === 1 ? "" : "s"} it wrote are
                    still in the code.
                  </p>
                  <ul className="sdoc-files">
                    {doc.files.map((f) => (
                      <li key={f.path}>
                        <code>{f.path}</code>
                        {f.edits > 0 && (
                          <span className="sdoc-by">
                            {f.present} of {f.edits} edit{f.edits === 1 ? "" : "s"} still present
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {doc.prs.length > 0 && (
                <p className="sdoc-note">
                  Pull requests from this session: {doc.prs.map((p) => `#${p.number}`).join(", ")}
                </p>
              )}
            </section>

            {doc.notes.length > 0 && (
              <section aria-label="Notes">
                <h3>Noted along the way</h3>
                <ul className="sdoc-list">
                  {doc.notes.map((n) => (
                    <li key={n.id}>
                      <span className="sdoc-by">{n.kind === "memory" ? "remembered" : "noticed"}</span> {n.text}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {doc.handoffs.length > 0 && (
              <section aria-label="Earlier hand-offs">
                <h3>Earlier hand-offs</h3>
                <ul className="sdoc-list">
                  {doc.handoffs.slice(0, 5).map((h) => (
                    <li key={h.id}>
                      {clock(h.ts)} — {h.subject ?? "hand-off packet"}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <footer className="sdoc-foot">
              {loaded.missing.length > 0 && <span>Not available here: {loaded.missing.join(", ")}.</span>}
              {cloud && (
                <button
                  type="button"
                  className="sdoc-link"
                  onClick={() => window.dispatchEvent(new CustomEvent("canopy:open-workspaces"))}
                >
                  Work on a session live with a teammate: Shared sessions
                </button>
              )}
            </footer>
          </div>
        )}
      </article>
    </div>
  );
}

// ------------------------------------------------------------ received

/** A handoff card a teammate sent, opened with "Take over": the packet to read
 *  (plain text — it came from another device), and a fresh agent of your own
 *  to continue it in the project you choose. */
export function ReceivedHandoffView({
  request,
  onClose,
  deps = defaultDeps,
}: {
  request: Extract<SessionDocRequest, { kind: "received" }>;
  onClose: () => void;
  deps?: Pick<SessionDocDeps, "launch" | "agents" | "projects" | "copy">;
}) {
  useEscape(onClose);
  return (
    <div className="sdoc-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <article className="sdoc" role="dialog" aria-modal="true" aria-label="Take over a session">
        <header className="sdoc-head">
          <div className="sdoc-head-main">
            <h2>Take over: {request.title}</h2>
            <div className="sdoc-meta">
              {request.from && <span>from {request.from}</span>}
              <span>{request.agent} session</span>
              {request.repo && <span>{request.repo.slug}</span>}
              {request.dir && <span>{request.dir}</span>}
            </div>
          </div>
          <div className="sdoc-head-actions">
            <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close">
              Close
            </Button>
          </div>
        </header>
        <div className="sdoc-body">
          <section aria-label="Packet">
            <h3>Their hand-off packet</h3>
            <pre className="sdoc-packet-read" tabIndex={0}>
              {request.packet}
            </pre>
            <div className="sdoc-actions">
              <Button size="sm" variant="ghost" onClick={() => void deps.copy(request.packet).catch(() => {})}>
                Copy packet
              </Button>
            </div>
          </section>
          <section aria-label="Continue">
            <h3>Continue it here</h3>
            <p className="sdoc-note">
              Starts a fresh agent on your computer whose brief is this packet. It checks the code against the packet
              before changing anything.
            </p>
            <ContinueInNewAgent markdown={request.packet} title={request.title} deps={deps} />
          </section>
        </div>
      </article>
    </div>
  );
}

/** The one session-document overlay, opened by `openSessionDoc` from any entry
 *  point (mounted once by App). */
export function SessionDocHost() {
  const [request, setRequest] = useState<SessionDocRequest | null>(null);
  // Terminal start times, for finding the session of a CLI with no hooks.
  useEffect(() => watchPtyBirths(), []);
  useEffect(() => {
    const open = (e: Event) => {
      const d = (e as CustomEvent<SessionDocRequest>).detail;
      if (d) setRequest(d);
    };
    window.addEventListener(OPEN_SESSION_DOC_EVENT, open);
    return () => window.removeEventListener(OPEN_SESSION_DOC_EVENT, open);
  }, []);
  const close = useCallback(() => setRequest(null), []);
  if (!request) return null;
  return request.kind === "session" ? (
    <SessionDocView key={request.sessionId} request={request} onClose={close} />
  ) : (
    <ReceivedHandoffView key={`${request.session}:${request.title}`} request={request} onClose={close} />
  );
}
