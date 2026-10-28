// Readable Canopy links: https://canopyide.dev/<team>/<workspace>, with
// /s/<slug> for a shared agent session and /t/<channel>/<word-slug> for a team
// chat message, plan or handoff. The control plane allocates and resolves them
// (packages/control-plane/lib/readable-links.mjs); a link is only a name, and
// every open re-checks the signed-in account's access. See
// docs/seamless-sharing.md.
//
// "Copy link" is one click: the first copy of a thing asks the control plane
// for its link (idempotent: the same thing always gets the same URL) and the
// answer is remembered for this account until it changes.
import {invoke} from '@tauri-apps/api/core';
import { serverFeatureError } from './accountErrors';
import {writeClipboardText} from './terminalClipboard';
import type {DeepLink} from './deepLinks';

export {LINK_ORIGIN,RESERVED_HANDLES,parseReadableLink,type LinkKind} from './readableLinkParse';
import {parseReadableLink} from './readableLinkParse';

export type LinkTarget =
  | {kind: 'workspace'; workspaceId: string}
  | {kind: 'session'; workspaceId: string; projectId: string; publicationId: string; title: string}
  /** `peer: null` is the team channel; otherwise the other person in a DM. */
  | {kind: 'message'; teamId: string; peer: string | null; messageId: string};
/** Newer servers say which team holds a link and when it was last active. */
export type LinkAbout = {teamName: string | null; activity: 'opened' | 'shared'; activityAt: string | null};
export type ResolvedLink = (
  | {url: string; kind: 'workspace'; target: {workspaceId: string; name: string}}
  | {url: string; kind: 'session'; target: {workspaceId: string; workspaceName: string; projectId: string; publicationId: string; title: string}}
  | {url: string; kind: 'message'; target: {teamId: string; teamName: string; peer: string | null; peerName: string; messageId: string; viewer: string}}
) & {about?: LinkAbout};
/** A link in Settings → Account → Links. */
export type ManagedLink = ResolvedLink & {createdAt: string | null; mine: boolean; canRevoke: boolean};

const request = <T,>(body: unknown) =>
  invoke<T>('canopy_account_request', {route: '/api/links', body}).catch((error: unknown) => {
    throw serverFeatureError(error, 'Readable links');
  });
export const targetKey = (t: LinkTarget) =>
  t.kind === 'workspace' ? `workspace:${t.workspaceId}` : t.kind === 'session' ? `session:${t.workspaceId}:${t.publicationId}` : `message:${t.teamId}:${t.peer ?? ''}:${t.messageId}`;

// Per account. A link URL is not secret, but which things this person has
// linked is theirs; nothing here is written to disk.
let cache = new Map<string, string>();
let epoch = 0;
if (typeof window !== 'undefined') window.addEventListener('canopy:account-changed', () => { epoch++; cache = new Map(); });

/** The readable URL for a thing, allocating it on first use. */
export async function ensureReadableLink(target: LinkTarget): Promise<string> {
  const key = targetKey(target), known = cache.get(key);
  if (known) return known;
  const current = epoch;
  const {link} = await request<{link: {url: string}}>({action: 'ensure', ...target});
  if (!parseReadableLink(link?.url ?? '')) throw Error('Canopy returned an invalid link');
  if (current === epoch) cache.set(key, link.url);
  return link.url;
}

/** Copy a thing's readable URL. Resolves to the URL; throws with a message a
 *  person can act on (signed out, offline, no access). */
export async function copyReadableLink(target: LinkTarget, write: (text: string) => Promise<boolean> = writeClipboardText): Promise<string> {
  let url: string;
  try {
    url = await ensureReadableLink(target);
  } catch (error) {
    const text = String(error).replace(/^Error:\s*/, '');
    throw Error(/unauthori[sz]ed|sign in|\b401\b/i.test(text) ? 'Sign in to Canopy to copy links.' : text);
  }
  if (!(await write(url))) throw Error(`Couldn't copy. The link is ${url}`);
  return url;
}

export const resolveReadableLink = (url: string) => request<{link: ResolvedLink}>({action: 'resolve', url}).then((r) => r.link);

/** The live links this account manages: the ones it made, plus those on
 *  workspaces it owns and in teams it owns or administers. */
export const listReadableLinks = () => request<{links?: ManagedLink[]}>({action: 'list'}).then((r) => (Array.isArray(r?.links) ? r.links : []));

