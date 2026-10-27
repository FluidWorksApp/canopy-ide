// Wiring for live sessions: the one room registry this window holds, the
// transport both sides use (the team chat sessions already running), and the
// cloud workspace terminal a room can show.
import { useSyncExternalStore } from "react";
import { liveTeamSessions, subscribeLiveEvents } from "../teamMessaging/session";
import { onAgentTurnEnd, onAgentTurnStart } from "../agentTurns";
import { activeWorkspace } from "../remoteExecution/workspace";
import type { LiveOp, LiveTurn } from "../teamMessaging/liveEvents";
import { openShareDialog, repoRefFor } from "../shareCards";
import { basename } from "../paths";
import { cleanLine, LIMITS, type LiveSessionCard } from "../teamMessaging/cardSchema";
import type { LiveJoin } from "../sessionDoc/events";
import { LiveRooms, shownFile, type Room } from "./rooms";
import { LiveGuest } from "./guest";

const sessionFor = (team: string) => liveTeamSessions().find((s) => s.team === team);

export async function sendLive(team: string, peer: string, room: string, op: LiveOp, reachAll = false): Promise<number> {
  const session = sessionFor(team);
  if (!session) throw new Error("Not signed in to that team on this computer.");
  return session.sendLive(peer, room, op, reachAll);
}

export const liveRooms = new LiveRooms({
  send: (team, peer, room, op) => sendLive(team, peer, room, op),
  members: (team) => sessionFor(team)?.members() ?? null,
  now: () => Date.now(),
});

/** The rooms this window holds, for a component. */
export function useLiveRooms(rooms: LiveRooms = liveRooms): Room[] {
  return useSyncExternalStore(rooms.subscribe, rooms.getSnapshot);
}

/** This account's id in a team, when this Canopy is in it. */
export const selfIn = (team: string) => sessionFor(team)?.user ?? null;
/** The first team this Canopy is signed in to, for a room shown only through
 *  a shared terminal. */
export const anyTeam = () => liveTeamSessions()[0]?.team ?? null;

/** App calls this once: rooms hear joiners and the agent's turns. */
export function startLiveRooms(): () => void {
  const stops = [
    subscribeLiveEvents((e) => liveRooms.handle(e)),
    onAgentTurnStart((t) => liveRooms.turnStarted(t.sessionId, t.prompt, t.startedAt)),
    onAgentTurnEnd((t) => liveRooms.turnEnded(t.sessionId, t.lastMessage, t.filesTouched, t.endedAt)),
  ];
  const timer = setInterval(() => liveRooms.prune(), 30_000);
  return () => {
    clearInterval(timer);
    stops.forEach((fn) => fn());
  };
}

export function joinLive(join: LiveJoin): LiveGuest {
  return new LiveGuest(join, { send: sendLive, subscribe: subscribeLiveEvents, now: () => Date.now() });
}

/** A session document's turns as a joiner first sees them. */
export function seedTurns(turns: { n: number; prompt: string; files: string[]; startedAt: number | null }[]): LiveTurn[] {
  return turns
    .filter((t) => t.prompt.trim())
    .slice(-12)
    .map((t) => ({
      id: `doc:${t.n}`,
      at: t.startedAt ?? 0,
      kind: "prompt" as const,
      text: [...t.prompt.trim()].slice(0, 1500).join(""),
      ...(t.files.length ? { files: t.files.slice(0, 12).map(shownFile).filter(Boolean) } : {}),
    }));
}

/** The project a cloud workspace terminal runs in, from its directory. */
export function workspaceProject(cwd: string): string | null {
  return /^\/workspace\/projects\/([^/]+)/.exec(cwd)?.[1] ?? null;
}

/** Shares the agent's terminal in this cloud workspace with the room, view
 *  only, through Shared sessions (the workspace checks each viewer's access).
 *  Only the workspace's owner can share a terminal. */
export async function shareTerminal(args: {
  room: string;
  ptyId: number;
  cwd: string;
  title: string;
}): Promise<{ workspace: string; publication: string; team: string }> {
  const host = activeWorkspace();
  if (!host) throw new Error("Showing the terminal needs a cloud workspace.");
  const projectId = workspaceProject(args.cwd);
  if (!projectId) throw new Error("This agent isn't running in one of the workspace's projects.");
  const room = liveRooms.room(args.room);
  const team = room?.audiences[0]?.team ?? anyTeam();
  const owner = team ? selfIn(team) : null;
  if (!team || !owner) throw new Error("Sign in to a Canopy team first.");
  const workspace = host.connection.workspaceId;
  const result = await host.client.workspace<{ sessions: { id: string; sessionId?: number; room?: { id: string } }[] }>(
    workspace,
    "/shared-sessions",
    {
      action: "publish",
      sessionId: args.ptyId,
      projectId,
      title: args.title.slice(0, 80),
      mode: "view",
      acknowledged: true,
      room: { id: args.room, owner, team },
    },
  );
  // A workspace on an older image shares the terminal without the room; the
  // room still tells its joiners where the terminal is.
  const publication = (
    result.sessions.find((p) => p.room?.id === args.room) ?? result.sessions.find((p) => p.sessionId === args.ptyId)
  )?.id;
  if (!publication) throw new Error("The workspace didn't share the terminal.");
  return { workspace, publication, team };
}

export async function stopSharingTerminal(publication: string): Promise<void> {
  const host = activeWorkspace();
  if (!host) return;
  await host.client.workspace(host.connection.workspaceId, "/shared-sessions", { action: "revoke", id: publication });
}

/** Ends a room for everyone watching, and stops showing its terminal. */
export async function endLiveRoom(id: string): Promise<void> {
  const publication = liveRooms.room(id)?.terminal?.publication;
  liveRooms.close(id);
  if (publication) await stopSharingTerminal(publication).catch(() => {});
}

export async function liveSessionCard(room: Room, cwd: string, repo?: string | null): Promise<LiveSessionCard> {
  const repoRef = repo ? await repoRefFor(repo).catch(() => undefined) : undefined;
  const dir = cwd ? cleanLine(basename(cwd), 200).replace(/[\\/]/g, "") : "";
  return {
    type: "live-session",
    v: 1,
    room: room.id,
    title: cleanLine(room.title, LIMITS.title) || "Agent session",
    agent: cleanLine(room.agent, 64) || "agent",
    ...(dir ? { dir } : {}),
    ...(repoRef ? { repo: repoRef } : {}),
  };
}

/** Opens the share dialog with the room's card; the conversation it goes to
 *  may then join. */
export function inviteToRoom(room: Room, cwd: string, repo?: string | null): void {
  void liveSessionCard(room, cwd, repo).then((card) =>
    openShareDialog({ kind: "share", card, onSent: (team, peer) => liveRooms.allow(room.id, { team, peer }) }),
  );
}
