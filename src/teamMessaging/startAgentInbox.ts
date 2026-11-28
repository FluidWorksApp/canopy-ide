// The window's agent inbox (agentInbox.ts), wired to the team sessions, the
// terminals and the agents' states. Started once by App.
import * as ipc from "../ipc";
import { agentLife, subscribeAgentLives } from "../agentLifeRegistry";
import { createAgentInbox } from "./agentInbox";
import { recordAgentDelivery } from "./agentRouting";
import { subscribeAgentStatus, subscribeTeamMessages, teamSession } from "./session";
import { teamName } from "./unread";

/** How often waiting messages are re-checked, besides on every state change. */
const FLUSH_MS = 3_000;

export function startAgentInbox(): () => void {
  const inbox = createAgentInbox({
    agents: async () =>
      (await ipc.ptyStats())
        .filter((s) => s.agent_hint)
        .flatMap((s) => {
          // An agent signs its messages with its session name (agentOps
          // `agentLabel`); a title is the fallback the chat hand-off shows.
          const names = [...new Set([s.name, s.title].filter((n): n is string => !!n?.trim()))];
          return names.map((name) => ({ ptyId: s.id, name }));
        }),
    life: agentLife,
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
  const offStatus = subscribeAgentStatus(({ sender, event }) =>
    recordAgentDelivery(event.target, { agent: event.agent, state: event.state, by: sender, at: Date.now() }),
  );
  const offLives = subscribeAgentLives(() => void inbox.flush());
  const timer = window.setInterval(() => void inbox.flush(), FLUSH_MS);
  return () => {
    offMessages();
    offStatus();
    offLives();
    window.clearInterval(timer);
  };
}
