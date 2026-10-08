/** Mesh jobs as they cross the encrypted team channel. Who sent one is never
 * read from here: it is the envelope's verified sender device and account. */
export type JobRequest={id:string;title:string;brief:string;workspace:string|null;created:number};
export type JobState='accepted'|'declined'|'started'|'done'|'blocked'|'failed';
export type JobStatus={jobId:string;state:JobState;detail:string;created:number};

export const MAX_JOB_BRIEF=16*1024;
const MAX_JOB_TITLE=120,MAX_JOB_WORKSPACE=200,MAX_JOB_DETAIL=4000;
const STATES:readonly JobState[]=['accepted','declined','started','done','blocked','failed'];
const bytes=(value:string)=>new TextEncoder().encode(value).length;
const isRecord=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const jobId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9-]{8,64}$/.test(value);

export function validJobRequest(value:unknown):value is JobRequest{
 return isRecord(value)&&jobId(value.id)&&typeof value.title==='string'&&value.title.length<=MAX_JOB_TITLE&&
  typeof value.brief==='string'&&value.brief.trim().length>0&&bytes(value.brief)<=MAX_JOB_BRIEF&&
  (value.workspace===null||typeof value.workspace==='string'&&value.workspace.length<=MAX_JOB_WORKSPACE)&&
  Number.isSafeInteger(value.created);
}

export function validJobStatus(value:unknown):value is JobStatus{
 return isRecord(value)&&jobId(value.jobId)&&typeof value.state==='string'&&STATES.includes(value.state as JobState)&&
  typeof value.detail==='string'&&value.detail.length<=MAX_JOB_DETAIL&&Number.isSafeInteger(value.created);
}

export const clipDetail=(text:string)=>text.length>MAX_JOB_DETAIL?`${text.slice(0,MAX_JOB_DETAIL-1)}…`:text;
