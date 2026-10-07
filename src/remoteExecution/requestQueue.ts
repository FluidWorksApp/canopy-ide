/** Share admission across clients for the same endpoint. Keep terminal input,
 * desktop and editor actions ahead of periodic inspections under heavy load. */
const BUSY='Workspace is busy. Try again shortly.';
// Periodic inspections retry on their next tick, so a backlog of them is
// dropped rather than queued. Under a slow link they used to fill the queue
// and the request turned away was a terminal reconnect.
const BACKGROUND_WAITING=24;
export class RequestQueue {
 private active=0;
 private inputQueue?:RequestQueue;
 private waiting:Array<{start:()=>void;reject:(error:Error)=>void;priority:number;queuedAt:number}>=[];
 async run<T>(priority:number,task:()=>Promise<T>):Promise<T>{
  // Input has a separate bounded lane: slow inspections must not block typing.
  if(priority===2){
   this.inputQueue??=new RequestQueue();
   return this.inputQueue.run(1,task);
  }
  if(priority===0&&this.waiting.filter(w=>w.priority===0).length>=BACKGROUND_WAITING)throw Error(BUSY);
  if(this.waiting.length>=96){
   // Full: an interactive request takes the place of the oldest queued poll.
   const poll=priority>0?this.waiting.findIndex(w=>w.priority===0):-1;
   if(poll<0)throw Error(BUSY);
   this.waiting.splice(poll,1)[0].reject(Error(BUSY));
  }
  await new Promise<void>((resolve,reject)=>{this.waiting.push({start:resolve,reject,priority,queuedAt:Date.now()});this.pump();});
  try{return await task();}finally{this.active--;this.pump();}
 }
 private pump(){const now=Date.now();this.waiting.sort((a,b)=>Number(now-b.queuedAt>=2000)-Number(now-a.queuedAt>=2000)||b.priority-a.priority||a.queuedAt-b.queuedAt);while(this.active<4&&this.waiting.length){this.active++;this.waiting.shift()!.start();}}
}
const queues=new Map<string,RequestQueue>();
export function requestQueue(endpoint:string){let queue=queues.get(endpoint);if(!queue){queue=new RequestQueue();queues.set(endpoint,queue);}return queue;}
export function requestPriority(route:string,args?:unknown){if(/\/sessions\/\d+\/input$/.test(route))return 2;const command=(args as {command?:string}|undefined)?.command;return command&&['workspace_metrics','session_process_stats','pty_metadata_get','workspace_browser_request','cli_versions','fs_list_dir','git_status','agent_usage'].includes(command)||route.endsWith('/sessions')&&!args?0:1;}
