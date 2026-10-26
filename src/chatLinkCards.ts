// Preview cards for the PR, issue and commit links in a team-chat message.
//
// Derived entirely at render time from URLs already in the plain text: nothing
// about a card is sent, stored or part of the message wire format, so an older
// client — or a teammate without the repo — just sees the link.
//
// A card is a promise about a thing we may know nothing about, so it is built
// up in layers and every layer is optional:
//
//   * The URL alone (parseGitLink): kind, repo, number or hash. Always there;
//     this is the compact card every failure falls back to.
//   * The PR watcher's rows (prWatchStore): open PRs of every open project,
//     already fetched — title, author, draft, CI rollup, review decision for
//     free, no `gh` call.
//   * A checkout of that repo in any open project, asked through the same `gh`
//     and git commands the PR, issue and commit tabs use. Merged and closed PRs
//     are only reachable through `gh pr view --json state`, so those cards
//     carry state without a title.
//
// No gh, no access, offline, a repo nobody has checked out: the compact card,
// never an error. Answers are cached in memory for a few minutes, and failures
// for less, so a chat full of the same link costs one round trip.
import { parseGitLink, remoteMatchesSlug, type GitLink } from "./gitLinks";
import { linkParts } from "./components/LinkifiedText";
import type * as ipc from "./ipc";

/** Cards under one message, at most. */
export const MAX_CARDS = 3;
/** How long a fetched card is trusted. */
export const CARD_TTL_MS = 3 * 60_000;
/** How long a card that fell back (gh failed) waits before asking again. */
export const DEGRADED_TTL_MS = 30_000;

export type CardLink = Extract<GitLink, { kind: "pr" | "issue" | "commit" }>;

export interface CardTarget {
  href: string;
  link: CardLink;
}

export type CardState = "open" | "draft" | "merged" | "closed";

export interface LinkCard {
  href: string;
  link: CardLink;
  title?: string;
  author?: string;
  state?: CardState;
  /** PRs: PASS / FAIL / PENDING, "" or absent when unknown or no checks ran. */
  checks?: string;
  checksSummary?: string;
  /** PRs: APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED. */
  review?: string;
  /** Commits: the abbreviated hash to show. */
  short?: string;
}

/** The recognised links in a message, in order, de-duplicated, capped. Files
 *  are left out — a blob link has nothing a card could add to it. */
export function cardTargets(text: string): CardTarget[] {
  const seen = new Set<string>();
  const out: CardTarget[] = [];
  for (const part of linkParts(text)) {
    if (!part.href) continue;
    const link = parseGitLink(part.href);
    if (!link || link.kind === "file") continue;
    const key = targetKey(link);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ href: part.href, link });
    if (out.length >= MAX_CARDS) break;
  }
  return out;
}

const targetKey = (link: CardLink): string =>
  `${link.kind}:${link.slug.toLowerCase()}:${link.kind === "commit" ? link.hash.toLowerCase() : link.number}`;

/** The card the URL alone can draw. */
export function compactCard({ href, link }: CardTarget): LinkCard {
  return link.kind === "commit"
    ? { href, link, short: link.hash.slice(0, 7) }
    : { href, link };
}

/** Where a card's details come from. Injected so tests run without IPC. */
export interface CardLookups {
  /** Open PRs the watcher already holds, across every open project. */
  watchedRows(): readonly ipc.PrRow[];
  /** Component paths of every open project. */
  repos(): readonly string[];
  remoteUrl(repo: string): Promise<string>;
  prs(repo: string): Promise<ipc.PrInfo[]>;
  prState(repo: string, number: number): Promise<string>;
  issues(repo: string): Promise<ipc.TicketInfo[]>;
  issueDetail(repo: string, number: number): Promise<ipc.IssueDetail>;
  commit(repo: string, hash: string): Promise<ipc.CommitDetail>;
}

interface Entry<T> {
  at: number;
  ttl: number;
  value: Promise<T>;
}

const cache = new Map<string, Entry<unknown>>();
const settled = new Map<string, { at: number; ttl: number; card: LinkCard }>();

/** One promise per key per TTL: concurrent askers share the round trip, and a
 *  rejection is forgotten at once so the next card can try again. */
function memo<T>(key: string, now: number, ttl: number, run: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as Entry<T> | undefined;
  if (hit && now - hit.at < hit.ttl) return hit.value;
  const value = run();
  cache.set(key, { at: now, ttl, value });
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}

const lower = (s: string | undefined | null) => (s ?? "").trim().toLowerCase();

function prState(state: string, draft: boolean): CardState | undefined {
  const s = lower(state);
  if (s === "merged") return "merged";
  if (s === "closed") return "closed";
  if (s === "open") return draft ? "draft" : "open";
  return undefined;
}

function issueState(state: string): CardState | undefined {
  const s = lower(state);
  if (s === "open" || s === "opened") return "open";
  if (s === "closed" || s === "done" || s === "completed") return "closed";
  return undefined;
}

/** The checkout of this repo in any open project, if there is one. */
async function repoFor(slug: string, look: CardLookups, now: number): Promise<string | null> {
  for (const repo of look.repos()) {
    const remote = await memo(`remote:${repo}`, now, CARD_TTL_MS, () => look.remoteUrl(repo)).catch(
      () => "",
    );
    if (remoteMatchesSlug(remote, slug)) return repo;
  }
  return null;
}

