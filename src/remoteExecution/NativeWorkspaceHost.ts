import {READ_ONLY_NATIVE} from '../../packages/remote-host/readonly-native.mjs';
import {takeOutputBatch,type OutputFrame} from './outputBatch';
import type { Host, HostChannel, HostEvent, UnlistenFn } from '../host/contract';
import { nativeHost } from '../host/native';
import { RemoteExecutionClient, type RemoteSession } from './client';
import {connectionKey,reportConnection,reportStream,workspaceLifecyclePhase} from './connectionState';
import {saveRemoteContextImage} from './saveContextImage';
import {TerminalInput} from './terminalInput';
import {canSwitchExecutionMode} from '../executionMode';
import {remoteDiagnostic} from './remoteDiagnostic';
import type {ClaudeIdeEvent} from '../claudeIde';
import {HOST_PROTOCOL} from '../../packages/remote-host/native-commands.mjs';
import {HARNESS_READS,harnessCommand,isHarnessCommand,isOutdatedHarnessError} from './harnessCommands';
import {HOST_OUTDATED_EVENT,hostOutdatedMessage,isRemoteUnsupported,outdatedHostCommand,remoteUnsupportedMessage} from './remoteSupport';

export interface WorkspaceConnection { endpoint: string; token: string; workspaceId: string; workspaceName: string; scope?: 'view'|'drive'; clientId?: string; expiresAt?: string; credentialAccountKey?: string }
type Args = Record<string, unknown>;
type Stream = { id:number; receivedSnapshot:boolean; pendingExit?:number; socket?: WebSocket; generation: number; cursor: number; frames:OutputFrame[]; queuedBytes:number; busy:boolean; retry?: ReturnType<typeof setTimeout>; kick?: ()=>void; kickedAt?: number; handshake?: ReturnType<typeof setTimeout>; channel?: HostChannel<ArrayBuffer>; closed: boolean };
const LOCAL_UI = new Set(['js_log','watchdog_ack','watchdog_incidents','memory_info','selftest_config','set_shortcut_profile','notify_native','set_window_zoom','window_zoom','crash_pending','crash_clear','crash_upload','take_pending_crash','dictation_supported','remote_set_theme','remote_set_clis','remote_set_companion','remote_set_hibernated','remote_set_attention','execution_mode_get','execution_mode_set','execution_remote_get','execution_remote_set']);
// The clipboard and microphone belong to the computer displaying the IDE.
// Remote execution must not redirect their native services into the VM.
for(const command of ['clipboard_image_png','clipboard_write_text','clipboard_read_text','clipboard_watch_set','clipboard_recent','clipboard_read','clipboard_forget','clipboard_clear','clipboard_status','dictation_models','dictation_status','dictation_download','dictation_delete_model','dictation_start','dictation_stop','dictation_cancel'])LOCAL_UI.add(command);
// The Playwright extension token unlocks this computer's Chrome, which is the
// one the desktop's Chrome bridge connects to; it never belongs in the VM.
for(const command of ['chrome_extension_token_status','chrome_extension_token_set','chrome_extension_token_clear','chrome_extension_open_status'])LOCAL_UI.add(command);
// The scratchpad is the person's own thoughts and screenshots, kept on the
// computer showing the IDE like the clipboard; the workspace has no notes store
// (it answered "does not support notes_create"). Attaching a file stays with the
// workspace: its path names a workspace file this computer cannot read.
for(const command of ['notes_list','notes_due','notes_get','notes_create','notes_update','notes_add_attachment','notes_set_status','notes_link','notes_read_file','notes_read_image','notes_dir','notes_remind','notes_search','notes_delete'])LOCAL_UI.add(command);
// The companion floats over the app and belongs to no project, so its CLI runs
// on the computer showing the IDE in every mode. Its canopy_* tools reach the
// desktop's context bridge, which publishes ops to this window and waits for
// the answer; the answers then act on the workspace through this host.
export const COMPANION_DESKTOP_COMMANDS=['companion_spawn','companion_write','companion_kill','companion_status','companion_store_read','companion_store_write','companion_save_attachment','companion_dispatch_origin','companion_open_requests','context_publish','context_remove','context_tools','context_agent_spawn_ready','browser_result','webview_snapshot'] as const;
for(const command of COMPANION_DESKTOP_COMMANDS)LOCAL_UI.add(command);
// The bridge's requests to this window, and the companion's replies. An op from
// a terminal on this computer is dropped: its pty id would alias a VM session's.
export const COMPANION_DESKTOP_EVENTS=['agent:ui','agent:action','agent:browser','companion:reply'] as const;
// The signed-in account, crash reports and the remote portal belong to this
// computer; the workspace has none of them.
for(const command of ['canopy_account_request','report_crash','send_crash','crash_issue_draft','file_crash_issue','remote_status','remote_enable','remote_disable','remote_qr','remote_rotate_pin','remote_socket_metrics'])LOCAL_UI.add(command);
// The person's credential vault is theirs, on this computer, and fills pages
// shown here; it never moves into a workspace.
for(const command of ['vault_status','vault_create','vault_unlock','vault_lock','vault_change_passphrase','vault_list','vault_matches','vault_save','vault_delete','vault_reveal','vault_read','vault_fill','vault_import_kdbx','vault_approvals','vault_approve','vault_revoke'])LOCAL_UI.add(command);
// Android phones and emulators are attached to this computer, and the VM image
// has no Android SDK, so device tools act on this computer's devices.
for(const command of ['android_sdk_status','android_devices','android_avds','android_emulator_start','android_emulator_stop','android_screencap','android_ui_dump','android_layout','android_foreground','android_tap','android_text','android_swipe','android_key','android_logcat','android_run','android_describe'])LOCAL_UI.add(command);
// The LAN relay is hosted by the desktop app between people's computers; its
// file offers use this computer's dialogs and paths. Its status goes with it.
for(const command of ['relay_status','relay_host_start','relay_host_stop','relay_regenerate_code','relay_connect','relay_disconnect','relay_send_chat','relay_send_collab','relay_send_command','relay_offer_file','relay_accept_file'])LOCAL_UI.add(command);
// Public links expose this computer's own portal port (tunnel.rs); Linear is a
// plain HTTPS API called with a key from this computer's settings.
for(const command of ['tunnel_start','tunnel_stop','tunnel_status','linear_issues','linear_issue_detail','linear_issue_set_state','linear_issue_comment'])LOCAL_UI.add(command);
// This app's own diagnostics, self-test harness, `canopy` launcher, and
// workspace files chosen in this computer's save/open dialogs.
for(const command of ['process_capture_metrics','snapshot_capture_metrics','browser_close_metrics','browser_pressure_reload_metrics','selftest_checkpoint','selftest_checkpoint_save','selftest_finish','selftest_reload_renderer','selftest_spawn_remote','selftest_store_contains','cli_install_shim','workspace_export','workspace_import'])LOCAL_UI.add(command);
/** Desktop events that belong to the commands above. */
const DESKTOP_EVENTS=['relay:state','relay:chat','relay:command','relay:collab','relay:transfer','relay:transfer-progress','tunnel:state'];
/** Commands this adapter answers itself (below) rather than passing to the
 *  host by name: terminals, browser streams, uploads and clone progress. */
