import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor, act } from '@testing-library/react';
import { RemoteTerminal } from './RemoteTerminal';
import type { RemoteExecutionClient } from './client';
const state=vi.hoisted(()=>({input:undefined as undefined|((s:string)=>void),writes:[] as Uint8Array[]}));
vi.mock('@xterm/xterm',()=>({Terminal:class {
 cols=80;rows=24;loadAddon(){}open(){}reset(){}resize(){}dispose(){}
 onData(fn:(s:string)=>void){state.input=fn;return {dispose(){}};}
 write(bytes:Uint8Array,done:()=>void){state.writes.push(bytes);done();}
}}));
vi.mock('@xterm/addon-fit',()=>({FitAddon:class {fit(){}}}));
class Socket {
 static OPEN=1;static instances:Socket[]=[];readyState=1;closed=false;
 onopen?:()=>void;onmessage?: (event:{data:string})=>void;onclose?:()=>void;
 constructor(){Socket.instances.push(this);}
 close(){this.closed=true;this.readyState=3;this.onclose?.();}
}
afterEach(()=>{cleanup();vi.unstubAllGlobals();Socket.instances=[];state.writes=[];state.input=undefined;Object.defineProperty(document,'hidden',{configurable:true,value:false});});
it('detaches an unfocused viewer and restores a current snapshot without replaying background frames',async()=>{
 vi.stubGlobal('WebSocket',Socket);vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
 Object.defineProperty(document,'hidden',{configurable:true,value:false});
 const client={streamUrl:vi.fn().mockResolvedValue('wss://example.test/stream'),workspace:vi.fn().mockResolvedValue({})};
 render(<RemoteTerminal client={client as unknown as RemoteExecutionClient} workspaceId="ws" sessionId={1} writable/>);
 await waitFor(()=>expect(Socket.instances).toHaveLength(1));const first=Socket.instances[0];
 act(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
 expect(first.closed).toBe(true);
 act(()=>{first.onmessage?.({data:JSON.stringify({t:'data',b64:btoa('old spinner')})});state.input?.('x');});
 expect(state.writes).toHaveLength(0);expect(client.workspace).not.toHaveBeenCalledWith('ws','/sessions/1/input',expect.anything());
 act(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
 await waitFor(()=>expect(Socket.instances).toHaveLength(2));
 act(()=>Socket.instances[1].onmessage?.({data:JSON.stringify({t:'snapshot',reset:true,cols:80,rows:24,b64:btoa('\0current cells')})}));
 expect(new TextDecoder().decode(state.writes[0])).toBe('current cells');
});
it('does not attach a stale stream URL resolved after the viewer becomes hidden',async()=>{
 vi.stubGlobal('WebSocket',Socket);vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
 Object.defineProperty(document,'hidden',{configurable:true,value:false});
 let resolve!:(url:string)=>void;const client={streamUrl:()=>new Promise<string>(done=>resolve=done),workspace:vi.fn()};
 render(<RemoteTerminal client={client as unknown as RemoteExecutionClient} workspaceId="ws" sessionId={1} writable/>);
 act(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
 await act(async()=>resolve('wss://example.test/stream'));
 expect(Socket.instances).toHaveLength(0);
});
it('shared terminals use publication routes and read-only terminals never submit input',async()=>{
 vi.stubGlobal('WebSocket',Socket);vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});Object.defineProperty(document,'hidden',{configurable:true,value:false});
 const client={streamUrl:vi.fn().mockResolvedValue('wss://example.test/stream'),workspace:vi.fn()};const view=render(<RemoteTerminal client={client as unknown as RemoteExecutionClient} workspaceId="ws" sessionId={0} sharedSessionId="share" writable={false}/>);
 await waitFor(()=>expect(client.streamUrl).toHaveBeenCalledWith('ws','/shared-sessions/share/stream'));act(()=>state.input?.('secret'));expect(client.workspace).not.toHaveBeenCalled();
 view.rerender(<RemoteTerminal client={client as unknown as RemoteExecutionClient} workspaceId="ws" sessionId={0} sharedSessionId="share" writable/>);await waitFor(()=>expect(Socket.instances).toHaveLength(2));act(()=>state.input?.('echo safe\n'));await waitFor(()=>expect(client.workspace).toHaveBeenCalledWith('ws','/shared-sessions/share/input',{data:'echo safe\n'}));expect(client.workspace.mock.calls.some(([,route])=>route.endsWith('/resize'))).toBe(false);
});
