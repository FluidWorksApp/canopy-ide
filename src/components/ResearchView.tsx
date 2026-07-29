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
import { useCallback, useEffect, useMemo, useState } from "react";
import { renderMarkdown } from "../markdown";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as ipc from "../ipc";
import {
  NEXT_STATUSES,
  RESEARCH_EVENT,
  STATUS_BLURBS,
  STATUS_LABELS,
  STATUS_STEP,
  remove as removeResearch,
  setStatus,
} from "../research";
import { ago } from "./ProjectView/helpers";
import { TaskProgress } from "./TaskProgress";
import { RESEARCH_STEPS, stepsDone } from "../microTasks";

interface ResearchViewProps {
  projectId: string;
  researchId: string;
  /** Hand this entry to an agent to build. Absent while no CLI is installed. */
  onImplement?: (entry: ipc.ResearchDetail) => void;
  /** Reopen the question with a fresh agent, carrying the entry. */
  onContinue?: (entry: ipc.ResearchDetail) => void;
  /** Follow a link out to the thing it points at, natively. */
  onOpenPr?: (pr: ipc.ResearchPrLink) => void;
  onOpenFile?: (path: string) => void;
  onClosed?: () => void;
  onNotice?: (text: string, level?: "info" | "error") => void;
}

export function ResearchView({
  projectId,
  researchId,
  onImplement,
  onContinue,
  onOpenPr,
  onOpenFile,
  onClosed,
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
    return () => window.removeEventListener(RESEARCH_EVENT, load);
  }, [load]);

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

  const html = useMemo(
    () =>
      entry?.body.trim()
        ? renderMarkdown(entry.body)
        : "<p class='research-empty'>Nothing written up yet.</p>",
    [entry?.body],
  );

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
          <span>{entry.title}</span>
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
            <div
              className="research-md markdown-body"
              dangerouslySetInnerHTML={{ __html: html }}
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

      <div className="research-actions">
        {/* Implementing is the point of a finished finding, so it leads — and
            only when the state machine actually allows the move. */}
        {moves.includes("implementing") && onImplement && (
          <button className="btn btn-primary" onClick={() => onImplement(entry)}>
            Implement this
          </button>
        )}
        {onContinue && (
          <button className="btn" onClick={() => onContinue(entry)}>
            Continue research
          </button>
        )}
        {moves
          .filter((m) => m !== "implementing" && m !== "archived")
          .map((m) => (
            <button
              key={m}
              className="btn"
              title={STATUS_BLURBS[m]}
              onClick={() => move(m)}
            >
              Mark {STATUS_LABELS[m].toLowerCase()}
            </button>
          ))}
        <span className="status-spacer" />
        {moves.includes("archived") && (
          <button className="btn" title={STATUS_BLURBS.archived} onClick={() => move("archived")}>
            Archive
          </button>
        )}
        <button className="btn btn-danger" onClick={del} title={`Deletes ${entry.dir}`}>
          Delete
        </button>
      </div>
    </div>
  );
}