export const WORKSPACE_ADAPTER_COMMANDS=['spot_save_context_image','notes_attach_file','spot_stage_drop_images','chrome_stream_ticket','chrome_stream_close','chrome_stream_open','execution_remote_upload','execution_remote_upload_cancel','git_clone','browser_supported','environment_identity','pty_renderer_register','pty_renderer_sessions','instance_id','pty_spawn','pty_spawn_attached_argv','pty_spawn_argv','pty_spawn_detached','pty_attach_desktop','pty_read_desktop','pty_detach_desktop','pty_ack','pty_write_binary','pty_write','pty_resize','pty_kill','pty_set_name_theme','cli_set_native_update_env','pty_set_title','pty_set_name','pty_stats'] as const;
/** Whether a command runs on the computer showing the IDE in remote mode. */
export const isDesktopLocal=(command:string)=>LOCAL_UI.has(command);
class WorkspaceChannel<T> implements HostChannel<T>{onmessage:(message:T)=>void=()=>{};}
// Recovery reads share routes with background polls; they must not wait in that lane.
const INTERACTIVE=1;
/** claudeIde.ts CLAUDE_IDE_MARKER, spelled out so the host does not load the
 *  IDE module's settings and harness graph before it is installed. */
export const CLAUDE_IDE_MARKER='CANOPY_CLAUDE_IDE';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Immutable execution ownership for one renderer. Every execution/file request
 * goes to this workspace; only explicit desktop UI operations stay native. */
