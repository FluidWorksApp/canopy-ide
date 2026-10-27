// Share cards: a pull request, lines of a file, a diff, terminal output or an
// agent's report, sent from Canopy into team chat — plus PR review requests and
// their outcomes, and agent plans shared for the team to approve (src/plans).
//
// A card rides on an ordinary, visible chat message as the optional `card`
// field. The message's `text` is the human-readable fallback (a summary line and
// the canonical https URL), so a client that does not know cards — or drops
// this one as invalid — shows a perfectly good message instead. Nothing here is
// gated on a capability for that reason.
//
// Everything on the wire is untrusted: it came from a teammate's device, and a
// modified client can put anything in it. So a card names a repository only by
// its host and `owner/name` (never a path on anyone's disk), carries no URLs
// (the recipient builds them), and every string is bounded and stripped of the
// characters that make text render as something it isn't. `parseCard` is
// lenient in the same way `parseExtensions` is: anything malformed or unknown is
// dropped and the message is shown as its text.
import type {ChatMessage} from './client';
import {UUID,hasControl} from './messageSchema';
/** safeRepoPath's segment rules (gitLinks.ts), restated here so the wire
 *  schema has no import cycle with gitLinks: no empty, `.`, `..` or `.git`
 *  segment, no slash or backslash inside one, and no drive letter first. */
const safeSegments=(segments:readonly string[])=>segments.length>0&&segments.every(s=>!!s&&s!=='.'&&s!=='..'&&!s.includes('\\')&&s.toLowerCase()!=='.git')&&!/^[a-z]:/i.test(segments[0]);

/** A repository as both ends can name it: the git host and its `owner/name`
 *  (or a nested group path), read from the sender's `origin`. */
export type RepoRef={host:string;slug:string};
export type LineRange={start:number;end:number};
export type PrCard={type:'pr';v:1;repo:RepoRef;number:number;title:string;head?:string;base?:string};
export type FileCard={type:'file';v:1;repo:RepoRef;path:string;rev:string;lines?:LineRange;snippet?:string};
export type DiffCard={type:'diff';v:1;repo:RepoRef;base:string;head:string;path:string;lines?:LineRange&{side:'old'|'new'};patch:string;pr?:number};
export type TerminalCard={type:'terminal';v:1;title:string;command?:string;output:string;exit?:number;truncated?:boolean};
export type ReportCard={type:'report';v:1;agent:string;title:string;body:string;repo?:RepoRef;pr?:number};
export type ReviewRequestCard={type:'review-request';v:1;repo:RepoRef;number:number;title:string;head:string;reviewers:string[]};
export type ReviewOutcome='approved'|'changes-requested'|'commented';
export type ReviewOutcomeCard={type:'review-outcome';v:1;request:string;repo:RepoRef;number:number;outcome:ReviewOutcome;head?:string};
/** A session handed off to a teammate: the packet's markdown (rendered as
 *  plain text on the other side — it is untrusted), which agent CLI the session
 *  ran on, and its id, so the recipient can see which conversation it was. The
 *  recipient's "Take over" starts a fresh agent of their own from the packet;
 *  nothing about the sender's machine is named beyond the directory's name. */
export type HandoffCard={type:'handoff';v:1;title:string;agent:string;session:string;packet:string;dir?:string;repo?:RepoRef;truncated?:boolean};
/** A plan an agent will work from (src/plans/plan.ts), shared before the work
 *  starts so teammates can comment and approve. `plan` is the plan's id on the
 *  sender's machine — an opaque token, never a path. No repo: a plan is read,
 *  not opened. */
