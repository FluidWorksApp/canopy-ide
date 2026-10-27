/** Mesh jobs as they cross the encrypted team channel. Who sent one is never
 * read from here: it is the envelope's verified sender device and account. */
import {validCardPath,validRepo,validSlug} from './cardSchema';
/** Which agent in the target workspace takes a job or message (protocol §6.1). */
export type AgentTarget={ptyId:number}|{name:string};
/** A repository a job is about, as its origin remote names it: host and
 *  `owner/name`, never a local path. `host` is absent when the sender named
 *  only `owner/name` and had no checkout of it to take the host from. */
export type JobRepo={host?:string;slug:string};
/** Which project a job belongs in, by repository identity alone: the first
 *  repo is where it runs, the rest are others its brief also touches. `path`
 *  is the folder inside the first repo the sender worked in (repo-relative,
 *  never absolute); `branch` the sender's branch there, informational only.
 *  Optional on the wire: an older sender sends none, an older receiver ignores it. */
export type JobScope={repos:JobRepo[];path?:string;branch?:string};
export type JobRequest={id:string;title:string;brief:string;workspace:string|null;created:number;target?:AgentTarget;scope?:JobScope};
export const MAX_SCOPE_REPOS=5;
const MAX_SCOPE_BRANCH=200;
export type JobState='accepted'|'declined'|'refused'|'started'|'done'|'blocked'|'failed'|'interrupted';
export type JobStatus={jobId:string;state:JobState;detail:string;created:number};

export const MAX_JOB_BRIEF=16*1024;
const MAX_JOB_TITLE=120,MAX_JOB_WORKSPACE=200,MAX_JOB_DETAIL=4000;
const STATES:readonly JobState[]=['accepted','declined','refused','started','done','blocked','failed','interrupted'];
const bytes=(value:string)=>new TextEncoder().encode(value).length;
const isRecord=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const jobId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9-]{8,64}$/.test(value);

export function validJobRequest(value:unknown):value is JobRequest{
 return isRecord(value)&&jobId(value.id)&&typeof value.title==='string'&&value.title.length<=MAX_JOB_TITLE&&
  typeof value.brief==='string'&&value.brief.trim().length>0&&bytes(value.brief)<=MAX_JOB_BRIEF&&
  (value.workspace===null||typeof value.workspace==='string'&&value.workspace.length<=MAX_JOB_WORKSPACE)&&
  Number.isSafeInteger(value.created)&&(value.target===undefined||validTarget(value.target))&&
  (value.scope===undefined||validJobScope(value.scope));
}
export function validJobRepo(value:unknown):value is JobRepo{
 if(!isRecord(value))return false;
 if(value.host===undefined)return Object.keys(value).every(k=>k==='slug')&&validSlug(value.slug);
 return validRepo(value);
}
export function validJobScope(value:unknown):value is JobScope{
 if(!isRecord(value)||!Object.keys(value).every(k=>k==='repos'||k==='path'||k==='branch'))return false;
 const {repos,path,branch}=value;
 return Array.isArray(repos)&&repos.length>=1&&repos.length<=MAX_SCOPE_REPOS&&repos.every(validJobRepo)&&
  (path===undefined||validCardPath(path)&&bytes(path)<=300)&&
  (branch===undefined||typeof branch==='string'&&branch.length>0&&branch.length<=MAX_SCOPE_BRANCH&&!/[\s\x00-\x1f\x7f]/.test(branch));
}
export function validTarget(value:unknown):value is AgentTarget{
 if(!isRecord(value))return false;const keys=Object.keys(value);
 return keys.length===1&&(Number.isSafeInteger(value.ptyId)&&(value.ptyId as number)>=0||typeof value.name==='string'&&value.name.trim().length>0&&value.name.length<=200);
}

export function validJobStatus(value:unknown):value is JobStatus{
 return isRecord(value)&&jobId(value.jobId)&&typeof value.state==='string'&&STATES.includes(value.state as JobState)&&
  typeof value.detail==='string'&&value.detail.length<=MAX_JOB_DETAIL&&Number.isSafeInteger(value.created);
}

