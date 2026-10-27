// Agents in cloud workspaces — this account's own and teammates' — that work
// on the same repository as a finishing agent, as overlap detection sees them.
//
// A cloud agent's checkout is on another machine, so "same repository" is
// decided by the origin remote, not by path: every clone of
// github.com/acme/api is the same repository wherever it lives. Its files come
// from the workspace service's roster (the host folds them from the agent's
// own hook events), already relative to its checkout.
import type { CloudRoster } from "./roster";
import type { PeerAgent } from "./overlap";

/** One spelling per repository: `git@github.com:Acme/api.git`,
 *  `https://user@github.com/acme/api` and `ssh://git@github.com/acme/api.git`
 *  are all `github.com/acme/api`. Null for anything that is not a remote. */
export function repoKey(url: string | null | undefined): string | null {
  let text = (url ?? "").trim();
  if (!text) return null;
  const scp = /^[^/@:]+@([^/:]+):(.+)$/.exec(text);
  if (scp) text = `${scp[1]}/${scp[2]}`;
  else {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(text);
    if (!m) return null;
    text = `${m[1]}/${m[2]}`;
  }
  const key = text.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
  return key.includes("/") ? key : null;
}

/** Cloud agents on `repo`, each carrying where to reach it. `exclude` names
 *  a workspace whose agents are already local peers (the one this IDE runs
 *  against). */
export function cloudPeersFor(rosters: CloudRoster[], repo: string, exclude?: string | null): PeerAgent[] {
  const peers: PeerAgent[] = [];
  for (const w of rosters) {
    if (!w.id || !w.online || !w.agents || (exclude && w.id === exclude)) continue;
    for (const a of w.agents) {
      if (repoKey(a.repo) !== repo || !a.root) continue;
      const files = (a.files ?? []).filter((f) => f && typeof f.path === "string" && f.path && !f.path.startsWith("/"));
      peers.push({
        sessionId: `cloud:${w.id}:${a.ptyId}`,
        ptyId: a.ptyId,
        cli: a.agent ?? "",
        cwd: a.root,
        name: `${a.name || a.agent || `terminal ${a.ptyId}`} in ${w.name}`,
        task: a.task,
        files: files.map((f) => f.path),
        recent: files.filter((f) => Number.isFinite(f.ts)).map((f) => ({ path: f.path, ts: f.ts })),
        claims: [],
        cloud: { workspace: w.id, workspaceName: w.name, root: a.root },
      });
    }
  }
  return peers;
}
