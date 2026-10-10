import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
// The agent's own browser for POST /browser (docs/canopy-service-protocol.md §4):
// the workspace image's Chromium, driven over CDP through Playwright, with the
// same in-page picker the desktop preview injects, so snapshot/click/type/
// point/eval/console/network answer with the desktop's shapes. One page per
// workspace runtime, its own profile, ops serialized, 30 s deadline each.
export const BROWSER_OPS=new Set(['navigate','snapshot','click','type','point','eval','console','network','resize','screenshot']);
const PAGE_OPS=new Set(['snapshot','click','type','point','eval','console','network']);
const DEFAULT_VIEWPORT={width:1280,height:720};
const failure=(status,message)=>Object.assign(Error(message),{status});
export function validateBrowserOp(op,args){
 if(!BROWSER_OPS.has(op))throw failure(400,`unknown browser op: ${op}`);
 if(!args||typeof args!=='object'||Array.isArray(args))throw failure(400,'browser args must be an object');
 if(op==='navigate'){
  if(typeof args.url==='string'){let url;try{url=new URL(args.url);}catch{url=null;}if(!url||!['http:','https:'].includes(url.protocol)||args.url.length>8192)throw failure(400,`${args.url} isn't an http:// or https:// URL — the preview opens web pages`);}
  else if(!['back','forward','reload'].includes(args.action))throw failure(400,'navigate needs a url, or action = back | forward | reload');
 }
 if(['click','type','point'].includes(op)){
  if(args.ref==null&&args.selector==null)throw failure(400,`${op} needs a ref (from canopy_browser_snapshot) or a selector`);
  if(op==='type'&&typeof args.text!=='string')throw failure(400,'type needs text');
 }
 if(op==='eval'&&(typeof args.code!=='string'||!args.code.trim()))throw failure(400,'eval needs code');
 if(op==='resize'){
  const valid=n=>Number.isInteger(n)&&n>=200&&n<=7680;
  if(args.reset===true){if(args.width!=null||args.height!=null)throw failure(400,'resize takes either reset = true or width and height, not both');}
  else if(!valid(args.width)||!valid(args.height))throw failure(400,'resize needs width and height between 200 and 7680 CSS pixels, or reset = true');
 }
 if(op==='screenshot'&&args.scope==='ide')throw failure(503,'no IDE attached: a cloud workspace can only screenshot its browser');
 if(op==='screenshot'&&args.scope!=null&&args.scope!=='browser')throw failure(400,'scope must be browser or ide');
}
export class AgentBrowser{
 constructor({home='/home/agent',timeoutMs=30_000,launch,picker=new URL('./chrome-stream/preview_picker.js',import.meta.url),executablePath=process.env.CANOPY_CHROMIUM_EXECUTABLE??'/usr/bin/chromium'}={}){
  Object.assign(this,{home,timeoutMs,picker,executablePath});
  this.launch=launch??(async profileDirectory=>{const {chromium}=createRequire(import.meta.url)('playwright-core');return chromium.launchPersistentContext(profileDirectory,{executablePath:this.executablePath,headless:true,args:['--no-sandbox','--disable-dev-shm-usage'],viewport:DEFAULT_VIEWPORT});});
  this.tail=Promise.resolve();this.pending=new Map();this.serial=0;this.viewport=DEFAULT_VIEWPORT;
 }
 async open(){
  if(this.current&&!this.current.page.isClosed())return this.current;
  if(!this.opening)this.opening=(async()=>{
   const profile=join(this.home,'.canopy','browser-profiles','agent-tools');await mkdir(profile,{recursive:true,mode:0o700});
   const context=await this.launch(profile);
   try{
    const page=context.pages()[0]??await context.newPage();
    await page.exposeBinding('__canopyStreamSend',({frame},message)=>{
     if(frame!==page.mainFrame()||message?.canopy!=='agent-result')return;
     const waiter=this.pending.get(message.id);if(waiter){this.pending.delete(message.id);waiter(message);}
    });
    const source=`if (window === window.top) { window.__canopyStreamBrowser = true; ${await readFile(this.picker,'utf8')}\n }`;
    await page.addInitScript({content:source});
    await page.evaluate(source).catch(()=>{});
    context.on('close',()=>{if(this.current?.context===context)this.current=undefined;});
    this.current={context,page,source};return this.current;
   }catch(error){await context.close().catch(()=>{});throw error;}
  })().finally(()=>{this.opening=undefined;});
  return this.opening;
 }
 run(op,args={}){
  validateBrowserOp(op,args);
  const result=this.tail.then(()=>this.deadline(this.execute(op,args)));
  this.tail=result.catch(()=>{});
  return result;
 }
 deadline(promise){
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure(504,"The workspace browser didn't answer in time. The page may still be loading — try again.")),this.timeoutMs);})]).finally(()=>clearTimeout(timer));
 }
 async execute(op,args){
  const {page,source}=await this.open();
  const here=async()=>({url:page.url(),title:await page.title().catch(()=>'')});
  if(op==='navigate'){
   const options={waitUntil:'domcontentloaded',timeout:this.timeoutMs-1000};
   if(args.url)await page.goto(args.url,options);
   else if(args.action==='back')await page.goBack(options);
   else if(args.action==='forward')await page.goForward(options);
   else await page.reload(options);
   return here();
  }
  if(op==='resize'){
   this.viewport=args.reset?DEFAULT_VIEWPORT:{width:args.width,height:args.height};
   await page.setViewportSize(this.viewport);
   return {url:page.url(),...this.viewport,reset:!!args.reset};
  }
  if(op==='screenshot'){
   const image=await page.screenshot({type:'png',timeout:this.timeoutMs-1000});
   return {image:image.toString('base64'),mimeType:'image/png',url:page.url(),...this.viewport};
  }
  if(!PAGE_OPS.has(op))throw failure(400,`unknown browser op: ${op}`);
  // A page navigated by itself may not have run the init script yet.
  await page.evaluate(source).catch(()=>{});
  const id=++this.serial;
  const answered=new Promise(resolve=>this.pending.set(id,resolve));
  const fields=['ref','selector','text','submit','append','label','code','lines','clear','max'];
  const message={canopy:'agent',id,op,bg:true,...Object.fromEntries(fields.filter(k=>args[k]!==undefined).map(k=>[k,args[k]]))};
  try{
   const accepted=await page.evaluate(d=>window.__canopyBrowser?window.__canopyBrowser.cmd(d):'The page is still loading.',message);
   if(accepted!==true)throw failure(400,String(accepted));
   const reply=await answered;
   if(!reply.ok)throw failure(400,typeof reply.data==='string'?reply.data:JSON.stringify(reply.data));
   return reply.data;
  }finally{this.pending.delete(id);}
 }
 async close(){const current=this.current;this.current=undefined;await current?.context.close().catch(()=>{});}
}
