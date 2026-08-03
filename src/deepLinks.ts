// Where a notification goes when you click it.
//
// A native notification is raised by whichever part of the app noticed
// something — a micro-task reporting in, a teammate sending a file, an agent
// asking for help — and read minutes later, from another Space, by a user who
// no longer remembers which project it was about. Until now clicking one only
// raised the window: the app came forward showing whatever was last in front,
// and the notification's actual subject was left for the user to go find.
//
// So every notification carries a target, expressed as a URL:
//
//   canopy://terminal?pty=12&path=/Users/me/src/api   the agent's terminal
//   canopy://panel?name=tasks&path=/Users/me/src/api  a side panel
//   canopy://chat?peer=ab12                           a teammate's conversation
//   canopy://file?path=/Users/me/src/api/main.rs&line=40
//   canopy://note?note=0007-tier-donations&id=p1      one scratchpad note
//   canopy://pr?number=1341&path=/Users/me/src/api    a pull request's tab
//   canopy://project?id=p1                            the project itself
//   canopy://app                                      nothing in particular
//
// The note target is the one composed *outside* the app: a reminder's launchd
// job holds it in a plist and hands it to a Canopy that may not be running yet
// (remind.rs, cli.rs). That is the case the scheme shape was always for, and
// it is why the parser has to be as forgiving about where the string came from
// as it is strict about what the string says.
//
// URLs rather than a bag of fields because a deep link has to survive leaving
// the process: it goes out to the OS with the notification and comes back as a
// string, and `canopy 'canopy://…'` routes through the same parser (cli.rs).
// The scheme is not registered with the OS yet — see `link_from_args` — but
// nothing in the routing assumes where the string came from.
//
// Every target is a *hint*, never a guarantee. The terminal may have exited,
// the project may have been removed. `routeDeepLink` (App.tsx) walks a fallback
// chain — exact surface, then its project, then the window — so a click always
// lands somewhere honest instead of failing silently.

import type { SideTab } from "./components/ProjectView/helpers";

const SIDE_TABS: readonly SideTab[] = [
  "files",
  "servers",
  "changes",
  "git",
  "prs",
  "trackers",
  "tasks",
  "research",
  "agents",
  "team",
  "tools",
];

/** Hints for finding the project a target belongs to. Both are optional and
 *  both can be wrong (a project closed since the notification went out); the
 *  router tries `projectId` first, then containment of `path`. */
export interface ProjectHint {
  projectId?: string;
  /** Any path inside the project — a component root, an agent's cwd, a file. */
  path?: string;
}

export type DeepLink =
  | ({ kind: "app" } & ProjectHint)
  | ({ kind: "project" } & ProjectHint)
  | ({ kind: "terminal"; ptyId: number } & ProjectHint)
  | ({ kind: "panel"; panel: SideTab } & ProjectHint)
  /** `peer: null` is the team-wide conversation, not a DM. */
  | ({ kind: "chat"; peer: string | null } & ProjectHint)
  | ({ kind: "file"; path: string; line?: number } & ProjectHint)
  /** A scratchpad note, by store id (`nnnn-slug`). */
  | ({ kind: "note"; noteId: string } & ProjectHint)
  /** A pull request's detail tab. `path` doubles as the repo checkout — the
   *  same string `openPr` keys tabs on — and `url` is the escape hatch: a PR
   *  that has merged or closed since the notification went out has no native
   *  tab any more, and the browser is the only true answer left. */
  | ({ kind: "pr"; number: number; url?: string } & ProjectHint);

export const DEEP_LINK_SCHEME = "canopy:";

