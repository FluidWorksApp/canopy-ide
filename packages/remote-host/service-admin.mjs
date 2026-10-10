import http from 'node:http';
import {validId} from './policy.mjs';
// Gateway -> canopy-serviced admin API (docs/canopy-service-protocol.md §3),
// HTTP/1.1 over the admin Unix socket. The socket's file mode is the credential.
export const SERVICE_ADMIN_SOCKET='/run/canopy-service/admin.sock';
export class ServiceAdminError extends Error{
 // code: unavailable (no socket/daemon), timeout, rejected (4xx/5xx), invalid-response
 constructor(code,message,{status,body}={}){super(message);this.name='ServiceAdminError';this.code=code;this.status=status;this.body=body;}
}
const requestIdPattern=/^[a-zA-Z0-9:-]{8,128}$/;
const ws=id=>{if(!validId(id))throw new ServiceAdminError('rejected','Invalid service workspace');return encodeURIComponent(id);};
const rid=id=>{if(typeof id!=='string'||!requestIdPattern.test(id))throw new ServiceAdminError('rejected','Invalid terminal request');return encodeURIComponent(id);};
export class ServiceAdmin{
 constructor({socketPath=SERVICE_ADMIN_SOCKET,timeoutMs=5000,maxBytes=4*1024*1024,request=http.request}={}){Object.assign(this,{socketPath,timeoutMs,maxBytes,request});}
 /** One JSON call. Never hangs past timeoutMs; never buffers past maxBytes. */
 call(method,path,payload,{timeoutMs=this.timeoutMs}={}){
  const data=payload===undefined?undefined:Buffer.from(JSON.stringify(payload));
  return new Promise((resolve,reject)=>{
   let settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
   const req=this.request({socketPath:this.socketPath,method,path,headers:{host:'canopy-service',accept:'application/json',...(data?{'content-type':'application/json','content-length':data.length}:{})}},response=>{
    const chunks=[];let size=0;
    response.on('data',chunk=>{size+=chunk.length;if(size>this.maxBytes){req.destroy();finish(new ServiceAdminError('invalid-response','Service response too large',{status:response.statusCode}));return;}chunks.push(chunk);});
    response.on('error',()=>finish(new ServiceAdminError('unavailable','Service connection failed')));
    response.on('end',()=>{
     const text=Buffer.concat(chunks).toString();let body;
     try{body=text?JSON.parse(text):{};}catch{return finish(new ServiceAdminError('invalid-response','Service answered with invalid JSON',{status:response.statusCode}));}
     if(response.statusCode<200||response.statusCode>=300)return finish(new ServiceAdminError('rejected',typeof body?.message==='string'?body.message:typeof body?.error==='string'?body.error:`Service refused (${response.statusCode})`,{status:response.statusCode,body}));
     finish(null,body);
    });
   });
   const timer=setTimeout(()=>{req.destroy();finish(new ServiceAdminError('timeout','Canopy service did not answer in time'));},timeoutMs);
   req.on('error',()=>finish(new ServiceAdminError('unavailable','Canopy service is unavailable')));
   req.end(data);
  });
 }
 /** Raw streaming request (SSE). The caller owns the response and its lifetime. */
 stream(path,{signal,connectTimeoutMs=this.timeoutMs}={}){
  return new Promise((resolve,reject)=>{
   let settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
   const req=this.request({socketPath:this.socketPath,method:'GET',path,headers:{host:'canopy-service',accept:'text/event-stream'},signal},response=>{
    if(response.statusCode!==200){response.resume();return finish(new ServiceAdminError('rejected',`Service refused (${response.statusCode})`,{status:response.statusCode}));}
    finish(null,response);
   });
   const timer=setTimeout(()=>{req.destroy();finish(new ServiceAdminError('timeout','Canopy service did not answer in time'));},connectTimeoutMs);
   req.on('error',()=>finish(new ServiceAdminError('unavailable','Canopy service is unavailable')));
   req.end();
  });
 }
 async health(){return this.call('GET','/admin/health',undefined,{timeoutMs:Math.min(this.timeoutMs,2000)});}
 async registerWorkspace(id,{name,ownerUserId=null,runnerUrl=null,runnerToken}){return this.call('PUT',`/admin/workspaces/${ws(id)}`,{name,ownerUserId,runnerUrl,runnerToken});}
 async deregisterWorkspace(id){return this.call('DELETE',`/admin/workspaces/${ws(id)}`);}
 async mintTerminal(id,{requestId,agent,name,task}){rid(requestId);return this.call('POST',`/admin/workspaces/${ws(id)}/terminals`,{requestId,...(agent?{agent}:{}),...(name?{name}:{}),...(task?{task}:{})});}
 async bindTerminal(id,requestId,{sessionId,pid}){return this.call('POST',`/admin/workspaces/${ws(id)}/terminals/${rid(requestId)}/bind`,{sessionId,pid});}
 async revokeTerminal(id,requestId){return this.call('DELETE',`/admin/workspaces/${ws(id)}/terminals/${rid(requestId)}`);}
 async putAccess(id,snapshot){return this.call('PUT',`/admin/workspaces/${ws(id)}/access`,snapshot);}
 async query(id,body){return this.call('POST',`/admin/workspaces/${ws(id)}/query`,body,{timeoutMs:Math.max(this.timeoutMs,15000)});}
 async action(id,body){return this.call('POST',`/admin/workspaces/${ws(id)}/actions`,body,{timeoutMs:Math.max(this.timeoutMs,15000)});}
 async openStream(id,cursor,options){
  if(cursor!=null&&(typeof cursor!=='string'||!/^[A-Za-z0-9_-]{1,64}:\d{1,16}$/.test(cursor)))throw new ServiceAdminError('rejected','Invalid stream cursor');
  return this.stream(`/admin/workspaces/${ws(id)}/stream${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`,options);
 }
 async device(){return this.call('GET','/admin/device');}
}