export type PlanRisk='low'|'medium'|'high';
export type PlanCardSize='tiny'|'small'|'large';
export type PlanCard={type:'plan';v:1;plan:string;goal:string;decisions?:{q:string;a:string}[];acceptance:string[];wontDo?:string[];risk:PlanRisk;size:PlanCardSize};
export type PlanOutcome='approved'|'changes-requested';
/** A teammate's answer to a plan card, posted in the card's thread. */
export type PlanOutcomeCard={type:'plan-outcome';v:1;request:string;plan:string;outcome:PlanOutcome};
export type Card=PrCard|FileCard|DiffCard|TerminalCard|ReportCard|ReviewRequestCard|ReviewOutcomeCard|HandoffCard|PlanCard|PlanOutcomeCard;
export type CardType=Card['type'];

// ---------- limits ----------
export const LIMITS={
 title:200,command:1024,pathBytes:1024,snippetBytes:8*1024,patchBytes:8*1024,outputBytes:12*1024,bodyBytes:12*1024,
 /** The whole card as JSON. A chat message must stay under client.ts's 32 KB
  *  envelope check together with its text fallback and the other fields. */
 cardBytes:14*1024,
 /** How much of terminal output / a report goes into the fallback text. */
 excerptBytes:1024,
 reviewers:20,maxLine:1_000_000,maxSpan:2000,maxNumber:1_000_000_000,slug:200,
 /** A handoff packet's markdown. Under cardBytes with room for the rest. */
 packetBytes:11*1024,
 /** Plan cards: a goal, up to 8 decisions, 12 checks and 8 exclusions. */
 planGoal:400,planItem:300,planDecisions:8,planChecks:12,planWontDo:8,
} as const;
const bytes=(value:string)=>new TextEncoder().encode(value).length;
export const cardBytes=(card:Card)=>bytes(JSON.stringify(card));

// ---------- text safety ----------
/** C1 controls and the bidi overrides/isolates (U+202A–202E, U+2066–2069). */
const C1_OR_BIDI=/[\u0080-\u009f‪-‮⁦-⁩]/;
/** One line of display text: no C0 controls, DEL, C1 controls or bidi controls. */
export const safeLine=(value:unknown,maxChars:number):value is string=>typeof value==='string'&&value.length>0&&[...value].length<=maxChars&&!hasControl(value)&&!C1_OR_BIDI.test(value);
/** A block of display text: as safeLine, but newlines and tabs are allowed. */
export function safeBlock(value:unknown,maxBytes:number):value is string{
 if(typeof value!=='string'||!value.length||bytes(value)>maxBytes||C1_OR_BIDI.test(value))return false;
 for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if((c<32&&c!==10&&c!==9)||c===127)return false;}
 return true;
}
// eslint-disable-next-line no-control-regex
const ANSI=/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[P^_X][^\u001b]*\u001b\\|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[ -/]*[0-~]|\u009b[0-?]*[ -/]*[@-~]/g;
/** Terminal text made safe to send: escape sequences removed (colour, cursor
 *  moves, OSC titles and hyperlinks), carriage returns folded into newlines,
 *  and any other control or bidi character dropped. */
export function stripAnsi(value:string):string{
 // eslint-disable-next-line no-control-regex
 return value.replace(ANSI,'').replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g,'');
}
/** Display text for a single line: unsafe characters removed, whitespace runs collapsed, clipped. */
export function cleanLine(value:string,maxChars:number):string{
 const flat=stripAnsi(value).replace(/\s+/g,' ').trim(),chars=[...flat];
 return chars.length>maxChars?`${chars.slice(0,maxChars-1).join('')}…`:flat;
}
/** The longest prefix of `value` within `maxBytes`, cut on a code point. */
export function clipBytes(value:string,maxBytes:number):{text:string;clipped:boolean}{
 if(bytes(value)<=maxBytes)return {text:value,clipped:false};
 let out='',used=0;
 for(const ch of value){const n=bytes(ch);if(used+n>maxBytes)break;out+=ch;used+=n;}
 return {text:out,clipped:true};
}

