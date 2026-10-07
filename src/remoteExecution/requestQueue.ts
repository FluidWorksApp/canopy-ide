/** Share admission across clients for the same endpoint. Keep terminal input,
 * desktop and editor actions ahead of periodic inspections under heavy load. */
export class RequestQueue {
 private active=0;
 private inputQueue?:RequestQueue;
 private waiting:Array<{start:()=>void;priority:number;queuedAt:number}>=[];
 async run<T>(priority:number,task:()=>Promise<T>):Promise<T>{
  // Input has a separate bounded lane: slow inspections must not block typing.
  if(priority===2){
   this.inputQueue??=new RequestQueue();
   return this.inputQueue.run(1,task);
  }
  if(this.waiting.length>=96)throw Error('Workspace is busy. Try again shortly.');
  await new Promise<void>(resolve=>{this.waiting.push({start:resolve,priority,queuedAt:Date.now()});this.pump();});
  try{return await task();}finally{this.active--;this.pump();}
 }
 private pump(){const now=Date.now();this.waiting.sort((a,b)=>Number(now-b.queuedAt>=2000)-Number(now-a.queuedAt>=2000)||b.priority-a.priority||a.queuedAt-b.queuedAt);while(this.active<4&&this.waiting.length){this.active++;this.waiting.shift()!.start();}}
}
const queues=new Map<string,RequestQueue>();
export function requestQueue(endpoint:string){let queue=queues.get(endpoint);if(!queue){queue=new RequestQueue();queues.set(endpoint,queue);}return queue;}
export function requestPriority(route:string,args?:unknown){if(/\/sessions\/\d+\/input$/.test(route))return 2;const command=(args as {command?:string}|undefined)?.command;return command&&['workspace_metrics','session_process_stats','pty_metadata_get','workspace_browser_request','cli_versions','fs_list_dir','git_status','agent_usage'].includes(command)||route.endsWith('/sessions')&&!args?0:1;}
