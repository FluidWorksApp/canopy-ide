// An issue opened as a tab: the ticket read natively instead of bouncing to
// a browser. Header (id, title, status, priority, assignee) over the
// markdown description, with the start-work actions pinned to the bottom —
// the two things you do with a ticket you're reading are understand it and
// hand it to an agent.
import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as ipc from "../ipc";
import { heldBadge } from "../branchSwitch";
import { useBranchSwitch } from "../useBranchSwitch";
import { TRACKERS, trackerKey } from "../trackers";
import { AgentLaunchButton } from "./AgentLaunchButton";
import { Markdown } from "./Markdown";
import { TrackerIcon } from "./icons";
import type { AgentTarget } from "./TicketsPanel";
import { Button, Select } from "./ui";

interface TicketViewProps {
  ticket: ipc.TicketInfo;
  /** Which tracker it came from (registry id). */
  source: string;
  /** The repository the ticket's work lives in — what "open it there" needs to
   *  know which project's files to point. Absent until the owner resolves it,
   *  in which case the workspace chip stays a label. */
  repo?: string | null;
  /** The worktree already holding this ticket's work, if any. */
  worktree: ipc.WorktreeInfo | undefined;
  /** Agent terminals open in this project — the "send it there" targets. */
  agentTargets: AgentTarget[];
  /** Which agent CLIs are on PATH. */
  installed: Record<string, boolean>;
  /** Start a fresh agent on this ticket in its worktree. */
  onStartNew: (agentId: string) => void;
  /** Run the ticket as a one-shot task in its worktree. The promise settles
   *  when the launch has been accepted or refused — it is what keeps the
   *  button honest about being mid-submit. */
  onStartTask: () => void | Promise<unknown>;
  /** A task for this ticket is running right now — the button reflects it
   *  instead of offering to start a second one. */
  taskRunning?: boolean;
  /** Open the Tasks panel, where the running task reports. */
  onShowTasks?: () => void;
  onSendToAgent: (target: AgentTarget) => void;
}