// ---------- field validators ----------
const HOST=/^[a-z0-9.-]{1,253}(:\d{1,5})?$/;
const SEGMENT=/^[A-Za-z0-9._-]+$/;
/** A full object id: SHA-1 (40) or SHA-256 (64) hex. Abbreviations are refused —
 *  they can become ambiguous, and the recipient re-validates in Rust anyway. */
export const SHA=/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const validSha=(value:unknown):value is string=>typeof value==='string'&&SHA.test(value);
export function validRepo(value:unknown):value is RepoRef{
 if(!isObject(value)||!exact(value,['host','slug']))return false;
 const {host,slug}=value as RepoRef;
 if(typeof host!=='string'||!HOST.test(host)||host.startsWith('.')||host.startsWith('-'))return false;
 if(typeof slug!=='string'||slug.length>LIMITS.slug)return false;
 const parts=slug.split('/');
 return parts.length>=2&&parts.length<=5&&parts.every(p=>SEGMENT.test(p)&&p!=='.'&&p!=='..');
}
export const validNumber=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=1&&(value as number)<=LIMITS.maxNumber;
/** A repo-relative path a teammate sent: the same rules as a blob link's path
 *  (safeRepoPath — no `.`/`..`, no `\`, no drive letter, nothing in `.git`),
 *  plus no percent-encoded dot, slash or backslash. Paths on the wire are never
 *  URL-decoded, so `%2e%2e` would be a literal (and harmless) name — but a later
 *  consumer that does decode must never be handed one. */
export function validCardPath(value:unknown):value is string{
 if(typeof value!=='string'||!value||bytes(value)>LIMITS.pathBytes)return false;
 if(!safeLine(value,LIMITS.pathBytes)||/%(?:2e|2f|5c|00)/i.test(value))return false;
 if(value.startsWith('/')||value.endsWith('/'))return false;
 return safeSegments(value.split('/'));
}
const validLines=(value:unknown,withSide:boolean):boolean=>{
 if(!isObject(value)||!exact(value,withSide?['start','end','side']:['start','end']))return false;
 const l=value as LineRange&{side?:string};
 if(!Number.isSafeInteger(l.start)||!Number.isSafeInteger(l.end)||l.start<1||l.end<l.start||l.end>LIMITS.maxLine||l.end-l.start+1>LIMITS.maxSpan)return false;
 return !withSide||l.side==='old'||l.side==='new';
};
const validIdentity=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&!hasControl(value)&&!C1_OR_BIDI.test(value);
const isObject=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:object,keys:string[])=>Object.keys(value).every(key=>keys.includes(key));
const optional=<T,>(value:unknown,check:(v:unknown)=>v is T)=>value===undefined||check(value);
const OUTCOMES:readonly ReviewOutcome[]=['approved','changes-requested','commented'];
const PLAN_OUTCOMES:readonly PlanOutcome[]=['approved','changes-requested'];
/** src/plans/plan.ts PLAN_ID, restated so the wire schema imports nothing. */
const PLAN_ID=/^pl-[a-z0-9]{1,16}-[a-z0-9]{1,16}$/;
const planItem=(v:unknown):v is string=>safeLine(v,LIMITS.planItem);
const planItems=(v:unknown,max:number,min=0):v is string[]=>Array.isArray(v)&&v.length>=min&&v.length<=max&&v.every(planItem);
const title=(v:unknown):v is string=>safeLine(v,LIMITS.title);
const repoCopy=(r:RepoRef):RepoRef=>({host:r.host,slug:r.slug});
/** An agent CLI's conversation id: uuid-like, never a path. */
const SESSION_ID=/^[A-Za-z0-9_-]{1,128}$/;

/** A well formed card of a type this client knows — a fresh object holding only
 *  the known fields — or undefined. Never throws. */
