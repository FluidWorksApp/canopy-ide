// One research entry, open as a tab: the finding, what it recommends, what is
// still unresolved, the raw material behind it, and what shipped from it.
//
// The shape follows the tiers the store enforces. The digest and recommendation
// are at the top at full size because they are the entry — everything below is
// there for the reader who wants to check the work. Sources are listed, never
// inlined: the whole reason the body has a cap is that captures do not belong
// in the thing people read.
//
// The entry is re-read on every research event rather than held on the tab. An
// agent appends to it while it is on screen, and the PR watcher can move its
// status from under you; a copy on the tab would be a second truth going stale
// in front of the user.
import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as ipc from "../ipc";
import {
  NEXT_STATUSES,
  rename as renameResearch,
  RESEARCH_EVENT,
  STATUS_BLURBS,
  STATUS_LABELS,
  STATUS_STEP,
  remove as removeResearch,
  setStatus,
} from "../research";
import { ago } from "./ProjectView/helpers";
import { AgentLaunchButton } from "./AgentLaunchButton";
import { Markdown } from "./Markdown";
import type { AgentTarget } from "./TicketsPanel";
import {
  ArchiveIcon,
  BlockedIcon,
  CheckIcon,
  ExchangeIcon,
  RestartIcon,
  TrashIcon,
} from "./icons";
import { TaskProgress } from "./TaskProgress";
import { RESEARCH_STEPS, stepsDone } from "../microTasks";
import { Button } from "./ui";

interface ResearchViewProps {
  projectId: string;
  researchId: string;
  /** Hand this entry to a fresh agent to build, on the CLI the user picked. */
  onImplement?: (entry: ipc.ResearchDetail, agentId: string) => void;
  /** Hand it to an agent already running instead of starting one. */
  onSendImplement?: (target: AgentTarget, entry: ipc.ResearchDetail) => void;
  /** Agent terminals open in this project — the "send it there" targets. */
  agentTargets?: AgentTarget[];
  /** Which agent CLIs are on PATH. */
  installed?: Record<string, boolean>;
  /** Put an agent back on it. `steer` is what the user typed into the popover
   *  — continuing with nothing extra is allowed, and is the empty string. */
  onContinue?: (entry: ipc.ResearchDetail, steer: string) => void;
  /** Follow a link out to the thing it points at, natively. */
  onOpenPr?: (pr: ipc.ResearchPrLink) => void;
  onOpenFile?: (path: string) => void;
  /** Follow a [[wikilink]] in the write-up. Resolved centrally (wikilinks.ts)
   *  so a link means the same thing here as it does in a note. */
  onWikilink?: (target: string) => void;
  onClosed?: () => void;
  /** The title changed — the tab strip holds its own copy of it. */
  onRenamed?: (title: string) => void;
  onNotice?: (text: string, level?: "info" | "error") => void;
}

