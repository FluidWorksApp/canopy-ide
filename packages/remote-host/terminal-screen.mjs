import {trackMouseEncoding} from './terminal-mouse-modes.mjs';
// One bounded server-side terminal per live PTY. Reattachments restore cells,
// never replay an arbitrary tail of cursor-motion escape sequences.
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import WebSocket from 'ws';
import unicode from '@xterm/addon-unicode11';
const {Terminal}=headless, {SerializeAddon}=serialize;
export class TerminalScreen {
  constructor(cols=120,rows=40){
    this.term=new Terminal({cols,rows,scrollback:1000,allowProposedApi:true});
    this.term.loadAddon(new unicode.Unicode11Addon());this.term.unicode.activeVersion='11';
    this.mouseModes=trackMouseEncoding(this.term);this.serializer=new SerializeAddon();this.term.loadAddon(this.serializer);
    this.end=0;this.pending=0;this.operations=0;this.tail=Promise.resolve();this.disposed=false;
  }
  enqueue(bytes,action){
    if(this.disposed||this.pending+bytes>1024*1024||this.operations>=1024)throw Error('Terminal parser capacity reached');
    this.pending+=bytes;this.operations++;
    const next=this.tail.then(()=>{if(this.disposed)throw Error('Terminal screen closed');return action();});
    this.tail=next.catch(()=>{}).finally(()=>{this.pending-=bytes;this.operations--;});return next;
  }
  write(bytes,reset=false,cols=this.term.cols,rows=this.term.rows){return this.enqueue(bytes.length,async()=>{
    if(reset){this.mouseModes.reset();this.term.reset();}this.term.resize(cols,rows);
    const start=this.end;await new Promise(resolve=>this.term.write(bytes,resolve));this.end+=bytes.length;
    return {t:'data',b64:Buffer.from(bytes).toString('base64'),start,end:this.end,cols,rows};
  });}
  serialize(){
    for(const scrollback of [1000,500,250,125,0]){const bytes=Buffer.from(this.mouseModes.serialize(this.serializer,{scrollback}));if(bytes.length<=512*1024)return Buffer.concat([Buffer.from([0]),bytes]).toString('base64');}
    throw Error('Terminal screen exceeds restore capacity');
  }
  snapshot(){return this.enqueue(0,()=>({t:'snapshot',reset:true,gap:false,b64:this.serialize(),start:this.end,end:this.end,cols:this.term.cols,rows:this.term.rows}));}
  dispose(){this.disposed=true;this.mouseModes.dispose();this.term.dispose();}
}
export function terminalScreens(secret){
  const screens=new Map();
  function get(id){
    let entry=screens.get(id);if(entry)return entry;
    if(screens.size>=16){const idle=[...screens].find(([,e])=>!e.clients.size);if(!idle)throw Error('Terminal screen capacity reached');idle[1].close();}
    const screen=new TerminalScreen();const clients=new Set();let initialized=false;
    const upstream=new WebSocket(`ws://127.0.0.1:8080/sessions/${id}/stream`,{headers:{authorization:`Bearer ${secret}`},maxPayload:1024*1024,perMessageDeflate:false});
    let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});ready.catch(()=>{});
    entry={screen,clients,ready,summary:{},close(){if(screens.get(id)!==entry)return;screens.delete(id);upstream.close();for(const client of clients)client.close(1013,'Terminal reconnect required');clients.clear();screen.dispose();readyReject(Error('Terminal disconnected'));}};
    screens.set(id,entry);
    const send=message=>{const data=JSON.stringify(message);for(const client of clients){if(client.readyState!==1)continue;if(client.bufferedAmount>1024*1024){client.close(1013,'Slow terminal consumer');continue;}client.send(data);}};
    upstream.on('message',raw=>{
      try{
        const message=JSON.parse(raw);
        if(message.t==='exit'){void screen.enqueue(0,()=>send(message));return;}
        if(!['snapshot','data'].includes(message.t))return;
        const bytes=Buffer.from(message.b64,'base64');
        if(message.t==='snapshot')entry.summary=message;
        const cols=message.cols??screen.term.cols, rows=message.rows??screen.term.rows;
        const parsed=screen.write(bytes,message.t==='snapshot',cols,rows);
        if(screen.pending>256*1024)upstream.pause();
        void parsed.then(frame=>{if(!initialized){initialized=true;readyResolve();}else send(frame);if(screen.pending-bytes.length<128*1024)upstream.resume();}).catch(()=>entry.close());
      }catch{entry.close();}
    });
    upstream.on('error',()=>entry.close());upstream.on('close',()=>entry.close());return entry;
  }
  return {
    async attach(id,client){const entry=get(id);await entry.ready;await entry.screen.enqueue(0,()=>{
      if(client.readyState!==1)return;
      const frame={...entry.summary,t:'snapshot',reset:true,gap:false,b64:entry.screen.serialize(),start:entry.screen.end,end:entry.screen.end,cols:entry.screen.term.cols,rows:entry.screen.term.rows};
      client.send(JSON.stringify(frame));entry.clients.add(client);client.once('close',()=>entry.clients.delete(client));
    });},
    async resize(id,cols,rows){
      if(!Number.isInteger(cols)||!Number.isInteger(rows)||cols<1||cols>512||rows<1||rows>256)throw Error('Invalid terminal geometry');
      const entry=get(id);await entry.ready;
      return entry.screen.enqueue(0,async()=>{
        // Adopt geometry before SIGWINCH can produce new-grid escape sequences.
        const previous={cols:entry.screen.term.cols,rows:entry.screen.term.rows};entry.screen.term.resize(cols,rows);
        try{const response=await fetch(`http://127.0.0.1:8080/sessions/${id}/resize`,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify({cols,rows}),signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('Terminal resize failed');
          const frame={t:'data',b64:'AA==',start:entry.screen.end,end:entry.screen.end,cols,rows};
          for(const client of entry.clients)if(client.readyState===1){if(client.bufferedAmount>1024*1024)client.close(1013);else client.send(JSON.stringify(frame));}
          return await response.json();}
        catch(error){entry.screen.term.resize(previous.cols,previous.rows);throw error;}
      });
    },
    dispose(){for(const entry of [...screens.values()])entry.close();}
  };
}
