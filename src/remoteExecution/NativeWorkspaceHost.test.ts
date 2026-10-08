import { afterEach, expect, it, vi } from 'vitest';
import type { Host, HostEvent } from '../host/contract';
import { NativeWorkspaceHost } from './NativeWorkspaceHost';
afterEach(() => vi.unstubAllGlobals());
it('opens and closes public browser previews on the viewing computer',async()=>{
 const {host,desktop,fetcher}=setup();
 vi.mocked(desktop.invoke).mockResolvedValue('http://127.0.0.1:9000/viewer');
 const args={sessionId:'github-preview',url:'https://github.com'};
 expect(await host.invoke('chrome_stream_open',args)).toBe('http://127.0.0.1:9000/viewer');
 await host.invoke('chrome_stream_close',{sessionId:args.sessionId});
 expect(desktop.invoke).toHaveBeenCalledWith('chrome_stream_open',args);
 expect(desktop.invoke).toHaveBeenCalledWith('chrome_stream_close',{sessionId:args.sessionId});
 expect(fetcher).not.toHaveBeenCalled();host.dispose();
});
it('routes workspace localhost through a private remote browser and scoped ticket',async()=>{
 const {host,desktop,fetcher}=setup();const id='12345678-1234-1234-1234-123456789abc';
 fetcher.mockImplementation(async(url:string)=>({ok:true,json:async()=>url.endsWith('/ticket')?{ticket:'one-use'}:{result:{id}}}));
 const viewer=await host.invoke<string>('chrome_stream_open',{sessionId:'dev',url:'http://localhost:3000'});
 expect(viewer).toContain('/chrome-stream/viewer.html?remote=1&sessionId=dev');
 expect(await host.invoke('chrome_stream_ticket',{sessionId:'dev'})).toContain('/v1/stream?ticket=one-use');
 expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body as string).stream).toBe(`/browsers/${id}/stream`);
 await host.invoke('chrome_stream_close',{sessionId:'dev'});
 await expect(host.invoke('chrome_stream_ticket',{sessionId:'dev'})).rejects.toThrow('Unknown');
 expect(desktop.invoke).not.toHaveBeenCalled();host.dispose();
});
it('keeps the scratchpad on the viewing computer, but attaches workspace files through the workspace',async()=>{
 const {host,desktop,fetcher}=setup();
 vi.mocked(desktop.invoke).mockResolvedValue({id:'n1'});
 const note={projectId:'p_1',title:'Number Vandurucha'};
 expect(await host.invoke('notes_create',note)).toEqual({id:'n1'});
 await host.invoke('notes_list',{projectId:'p_1',status:null,limit:50});
 expect(desktop.invoke).toHaveBeenCalledWith('notes_create',note);
 expect(desktop.invoke).toHaveBeenCalledWith('notes_list',{projectId:'p_1',status:null,limit:50});
 expect(fetcher).not.toHaveBeenCalled();
 await host.invoke('notes_attach_file',{projectId:'p_1',id:'n1',path:'/workspace/a.txt'});
 expect(desktop.invoke).not.toHaveBeenCalledWith('notes_attach_file',expect.anything());
 expect(fetcher.mock.calls.at(-1)![0]).toContain('/workspaces/alice/native');
 host.dispose();
});
const connection = {endpoint:'http://127.0.0.1:8787',token:'synthetic-token',workspaceId:'alice',workspaceName:'Alice'};
function setup() {
  const desktop = {kind:'native',invoke:vi.fn(),listen:vi.fn(),channel:vi.fn()} as unknown as Host;
  const host = new NativeWorkspaceHost(connection, desktop);
  const fetcher = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body || '{}'));
    return {ok:true,json:async()=>url.endsWith('/sessions')?{id:7,title:'shell',cols:120,rows:40,exitCode:null,accountId:null}:{result:body.command==='fs_read_file'?[65]:null}};
  });
  vi.stubGlobal('fetch', fetcher);
  return {host, desktop, fetcher};
}
it('routes files to the selected VM without invoking local filesystem commands', async () => {
  const {host,desktop,fetcher}=setup();
  expect(await host.invoke('fs_read_file',{path:'/workspace/a.txt'})).toEqual([65]);
  expect(fetcher.mock.calls[0][0]).toContain('/workspaces/alice/native');
  expect(desktop.invoke).not.toHaveBeenCalled();
  host.dispose();
});
it('supplies remote foreground-agent evidence to the existing agent grouping',async()=>{
 const {host,fetcher,desktop}=setup();
 fetcher.mockImplementation(async(url:string,options:RequestInit)=>{
  const body=JSON.parse(String(options.body||'{}'));
  return {ok:true,json:async()=>url.endsWith('/sessions')?[{id:7,title:'shell',cols:120,rows:40,exitCode:null}]:{result:body.command==='session_process_stats'?[{id:7,title:'shell',cwd:'/workspace',agent_hint:{bin:'claude',pkg:null,path:'/usr/bin/claude',interactive:true},procs:[]}]:null}};
 });
 const stats=await host.invoke<Array<{agent_hint:{bin:string}}>>('pty_stats');
 expect(stats[0].agent_hint.bin).toBe('claude');expect(desktop.invoke).not.toHaveBeenCalled();host.dispose();
});
it('publishes foreground-agent stats through the subscribed remote polling event',async()=>{
 vi.useFakeTimers();
 const {host,fetcher}=setup();const handler=vi.fn();
 fetcher.mockImplementation(async(url:string,options:RequestInit)=>{
  const body=JSON.parse(String(options.body||'{}'));
  return {ok:true,json:async()=>url.endsWith('/sessions')?[{id:7,title:'shell',cols:120,rows:40,exitCode:null}]:{result:body.command==='session_process_stats'?[{id:7,agent_hint:{bin:'claude'},procs:[]}]:null}};
 });
 try {
  await host.listen('pty:stats',handler);await vi.advanceTimersByTimeAsync(3000);
  expect(handler).toHaveBeenCalledWith(expect.objectContaining({payload:[expect.objectContaining({id:7,agent_hint:{bin:'claude'}})]}));
 }finally{host.dispose();vi.useRealTimers();}
});
it('remote failures never execute an agent locally', async () => {
  const {host,desktop,fetcher}=setup();
  fetcher.mockRejectedValue(new Error('Disconnected'));
  await expect(host.invoke('pty_spawn_detached',{cwd:'/workspace',command:'codex'})).rejects.toThrow('Disconnected');
  expect(desktop.invoke).not.toHaveBeenCalled();
  host.dispose();
});
it('spawns shells in the selected workspace and quotes argv and environment', async () => {
  const {host,fetcher}=setup();
  await host.invoke('pty_spawn_argv',{cwd:'/workspace/repo',projectId:'trusted-project',argv:['codex',"a'b"],env:[['KEY','a b'],['CANOPY_ACCOUNT_POOL','team']]});
  const body=JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.command).toContain("cd '/workspace/repo'");
  expect(body.command).toContain("'KEY=a b'");
  expect(body.command).toContain("'a'\\''b'");
  expect(body.command).not.toContain('CANOPY_ACCOUNT_POOL');
  expect(body.accountId).toBe('team');
  expect(body.projectId).toBe('trusted-project');
  expect(body.requestId).toBeTruthy();
  host.dispose();
});
it('only explicit desktop UI commands stay native', async () => {
  const {host,desktop}=setup();
  await host.invoke('watchdog_ack',{generation:1});
  expect(desktop.invoke).toHaveBeenCalledWith('watchdog_ack',{generation:1});
  await expect(host.invoke('pty_spawn',{cwd:'/Users/local'})).rejects.toThrow('remote workspace');
  host.dispose();
});
it('keeps clipboard and microphone operations and events on the display computer',async()=>{
 const {host,desktop,fetcher}=setup();
 await host.invoke('clipboard_image_png');
 await host.invoke('clipboard_read',{id:1});await host.invoke('dictation_start',{modelId:'test'});
 await host.listen('clipboard:changed',()=>{});await host.listen('dictation:partial',()=>{});
 expect(desktop.invoke).toHaveBeenCalledWith('clipboard_image_png',{});
 expect(desktop.invoke).toHaveBeenCalledWith('clipboard_read',{id:1});expect(desktop.invoke).toHaveBeenCalledWith('dictation_start',{modelId:'test'});
 expect(desktop.listen).toHaveBeenCalledWith('clipboard:changed',expect.any(Function));expect(fetcher).not.toHaveBeenCalled();host.dispose();
});
it('batches terminal keystrokes in order instead of racing HTTP input', async () => {
  const {host,fetcher}=setup();
  await Promise.all(['p','w','d','\r'].map(data=>host.invoke('pty_write',{id:7,data})));
  const inputs=fetcher.mock.calls.filter(([url])=>url.endsWith('/input')).map(([,options])=>JSON.parse(options.body).data);
  expect(inputs.join('')).toBe('pwd\r');
  expect(inputs.length).toBe(1);
  host.dispose();
});

