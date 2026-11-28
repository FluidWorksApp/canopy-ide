// Messages teammates write for this account's agents (agentRouting.ts), from
// arrival to the agent's terminal.
//
// The user chose that any teammate may address any of their running agents
// and that it reaches the agent without a click. What it does not do is
// interrupt: a message for an agent that is mid-turn waits until the turn
// ends, then is typed in. The sender is told each step (`agent-status`):
// queued, delivered, not running, or paused because agents have been
// answering each other with no person in between.
import type { ChatMessage } from "./client";
import type { AgentDeliveryState } from "./chatEvents";
import type { AgentLifeEntry } from "../agentLifeRegistry";
import { agentTagOf } from "./chatEvents";
import { agentAddressee, agentBrief, agentRunTooLong, recordAgentDelivery } from "./agentRouting";

export type InboxAgent = { ptyId: number; name: string };
export type InboxMessage = {
  team: string;
  user: string;
  message: ChatMessage;
  senderName: string;
  /** Where it was written, for the brief: "direct message with Ana", "#core". */
  where: string;
  /** The conversation's messages, for the run-of-agents check. */
  messages: readonly ChatMessage[];
};

export interface AgentInboxDeps {
  /** Agent sessions running in this window. */
  agents(): Promise<InboxAgent[]>;
  life(ptyId: number): AgentLifeEntry | undefined;
  /** Type `text` into the agent's terminal; `messageId` is the chat message's. */
  deliver(ptyId: number, text: string, messageId: string): Promise<unknown>;
  /** Tell the sender what happened. */
  report(team: string, user: string, sender: string, messageId: string, agent: string, state: AgentDeliveryState): Promise<unknown>;
  now?: () => number;
}

/** A hookless CLI never reports a turn ending; this long without output counts as done. */
export const QUIET_READY_MS = 5_000;
/** After a delivery the agent's state still reads idle until its turn is
 *  seen starting; nothing more is typed into it for this long. */
export const DELIVERY_GAP_MS = 15_000;
/** A message nobody could deliver is dropped this long after it was written. */
export const QUEUE_TTL_MS = 6 * 3_600_000;

/** Whether an agent may be typed into now. "waiting" means a question or a
 *  permission prompt is open, which a message would answer by accident. */
export function readyFor(entry: AgentLifeEntry | undefined): boolean {
  if (!entry) return false;
  if (entry.state === "idle") return true;
  return (entry.state === "unknown" || entry.state === "starting") && (entry.quietMs ?? 0) >= QUIET_READY_MS;
}

type Queued = { item: InboxMessage; agent: InboxAgent; at: number };

export function createAgentInbox(deps: AgentInboxDeps) {
  const now = deps.now ?? Date.now;
  const queue: Queued[] = [];
  const handled = new Set<string>();
  const lastDelivery = new Map<number, number>();
  const free = (ptyId: number) => readyFor(deps.life(ptyId)) && now() - (lastDelivery.get(ptyId) ?? -Infinity) >= DELIVERY_GAP_MS;

  const tell = (item: InboxMessage, agent: string, state: AgentDeliveryState) => {
    const { team, user, message } = item;
    recordAgentDelivery(message.id, { agent, state, by: user, at: now() });
    void deps.report(team, user, message.sender, message.id, agent, state).catch(() => {});
  };

  const brief = (item: InboxMessage) =>
    agentBrief({
      sender: item.senderName,
      viaAgent: agentTagOf(item.message)?.from,
      where: item.where,
      text: item.message.text,
      messageId: item.message.id,
      files: item.message.attachments?.map((a) => a.name),
    });

  async function deliver(q: Queued) {
    await deps.deliver(q.agent.ptyId, brief(q.item), q.item.message.id);
    lastDelivery.set(q.agent.ptyId, now());
    tell(q.item, q.agent.name, "delivered");
  }

  /** A message just arrived. Resolves once it is delivered, queued or refused. */
  async function receive(item: InboxMessage): Promise<void> {
    const name = agentAddressee(item.message, item.user);
    if (!name || handled.has(item.message.id)) return;
    handled.add(item.message.id);
    if (handled.size > 2000) handled.delete(handled.values().next().value!);
    if (agentRunTooLong(item.messages, item.message)) return tell(item, name, "paused");
    if (now() - item.message.created > QUEUE_TTL_MS) return tell(item, name, "gone");
    const agent = (await deps.agents()).find((a) => a.name.trim().toLowerCase() === name.toLowerCase());
    if (!agent) return tell(item, name, "missing");
    // From when it was written: a message that arrives days late (backfill)
    // is not typed into an agent as if it were new.
    const q = { item, agent, at: Math.min(now(), item.message.created) };
    if (free(agent.ptyId) && !queue.some((w) => w.agent.ptyId === agent.ptyId)) {
      try {
        return await deliver(q);
      } catch {
        /* Gone between the check and the write: queue and try again. */
      }
    }
    queue.push(q);
    tell(item, agent.name, "queued");
  }

  let flushing = false;
  /** Deliver whatever is waiting for an agent that has now finished its turn. */
  async function flush(): Promise<void> {
    if (flushing || !queue.length) return;
    flushing = true;
    try {
      const running = new Set((await deps.agents()).map((a) => a.ptyId));
      for (const q of [...queue]) {
        const gone = !running.has(q.agent.ptyId), stale = now() - q.at > QUEUE_TTL_MS;
        if (gone || stale) {
          queue.splice(queue.indexOf(q), 1);
          tell(q.item, q.agent.name, "gone");
          continue;
        }
        // One message per agent per turn: the next waits for this one's answer.
        if (!free(q.agent.ptyId)) continue;
        queue.splice(queue.indexOf(q), 1);
        try {
          await deliver(q);
        } catch {
          queue.unshift(q);
          lastDelivery.set(q.agent.ptyId, now());
        }
      }
    } finally {
      flushing = false;
    }
  }

  return { receive, flush, pending: () => queue.length };
}
