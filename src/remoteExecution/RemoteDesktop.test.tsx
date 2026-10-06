// @vitest-environment jsdom
import {render,waitFor,cleanup,act} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {createRef} from 'react';
import {RemoteDesktop,type RemoteDesktopCapture} from './RemoteDesktop';
import type {RemoteExecutionClient} from './client';
const mock=vi.hoisted(()=>({connect:vi.fn(),disconnect:vi.fn(),png:vi.fn(()=>'data:image/png;base64,c3ludGhldGlj'),events:new Map<string,()=>void>()}));
vi.mock('@novnc/novnc',()=>({default:class{constructor(...args:unknown[]){mock.connect(...args);} addEventListener(name:string,callback:()=>void){mock.events.set(name,callback);} toDataURL(){return mock.png();} disconnect(){mock.disconnect();}}}));
afterEach(()=>{cleanup();vi.clearAllMocks();mock.events.clear();vi.restoreAllMocks();});
it('starts the browser in the selected workspace before connecting its authenticated display',async()=>{
 const workspace=vi.fn().mockResolvedValue({});const streamUrl=vi.fn().mockResolvedValue('wss://example.test/single-use-ticket');
 const client={workspace,streamUrl} as unknown as RemoteExecutionClient;
 const view=render(<RemoteDesktop client={client} workspaceId="alice" previewUrl="http://localhost:6001"/>);
 await waitFor(()=>expect(mock.connect).toHaveBeenCalledOnce());
 expect(workspace.mock.calls).toEqual([
  ['alice','/desktop',{}],['alice','/native',{command:'desktop_session',args:{}}],
  ['alice','/native',{command:'workspace_preview_open',args:{url:'http://localhost:6001'}}],
 ]);
 expect(streamUrl).toHaveBeenCalledWith('alice','/desktop/ws');
 view.unmount();expect(mock.disconnect).toHaveBeenCalledOnce();
});
it('shows browser launch failures and does not connect a misleading desktop',async()=>{
 const workspace=vi.fn().mockImplementation(async(_id,_path,body)=>{if(body.command==='workspace_preview_open')throw Error('Browser unavailable');return {};});
 const streamUrl=vi.fn();const client={workspace,streamUrl} as unknown as RemoteExecutionClient;
 const view=render(<RemoteDesktop client={client} workspaceId="alice" previewUrl="http://localhost:6001"/>);
 await view.findByText('Error: Browser unavailable');expect(streamUrl).not.toHaveBeenCalled();
});

it('captures only a connected visible workspace display and rejects stale frames',async()=>{
 const client={workspace:vi.fn().mockResolvedValue({}),streamUrl:vi.fn().mockResolvedValue('wss://example.test/ticket')} as unknown as RemoteExecutionClient;
 const ref=createRef<RemoteDesktopCapture>();
 const view=render(<RemoteDesktop client={client} workspaceId="alice" captureRef={ref}/>);
 expect(()=>ref.current!.capture()).toThrow('not connected');
 await waitFor(()=>expect(mock.connect).toHaveBeenCalledOnce());
 act(()=>mock.events.get('connect')!());
 expect(()=>ref.current!.capture()).toThrow('not visible');
 vi.spyOn(view.container.querySelector('.remote-desktop-surface')!,'getBoundingClientRect').mockReturnValue({width:800,height:600} as DOMRect);
 expect(ref.current!.capture()).toEqual({png:'c3ludGhldGlj',cssWidth:800});
 act(()=>mock.events.get('disconnect')!());
 expect(()=>ref.current!.capture()).toThrow('not connected');
 expect(mock.png).toHaveBeenCalledOnce();
 view.unmount();expect(ref.current).toBeNull();
});