it('orders terminal parsing with acknowledgements and rejects obsolete detaches', async()=>{
 const {host,fetcher}=setup();
 class Socket {
  static all:Socket[]=[];onmessage?: (event:{data:string})=>void;onclose?:()=>void;closed=false;
  constructor(){Socket.all.push(this);}close(){this.closed=true;}sendFrame(value:unknown){this.onmessage?.({data:JSON.stringify(value)});}
 }
 vi.stubGlobal('WebSocket',Socket);
 fetcher.mockImplementation(async(url:string,options:RequestInit)=>({ok:true,json:async()=>url.endsWith('/ticket')?{ticket:'synthetic-ticket'}:url.endsWith('/sessions')&&options.method==='GET'?[{id:7,title:'shell',cols:40,rows:10,exitCode:null}]:url.endsWith('/sessions')?{id:7,title:'shell',cols:40,rows:10,exitCode:null}:{result:null}}));
 const channel={onmessage:vi.fn()};
 const spawned=await host.invoke<{generation:number}>('pty_spawn_attached_argv',{cwd:'/workspace',argv:['bash'],onData:channel});
 const socket=Socket.all[0];
 socket.sendFrame({t:'snapshot',b64:btoa('screen'),start:100,end:100,reset:true,cols:40,rows:10});
 socket.sendFrame({t:'data',b64:btoa('next'),start:100,end:104,cols:20,rows:5});
 expect(channel.onmessage).toHaveBeenCalledTimes(1);
 await host.invoke('pty_ack',{id:7,generation:spawned.generation-1,bytes:6});expect(channel.onmessage).toHaveBeenCalledTimes(1);
 await host.invoke('pty_ack',{id:7,generation:spawned.generation,bytes:6});expect(channel.onmessage).toHaveBeenCalledTimes(2);
 const {decodePtyChunk}=await import('../ipc');
 const frame=decodePtyChunk(channel.onmessage.mock.calls[0][0]);expect(frame).toMatchObject({reset:true,start:100,end:100,cols:40,rows:10,gap:false});
 const attached=await host.invoke<{generation:number}>('pty_attach_desktop',{id:7});
 await host.invoke('pty_detach_desktop',{id:7,generation:spawned.generation});
 expect(Socket.all[1].closed).toBe(false);expect(attached.generation).not.toBe(spawned.generation);
 host.dispose();
});

