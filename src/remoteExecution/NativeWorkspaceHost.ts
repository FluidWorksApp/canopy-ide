import {READ_ONLY_NATIVE} from '../../packages/remote-host/readonly-native.mjs';
import {takeOutputBatch,type OutputFrame} from './outputBatch';
import type { Host, HostChannel, HostEvent, UnlistenFn } from '../host/contract';
import { nativeHost } from '../host/native';
import { RemoteExecutionClient, type RemoteSession } from './client';
import {connectionKey,reportConnection,reportStream} from './connectionState';
import {saveRemoteContextImage} from './saveContextImage';

export interface WorkspaceConnection { endpoint: string; token: string; workspaceId: string; workspaceName: string; scope?: 'view'|'drive' }
type Args = Record<string, unknown>;
type InputQueue = {data:string; running:boolean; timer?:ReturnType<typeof setTimeout>; waiters:Array<{resolve:()=>void; reject:(error:unknown)=>void}>};
type Stream = { id:number; receivedSnapshot:boolean; pendingExit?:number; socket?: WebSocket; generation: number; cursor: number; frames:OutputFrame[]; queuedBytes:number; busy:boolean; retry?: ReturnType<typeof setTimeout>; handshake?: ReturnType<typeof setTimeout>; channel?: HostChannel<ArrayBuffer>; closed: boolean };
const LOCAL_UI = new Set(['js_log','watchdog_ack','watchdog_incidents','memory_info','selftest_config','set_shortcut_profile','notify_native','set_window_zoom','window_zoom','crash_pending','crash_clear','crash_upload','take_pending_crash','dictation_supported','remote_set_theme','remote_set_clis','remote_set_companion','remote_set_hibernated','remote_set_attention','execution_mode_get','execution_mode_set','execution_remote_get','execution_remote_set']);
// The clipboard and microphone belong to the computer displaying the IDE.
// Remote execution must not redirect their native services into the VM.
for(const command of ['clipboard_image_png','clipboard_watch_set','clipboard_recent','clipboard_read','clipboard_forget','clipboard_clear','clipboard_status','dictation_models','dictation_status','dictation_download','dictation_delete_model','dictation_start','dictation_stop','dictation_cancel'])LOCAL_UI.add(command);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Immutable execution ownership for one renderer. Every execution/file request
 * goes to this workspace; only explicit desktop UI operations stay native. */
