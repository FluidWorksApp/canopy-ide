// The shape of a readable Canopy link, with no dependencies, so anything that
// handles a URL (links.ts, the deep-link parser) can recognise one cheaply.
// The rest of the feature is in readableLinks.ts; the control plane is the
// authority (packages/control-plane/lib/readable-links.mjs).
export const LINK_ORIGIN = 'https://canopyide.dev';
const LINK_HOST = 'canopyide.dev';
/** Mirrors RESERVED_HANDLES in packages/control-plane/lib/readable-links.mjs
 *  (readableLinks.test.ts keeps them identical): first path segments the
 *  website serves itself, so they are never a team. */
export const RESERVED_HANDLES: readonly string[] = ['about','account','accounts','admin','api','app','apps','assets','auth','billing','blog','careers','changelog','contact','dashboard','docs','download','downloads','help','home','invite','invitations','join','legal','link','links','login','logout','new','oauth','organizations','personal-teams','press','pricing','privacy','s','security','settings','sign-in','sign-out','sign-up','signin','signup','static','status','support','t','team','teams','terms','u','user','users','www','workspace','workspaces','_next','favicon-ico','robots-txt','sitemap-xml','alternatives','cloud','connect','dev','first-agent-project-zip','guides','llms-full-txt','llms-txt','local-stack-demo-zip','mesh','questions','rss-xml','tech-stack','tools','topics','use-cases','vibe','workflows'];
const reserved = new Set(RESERVED_HANDLES);
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type LinkKind = 'workspace' | 'session' | 'message';
function pathKind(path: string): LinkKind | null {
  const parts = path.split('/');
  if (!parts.every((p) => SEGMENT.test(p))) return null;
  if (parts.length === 1 && parts[0] !== 's' && parts[0] !== 't') return 'workspace';
  if (parts.length === 3 && parts[0] === 't' && (parts[1] === 'general' || parts[1] === 'dm')) return 'message';
  if (parts.length === 3 && parts[0] !== 't' && parts[0] !== 's' && parts[1] === 's') return 'session';
  return null;
}

/** A readable Canopy link in `text` (pasted, typed, or from a deep link), in
 *  canonical form, or null. Shape only: whether it exists, and whether this
 *  account may open it, is the control plane's answer. */
export function parseReadableLink(text: string): {url: string; namespace: string; path: string; kind: LinkKind} | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const segments = url.pathname.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s).toLowerCase();
    } catch {
      return '';
    }
  });
  let namespace: string | undefined;
  if (host === LINK_HOST || host === `www.${LINK_HOST}`) namespace = segments.shift();
  else if (host.endsWith(`.${LINK_HOST}`) && !host.slice(0, -LINK_HOST.length - 1).includes('.')) namespace = host.slice(0, -LINK_HOST.length - 1);
  else return null;
  if (!namespace || !HANDLE.test(namespace) || reserved.has(namespace)) return null;
  const path = segments.join('/'), kind = pathKind(path);
  return kind ? {url: `${LINK_ORIGIN}/${namespace}/${path}`, namespace, path, kind} : null;
}