it('local disk upload chooser stays on the desktop and binds to this workspace',async()=>{
 const {host,desktop,fetcher}=setup();
 await host.invoke('execution_remote_upload',{id:'test-job',destination:'/workspace/data',kind:'files',workspaceId:'wrong'});
 expect(desktop.invoke).toHaveBeenCalledWith('execution_remote_upload',{id:'test-job',destination:'/workspace/data',kind:'files',workspaceId:'alice',endpoint:connection.endpoint});
 await host.listen('remote:upload-progress',()=>{});expect(desktop.listen).toHaveBeenCalledWith('remote:upload-progress',expect.any(Function));
 await host.invoke('execution_remote_upload_cancel',{id:'test-job'});expect(fetcher).not.toHaveBeenCalled();host.dispose();
});

it('preserves a fast-exiting run when its initial resize reaches an already closed PTY',async()=>{
 const {host,fetcher}=setup();
 vi.stubGlobal('WebSocket',class {close(){} });
 fetcher.mockImplementation(async(url:string,options:RequestInit)=>{
  if(url.endsWith('/resize'))return {ok:false,json:async()=>({error:'Terminal resize failed'})};
  const completed={id:7,title:'synthetic',cols:120,rows:40,exitCode:127,accountId:null,kind:'build'};
  return {ok:true,json:async()=>url.endsWith('/sessions')?(options.method==='GET'?[completed]:{...completed,exitCode:null}):url.endsWith('/ticket')?{ticket:'synthetic'}:{result:null}};
 });
 try {
  const spawned=await host.invoke<{id:number;generation:number;run:boolean}>('pty_spawn',{cwd:'/workspace',runCommand:'synthetic',cols:80,rows:24,onData:{onmessage:vi.fn()}});
  expect(spawned.id).toBe(7);expect(spawned.generation).toBeGreaterThan(0);expect(spawned.run).toBe(true);
  expect(fetcher.mock.calls.filter(([url,opts])=>url.endsWith('/sessions')&&opts.method==='POST')).toHaveLength(1);
 }finally{host.dispose();}
});
it('still reports genuine resize failures for a running remote process',async()=>{
 const {host,fetcher}=setup();
 fetcher.mockImplementation(async(url:string,options:RequestInit)=>url.endsWith('/resize')?{ok:false,json:async()=>({error:'Terminal resize failed'})}:{ok:true,json:async()=>url.endsWith('/sessions')?(options.method==='GET'?[{id:7,exitCode:null}]:{id:7,exitCode:null}):{result:null}});
 try{await expect(host.invoke('pty_spawn',{cwd:'/workspace',cols:80,rows:24})).rejects.toThrow('Terminal resize failed');}finally{host.dispose();}
});

