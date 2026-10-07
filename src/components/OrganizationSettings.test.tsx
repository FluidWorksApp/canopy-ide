import {render,screen,fireEvent,waitFor,act} from '@testing-library/react';
import {beforeEach,it,expect,vi} from 'vitest';
import {OrganizationSettings} from './OrganizationSettings';
const invoke=vi.hoisted(()=>vi.fn());vi.mock('@tauri-apps/api/core',()=>({invoke}));
beforeEach(()=>{invoke.mockReset();invoke.mockImplementation(async(_command,{body})=>{
 if(body.action==='organization-list')return {organizations:[{id:'org',name:'Canopy',role:'owner'}],invitations:[{id:'invite',name:'Partner'}]};
 if(body.action==='organization-detail')return {role:'owner',members:[{id:'owner',name:'Sam',email:'sam@example.invalid',role:'owner'},{id:'member',name:'Ada',email:'ada@example.invalid',role:'member'}],teams:[{id:'team',name:'Engineering',members:[{id:'member',name:'Ada',email:'ada@example.invalid',role:'member'}]}]};
 return {ok:true};
});});
it('uses account organization invitations and never renders a chat composer',async()=>{
 render(<OrganizationSettings/>);fireEvent.click(await screen.findByRole('button',{name:'Accept invitation'}));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('canopy_account_request',expect.objectContaining({body:expect.objectContaining({action:'organization-accept',invitationId:'invite'})})));
 expect(screen.queryByRole('textbox',{name:'Message'})).toBeNull();
});
it('requires confirmation before removing a member',async()=>{
 render(<OrganizationSettings/>);fireEvent.click(await screen.findByRole('button',{name:'Remove'}));
 expect(invoke.mock.calls.some(([,args])=>args.body.action==='organization-member-remove')).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Remove member'}));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('canopy_account_request',expect.objectContaining({body:expect.objectContaining({action:'organization-member-remove',organizationId:'org',userId:'member'})})));
});
it('adds an organization member to a selected reusable team',async()=>{
 render(<OrganizationSettings/>);await screen.findByRole('button',{name:'Add to team'});
 fireEvent.change(screen.getByRole('combobox',{name:'Person'}),{target:{value:'member'}});
 fireEvent.change(screen.getByRole('combobox',{name:'Team'}),{target:{value:'team'}});
 fireEvent.click(screen.getByRole('button',{name:'Add to team'}));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('canopy_account_request',expect.objectContaining({body:expect.objectContaining({action:'organization-team-member-add',organizationId:'org',userId:'member',teamId:'team'})})));
});

it('shows team membership and confirms team-only removal',async()=>{
 render(<OrganizationSettings/>);fireEvent.click(await screen.findByText('Engineering',{selector:'strong'}));
 fireEvent.click(screen.getByRole('button',{name:'Remove Ada from Engineering'}));
 expect(invoke.mock.calls.some(([,args])=>args.body.action==='organization-team-member-remove')).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Confirm removal'}));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('canopy_account_request',expect.objectContaining({body:expect.objectContaining({action:'organization-team-member-remove',organizationId:'org',teamId:'team',userId:'member'})})));
});

it('clears old account data and ignores its pending directory response',async()=>{
 let resolveOld!:(value:unknown)=>void;let first=true;invoke.mockImplementation(async(_,{body})=>{if(body.action==='organization-list'&&first){first=false;return new Promise(resolve=>{resolveOld=resolve;});}return {organizations:[],invitations:[]};});
 render(<OrganizationSettings/>);await act(async()=>window.dispatchEvent(new Event('canopy:account-changed')));
 await act(async()=>resolveOld({organizations:[{id:'old',name:'Private old organization',role:'owner'}],invitations:[]}));
 expect(screen.queryByText('Private old organization')).toBeNull();
});
