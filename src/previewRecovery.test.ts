import {readFileSync} from 'node:fs';
import {transformWithOxc} from 'vite';
import {expect,it,vi} from 'vitest';

// Execute PreviewView's real iframe message handler without mounting browser
// surfaces. Its source, origin and session fences must survive async tickets.
const source=readFileSync('src/components/PreviewView.tsx','utf8');
const start=source.indexOf('    const onMessage = (e: MessageEvent) => {');
const end=source.indexOf('    window.addEventListener("message", onMessage);',start);
if(start<0||end<0)throw Error('Missing PreviewView message listener');
const {code}=await transformWithOxc(source.slice(start,end),'preview-message.ts');
function harness(ticket:Promise<string>){
 const postMessage=vi.fn(),frame={postMessage},chromeSession={current:'session-current'};
 const retry=vi.fn(),ready=vi.fn(),handle=vi.fn();
 const scope={iframeRef:{current:{contentWindow:frame}},engine:'chrome',chromeSrc:'https://viewer.example/viewer',chromeSession,
  ipc:{chromeStreamTicket:vi.fn(()=>ticket)},setChromeRetry:retry,initChromeFrame:ready,handleMessage:handle,openUrl:vi.fn()};
 const receive=new Function(...Object.keys(scope),`${code}\nreturn onMessage;`)(...Object.values(scope)) as (event:MessageEvent)=>void;
 const send=(data:Record<string,unknown>,origin='https://viewer.example',from=frame)=>receive({data,origin,source:from} as unknown as MessageEvent);
 return {send,postMessage,chromeSession,retry,ready,scope};
}
it('returns a rejected ticket to the viewer so Reconnect is not stranded',async()=>{
 const h=harness(Promise.reject(Error('Expired browser')));
 h.send({canopy:'remote-stream-ticket-request',sessionId:'session-current',requestId:17});
 await Promise.resolve();await Promise.resolve();
 expect(h.postMessage).toHaveBeenCalledWith({canopy:'remote-stream-ticket-error',sessionId:'session-current',requestId:17},'https://viewer.example');
});
it('ignores a late ticket after its browser session was replaced',async()=>{
 let resolve!:(url:string)=>void;const h=harness(new Promise<string>(r=>{resolve=r;}));
 h.send({canopy:'remote-stream-ticket-request',sessionId:'session-current'});h.chromeSession.current='replacement';resolve('wss://workspace/stream?ticket=fixture');
 await Promise.resolve();expect(h.postMessage).not.toHaveBeenCalled();
});
it('allows only the owning iframe and current session to recreate the bridge',()=>{
 const h=harness(Promise.resolve('wss://workspace/stream'));
 h.send({canopy:'stream-reopen',sessionId:'obsolete'});
 h.send({canopy:'stream-reopen',sessionId:'session-current'},'https://untrusted.example');
 h.send({canopy:'stream-reopen',sessionId:'session-current'},'https://viewer.example',{postMessage:vi.fn()});
 expect(h.retry).not.toHaveBeenCalled();
 h.send({canopy:'stream-reopen',sessionId:'session-current'});expect(h.retry).toHaveBeenCalledTimes(1);
 expect(h.retry.mock.calls[0][0](4)).toBe(5);
});
it('returns a fresh ticket only to the requesting iframe and session',async()=>{
 const h=harness(Promise.resolve('wss://workspace/stream?ticket=fixture'));
 h.send({canopy:'remote-stream-ticket-request',sessionId:'session-current'});
 await Promise.resolve();
 expect(h.postMessage).toHaveBeenCalledWith({canopy:'remote-stream-ticket',sessionId:'session-current',url:'wss://workspace/stream?ticket=fixture'},'https://viewer.example');
});
