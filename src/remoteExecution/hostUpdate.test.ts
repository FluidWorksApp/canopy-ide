import {it,expect,vi,beforeEach} from 'vitest';
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
import {HostUpdateCancelled,hostUpdateState,hostUpdateStepLabel,requestHostUpdate,workspaceUpdate} from './hostUpdate';
const id='ws-11111111-1111-1111-1111-111111111111',A='a'.repeat(40),B='b'.repeat(40);
beforeEach(()=>{vi.clearAllMocks();});

it('decides current, available and required from the list, against this app\'s protocol',()=>{
 expect(hostUpdateState({host:{revision:A,protocol:6},release:{revision:A,protocol:6}},null,6)).toBe('current');
 expect(hostUpdateState({host:{revision:A,protocol:6},release:{revision:B,protocol:6}},null,6)).toBe('available');
 expect(hostUpdateState({host:{revision:A,protocol:5},release:{revision:B,protocol:6}},null,6)).toBe('required');
 expect(hostUpdateState({host:{revision:A,protocol:7},release:{revision:A,protocol:7}},null,6)).toBe('current'); // A newer host is a superset.
 expect(hostUpdateState({host:{revision:A,protocol:6},release:null},null,6)).toBe('current');
 expect(hostUpdateState({host:{revision:null,protocol:6},release:{revision:B,protocol:6}},null,6)).toBe('unknown');
});
it('falls back to what the host answers when the list has no report',()=>{
 expect(hostUpdateState({host:null,release:{revision:B,protocol:6}},null,6)).toBe('unknown');
 expect(hostUpdateState({},{protocol:5},6)).toBe('required');
 expect(hostUpdateState({release:{revision:B,protocol:6}},{protocol:6,revision:A},6)).toBe('available');
 expect(hostUpdateState({release:{revision:B,protocol:6}},{protocol:6,revision:B},6)).toBe('current');
 expect(hostUpdateState({host:{revision:A,protocol:5},release:{revision:B,protocol:6}},{protocol:6,revision:B},6)).toBe('required'); // The control plane's report wins over a cached answer.
});

it('a container on an older image than the release has an update available',()=>{
 const image=(digest:string)=>'ghcr.io/fluidworksapp/canopy-workspace@sha256:'+digest.repeat(64);
 expect(hostUpdateState({host:{revision:B,protocol:6,image:image('1')},release:{revision:B,protocol:6,image:image('2')}},null,6)).toBe('available');
 expect(hostUpdateState({host:{revision:B,protocol:6,image:image('2')},release:{revision:B,protocol:6,image:image('2')}},null,6)).toBe('current');
});
it('a failed command outranks the list; otherwise the list decides, then what the connection learned',()=>{
 const required={workspaceId:id,state:'required' as const,command:'gh_pr_list',revision:null};
 expect(workspaceUpdate({host:{revision:B,protocol:6},release:{revision:B,protocol:6}},required)).toEqual({state:'required',command:'gh_pr_list',revision:B});
 expect(workspaceUpdate({host:{revision:B,protocol:6},release:{revision:B,protocol:6}},{...required,state:'available',command:null})).toBeNull();
 expect(workspaceUpdate({host:{revision:A,protocol:6},release:{revision:B,protocol:6}},null)).toEqual({state:'available',command:null,revision:B});
 expect(workspaceUpdate(undefined,{...required,state:'available',command:null,revision:B})).toEqual({state:'available',command:null,revision:B});
 expect(workspaceUpdate(undefined,null)).toBeNull();
});
const status=(operation:unknown,state='ready')=>({workspaces:[{id,state,operation}]});
it('requests update-host with a request key and client id, then waits for the operation to finish',async()=>{
 vi.useFakeTimers();try{
  let reads=0;const progress=vi.fn();
  mocks.invoke.mockImplementation(async(_command,args)=>{if(args.route==='/api/operations')return {accepted:true,operation:{id:'op-1'}};reads++;return status(reads<3?{id:'op-1',action:'update-host',status:'running'}:{id:'op-1',action:'update-host',status:'succeeded'});});
  const done=requestHostUpdate(id,{clientId:'client-1',onProgress:progress});
  await vi.advanceTimersByTimeAsync(6000);await done;
  const [, request]=mocks.invoke.mock.calls[0];
  expect(request).toMatchObject({route:'/api/operations',detailedErrors:true,body:{workspaceId:id,action:'update-host',clientId:'client-1'}});
  expect(request.body.requestKey).toMatch(/^[0-9a-f-]{36}$/);expect(request.body).not.toHaveProperty('confirmOthers');
  expect(progress.mock.calls.map(([p])=>p.phase)).toEqual(['requesting','updating','completed']);
 }finally{vi.useRealTimers();}
});
it('asks before stopping other people\'s sessions, and resubmits only with their confirmation',async()=>{
 const others=JSON.stringify({error:'Members are connected',code:'others-connected',others:2});
 mocks.invoke.mockImplementation(async(_command,args)=>{if(args.route==='/api/operations'){if(!args.body.confirmOthers)throw others;return {accepted:true};}return status({action:'update-host',status:'succeeded'});});
 const confirm=vi.fn(async()=>true);
 await requestHostUpdate(id,{confirmOthers:confirm});
 expect(confirm).toHaveBeenCalledWith(2);
 expect(mocks.invoke.mock.calls.filter(([,args])=>args.route==='/api/operations').map(([,args])=>args.body.confirmOthers)).toEqual([undefined,true]);
 mocks.invoke.mockClear();mocks.invoke.mockImplementation(async()=>{throw others;});
 await expect(requestHostUpdate(id,{confirmOthers:async()=>false})).rejects.toBeInstanceOf(HostUpdateCancelled);
 expect(mocks.invoke).toHaveBeenCalledOnce();
});
it('passes on each new step the host reports through the operation',async()=>{
 vi.useFakeTimers();try{
  let reads=0;const progress=vi.fn();const steps=['download','download','image','bogus'];
  mocks.invoke.mockImplementation(async(_command,args)=>{if(args.route==='/api/operations')return {accepted:true,operation:{id:'op-1'}};const step=steps[reads++];return status(step?{id:'op-1',action:'update-host',status:'running',update_step:step}:{id:'op-1',action:'update-host',status:'succeeded'});});
  const done=requestHostUpdate(id,{onProgress:progress});
  await vi.advanceTimersByTimeAsync(10000);await done;
  expect(progress.mock.calls.map(([p])=>[p.phase,p.step??null])).toEqual([['requesting',null],['updating',null],['updating','download'],['updating','image'],['updating',null],['completed',null]]);
  expect(hostUpdateStepLabel('gateway')).toBe('Restarting the workspace host');expect(hostUpdateStepLabel('bogus')).toBeNull();
 }finally{vi.useRealTimers();}
});
it('reports a refused request and a failed update in plain words',async()=>{
 mocks.invoke.mockImplementation(async()=>{throw JSON.stringify({error:'Only the workspace owner can update it',status:403});});
 await expect(requestHostUpdate(id)).rejects.toThrow('Only the workspace owner can update it');
 mocks.invoke.mockImplementation(async(_command,args)=>args.route==='/api/operations'?{accepted:true}:status({action:'update-host',status:'failed',last_error:'The updated host did not become ready; the previous host is running'}));
 await expect(requestHostUpdate(id)).rejects.toThrow('previous host is running');
 mocks.invoke.mockImplementation(async(_command,args)=>args.route==='/api/operations'?{accepted:true}:status({action:'hibernate',status:'running'},'stopping'));
 await expect(requestHostUpdate(id)).rejects.toThrow('Another workspace action replaced this update');
});
