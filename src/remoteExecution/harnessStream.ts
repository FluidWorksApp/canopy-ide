// A cloud workspace's Canopy service owns its mesh, notes, research and
// attention (canopy-service-protocol.md §5). This subscribes to it through the
// workspace gateway and mirrors what it reports into the IDE's stores, keyed by
// service, workspace and item id so it unions with local state.
//
// The cursor survives reconnects; the service answers an unknown, stale or
// other-epoch cursor with a fresh snapshot, and a slow subscriber is told to
// `resnapshot`, which reconnects without one. A change names a store and
// scope; the store is re-read through the query route rather than trusted.
import {postAttention,resolveAttentionByKey} from '../attention';
import {HARNESS_STORES,forgetRemoteSource,remoteItems,setRemoteStore,workspaceProjectId,type HarnessStoreName} from './harnessStores';

export interface HarnessTransport {
 open(id:string,route:string,signal:AbortSignal):Promise<Response>;
 workspace<T>(id:string,route:string,args?:unknown):Promise<T>;
}
type Snapshot={cursor:string;stores:Partial<Record<HarnessStoreName,unknown>>};
type Change={cursor:string;store:HarnessStoreName;scope?:string;id?:string};
const CURSOR=/^[A-Za-z0-9_-]{1,64}:\d{1,20}$/;
const isStore=(value:unknown):value is HarnessStoreName=>HARNESS_STORES.includes(value as HarnessStoreName);

/** Parses `text/event-stream` frames from a byte stream. */
export async function* sseEvents(body:ReadableStream<Uint8Array>):AsyncGenerator<{event:string;data:string}>{
 const reader=body.getReader(),decoder=new TextDecoder();let buffer='';
 try{
  for(;;){
   const {value,done}=await reader.read();if(done)return;
   buffer+=decoder.decode(value,{stream:true}).replace(/\r\n?/g,'\n');
   if(buffer.length>4*1024*1024)throw Error('Harness event too large');
   let end;
   while((end=buffer.indexOf('\n\n'))>=0){
    const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
    let event='message';const data:string[]=[];
    for(const line of frame.split('\n')){
     if(!line||line.startsWith(':'))continue;
     const i=line.indexOf(':'),field=i<0?line:line.slice(0,i),raw=i<0?'':line.slice(i+1).replace(/^ /,'');
     if(field==='event')event=raw;else if(field==='data')data.push(raw);
    }
    if(data.length)yield {event,data:data.join('\n')};
   }
  }
 }finally{reader.releaseLock();}
}

/** Questions and FYIs a remote service holds become attention items; resolving
 *  there resolves here. Answering goes back through `action('answer')`. */
function syncAttention(service:string,workspace:string,name:string|undefined){
 for(const {item} of remoteItems<{id:string;kind?:string;title?:string;body?:string;resolution?:unknown}>('attention',workspaceProjectId(workspace)).filter(r=>r.service===service)){
  const dedupeKey=`remote:${service}:${workspace}:${item.id}`;
  if(item.resolution){resolveAttentionByKey(dedupeKey,'answered');continue;}
  if(typeof item.title!=='string')continue;
  postAttention({kind:item.kind==='question'?'question':'fyi',tone:'info',source:'agent',title:item.title.slice(0,300),...(typeof item.body==='string'?{body:item.body.slice(0,4000)}:{}),projectId:workspaceProjectId(workspace),...(name?{projectName:name}:{}),dedupeKey});
 }
}

export class HarnessStream {
 private cursor:string|null=null;
 private controller?:AbortController;
 private stopped=false;
 private retry=0;
 private timer?:ReturnType<typeof setTimeout>;
 private readonly transport:HarnessTransport;
 private readonly workspace:string;
 private readonly service:string;
 private readonly name?:string;
 private readonly sleep:(ms:number)=>Promise<void>;
 constructor(transport:HarnessTransport,workspace:string,options:{service?:string;name?:string;sleep?:(ms:number)=>Promise<void>}={}){
  this.transport=transport;this.workspace=workspace;this.service=options.service??workspace;this.name=options.name;
  this.sleep=options.sleep??(ms=>new Promise(resolve=>{this.timer=setTimeout(resolve,ms);}));
 }
 /** The last applied position, `<epoch>:<seq>`. */
 position(){return this.cursor;}
 start(){void this.run();return this;}
 stop(){this.stopped=true;clearTimeout(this.timer);this.controller?.abort();forgetRemoteSource(this.service,this.workspace);}
 query<T>(store:HarnessStoreName,action:string,args:Record<string,unknown>={}){return this.transport.workspace<T>(this.workspace,'/harness/query',{store,action,args});}
 action<T>(kind:'answer'|'attention_ack'|'notes_write'|'research_write',args:Record<string,unknown>){return this.transport.workspace<T>(this.workspace,'/harness/actions',{kind,...args});}
 private async run(){
  while(!this.stopped){
   try{await this.connect();this.retry=0;}
   catch{if(this.stopped)return;this.retry=Math.min(this.retry+1,6);}
   if(this.stopped)return;
   await this.sleep(this.retry?Math.min(30_000,500*2**this.retry):250);
  }
 }
 private async connect(){
  const controller=new AbortController();this.controller=controller;
  const route=`/harness/stream${this.cursor?`?cursor=${encodeURIComponent(this.cursor)}`:''}`;
  const response=await this.transport.open(this.workspace,route,controller.signal);
  // A gateway from before the service has no such route: stay quiet rather than poll it.
  if(response.status===404){this.stopped=true;return;}
  if(!response.ok||!response.body)throw Error(`Harness stream unavailable (${response.status})`);
  for await(const {event,data} of sseEvents(response.body)){
   if(this.stopped)return;
   if(event==='resnapshot'){this.cursor=null;controller.abort();return;}
   let value:unknown;try{value=JSON.parse(data);}catch{continue;}
   if(event==='snapshot')this.snapshot(value as Snapshot);
   else if(event==='change')await this.change(value as Change);
  }
 }
 private snapshot(value:Snapshot){
  if(!value||typeof value.cursor!=='string'||!CURSOR.test(value.cursor)||!value.stores||typeof value.stores!=='object')throw Error('Invalid harness snapshot');
  for(const store of HARNESS_STORES)setRemoteStore(this.service,this.workspace,store,value.stores[store]??[]);
  syncAttention(this.service,this.workspace,this.name);
  this.cursor=value.cursor;
 }
 private async change(value:Change){
  if(!value||typeof value.cursor!=='string'||!CURSOR.test(value.cursor)||!isStore(value.store))throw Error('Invalid harness change');
  const rows=await this.query<unknown>(value.store,'list',{scope:value.scope??null});
  if(this.stopped)return;
  setRemoteStore(this.service,this.workspace,value.store,rows);
  if(value.store==='attention')syncAttention(this.service,this.workspace,this.name);
  this.cursor=value.cursor;
 }
}