it('delivers the final output before reporting an already-completed run',async()=>{
 const {host,fetcher}=setup();const exited=vi.fn();await host.listen('pty:exit',exited);
 class Socket {static all:Socket[]=[];onmessage?:(e:{data:string})=>void;constructor(){Socket.all.push(this);}close(){} }
 vi.stubGlobal('WebSocket',Socket);
 fetcher.mockImplementation(async(url:string,options:RequestInit)=>{
  if(url.endsWith('/resize'))return {ok:false,json:async()=>({error:'Terminal resize failed'})};
  const session={id:7,title:'synthetic',cols:120,rows:40,exitCode:127,accountId:null,kind:'build'};
  return {ok:true,json:async()=>url.endsWith('/sessions')?(options.method==='GET'?[session]:{...session,exitCode:null}):url.endsWith('/ticket')?{ticket:'synthetic'}:{result:null}};
 });
 try{
  const channel={onmessage:vi.fn()};const spawned=await host.invoke<{generation:number}>('pty_spawn',{cwd:'/workspace',runCommand:'synthetic',cols:80,rows:24,onData:channel});
  Socket.all[0].onmessage?.({data:JSON.stringify({t:'snapshot',b64:btoa('actual command error'),start:0,end:20,reset:true,cols:120,rows:40})});
  expect(channel.onmessage).toHaveBeenCalledOnce();expect(exited).not.toHaveBeenCalled();
  await host.invoke('pty_ack',{id:7,generation:spawned.generation,bytes:20});
  expect(exited).toHaveBeenCalledWith(expect.objectContaining({payload:expect.objectContaining({id:7,exit_code:127})}));
 }finally{host.dispose();}
});

it('uploads dropped images through the desktop into the bound remote workspace',async()=>{
 const {host,desktop,fetcher}=setup();
 vi.mocked(desktop.invoke).mockResolvedValue(['/workspace/.canopy/attachments/image.png']);
 const paths=['/tmp/local-screenshot.png'];
 expect(await host.invoke('spot_stage_drop_images',{dir:'/workspace',paths})).toEqual(['/workspace/.canopy/attachments/image.png']);
 expect(desktop.invoke).toHaveBeenCalledWith('execution_remote_stage_images',{dir:'/workspace',paths,workspaceId:'alice',endpoint:connection.endpoint});
 expect(fetcher.mock.calls[0][0]).toContain('/resources');host.dispose();
});

it('does not announce desktop-owned spawns as new external terminals', async () => {
 const {host}=setup();
 const discovered=vi.fn();
 await host.listen('pty:spawned',discovered);
 const result=await host.invoke<{id:number}>('pty_spawn_argv',{cwd:'/workspace',argv:['bash']});
 expect(result.id).toBe(7);
 expect(discovered).not.toHaveBeenCalled();
 host.dispose();
});