export function ResearchView({
  projectId,
  researchId,
  onImplement,
  onSendImplement,
  agentTargets,
  installed,
  onContinue,
  onOpenPr,
  onOpenFile,
  onWikilink,
  onClosed,
  onRenamed,
  onNotice,
}: ResearchViewProps) {
  const [entry, setEntry] = useState<ipc.ResearchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Milestones the run has reported. Polled from a file inside the entry
   *  rather than pushed, so it works on every CLI with or without the MCP
   *  bridge — the same arrangement the PR tabs use. */
  const [done, setDone] = useState<string[]>([]);
  /** The one expanded capture, and its text. One at a time on purpose. */
  const [open, setOpen] = useState<string | null>(null);
  const [sourceText, setSourceText] = useState<string | null>(null);
  /** The title being edited, or null when it is not. An entry names itself
   *  from the question, shortened, which is the only thing available when it is
   *  created and rarely what it should be called afterwards. */
  const [draft, setDraft] = useState<string | null>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  /** The steering box for "continue research". Open with an empty string —
   *  null is closed — because continuing with no extra direction is a perfectly
   *  good answer and must stay one keypress away. */
  const [steer, setSteer] = useState<string | null>(null);
  const steerInput = useRef<HTMLInputElement>(null);

  const steering = steer !== null;
  useEffect(() => {
    if (steering) setTimeout(() => steerInput.current?.focus(), 0);
  }, [steering]);

  // Whole thing selected, not a caret parked at the end: a rename here replaces
  // the auto-title far more often than it edits it. Same call the tab strip
  // makes for the same reason.
  // Keyed on whether it is open, not on the draft — re-selecting on every
  // keystroke would make the field impossible to type in.
  const renaming = draft !== null;
  useEffect(() => {
    if (!renaming) return;
    const el = titleInput.current;
    el?.focus();
    el?.select();
  }, [renaming]);

  const commitRename = () => {
    const next = (draft ?? "").trim();
    setDraft(null);
    if (!entry || !next || next === entry.title) return;
    void renameResearch(projectId, researchId, next)
      .then(() => {
        onRenamed?.(next);
        load();
      })
      .catch((e) => onNotice?.(String(e), "error"));
  };

  const toggleSource = (source: ipc.ResearchSource) => {
    if (open === source.file) {
      setOpen(null);
      return;
    }
    setOpen(source.file);
    setSourceText(null);
    ipc
      .researchReadFile(projectId, researchId, source.file)
      .then(setSourceText)
      .catch((e) => setSourceText(String(e)));
  };

  const load = useCallback(() => {
    ipc
      .researchGet(projectId, researchId)
      .then((d) => {
        setEntry(d);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [projectId, researchId]);

  useEffect(() => {
    load();
    window.addEventListener(RESEARCH_EVENT, load);
    // The store's own event, so an agent appending through MCP reaches an open
    // reader as well. The poll below only runs for a live status, so without
    // this an append to a finished entry sat unseen until the tab was reopened.
    let alive = true;
    let unlisten: (() => void) | undefined;
    void ipc
      .onResearchChanged((pid) => {
        if (pid === projectId) load();
      })
      .then((off) => (alive ? (unlisten = off) : off()))
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
      window.removeEventListener(RESEARCH_EVENT, load);
    };
  }, [load, projectId]);

  // While an agent is on it, the entry changes under the reader — findings are
  // appended, sources land, the status moves. Nothing in the window tells us,
  // so the page asks. Strictly gated on a live state: a poll that outlives what
  // it was watching is a tab that never goes quiet.
  const live = entry?.status === "researching" || entry?.status === "implementing";
  useEffect(() => {
    if (!live) return;
    const tick = window.setInterval(load, 2000);
    return () => window.clearInterval(tick);
  }, [live, load]);

  useEffect(() => {
    if (!live) {
      setDone([]);
      return;
    }
    let alive = true;
    const read = () =>
      void ipc
        .researchReadFile(projectId, researchId, "progress.txt")
        .then((t) => alive && setDone(stepsDone(t, RESEARCH_STEPS)))
        // No progress file yet is the normal first seconds of a run, not an
        // error — the rail simply sits at nothing reported.
        .catch(() => {});
    read();
    const tick = window.setInterval(read, 1500);
    return () => {
      alive = false;
      window.clearInterval(tick);
    };
  }, [live, projectId, researchId]);


  if (error) {
    return (
      <div className="research-view">
        <p className="research-empty">
          This research entry could not be read — it may have been deleted.
        </p>
      </div>
    );
  }
  if (!entry) return <div className="research-view" />;

  const moves = NEXT_STATUSES[entry.status] ?? [];

  const step = STATUS_STEP[entry.status] ?? 0;

  const move = (to: ipc.ResearchStatus) => {
    void setStatus(projectId, entry.id, to).catch((e) =>
      onNotice?.(String(e), "error"),
    );
  };

  const del = () => {
    void removeResearch(projectId, entry.id)
      .then(() => onClosed?.())
      .catch((e) => onNotice?.(String(e), "error"));
  };

  return (
    <div className="research-view">
      <div className="research-head">
        <div className="research-title">
          <span className="research-num">{entry.id.split("-")[0]}</span>
          {draft !== null ? (
            <input
              ref={titleInput}
              className="research-title-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setDraft(null);
                }
              }}
            />
          ) : (
            <span
              className="research-title-text"
              title="Double-click to rename"
              onDoubleClick={() => setDraft(entry.title)}
            >
              {entry.title}
            </span>
          )}
        </div>
        <div className="research-meta">
          <span className={`research-status research-status-${entry.status}`}>
            {STATUS_LABELS[entry.status]}
          </span>
          {/* Where it is on the way from question to shipped. A status word
              alone doesn't say how far along this is; five dots do. */}
          <span className="research-steps" title={STATUS_BLURBS[entry.status]}>
            {[0, 1, 2, 3, 4].map((i) => (
              <i key={i} className={i <= step ? "on" : ""} />
            ))}
          </span>
          {entry.agent && <span className="research-chip">{entry.agent}</span>}
          <span className="research-chip" title={new Date(entry.updated_at * 1000).toLocaleString()}>
            {ago(entry.updated_at)}
          </span>
          {entry.tags.map((t) => (
            <span key={t} className="research-tag">
              {t}
            </span>
          ))}

          <span className="status-spacer" />

          {/* Continuing is a different act from every other thing here — it
              starts an agent — so it keeps a word on it while the state moves
              below become icons. The popover is the point: continuing without
              saying what changed is how you get the same answer twice. */}
          {onContinue && (
            <div className="research-steer">
              <Button size="sm"
                onClick={() => setSteer(steer === null ? "" : null)}
                title="Put an agent back on this, with a nudge">
                Continue research
              </Button>
              {steer !== null && (
                <div className="cli-menu research-steer-menu">
                  <input
                    ref={steerInput}
                    className="agent-query-input"
                    placeholder="Anything to steer it? (optional)"
                    value={steer}
                    onChange={(e) => setSteer(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        onContinue(entry, steer.trim());
                        setSteer(null);
                      }
                      if (e.key === "Escape") setSteer(null);
                    }}
                  />
                  <p className="research-steer-note">
                    It gets this entry and everything already recorded in it.
                    Say what to focus on, or what the last run got wrong.
                  </p>
                  <Button size="sm" variant="accent"
                    onClick={() => {
                      onContinue(entry, steer.trim());
                      setSteer(null);
                    }}>
                    Continue
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Every state move, plus the two destructive ones, as marks. They
              are the CRUD of an entry — frequent, small, and not worth six
              same-sized words competing with the one action that matters. */}
          <span className="research-crud">
            {moves.includes("researched") && (
              <Button icon
                title="Mark researched — there is a finding here"
                onClick={() => move("researched")}>
                <CheckIcon />
              </Button>
            )}
            {moves.includes("researching") && (
              <Button icon
                title="Reopen — put it back to being researched"
                onClick={() => move("researching")}>
                <RestartIcon />
              </Button>
            )}
            {moves.includes("blocked") && (
              <Button icon
                title="Mark blocked — it is waiting on you"
                onClick={() => move("blocked")}>
                <BlockedIcon />
              </Button>
            )}
            {moves.includes("superseded") && (
              <Button icon
                title="Mark superseded — a later entry replaced this"
                onClick={() => move("superseded")}>
                <ExchangeIcon />
              </Button>
            )}
            {moves.includes("archived") && (
              <Button icon
                title="Archive — put it down without deleting it"
                onClick={() => move("archived")}>
                <ArchiveIcon />
              </Button>
            )}
            <Button icon variant="danger"
              title={`Delete this entry and everything in it (${entry.dir})`}
              onClick={del}>
              <TrashIcon />
            </Button>
          </span>
        </div>
      </div>

      {/* What the run is doing, while it is doing it. A research entry used to
          sit completely still for however long it took — the same complaint the
          micro-task rail was built to answer, so it is the same rail. */}
      {live && (
        <TaskProgress
          steps={RESEARCH_STEPS}
          done={done}
          active
          // Not the status word again — the pill above already says that, and
          // a rail that repeats it spends its one line of prose on nothing.
          // The steps carry the "what"; this carries the "who".
          title={
            entry.status === "implementing"
              ? `${entry.agent || "An agent"} is building this`
              : `${entry.agent || "An agent"} is on it`
          }
          elapsed={ago(entry.updated_at)}
        />
      )}

      {/* A superseded entry warns before it is read, not after. Acting on a
          finding someone has already replaced is the failure this prevents. */}
      {entry.superseded_by && (
        <p className="research-superseded">
          Superseded by {entry.superseded_by}. Read that one instead.
        </p>
      )}

      <div className="research-body">
        {entry.question && (
          <section className="research-section">
            <h3>Question</h3>
            <p className="research-question">{entry.question}</p>
          </section>
        )}

        {/* The two fields with caps on them, given the space that earns. */}
        {entry.digest && (
          <section className="research-section research-finding">
            <h3>Finding</h3>
            <p>{entry.digest}</p>
          </section>
        )}
        {entry.recommendation && (
          <section className="research-section research-recommendation">
            <h3>Recommendation</h3>
            <p>{entry.recommendation}</p>
          </section>
        )}
        {entry.open_questions.length > 0 && (
          <section className="research-section">
            <h3>Still open</h3>
            <ul className="research-open">
              {entry.open_questions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </section>
        )}

        <section className="research-section">
          <h3>Write-up</h3>
          {/* An empty write-up mid-run is the normal first minutes, not an
              absence — saying so beats a blank panel that reads as broken. */}
          {live && !entry.body.replace(/^#.*$/m, "").trim() ? (
            <p className="research-pending">
              Nothing written up yet — findings appear here as the agent records
              them.
            </p>
          ) : (
            // `owned`: the store wrote this, so its wikilinks resolve.
            <Markdown
              className="research-md"
              text={entry.body}
              origin="owned"
              onWikilink={onWikilink}
            />
          )}
        </section>

        {/* Named, sized, and opened one at a time — the manifest, not the
            contents. This is the tier rule made visible. */}
        {entry.sources.length > 0 && (
          <section className="research-section">
            <h3>Sources</h3>
            <ul className="research-sources">
              {entry.sources.map((s) => (
                <li key={s.file}>
                  <button
                    className="research-link"
                    onClick={() => toggleSource(s)}
                    aria-expanded={open === s.file}
                  >
                    {open === s.file ? "▾" : "▸"} {s.title}
                  </button>
                  <span className="research-source-meta">
                    {s.origin ? `${s.origin} · ` : ""}
                    {Math.max(1, Math.round(s.bytes / 1024))} KB
                  </span>
                  {/* Expanded here rather than opened as a file tab: the store
                      sits outside every registered workspace root, so the
                      editor cannot reach it — and a capture is something you
                      glance at to check the finding, not something you edit.
                      One at a time, which is the same rule the tools follow. */}
                  {open === s.file && (
                    <pre className="research-source-body">
                      {sourceText ?? "Loading…"}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {(entry.links.prs.length > 0 ||
          entry.links.tickets.length > 0 ||
          entry.links.files.length > 0 ||
          entry.links.branches.length > 0) && (
          <section className="research-section">
            <h3>What came of it</h3>
            <ul className="research-links">
              {entry.links.prs.map((pr) => (
                <li key={`${pr.repo}#${pr.number}`}>
                  <button className="research-link" onClick={() => onOpenPr?.(pr)}>
                    #{pr.number}
                  </button>
                  <span className={`research-pr-state research-pr-${pr.state}`}>{pr.state}</span>
                  <span className="research-source-meta">{pr.repo}</span>
                </li>
              ))}
              {entry.links.tickets.map((t) => (
                <li key={t.id}>
                  <button className="research-link" onClick={() => void openUrl(t.url)}>
                    {t.id}
                  </button>
                  <span className="research-source-meta">{t.title}</span>
                </li>
              ))}
              {entry.links.branches.map((b) => (
                <li key={b}>
                  <span className="research-source-meta">⑂ {b}</span>
                </li>
              ))}
              {entry.links.files.map((f) => (
                <li key={f}>
                  <button className="research-link" onClick={() => onOpenFile?.(f)}>
                    {f}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {entry.history.length > 0 && (
          <section className="research-section">
            <h3>History</h3>
            <ul className="research-history">
              {entry.history
                .slice()
                .reverse()
                .map((h, i) => (
                  <li key={i}>
                    <span className="research-source-meta">{ago(h.at)}</span>{" "}
                    {STATUS_LABELS[h.to as ipc.ResearchStatus] ?? h.to}
                    {h.by ? ` · ${h.by}` : ""}
                    {h.note ? ` — ${h.note}` : ""}
                  </li>
                ))}
            </ul>
          </section>
        )}
      </div>

      {/* The note leads, the control is rightmost — the same shape every other
          footer in the app has, and the reason the eye finds the action without
          reading the sentence first. A split button rather than a plain one:
          starting an agent is always a choice of *which* agent, and every other
          surface that starts one (the ticket tab, the PR header) already asks
          it that way. */}
      {moves.includes("implementing") && onImplement && (
        <div className="research-actions">
          <span className="research-actions-note">
            Starts an agent on a branch of its own. The pull request it raises is
            what marks this implemented.
          </span>
          <span className="status-spacer" />
          <AgentLaunchButton
            label="Implement this"
            agentTargets={agentTargets ?? []}
            installed={installed ?? {}}
            newAgentLabel={`New agent on research/${entry.id}`}
            primaryTitle={(cli) =>
              `Start ${cli} on this research, in a worktree of its own`
            }
            onStart={(agentId) => onImplement(entry, agentId)}
            onSend={(target) => onSendImplement?.(target, entry)}
          />
        </div>
      )}
    </div>
  );
}