export class NativeWorkspaceHost implements Host {
  readonly kind = 'socket' as const;
  get readOnly(){
    if(this.connection.scope)return this.connection.scope==='view';
    try{const value=JSON.parse(atob(this.connection.token.split('.')[0].replace(/-/g,'+').replace(/_/g,'/')));return value.version===2&&value.scope==='view';}catch{return false;}
  }
  readonly connectionClientId = crypto.randomUUID();
  private remoteBrowsers = new Map<string,string>();
  private projectIdle = false;
  private tokenFreshUntil = 0;
  private heartbeat?: ReturnType<typeof setTimeout>;
  setProjectIdle(idle:boolean){this.projectIdle=idle;if(!idle)this.tokenFreshUntil=0;}
  readonly client: RemoteExecutionClient;
  private rendererGeneration = 1;
  private nextStreamGeneration = 1;
  private listeners = new Map<string, Set<(event: HostEvent<unknown>) => void>>();
  private streams = new Map<number, Stream>();
  private metadata: Record<string, Args> = {};
  private disposed = false;
  private onAccountChanged=()=>{this.dispose();reportConnection(connectionKey(this.connection.endpoint,this.connection.workspaceId),'authentication-error');};
  private desktopListeners=new Set<UnlistenFn>();
  private poll?: ReturnType<typeof setTimeout>;
  private agentEventCursor: string | null = null;
  private inputs = new Map<number,InputQueue>();
  private known = new Map<number, RemoteSession>();
  readonly connection: WorkspaceConnection;
  private desktop: Host;
  constructor(connection: WorkspaceConnection, desktop: Host = nativeHost) {
    this.connection = connection; this.desktop = desktop;
    const managed = connection.endpoint === `https://${connection.workspaceId}.workspaces.canopyide.dev`;
    let refreshing: Promise<string> | undefined;
    const resolveToken = async () => {
      if(this.disposed)throw Error('Workspace disconnected. Reopen it from your account.');
      if (this.projectIdle || Date.now() < this.tokenFreshUntil) return connection.token;
      if (!refreshing) refreshing = this.desktop.invoke<{connection:WorkspaceConnection;expiresAt:string}>('canopy_account_request', {
        route:'/api/operations', body:{action:'connect',workspaceId:connection.workspaceId,clientId:this.connectionClientId},
      }).then(async result => {
        if(this.disposed)throw Error('Workspace disconnected');
        if (result.connection.endpoint !== connection.endpoint || result.connection.workspaceId !== connection.workspaceId) throw Error('Workspace connection changed. Reopen it from your account.');
        const expires=Date.parse(result.expiresAt);
        if(!Number.isFinite(expires)||expires<=Date.now()||typeof result.connection.token!=='string'||!result.connection.token)throw Error('Workspace returned an invalid credential');
        connection.token = result.connection.token;connection.scope=result.connection.scope;
        await this.desktop.invoke('execution_remote_set',{connection});
        this.tokenFreshUntil = expires - 60_000;
        return connection.token;
      }).finally(() => {refreshing = undefined;});
      return refreshing;
    };
    this.client = new RemoteExecutionClient(connection.endpoint, connection.token, managed ? resolveToken : async()=>{if(this.disposed)throw Error('Workspace disconnected');return connection.token;});
    if(managed||connection.workspaceId==='shoaib-work')window.addEventListener('canopy:account-changed',this.onAccountChanged);
    if(managed){
      const tick=async()=>{
        try{if(!this.disposed&&!this.projectIdle)await this.call('/open',{});}
        catch{/* Requests report connection failure; never fall back to local execution. */}
        finally{if(!this.disposed)this.heartbeat=setTimeout(()=>void tick(),30_000);}
      };
      this.heartbeat=setTimeout(()=>void tick(),30_000);
    }else if(connection.workspaceId==='shoaib-work'){
      // Legacy EC2 keeps its existing runner credential, but participates in
      // account-side presence so another IDE cannot stop active shared compute.
      const tick=async()=>{
        try{if(!this.disposed&&!this.projectIdle)await this.desktop.invoke('canopy_account_request',{route:'/api/operations',body:{action:'legacy-heartbeat',workspaceId:connection.workspaceId,clientId:this.connectionClientId}});}
        catch{/* Lifecycle actions report failures through the project workflow. */}
        finally{if(!this.disposed)this.heartbeat=setTimeout(()=>void tick(),30_000);}
      };
      this.heartbeat=setTimeout(()=>void tick(),0);
    }
  }
  private async call<T>(route: string, args?: unknown) {if(this.disposed)throw Error('Workspace disconnected');const result=await this.client.workspace<T>(this.connection.workspaceId,route,args);if(this.disposed)throw Error('Workspace disconnected');return result;}
  private emit(event: string, payload: unknown) { this.listeners.get(event)?.forEach(handler => handler({event,id:0,payload})); }
  private summary(session: RemoteSession) {
    const meta=this.metadata[String(session.id)] ?? {};
    return {id:session.id,session_generation:session.id,pid:null,cwd:meta.cwd??'/workspace',title:meta.title??session.title,name:meta.name,cols:session.cols,rows:session.rows,kind:'desktop',project_id:meta.projectId??`remote-${this.connection.workspaceId}`,run:meta.run??session.kind==='build',command:meta.command,run_command_id:meta.runCommandId,generation:1,replay_start:0,replay_end:0};
  }
  private async desktopCall<T>(command:string,args:Args={}){if(this.disposed)throw Error('Workspace disconnected');const result=await this.desktop.invoke<T>(command,args);if(this.disposed)throw Error('Workspace disconnected');return result;}
  private async native<T>(command: string,args: Args={}) {
    const result=await this.call<{result:T}>('/native',{command,args});return result.result;
  }
  private async sessions() {
    const sessions=await this.call<RemoteSession[]>('/sessions');
    for(const session of sessions){
      const old=this.known.get(session.id);
      if(old?.exitCode==null && session.exitCode!=null && old){const stream=this.streams.get(session.id);if(stream){stream.pendingExit=session.exitCode;this.deliver(stream);}else this.emit('pty:exit',{id:session.id,session_generation:session.id,exit_code:session.exitCode});}
      this.known.set(session.id,session);
    }
    return sessions;
  }
  private beginPoll() {
    if(this.poll || this.disposed)return;
    const tick=async()=>{try{await this.sessions();if(this.listeners.get('pty:stats')?.size){try{const stats=await this.invoke('pty_stats');if(!this.disposed)this.emit('pty:stats',stats);}catch{/* Keep file refresh working if process inspection is unavailable. */}}if(this.listeners.get('agent:events')?.size){try{const batch=await this.native<{cursor:string|null;lines:string[]}>('agent_events_poll',{cursor:this.agentEventCursor});if(!this.disposed){this.agentEventCursor=batch.cursor;if(batch.lines.length)this.emit('agent:events',batch.lines);}}catch{/* Keep polling after transient hook transport failures. */}}this.emit('git:change',{root:'/workspace'});this.emit('fs:change',{root:'/workspace',paths:[],kind:'other',overflow:true});}catch{/* Disconnection never falls back to native execution. */}finally{if(!this.disposed)this.poll=setTimeout(()=>void tick(),3000);}};
    this.poll=setTimeout(()=>void tick(),3000);
  }
  private async attach(id:number, channel?:HostChannel<ArrayBuffer>) {
    this.detach(id);
    const stream:Stream={id,receivedSnapshot:false,generation:this.nextStreamGeneration++,cursor:0,frames:[],queuedBytes:0,busy:false,channel,closed:false};
    this.streams.set(id,stream);
    const stateKey=connectionKey(this.connection.endpoint,this.connection.workspaceId);
    reportStream(stateKey,id,false);
    let failures=0;
    const retry=()=>{if(stream.closed)return;clearTimeout(stream.handshake);reportStream(stateKey,id,false);const delay=Math.min(30_000,1000*2**Math.min(failures++,5))+Math.random()*500;stream.retry=setTimeout(()=>void connect(),delay);};
    const connect=async()=>{
      try{
        const url=await this.client.streamUrl(this.connection.workspaceId,`/sessions/${id}/stream`);
        if(stream.closed)return;
        const socket=new WebSocket(url);stream.socket=socket;
        stream.handshake=setTimeout(()=>{if(stream.socket===socket&&socket.readyState===WebSocket.CONNECTING)socket.close();},10_000);
        socket.onopen=()=>{clearTimeout(stream.handshake);if(!stream.closed&&stream.socket===socket)reportStream(stateKey,id,true);};
        socket.onerror=()=>socket.close();
        socket.onmessage=event=>{
          if(stream.closed || stream.socket!==socket)return;
          try{
            const message=JSON.parse(event.data);
            if(message.t==='exit'){stream.pendingExit=message.exitCode;this.deliver(stream);return;}
            if(!['snapshot','data'].includes(message.t))return;
            failures=0;
            const bytes=Uint8Array.from(atob(message.b64),c=>c.charCodeAt(0));
            const reset=message.t==='snapshot' && message.reset===true;
            if(message.t==='snapshot'){stream.frames=[];stream.queuedBytes=0;stream.receivedSnapshot=true;const exitCode=message.exitCode??this.known.get(id)?.exitCode;if(exitCode!=null)stream.pendingExit=exitCode;}
            const frame:OutputFrame={bytes,start:message.start??stream.cursor,end:message.end??(stream.cursor+bytes.length),gap:message.gap??(message.t==='snapshot'&&!reset),reset,cols:message.cols??0,rows:message.rows??0};
            stream.cursor=frame.end;
            if(stream.queuedBytes+bytes.length>512*1024 || stream.frames.length>=1024){stream.frames=[];stream.queuedBytes=0;socket.close();return;}
            stream.frames.push(frame);stream.queuedBytes+=bytes.length;this.deliver(stream);
          }catch{socket.close();}
        };
        socket.onclose=()=>{if(!stream.closed&&stream.socket===socket)retry();};
      }catch{retry();}
    };
    await connect();return stream;
  }
  private take(stream:Stream){if(stream.busy||!stream.frames.length)return null;const frame=takeOutputBatch(stream.frames)!;stream.queuedBytes-=frame.bytes.length;stream.busy=true;return frame;}
  private deliver(stream:Stream){
    // Exit is a barrier after the final output acknowledgement. Term detaches
    // on exit, so emitting it before parsing completes would discard the error.
    if(stream.receivedSnapshot&&!stream.busy&&!stream.frames.length&&stream.pendingExit!=null){const exitCode=stream.pendingExit;stream.pendingExit=undefined;this.emit('pty:exit',{id:stream.id,session_generation:stream.id,exit_code:exitCode});return;}
    if(!stream.channel)return;const data=this.take(stream);if(!data)return;
    const frame=new Uint8Array(32+data.bytes.length),view=new DataView(frame.buffer);
    frame.set([0x43,0x50,0x54,0x32,(data.gap?1:0)|(data.reset?2:0)]);
    view.setUint16(6,data.cols,true);view.setBigUint64(8,BigInt(data.start),true);view.setBigUint64(16,BigInt(data.end),true);view.setUint16(24,data.rows,true);frame.set(data.bytes,32);stream.channel.onmessage(frame.buffer);
  }
  private detach(id:number){const stream=this.streams.get(id);if(!stream)return;stream.closed=true;clearTimeout(stream.retry);clearTimeout(stream.handshake);stream.socket?.close();this.streams.delete(id);reportStream(connectionKey(this.connection.endpoint,this.connection.workspaceId),id,null);}
  private write(id:number,data:string):Promise<void>{
    const queue=this.inputs.get(id)??{data:'',running:false,waiters:[]};
    if(queue.data.length+data.length>32768||queue.waiters.length>=4096)return Promise.reject(Error('Remote terminal input queue is full'));
    this.inputs.set(id,queue);queue.data+=data;
    const done=new Promise<void>((resolve,reject)=>queue.waiters.push({resolve,reject}));
    const flush=async()=>{
      queue.timer=undefined;if(queue.running||this.disposed)return;
      queue.running=true;
      let size=Math.min(2048,queue.data.length);
      if(size<queue.data.length&&queue.data.charCodeAt(size-1)>=0xd800&&queue.data.charCodeAt(size-1)<=0xdbff)size--;
      const batch=queue.data.slice(0,size);queue.data=queue.data.slice(size);
      try{
        await this.call(`/sessions/${id}/input`,{data:batch});
        queue.running=false;
        if(queue.data.length)queue.timer=setTimeout(()=>void flush(),0);
        else{queue.waiters.splice(0).forEach(w=>w.resolve());this.inputs.delete(id);}
      }catch(error){queue.running=false;queue.data='';queue.waiters.splice(0).forEach(w=>w.reject(error));this.inputs.delete(id);}
    };
    if(!queue.running&&!queue.timer)queue.timer=setTimeout(()=>void flush(),10);
    return done;
  }
  async invoke<T>(command:string,args:Args={}):Promise<T>{
    if(this.disposed)throw Error('Workspace disconnected');
    if(this.readOnly&&['spot_save_context_image','spot_stage_drop_images','execution_remote_upload'].includes(command))throw Error('This workspace is read-only');
    let value:unknown;
    if(command==='spot_save_context_image')return await saveRemoteContextImage((command,args)=>this.native(command,args),args.dir,args.base64Png) as T;
    if(command==='chrome_stream_ticket'){
      if(this.readOnly)throw Error('This workspace is read-only');
      const id=this.remoteBrowsers.get(String(args.sessionId));if(!id)throw Error('Unknown workspace preview');
      return await this.client.streamUrl(this.connection.workspaceId,`/browsers/${id}/stream`) as T;
    }
    if(command==='chrome_stream_close'){
      const id=this.remoteBrowsers.get(String(args.sessionId));if(!id)return this.desktopCall<T>(command,args);
      this.remoteBrowsers.delete(String(args.sessionId));return await this.native('workspace_chrome_stream_close',{id}) as T;
    }
    if(command==='chrome_stream_open'){
      const url=new URL(String(args.url));
      if(['localhost','127.0.0.1','0.0.0.0','[::1]'].includes(url.hostname)||url.hostname.endsWith('.localhost')){
        if(this.readOnly)throw Error('This workspace is read-only');
        const result=await this.native<{id:string}>('workspace_chrome_stream_open',args);
        if(!/^[a-f0-9-]{36}$/.test(result.id))throw Error('Invalid workspace preview');
        this.remoteBrowsers.set(String(args.sessionId),result.id);
        return new URL(`/chrome-stream/viewer.html?remote=1&sessionId=${encodeURIComponent(String(args.sessionId))}`,window.location.href).href as T;
      }
      return this.desktopCall<T>(command,args);
    }
    if(command==='spot_stage_drop_images'){await this.call('/resources');return this.desktopCall<T>('execution_remote_stage_images',{...args,workspaceId:this.connection.workspaceId,endpoint:this.connection.endpoint});}
    if(command==='execution_remote_upload')return this.desktopCall<T>(command,{...args,workspaceId:this.connection.workspaceId,endpoint:this.connection.endpoint});
    if(command==='execution_remote_upload_cancel')return this.desktopCall<T>(command,args);
    if(LOCAL_UI.has(command))return this.desktopCall<T>(command,args);
    if(this.readOnly&&!READ_ONLY_NATIVE.has(command)&&!['environment_identity','pty_renderer_register','pty_renderer_sessions','pty_stats'].includes(command))throw Error('This workspace is read-only');
    if(command==='git_clone'){
      let job=await this.native<{id:string;state:string;path:string;name:string;error?:string}>('git_clone_start',args);
      while(true){
        this.emit('git:clone-progress',{...job,parent:args.parent,url:args.url});
        if(job.state==='complete')return {path:job.path,name:job.name} as T;
        if(job.state==='failed'||job.state==='cancelled')throw Error(job.error??'Clone cancelled. Incomplete files were kept.');
        if(this.disposed)throw Error('Workspace disconnected. Clone continues remotely.');
        await new Promise(resolve=>setTimeout(resolve,500));
        job=await this.native('git_clone_status',{id:job.id});
      }
    }
    if(command==='environment_identity')value=`${this.connection.endpoint}/${this.connection.workspaceId}`;
    else if(command==='pty_renderer_register'){
      // Keep the Mac watchdog alive, but never adopt its local processes.
      const registration=await this.desktop.invoke<{generation:number}>('pty_renderer_register');this.rendererGeneration=registration.generation;
      this.metadata=await this.native<Record<string,Args>>('pty_metadata_get');this.beginPoll();
      value={generation:this.rendererGeneration,sessions:(await this.sessions()).filter(s=>s.exitCode==null).map(s=>this.summary(s))};
    }else if(command==='pty_renderer_sessions')value=(await this.sessions()).filter(s=>s.exitCode==null).map(s=>this.summary(s));
    else if(['pty_spawn','pty_spawn_attached_argv','pty_spawn_argv','pty_spawn_detached'].includes(command)){
      const cwd=String(args.cwd??'/workspace');if(cwd!=='/workspace'&&!cwd.startsWith('/workspace/'))throw Error('Choose a directory in the remote workspace');
      const env=(args.env??[]) as [string,string][];
      if(env.some(([key])=>!/^[_A-Za-z][_A-Za-z0-9]*$/.test(key)))throw Error('Invalid environment variable');
      const accountId=env.find(([key])=>key==='CANOPY_ACCOUNT_POOL')?.[1];
      const requested=Array.isArray(args.argv)?(args.argv as string[]).map(quote).join(' '):String(args.runCommand??args.command??args.shell??'/bin/bash');
      const requestId=crypto.randomUUID();
      const commandLine=`cd ${quote(cwd)} && env ${[...env.filter(([key])=>!['CANOPY_ACCOUNT_POOL','CANOPY_SESSION_REQUEST_ID'].includes(key)),['CANOPY_SESSION_REQUEST_ID',requestId]].map(([key,val])=>quote(key+'='+val)).join(' ')} ${requested}`;
      const session=await this.call<RemoteSession>('/sessions',{command:commandLine,kind:args.runCommand?'build':'terminal',accountId,requestId,projectId:args.projectId});
      if(Number(args.cols)>0 && Number(args.rows)>0){
        try{await this.call(`/sessions/${session.id}/resize`,{cols:args.cols,rows:args.rows});session.cols=Number(args.cols);session.rows=Number(args.rows);}
        catch(error){
          // A build can finish before this follow-up resize reaches its PTY.
          // Keep its real output and exit status; it did successfully spawn.
          const completed=(await this.call<RemoteSession[]>('/sessions')).find(s=>s.id===session.id);
          if(!completed||completed.exitCode==null)throw error;
          Object.assign(session,completed);
        }
      }
      this.metadata[String(session.id)]={cwd,projectId:args.projectId,title:args.runCommand??requested,run:!!args.runCommand,runCommandId:args.runCommandId,command:requested,requestId};
      await this.native('pty_metadata_set',{id:session.id,value:this.metadata[String(session.id)]});this.known.set(session.id,session);
      const channel=args.onData as HostChannel<ArrayBuffer>|undefined;
      const stream=channel?await this.attach(session.id,channel):null;
      // The caller already owns the tab. Emitting pty:spawned here races its
      // spawn response and makes App attach a second tab to this same PTY.
      value={...this.summary(session),generation:stream?.generation??null};
    }else if(command==='pty_attach_desktop'){const stream=await this.attach(Number(args.id));const session=(await this.sessions()).find(s=>s.id===args.id);if(!session)throw Error('Remote session not found');value={cols:session.cols,rows:session.rows,generation:stream.generation,replay_start:0,replay_end:0};}
    else if(command==='pty_read_desktop'){const stream=this.streams.get(Number(args.id));if(!stream||stream.generation!==args.generation)throw Error('Remote terminal attachment ended');const frame=this.take(stream);value=frame?{...frame,bytes:[...frame.bytes]}:null;}
    else if(command==='pty_detach_desktop'){const stream=this.streams.get(Number(args.id));if(stream && (args.generation==null||stream.generation===args.generation))this.detach(Number(args.id));}
    else if(command==='pty_ack'){const stream=this.streams.get(Number(args.id));if(stream && stream.generation===args.generation){stream.busy=false;this.deliver(stream);}value=null;}
    else if(command==='pty_write'){await this.write(Number(args.id),String(args.data));}
    else if(command==='pty_resize'){await this.call(`/sessions/${args.id}/resize`,{cols:args.cols,rows:args.rows});value={cols:args.cols,rows:args.rows};}
    else if(command==='pty_kill'){await this.call(`/sessions/${args.id}/stop`,{});}
    else if(['pty_set_name_theme'].includes(command))value=null;
    else if(command==='pty_set_title'||command==='pty_set_name'){const key=command==='pty_set_name'?'name':'title';this.metadata[String(args.id)]={...this.metadata[String(args.id)],[key]:args[key]};await this.native('pty_metadata_set',{id:args.id,value:this.metadata[String(args.id)]});value=args[key];}
    else if(command==='pty_stats'&&this.readOnly)value=[];
    else if(command==='pty_stats'){
      const stats=await this.native<Array<Args&{id:number}>>('session_process_stats',{sessions:(await this.sessions()).filter(session=>session.exitCode==null).map(session=>({...session,requestId:this.metadata[String(session.id)]?.requestId}))});
      value=stats.map(stat=>{const meta=this.metadata[String(stat.id)]??{};return {...stat,cwd:meta.cwd??stat.cwd,title:meta.title??stat.title,name:meta.name};});
    }
    else value=await this.native(command,args);
    if(command==='fs_read_file' && value && typeof value==='object' && 'b64' in value) return Uint8Array.from(atob(String(value.b64)), c=>c.charCodeAt(0)).buffer as T;
    return value as T;
  }
  async listen<T>(event:string,handler:(event:HostEvent<T>)=>void):Promise<UnlistenFn>{
    if(this.disposed)throw Error('Workspace disconnected');
    if(['remote:upload-progress','menu','deep-link','memory:pressure','window:fullscreen','clipboard:changed','clipboard:blocked','dictation:progress','dictation:partial','dictation:level'].includes(event)){const release=await this.desktop.listen<T>(event,value=>{if(!this.disposed)handler(value);});if(this.disposed){release();return()=>{};}const cancel=()=>{this.desktopListeners.delete(cancel);release();};this.desktopListeners.add(cancel);return cancel;}
    const list=this.listeners.get(event)??new Set();this.listeners.set(event,list);list.add(handler as (event:HostEvent<unknown>)=>void);this.beginPoll();return ()=>{list.delete(handler as (event:HostEvent<unknown>)=>void);};
  }
  channel<T>():HostChannel<T>{return {onmessage:()=>{}};}
  dispose(){this.disposed=true;for(const release of [...this.desktopListeners]){try{release();}catch{/* Disposed handlers stay inert even if native teardown fails. */}}this.desktopListeners.clear();window.removeEventListener('canopy:account-changed',this.onAccountChanged);clearTimeout(this.heartbeat);for(const queue of this.inputs.values()){clearTimeout(queue.timer);queue.waiters.splice(0).forEach(w=>w.reject(Error('Workspace disconnected')));}this.inputs.clear();clearTimeout(this.poll);for(const id of this.streams.keys())this.detach(id);this.listeners.clear();}
}