it('renews managed access without terminal listeners and stops heartbeats while idle or disposed',async()=>{
 vi.useFakeTimers();vi.setSystemTime(1000000);
 const managed={...connection,endpoint:'https://alice.workspaces.canopyide.dev'};
 const invoke=vi.fn().mockImplementation(async(command:string)=>command==='canopy_account_request'?{connection:{...managed,token:`renewed-${Date.now()}`},expiresAt:new Date(Date.now()+120000).toISOString()}:undefined);
 const desktop={kind:'native',invoke,listen:vi.fn(),channel:vi.fn()} as unknown as Host;
 const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({})});vi.stubGlobal('fetch',fetcher);
 const host=new NativeWorkspaceHost(managed,desktop);
 const renewals=()=>invoke.mock.calls.filter(([command])=>command==='canopy_account_request');
 try{
  await vi.advanceTimersByTimeAsync(150000);
  expect(renewals()).toHaveLength(3);expect(fetcher).toHaveBeenCalledTimes(5);
  expect(fetcher.mock.calls.every(([url])=>url.endsWith('/open'))).toBe(true);
  host.setProjectIdle(true);await vi.advanceTimersByTimeAsync(150000);
  expect(fetcher).toHaveBeenCalledTimes(5);
  host.setProjectIdle(false);await vi.advanceTimersByTimeAsync(30000);
  expect(renewals()).toHaveLength(4);
  host.dispose();await vi.advanceTimersByTimeAsync(150000);expect(fetcher).toHaveBeenCalledTimes(6);
 }finally{host.dispose();vi.useRealTimers();}
});
it('rejects invalid renewed credentials before sending requests or persisting them',async()=>{
 const managed={...connection,endpoint:'https://alice.workspaces.canopyide.dev'};
 const invoke=vi.fn().mockResolvedValue({connection:{...managed,token:'invalid'},expiresAt:'not-a-date'});
 const desktop={kind:'native',invoke,listen:vi.fn(),channel:vi.fn()} as unknown as Host;
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const host=new NativeWorkspaceHost(managed,desktop);
 try{
  await expect(host.invoke('fs_read_file',{path:'/workspace/test'})).rejects.toThrow('invalid credential');
  expect(fetcher).not.toHaveBeenCalled();expect(invoke).toHaveBeenCalledTimes(1);
 }finally{host.dispose();}
});
it('delivers remote hook events and advances a per-IDE cursor, stopping on disposal',async()=>{
 vi.useFakeTimers();const {host,fetcher}=setup();const handler=vi.fn();const cursors:unknown[]=[];
 fetcher.mockImplementation(async(url:string,options:RequestInit)=>{
  const body=JSON.parse(String(options.body||'{}'));
  if(body.command==='agent_events_poll'){
   cursors.push(body.args.cursor);
   return {ok:true,json:async()=>({result:{cursor:'11:80',lines:cursors.length===1?['{"agent":"claude","hook_event_name":"Stop"}']:[]}})};
  }
  return {ok:true,json:async()=>url.endsWith('/sessions')?[]:{result:null}};
 });
 try{
  await host.listen('agent:events',handler);
  await vi.advanceTimersByTimeAsync(6000);
  expect(cursors).toEqual([null,'11:80']);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(handler).toHaveBeenCalledWith(expect.objectContaining({payload:['{"agent":"claude","hook_event_name":"Stop"}']}));
  host.dispose();await vi.advanceTimersByTimeAsync(6000);expect(cursors).toHaveLength(2);
 }finally{host.dispose();vi.useRealTimers();}
});
it('Canopy account changes invalidate managed credentials before a later refresh or native request',async()=>{
 const desktop={kind:'native',invoke:vi.fn().mockResolvedValue({connection:{endpoint:'https://workspace.workspaces.canopyide.dev',workspaceId:'workspace',workspaceName:'Workspace',token:'new-account'},expiresAt:new Date(Date.now()+300000).toISOString()}),listen:vi.fn(),channel:vi.fn()} as unknown as Host;
 const fetcher=vi.fn().mockResolvedValue(Response.json({result:'safe'}));vi.stubGlobal('fetch',fetcher);
 const host=new NativeWorkspaceHost({endpoint:'https://workspace.workspaces.canopyide.dev',workspaceId:'workspace',workspaceName:'Workspace',token:'old-account'},desktop);
 try{
  await host.invoke('fs_read_file',{path:'/workspace/app.ts'});expect(fetcher).toHaveBeenCalledTimes(1);vi.mocked(desktop.invoke).mockClear();
  window.dispatchEvent(new Event('canopy:account-changed'));
  await expect(host.invoke('fs_read_file',{path:'/workspace/secret'})).rejects.toThrow('disconnected');await expect(host.client.workspace('workspace','/sessions')).rejects.toThrow('disconnected');await expect(host.invoke('clipboard_read')).rejects.toThrow('disconnected');
  expect(fetcher).toHaveBeenCalledTimes(1);expect(desktop.invoke).not.toHaveBeenCalled();
 }finally{host.dispose();}
});
it('disposed adapters do not release a late remote result to the next account',async()=>{
 const {host}=setup();let resolve!:(value:Response)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(r=>{resolve=r;})));
 const pending=host.invoke('fs_read_file',{path:'/workspace/private'});await Promise.resolve();await Promise.resolve();host.dispose();resolve(Response.json({result:'old-account-data'}));await expect(pending).rejects.toThrow('disconnected');
});
it('disposed adapters suppress native event callbacks and release their subscriptions',async()=>{
 const {host,desktop}=setup();let forward!:(event:HostEvent<unknown>)=>void;const release=vi.fn();vi.mocked(desktop.listen).mockImplementation(async(_event,handler)=>{forward=handler;return release;});const handler=vi.fn();
 await host.listen('clipboard:changed',handler);forward({event:'clipboard:changed',id:1,payload:'before'});expect(handler).toHaveBeenCalledTimes(1);host.dispose();forward({event:'clipboard:changed',id:2,payload:'after'});expect(handler).toHaveBeenCalledTimes(1);expect(release).toHaveBeenCalledTimes(1);await expect(host.listen('clipboard:changed',handler)).rejects.toThrow('disconnected');
});
it('native UI results arriving after disposal are not returned to the old workspace',async()=>{
 const {host,desktop}=setup();let resolve!:(value:unknown)=>void;vi.mocked(desktop.invoke).mockImplementation(()=>new Promise(r=>{resolve=r;}));const pending=host.invoke('clipboard_read');host.dispose();resolve('next-account-private-data');await expect(pending).rejects.toThrow('disconnected');
});