/** Serialise a target for the trip through the OS and back. */
export function formatDeepLink(link: DeepLink): string {
  const q = new URLSearchParams();
  const hint = link as ProjectHint;
  if (hint.projectId) q.set("id", hint.projectId);
  if (hint.path) q.set("path", hint.path);
  if (link.kind === "terminal") q.set("pty", String(link.ptyId));
  if (link.kind === "panel") q.set("name", link.panel);
  if (link.kind === "chat" && link.peer !== null) q.set("peer", link.peer);
  if (link.kind === "file" && link.line != null) q.set("line", String(link.line));
  // `note`, not `id` — `id` is already the project hint on every kind, and a
  // link that spelled the note with it would be a link that can never carry
  // both. The Rust side composes the same string (notes.rs `note_link`).
  if (link.kind === "note") q.set("note", link.noteId);
  if (link.kind === "pr") {
    q.set("number", String(link.number));
    if (link.url) q.set("url", link.url);
  }
  const query = q.toString();
  return `canopy://${link.kind}${query ? `?${query}` : ""}`;
}

/** Parse a target back. Returns null for anything that isn't one of ours or
 *  that is missing what its kind needs — a malformed link is dropped rather
 *  than half-followed, and the caller falls back to raising the window. */
export function parseDeepLink(raw: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== DEEP_LINK_SCHEME) return null;
  // `canopy://terminal?pty=1` puts the kind in the host; `canopy:project`
  // (no authority) puts it in the pathname. Accept both — a link typed by
  // hand, or mangled by a shell, shouldn't be a dead end.
  const kind = (url.hostname || url.pathname.replace(/^\/+/, "")).toLowerCase();
  const p = url.searchParams;
  const hint: ProjectHint = {};
  const id = p.get("id");
  const path = p.get("path");
  if (id) hint.projectId = id;
  if (path) hint.path = path;

  switch (kind) {
    case "app":
      return { kind: "app", ...hint };
    case "project":
      return { kind: "project", ...hint };
    case "terminal": {
      const raw = p.get("pty");
      const pty = Number(raw);
      // `Number(null)` and `Number("")` are both 0, a perfectly good pty id —
      // so the presence of the parameter is checked, not just its value.
      if (!raw || !Number.isInteger(pty) || pty < 0) return null;
      return { kind: "terminal", ptyId: pty, ...hint };
    }
    case "panel": {
      const name = p.get("name") as SideTab | null;
      if (!name || !SIDE_TABS.includes(name)) return null;
      return { kind: "panel", panel: name, ...hint };
    }
    case "chat":
      return { kind: "chat", peer: p.get("peer"), ...hint };
    case "note": {
      const noteId = p.get("note");
      if (!noteId) return null;
      return { kind: "note", noteId, ...hint };
    }
    case "pr": {
      const raw = p.get("number");
      const number = Number(raw);
      // Same presence check as `pty`: `Number(null)` is 0, and PR #0 is not a
      // thing anyone meant.
      if (!raw || !Number.isInteger(number) || number <= 0) return null;
      const url = p.get("url") ?? undefined;
      return { kind: "pr", number, ...(url ? { url } : {}), ...hint };
    }
    case "file": {
      if (!path) return null;
      const line = Number(p.get("line"));
      return {
        kind: "file",
        path,
        ...(Number.isInteger(line) && line > 0 ? { line } : {}),
        ...hint,
      };
    }
    default:
      return null;
  }
}

/** What following a link actually does, once the project is open. Separated
 *  from doing it because the interesting part is the fallback chain, and a
 *  chain buried in an event handler inside a component is a chain nobody can
 *  test — every branch here is a case where the target no longer describes the
 *  world, which is the normal case for anything read minutes after it was
 *  written. */
export type DeepLinkAction =
  | { do: "tab"; tabId: string }
  | { do: "panel"; panel: SideTab; note?: string }
  | { do: "chat"; peer: string | null; name: string }
  | { do: "file"; path: string; line?: number }
  | { do: "note"; noteId: string }
  | { do: "pr"; repo: string; number: number; url?: string }
  | { do: "nothing" };

/** The project's surfaces as they are right now — what the link is resolved
 *  against. */