export function parseCard(value:unknown):Card|undefined{
 try{
  if(!isObject(value)||value.v!==1)return undefined;
  const c=value as Record<string,unknown>;
  const base={v:1 as const};
  switch(c.type){
   case 'pr':{
    if(!exact(c,['type','v','repo','number','title','head','base'])||!validRepo(c.repo)||!validNumber(c.number)||!title(c.title)||!optional(c.head,validSha)||!optional(c.base,validSha))return undefined;
    return fits({type:'pr',...base,repo:repoCopy(c.repo),number:c.number,title:c.title,...(c.head?{head:c.head as string}:{}),...(c.base?{base:c.base as string}:{})});
   }
   case 'file':{
    if(!exact(c,['type','v','repo','path','rev','lines','snippet'])||!validRepo(c.repo)||!validCardPath(c.path)||!validSha(c.rev))return undefined;
    if(c.lines!==undefined&&!validLines(c.lines,false))return undefined;
    if(c.snippet!==undefined&&!safeBlock(c.snippet,LIMITS.snippetBytes))return undefined;
    const lines=c.lines as LineRange|undefined;
    return fits({type:'file',...base,repo:repoCopy(c.repo),path:c.path,rev:c.rev,...(lines?{lines:{start:lines.start,end:lines.end}}:{}),...(c.snippet!==undefined?{snippet:c.snippet as string}:{})});
   }
   case 'diff':{
    if(!exact(c,['type','v','repo','base','head','path','lines','patch','pr'])||!validRepo(c.repo)||!validSha(c.base)||!validSha(c.head)||!validCardPath(c.path)||!safeBlock(c.patch,LIMITS.patchBytes)||!optional(c.pr,validNumber))return undefined;
    if(c.lines!==undefined&&!validLines(c.lines,true))return undefined;
    const lines=c.lines as (LineRange&{side:'old'|'new'})|undefined;
    return fits({type:'diff',...base,repo:repoCopy(c.repo),base:c.base,head:c.head,path:c.path,...(lines?{lines:{start:lines.start,end:lines.end,side:lines.side}}:{}),patch:c.patch,...(c.pr!==undefined?{pr:c.pr as number}:{})});
   }
   case 'terminal':{
    if(!exact(c,['type','v','title','command','output','exit','truncated'])||!title(c.title)||!optional(c.command,(v):v is string=>safeLine(v,LIMITS.command))||!safeBlock(c.output,LIMITS.outputBytes))return undefined;
    if(c.exit!==undefined&&!(Number.isSafeInteger(c.exit)&&Math.abs(c.exit as number)<=0xffffffff))return undefined;
    if(c.truncated!==undefined&&typeof c.truncated!=='boolean')return undefined;
    return fits({type:'terminal',...base,title:c.title,...(c.command!==undefined?{command:c.command as string}:{}),output:c.output,...(c.exit!==undefined?{exit:c.exit as number}:{}),...(c.truncated!==undefined?{truncated:c.truncated as boolean}:{})});
   }
   case 'report':{
    if(!exact(c,['type','v','agent','title','body','repo','pr'])||!title(c.agent)||!title(c.title)||!safeBlock(c.body,LIMITS.bodyBytes)||!optional(c.repo,validRepo)||!optional(c.pr,validNumber))return undefined;
    if(c.pr!==undefined&&c.repo===undefined)return undefined;
    return fits({type:'report',...base,agent:c.agent,title:c.title,body:c.body,...(c.repo?{repo:repoCopy(c.repo as RepoRef)}:{}),...(c.pr!==undefined?{pr:c.pr as number}:{})});
   }
   case 'review-request':{
    if(!exact(c,['type','v','repo','number','title','head','reviewers'])||!validRepo(c.repo)||!validNumber(c.number)||!title(c.title)||!validSha(c.head))return undefined;
    const r=c.reviewers;
    if(!Array.isArray(r)||!r.length||r.length>LIMITS.reviewers||!r.every(validIdentity)||new Set(r).size!==r.length)return undefined;
    return fits({type:'review-request',...base,repo:repoCopy(c.repo),number:c.number,title:c.title,head:c.head,reviewers:[...r] as string[]});
   }
   case 'review-outcome':{
    if(!exact(c,['type','v','request','repo','number','outcome','head'])||typeof c.request!=='string'||!UUID.test(c.request)||!validRepo(c.repo)||!validNumber(c.number)||!OUTCOMES.includes(c.outcome as ReviewOutcome)||!optional(c.head,validSha))return undefined;
    return fits({type:'review-outcome',...base,request:c.request,repo:repoCopy(c.repo),number:c.number,outcome:c.outcome as ReviewOutcome,...(c.head?{head:c.head as string}:{})});
   }
   case 'handoff':{
    if(!exact(c,['type','v','title','agent','session','packet','dir','repo','truncated'])||!title(c.title)||!safeLine(c.agent,64)||typeof c.session!=='string'||!SESSION_ID.test(c.session)||!safeBlock(c.packet,LIMITS.packetBytes)||!optional(c.dir,(v):v is string=>safeLine(v,200)&&!/[\\/]/.test(v))||!optional(c.repo,validRepo))return undefined;
    if(c.truncated!==undefined&&typeof c.truncated!=='boolean')return undefined;
    return fits({type:'handoff',...base,title:c.title,agent:c.agent,session:c.session,packet:c.packet,...(c.dir!==undefined?{dir:c.dir as string}:{}),...(c.repo?{repo:repoCopy(c.repo as RepoRef)}:{}),...(c.truncated!==undefined?{truncated:c.truncated as boolean}:{})});
   }
   case 'plan':{
    if(!exact(c,['type','v','plan','goal','decisions','acceptance','wontDo','risk','size'])||typeof c.plan!=='string'||!PLAN_ID.test(c.plan)||!safeLine(c.goal,LIMITS.planGoal))return undefined;
    if(c.risk!=='low'&&c.risk!=='medium'&&c.risk!=='high')return undefined;
    if(c.size!=='tiny'&&c.size!=='small'&&c.size!=='large')return undefined;
    if(!planItems(c.acceptance,LIMITS.planChecks)||(c.wontDo!==undefined&&!planItems(c.wontDo,LIMITS.planWontDo)))return undefined;
    const d=c.decisions;
    if(d!==undefined&&!(Array.isArray(d)&&d.length<=LIMITS.planDecisions&&d.every(x=>isObject(x)&&exact(x,['q','a'])&&planItem(x.q)&&planItem(x.a))))return undefined;
    const decisions=(d as {q:string;a:string}[]|undefined)?.map(x=>({q:x.q,a:x.a}));
    return fits({type:'plan',...base,plan:c.plan,goal:c.goal,...(decisions?{decisions}:{}),acceptance:[...c.acceptance as string[]],...(c.wontDo!==undefined?{wontDo:[...c.wontDo as string[]]}:{}),risk:c.risk,size:c.size});
   }
   case 'plan-outcome':{
    if(!exact(c,['type','v','request','plan','outcome'])||typeof c.request!=='string'||!UUID.test(c.request)||typeof c.plan!=='string'||!PLAN_ID.test(c.plan)||!PLAN_OUTCOMES.includes(c.outcome as PlanOutcome))return undefined;
    return fits({type:'plan-outcome',...base,request:c.request,plan:c.plan,outcome:c.outcome as PlanOutcome});
   }
   default:return undefined;
  }
 }catch{return undefined;}
}
const fits=(card:Card)=>cardBytes(card)<=LIMITS.cardBytes?card:undefined;
/** The card a message carries, if this client understands it. */
const parsed=new WeakMap<object,Card|undefined>();
/** Parsed once per card object: a chat view asks on every render. */
export function cardOf(m:Pick<ChatMessage,'card'>):Card|undefined{
 const raw=m.card;
 if(!raw||typeof raw!=='object')return raw===undefined?undefined:parseCard(raw);
 if(parsed.has(raw))return parsed.get(raw);
 const card=parseCard(raw);parsed.set(raw,card);return card;
}

