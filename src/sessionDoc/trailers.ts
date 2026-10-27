// Session provenance on commits: an `Agent-Session:` trailer for each agent
// session whose edits a commit includes.
//
// Which session wrote which lines is already known precisely — every edit tool
// call lands in that session's change journal (`agent_edits`), attributed even
// on a checkout several agents share — but it lives on one machine and dies
// with it. A git trailer carries it into history, where a reviewer (or a
// future `git log --grep`) can follow a line back to the conversation that
// produced it. Off by default (`commitSessionTrailers`): it changes what
// lands in other people's history.
//
// Only sessions whose journaled text is still present in a staged file count.
// A session that touched the file and was then overwritten wrote none of the
// lines being committed.

import * as ipc from "../ipc";
import { getSettings } from "../settings";

export const TRAILER_KEY = "Agent-Session";

export interface TrailerSession {
  agent: string;
  sessionId: string;
}

export const trailerLine = (s: TrailerSession) => `${TRAILER_KEY}: ${s.agent}/${s.sessionId}`;

/** `message` with one trailer per session, in git's trailer block (a blank
 *  line, then `Key: value` lines). Sessions already named are not repeated,
 *  and an existing trailer block is extended rather than split. */
export function withSessionTrailers(message: string, sessions: readonly TrailerSession[]): string {
  const body = message.replace(/\s+$/, "");
  const fresh = sessions.map(trailerLine).filter((line, i, all) => all.indexOf(line) === i && !body.includes(line));
  if (!fresh.length || !body) return message;
  const lines = body.split("\n");
  const lastBlank = lines.lastIndexOf("");
  const tail = lastBlank >= 0 ? lines.slice(lastBlank + 1) : [];
  // The last paragraph is already a trailer block (Co-Authored-By: …) when
  // every line in it is `Token: value`; then the new lines join it.
  const isTrailerBlock =
    lastBlank > 0 && tail.length > 0 && tail.every((l) => /^[A-Za-z0-9][A-Za-z0-9-]*: \S/.test(l));
  return isTrailerBlock ? `${body}\n${fresh.join("\n")}\n` : `${body}\n\n${fresh.join("\n")}\n`;
}

export interface TrailerDeps {
  staged(repo: string): Promise<string[]>;
  digests(roots: string[]): Promise<ipc.SessionDigest[]>;
  edits(repo: string, sessionId: string): Promise<ipc.AgentEdit[]>;
  now(): number;
}

const ipcDeps: TrailerDeps = {
  staged: (repo) => ipc.gitRepoStatus(repo).then((s) => s.staged.map((f) => f.path)),
  digests: (roots) => ipc.sessionDigests(roots),
  edits: (repo, sid) => ipc.agentEdits(repo, sid),
  now: () => Date.now(),
};

/** Sessions looked at per commit, newest first — the journal read is per
 *  session, and a commit is waiting on this. */
const MAX_SESSIONS = 12;
/** A session idle longer than this did not write today's commit. */
const RECENT_SECS = 14 * 86_400;

const under = (dir: string | undefined, repo: string) => {
  if (!dir) return false;
  const a = dir.replace(/[\\/]+$/, "");
  const b = repo.replace(/[\\/]+$/, "");
  return a === b || a.startsWith(`${b}/`) || a.startsWith(`${b}\\`);
};

/** The sessions whose still-present edits are in the staged files. */
export async function sessionsInCommit(repo: string, deps: TrailerDeps = ipcDeps): Promise<TrailerSession[]> {
  const staged = new Set(await deps.staged(repo));
  if (!staged.size) return [];
  const cutoff = deps.now() / 1000 - RECENT_SECS;
  const candidates = (await deps.digests([repo]))
    .filter((d) => d.agent && (under(d.cwd, repo) || under(d.launch_cwd, repo)) && (d.updated ?? 0) >= cutoff)
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
    .slice(0, MAX_SESSIONS);
  const out: TrailerSession[] = [];
  for (const d of candidates) {
    const edits = await deps.edits(repo, d.session_id).catch(() => [] as ipc.AgentEdit[]);
    if (edits.some((e) => e.present && staged.has(e.path))) out.push({ agent: d.agent!, sessionId: d.session_id });
  }
  return out;
}

/** The message to commit with: unchanged when the setting is off or anything
 *  goes wrong — provenance must never be the reason a commit fails. */
export async function commitMessageWithSessions(
  repo: string,
  message: string,
  deps: TrailerDeps = ipcDeps,
): Promise<string> {
  if (!getSettings().commitSessionTrailers) return message;
  try {
    return withSessionTrailers(message, await sessionsInCommit(repo, deps));
  } catch {
    return message;
  }
}
