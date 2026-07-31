// Research sidebar section: every finding this project has, grouped by where it
// is between "someone asked" and "it shipped".
//
// The grouping is the whole design. A flat list of research answers "what have
// we looked at"; grouped by status it answers the two questions people actually
// have — what is waiting on me, and what did we find out that nobody has acted
// on yet. `researched` is the group that did not exist anywhere before this
// module: findings with nothing built from them, which is exactly the pile that
// used to evaporate.
//
// Rows carry the digest and nothing longer. That is the same tier rule the
// store enforces on agents, applied to the human: a panel is for choosing what
// to open, and a paragraph is enough to choose with.
import { useEffect, useState } from "react";
import * as ipc from "../ipc";
import {
  ACTIVE_STATUSES,
  RESEARCH_EVENT,
  STATUS_BLURBS,
  STATUS_LABELS,
  STATUS_ORDER,
  cached,
  refresh,
  watchStore,
} from "../research";
import { ago } from "./ProjectView/helpers";
import { ResearchIcon } from "./icons";
import { Button, TextInput } from "./ui";

interface ResearchPanelProps {
  projectId: string;
  /** Open an entry as a tab — every row leads somewhere native. */
  onOpen: (entry: ipc.ResearchSummary) => void;
  /** Start a fresh research run on a question the user types here. */
  onStart: (question: string) => void;
  /** Whether an agent CLI is available to run one. */
  canStart: boolean;
}

export function ResearchPanel({
  projectId,
  onOpen,
  onStart,
  canStart,
}: ResearchPanelProps) {
  const [rows, setRows] = useState<ipc.ResearchSummary[]>(() => cached(projectId));
  const [question, setQuestion] = useState("");
  const [showClosed, setShowClosed] = useState(false);

  useEffect(() => {
    const sync = () => setRows(cached(projectId));
    window.addEventListener(RESEARCH_EVENT, sync);
    // Agents write through MCP, which never reaches the store module — without
    // this the panel would show whatever existed when it mounted.
    watchStore();
    void refresh(projectId);
    return () => window.removeEventListener(RESEARCH_EVENT, sync);
  }, [projectId]);

  // Archived and superseded are fetched only when asked for: the panel is a
  // worklist, and a closed record on it is one more thing to read past.
  const [closed, setClosed] = useState<ipc.ResearchSummary[]>([]);
  useEffect(() => {
    if (!showClosed) return;
    let live = true;
    void ipc
      .researchList(projectId, ["archived", "superseded"], 50)
      .then((r) => live && setClosed(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [showClosed, projectId, rows]);

  const all = showClosed ? [...rows, ...closed] : rows;
  const groups = STATUS_ORDER.map((status) => ({
    status,
    entries: all.filter((r) => r.status === status),
  })).filter((g) => g.entries.length > 0);

  const submit = () => {
    const q = question.trim();
    if (!q || !canStart) return;
    onStart(q);
    setQuestion("");
  };

  return (
    <div className="side-panel research-panel">
      <div className="research-new">
        <TextInput
          className="research-input"
          size="sm"
          width="full"
          placeholder="Research a question…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <Button
          disabled={!question.trim() || !canStart}
          onClick={submit}
          title={
            canStart
              ? "Start an agent on this question. It records the finding and changes no code."
              : "No agent CLI installed"
          }
          size="sm">
          Research
        </Button>
      </div>

      {all.length === 0 && (
        <p className="tree-empty">
          No research yet. Ask a question above, or type one into ⌘K and pick
          “Research”. Anything an agent finds out lands here instead of in a
          file that disappears.
        </p>
      )}

      {groups.map((g) => (
        <section key={g.status} className="research-group">
          <h4 className="research-state-head" title={STATUS_BLURBS[g.status]}>
            {STATUS_LABELS[g.status]}
            <span className="badge">{g.entries.length}</span>
          </h4>
          <ul className="research-rows">
            {g.entries.map((e) => (
              <li key={e.id}>
                <button
                  className="research-row"
                  onClick={() => onOpen(e)}
                  title={e.digest || e.title}
                >
                  <ResearchIcon size={13} className="research-row-mark" />
                  <span className="research-row-num">{e.id.split("-")[0]}</span>
                  <span className="research-row-title">{e.title}</span>
                  <span className="research-row-age">{ago(e.updated_at)}</span>
                  {e.digest && (
                    <span className="research-row-digest">{e.digest}</span>
                  )}
                  <span className="research-row-facts">
                    {/* What a row is worth knowing before opening it: whether
                        anything shipped, and how much is behind it. */}
                    {e.pr_count > 0 && (
                      <span title={`${e.pr_count} linked pull request(s)`}>
                        ⇅ {e.pr_count}
                      </span>
                    )}
                    {e.source_count > 0 && (
                      <span title={`${e.source_count} source capture(s)`}>
                        ▤ {e.source_count}
                      </span>
                    )}
                    {e.superseded_by && (
                      <span title={`Superseded by ${e.superseded_by}`}>
                        superseded
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <button className="research-more" onClick={() => setShowClosed((v) => !v)}>
        {showClosed ? "Hide archived & superseded" : "Show archived & superseded"}
      </button>
    </div>
  );
}

/** Statuses the panel loads by default — exported so the caller's prefetch and
 *  this component cannot drift apart. */
export const PANEL_STATUSES = ACTIVE_STATUSES;