// ---------- canonical URLs and fallback text ----------
const short=(sha:string)=>sha.slice(0,7);
const isGitLab=(host:string)=>/(^|\.)gitlab\./.test(host)||host==='gitlab.com';
const encodePath=(path:string)=>path.split('/').map(encodeURIComponent).join('/');
const repoUrl=(r:RepoRef)=>`https://${r.host}/${r.slug.split('/').map(encodeURIComponent).join('/')}`;
export const repoName=(r:RepoRef)=>r.slug;
export function prUrl(r:RepoRef,number:number){return isGitLab(r.host)?`${repoUrl(r)}/-/merge_requests/${number}`:`${repoUrl(r)}/pull/${number}`;}
const lineAnchor=(l?:LineRange)=>l?(l.start===l.end?`#L${l.start}`:`#L${l.start}-L${l.end}`):'';
export function blobUrl(r:RepoRef,rev:string,path:string,lines?:LineRange){return `${repoUrl(r)}${isGitLab(r.host)?'/-':''}/blob/${rev}/${encodePath(path)}${lineAnchor(lines)}`;}
export function compareUrl(r:RepoRef,base:string,head:string){return `${repoUrl(r)}${isGitLab(r.host)?'/-':''}/compare/${base}...${head}`;}
/** Where the card's subject lives on the web, built here from validated fields — never sent. */
export function cardUrl(card:Card):string|undefined{
 switch(card.type){
  case 'pr':case 'review-request':case 'review-outcome':return prUrl(card.repo,card.number);
  case 'file':return blobUrl(card.repo,card.rev,card.path,card.lines);
  case 'diff':return card.pr?`${prUrl(card.repo,card.pr)}${isGitLab(card.repo.host)?'/diffs':'/files'}`:compareUrl(card.repo,card.base,card.head);
  case 'report':return card.repo&&card.pr?prUrl(card.repo,card.pr):undefined;
  case 'terminal':case 'handoff':case 'plan':case 'plan-outcome':return undefined;
 }
}
const linesLabel=(l?:LineRange)=>l?(l.start===l.end?`:${l.start}`:`:${l.start}-${l.end}`):'';
export const OUTCOME_LABEL:Record<ReviewOutcome,string>={approved:'Approved','changes-requested':'Requested changes on',commented:'Commented on'};
export const OUTCOME_ICON:Record<ReviewOutcome,string>={approved:'✅','changes-requested':'🔁',commented:'💬'};
/** The one-line summary a card's fallback text starts with. */
export function cardSummary(card:Card):string{
 switch(card.type){
  case 'pr':return `PR ${card.repo.slug}#${card.number}: ${card.title}`;
  case 'file':return `${card.repo.slug} ${card.path}${linesLabel(card.lines)} @ ${short(card.rev)}`;
  case 'diff':return `Diff ${card.repo.slug} ${card.path}${card.lines?linesLabel(card.lines):''} (${short(card.base)}..${short(card.head)})${card.pr?` in #${card.pr}`:''}`;
  case 'terminal':return `Terminal output: ${card.title}`;
  case 'report':return `Report from ${card.agent}: ${card.title}`;
  case 'review-request':return `Review requested: ${card.repo.slug}#${card.number} · head ${short(card.head)}: ${card.title}`;
  case 'review-outcome':return `${OUTCOME_ICON[card.outcome]} ${OUTCOME_LABEL[card.outcome]} ${card.repo.slug}#${card.number} (via Canopy)`;
  case 'handoff':return `Handoff: ${card.title}${card.repo?` (${card.repo.slug})`:''}`;
  case 'plan':return `Plan for review (${card.risk} risk, ${card.size}): ${card.goal}`;
  case 'plan-outcome':return card.outcome==='approved'?'✅ Approved the plan (via Canopy)':'🔁 Asked for changes to the plan (via Canopy)';
 }
}
/** A plan card's body as plain text: what a client without cards shows, and
 *  what the secret check reads. */
