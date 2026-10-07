// Keystroke -> echo latency fixture (tests only; never deployed behaviour).
//
// Real gateway + real runner whose PTY echoes like a shell, a native stand-in
// that parses output through the production TerminalScreen before sending it
// (as native.mjs does), and a TCP proxy adding a fixed one-way delay in each
// direction between the client and the gateway. Every stage is timestamped on
// the shared wall clock (performance.timeOrigin + now) so a client in another
// process can break a keystroke's latency down.
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';
import {createGateway} from '../gateway.mjs';
import {createRunner} from '../runner.mjs';
import {digest} from '../policy.mjs';
import {TerminalScreen} from '../terminal-screen.mjs';

export const clock=()=>performance.timeOrigin+performance.now();
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}

/** TCP proxy with a constant one-way delay per direction (FIFO per socket). */
function delayProxy(target,oneWayMs,log){
 const sockets=new Set();
 const server=net.createServer(client=>{
  const upstream=net.connect(target,'127.0.0.1');sockets.add(client);sockets.add(upstream);
  const pipe=(from,to,direction)=>{
   from.on('data',chunk=>{if(direction==='down')log('gatewaySent');setTimeout(()=>{if(direction==='up')log('gatewayReceived');if(!to.destroyed)to.write(chunk);},oneWayMs);});
   from.on('end',()=>setTimeout(()=>to.end(),oneWayMs));from.on('error',()=>to.destroy());from.on('close',()=>setTimeout(()=>to.destroy(),oneWayMs));
  };
  pipe(client,upstream,'up');pipe(upstream,client,'down');
 });
 return {server,close:()=>{for(const socket of sockets)socket.destroy();return new Promise(resolve=>server.close(resolve));}};
}

export async function startLatencyFixture({rttMs=55,openCostMs=0,openCacheMs=2000,principals}={}){
 const events=[];const log=(stage,detail)=>{if(events.length<100000)events.push({stage,at:clock(),...(detail?{detail}:{})});};
 const secret='x'.repeat(64);let echo;const writes=[];
 const runner=createRunner({secret,accounts:[],spawnPty:()=>({onData:handler=>{echo=handler;},onExit(){},resize(){},kill(){},
  write:data=>{writes.push(data);log('ptyWrite',data);setImmediate(()=>{log('ptyEcho',data);echo?.(data);});}})});
 const runnerPort=await listen(runner);
 const native=http.createServer((request,response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify(request.url==='/native'?{result:null}:{ok:true}));});
 const nativeWss=new WebSocketServer({noServer:true});
 native.on('upgrade',(request,socket,head)=>nativeWss.handleUpgrade(request,socket,head,client=>{
  const screen=new TerminalScreen();let attached=false;
  const upstream=new WebSocket(`ws://127.0.0.1:${runnerPort}${request.url}`,{headers:{authorization:`Bearer ${secret}`}});
  upstream.on('message',raw=>{
   const message=JSON.parse(String(raw));
   if(message.t==='snapshot'){void screen.write(Buffer.from(message.b64,'base64'),true).then(()=>{if(attached)return;attached=true;client.send(JSON.stringify({...message,reset:true,gap:false,b64:Buffer.concat([Buffer.from([0]),Buffer.from(screen.serializer.serialize())]).toString('base64'),start:screen.end,end:screen.end,cols:screen.term.cols,rows:screen.term.rows}));});return;}
   if(message.t!=='data'){client.send(String(raw));return;}
   void screen.write(Buffer.from(message.b64,'base64')).then(frame=>{log('screenParsed');client.send(JSON.stringify(frame));});
  });
  client.on('close',()=>{upstream.close();screen.dispose();});
 }));
 const nativePort=await listen(native);
 let cachedAt=-Infinity;
 const workspaces={open:async()=>{
  // Models DockerWorkspaces.open: admission re-check when its cache expires.
  if(clock()-cachedAt>=openCacheMs){if(openCostMs)await new Promise(resolve=>setTimeout(resolve,openCostMs));cachedAt=clock();}
  return {url:`http://127.0.0.1:${runnerPort}`,nativeUrl:`http://127.0.0.1:${nativePort}`,token:secret};
 }};
 const config={workspaces:[{id:'latency',accounts:[],memoryMiB:1024,cpus:1}],principals:principals??[{id:'owner',tokenSha256:digest('owner-token'),workspaces:['latency'],scope:'drive'},{id:'viewer',tokenSha256:digest('viewer-token'),workspaces:['latency'],scope:'view'}]};
 const gateway=createGateway({config,workspaces});
 const gatewayPort=await listen(gateway);
 const proxy=delayProxy(gatewayPort,rttMs/2,log);
 const proxyPort=await listen(proxy.server);
 return {
  endpoint:`http://127.0.0.1:${proxyPort}`,direct:`http://127.0.0.1:${gatewayPort}`,token:'owner-token',viewerToken:'viewer-token',workspaceId:'latency',config,gateway,events,writes,
  async close(){await proxy.close();for(const client of nativeWss.clients)client.terminate();for(const server of [gateway,runner,native])server.closeAllConnections();await Promise.all([gateway,runner,native].map(server=>new Promise(resolve=>server.close(resolve))));},
 };
}

// Child-process mode for the renderer e2e test: print the endpoint, serve the
// event log on a control port, exit when stdin closes.
if(process.argv[1]===new URL(import.meta.url).pathname){
 const options=JSON.parse(process.argv[2]??'{}');
 const fixture=await startLatencyFixture(options);
 const control=http.createServer((request,response)=>{
  response.setHeader('content-type','application/json');
  if(request.url==='/events'){response.end(JSON.stringify(fixture.events.splice(0)));return;}
  response.end(JSON.stringify({writes:fixture.writes}));
 });
 const controlPort=await listen(control);
 process.stdout.write(JSON.stringify({endpoint:fixture.endpoint,token:fixture.token,viewerToken:fixture.viewerToken,workspaceId:fixture.workspaceId,control:`http://127.0.0.1:${controlPort}`})+'\n');
 process.stdin.resume();process.stdin.on('end',async()=>{await fixture.close();control.close();process.exit(0);});
}
