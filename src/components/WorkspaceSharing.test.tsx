import {render,screen,fireEvent,waitFor,act,within} from '@testing-library/react';
import {it,expect,vi,beforeEach} from 'vitest';
import {WorkspaceSharing} from './WorkspaceSharing';
const invoke=vi.hoisted(()=>vi.fn());vi.mock('@tauri-apps/api/core',()=>({invoke}));
type Body={action:string;[key:string]:unknown};
const listing=(shares:unknown[]=[])=>({organizationId:'org',organizationName:'Canopy Labs',people:[{id:'ada',name:'Ada',email:'ada@example.invalid'},{id:'bo',name:'Bo',email:'bo@example.invalid'}],teams:[{id:'core',name:'Core'}],shares});
function fixture(overrides:Record<string,unknown>={}){invoke.mockImplementation(async(_:string,{body}:{body:Body}={body:{action:''}})=>{
 if(body.action in overrides){const result=overrides[body.action];if(result instanceof Error)throw result;return typeof result==='function'?(result as (b:Body)=>unknown)(body):result;}
 if(body.action==='workspace-share-list')return listing();
 if(body.action==='sharing-status')return {sharing:{state:'off',enabled:false,ready:false,error:null}};
 if(body.action==='organization-list')return {organizations:[{id:'org',name:'Canopy Labs'}]};
 return {ok:true};
});}
const calls=(action:string)=>invoke.mock.calls.map(([,args])=>args.body).filter((b:Body)=>b.action===action);
beforeEach(()=>invoke.mockReset());