export interface FollowContext {
  /** Terminal tabs open in this project. `ptyId` is null for a tab whose shell
   *  hasn't spawned yet; `attachId` is set for a tab attached to a pty someone
   *  else spawned (the portal, a micro-task). */
  terminals: { id: string; ptyId: number | null; attachId?: number }[];
  /** Ptys of micro-task runs with no tab in this window — they live in Tasks. */
  detachedPtys: number[];
  /** Relay members currently connected. A member is keyless until it has
   *  identified itself, and a keyless one can never be a link's peer. */
  members: { key: string | null; name: string }[];
}

export function followLink(
  link: DeepLink,
  ctx: FollowContext,
): DeepLinkAction {
  switch (link.kind) {
    case "panel":
      return { do: "panel", panel: link.panel };
    case "terminal": {
      const tab = ctx.terminals.find(
        (t) => t.ptyId === link.ptyId || t.attachId === link.ptyId,
      );
      if (tab) return { do: "tab", tabId: tab.id };
      // A detached micro-task never had a tab in this window; the Tasks panel
      // is where its row, its status and its transcript are.
      if (ctx.detachedPtys.includes(link.ptyId))
        return { do: "panel", panel: "tasks" };
      // The terminal is gone. Agents is the panel that still remembers what
      // ran in it, which is the nearest true answer to "take me there".
      return {
        do: "panel",
        panel: "agents",
        note: "That terminal has closed — here's what ran in it.",
      };
    }
    case "chat": {
      const peer = link.peer;
      if (peer === null) return { do: "chat", peer, name: "Team" };
      const name = ctx.members.find((m) => m.key === peer)?.name;
      // A DM with someone who has since disconnected has no conversation to
      // open — the Team panel still holds the transcript.
      if (!name)
        return {
          do: "panel",
          panel: "team",
          note: "They've left the relay — the conversation is in Team.",
        };
      return { do: "chat", peer, name };
    }
    case "file":
      return { do: "file", path: link.path, line: link.line };
    // Unlike a terminal or a peer, a note cannot have gone away underneath the
    // link: the store is the authority and it is still there. So there is no
    // fallback chain here — opening the tab either finds it or reports that it
    // was deleted, which is a truer answer than landing on the panel.
    case "note":
      return { do: "note", noteId: link.noteId };
    // The handler re-resolves the PR against the live list (`openPrByNumber`):
    // still open → its tab, gone → the URL in the browser. Without a repo to
    // resolve against, the PRs panel is the nearest honest landing.
    case "pr":
      return link.path
        ? { do: "pr", repo: link.path, number: link.number, url: link.url }
        : { do: "panel", panel: "prs" };
    // The project is already open by the time this runs; that was the whole
    // instruction.
    case "app":
    case "project":
      return { do: "nothing" };
  }
}

/** The project a target belongs to, resolved against the workspace as it is
 *  *now* — which is the whole difficulty: the notification was composed when
 *  the world looked different.
 *
 *  `projectId` wins when that project still exists. Otherwise the most specific
 *  component root containing `path`, so a link into a nested component lands in
 *  the project that owns it rather than an ancestor that merely contains it.
 *  Returns undefined when neither resolves — the caller then falls back. */
export function projectForLink(
  link: DeepLink,
  projects: { id: string; components: { path: string }[] }[],
): string | undefined {
  const hint = link as ProjectHint;
  if (hint.projectId && projects.some((p) => p.id === hint.projectId))
    return hint.projectId;
  const norm = (s: string) => s.replace(/\/+$/, "");
  const target = hint.path ? norm(hint.path) : "";
  if (!target) return undefined;
  let bestId: string | undefined;
  let bestLen = -1;
  for (const project of projects) {
    for (const comp of project.components) {
      const root = norm(comp.path);
      if (!root) continue;
      if (
        (target === root || target.startsWith(root + "/")) &&
        root.length > bestLen
      ) {
        bestLen = root.length;
        bestId = project.id;
      }
    }
  }
  return bestId;
}
