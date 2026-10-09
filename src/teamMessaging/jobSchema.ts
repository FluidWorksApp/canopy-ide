/** Mesh jobs as they cross the encrypted team channel. Who sent one is never
 * read from here: it is the envelope's verified sender device and account. */
/** Which agent in the target workspace takes a job or message (protocol §6.1). */
export type AgentTarget={ptyId:number}|{name:string};
export type JobRequest={id:string;title:string;brief:string;workspace:string|null;created:number;target?:AgentTarget};
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
  Number.isSafeInteger(value.created)&&(value.target===undefined||validTarget(value.target));
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

/** An agent message to a workspace's service, and the service's refusal of one. */
export type MeshMessage={id:string;text:string;target:AgentTarget;replyTo?:string;created:number};
export type MeshStatus={messageId:string;state:'refused';detail:string;created:number};
export const MAX_MESH_TEXT=16*1024;
export function validMeshMessage(value:unknown):value is MeshMessage{
 return isRecord(value)&&typeof value.id==='string'&&/^[A-Za-z0-9-]{8,64}$/.test(value.id)&&typeof value.text==='string'&&value.text.trim().length>0&&bytes(value.text)<=MAX_MESH_TEXT&&
  validTarget(value.target)&&(value.replyTo===undefined||typeof value.replyTo==='string'&&value.replyTo.length<=64)&&Number.isSafeInteger(value.created);
}
export function validMeshStatus(value:unknown):value is MeshStatus{
 return isRecord(value)&&typeof value.messageId==='string'&&/^[A-Za-z0-9-]{8,64}$/.test(value.messageId)&&value.state==='refused'&&typeof value.detail==='string'&&value.detail.length<=MAX_JOB_DETAIL&&Number.isSafeInteger(value.created);
}
