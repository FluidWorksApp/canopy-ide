// @vitest-environment jsdom
import {render,waitFor,cleanup,act,fireEvent} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {createRef} from 'react';
import {MINIMIZED_KEEP_MS,RemoteDesktop,type RemoteDesktopCapture} from './RemoteDesktop';
import type {RemoteExecutionClient} from './client';
const clip=vi.hoisted(()=>({read:vi.fn(),write:vi.fn()}));
vi.mock('../terminalClipboard',()=>({readClipboardText:clip.read,writeClipboardText:clip.write}));
const mock=vi.hoisted(()=>({paste:vi.fn(),key:vi.fn(),connect:vi.fn(),disconnect:vi.fn(),focus:vi.fn(),blur:vi.fn(),png:vi.fn(()=>'data:image/png;base64,c3ludGhldGlj'),events:new Map<string,(event?:unknown)=>void>()}));
vi.mock('@novnc/novnc',()=>({default:class{clipboardPasteFrom(text:string){mock.paste(text);} sendKey(...args:unknown[]){mock.key(...args);} focus(){mock.focus();} blur(){mock.blur();} constructor(...args:unknown[]){mock.connect(...args);} addEventListener(name:string,callback:(event?:unknown)=>void){mock.events.set(name,callback);} toDataURL(){return mock.png();} disconnect(){mock.disconnect();}}}));
afterEach(()=>{vi.useRealTimers();cleanup();vi.clearAllMocks();mock.events.clear();vi.restoreAllMocks();});
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

