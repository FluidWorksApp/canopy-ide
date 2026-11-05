import net from 'node:net';
// The workspace end of the preview tunnel. The desktop renders a workspace app
// in its own embedded browser, so each connection that browser makes arrives
// here as one numbered stream over a single WebSocket and is dialled on this
// runtime's loopback. Only bytes cross; nothing here parses HTTP.
//
// Frames (binary): [type:u8][stream:u32 BE][payload]. OPEN carries JSON {port}.
// WINDOW returns u32 BE bytes of send credit. PING is answered with PONG so the
// desktop proves the whole path, not just its hop to the gateway.
export const OPEN=1,DATA=2,END=3,RESET=4,WINDOW=5,PING=6,PONG=7;
/** The gateway closes a tunnel that overruns 4 MiB towards the desktop and
 *  1 MiB towards the workspace. Credit keeps every stream together below both,
 *  so one large response slows itself and never costs the others their tunnel. */
export const MAX_STREAMS=24,SEND_WINDOW=128*1024,RECEIVE_WINDOW=32*1024,CHUNK=16*1024;
/** The runtime's own services, reachable on its loopback but never previews. */
export const BLOCKED_PORTS=new Set([8080,8081,8787]);
export const frame=(type,stream,payload=Buffer.alloc(0))=>{const head=Buffer.alloc(5);head[0]=type;head.writeUInt32BE(stream,1);return Buffer.concat([head,payload]);};
const credit=bytes=>{const value=Buffer.alloc(4);value.writeUInt32BE(bytes);return value;};
export function forwardablePort(value){return Number.isInteger(value)&&value>0&&value<65536&&!BLOCKED_PORTS.has(value);}
export function servePortForward(client,{connect=net.connect}={}){
 const streams=new Map();
 const send=(type,id,payload)=>{if(client.readyState===1)client.send(frame(type,id,payload),{binary:true});};
 const drop=id=>{const stream=streams.get(id);if(!stream)return;streams.delete(id);stream.socket.destroy();};
 const open=(id,payload)=>{
  let port;try{port=JSON.parse(payload.toString()).port;}catch{port=null;}
  if(streams.has(id)||streams.size>=MAX_STREAMS||!forwardablePort(port))return send(RESET,id);
  const socket=connect({host:'127.0.0.1',port}),stream={socket,credit:SEND_WINDOW};streams.set(id,stream);
  socket.on('data',data=>{
   for(let at=0;at<data.length;at+=CHUNK){const part=data.subarray(at,at+CHUNK);stream.credit-=part.length;send(DATA,id,part);}
   if(stream.credit<=0)socket.pause();
  });
  socket.on('end',()=>send(END,id));
  socket.on('error',()=>{});
  socket.on('close',()=>{if(streams.get(id)===stream){streams.delete(id);send(RESET,id);}});
 };
 client.on('message',(raw,binary)=>{
  if(!binary||raw.length<5)return;
  const type=raw[0],id=raw.readUInt32BE(1),payload=raw.subarray(5),stream=streams.get(id);
  if(type===PING)return send(PONG,id,payload);
  if(type===OPEN)return open(id,payload);
  if(!stream)return;
  if(type===DATA)stream.socket.write(payload,()=>send(WINDOW,id,credit(payload.length)));
  else if(type===END)stream.socket.end();
  else if(type===RESET)drop(id);
  else if(type===WINDOW&&payload.length===4){stream.credit+=payload.readUInt32BE(0);if(stream.credit>0)stream.socket.resume();}
 });
 const closeAll=()=>{for(const id of [...streams.keys()])drop(id);};
 client.once('close',closeAll);client.on('error',closeAll);
}
