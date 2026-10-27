import {parseReadableUrl,resolveReadableLink,readableLinkAction,linkOrigin} from './readable-links.mjs';
// The website side of readable links, kept framework-free so the canopyide.dev
// deployment mounts it with a thin adapter (see docs/seamless-sharing.md):
//   POST /api/links         → linksApi(db, user, body)        (JSON in, JSON out)
//   GET  /<team>/<path...>  → readableRequestDecision(...)     (redirect or page)
// Both take the user from principal(); the caller owns the transaction.
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
/** POST /api/links. Resolve and list only read; ensure and revoke change state: the caller passes
 * `mayMutate` (principal.mjs) so a cross-site browser form cannot mint links. */
export async function linksApi(db,user,body,{mayMutate=false,origin=linkOrigin()}={}){
 if(!user)fail(401,'Sign in to use Canopy links');
 if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'Invalid link request');
 if(!['resolve','list'].includes(body.action)&&!mayMutate)fail(403,'This request cannot change links');
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
const LABEL={workspace:'Workspace',session:'Shared agent session',message:'Team message'};
const DATE=new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
/** What the link names, for someone who may open it: a name, where it lives
 * and when it was last active. Never message or session contents. */
export function linkSummary(link){
 const t=link?.target??{},about=link?.about??{};
 const when=about.activityAt&&!Number.isNaN(Date.parse(about.activityAt))?DATE.format(new Date(about.activityAt)):null;
 const rows=[];
 let name;
 if(link?.kind==='workspace')name=t.name||'Workspace';
 else if(link?.kind==='session'){name=t.title||'Agent session';if(t.workspaceName)rows.push(['Workspace',t.workspaceName]);}
 else{name=t.peer?`Direct message${t.peerName?` with ${t.peerName}`:''}`:'Message in the team channel';}
 if(about.teamName)rows.push(['Team',about.teamName]);
 if(when)rows.push([about.activity==='opened'?'Last opened':'Shared',when]);
 return {label:LABEL[link?.kind]??'Canopy link',name,rows};
}
/** A minimal, dependency-free page for a 200/404/410 decision. The website may
 * render its own instead; this one is safe to serve as-is (no target names on
 * error pages, everything escaped, no script). */
export function readableLinkPage(decision,{downloadUrl='https://canopyide.dev/downloads'}={}){
 const shell=(title,body)=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)} · Canopy</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1d2420;background:#fafaf7}h1{font-size:1.5rem;margin:.2rem 0 1rem;overflow-wrap:anywhere}.kind{margin:0;color:#5b645f;font-size:.875rem;text-transform:uppercase;letter-spacing:.04em}dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:0 0 1.5rem}dt{color:#5b645f}dd{margin:0;overflow-wrap:anywhere}a.button{display:inline-block;padding:.6rem 1rem;border-radius:.5rem;background:#2f6b4f;color:#fff;text-decoration:none}a.button:focus-visible{outline:3px solid #9cc9b2;outline-offset:2px}small{color:#5b645f}@media(prefers-color-scheme:dark){body{background:#151816;color:#e6ebe7}small,dt,.kind{color:#9aa49e}}</style></head><body>${body}</body></html>`;
 if(decision.status===410)return shell('Link revoked','<h1>This link was revoked</h1><p>Ask whoever shared it for a new one.</p>');
 if(decision.status!==200)return shell('Link not found','<h1>Nothing here</h1><p>This Canopy link does not exist, or your account cannot open it. Check you are signed in with the account your team uses.</p>');
 const {label,name,rows}=linkSummary(decision.link);
 const details=rows.length?`<dl>${rows.map(([k,v])=>`<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`).join('')}</dl>`:'';
 return shell(name,`<main><p class="kind">${escape(label)}</p><h1>${escape(name)}</h1>${details}<p><a class="button" href="${escape(decision.openInApp)}">Open in Canopy</a></p><p><small>Canopy not installed? <a href="${escape(downloadUrl)}">Download Canopy</a>, sign in with this account, then open the link again.<br>${escape(decision.link.url)}</small></p></main>`);
}