const live=()=>({workspace:vi.fn().mockResolvedValue({}),streamUrl:vi.fn().mockResolvedValue('wss://example.test/ticket')} as unknown as RemoteExecutionClient);
const settle=()=>act(async()=>{await vi.advanceTimersByTimeAsync(0);});
it('stays connected while minimized and hands the keyboard back on restore',async()=>{
 const client=live(),view=render(<RemoteDesktop client={client} workspaceId="alice"/>);
 await waitFor(()=>expect(mock.connect).toHaveBeenCalledOnce());act(()=>mock.events.get('connect')!());
 view.rerender(<RemoteDesktop client={client} workspaceId="alice" minimized/>);
 expect(mock.blur).toHaveBeenCalledOnce();expect(mock.disconnect).not.toHaveBeenCalled();
 view.rerender(<RemoteDesktop client={client} workspaceId="alice"/>);
 expect(mock.focus).toHaveBeenCalled();expect(mock.connect).toHaveBeenCalledOnce();expect(mock.disconnect).not.toHaveBeenCalled();
});
it('lets go after the minimized allowance so the workspace can idle, then reconnects on restore',async()=>{
 vi.useFakeTimers();const client=live(),view=render(<RemoteDesktop client={client} workspaceId="alice"/>);
 await settle();await settle();expect(mock.connect).toHaveBeenCalledOnce();
 view.rerender(<RemoteDesktop client={client} workspaceId="alice" minimized/>);
 await act(async()=>{await vi.advanceTimersByTimeAsync(MINIMIZED_KEEP_MS-1);});expect(mock.disconnect).not.toHaveBeenCalled();
 await act(async()=>{await vi.advanceTimersByTimeAsync(1);});expect(mock.disconnect).toHaveBeenCalledOnce();
 view.rerender(<RemoteDesktop client={client} workspaceId="alice"/>);await settle();await settle();
 expect(mock.connect).toHaveBeenCalledTimes(2);
});
it('reconnects by itself after a dropped connection, and not after it is closed',async()=>{
 vi.useFakeTimers();const client=live(),view=render(<RemoteDesktop client={client} workspaceId="alice"/>);
 await settle();await settle();expect(mock.connect).toHaveBeenCalledOnce();
 act(()=>mock.events.get('disconnect')!());
 await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});await settle();await settle();
 expect(mock.connect).toHaveBeenCalledTimes(2);
 act(()=>mock.events.get('disconnect')!());view.unmount();
 await act(async()=>{await vi.advanceTimersByTimeAsync(60_000);});expect(mock.connect).toHaveBeenCalledTimes(2);
});
const open=async(workspace=vi.fn().mockResolvedValue({}),streamUrl=vi.fn().mockResolvedValue('wss://example.test/ticket'))=>{
 const view=render(<RemoteDesktop client={{workspace,streamUrl} as unknown as RemoteExecutionClient} workspaceId="alice"/>);
 await waitFor(()=>expect(mock.connect).toHaveBeenCalledOnce());act(()=>mock.events.get('connect')!());
 mock.key.mockClear();// the release sent on connect is tested on its own
 return {view,workspace,streamUrl,surface:view.container.querySelector('.remote-desktop-surface')!};
};
const shiftInsert=[[0xffe1,'ShiftLeft',true],[0xff63,'Insert',true],[0xff63,'Insert',false],[0xffe1,'ShiftLeft',false]];
it('pastes through the workspace, with full Unicode, then presses paste there',async()=>{
 clip.read.mockResolvedValue('curly ’ 😀');const {view,workspace}=await open();
 fireEvent.click(view.getByRole('button',{name:'Paste'}));
 await waitFor(()=>expect(workspace).toHaveBeenCalledWith('alice','/native',{command:'desktop_clipboard_write',args:{text:'curly ’ 😀'}}));
 await waitFor(()=>expect(mock.key.mock.calls).toEqual(shiftInsert));expect(mock.paste).not.toHaveBeenCalled();
});
it('falls back to VNC on an older host, and says when characters may be lost',async()=>{
 clip.read.mockResolvedValue('😀');
 const workspace=vi.fn().mockImplementation(async(_id,_path,body)=>{if(body.command==='desktop_clipboard_write')throw Error('does not support');return {};});
 const {view}=await open(workspace);
 fireEvent.click(view.getByRole('button',{name:'Paste'}));
 await waitFor(()=>expect(mock.paste).toHaveBeenCalledWith('😀'));
 expect(await view.findByText(/may not paste until this workspace updates/)).toBeTruthy();
});
const copying=(selections:{clipboard:string[];primary:string})=>vi.fn().mockImplementation(async(_id,_path,body)=>{if(body.command!=='desktop_clipboard_read')return {};return {result:body.args.selection==='primary'?selections.primary:selections.clipboard.shift()};});
it('copies the workspace’s clipboard to this computer on request, and presses copy there',async()=>{
 clip.write.mockResolvedValue(true);const {view}=await open(copying({clipboard:['old','it’s 😀'],primary:''}));
 fireEvent.click(view.getByRole('button',{name:'Copy'}));
 await waitFor(()=>expect(clip.write).toHaveBeenCalledWith('it’s 😀'));
 expect(mock.key.mock.calls).toEqual([[0xffe3,'ControlLeft',true],[0xff63,'Insert',true],[0xff63,'Insert',false],[0xffe3,'ControlLeft',false]]);
 expect(await view.findByText('Copied to this computer')).toBeTruthy();
});
it('uses the highlighted text when the copy shortcut changed nothing, as in a terminal',async()=>{
 clip.write.mockResolvedValue(true);const {view}=await open(copying({clipboard:['same','same'],primary:'highlighted'}));
 fireEvent.click(view.getByRole('button',{name:'Copy'}));
 await waitFor(()=>expect(clip.write).toHaveBeenCalledWith('highlighted'));
});
it('never touches this computer’s clipboard without a request',async()=>{
 const {view}=await open();expect(mock.events.has('clipboard')).toBe(false);
 fireEvent.click(view.getByRole('button',{name:'Copy'}));
 expect(await view.findByText('Nothing selected to copy')).toBeTruthy();expect(clip.write).not.toHaveBeenCalled();
});
it('sends shortcuts to the clipboard, not to the workspace as keystrokes',async()=>{
 clip.read.mockResolvedValue('text');const {surface,workspace}=await open();
 const event=new KeyboardEvent('keydown',{key:'v',ctrlKey:true,bubbles:true,cancelable:true});
 act(()=>{surface.dispatchEvent(event);});expect(event.defaultPrevented).toBe(true);
 await waitFor(()=>expect(workspace).toHaveBeenCalledWith('alice','/native',{command:'desktop_clipboard_write',args:{text:'text'}}));
});
it('turns sound on with a click, plays the stream, and stops with the desktop',async()=>{
 const sockets:{url:string;close:ReturnType<typeof vi.fn>;onclose?:()=>void}[]=[];
 vi.stubGlobal('WebSocket',class{close=vi.fn();url:string;constructor(url:string){this.url=url;sockets.push(this);}});
 const resume=vi.fn().mockResolvedValue(undefined),close=vi.fn().mockResolvedValue(undefined);
 vi.stubGlobal('AudioContext',class{currentTime=0;resume=resume;close=close;});
 const {view,streamUrl}=await open();
 expect(sockets).toHaveLength(0);
 fireEvent.click(view.getByRole('button',{name:'Sound off'}));expect(resume).toHaveBeenCalled();
 await waitFor(()=>expect(sockets).toHaveLength(1));expect(streamUrl).toHaveBeenCalledWith('alice','/desktop/audio');
 fireEvent.click(view.getByRole('button',{name:'Sound on'}));expect(sockets[0].close).toHaveBeenCalled();
 view.unmount();expect(close).toHaveBeenCalled();vi.unstubAllGlobals();
});
it('says so when a workspace has no sound yet',async()=>{
 vi.stubGlobal('AudioContext',class{currentTime=0;resume=vi.fn().mockResolvedValue(undefined);close=vi.fn().mockResolvedValue(undefined);});
 const streamUrl=vi.fn().mockImplementation(async(_id,stream)=>{if(stream==='/desktop/audio')throw Error('Invalid stream');return 'wss://example.test/ticket';});
 const {view}=await open(undefined,streamUrl);
 fireEvent.click(view.getByRole('button',{name:'Sound off'}));
 expect(await view.findByText(/Sound isn’t available/)).toBeTruthy();expect(view.getByRole('button',{name:'Sound off'})).toBeTruthy();vi.unstubAllGlobals();
});

