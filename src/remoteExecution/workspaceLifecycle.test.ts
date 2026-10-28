import {afterEach,beforeEach,expect,it,vi} from 'vitest';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
import type {ManagedWorkspace} from './ManagedWorkspaces';
import {STOP_ACKNOWLEDGE_TIMEOUT_MS,markStopRequested,reconcileStopRequests,resetWorkspaceLifecycle,saveStopSwitchNotice,stopRequestError,stopRequested,takeStopSwitchNotice,dismissStopSwitchNotice,workspaceLifecycle} from './workspaceLifecycle';
import {workspaceStatus} from './WorkspaceHero';
import {workspaceStartupProblem} from './ManagedWorkspaces';

const base:ManagedWorkspace={id:'ws-a',name:'Machine Works',provider:'lightsail',state:'ready',cpu_max:2,memory_max_mib:8192};
const w=(patch:Partial<ManagedWorkspace>={}):ManagedWorkspace=>({...base,...patch});
const hibernate=(status:string,last_error?:string)=>({phase:'quiesce',status,action:'hibernate',last_error});
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(1_000_000);});
afterEach(()=>{resetWorkspaceLifecycle();dismissStopSwitchNotice();vi.useRealTimers();});

it('derives one lifecycle from server state and the latest operation',()=>{
 expect(workspaceLifecycle(w())).toBe('running');
 expect(workspaceLifecycle(w({state:'starting'}))).toBe('starting');
 expect(workspaceLifecycle(w({state:'created'}))).toBe('not-started');
 expect(workspaceLifecycle(w({state:'stopped'}))).toBe('stopped');
 expect(workspaceLifecycle(w({state:'deleting'}))).toBe('deleting');
 expect(workspaceLifecycle(w({state:'error'}))).toBe('error');
 // The control plane queues the stop while the row still reads ready.
 expect(workspaceLifecycle(w({operation:hibernate('pending')}))).toBe('stopping');
 expect(workspaceLifecycle(w({state:'stopping',operation:hibernate('running')}))).toBe('stopping');
 expect(workspaceLifecycle(w({state:'stopping',operation:hibernate('failed','Provider refused')}))).toBe('error');
});

it('a failed Update workspace leaves a running workspace running',()=>{
 // Seen 2026-10-28: an update-host refused by a host from before 0.5.3 turned
 // a ready workspace into "Needs attention" with Retry preparation.
 const update={phase:'dispatch',status:'failed',action:'update-host',last_error:'This workspace host cannot update in place. Hibernate and resume the workspace to get the new release.'};
 expect(workspaceLifecycle(w({operation:update}))).toBe('running');
 expect(workspaceStatus(w({operation:update}))).toMatchObject({label:'Running'});
 expect(workspaceStartupProblem(w({operation:update}))).toBeNull();
 expect(workspaceLifecycle(w({state:'error',operation:update}))).toBe('error');
 expect(workspaceLifecycle(w({operation:{phase:'boot',status:'failed',action:'resume'}}))).toBe('error');
});

it('every surface reads the same stopping label from that lifecycle',()=>{
 expect(workspaceStatus(w({operation:hibernate('pending')}))).toMatchObject({label:'Stopping…',tone:'attention',busy:true});
 expect(workspaceStatus(w({state:'stopped'}))).toMatchObject({label:'Stopped'});
 expect(workspaceStatus(w())).toMatchObject({label:'Running'});
});

it('does not flip back to Running while an accepted stop is not yet visible on the server',()=>{
 markStopRequested('ws-a');
 expect(workspaceLifecycle(w())).toBe('stopping');
 reconcileStopRequests([w()]);
 expect(stopRequested('ws-a')).toBe(true);expect(workspaceLifecycle(w())).toBe('stopping');
 // Server acknowledges, then settles.
 reconcileStopRequests([w({operation:hibernate('pending')})]);
 expect(workspaceLifecycle(w())).toBe('stopping');
 reconcileStopRequests([w({state:'stopped',operation:{...hibernate('succeeded'),phase:'complete'}})]);
 expect(stopRequested('ws-a')).toBe(false);expect(stopRequestError('ws-a')).toBeUndefined();
});

it('an acknowledged stop keeps Stopping even past the acknowledgement timeout',()=>{
 markStopRequested('ws-a');
 reconcileStopRequests([w({state:'stopping',operation:hibernate('running')})]);
 vi.setSystemTime(1_000_000+STOP_ACKNOWLEDGE_TIMEOUT_MS*3);
 expect(workspaceLifecycle(w())).toBe('stopping');
});

it('times out an unacknowledged stop with an inline error instead of hanging',()=>{
 markStopRequested('ws-a');
 vi.setSystemTime(1_000_000+STOP_ACKNOWLEDGE_TIMEOUT_MS);
 expect(workspaceLifecycle(w())).toBe('running');
 reconcileStopRequests([w()]);
 expect(stopRequested('ws-a')).toBe(false);
 expect(stopRequestError('ws-a')).toMatch(/still reports running/);
 // Asking again clears the error.
 markStopRequested('ws-a');expect(stopRequestError('ws-a')).toBeUndefined();
});

it('reports a failed stop and clears it when another action replaces an acknowledged stop',()=>{
 markStopRequested('ws-a');
 reconcileStopRequests([w({operation:hibernate('failed','Provider refused the stop')})]);
 expect(stopRequestError('ws-a')).toBe('Provider refused the stop');
 expect(workspaceLifecycle(w({operation:hibernate('failed','Provider refused the stop')}))).toBe('error');
 markStopRequested('ws-a');
 reconcileStopRequests([w({operation:hibernate('pending')})]);
 reconcileStopRequests([w({state:'starting',operation:{phase:'starting',status:'running',action:'resume'}})]);
 expect(stopRequested('ws-a')).toBe(false);
});

it('keeps pending stops across the reload that switches to the local workspace',async()=>{
 markStopRequested('ws-a');
 saveStopSwitchNotice({workspaceId:'ws-a',name:'Machine Works',at:Date.now()});
 vi.resetModules();
 const reloaded=await import('./workspaceLifecycle');
 expect(reloaded.workspaceLifecycle(w())).toBe('stopping');
 expect(reloaded.takeStopSwitchNotice()).toMatchObject({workspaceId:'ws-a',name:'Machine Works'});
 reloaded.resetWorkspaceLifecycle();
 expect(takeStopSwitchNotice()).toMatchObject({workspaceId:'ws-a'});
});