export function planText(card:PlanCard):string{
 const out:string[]=[];
 if(card.decisions?.length)out.push('Decisions:',...card.decisions.map(d=>`- ${d.q} → ${d.a}`));
 if(card.acceptance.length)out.push('Done when:',...card.acceptance.map(a=>`- ${a}`));
 if(card.wontDo?.length)out.push('Won\'t do:',...card.wontDo.map(w=>`- ${w}`));
 return out.join('\n');
}
const excerpt=(value:string)=>{const {text,clipped}=clipBytes(value,LIMITS.excerptBytes);return clipped?`${text}…`:text;};
/** What a client that does not know cards shows: the optional note, the
 *  summary line, the canonical https URL, and a short excerpt for the text
 *  kinds. It always stays far under the 16 KB text limit. */
export function cardText(card:Card,note=''):string{
 const parts:string[]=[];
 const n=note.trim();if(n)parts.push(n);
 parts.push(cardSummary(card));
 if(card.type==='terminal'){if(card.command)parts.push(`$ ${card.command}`);parts.push(excerpt(card.output));}
 if(card.type==='report')parts.push(excerpt(card.body));
 // The whole packet, not an excerpt: a teammate on an older Canopy must still
 // be able to take the work over by reading it.
 if(card.type==='handoff')parts.push(card.packet);
 if(card.type==='plan')parts.push(excerpt(planText(card)));
 const url=cardUrl(card);if(url)parts.push(url);
 return parts.join('\n');
}