it('viewer host browses files but rejects terminal, uploads and mutations before native or HTTP execution',async()=>{
 const desktop={kind:'native',invoke:vi.fn(),listen:vi.fn(),channel:vi.fn()} as unknown as Host;
 const viewer=new NativeWorkspaceHost({...connection,scope:'view'},desktop),fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({result:[65]})});vi.stubGlobal('fetch',fetcher);
 expect(viewer.readOnly).toBe(true);expect(await viewer.invoke('fs_read_file',{path:'/workspace/projects/app/readme.md'})).toEqual([65]);
 fetcher.mockClear();for(const command of ['pty_spawn','fs_write_file','profile_import_credentials','cli_update','execution_remote_upload','spot_save_context_image'])await expect(viewer.invoke(command,{})).rejects.toThrow('read-only');
 expect(fetcher).not.toHaveBeenCalled();expect(desktop.invoke).not.toHaveBeenCalled();viewer.dispose();
});

it('view-only workspace cannot start or request interactive remote browser tickets',async()=>{
 const desktop={kind:'native',invoke:vi.fn(),listen:vi.fn(),channel:vi.fn()} as unknown as Host;
 const host=new NativeWorkspaceHost({...connection,scope:'view'},desktop);const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 await expect(host.invoke('chrome_stream_open',{sessionId:'readonly',url:'http://localhost:3000'})).rejects.toThrow('read-only');
 await expect(host.invoke('chrome_stream_ticket',{sessionId:'readonly'})).rejects.toThrow('read-only');expect(fetcher).not.toHaveBeenCalled();host.dispose();
});
it('parks terminal reconnects and heartbeats while the workspace is intentionally stopping',async()=>{
 vi.useFakeTimers();vi.setSystemTime(1000000);
 const {connectionKey,reportWorkspaceLifecycle}=await import('./connectionState');
 const managed={...connection,endpoint:'https://alice.workspaces.canopyide.dev'},key=connectionKey(managed.endpoint,'alice');
 const invoke=vi.fn().mockImplementation(async(command:string)=>command==='canopy_account_request'?{connection:{...managed,token:'renewed'},expiresAt:new Date(Date.now()+3600000).toISOString()}:undefined);
 const desktop={kind:'native',invoke,listen:vi.fn(),channel:vi.fn()} as unknown as Host;
 class Socket {static CONNECTING=0;static all:Socket[]=[];readyState=0;onopen?:()=>void;onclose?:()=>void;onmessage?:()=>void;onerror?:()=>void;constructor(){Socket.all.push(this);}close(){this.onclose?.();}}
 vi.stubGlobal('WebSocket',Socket);
 const fetcher=vi.fn().mockImplementation(async(url:string,options:RequestInit)=>({ok:true,json:async()=>url.endsWith('/ticket')?{ticket:'synthetic-ticket'}:url.endsWith('/sessions')&&options.method!=='GET'?{id:7,title:'shell',cols:40,rows:10,exitCode:null}:{result:null}}));
 vi.stubGlobal('fetch',fetcher);
 const host=new NativeWorkspaceHost(managed,desktop);
 try{
  await host.invoke('pty_spawn_attached_argv',{cwd:'/workspace',argv:['bash'],onData:{onmessage:vi.fn()}});
  expect(Socket.all).toHaveLength(1);
  reportWorkspaceLifecycle(key,'stopping');
  const requests=fetcher.mock.calls.length;
  Socket.all[0].close();
  await vi.advanceTimersByTimeAsync(120000);
  // No ticket requests, sockets or heartbeats against compute that is stopping.
  expect(Socket.all).toHaveLength(1);expect(fetcher.mock.calls.length).toBe(requests);
  // Waking the workspace clears the lifecycle and the terminal reconnects.
  reportWorkspaceLifecycle(key,null);
  await vi.advanceTimersByTimeAsync(2500);
  expect(Socket.all).toHaveLength(2);
 }finally{host.dispose();reportWorkspaceLifecycle(key,null);vi.useRealTimers();}
});

