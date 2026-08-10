import type * as ipc from "./ipc";
import type { WorkflowTriggerProvenance } from "./workflowDefinition";

export type IssueWorkflowKind = Extract<
  WorkflowTriggerProvenance["kind"],
  | "issue.opened"
  | "issue.updated"
  | "issue.closed"
  | "issue.reopened"
  | "issue.comment"
>;

export interface IssueWorkflowSource {
  source: string;
  repo: string;
  ticket: ipc.TicketInfo;
}

const terminal = (ticket: ipc.TicketInfo) =>
  ["closed", "completed", "canceled", "cancelled"].includes(
    ticket.state_type.toLowerCase(),
  );

const payloadFor = ({ source, repo, ticket }: IssueWorkflowSource) => ({
  source,
  repo,
  issueId: ticket.id,
  title: ticket.title,
  url: ticket.url,
  state: ticket.state,
  stateType: ticket.state_type,
  assignee: ticket.assignee,
  priority: ticket.priority,
  updatedAt: ticket.updated_at ?? "",
});

export function issueWorkflowEvent(
  kind: IssueWorkflowKind,
  issue: IssueWorkflowSource,
  extra: Record<string, unknown> = {},
  eventId: string = crypto.randomUUID(),
  occurredAt = Date.now(),
): WorkflowTriggerProvenance {
  return {
    kind,
    eventId,
    occurredAt,
    payload: { ...payloadFor(issue), ...extra },
  };
}

/** Compare two successful observations from one provider. The first fetch is
 * retained as a baseline by the caller and never passed here, so opening the
 * Issues surface cannot replay the provider's entire history. */
export function diffIssueWorkflowEvents(
  previous: readonly ipc.TicketInfo[],
  current: readonly ipc.TicketInfo[],
  source: string,
  repo: string,
  occurredAt = Date.now(),
): WorkflowTriggerProvenance[] {
  const before = new Map(previous.map((ticket) => [ticket.id, ticket]));
  const after = new Map(current.map((ticket) => [ticket.id, ticket]));
  const events: WorkflowTriggerProvenance[] = [];

  for (const ticket of current) {
    const old = before.get(ticket.id);
    const issue = { source, repo, ticket };
    if (!old) {
      events.push(issueWorkflowEvent("issue.opened", issue, {}, undefined, occurredAt));
      continue;
    }
    const wasTerminal = terminal(old);
    const isTerminal = terminal(ticket);
    if (!wasTerminal && isTerminal) {
      events.push(issueWorkflowEvent("issue.closed", issue, {}, undefined, occurredAt));
      continue;
    }
    if (wasTerminal && !isTerminal) {
      events.push(issueWorkflowEvent("issue.reopened", issue, {}, undefined, occurredAt));
      continue;
    }
    if (
      old.updated_at !== ticket.updated_at ||
      old.title !== ticket.title ||
      old.body !== ticket.body ||
      old.state !== ticket.state ||
      old.state_type !== ticket.state_type ||
      old.assignee !== ticket.assignee ||
      old.priority !== ticket.priority
    ) {
      events.push(issueWorkflowEvent("issue.updated", issue, {}, undefined, occurredAt));
    }
  }

  // Linear omits completed/cancelled issues from its active list. A row that
  // disappears after a successful refresh is therefore a close event. GitHub
  // returns all states, so deletion is the only other case and still deserves
  // a terminal event rather than silently losing workflow provenance.
  for (const ticket of previous) {
    if (after.has(ticket.id) || terminal(ticket)) continue;
    events.push(issueWorkflowEvent(
      "issue.closed",
      { source, repo, ticket },
      { state: "closed", stateType: "closed", inferred: true },
      undefined,
      occurredAt,
    ));
  }

  return events;
}
