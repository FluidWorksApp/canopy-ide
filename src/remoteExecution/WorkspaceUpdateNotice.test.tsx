import {render,screen,fireEvent,act,waitFor} from '@testing-library/react';
import {it,expect,vi,beforeEach} from 'vitest';
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
import {WorkspaceUpdateNotice} from './WorkspaceUpdateNotice';
import {recordHostUpdate} from './hostUpdate';
import {HOST_OUTDATED_EVENT} from './remoteSupport';
import type {ManagedWorkspace} from './ManagedWorkspaces';
const A='a'.repeat(40),B='b'.repeat(40);
let n=0;const id=()=>`ws-${String(++n).padStart(8,'0')}-1111-1111-1111-111111111111`;
const listed=(workspaceId:string,host:ManagedWorkspace['host'],release:ManagedWorkspace['release']={revision:B,protocol:6})=>({id:workspaceId,name:'Studio',state:'ready',memory_max_mib:2048,cpu_max:2,host,release}) as ManagedWorkspace;
beforeEach(()=>{vi.clearAllMocks();try{localStorage.clear();}catch{/* optional */}});

it('offers an available update to the owner, and Later hides it for that release',()=>{
 const w=id();
 const {unmount}=render(<WorkspaceUpdateNotice workspaceId={w} name="Studio" owner listed={listed(w,{revision:A,protocol:6})} reconnect={async()=>{}}/>);
 expect(screen.getByText('A newer Canopy host is ready for Studio.')).toBeTruthy();
 expect(screen.getByRole('button',{name:'Update workspace'})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Later'}));
 expect(screen.queryByText(/newer Canopy host/)).toBeNull();
 unmount();
 render(<WorkspaceUpdateNotice workspaceId={w} name="Studio" owner listed={listed(w,{revision:A,protocol:6})} reconnect={async()=>{}}/>);
 expect(screen.queryByText(/newer Canopy host/)).toBeNull();
});

it('names the feature that failed when an update is required, never a background probe',()=>{
 const w=id(),other=id();
 act(()=>{window.dispatchEvent(new CustomEvent(HOST_OUTDATED_EVENT,{detail:{workspaceId:w,state:'required',command:'gh_pr_list',revision:null}}));});
 render(<WorkspaceUpdateNotice workspaceId={w} name="Studio" owner listed={undefined} reconnect={async()=>{}}/>);
 expect(screen.getByText('Studio needs an update to use GitHub pull requests and issues and other parts of this version.')).toBeTruthy();
 expect(screen.getByRole('button',{name:'Not now'})).toBeTruthy();
 act(()=>{window.dispatchEvent(new CustomEvent(HOST_OUTDATED_EVENT,{detail:{workspaceId:other,state:'required',command:null,revision:null}}));});
 render(<WorkspaceUpdateNotice workspaceId={other} name="Lab" owner listed={undefined} reconnect={async()=>{}}/>);
 expect(screen.getByText('Lab needs an update to work with this version of Canopy.')).toBeTruthy();
});

it('tells a member to ask the owner, with no update button',()=>{
 const w=id();
 render(<WorkspaceUpdateNotice workspaceId={w} name="Studio" owner={false} listed={listed(w,{revision:A,protocol:5})} reconnect={async()=>{}}/>);
 expect(screen.getByText('Studio needs an update to work with this version of Canopy.')).toBeTruthy();
 expect(screen.getByText('Ask the workspace owner to update it.')).toBeTruthy();
 expect(screen.queryByRole('button',{name:'Update workspace'})).toBeNull();
});

it('says nothing for a current workspace',()=>{
 const w=id();
 const {container}=render(<WorkspaceUpdateNotice workspaceId={w} name="Studio" owner listed={listed(w,{revision:B,protocol:6})} reconnect={async()=>{}}/>);
 expect(container.textContent).toBe('');
});

it('confirms, asks before stopping other people, shows progress, then reconnects',async()=>{
 const w=id(),reconnect=vi.fn(async()=>{});let requests=0;
 mocks.invoke.mockImplementation(async(_command,args)=>{
  if(args?.route==='/api/operations'){requests++;if(!args.body.confirmOthers)throw JSON.stringify({error:'Others are connected',code:'others-connected',others:2});return {accepted:true,operation:{id:'op'}};}
  if(args?.body?.action==='status')return {workspaces:[{id:w,state:'ready',operation:{id:'op',action:'update-host',status:'succeeded'}}]};
  return {workspaces:[]};
 });
 render(<WorkspaceUpdateNotice workspaceId={w} name="Studio" owner listed={listed(w,{revision:A,protocol:5})} clientId="client-1" reconnect={reconnect}/>);
 fireEvent.click(screen.getByRole('button',{name:'Update workspace'}));
 expect(screen.getByText('Terminals and agents in this workspace restart. Your files and projects are kept.')).toBeTruthy();
 fireEvent.click(screen.getAllByRole('button',{name:'Update workspace'}).at(-1)!);
 await screen.findByText('2 other people are connected. Their terminals and agents stop too; they come back when they open the workspace again.');
 expect(screen.getByText('Updating Studio…')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Update anyway'}));
 await screen.findByText('Studio is up to date.');
 expect(requests).toBe(2);expect(reconnect).toHaveBeenCalledOnce();
 const sent=mocks.invoke.mock.calls.filter(([,args])=>args?.route==='/api/operations').map(([,args])=>args.body);
 expect(sent[1]).toMatchObject({workspaceId:w,action:'update-host',clientId:'client-1',confirmOthers:true});
});

it('shows a failed update with a retry, and cancelling the confirmation changes nothing',async()=>{
 const w=id();
 mocks.invoke.mockImplementation(async()=>{throw JSON.stringify({error:'The workspace update failed. The previous host is running.'});});
 render(<WorkspaceUpdateNotice workspaceId={w} name="Studio" owner listed={listed(w,{revision:A,protocol:6})} reconnect={async()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:'Update workspace'}));
 fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
 expect(mocks.invoke).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Update workspace'}));
 fireEvent.click(screen.getAllByRole('button',{name:'Update workspace'}).at(-1)!);
 await waitFor(()=>expect(screen.getByText('The workspace update failed. The previous host is running.')).toBeTruthy());
 expect(screen.getByRole('button',{name:'Try again'})).toBeTruthy();
 recordHostUpdate(null,w);
});

it('shows the host\'s current step while updating, and the operation\'s error when it fails',async()=>{
 const w=id();let reads=0;
 mocks.invoke.mockImplementation(async(_command,args)=>{
  if(args?.route==='/api/operations')return {accepted:true,operation:{id:'op'}};
  if(args?.body?.action==='status'){reads++;return {workspaces:[{id:w,state:'ready',operation:reads===1?{id:'op',action:'update-host',status:'running',context:{updateStep:'rollback'}}:{id:'op',action:'update-host',status:'failed',last_error:'The new image did not become ready; the previous container is running.'}}]};}
  return {workspaces:[]};
 });
 render(<WorkspaceUpdateNotice workspaceId={w} name="Studio" owner listed={listed(w,{revision:A,protocol:5})} reconnect={async()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:'Update workspace'}));
 fireEvent.click(screen.getAllByRole('button',{name:'Update workspace'}).at(-1)!);
 await screen.findByText('Rolling back. Your files and projects are kept. Terminals and agents restart.');
 await screen.findByText('The new image did not become ready; the previous container is running.',undefined,{timeout:4000});
 expect(screen.getByRole('button',{name:'Try again'})).toBeTruthy();
});