export const clipDetail=(text:string)=>text.length>MAX_JOB_DETAIL?`${text.slice(0,MAX_JOB_DETAIL-1)}…`:text;

/** An agent message to a workspace's service, and the service's refusal of one.
 *  `from.name` is the sending agent's display name, shown to the receiver; a
 *  reply from a service names `replyTo`, and its `target` is `{ptyId:0}`. A
 *  `failed` status means it was admitted but could not be delivered. */
export type MeshMessage={id:string;text:string;target:AgentTarget;replyTo?:string;created:number;from?:{name:string}};
export type MeshStatus={messageId:string;state:'refused'|'failed';detail:string;created:number};
export const MAX_MESH_TEXT=16*1024;
const MAX_FROM_NAME=60;
export function validMeshMessage(value:unknown):value is MeshMessage{
 return isRecord(value)&&typeof value.id==='string'&&/^[A-Za-z0-9-]{8,64}$/.test(value.id)&&typeof value.text==='string'&&value.text.trim().length>0&&bytes(value.text)<=MAX_MESH_TEXT&&
  validTarget(value.target)&&(value.replyTo===undefined||typeof value.replyTo==='string'&&value.replyTo.length<=64)&&Number.isSafeInteger(value.created)&&
  (value.from===undefined||isRecord(value.from)&&typeof value.from.name==='string'&&value.from.name.length<=MAX_FROM_NAME);
}
export function validMeshStatus(value:unknown):value is MeshStatus{
 return isRecord(value)&&typeof value.messageId==='string'&&/^[A-Za-z0-9-]{8,64}$/.test(value.messageId)&&(value.state==='refused'||value.state==='failed')&&typeof value.detail==='string'&&value.detail.length<=MAX_JOB_DETAIL&&Number.isSafeInteger(value.created);
}

/** Who is running in a cloud workspace: asked of its service, answered with
 *  the same agents its own canopy_agents lists (protocol §6.1). */
export type RosterRequest={id:string;created:number};
/** `repo` (its origin remote), `root` (its checkout) and `files` (repo-relative,
 *  newest first, `ts` in ms) come from a current service; awareness matches
 *  cloud agents to a repository by them. */
export type RosterAgent={ptyId:number;name:string|null;agent:string|null;task:string|null;status:{title:string|null;description:string|null}|null;closing:boolean;repo?:string|null;root?:string|null;files?:{path:string;ts:number}[]};
export type Roster={requestId:string;agents:RosterAgent[];created:number};
const MAX_ROSTER=50,MAX_ROSTER_FILES=20;
const optText=(value:unknown,n:number)=>value===null||value===undefined||typeof value==='string'&&value.length<=n;
export function validRosterRequest(value:unknown):value is RosterRequest{
 return isRecord(value)&&jobId(value.id)&&Number.isSafeInteger(value.created);
}
function validRosterAgent(value:unknown):value is RosterAgent{
 if(!isRecord(value)||!Number.isSafeInteger(value.ptyId)||(value.ptyId as number)<1)return false;
 const status=value.status;
 return optText(value.name,80)&&optText(value.agent,40)&&optText(value.task,200)&&(value.closing===undefined||typeof value.closing==='boolean')&&
  (status===null||status===undefined||isRecord(status)&&optText(status.title,120)&&optText(status.description,200))&&
  optText(value.repo,300)&&optText(value.root,300)&&
  (value.files===undefined||Array.isArray(value.files)&&value.files.length<=MAX_ROSTER_FILES&&value.files.every(f=>isRecord(f)&&typeof f.path==='string'&&f.path.length<=300&&Number.isSafeInteger(f.ts)));
}
export function validRoster(value:unknown):value is Roster{
 return isRecord(value)&&jobId(value.requestId)&&Array.isArray(value.agents)&&value.agents.length<=MAX_ROSTER&&value.agents.every(validRosterAgent)&&Number.isSafeInteger(value.created);
}
