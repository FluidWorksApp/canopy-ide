import {afterEach,expect,it,vi} from 'vitest';import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
const mocks=vi.hoisted(()=>({invoke:vi.fn(),write:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
vi.mock('../terminalClipboard',()=>({writeClipboardText:mocks.write}));
import {ReadableLinksSettings} from './ReadableLinksSettings';
afterEach(()=>{cleanup();mocks.invoke.mockReset();mocks.write.mockReset();});
const team='22222222-2222-4222-8222-222222222222';
const links=[
 {url:'https://canopyide.dev/platform/api',kind:'workspace',target:{workspaceId:'ws-1',name:'API Server'},about:{teamName:'Platform',activity:'opened',activityAt:'2026-10-20T12:00:00.000Z'},createdAt:'2026-10-01T00:00:00.000Z',mine:true,canRevoke:true},
 {url:'https://canopyide.dev/platform/t/general/quiet-otter-41',kind:'message',target:{teamId:team,teamName:'Platform',peer:null,peerName:'',messageId:'m',viewer:'alice'},about:{teamName:'Platform',activity:'shared',activityAt:'2026-10-02T00:00:00.000Z'},createdAt:'2026-10-02T00:00:00.000Z',mine:false,canRevoke:false},
];
const calls=()=>mocks.invoke.mock.calls.map(([,args])=>(args as {body:{action:string}}).body);

it('lists the account\'s links with copy and open, and revoke only where allowed',async()=>{
 mocks.invoke.mockResolvedValue({links});mocks.write.mockResolvedValue(true);
 render(<ReadableLinksSettings/>);
 expect(await screen.findByText('API Server')).toBeInTheDocument();
 expect(calls()).toEqual([{action:'list'}]);
 expect(screen.getByText('Message in the team channel')).toBeInTheDocument();
 expect(screen.getByText(/Platform · Last opened .* · Made by you/)).toBeInTheDocument();
 expect(screen.getByText(/Team link$/)).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Revoke link to API Server'})).toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'Revoke link to Message in the team channel'})).toBeNull();

 fireEvent.click(screen.getByRole('button',{name:'Copy link to API Server'}));
 await waitFor(()=>expect(mocks.write).toHaveBeenCalledWith('https://canopyide.dev/platform/api'));
 expect(await screen.findByRole('button',{name:'Copied link to API Server'})).toBeInTheDocument();

 const followed=vi.fn();window.addEventListener('canopy:follow-deep-link',followed);
 fireEvent.click(screen.getByRole('button',{name:'Open Message in the team channel'}));
 window.removeEventListener('canopy:follow-deep-link',followed);
 expect((followed.mock.calls[0][0] as CustomEvent).detail).toEqual({url:'https://canopyide.dev/platform/t/general/quiet-otter-41'});
});

it('revokes after a confirmation and drops the row',async()=>{
 mocks.invoke.mockImplementation(async(_cmd:string,{body}:{body:{action:string}})=>body.action==='list'?{links}:{revoked:true});
 render(<ReadableLinksSettings/>);
 fireEvent.click(await screen.findByRole('button',{name:'Revoke link to API Server'}));
 expect(calls()).toEqual([{action:'list'}]);
 fireEvent.click(screen.getByRole('button',{name:'Keep'}));
 expect(screen.getByText('API Server')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Revoke link to API Server'}));
 fireEvent.click(screen.getByRole('button',{name:'Revoke'}));
 await waitFor(()=>expect(screen.queryByText('API Server')).toBeNull());
 expect(calls()[1]).toEqual({action:'revoke',url:'https://canopyide.dev/platform/api'});
 expect(screen.getByRole('status')).toHaveTextContent('Revoked API Server');
});

it('shows an empty state, and a plain error when links cannot load',async()=>{
 mocks.invoke.mockResolvedValueOnce({links:[]});
 render(<ReadableLinksSettings/>);
 expect(await screen.findByText(/No links yet/)).toBeInTheDocument();
 cleanup();
 mocks.invoke.mockRejectedValueOnce('Cannot reach Canopy. Check your connection and try again.');
 render(<ReadableLinksSettings/>);
 expect(await screen.findByRole('alert')).toHaveTextContent('Links could not load. Cannot reach Canopy.');
});
