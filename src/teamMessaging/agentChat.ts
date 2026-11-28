// Agents posting in the user's Teams chat (canopy_team_people, canopy_team_send).
//
// The message goes out through the same TeamSession the chat tab uses, so it
// is the user's account speaking, end-to-end encrypted, exactly as if they had
// typed it. Two things keep that honest: only an agent terminal can call it
// (the bridge checks), and every message carries a line naming the agent that
// wrote it, so the person reading it knows a person did not.
//
// Every message also carries `agent.from` (chatEvents.ts AgentTag), so the chat
// shows which agent spoke. `replyTo` answers in a message's thread, in that
// message's conversation; `agent` (or replying to a teammate's agent) addresses
// one of the recipient's agents, which their Canopy types into that agent's
// terminal once it is idle (agentInbox.ts). Otherwise the recipient chooses:
// hand it to one of their agents, or start a task on it (AccountChatView).

/** The slice of a TeamSession this module uses. */
import type { ChatMessage } from "./client";
import type { MessageExtensions } from "./messageSchema";
import { agentTagOf, validAgentName } from "./chatEvents";
import { threadRoot } from "./unread";

export interface ChatSession {
  readonly team: string;
  readonly user: string;
  members(): Record<string, string>;
  /** The messages this device has, for finding the one a reply answers. */
  messages(): readonly ChatMessage[];
  send(text: string, peer: string | null, ext?: MessageExtensions): Promise<{ id: string; delivery?: { state: string; detail?: string } }>;
}

export interface TeamPerson {
  id: string;
  name: string;
  email?: string;
  role?: string;
}

export interface AgentChatDeps {
  sessions: () => ChatSession[];
  teamName: (team: string) => string | undefined;
  /** A team's people with their emails (the account directory); the session
   *  only knows names. Null when it cannot be read right now. */
  people: (team: string) => Promise<TeamPerson[] | null>;
}

const CHANNEL = new Set(["channel", "everyone", "all", "team", "#channel"]);
const norm = (value: string) => value.trim().toLowerCase();

/** The line every agent-written message ends with. */
export function agentFooter(agent: string | null | undefined): string {
  const who = agent?.trim();
  return `— sent by ${who ? `agent ${who}` : "an agent"} from Canopy`;
}

