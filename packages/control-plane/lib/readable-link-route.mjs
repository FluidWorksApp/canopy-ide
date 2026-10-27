import {parseReadableUrl,resolveReadableLink,readableLinkAction,linkOrigin} from './readable-links.mjs';
// The website side of readable links, kept framework-free so the canopyide.dev
// deployment mounts it with a thin adapter (see docs/seamless-sharing.md):
//   POST /api/links         → linksApi(db, user, body)        (JSON in, JSON out)
//   GET  /<team>/<path...>  → readableRequestDecision(...)     (redirect or page)
// Both take the user from principal(); the caller owns the transaction.
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
/** POST /api/links. Ensure and revoke change state: the caller passes
 * `mayMutate` (principal.mjs) so a cross-site browser form cannot mint links. */
export async function linksApi(db,user,body,{mayMutate=false,origin=linkOrigin()}={}){
 if(!user)fail(401,'Sign in to use Canopy links');
 if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'Invalid link request');
 if(body.action!=='resolve'&&!mayMutate)fail(403,'This request cannot change links');
 return readableLinkAction(db,user,{...body,origin});
}
/** The deep link the desktop app follows for a readable URL. */
export const appLink=url=>`canopy://link?url=${encodeURIComponent(url)}`;
/** What GET https://canopyide.dev/<team>/... should do:
 *   302 → sign in first (and come back), when there is no session;
 *   200 → a small page that opens the app at the target (`openInApp`);
 *   404 → not a link, not yours, or nothing there (indistinguishable on purpose);
 *   410 → a link you could open, since revoked. */
export async function readableRequestDecision(db,user,url,{origin=linkOrigin(),signInPath='/sign-in'}={}){
 const parsed=parseReadableUrl(url,origin);
 if(!parsed)return {status:404};
 if(!user)return {status:302,location:`${signInPath}?next=${encodeURIComponent(`/${parsed.namespace}/${parsed.path}`)}`};
 try{
  const {link}=await resolveReadableLink(db,user,{url,origin});
  return {status:200,link,openInApp:appLink(link.url)};
 }catch(error){
  if(error.code===404||error.code===410)return {status:error.code};
  throw error;
 }
}
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const LABEL={workspace:'workspace',session:'shared session',message:'message'};
/** A minimal, dependency-free page for a 200/404/410 decision. The website may
 * render its own instead; this one is safe to serve as-is (no target names on
 * error pages, everything escaped, no script). */
export function readableLinkPage(decision,{downloadUrl='https://canopyide.dev/downloads'}={}){
 const shell=(title,body)=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)} · Canopy</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1d2420;background:#fafaf7}a.button{display:inline-block;padding:.6rem 1rem;border-radius:.5rem;background:#2f6b4f;color:#fff;text-decoration:none}small{color:#5b645f}@media(prefers-color-scheme:dark){body{background:#151816;color:#e6ebe7}small{color:#9aa49e}}</style></head><body>${body}</body></html>`;
 if(decision.status===410)return shell('Link revoked','<h1>This link was revoked</h1><p>Ask whoever shared it for a new one.</p>');
 if(decision.status!==200)return shell('Link not found','<h1>Nothing here</h1><p>This Canopy link does not exist, or your account cannot open it. Check you are signed in with the account your team uses.</p>');
 const t=decision.link.target??{},name=t.title||t.name||t.workspaceName||t.teamName||'';
 return shell(`Open ${LABEL[decision.link.kind]??'link'}`,`<h1>Open ${escape(LABEL[decision.link.kind]??'link')}${name?` <em>${escape(name)}</em>`:''} in Canopy</h1><p><a class="button" href="${escape(decision.openInApp)}">Open in Canopy</a></p><p><small>${escape(decision.link.url)}<br>Canopy not installed? <a href="${escape(downloadUrl)}">Download it</a>, sign in with this account, then open the link again.</small></p>`);
}
