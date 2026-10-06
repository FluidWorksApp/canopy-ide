import {test,expect,vi,beforeEach} from 'vitest';import {render,screen,fireEvent,waitFor} from '@testing-library/react';
vi.mock('../remoteExecution/sharedAccountsClient',()=>({sharedAccountRequest:vi.fn()}));
import {sharedAccountRequest} from '../remoteExecution/sharedAccountsClient';import {SharedAccountsPanel} from './SharedAccountsPanel';
const projects=[{id:'app',name:'Product'}];
beforeEach(()=>{vi.clearAllMocks();vi.mocked(sharedAccountRequest).mockResolvedValue({bindings:[]});});
test('saving a key imports then selects it and clears its field before completion',async()=>{
 const view=render(<SharedAccountsPanel workspaceId="workspace" projects={projects}/>);
 fireEvent.click(screen.getByRole('button',{name:'Configure Claude for Product'}));
 fireEvent.change(screen.getByLabelText('Provider API key'),{target:{value:'synthetic-private-key'}});
 fireEvent.submit(screen.getByText('Save account').closest('form')!);
 await screen.findByText('Shared account saved.');expect(screen.queryByLabelText('Provider API key')).toBeNull();
 expect(sharedAccountRequest).toHaveBeenCalledWith('workspace',{action:'import',accountId:'claude-app',credential:{provider:'anthropic',token:'synthetic-private-key'}});
 expect(sharedAccountRequest).toHaveBeenCalledWith('workspace',{action:'bind',accountId:'claude-app',projectId:'app',slot:'claude'});view.unmount();
});
test('failed import clears the key, avoids selection and permits retry',async()=>{
 vi.mocked(sharedAccountRequest).mockRejectedValueOnce(Error('failure'));render(<SharedAccountsPanel workspaceId="workspace" projects={projects}/>);
 fireEvent.click(screen.getByRole('button',{name:'Configure Codex for Product'}));fireEvent.change(screen.getByLabelText('Provider API key'),{target:{value:'synthetic'}});fireEvent.submit(screen.getByText('Save account').closest('form')!);
 await screen.findByRole('alert');expect(screen.getByLabelText('Provider API key')).toHaveValue('');expect(sharedAccountRequest).toHaveBeenCalledTimes(1);expect(screen.getByText('Save account')).toBeDisabled();
});
test('workspace changes clear secrets and prevent a stale import from selecting an account',async()=>{
 let resolve!:(value:unknown)=>void;vi.mocked(sharedAccountRequest).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));const view=render(<SharedAccountsPanel workspaceId="old" projects={projects}/>);
 fireEvent.click(screen.getByRole('button',{name:'Configure Claude for Product'}));fireEvent.change(screen.getByLabelText('Provider API key'),{target:{value:'synthetic'}});fireEvent.submit(screen.getByText('Save account').closest('form')!);
 view.rerender(<SharedAccountsPanel workspaceId="new" projects={projects}/>);resolve({imported:true});await waitFor(()=>expect(screen.queryByText('Shared account saved.')).toBeNull());expect(sharedAccountRequest).toHaveBeenCalledTimes(1);expect(screen.getByRole('button',{name:'Configure Claude for Product'})).not.toBeDisabled();expect(screen.queryByLabelText('Provider API key')).toBeNull();
});

test('explicit subscription import sends only normalized credentials and clears password JSON immediately',async()=>{
 let resolve!:(value:unknown)=>void;vi.mocked(sharedAccountRequest).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 render(<SharedAccountsPanel workspaceId="workspace" projects={projects}/>);
 fireEvent.click(screen.getByRole('button',{name:'Configure Claude for Product'}));
 fireEvent.change(screen.getByLabelText('Account type'),{target:{value:'oauth'}});
 const field=screen.getByLabelText('Subscription sign-in JSON');expect(field).toHaveAttribute('type','password');
 fireEvent.change(field,{target:{value:JSON.stringify({claudeAiOauth:{accessToken:'synthetic-access',refreshToken:'synthetic-refresh',expiresAt:1760000000000},privateConfig:{discard:true}})}});
 fireEvent.submit(screen.getByText('Save account').closest('form')!);
 expect(field).toHaveValue('');
 expect(sharedAccountRequest).toHaveBeenCalledWith('workspace',{action:'import',accountId:'claude-app',credential:{provider:'anthropic',authType:'oauth',token:'synthetic-access',refreshToken:'synthetic-refresh',expiresAt:1760000000000}});
 resolve({imported:true});await screen.findByText('Shared account saved.');expect(screen.queryByLabelText('Subscription sign-in JSON')).toBeNull();
});

test('invalid provider export never reaches the host and changing account type clears the secret',async()=>{
 render(<SharedAccountsPanel workspaceId="workspace" projects={projects}/>);
 fireEvent.click(screen.getByRole('button',{name:'Configure Codex for Product'}));
 fireEvent.change(screen.getByLabelText('Provider API key'),{target:{value:'synthetic-key'}});
 fireEvent.change(screen.getByLabelText('Account type'),{target:{value:'oauth'}});
 expect(screen.getByLabelText('Subscription sign-in JSON')).toHaveValue('');
 fireEvent.change(screen.getByLabelText('Subscription sign-in JSON'),{target:{value:JSON.stringify({provider:'anthropic',authType:'oauth',token:'a',refreshToken:'r',expiresAt:1})}});
 fireEvent.submit(screen.getByText('Save account').closest('form')!);
 await screen.findByRole('alert');expect(sharedAccountRequest).not.toHaveBeenCalled();expect(screen.getByLabelText('Subscription sign-in JSON')).toHaveValue('');
});
