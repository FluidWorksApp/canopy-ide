import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentIntegrationWarning } from './AgentIntegrationWarning';
import * as ipc from '../ipc';
vi.mock('../ipc',()=>({agentIntegrationHealth:vi.fn(),agentHooksInstalled:vi.fn(),setupAgentHooks:vi.fn(),onAgentEvents:vi.fn()}));
beforeEach(()=>{vi.clearAllMocks();vi.mocked(ipc.onAgentEvents).mockResolvedValue(()=>{});vi.mocked(ipc.agentIntegrationHealth).mockResolvedValue([]);vi.mocked(ipc.agentHooksInstalled).mockResolvedValue(false);});
describe('project integration warning',()=>{
 it('persists after setup failure and disappears only after verification',async()=>{
  vi.mocked(ipc.setupAgentHooks).mockRejectedValueOnce(Error('Unavailable'));
  render(<AgentIntegrationWarning agents={['codex']} />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Set up integrations'}));
  await screen.findByText(/Unavailable/);expect(screen.getByRole('alert')).toBeTruthy();
  vi.mocked(ipc.setupAgentHooks).mockImplementation(async()=>{vi.mocked(ipc.agentHooksInstalled).mockResolvedValue(true);return {agent:'codex',ok:true,steps:[],summary:'Installed'};});
  fireEvent.click(screen.getByRole('button',{name:'Set up integrations'}));
  await screen.findByText('Restart agents to finish integration');
  const callback=vi.mocked(ipc.onAgentEvents).mock.calls[0][0];
  callback(['{"agent":"codex","hook_event_name":"SessionStart"}']);
  await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull());
 });
 it('checks installed agents even without open agent terminals',async()=>{
  vi.mocked(ipc.agentIntegrationHealth).mockResolvedValue([{agent:'claude',cli_installed:true,hooks:'missing',mcp:'ours'}]);
  render(<AgentIntegrationWarning agents={[]} />);
  await screen.findByText(/Claude Code needs setup/);
 });
});

it('clears a transient health failure after a successful account-change recheck',async()=>{
 vi.mocked(ipc.agentIntegrationHealth).mockRejectedValueOnce(Error('Transient disconnect'));
 const view=render(<AgentIntegrationWarning agents={[]}/>);await screen.findByText(/Could not verify/);
 fireEvent(window,new Event('canopy:cli-profile-changed'));
 await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull());view.unmount();
});

it('never shows a restart warning on its own when the integration is installed',async()=>{
 vi.mocked(ipc.agentHooksInstalled).mockResolvedValue(true);
 render(<AgentIntegrationWarning agents={['codex']} targets={[{agent:'codex',ptyId:1,profile:'default'}]}/>);
 await waitFor(()=>expect(ipc.agentHooksInstalled).toHaveBeenCalled());
 await new Promise(resolve=>setTimeout(resolve,20));
 expect(screen.queryByRole('alert')).toBeNull();
});

it('after setup, awaits only the sessions that were already open, each until it reports',async()=>{
 vi.mocked(ipc.setupAgentHooks).mockImplementation(async()=>{vi.mocked(ipc.agentHooksInstalled).mockResolvedValue(true);return {agent:'codex',ok:true,steps:[],summary:'Installed'};});
 const view=render(<AgentIntegrationWarning agents={['codex']} targets={[{agent:'codex',ptyId:1,profile:'default'},{agent:'codex',ptyId:2,profile:'work'}]}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Set up integrations'}));
 await screen.findByText('Restart agents to finish integration');const callback=vi.mocked(ipc.onAgentEvents).mock.calls[0][0];
 callback(['{"agent":"codex","hook_event_name":"SessionStart","canopy_pty":1}']);
 await waitFor(()=>expect(screen.getByRole('alert')).toBeTruthy());
 // A session opened after setup already has the integration.
 view.rerender(<AgentIntegrationWarning agents={['codex']} targets={[{agent:'codex',ptyId:2,profile:'work'},{agent:'codex',ptyId:3,profile:'default'}]}/>);
 callback(['{"agent":"codex","hook_event_name":"SessionStart","canopy_pty":2,"canopy_profile":"work"}']);
 await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull());view.unmount();
});
