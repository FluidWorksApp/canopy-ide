// The window's agent inbox (agentInbox.ts), wired to the team sessions, the
// terminals and the agents' states. Started once by App.
import * as ipc from "../ipc";
import { agentLife, subscribeAgentLives } from "../agentLifeRegistry";
import { createAgentInbox } from "./agentInbox";
import { recordAgentDelivery } from "./agentRouting";
import { agentTagOf } from "./chatEvents";
import { subscribeAgentStatus, subscribeTeamMessages, teamSession } from "./session";
import { teamName } from "./unread";

/** How often waiting messages are re-checked, besides on every state change. */
const FLUSH_MS = 3_000;

export function startAgentInbox(): () => void {
  /** Output silence per terminal, from the last read of the terminals: the
   *  state of an agent no open project has published (a pane or child agent
   *  outside the tabs, a hookless CLI) is judged by it. */
  const quiet = new Map<number, number | null>();
  const inbox = createAgentInbox({
    agents: async () =>
      (await ipc.ptyStats())
        .filter((s) => s.agent_hint)
        .flatMap((s) => {
          quiet.set(s.id, s.quiet_ms);
          // An agent signs its messages with its session name (agentOps
          // `agentLabel`); a title is the fallback the chat hand-off shows.
          const names = [...new Set([s.name, s.title].filter((n): n is string => !!n?.trim()))];
          return names.map((name) => ({ ptyId: s.id, name }));
        }),
    life: (ptyId) => agentLife(ptyId) ?? (quiet.has(ptyId) ? { state: "unknown", quietMs: quiet.get(ptyId) ?? null } : undefined),
    deliver: async (ptyId, text, messageId) =>
      ipc.deliverTeamAgentMessage(ptyId, await ipc.instanceId(), messageId, text),
    report: (team, user, sender, messageId, agent, state) =>
      teamSession(team, user).sendAgentStatus(sender, messageId, agent, state),
  });
  const offMessages = subscribeTeamMessages((event) => {
    const { team, user, message } = event;
    const session = teamSession(team, user);
    const senderName = event.senderName || session.members()[message.sender] || "A teammate";
    void inbox.receive({
      team,
      user,
      message,
      senderName,
      where: message.recipient === null ? `#${teamName(team) ?? "team"}` : `direct message with ${senderName}`,
      messages: session.getSnapshot().messages,
    });
  });
  // What a teammate's Canopy says happened to a message written for their agent.
  // Only from the account the message was for: no one else's Canopy speaks for that agent.
  const offStatus = subscribeAgentStatus(({ team, user, sender, event }) => {
    const message = teamSession(team, user).getSnapshot().messages.find((m) => m.id === event.target);
    if (!message || message.sender !== user || agentTagOf(message)?.to?.owner !== sender) return;
    recordAgentDelivery(event.target, { agent: event.agent, state: event.state, by: sender, at: Date.now() });
  });
  const offLives = subscribeAgentLives(() => void inbox.flush());
  const timer = window.setInterval(() => void inbox.flush(), FLUSH_MS);
  return () => {
    offMessages();
    offStatus();
    offLives();
    window.clearInterval(timer);
  };
}