it('sends keystrokes over the stream socket once the gateway offers it and falls back to HTTP across a reconnect',async()=>{
 const {host,fetcher}=setup();
 class Socket {
  static all:Socket[]=[];readyState=1;sent:Array<{t:string;id:string;seq:number;data:string}>=[];onmessage?:(event:{data:string})=>void;onclose?:()=>void;onopen?:()=>void;
  constructor(){Socket.all.push(this);}close(){this.readyState=3;this.onclose?.();}send(text:string){this.sent.push(JSON.parse(text));}frame(value:unknown){this.onmessage?.({data:JSON.stringify(value)});}
 }
 vi.stubGlobal('WebSocket',Socket);
 fetcher.mockImplementation(async(url:string,options:RequestInit)=>({ok:true,json:async()=>url.endsWith('/ticket')?{ticket:'synthetic-ticket'}:url.endsWith('/sessions')&&options.method==='GET'?[{id:7,title:'shell',cols:40,rows:10,exitCode:null}]:url.endsWith('/sessions')?{id:7,title:'shell',cols:40,rows:10,exitCode:null}:url.endsWith('/input')?{ok:true}:{result:null}}));
 await host.invoke('pty_spawn_attached_argv',{cwd:'/workspace',argv:['bash'],onData:{onmessage:vi.fn()}});
 const socket=Socket.all[0];socket.frame({t:'hello',input:1});
 const inputs=()=>fetcher.mock.calls.filter(([url])=>String(url).endsWith('/input'));
 const typed=host.invoke('pty_write',{id:7,data:'l'});await new Promise(r=>setTimeout(r,0));
 const second=host.invoke('pty_write',{id:7,data:'s'});await new Promise(r=>setTimeout(r,0));
 expect(socket.sent.map(f=>[f.seq,f.data])).toEqual([[1,'l'],[2,'s']]);expect(inputs()).toHaveLength(0);
 socket.frame({t:'input-ack',id:socket.sent[0].id,seq:1});await typed;
 // The socket drops before acknowledging 's': it is resent once over HTTP with its identity.
 socket.close();await second;
 expect(inputs().map(([,options])=>JSON.parse(String((options as RequestInit).body)))).toEqual([{data:'s',id:socket.sent[0].id,seq:2}]);
 host.dispose();
});