export class NativeWorkspaceHost implements Host {
  readonly kind = 'socket' as const;
  get readOnly(){
    if(this.connection.scope)return this.connection.scope==='view';
    try{const value=JSON.parse(atob(this.connection.token.split('.')[0].replace(/-/g,'+').replace(/_/g,'/')));return value.version===2&&value.scope==='view';}catch{return false;}
  }
  // The first connect already named this IDE connection; keep that identity
  // so member token renewals match the lease the control plane issued.
  get connectionClientId(){return this.connection.clientId??(this.connection.clientId=crypto.randomUUID());}
  private remoteBrowsers = new Map<string,string>();
  private projectIdle = false;
  private tokenFreshUntil = 0;
  private heartbeat?: ReturnType<typeof setTimeout>;
  private get stopping(){return !!workspaceLifecyclePhase(connectionKey(this.connection.endpoint,this.connection.workspaceId));}
  setProjectIdle(idle:boolean){this.projectIdle=idle;if(!idle)this.tokenFreshUntil=0;}
  /** An explicit retry. An idle member connection holds an expired token and a
   * disposed adapter can never send again, so retrying either must renew. */
  async reconnect(){
    if(this.disposed){
      if(!canSwitchExecutionMode())throw Error('Save or close unsaved files, then retry to reconnect.');
      window.location.reload();return;
    }
    this.setProjectIdle(false);
    await this.client.workspace(this.connection.workspaceId,'/open',{resume:true});
  }
  readonly client: RemoteExecutionClient;
  private rendererGeneration = 1;
  private nextStreamGeneration = 1;
  private listeners = new Map<string, Set<(event: HostEvent<unknown>) => void>>();
  private streams = new Map<number, Stream>();
  private metadata: Record<string, Args> = {};
  private disposed = false;
  /** The workspace service's harness subscription (harnessStream.ts), while connected. */
  harness?: {stop():void};
  private onAccountChanged=()=>{this.dispose();reportConnection(connectionKey(this.connection.endpoint,this.connection.workspaceId),'authentication-error');};
  private desktopListeners=new Set<UnlistenFn>();
  private poll?: ReturnType<typeof setTimeout>;
  private agentEventCursor: string | null = null;
  private inputs = new Map<number,TerminalInput>();
  private known = new Map<number, RemoteSession>();
  readonly connection: WorkspaceConnection;
  private desktop: Host;
  constructor(connection: WorkspaceConnection, desktop: Host = nativeHost) {
    this.connection = connection; this.desktop = desktop;
    const managed = connection.endpoint === `https://${connection.workspaceId}.workspaces.canopyide.dev`;
    let refreshing: Promise<string> | undefined;
    let savedFreshness: Promise<void> | undefined;
    // A failed check must not be memoized: every later request would fail on it
    // without ever reaching the network, leaving the workspace stuck reconnecting.
    const checkSavedFreshness = () => savedFreshness ??= (async () => {
      const expires=Date.parse(connection.expiresAt??'');
      if(!connection.credentialAccountKey||!Number.isFinite(expires)||expires-60_000<=Date.now())return;
      const key=await this.desktop.invoke<string|null>('canopy_account_cache_key');
      if(this.disposed)throw Error('Workspace disconnected');
      if(key===connection.credentialAccountKey)this.tokenFreshUntil=expires-60_000;
    })().catch(error=>{savedFreshness=undefined;throw error;});
    const resolveToken = async () => {
      if(this.disposed)throw Error('Workspace disconnected. Reopen it from your account.');
      await checkSavedFreshness();
      if (this.projectIdle || Date.now() < this.tokenFreshUntil) return connection.token;
      if (!refreshing) refreshing = this.desktop.invoke<{connection:WorkspaceConnection;expiresAt:string}>('canopy_account_request', {
        route:'/api/operations', body:{action:'connect',workspaceId:connection.workspaceId,clientId:this.connectionClientId},
      }).then(async result => {
        if(this.disposed)throw Error('Workspace disconnected');
        if (result.connection.endpoint !== connection.endpoint || result.connection.workspaceId !== connection.workspaceId) throw Error('Workspace connection changed. Reopen it from your account.');
        const expires=Date.parse(result.expiresAt);
        if(!Number.isFinite(expires)||expires<=Date.now()||typeof result.connection.token!=='string'||!result.connection.token)throw Error('Workspace returned an invalid credential');
        const accountKey=await this.desktop.invoke<string|null>('canopy_account_cache_key');
        if(this.disposed)throw Error('Workspace disconnected');
        connection.token = result.connection.token;connection.scope=result.connection.scope;
        connection.expiresAt=result.expiresAt;connection.credentialAccountKey=accountKey??undefined;
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
        try{if(!this.disposed&&!this.projectIdle&&!this.stopping)await this.call('/open',{});}
        catch{/* Requests report connection failure; never fall back to local execution. */}
        finally{if(!this.disposed)this.heartbeat=setTimeout(()=>void tick(),30_000);}
      };
      this.heartbeat=setTimeout(()=>void tick(),30_000);
    }else if(connection.workspaceId==='shoaib-work'){
      // Legacy EC2 keeps its existing runner credential, but participates in
      // account-side presence so another IDE cannot stop active shared compute.
      const tick=async()=>{
        try{if(!this.disposed&&!this.projectIdle&&!this.stopping)await this.desktop.invoke('canopy_account_request',{route:'/api/operations',body:{action:'legacy-heartbeat',workspaceId:connection.workspaceId,clientId:this.connectionClientId}});}
        catch{/* Lifecycle actions report failures through the project workflow. */}
        finally{if(!this.disposed)this.heartbeat=setTimeout(()=>void tick(),30_000);}
      };
      this.heartbeat=setTimeout(()=>void tick(),0);
    }
  }
  private async call<T>(route: string, args?: unknown, priority?: number) {if(this.disposed)throw Error('Workspace disconnected');const result=await this.client.workspace<T>(this.connection.workspaceId,route,args,priority);if(this.disposed)throw Error('Workspace disconnected');return result;}
  private emit(event: string, payload: unknown) { this.listeners.get(event)?.forEach(handler => handler({event,id:0,payload})); }
  private summary(session: RemoteSession) {
    const meta=this.metadata[String(session.id)] ?? {};
    return {id:session.id,session_generation:session.id,pid:null,cwd:meta.cwd??'/workspace',title:meta.title??session.title,name:meta.name,cols:session.cols,rows:session.rows,kind:'desktop',project_id:meta.projectId??`remote-${this.connection.workspaceId}`,run:meta.run??session.kind==='build',command:meta.command,run_command_id:meta.runCommandId,resumed_from:typeof meta.resumedFrom==='number'?meta.resumedFrom:null,generation:1,replay_start:0,replay_end:0};
  }
  private desktopArgs(args:Args){
    let out=args;
    for(const [key,value] of Object.entries(args))if(value instanceof WorkspaceChannel){const channel=this.desktop.channel<unknown>();channel.onmessage=message=>value.onmessage(message);out={...out,[key]:channel};}
    return out;
  }
  private async desktopCall<T>(command:string,args:Args={}){if(this.disposed)throw Error('Workspace disconnected');const result=await this.desktop.invoke<T>(command,this.desktopArgs(args));if(this.disposed)throw Error('Workspace disconnected');return result;}
  private async native<T>(command: string,args: Args={},priority?: number) {
    const result=await this.call<{result:T}>('/native',{command,args},priority);return result.result;
  }
  private instance?: Promise<string>;
  private instanceId(){
    if(!this.instance){const pending=this.native<string>('instance_id',{},INTERACTIVE);this.instance=pending;pending.catch(()=>{if(this.instance===pending)this.instance=undefined;});}
    return this.instance;
  }
  private tickets=new Map<number,Promise<string>>();
  private ticket(id:number){
    let pending=this.tickets.get(id);
    if(!pending){pending=this.client.streamUrl(this.connection.workspaceId,`/sessions/${id}/stream`).finally(()=>{if(this.tickets.get(id)===pending)this.tickets.delete(id);});this.tickets.set(id,pending);}
    return pending;
  }
  private async sessions(priority?: number) {
    const listed=new Set(this.known.keys());
    const sessions=await this.call<RemoteSession[]>('/sessions',undefined,priority);
    // The host resumes agents after a workspace restart. Those terminals were
    // not spawned here, so they are announced like any other new session.
    const appeared=this.known.size?sessions.filter(session=>session.exitCode==null&&!this.known.has(session.id)):[];
    if(appeared.length){
      try{this.metadata={...this.metadata,...await this.native<Record<string,Args>>('pty_metadata_get',{},priority)};}catch{/* Retried on the next poll. */}
    }
    for(const session of appeared.filter(session=>this.metadata[String(session.id)]?.resumedFrom!=null))this.emit('pty:spawned',this.summary(session));
    for(const session of sessions){
      const old=this.known.get(session.id);
      if(old?.exitCode==null && session.exitCode!=null && old){const stream=this.streams.get(session.id);if(stream){stream.pendingExit=session.exitCode;this.deliver(stream);}else this.emit('pty:exit',{id:session.id,session_generation:session.id,exit_code:session.exitCode});}
      this.known.set(session.id,session);
    }
    // A recreated runtime has none of its predecessor's terminals. A stream to
    // one would retry forever and hold the whole workspace at Reconnecting.
    const live=new Set(sessions.map(session=>session.id));
    for(const id of listed)if(!live.has(id)&&this.known.get(id)?.exitCode==null)this.ended(id);
    for(const stream of this.streams.values())if(stream.kick&&live.has(stream.id))stream.kick();
    return sessions;
  }
  private beginPoll() {
    if(this.poll || this.disposed)return;
    const tick=async()=>{try{if(this.stopping)return;await this.sessions();if(this.listeners.get('pty:stats')?.size){try{const stats=await this.invoke('pty_stats');if(!this.disposed)this.emit('pty:stats',stats);}catch{/* Keep file refresh working if process inspection is unavailable. */}}if(this.listeners.get('agent:events')?.size){try{const batch=await this.native<{cursor:string|null;lines:string[]}>('agent_events_poll',{cursor:this.agentEventCursor});if(!this.disposed){this.agentEventCursor=batch.cursor;if(batch.lines.length)this.emit('agent:events',batch.lines);}}catch{/* Keep polling after transient hook transport failures. */}}this.emit('git:change',{root:'/workspace'});this.emit('fs:change',{root:'/workspace',paths:[],kind:'other',overflow:true});}catch{/* Disconnection never falls back to native execution. */}finally{if(!this.disposed)this.poll=setTimeout(()=>void tick(),3000);}};
    this.poll=setTimeout(()=>void tick(),3000);
  }
  private async attach(id:number, channel?:HostChannel<ArrayBuffer>) {
    this.detach(id);
    const stream:Stream={id,receivedSnapshot:false,generation:this.nextStreamGeneration++,cursor:0,frames:[],queuedBytes:0,busy:false,channel,closed:false};
    this.streams.set(id,stream);
    const stateKey=connectionKey(this.connection.endpoint,this.connection.workspaceId);
    reportStream(stateKey,id,false);
    let failures=0;
    // An intentionally stopping or hibernated workspace is not reconnected;
    // the stream parks without network attempts until that state is cleared.
    const parked=()=>{if(stream.closed)return;if(workspaceLifecyclePhase(stateKey)){stream.retry=setTimeout(parked,2000);return;}void connect();};
    const retry=()=>{if(stream.closed)return;remoteDiagnostic('terminal-stream-retry');clearTimeout(stream.handshake);reportStream(stateKey,id,false);if(workspaceLifecyclePhase(stateKey)){stream.retry=setTimeout(parked,2000);return;}const delay=Math.min(30_000,1000*2**Math.min(failures++,5))+Math.random()*500;stream.retry=setTimeout(()=>void connect(),delay);
      // The backoff guards against a workspace that isn't answering. Once the
      // session poll shows it is, a waiting terminal reconnects then instead of
      // sitting out up to 30s; at most once per 10s, so a refusal cannot spin.
      stream.kick=()=>{if(stream.closed||workspaceLifecyclePhase(stateKey)||Date.now()-(stream.kickedAt??0)<10_000)return;stream.kickedAt=Date.now();clearTimeout(stream.retry);stream.kick=undefined;void connect();};};
    const connect=async()=>{
      stream.kick=undefined;
      try{
        const url=await this.ticket(id);
        if(stream.closed)return;
        const socket=new WebSocket(url);stream.socket=socket;
        stream.handshake=setTimeout(()=>{if(stream.socket===socket&&socket.readyState===WebSocket.CONNECTING)socket.close();},10_000);
        socket.onopen=()=>{clearTimeout(stream.handshake);if(!stream.closed&&stream.socket===socket)reportStream(stateKey,id,true);};
        socket.onerror=()=>socket.close();
        socket.onmessage=event=>{
          if(stream.closed || stream.socket!==socket)return;
          try{
            const message=JSON.parse(event.data);
            if(message.t==='hello'){this.input(id).hello(socket,message.input);return;}
            if(message.t==='input-ack'){this.inputs.get(id)?.acknowledge(message.id,message.seq);return;}
            if(message.t==='input-error'){this.inputs.get(id)?.rejected(message.id,message.error);return;}
            if(message.t==='exit'){stream.pendingExit=message.exitCode;this.deliver(stream);return;}
            // Claude Code's IDE server for this terminal runs on the VM
            // (claude-ide.mjs); its UI events ride this stream. The pty id is
            // this stream's, whatever the frame says.
            // A view-only window cannot answer a diff, so it is not shown one.
            if(message.t==='ide'){if(!this.readOnly&&message.event&&typeof message.event.kind==='string')this.emit('claude-ide',{...message.event,ptyId:id} as ClaudeIdeEvent);return;}
            if(!['snapshot','data'].includes(message.t))return;
            failures=0;
            const bytes=Uint8Array.from(atob(message.b64),c=>c.charCodeAt(0));
            const reset=message.t==='snapshot' && message.reset===true;
            if(message.t==='snapshot'){if(!stream.receivedSnapshot)remoteDiagnostic('terminal-stream-live');stream.frames=[];stream.queuedBytes=0;stream.receivedSnapshot=true;const exitCode=message.exitCode??this.known.get(id)?.exitCode;if(exitCode!=null)stream.pendingExit=exitCode;}
            const frame:OutputFrame={bytes,start:message.start??stream.cursor,end:message.end??(stream.cursor+bytes.length),gap:message.gap??(message.t==='snapshot'&&!reset),reset,cols:message.cols??0,rows:message.rows??0};
            stream.cursor=frame.end;
            if(stream.queuedBytes+bytes.length>512*1024 || stream.frames.length>=1024){stream.frames=[];stream.queuedBytes=0;socket.close();return;}
            stream.frames.push(frame);stream.queuedBytes+=bytes.length;this.deliver(stream);
          }catch{socket.close();}
        };
        socket.onclose=()=>{this.inputs.get(id)?.closed(socket);if(!stream.closed&&stream.socket===socket)retry();};
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
  private ended(id:number){this.known.delete(id);if(this.streams.has(id))this.detach(id);this.emit('pty:exit',{id,session_generation:id,exit_code:null});}
  private detach(id:number){const stream=this.streams.get(id);if(!stream)return;stream.closed=true;const input=this.inputs.get(id);if(stream.socket)input?.closed(stream.socket);if(input?.idle)this.inputs.delete(id);clearTimeout(stream.retry);clearTimeout(stream.handshake);stream.socket?.close();this.streams.delete(id);reportStream(connectionKey(this.connection.endpoint,this.connection.workspaceId),id,null);}
  /** One ordered input queue per remote PTY; its stream socket carries it
   * once the gateway announces socket input, HTTP otherwise. */
  private input(id:number){let input=this.inputs.get(id);if(!input){input=new TerminalInput(body=>this.call(`/sessions/${id}/input`,body));this.inputs.set(id,input);}return input;}
  private write(id:number,data:string):Promise<void>{return this.input(id).write(data);}
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
    if(command==='notes_attach_file')return await this.attachWorkspaceFile(args) as T;
    if(command==='spot_stage_drop_images'){await this.call('/resources');return this.desktopCall<T>('execution_remote_stage_images',{...args,workspaceId:this.connection.workspaceId,endpoint:this.connection.endpoint});}
    if(command==='execution_remote_upload')return this.desktopCall<T>(command,{...args,workspaceId:this.connection.workspaceId,endpoint:this.connection.endpoint});
    if(command==='execution_remote_upload_cancel')return this.desktopCall<T>(command,args);
    if(LOCAL_UI.has(command))return this.desktopCall<T>(command,args);
    // Deliberately absent from a cloud workspace: say so without a round trip.
    if(isRemoteUnsupported(command))throw Error(remoteUnsupportedMessage(command));
    // Research, claims and the mesh live in the workspace's canopy-service. A
    // view-only member may read them; a write is refused here, before the
    // gateway's 403 could read as a lost sign-in.
    if(isHarnessCommand(command)){
      if(this.readOnly&&!HARNESS_READS.has(command))throw Error('This workspace is read-only');
      try{return await harnessCommand(command,args,{
        query:(store,action,body={})=>this.call('/harness/query',{store,action,args:body},INTERACTIVE),
        action:(kind,body)=>this.call('/harness/actions',{...body,kind},INTERACTIVE),
        native:(name,body)=>this.native(name,body),
        desktop:(name,body)=>this.desktopCall(name,body),
        instance:`remote-${this.connection.workspaceId}`,
      }) as T;}
      catch(error){if(!isOutdatedHarnessError(error))throw error;this.hostOutdated(command);throw Error(hostOutdatedMessage(command));}
    }
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
    // Workspace previews stream a VM browser; the native webview never applies.
    if(command==='browser_supported')value=false;
    else if(command==='environment_identity')value=`${this.connection.endpoint}/${this.connection.workspaceId}`;
    else if(command==='pty_renderer_register'){
      // Keep the Mac watchdog alive, but never adopt its local processes.
      const [registration,metadata,sessions,instance]=await Promise.all([
        this.desktop.invoke<{generation:number}>('pty_renderer_register'),
        this.native<Record<string,Args>>('pty_metadata_get',{},INTERACTIVE),
        this.sessions(INTERACTIVE),
        this.instanceId().catch(()=>undefined),
      ]);
      this.rendererGeneration=registration.generation;this.metadata=metadata;this.beginPoll();this.scheduleHostVersionCheck();
      value={generation:this.rendererGeneration,instance,sessions:sessions.filter(s=>s.exitCode==null).map(s=>this.summary(s))};
    }else if(command==='pty_renderer_sessions')value=(await this.sessions(INTERACTIVE)).filter(s=>s.exitCode==null).map(s=>this.summary(s));
    else if(command==='instance_id')value=await this.instanceId();
    else if(['pty_spawn','pty_spawn_attached_argv','pty_spawn_argv','pty_spawn_detached'].includes(command)){
      const cwd=String(args.cwd??'/workspace');if(cwd!=='/workspace'&&!cwd.startsWith('/workspace/'))throw Error('Choose a directory in the remote workspace');
      const env=(args.env??[]) as [string,string][];
      if(env.some(([key])=>!/^[_A-Za-z][_A-Za-z0-9]*$/.test(key)))throw Error('Invalid environment variable');
      const accountId=env.find(([key])=>key==='CANOPY_ACCOUNT_POOL')?.[1];
      // A Claude Code tab's request for an IDE server (claudeIde.ts). The
      // workspace serves it beside claude, so it travels as a request field,
      // never as an env var the child would see; the lock follows the
      // profile's config dir when the launch sets one.
      const ideRoot=env.find(([key])=>key===CLAUDE_IDE_MARKER)?.[1];
      const claudeIde=ideRoot?{root:ideRoot,configDir:env.find(([key])=>key==='CLAUDE_CONFIG_DIR')?.[1]??null}:undefined;
      const requested=Array.isArray(args.argv)?(args.argv as string[]).map(quote).join(' '):String(args.runCommand??args.command??args.shell??'/bin/bash');
      const requestId=crypto.randomUUID();
      const commandLine=`cd ${quote(cwd)} && env ${[...env.filter(([key])=>!['CANOPY_ACCOUNT_POOL','CANOPY_SESSION_REQUEST_ID',CLAUDE_IDE_MARKER].includes(key)),['CANOPY_SESSION_REQUEST_ID',requestId]].map(([key,val])=>quote(key+'='+val)).join(' ')} ${requested}`;
      // A task attempt's terminal: the attempt must be the current reserved
      // one, and starts (or fails) with the spawn, as pty.rs does.
      const binding=args.runId!=null||args.attemptId!=null?await this.native<Args|null>('task_spawn_binding',{runId:args.runId??null,attemptId:args.attemptId??null}):null;
      let session:RemoteSession;
      try{session=await this.call<RemoteSession>('/sessions',{command:commandLine,kind:args.runCommand?'build':'terminal',accountId,requestId,projectId:args.projectId,...(claudeIde?{claudeIde}:{})});}
      catch(error){if(binding)await this.native('task_mark_launch_failed',{binding}).catch(()=>{});throw error;}
      if(binding){
        try{await this.native('task_mark_spawned',{binding});}
        catch(error){await this.call(`/sessions/${session.id}/stop`,{}).catch(()=>{});await this.native('task_mark_launch_failed',{binding}).catch(()=>{});throw Error(`spawned PTY but could not start task attempt: ${String(error).replace(/^Error: /,'')}`);}
      }
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
    }else if(command==='pty_attach_desktop'){const id=Number(args.id),stream=await this.attach(id);
      // The session list is a background poll; under load it queued behind
      // other polls and pushed the attach past its deadline. Use the copy the
      // poll already keeps, and only ask when this session isn't known yet.
      const session=this.known.get(id)??(await this.sessions(INTERACTIVE)).find(s=>s.id===id);
      // A restored tab can name a session the workspace no longer has. Answer
      // like the native host so the tab ends instead of retrying forever.
      if(!session){if(this.streams.get(id)===stream)this.detach(id);throw Error(`no pty session ${id}`);}
      value={cols:session.cols,rows:session.rows,generation:stream.generation,replay_start:0,replay_end:0};}
    else if(command==='pty_read_desktop'){const stream=this.streams.get(Number(args.id));if(!stream||stream.generation!==args.generation)throw Error('Remote terminal attachment ended');const frame=this.take(stream);value=frame?{...frame,bytes:[...frame.bytes]}:null;}
    else if(command==='pty_detach_desktop'){const stream=this.streams.get(Number(args.id));if(stream && (args.generation==null||stream.generation===args.generation))this.detach(Number(args.id));}
    else if(command==='pty_ack'){const stream=this.streams.get(Number(args.id));if(stream && stream.generation===args.generation){stream.busy=false;this.deliver(stream);}value=null;}
    else if(command==='pty_write_binary'){await this.input(Number(args.id)).writeBinary(String(args.data));}
    else if(command==='pty_write'){await this.write(Number(args.id),String(args.data));}
    else if(command==='pty_resize'){await this.call(`/sessions/${args.id}/resize`,{cols:args.cols,rows:args.rows});value={cols:args.cols,rows:args.rows};}
    else if(command==='pty_kill'){await this.call(`/sessions/${args.id}/stop`,{});}
    else if(['pty_set_name_theme','cli_set_native_update_env'].includes(command))value=null;
    // Answers to a Claude Code IDE server on the VM. A diagnostics reply has
    // the CLI's 500 ms window to make, so it never queues behind polls.
    else if(command.startsWith('claude_ide_'))value=await this.native(command,args,INTERACTIVE);
    else if(command==='pty_set_title'||command==='pty_set_name'){const key=command==='pty_set_name'?'name':'title';this.metadata[String(args.id)]={...this.metadata[String(args.id)],[key]:args[key]};await this.native('pty_metadata_set',{id:args.id,value:this.metadata[String(args.id)]});value=args[key];}
    else if(command==='pty_stats'&&this.readOnly)value=[];
    else if(command==='pty_stats'){
      const stats=await this.native<Array<Args&{id:number}>>('session_process_stats',{sessions:(await this.sessions()).filter(session=>session.exitCode==null).map(session=>({...session,requestId:this.metadata[String(session.id)]?.requestId}))});
      value=stats.map(stat=>{const meta=this.metadata[String(stat.id)]??{};return {...stat,cwd:meta.cwd??stat.cwd,title:meta.title??stat.title,name:meta.name};});
    }
    else value=await this.hostCommand(command,args);
    if(command==='fs_read_file' && value && typeof value==='object' && 'b64' in value) return Uint8Array.from(atob(String(value.b64)), c=>c.charCodeAt(0)).buffer as T;
    return value as T;
  }
  /** Notes live on this computer and the file in the workspace: read it from
   * the workspace in slices and attach the bytes, with notes.rs attach_file's
   * kind, title, extension and size rules. */
  private async attachWorkspaceFile(args:Args){
    const path=String(args.path??'');const name=path.split('/').pop()??'';const dot=name.lastIndexOf('.');
    const ext=dot>0?name.slice(dot+1).toLowerCase():'';
    const kind=typeof args.kind==='string'?args.kind:['png','jpg','jpeg','gif','webp','bmp'].includes(ext)?'image':'artifact';
    const image=kind==='image',limit=image?16*1024*1024:512*1024;
    const parts:Uint8Array[]=[];let offset=0,size=0;
    try{
      do{const slice=await this.native<{b64:string;size:number}>('fs_read_range',{path,offset,length:1024*1024});size=slice.size;
        if(size>limit)throw Error(`file is ${size} bytes; the limit is ${limit}`);
        const bytes=Uint8Array.from(atob(slice.b64),c=>c.charCodeAt(0));if(!bytes.length)break;parts.push(bytes);offset+=bytes.length;}while(offset<size);
    }catch(error){throw Error(`could not read ${path}: ${String(error).replace(/^Error: /,'')}`);}
    const bytes=new Uint8Array(offset);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}
    const stem=dot>0?name.slice(0,dot):name;
    const title=(typeof args.title==='string'&&args.title.trim())||stem||(image?'image':'capture');
    let data='';if(image){let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));data=btoa(binary);}else data=new TextDecoder().decode(bytes);
    return this.desktopCall('notes_add_attachment',{projectId:args.projectId,id:args.id,kind,title,data,ext:ext||(image?'png':'txt')});
  }
  /** A host command, with an older host told apart from a missing feature: a
   * newer app asking a workspace that still runs last month's host gets one
   * plain "restart or update the workspace" instead of "does not support". */
  private async hostCommand<T>(command:string,args:Args){
    // A Channel argument (LSP output, a runner's lines) is named for the host,
    // which queues what the command sends; pumpChannels drains it here.
    const opened:string[]=[];let input=args;
    for(const [key,value] of Object.entries(args))if(value instanceof WorkspaceChannel){const id=crypto.randomUUID();this.hostChannels.set(id,value as WorkspaceChannel<unknown>);opened.push(id);input={...input,[key]:{__canopyChannel:id}};}
    if(opened.length)this.pumpChannels();
    try{
      const result=await this.native<T>(command,input);
      // The desktop announces a language server's end as an event; here its
      // channel closing is that end.
      if(command==='lsp_start')for(const id of opened)this.channelEnded.set(id,()=>this.emit('lsp:exit',result));
      return result;
    }catch(error){
      for(const id of opened)this.hostChannels.delete(id);
      if(outdatedHostCommand(error)!==command)throw error;this.hostOutdated(command);throw Error(hostOutdatedMessage(command));
    }
  }
  private hostChannels=new Map<string,WorkspaceChannel<unknown>>();
  private channelEnded=new Map<string,()=>void>();
  private pumping=false;
  private async pumpChannels(){
    if(this.pumping)return;this.pumping=true;
    try{
      while(this.hostChannels.size&&!this.disposed){
        let batch:Record<string,{messages:unknown[];closed:boolean}>;
        try{batch=await this.native('channel_poll',{ids:[...this.hostChannels.keys()].slice(0,64),wait:1500},INTERACTIVE);}
        catch{await new Promise(resolve=>setTimeout(resolve,1000));continue;}
        for(const [id,{messages,closed}] of Object.entries(batch??{})){
          const channel=this.hostChannels.get(id);if(!channel)continue;
          for(const message of messages){try{channel.onmessage(message);}catch{/* One listener's failure never stalls the stream. */}}
          if(closed){this.hostChannels.delete(id);this.channelEnded.get(id)?.();this.channelEnded.delete(id);}
        }
      }
    }finally{this.pumping=false;}
  }
  private outdatedReported=false;
  private hostOutdated(command?:string){
    if(this.outdatedReported||this.disposed)return;this.outdatedReported=true;
    window.dispatchEvent(new CustomEvent(HOST_OUTDATED_EVENT,{detail:{command:command??null,message:hostOutdatedMessage(command)}}));
  }
  /** Ask once per connection, so a stale host is reported before anyone hits
   * it — after boot settles, never competing with the handshake for a lane. */
  private versionCheck?: ReturnType<typeof setTimeout>;
  private scheduleHostVersionCheck(){if(!this.versionCheck&&!this.outdatedReported)this.versionCheck=setTimeout(()=>void this.checkHostVersion(),10_000);}
  private async checkHostVersion(){
    if(this.disposed)return;
    try{const capabilities=await this.native<{protocol?:number}>('host_capabilities');if(!(Number(capabilities?.protocol)>=HOST_PROTOCOL))this.hostOutdated();}
    catch(error){if(/does not support host_capabilities yet/.test(String(error)))this.hostOutdated();}
  }
  async listen<T>(event:string,handler:(event:HostEvent<T>)=>void):Promise<UnlistenFn>{
    if(this.disposed)throw Error('Workspace disconnected');
    if(['remote:upload-progress','menu','deep-link','memory:pressure','window:fullscreen','clipboard:changed','clipboard:blocked','dictation:progress','dictation:partial','dictation:level',...COMPANION_DESKTOP_EVENTS,...DESKTOP_EVENTS].includes(event)){const companionOnly=event.startsWith('agent:');const release=await this.desktop.listen<T>(event,value=>{if(this.disposed)return;if(companionOnly&&(value.payload as {ptyId?:unknown}|null)?.ptyId!=null)return;handler(value);});if(this.disposed){release();return()=>{};}const cancel=()=>{this.desktopListeners.delete(cancel);release();};this.desktopListeners.add(cancel);return cancel;}
    const list=this.listeners.get(event)??new Set();this.listeners.set(event,list);list.add(handler as (event:HostEvent<unknown>)=>void);this.beginPoll();return ()=>{list.delete(handler as (event:HostEvent<unknown>)=>void);};
  }
  channel<T>():HostChannel<T>{return new WorkspaceChannel<T>();}
  invokeDesktop<T>(command:string,args:Args={}):Promise<T>{return this.desktopCall<T>(command,args);}
  dispose(){const channels=[...this.hostChannels.keys()];this.hostChannels.clear();if(channels.length&&!this.disposed)void this.native('channel_drop',{ids:channels}).catch(()=>{});this.disposed=true;this.harness?.stop();this.harness=undefined;for(const release of [...this.desktopListeners]){try{release();}catch{/* Disposed handlers stay inert even if native teardown fails. */}}this.desktopListeners.clear();window.removeEventListener('canopy:account-changed',this.onAccountChanged);clearTimeout(this.heartbeat);clearTimeout(this.versionCheck);for(const input of this.inputs.values())input.dispose();this.inputs.clear();clearTimeout(this.poll);for(const id of this.streams.keys())this.detach(id);this.listeners.clear();}
}