export function createAgentChat(deps: AgentChatDeps) {
  async function roster(session: ChatSession): Promise<TeamPerson[]> {
    const known = await deps.people(session.team).catch(() => null);
    if (known?.length) return known;
    return Object.entries(session.members()).map(([id, name]) => ({ id, name }));
  }

  function pickSession(team: string | null | undefined): ChatSession {
    const sessions = deps.sessions();
    if (!sessions.length) {
      throw new Error("Not signed in to a Canopy team on this machine — sign in under Settings → Account, then try again.");
    }
    const wanted = team ? norm(team) : "";
    if (!wanted) return sessions[0];
    const match = sessions.find((s) => norm(s.team) === wanted || norm(deps.teamName(s.team) ?? "") === wanted);
    if (!match) {
      throw new Error(
        `No team called "${team}". Your teams: ${sessions.map((s) => deps.teamName(s.team) ?? s.team).join(", ")}`,
      );
    }
    return match;
  }

  /** Every team and the people in it, for an agent choosing whom to message. */
  async function people() {
    const sessions = deps.sessions();
    const teams = await Promise.all(
      sessions.map(async (s) => ({
        team: deps.teamName(s.team) ?? s.team,
        teamId: s.team,
        channel: "channel",
        people: (await roster(s)).filter((p) => p.id !== s.user).map(({ id, name, email }) => ({ id, name, ...(email ? { email } : {}) })),
      })),
    );
    return {
      teams,
      note: sessions.length
        ? "canopy_team_send({ to, text, team? }) with a person's name, email or id, or to: \"channel\" for the whole team. Pass team when there is more than one."
        : "Not signed in to a Canopy team on this machine, so there is nobody to message. The user can sign in under Settings → Account.",
    };
  }

  /** Resolve `to` within one team: "channel", or exactly one person. */
  async function recipient(session: ChatSession, to: string): Promise<{ peer: string | null; name: string }> {
    const wanted = norm(to);
    const teamLabel = deps.teamName(session.team) ?? session.team;
    if (CHANNEL.has(wanted) || wanted === norm(teamLabel) || wanted === `#${norm(teamLabel)}`) {
      return { peer: null, name: `#${teamLabel}` };
    }
    const everyone = (await roster(session)).filter((p) => p.id !== session.user);
    const exact = everyone.filter(
      (p) => norm(p.id) === wanted || norm(p.name) === wanted || (p.email && norm(p.email) === wanted),
    );
    // A first name ("vijay") is how people say it; accept it only when it is unambiguous.
    const loose = exact.length
      ? exact
      : everyone.filter((p) => norm(p.name).split(/[\s@.]+/)[0] === wanted || (p.email && norm(p.email).split("@")[0] === wanted));
    if (loose.length === 1) return { peer: loose[0].id, name: loose[0].name || loose[0].email || loose[0].id };
    const list = everyone.map((p) => (p.email && p.email !== p.name ? `${p.name} <${p.email}>` : p.name)).join(", ");
    if (loose.length > 1) {
      throw new Error(`"${to}" matches ${loose.length} people in ${teamLabel} — use an email or id: ${list}`);
    }
    if (norm(to) === norm(session.user)) throw new Error("That is the user themselves — use canopy_notify to reach them.");
    throw new Error(`Nobody called "${to}" in ${teamLabel}. People: ${list || "none yet"}. Or send to "channel".`);
  }

  /** The session and message `replyTo` names, among every team's. */
  function replied(id: string, team: string | null | undefined): { session: ChatSession; message: ChatMessage } {
    const sessions = team ? [pickSession(team)] : deps.sessions();
    for (const session of sessions) {
      const message = session.messages().find((m) => m.id === id);
      if (message) return { session, message };
    }
    throw new Error(`No message ${id} in the Teams chat on this machine. Use the id from the message you were given.`);
  }

  async function send(req: {
    to?: string | null;
    text: string;
    team?: string | null;
    /** This agent's name, for the footer and the `agent.from` tag. */
    agent?: string | null;
    /** A chat message id: answer in its thread, in its conversation. */
    replyTo?: string | null;
    /** One of the recipient's agents, by name: it gets the message. */
    toAgent?: string | null;
  }) {
    const text = (req.text ?? "").trim();
    if (!text) throw new Error("A message needs text.");
    if (!req.to?.trim() && !req.replyTo?.trim()) throw new Error("Say who it is for: a teammate from canopy_team_people, or \"channel\" — or replyTo a message.");
    let session: ChatSession, who: { peer: string | null; name: string }, thread: string | undefined, target: { name: string; owner: string } | undefined;
    if (req.replyTo?.trim()) {
      const found = replied(req.replyTo.trim(), req.team);
      session = found.session;
      const m = found.message;
      const peer = m.recipient === null ? null : m.sender === session.user ? m.recipient : m.sender;
      who = { peer, name: peer === null ? `#${deps.teamName(session.team) ?? session.team}` : session.members()[peer] ?? peer };
      const find = (id: string) => session.messages().find((x) => x.id === id);
      thread = threadRoot(m, find) ?? m.id;
      // Answering a teammate's agent answers that agent.
      const from = agentTagOf(m)?.from;
      if (from && m.sender !== session.user) target = { name: from, owner: m.sender };
    } else {
      session = pickSession(req.team);
      who = await recipient(session, req.to ?? "");
    }
    if (req.toAgent?.trim()) {
      const owner = who.peer;
      if (owner === null) throw new Error("To reach a teammate's agent, message that teammate directly (to: their name), not the channel.");
      target = { name: req.toAgent.trim(), owner };
    }
    // A session name that is not a valid tag (too long, odd characters) is
    // still in the footer; the message must not fail over a label.
    const name = req.agent?.trim();
    const from = name && validAgentName(name) ? name : undefined;
    const tag = from || target ? { agent: { ...(from ? { from } : {}), ...(target ? { to: target } : {}) } } : {};
    const sent = await session.send(`${text}\n\n${agentFooter(req.agent)}`, who.peer, { ...tag, ...(thread ? { thread: { root: thread } } : {}) });
    const state = sent.delivery?.state;
    return {
      messageId: sent.id,
      to: target ? `${target.name} (${session.members()[target.owner] ?? who.name}'s agent)` : who.name,
      team: deps.teamName(session.team) ?? session.team,
      ...(thread ? { thread } : {}),
      status: state === "failed" ? "failed" : state === "waiting" ? "waiting-for-connection" : "sent",
      ...(sent.delivery?.detail ? { detail: sent.delivery.detail } : {}),
      note:
        state === "failed"
          ? "Not sent; the user can retry it from the chat."
          : target
            ? `Posted in Teams as the user, for ${target.name}. Their Canopy types it into that agent's terminal once it finishes its turn; if it is not running, ${who.name} sees it in the chat. An answer that replies to this message arrives in this terminal.`
            : `Posted in Teams as the user, marked as written by an agent. ${who.peer ? `${who.name} sees it` : "Everyone in the team sees it"} in Canopy. A reply in this message's thread addressed to you arrives in this terminal; anything else stays in the user's chat.`,
    };
  }

  return { people, send };
}

export type AgentChat = ReturnType<typeof createAgentChat>;