const keyUps=()=>mock.key.mock.calls.filter(call=>call[2]===false).map(call=>call[1] as string);
const everyModifierReleased=()=>{const up=keyUps();for(const code of ['ShiftLeft','ControlLeft','ControlRight','AltLeft','AltRight','MetaLeft','MetaRight'])expect(up).toContain(code);expect(mock.key.mock.calls.every(call=>call[2]===false)).toBe(true);};
it('lets go of every modifier the workspace may still hold when it connects, and takes keyboard focus',async()=>{
 const client=live();render(<RemoteDesktop client={client} workspaceId="alice"/>);
 await waitFor(()=>expect(mock.connect).toHaveBeenCalledOnce());act(()=>mock.events.get('connect')!());
 everyModifierReleased();expect(mock.focus).toHaveBeenCalled();
});
it('lets go of every modifier when the window loses focus, is hidden, or is minimized',async()=>{
 const client=live(),view=render(<RemoteDesktop client={client} workspaceId="alice"/>);
 await waitFor(()=>expect(mock.connect).toHaveBeenCalledOnce());act(()=>mock.events.get('connect')!());
 mock.key.mockClear();act(()=>{window.dispatchEvent(new Event('blur'));});everyModifierReleased();
 mock.key.mockClear();Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
 act(()=>{document.dispatchEvent(new Event('visibilitychange'));});everyModifierReleased();
 Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});
 mock.key.mockClear();view.rerender(<RemoteDesktop client={client} workspaceId="alice" minimized/>);everyModifierReleased();
});
it('has a button that releases stuck keys and returns the keyboard to the desktop',async()=>{
 const {view}=await open();mock.focus.mockClear();
 fireEvent.click(view.getByRole('button',{name:'Release keys'}));
 everyModifierReleased();expect(mock.focus).toHaveBeenCalled();
});
it('reconnects at once when the window comes back while disconnected, instead of waiting out the backoff',async()=>{
 vi.useFakeTimers();const client=live();render(<RemoteDesktop client={client} workspaceId="alice"/>);
 await settle();await settle();act(()=>mock.events.get('connect')!());
 // Two drops in a row: the next automatic retry is 1s away.
 act(()=>mock.events.get('disconnect')!());
 await act(async()=>{await vi.advanceTimersByTimeAsync(600);});await settle();await settle();
 expect(mock.connect).toHaveBeenCalledTimes(2);
 act(()=>mock.events.get('disconnect')!());
 await act(async()=>{await vi.advanceTimersByTimeAsync(100);});await settle();
 expect(mock.connect).toHaveBeenCalledTimes(2);// still waiting on the backoff
 act(()=>{window.dispatchEvent(new Event('online'));});await settle();await settle();
 expect(mock.connect).toHaveBeenCalledTimes(3);// the network came back: no waiting
});
it('does not restart a connect that is still in progress when the window is focused',async()=>{
 vi.useFakeTimers();const client=live();render(<RemoteDesktop client={client} workspaceId="alice"/>);
 await settle();await settle();expect(mock.connect).toHaveBeenCalledTimes(1);
 act(()=>{window.dispatchEvent(new Event('focus'));});await settle();await settle();
 expect(mock.connect).toHaveBeenCalledTimes(1);
});
it('replaces a connected stream that was hidden long enough to have died unnoticed, but not one hidden briefly',async()=>{
 vi.useFakeTimers();const client=live();render(<RemoteDesktop client={client} workspaceId="alice"/>);
 await settle();await settle();act(()=>mock.events.get('connect')!());
 const hide=()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});act(()=>{document.dispatchEvent(new Event('visibilitychange'));});};
 const show=()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});act(()=>{document.dispatchEvent(new Event('visibilitychange'));});};
 hide();await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});show();await settle();await settle();
 expect(mock.connect).toHaveBeenCalledTimes(1);// short absence: kept
 hide();await act(async()=>{await vi.advanceTimersByTimeAsync(20_000);});show();await settle();await settle();
 expect(mock.connect).toHaveBeenCalledTimes(2);// long absence: fresh stream
});