export function TicketView({
  ticket,
  source,
  repo,
  worktree,
  agentTargets,
  installed,
  onStartNew,
  onStartTask,
  taskRunning,
  onShowTasks,
  onSendToAgent,
}: TicketViewProps) {
  const trackerName = TRACKERS.find((t) => t.id === source)?.name ?? source;
  const { openThere } = useBranchSwitch();
  const number = Number(ticket.id.replace(/^#/, ""));
  const github = source === "github" && !!repo && Number.isInteger(number);
  const linearKey = source === "linear" ? trackerKey("linear") : "";
  const canManage = github || !!linearKey;
  const [detail, setDetail] = useState<ipc.IssueDetail | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Submitting a task means a worktree switch and a spawn — seconds during
  // which a stateless button reads as a dead click.
  const [startingTask, setStartingTask] = useState(false);
  const taskState = startingTask ? "starting" as const : taskRunning ? "running" as const : undefined;
  const startTask = () => {
    if (startingTask) return;
    setStartingTask(true);
    void Promise.resolve(onStartTask()).finally(() => setStartingTask(false));
  };

  const loadDetail = async () => {
    if (!canManage) return;
    setError("");
    try {
      setDetail(
        github && repo
          ? await ipc.ghIssueDetail(repo, number)
          : await ipc.linearIssueDetail(linearKey, ticket.id),
      );
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void loadDetail();
    // Reload when a different issue is placed in this tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, source, number, ticket.id]);

  const setOpen = async (open: boolean) => {
    if (!repo || busy) return;
    setBusy(true);
    setError("");
    try {
      await ipc.ghIssueSetState(repo, number, open);
      setDetail((prev) => prev && { ...prev, state: open ? "open" : "closed" });
      window.dispatchEvent(new CustomEvent("canopy:trackers-changed"));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const setLinearState = async (stateId: string) => {
    if (!detail || busy) return;
    const next = detail.states.find((state) => state.id === stateId);
    setBusy(true);
    setError("");
    try {
      await ipc.linearIssueSetState(linearKey, detail.internal_id, stateId);
      setDetail({ ...detail, state_id: stateId, state: next?.name ?? detail.state });
      window.dispatchEvent(new CustomEvent("canopy:trackers-changed"));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitComment = async () => {
    if (!detail || busy || !comment.trim()) return;
    setBusy(true);
    setError("");
    try {
      if (github && repo) await ipc.ghIssueComment(repo, number, comment.trim());
      else await ipc.linearIssueComment(linearKey, detail.internal_id, comment.trim());
      setComment("");
      await loadDetail();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const formatDate = (value: string) =>
    value ? new Date(value).toLocaleString() : "Unknown date";

  // Link clicks are delegated globally (main.tsx), so every surface —
  // issue bodies, commit messages, PR text — behaves identically.

  return (
    <div className="ticket-view">
      <div className="ticket-view-head">
        <div className="ticket-view-title">
          <TrackerIcon id={source} size={15} className="ticket-view-mark" />
          <span className="ticket-view-id">{ticket.id}</span>
          <span>{ticket.title}</span>
        </div>
        <div className="ticket-view-meta">
          <span className="ticket-view-state">{detail?.state ?? ticket.state}</span>
          {ticket.priority && <span className="ticket-view-chip">{ticket.priority}</span>}
          <span className={ticket.mine ? "ticket-mine" : ""}>
            {ticket.mine ? "you" : (ticket.assignee ?? "Unassigned")}
          </span>
          {detail && (
            <>
              <span>opened by {detail.author}</span>
              <span title={formatDate(detail.created_at)}>
                created {formatDate(detail.created_at)}
              </span>
              <span title={formatDate(detail.updated_at)}>
                updated {formatDate(detail.updated_at)}
              </span>
            </>
          )}
          {/* The workspace holding this ticket's work. Seeing which one has it
              and having no way to get there was the gap; the words are the
              shared badge's, so this reads the same as every other surface. */}
          {worktree &&
            (repo && !worktree.is_main ? (
              <button
                className="ticket-wt"
                title={`${heldBadge(worktree).label}\n${worktree.path}\n\nClick to open it there.`}
                onClick={() => void openThere(repo, worktree.path, worktree.branch)}
              >
                ⑂ {worktree.branch}
                {worktree.dirty > 0 ? ` ±${worktree.dirty}` : ""}
              </button>
            ) : (
              <span
                className="ticket-wt"
                title={`${heldBadge(worktree).label}\n${worktree.path}`}
              >
                ⑂ {worktree.branch}
                {worktree.dirty > 0 ? ` ±${worktree.dirty}` : ""}
              </span>
            ))}
          <span className="status-spacer" />
          <Button onClick={() => void openUrl(ticket.url)}>
            Open in {trackerName}
          </Button>
        </div>
      </div>

      <div className="ticket-view-scroll">
        {/* `external` on purpose: an issue body is authored by anyone who can
            file on the repo, so it renders identically to a note and navigates
            nothing. */}
        {ticket.body.trim() ? (
          <Markdown className="ticket-view-body" text={ticket.body} />
        ) : (
          <p className="ticket-view-empty">No description.</p>
        )}

        {detail && (
          <section className="ticket-comments" aria-label="Comments">
            <h2>Comments <span>{detail.comments.length}</span></h2>
            {detail.comments.length === 0 ? (
              <p className="ticket-view-empty">No comments yet.</p>
            ) : (
              detail.comments.map((item) => (
                <article className="ticket-comment" key={item.id || item.url}>
                  <div className="ticket-comment-meta">
                    <strong>{item.author}</strong>
                    <span title={formatDate(item.created_at)}>{formatDate(item.created_at)}</span>
                  </div>
                  <Markdown className="ticket-comment-body" text={item.body} />
                </article>
              ))
            )}
            <textarea
              className="ticket-comment-input"
              rows={3}
              placeholder="Add a comment"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
            <div className="ticket-comment-actions">
              <Button disabled={busy || !comment.trim()} onClick={() => void submitComment()}>
                {busy ? "Working…" : "Comment"}
              </Button>
            </div>
          </section>
        )}
        {error && <p className="ticket-view-error">{error}</p>}
      </div>

      <div className="ticket-view-actions">
        {/* Explainer on the left, actions pushed to the right edge — the same
            shape as the header row above and every dialog footer. */}
        <span className="ticket-view-note">
          {taskState === "running"
            ? "Working on this ticket in the background — it reports back in Tasks."
            : taskState === "starting"
              ? "Preparing the worktree and starting the agent…"
              : "Runs in the background and reports back in Tasks. No commit, no PR — that stays yours to do."}
        </span>
        {canManage && (
          github ? (
            <Button disabled={busy || !detail} onClick={() => void setOpen(detail?.state === "closed")}>
              {detail?.state === "closed" ? "Reopen issue" : "Close issue"}
            </Button>
          ) : (
            <label className="ticket-state-control">
              <span>Status</span>
              <Select
                size="sm"
                width="sm"
                aria-label="Issue status"
                disabled={busy || !detail}
                value={detail?.state_id ?? ""}
                onChange={(event) => void setLinearState(event.target.value)}
              >
                {detail?.states.map((state) => (
                  <option key={state.id} value={state.id}>{state.name}</option>
                ))}
              </Select>
            </label>
          )
        )}
        {/* One control: the primary action is the obvious thing (your default
            agent, in this ticket's worktree); the caret is where every other
            choice lives — running agents to hand it to, or a different CLI. */}
        <AgentLaunchButton
          label="Start work"
          agentTargets={agentTargets}
          installed={installed}
          newAgentLabel={worktree ? `New agent in ${worktree.branch}` : "New agent in a new worktree"}
          primaryTitle={(cli) =>
            `Start ${cli} (your default) on this ticket${
              worktree ? ` in ${worktree.branch}` : " in a new worktree"
            }`
          }
          onStart={onStartNew}
          onSend={onSendToAgent}
          primaryTask={{
            title: "Start this ticket as a one-shot task",
            onRun: startTask,
            state: taskState,
            onShow: onShowTasks,
          }}
        />
      </div>
    </div>
  );
}