/** What to show above a card: the sender's note when the text is exactly the
 *  generated fallback for this card (the card says the rest), otherwise the
 *  whole text — a text that says something other than its card is shown as
 *  sent, never hidden behind it. */
export function cardCaption(text:string,card:Card):string{
 const generated=cardText(card);
 if(text===generated)return '';
 if(text.endsWith(`\n${generated}`))return text.slice(0,-generated.length-1);
 return text;
}

// ---------- the message ----------
/** The optional fields a card message adds to a chat message. `mentions` and
 *  `thread` belong to the messaging engine; a card only sets them. */
export type CardExtensions={card:Card;mentions?:string[];thread?:{root:string}};
export type CardDraft={text:string;ext:CardExtensions;bytes:{card:number;text:number}};
export class CardError extends Error {}
/** The text and extensions to send for a card, or a CardError saying why it
 *  cannot be sent. Validates through parseCard, so the sender can never put on
 *  the wire a card its own recipients would drop. */
export function cardDraft(card:Card,note='',extra:{mentions?:string[];thread?:{root:string}}={}):CardDraft{
 const parsed=parseCard(card);
 if(!parsed)throw new CardError(cardBytes(card)>LIMITS.cardBytes?'This is too large to share. Select less.':'This cannot be shared as a card.');
 if(bytes(note)>2000)throw new CardError('Keep the note under 2 KB.');
 const text=cardText(parsed,note);
 if(bytes(text)>16000)throw new CardError('This message is too large.');
 return {text,ext:{card:parsed,...extra},bytes:{card:cardBytes(parsed),text:bytes(text)}};
}