/** Revoke a link. Nobody can open it afterwards, and its path is never reused;
 *  the next "Copy link" on the same thing makes a new one. */
export async function revokeReadableLink(url: string): Promise<void> {
  await request<{revoked: boolean}>({action: 'revoke', url});
  for (const [key, known] of cache) if (known === url) cache.delete(key);
}

/** One line a person can read for what a link points at. Never message text:
 *  links don't carry it. */
export function describeLink(link: ResolvedLink): {kind: string; name: string; detail: string} {
  const team = link.about?.teamName;
  if (link.kind === 'workspace') return {kind: 'Workspace', name: link.target.name || 'Workspace', detail: team ?? ''};
  if (link.kind === 'session') return {kind: 'Shared session', name: link.target.title || 'Agent session', detail: [link.target.workspaceName, team].filter(Boolean).join(' · ')};
  const t = link.target;
  return {kind: 'Message', name: t.peer ? `Direct message${t.peerName ? ` with ${t.peerName}` : ''}` : 'Message in the team channel', detail: t.teamName || team || ''};
}

/** The in-app deep link for a readable URL (deepLinks.ts `link`). */
export const appLinkFor = (url: string) => `canopy://link?url=${encodeURIComponent(url)}`;

// A shared session waiting for its viewer: the link opens the Team panel, and
// its Live now list (LiveSessions.tsx) picks this up when it mounts or is open.
let pendingSession: {workspaceId: string; publicationId: string} | null = null;
export const SHARED_SESSION_FOCUS_EVENT = 'canopy:shared-session-focus';
export function takePendingSession(workspaceId: string): string | null {
  if (pendingSession?.workspaceId !== workspaceId) return null;
  const id = pendingSession.publicationId;
  pendingSession = null;
  return id;
}
/** The waiting shared session for whichever workspace it names. */
export function takeAnyPendingSession(): {workspaceId: string; publicationId: string} | null {
  const pending = pendingSession;
  pendingSession = null;
  return pending;
}
/** `canopy:open-team` asks the project view to show the Team panel. */
export const OPEN_TEAM_EVENT = 'canopy:open-team';

/** `canopy:show-workspace` asks the workspace switcher to open a workspace
 *  (`connect`) or show its details. */
export const SHOW_WORKSPACE_EVENT = 'canopy:show-workspace';
export type ShowWorkspaceDetail = {workspaceId: string; connect: boolean};

export interface OpenDeps {
  resolve?: (url: string) => Promise<ResolvedLink>;
  /** The app's deep-link router (App.tsx followDeepLink). */
  follow: (link: DeepLink) => void | Promise<void>;
  dispatch?: (event: Event) => void;
}

/** Open what a readable link names, after the control plane confirms this
 *  account may see it. */
export async function openReadableLink(raw: string, deps: OpenDeps): Promise<ResolvedLink> {
  const parsed = parseReadableLink(raw);
  if (!parsed) throw Error('That is not a Canopy link.');
  const dispatch = deps.dispatch ?? ((event: Event) => window.dispatchEvent(event));
  let link: ResolvedLink;
  try {
    link = await (deps.resolve ?? resolveReadableLink)(parsed.url);
  } catch (error) {
    const text = String(error);
    if (/\b410\b|revoked/i.test(text)) throw Error('This link was revoked. Ask for a new one.');
    if (/unauthori[sz]ed|sign in|\b401\b/i.test(text)) throw Error('Sign in to Canopy to open this link.');
    if (/not found|\b404\b/i.test(text)) throw Error("This link doesn't exist, or your account can't open it.");
    throw Error(text.replace(/^Error:\s*/, ''));
  }
  if (link.kind === 'workspace') {
    dispatch(new CustomEvent<ShowWorkspaceDetail>(SHOW_WORKSPACE_EVENT, {detail: {workspaceId: link.target.workspaceId, connect: true}}));
  } else if (link.kind === 'session') {
    pendingSession = {workspaceId: link.target.workspaceId, publicationId: link.target.publicationId};
    dispatch(new Event(OPEN_TEAM_EVENT));
    dispatch(new CustomEvent(SHARED_SESSION_FOCUS_EVENT, {detail: {workspaceId: link.target.workspaceId}}));
  } else {
    const t = link.target;
    await deps.follow({kind: 'chat', peer: t.peer, team: t.teamId, account: t.viewer, name: t.peer ? t.peerName || 'Direct message' : t.teamName, message: t.messageId});
  }
  return link;
}
