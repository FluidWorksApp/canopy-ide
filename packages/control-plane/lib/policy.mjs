import {createHash,randomBytes} from 'node:crypto';
export const tokenHash=value=>createHash('sha256').update(value).digest('hex');
export const newDeviceToken=()=>randomBytes(48).toString('base64url');
export function workspaceName(value){if(typeof value!=='string'||!value.trim()||value.trim().length>80)throw Error('Choose a workspace name between 1 and 80 characters');return value.trim();}
export function canSleepHost({now,lastHeartbeatAt,lastActiveAt,idleTimeoutSeconds,autoSleepEnabled,connectedLeases,activeJobs,activeAgents,unknownActivity}){
 if(!autoSleepEnabled||unknownActivity||connectedLeases>0||activeJobs>0||activeAgents>0)return false;
 if(!Number.isFinite(lastHeartbeatAt)||now-lastHeartbeatAt>90000||now<lastHeartbeatAt)return false;
 if(!Number.isFinite(lastActiveAt)||now<lastActiveAt)return false;
 return now-lastActiveAt>=idleTimeoutSeconds*1000;
}
export function validatedUsage(value){
 if(!value||!['claude','codex','opencode','omp'].includes(value.agent)||typeof value.sessionId!=='string'||!value.sessionId||value.sessionId.length>200)throw Error('Invalid agent usage');
 const result={agent:value.agent,sessionId:value.sessionId,model:typeof value.model==='string'?value.model.slice(0,120):null};
 for(const key of ['inputTokens','outputTokens','cacheReadTokens','cacheCreationTokens','activeSeconds']){const number=value[key]??0;if(!Number.isSafeInteger(number)||number<0)throw Error('Invalid usage counter');result[key]=number;}
 return result; // Allowlist strips transcript text, paths and credentials.
}