// ---------- secrets ----------
const SECRET_PATTERNS:readonly [string,RegExp][]=[
 ['a private key',/-----BEGIN [A-Z ]*PRIVATE KEY-----/],
 ['an AWS access key',/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
 ['a GitHub token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
 ['a GitLab token',/\bglpat-[A-Za-z0-9_-]{20,}\b/],
 ['an API key',/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/],
 ['a Slack token',/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
 ['a Google API key',/\bAIza[0-9A-Za-z_-]{35}\b/],
 ['a bearer token',/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/],
 ['a JSON web token',/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
 ['a password or secret',/\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["']?[^\s"']{8,}/i],
 ['credentials in a URL',/\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]{3,}@/i],
];
/** What looks like a credential in text about to be shared, by kind — a
 *  warning for the sender, never a block (false positives are common). */
export function secretKinds(text:string):string[]{return SECRET_PATTERNS.filter(([,re])=>re.test(text)).map(([kind])=>kind);}
/** The free text a card carries, for the secret check. */
export function cardFreeText(card:Card):string{
 switch(card.type){
  case 'terminal':return `${card.command??''}\n${card.output}`;
  case 'report':return card.body;
  case 'file':return card.snippet??'';
  case 'diff':return card.patch;
  case 'handoff':return card.packet;
  case 'plan':return `${card.goal}\n${planText(card)}`;
  default:return '';
 }
}

// ---------- review outcomes ----------
/** Both in the channel, or both between the same two people (as chatEvents.ts). */
function sameConversation(a:Pick<ChatMessage,'sender'|'recipient'>,b:Pick<ChatMessage,'sender'|'recipient'>){
 if(a.recipient===null||b.recipient===null)return a.recipient===b.recipient;
 return [a.sender,a.recipient].sort().join('\u0000')===[b.sender,b.recipient].sort().join('\u0000');
}
export type FoldedOutcome={reviewer:string;outcome:ReviewOutcome;head?:string;created:number;id:string};
/** The latest outcome per reviewer for a review request, last-writer-wins by
 *  (created, id). Only replies in the request's own thread count, only from the
 *  reviewers the request named, and only for the PR it named. */
export function foldOutcomes(request:ChatMessage,messages:readonly ChatMessage[]):FoldedOutcome[]{
 const req=cardOf(request);if(req?.type!=='review-request')return [];
 const latest=new Map<string,FoldedOutcome>();
 for(const m of messages){
  if(m.id===request.id||!req.reviewers.includes(m.sender)||!sameConversation(m,request))continue;
  const thread=m.thread as {root?:unknown}|undefined;
  if(!thread||thread.root!==request.id)continue;
  const c=cardOf(m);
  if(c?.type!=='review-outcome'||c.request!==request.id||c.number!==req.number||c.repo.host!==req.repo.host||c.repo.slug.toLowerCase()!==req.repo.slug.toLowerCase())continue;
  const prev=latest.get(m.sender);
  if(prev&&(prev.created>m.created||(prev.created===m.created&&prev.id>m.id)))continue;
  latest.set(m.sender,{reviewer:m.sender,outcome:c.outcome,...(c.head?{head:c.head}:{}),created:m.created,id:m.id});
 }
 return req.reviewers.flatMap(r=>latest.get(r)??[]);
}

// ---------- plan outcomes ----------
export type FoldedPlanOutcome={by:string;outcome:PlanOutcome;created:number;id:string};
/** The latest answer per teammate to a plan card, last-writer-wins by
 *  (created, id). Only replies in the card's own thread count, only for the
 *  plan it named, and never the author's own (a plan is approved by someone
 *  else, or locally by its author before launch). */
export function foldPlanOutcomes(request:ChatMessage,messages:readonly ChatMessage[]):FoldedPlanOutcome[]{
 const req=cardOf(request);if(req?.type!=='plan')return [];
 const latest=new Map<string,FoldedPlanOutcome>();
 for(const m of messages){
  if(m.id===request.id||m.sender===request.sender||!sameConversation(m,request))continue;
  const thread=m.thread as {root?:unknown}|undefined;
  if(!thread||thread.root!==request.id)continue;
  const c=cardOf(m);
  if(c?.type!=='plan-outcome'||c.request!==request.id||c.plan!==req.plan)continue;
  const prev=latest.get(m.sender);
  if(prev&&(prev.created>m.created||(prev.created===m.created&&prev.id>m.id)))continue;
  latest.set(m.sender,{by:m.sender,outcome:c.outcome,created:m.created,id:m.id});
 }
 return [...latest.values()].sort((a,b)=>a.created-b.created);
}