const nwoMatches = (nwo: string, slug: string) =>
  lower(nwo) === lower(slug.split("/").slice(-2).join("/"));

async function load(target: CardTarget, look: CardLookups, now: number): Promise<LinkCard> {
  const { link } = target;
  const card = compactCard(target);
  if (link.kind === "pr") {
    const row = look.watchedRows().find((r) => r.number === link.number && nwoMatches(r.nwo, link.slug));
    if (row)
      return {
        ...card,
        title: row.title,
        author: row.author,
        state: row.draft ? "draft" : "open",
        checks: row.checks,
        review: row.review_decision,
      };
  }
  const repo = await repoFor(link.slug, look, now);
  if (!repo) return card;
  switch (link.kind) {
    case "pr": {
      const list = await memo(`prs:${repo}`, now, CARD_TTL_MS, () => look.prs(repo));
      const pr = list.find((p) => p.number === link.number);
      if (pr)
        return {
          ...card,
          title: pr.title,
          author: pr.author,
          state: prState(pr.state, pr.draft) ?? (pr.draft ? "draft" : "open"),
          checks: pr.checks,
          checksSummary: pr.checks_summary,
          review: pr.review_decision,
        };
      // Not in the open list: merged or closed. `gh` will say which, not much else.
      const state = await memo(`prstate:${repo}#${link.number}`, now, CARD_TTL_MS, () =>
        look.prState(repo, link.number),
      );
      return { ...card, state: prState(state, false) };
    }
    case "issue": {
      // The list carries the title (open and recently closed issues); the
      // detail carries author and state for any number. Either alone is a card.
      const [list, detail] = await Promise.all([
        memo(`issues:${repo}`, now, CARD_TTL_MS, () => look.issues(repo)).catch(() => null),
        memo(`issue:${repo}#${link.number}`, now, CARD_TTL_MS, () =>
          look.issueDetail(repo, link.number),
        ).catch(() => null),
      ]);
      if (!list && !detail) throw new Error("issue unavailable");
      const ticket = list?.find((t) => t.id === `#${link.number}`);
      return {
        ...card,
        title: ticket?.title || undefined,
        author: detail?.author || undefined,
        state: issueState(detail?.state ?? "") ?? issueState(ticket?.state ?? ""),
      };
    }
    case "commit": {
      const c = await memo(`commit:${repo}@${link.hash}`, now, CARD_TTL_MS, () => look.commit(repo, link.hash));
      return { ...card, title: c.subject, author: c.author, short: c.short || card.short };
    }
  }
}

/** A card answered recently enough to show without asking again. */
export function cachedCard(href: string, now = Date.now()): LinkCard | undefined {
  const hit = settled.get(href);
  return hit && now - hit.at < hit.ttl ? hit.card : undefined;
}

/** The fullest card we can draw for this link. Never rejects: anything that
 *  goes wrong is the compact card, kept for a short while. */
export function fetchCard(target: CardTarget, look: CardLookups, now = Date.now()): Promise<LinkCard> {
  const hit = cachedCard(target.href, now);
  if (hit) return Promise.resolve(hit);
  return memo(`card:${target.href}`, now, DEGRADED_TTL_MS, () =>
    load(target, look, now).then(
      (card) => {
        settled.set(target.href, { at: now, ttl: CARD_TTL_MS, card });
        return card;
      },
      () => {
        const card = compactCard(target);
        settled.set(target.href, { at: now, ttl: DEGRADED_TTL_MS, card });
        return card;
      },
    ),
  );
}

/** Test seam. */
export function __resetCardCache(): void {
  cache.clear();
  settled.clear();
}

// ---------- copy ----------

const KIND_LABEL: Record<CardLink["kind"], string> = {
  pr: "Pull request",
  issue: "Issue",
  commit: "Commit",
};

export const STATE_LABEL: Record<CardState, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

export function checksLabel(checks: string | undefined): string {
  switch ((checks ?? "").toUpperCase()) {
    case "PASS":
      return "Checks passing";
    case "FAIL":
      return "Checks failing";
    case "PENDING":
      return "Checks running";
    default:
      return "";
  }
}

export function reviewLabel(review: string | undefined): string {
  switch ((review ?? "").toUpperCase()) {
    case "APPROVED":
      return "Approved";
    case "CHANGES_REQUESTED":
      return "Changes requested";
    case "REVIEW_REQUIRED":
      return "Review required";
    default:
      return "";
  }
}

/** `#812` / `a1b2c3d` — what the card leads with. */
export function cardRef(card: LinkCard): string {
  return card.link.kind === "commit" ? (card.short ?? card.link.hash.slice(0, 7)) : `#${card.link.number}`;
}

/** The repo as `owner/name` — the last two segments, as remotes are matched. */
export const cardRepo = (card: LinkCard) => card.link.slug.split("/").slice(-2).join("/");

export const kindLabel = (card: LinkCard) => KIND_LABEL[card.link.kind];

/** One sentence a screen reader can act on. */
export function cardLabel(card: LinkCard): string {
  const parts = [`${kindLabel(card)} ${cardRef(card)} in ${cardRepo(card)}`];
  if (card.title) parts.push(card.title);
  if (card.state) parts.push(STATE_LABEL[card.state]);
  if (card.author) parts.push(`by ${card.author}`);
  const checks = checksLabel(card.checks);
  if (checks) parts.push(checks);
  const review = reviewLabel(card.review);
  if (review) parts.push(review);
  return parts.join(", ");
}