it('shares like a document: who, Can view / Can edit, and three switches with Projects on by default',async()=>{
 fixture();render(<WorkspaceSharing workspaceId="ws" workspaceName="Machine Works"/>);
 fireEvent.click(await screen.findByRole('button',{name:'Share'}));
 const dialog=screen.getByRole('form',{name:'Share workspace'});
 expect(within(dialog).getByRole('combobox',{name:'Access'})).toHaveValue('edit');
 expect(within(dialog).getByRole('checkbox',{name:'Projects'})).toBeChecked();
 expect(within(dialog).getByRole('checkbox',{name:'Agent sessions'})).not.toBeChecked();
 expect(within(dialog).getByRole('checkbox',{name:'Agents'})).not.toBeChecked();expect(within(dialog).getByRole('checkbox',{name:'Git'})).not.toBeChecked();
 const options=within(within(dialog).getByRole('combobox',{name:'Share with'})).getAllByRole('option').map(o=>o.textContent);
 expect(options).toEqual(['Choose a person, team or everyone','Everyone in Canopy Labs','Team · Core','Ada · ada@example.invalid','Bo · bo@example.invalid']);
 for(const jargon of [/Admin/,/Developer/,/Viewer/,/projects:all/,/agents:shared/,/Enable workspace sharing/,/Prepare shared storage/])expect(screen.queryByText(jargon)).toBeNull();
 fireEvent.change(within(dialog).getByRole('combobox',{name:'Share with'}),{target:{value:'team:core'}});
 fireEvent.click(within(dialog).getByRole('checkbox',{name:'Agent sessions'}));
 fireEvent.click(within(dialog).getByRole('button',{name:'Share'}));
 await waitFor(()=>expect(calls('workspace-share-set')).toEqual([{action:'workspace-share-set',workspaceId:'ws',subject:{type:'team',id:'core'},level:'edit',projects:true,sessions:true,agents:false,git:false,accounts:false}]));
 expect(await screen.findByText('Shared with Core.')).toBeInTheDocument();
});
it('lists each share once with its level and switches editable inline, and removes in one click',async()=>{
 fixture({'workspace-share-list':listing([{subject:{type:'person',id:'ada',name:'Ada',email:'ada@example.invalid'},level:'view',projects:true,sessions:false,accounts:false,via:['Core']},{subject:{type:'team',id:'core',name:'Core'},level:'edit',projects:true,sessions:true,accounts:true,via:[]}])});
 render(<WorkspaceSharing workspaceId="ws"/>);
 const list=await screen.findByRole('list',{name:'Shared with'});
 expect(within(list).getAllByRole('listitem')).toHaveLength(2);
 expect(within(list).getByText('ada@example.invalid · also via team Core')).toBeInTheDocument();
 const ada=within(list).getByText('Ada').closest('li')!;
 // A control plane from before the split lists one accounts switch: it reads as both.
 const core=within(list).getByText('Core').closest('li')!;expect(within(core).getByRole('checkbox',{name:'Agents'})).toBeChecked();expect(within(core).getByRole('checkbox',{name:'Git'})).toBeChecked();
 fireEvent.change(within(ada).getByRole('combobox',{name:'Access'}),{target:{value:'edit'}});
 await waitFor(()=>expect(calls('workspace-share-set').at(-1)).toEqual({action:'workspace-share-set',workspaceId:'ws',subject:{type:'person',id:'ada'},level:'edit',projects:true,sessions:false,agents:false,git:false,accounts:false}));
 fireEvent.click(within(ada).getByRole('checkbox',{name:'Agents'}));
 await waitFor(()=>expect(calls('workspace-share-set').at(-1)).toMatchObject({subject:{type:'person',id:'ada'},agents:true,git:false,accounts:false}));
 fireEvent.click(within(list).getByRole('button',{name:'Stop sharing with Core'}));
 await waitFor(()=>expect(calls('workspace-share-remove')).toEqual([{action:'workspace-share-remove',workspaceId:'ws',subject:{type:'team',id:'core'}}]));
});
it('a share always keeps Projects or Agent sessions on',async()=>{
 fixture();render(<WorkspaceSharing workspaceId="ws"/>);
 fireEvent.click(await screen.findByRole('button',{name:'Share'}));
 const dialog=screen.getByRole('form',{name:'Share workspace'});
 expect(within(dialog).getByRole('checkbox',{name:'Projects'})).toBeDisabled();
 fireEvent.click(within(dialog).getByRole('checkbox',{name:'Agent sessions'}));
 fireEvent.click(within(dialog).getByRole('checkbox',{name:'Projects'}));
 expect(within(dialog).getByRole('checkbox',{name:'Projects'})).not.toBeChecked();
 expect(within(dialog).getByRole('checkbox',{name:'Agent sessions'})).toBeDisabled();
});
it('shows one sharing line that turns from not shared to getting ready after a share',async()=>{
 let sharing={state:'off',enabled:false,ready:false,error:null as string|null};let shared=false;
 fixture({'sharing-status':()=>({sharing}),'workspace-share-list':()=>listing(shared?[{subject:{type:'team',id:'core',name:'Core'},level:'edit',projects:true,sessions:false,accounts:false,via:[]}]:[]),'workspace-share-set':()=>{shared=true;sharing={state:'pending',enabled:true,ready:false,error:null};return {ok:true};}});
 render(<WorkspaceSharing workspaceId="ws"/>);
 expect(await screen.findByText('Not shared · Add a person or team to share this workspace')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Share'}));
 fireEvent.change(screen.getByRole('combobox',{name:'Share with'}),{target:{value:'team:core'}});
 fireEvent.click(within(screen.getByRole('form',{name:'Share workspace'})).getByRole('button',{name:'Share'}));
 expect(await screen.findByText('Getting ready · Members can connect in a minute')).toBeInTheDocument();
 expect(invoke.mock.calls.some(([,args])=>['activate-sharing','sharing-start','sharing-on'].includes(args.body.action))).toBe(false);
});
it('a failed readiness check shows its reason with Retry',async()=>{
 let sharing={state:'failed',enabled:true,ready:false,error:'The workspace host needs an update to share. Restart the workspace to update it' as string|null};
 fixture({'sharing-status':()=>({sharing}),'sharing-retry':()=>{sharing={state:'ready',enabled:true,ready:true,error:null};return {sharing};}});
 render(<WorkspaceSharing workspaceId="ws"/>);
 expect(await screen.findByText('Not ready: The workspace host needs an update to share. Restart the workspace to update it')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Retry'}));
 expect(await screen.findByText('Sharing on · People with access can connect')).toBeInTheDocument();
});
it('turning sharing off asks first',async()=>{
 fixture({'sharing-status':{sharing:{state:'ready',enabled:true,ready:true,error:null}},'sharing-off':{sharing:{state:'off',enabled:false,ready:false,error:null}},'workspace-share-list':listing([{subject:{type:'team',id:'core',name:'Core'},level:'edit',projects:true,sessions:false,accounts:false,via:[]}])});
 render(<WorkspaceSharing workspaceId="ws"/>);
 fireEvent.click(await screen.findByRole('button',{name:'Turn off'}));expect(calls('sharing-off')).toHaveLength(0);
 fireEvent.click(screen.getByRole('button',{name:'Turn off sharing'}));
 expect(await screen.findByText('Sharing off · People with access can’t connect')).toBeInTheDocument();
});
it('people who are not the owner are told only the owner can change sharing',async()=>{
 fixture({'workspace-share-list':Error('Only the workspace owner can change who it is shared with')});
 render(<WorkspaceSharing workspaceId="ws" workspaceName="Machine Works"/>);
 expect(await screen.findByText('Only the owner of Machine Works can change who it is shared with.')).toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'Share'})).toBeNull();expect(calls('sharing-status')).toHaveLength(0);
});
it('a workspace outside an organization offers to add it first',async()=>{
 fixture({'workspace-share-list':{organizationId:null,organizationName:null,people:[],teams:[],shares:[]}});
 render(<WorkspaceSharing workspaceId="ws"/>);
 fireEvent.change(await screen.findByRole('combobox'),{target:{value:'org'}});
 fireEvent.click(screen.getByRole('button',{name:'Add to organization'}));
 await waitFor(()=>expect(calls('organization-workspace-attach')).toEqual([{action:'organization-workspace-attach',organizationId:'org',workspaceId:'ws'}]));
});
it('ignores a response for a previous workspace or account',async()=>{
 let resolveOld!:(value:unknown)=>void;
 fixture({'workspace-share-list':(body:Body)=>body.workspaceId==='old'?new Promise(resolve=>{resolveOld=resolve;}):listing()});
 const view=render(<WorkspaceSharing workspaceId="old"/>);view.rerender(<WorkspaceSharing workspaceId="new"/>);
 await screen.findByText('Not shared with anyone yet.');
 await act(async()=>resolveOld(listing([{subject:{type:'team',id:'stale',name:'Old private team'},level:'edit',projects:true,sessions:false,accounts:false,via:[]}])));
 expect(screen.queryByText('Old private team')).toBeNull();
});
