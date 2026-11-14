import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {isAbsolute,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {BrowserContexts} from './browser-contexts.mjs';
import {BrowserControlInterrupted,SessionControl} from './session-control.mjs';
// The agent's own browser for POST /browser (docs/canopy-service-protocol.md §4):
// the workspace image's Chromium, driven over CDP through Playwright, with the
// same in-page picker the desktop preview injects, so snapshot/click/type/
// point/eval/console/network answer with the desktop's shapes. One page per
// workspace runtime, its own profile, ops serialized, 30 s deadline each.
//
// The page is also streamed to people (runner.mjs /browser/stream). That part
// is ported from T3 Code (MIT) apps/server/src/preview/ServerBrowser.ts
// (pingdotgg/t3code d5290e9): the tab's SessionControl, viewers, capture lock,
// dialogs, attachViewer and dispatchViewerInput, with T3's constants. Canopy has
// one page per workspace and one agent, so the tab is owned by AGENT_ID.
// Not ported (T3-only): the desktop CDP relay, recordings, downloads, file
// chooser uploads, popups as tabs, browser profiles UI, zoom/colour scheme,
// the device toolbar's `viewport` input, agent pointer reports, the tab limits
// and idle sweep, PDF navigation and presentAsChrome.
export const BROWSER_OPS=new Set(['navigate','snapshot','click','type','point','eval','console','network','resize','screenshot']);
const PAGE_OPS=new Set(['snapshot','click','type','point','eval','console','network']);
/** Read-only operations stay available during human control (T3's READ_OPERATIONS for Canopy's op set). */
export const READ_OPERATIONS=new Set(['snapshot','console','network','screenshot']);
const DEFAULT_VIEWPORT={width:1280,height:720};
/** Canopy has one agent browser per workspace, so it always belongs to this agent. */
export const AGENT_ID='canopy-agent';
export const AGENT_PROFILE='agent-tools';
// T3's constants (ServerBrowser.ts).
// RENDER_SCALE is T3's snapshot render scale. Canopy keeps its own launch
// arguments (no --force-device-scale-factor=2), so frames are 1x CSS pixels.
export const RENDER_SCALE=2;
// Chromium allows three unacked frames, so 100 ms pacing caps viewers near 30 fps.
export const SCREENCAST_ACK_PACE_MS=100;
export const SCREENCAST_SETTLE_MS=200;
export const SCREENCAST_MOTION_FRAMES=4;
export const SCREENCAST_MOTION_WINDOW_MS=300;
export const SCREENCAST_MOTION_QUALITY=50;
export const VIEWER_OUTPUT_LIMIT=64;
const NAVIGATION_TIMEOUT_MS=15_000;
// T3 d9805b2c: how long a closing page may spend in its unload handlers.
export const PAGE_CLOSE_GRACE_MS=5_000;
// The desktop preview's control (autoControl): a person's input takes the page
// and gives it back this long after their last input, so the person never has
// to press "Take control" and the agent is never locked out of a page someone
// is only watching. The workspace overlay keeps T3's explicit handoff.
export const AUTO_RELEASE_MS=1_500;
// Viewer input that takes the page under autoControl. Hovers and resizes do not.
const TAKING_INPUT=new Set(['mouse','wheel','key','text','navigate','history','reload','fileChooser']);
const VIEWER_NAVIGATION_OPTIONS={waitUntil:'commit',timeout:NAVIGATION_TIMEOUT_MS};
const EDITABLE_AT_POINT_SCRIPT=`(x, y) => {
  let element = document.elementFromPoint(x, y);
  while (element && element.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === element) break;
    element = inner;
  }
  if (element && element.tagName === "LABEL" && element.control) element = element.control;
  if (!element) return false;
  if (element.tagName === "IFRAME" || element.tagName === "FRAME") return true;
  if (element.isContentEditable) return true;
  if (element.tagName === "TEXTAREA") return !element.disabled && !element.readOnly;
  if (element.tagName !== "INPUT") return false;
  const nonText = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"];
  return !nonText.includes(element.type) && !element.disabled && !element.readOnly;
}`;
const CLIPBOARD_TEXT_LIMIT=1024*1024;
const CLIPBOARD_WORLD='t3-preview-clipboard';
// Chromium shares its clipboard across contexts; capture real copy/cut keys in a page-inaccessible world instead.
const CLIPBOARD_SCRIPT=`(() => {
  let keying = false;
  // One entry per copy or cut key, oldest first, so a later key cannot overwrite an unread copy.
  const copies = [];
  // The same Ctrl or Cmd + C or X that editingCommand sends as copy or cut.
  addEventListener("keydown", (event) => {
    if (!event.isTrusted || event.altKey || event.ctrlKey === event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key !== "c" && key !== "x") return;
    keying = true;
    copies.push({ at: Date.now(), text: "" });
    setTimeout(() => { keying = false; });
  }, true);
  const selection = () => {
    let field = document.activeElement;
    while (field?.shadowRoot?.activeElement) field = field.shadowRoot.activeElement;
    if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && field.selectionStart !== null)
      return field.value.slice(field.selectionStart, field.selectionEnd ?? field.selectionStart);
    return String(document.getSelection() ?? "");
  };
  const record = (text) => {
    const copy = copies.at(-1);
    if (copy) copy.text = String(text ?? "").slice(0, ${CLIPBOARD_TEXT_LIMIT});
  };
  // Capturing at window runs before page handlers can stop the event, and
  // before cut removes the selection.
  const snapshot = (event) => {
    if (keying && event.isTrusted) record(selection());
  };
  // Bubbling back to window picks up text a page handler set instead.
  const replace = (event) => {
    if (keying && event.isTrusted && event.defaultPrevented) record(event.clipboardData?.getData("text/plain"));
  };
  for (const type of ["copy", "cut"]) {
    addEventListener(type, snapshot, true);
    addEventListener(type, replace);
  }
  // A key's copy was keyed between its dispatch and acknowledgement; older copies are stale.
  globalThis.takeCopy = (since, until) => {
    while (copies.length > 0 && copies[0].at < since) copies.shift();
    return copies[0] && copies[0].at <= until ? copies.shift().text : "";
  };
})();`;
// T3 f796df8f's ServerBrowserPage.parseNetError, without the numeric code table.
// Names can hold digits, as in ERR_HTTP2_PROTOCOL_ERROR.
export const parseNetError=errorText=>({description:/ERR_[A-Z\d_]+/.exec(errorText)?.[0]??errorText});
const failure=(status,message)=>Object.assign(Error(message),{status});
const constVoid=()=>undefined;
const sleepUntil=deadline=>new Promise(resolve=>setTimeout(resolve,Math.max(0,deadline-Date.now())));
const asRecord=value=>typeof value==='object'&&value!==null?value:null;
const num=(value,fallback=0)=>typeof value==='number'&&Number.isFinite(value)?value:fallback;
export const modifiersOf=message=>{const value=num(message.modifiers);return Number.isInteger(value)&&value>=0&&value<16?value:0;};
// Linux/headless Chromium needs commands for Cmd editing shortcuts and Ctrl copy/cut.
export const editingCommand=(key,modifiers)=>{
 const modifier=modifiers&0b0111;
 if(modifier!==2&&modifier!==4)return null;
 const lower=key.toLowerCase();
 const command=lower==='c'?'copy':lower==='x'?'cut':modifier!==4?null:lower==='a'?'selectAll':lower==='z'?(modifiers&8?'redo':'undo'):null;
 return command?{commands:[command]}:null;
};
const httpUrl=value=>{try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&value.length<=8192?url.href:null;}catch{return null;}};
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

/** T3's viewer output: Queue.make({capacity: VIEWER_OUTPUT_LIMIT, strategy: "dropping"}). */
class ViewerOutput{
 constructor(capacity){this.capacity=capacity;this.items=[];this.takers=[];this.shut=false;}
 /** Queue.offerUnsafe: false when a dropping queue is full. */
 offer(item){
  if(this.shut)return false;
  const taker=this.takers.shift();
  if(taker){taker(item);return true;}
  if(this.items.length>=this.capacity)return false;
  this.items.push(item);return true;
 }
 /** Resolves null once shut down. */
 take(){
  if(this.items.length)return Promise.resolve(this.items.shift());
  if(this.shut)return Promise.resolve(null);
  return new Promise(resolve=>this.takers.push(resolve));
 }
 clear(){const items=this.items;this.items=[];return items;}
 shutdown(){this.shut=true;for(const taker of this.takers.splice(0))taker(null);}
}

export class AgentBrowser{
 /**
  * The workspace passes nothing and gets its one page in its own profile.
  * The desktop preview host (preview-host.mjs) runs one AgentBrowser per
  * preview tab on a shared `contexts`, so tabs share a profile like T3's tabs
  * do: such a browser never closes the context, adopts a popup's page through
  * `adopt`, and reports its end through `onClosed`.
  */
 constructor({home='/home/agent',timeoutMs=30_000,launch,picker=new URL('./browser-assets/preview_picker.js',import.meta.url),executablePath=process.env.CANOPY_CHROMIUM_EXECUTABLE??'/usr/bin/chromium',contexts,profile=AGENT_PROFILE,adopt,onPopup,onClosed,prepareTab,label='workspace browser',autoControl=false,autoReleaseMs=AUTO_RELEASE_MS,fileChooser=false}={}){
  Object.assign(this,{home,timeoutMs,picker,executablePath,profile,adopt,onPopup,onClosed,prepareTab,label,autoControl,autoReleaseMs,fileChooser});
  this.launch=launch??(async profileDirectory=>{const {chromium}=createRequire(import.meta.url)('playwright-core');return chromium.launchPersistentContext(profileDirectory,{executablePath:this.executablePath,headless:true,args:['--no-sandbox','--disable-dev-shm-usage'],viewport:DEFAULT_VIEWPORT});});
  this.ownsContexts=!contexts;
  // The Chromium profile lock (browser-contexts.mjs): one persistent context per profile directory.
  this.contexts=contexts??new BrowserContexts({profilesDir:join(home,'.canopy','browser-profiles'),launch:directory=>this.launch(directory),onContextClose:context=>this.contextClosed(context)});
  this.pending=new Map();this.serial=0;this.viewerResizeOrder=0;
  /** T3's tab.setting: fill follows the latest viewer's size, fixed is the agent's resize. */
  this.setting={_tag:'fill'};
 }
 /** A shared context closed (Chromium exited); the host fans this out to every tab. */
 contextClosed(context){if(this.current?.context===context)this.dropTab(this.current);}
 /** The workspace's one tab, created once; T3's ensureTab with Canopy's single key. */
 open(){
  if(this.ended)return Promise.reject(Object.assign(new Error('The preview tab closed.'),{reason:'closed'}));
  if(this.current&&!this.current.closing)return Promise.resolve(this.current);
  this.opening??=this.createTab().finally(()=>{this.opening=undefined;});
  return this.opening;
 }
 async createTab(){
  const opened=[];
  try{return await this.setUpTab(opened);}
  catch(error){
   // An unpublished tab is in no list, so nothing else would ever close it.
   for(const close of opened.reverse())await close().catch(constVoid);
   throw error;
  }
 }
 async setUpTab(opened){
  const context=await this.contexts.contextFor(this.profile);
  // A context with no tab left would otherwise hold the profile lock with nothing to show.
  // A shared context holds other tabs, so only this tab's page is closed.
  if(this.ownsContexts)opened.push(()=>context.close());
  // T3's prepareContext: the page may write the clipboard; copies reach the viewer through CLIPBOARD_SCRIPT.
  await context.grantPermissions(['clipboard-write']);
  const adopted=this.adopt;this.adopt=undefined;
  const page=adopted&&!adopted.isClosed()?adopted:await context.newPage();
  if(!this.ownsContexts)opened.push(()=>page.close());
  const tab={
   context,page,source:'',cdp:null,frameSessions:new Map(),viewers:new Set(),fileChooser:null,
   // T3 3c7424ee: copy reads run in key order, outside the input queue.
   copyReads:Promise.resolve(),copyKeyedUntil:0,
   control:new SessionControl(AGENT_ID),captureLock:Promise.resolve(),capturing:0,dialog:null,closing:false,
  };
  await page.exposeBinding('__canopyStreamSend',({frame},message)=>{
   if(frame!==page.mainFrame()||typeof message!=='object'||message===null)return;
   if(message.canopy==='agent-result'){
    const waiter=this.pending.get(message.id);if(waiter){this.pending.delete(message.id);waiter(message);}
    return;
   }
   // The desktop preview's picker (annotations, regions, ready/nav) talks to the
   // viewer, as it talks to the IDE over postMessage under the proxy.
   if(this.autoControl)for(const viewer of tab.viewers)viewer.push({_tag:'picker',message});
  });
  tab.source=`if (window === window.top) { window.__canopyStreamBrowser = true; ${await readFile(this.picker,'utf8')}\n }`;
  await page.addInitScript({content:tab.source});
  await page.evaluate(tab.source).catch(()=>{});
  tab.cdp=await context.newCDPSession(page);
  await this.recordCopies(tab.cdp);
  // The desktop host presents the page as Chrome (T3's presentAsChrome).
  if(this.prepareTab)await this.prepareTab(tab).catch(constVoid);
  if(this.setting._tag==='fixed')await page.setViewportSize({width:this.setting.width,height:this.setting.height});
  page.on('framenavigated',frame=>void this.recordFrameCopies(tab,frame));
  // An adopted popup's frames may have loaded before the tab listened.
  if(adopted)for(const frame of page.frames())void this.recordFrameCopies(tab,frame);
  // T3 f796df8f: browser tools report why a page failed to load.
  page.on('request',request=>{if(request.isNavigationRequest()&&request.frame()===page.mainFrame())tab.loadError=undefined;});
  page.on('requestfailed',request=>{
   if(!request.isNavigationRequest()||request.frame()!==page.mainFrame())return;
   tab.loadError={url:request.url().slice(0,2048),...parseNetError(request.failure()?.errorText??'')};
   void this.broadcastNavigation(tab);
  });
  page.on('dialog',dialog=>{
   // Closing is already decided, so an unsaved-changes guard must not keep the page open.
   if(tab.closing&&dialog.type()==='beforeunload'){void dialog.accept().catch(constVoid);return;}
   tab.dialog=dialog;this.broadcastControl(tab);
  });
  // The viewer's address bar (Canopy's preview toolbar); T3 sends this in its tab snapshot.
  page.on('framenavigated',frame=>{if(frame===page.mainFrame())void this.broadcastNavigation(tab);});
  page.on('load',()=>void this.broadcastNavigation(tab));
  // T3: popups become tabs and keep `window.opener`, so sign-in popups can report back.
  if(this.onPopup)page.on('popup',popup=>void this.onPopup(popup,tab));
  // T3's file chooser: the page's file input is answered by the person controlling it.
  if(this.fileChooser){
   let offers=Promise.resolve();
   page.on('filechooser',chooser=>{offers=offers.then(()=>this.offerFileChooser(tab,chooser)).catch(constVoid);});
   page.on('framenavigated',()=>{
    const open=tab.fileChooser;
    if(open)void this.isFileChooserCurrent(open.chooser).then(current=>{if(!current&&tab.fileChooser===open)this.closeFileChooser(tab);});
   });
  }
  // Playwright cannot reload a crashed page, so it must leave the tab list.
  page.on('close',()=>this.dropTab(tab));
  page.on('crash',()=>this.dropTab(tab));
  this.current=tab;
  return tab;
 }
 dropTab(tab){
  if(this.current!==tab)return;
  this.current=undefined;
  tab.closing=true;
  for(const viewer of tab.viewers)viewer.push({_tag:'gone'});
  void tab.control.close().catch(constVoid);
  // T3 d9805b2c: closing runs the page's beforeunload handlers. `runBeforeUnload`
  // returns before the page closes, a pending dialog would block beforeunload
  // from running at all, and a renderer that never finishes unloading must not
  // outlive its tab.
  const page=tab.page;
  const closed=page.isClosed()?Promise.resolve():new Promise(resolve=>page.once('close',()=>resolve()));
  const forceClose=setTimeout(()=>void page.close().catch(constVoid),PAGE_CLOSE_GRACE_MS);
  void closed.then(()=>clearTimeout(forceClose));
  void page.close({runBeforeUnload:tab.dialog===null}).catch(()=>page.close()).catch(constVoid);
  tab.closed=closed;
  if(!this.ownsContexts){this.ended=true;this.onClosed?.();}
 }
 async broadcastNavigation(tab){
  if(tab.closing||!tab.viewers.size)return;
  const title=await tab.page.title().catch(()=>'');
  const loadError=this.loadErrorOf(tab);
  for(const viewer of tab.viewers)viewer.push({_tag:'navigated',url:loadError?.url??tab.page.url(),title,...(loadError?{loadError}:{})});
 }
 run(op,args={}){
  validateBrowserOp(op,args);
  return this.runOperation(op,args,performance.now()+this.timeoutMs).catch(error=>{
   // SessionControl's start deadline (T3's deadlineMs) passed while queued.
   if(error?.name==='TimeoutError')throw failure(504,`The ${this.label} didn't answer in time. The page may still be loading — try again.`);
   throw error;
  });
 }
 async runOperation(op,args,deadlineMs){
  const tab=await this.deadline(this.open());
  const pending=()=>new BrowserControlInterrupted({message:'A browser dialog is pending. A person has to answer it in the agent browser before the agent can continue.',reason:'dialogPending'});
  // Canopy difference: T3 lets only agents that do not own a tab observe it;
  // Canopy's one agent owns the page, so its reads observe while a human controls it.
  if(READ_OPERATIONS.has(op)&&!tab.control.agentCanActNow(AGENT_ID)){
   return tab.control.observe(async()=>{
    if(tab.dialog)throw pending();
    return this.deadline(this.execute(tab,op,args));
   });
  }
  return tab.control.agent(AGENT_ID,async()=>{
   if(tab.dialog)throw pending();
   // Bounded inside the queue, so a hung op cannot wedge the actions behind it.
   return this.deadline(this.execute(tab,op,args));
  },deadlineMs);
 }
 deadline(promise){
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure(504,`The ${this.label} didn't answer in time. The page may still be loading — try again.`)),this.timeoutMs);})]).finally(()=>clearTimeout(timer));
 }
 async execute(tab,op,args){
  const {page,source}=tab;
  const here=async()=>({url:page.url(),title:await page.title().catch(()=>'')});
  const viewport=()=>page.viewportSize()??DEFAULT_VIEWPORT;
  if(op==='navigate'){
   const options={waitUntil:'domcontentloaded',timeout:this.timeoutMs-1000};
   if(args.url)await page.goto(args.url,options);
   else if(args.action==='back')await page.goBack(options);
   else if(args.action==='forward')await page.goForward(options);
   else await page.reload(options);
   return here();
  }
  if(op==='resize'){
   await this.applySetting(tab,args.reset?{_tag:'fill'}:{_tag:'fixed',width:args.width,height:args.height});
   const {width,height}=viewport();
   return {url:page.url(),width,height,reset:!!args.reset};
  }
  if(op==='screenshot'){
   // CSS pixels by default, so the image matches the width and height reported;
   // `scale: "device"` keeps a 2x page's full resolution (the IDE's own region crops).
   const image=await this.withScreencastsPaused(tab,()=>page.screenshot({type:'png',scale:args.scale==='device'?'device':'css',timeout:this.timeoutMs-1000}));
   return {image:image.toString('base64'),mimeType:'image/png',url:page.url(),...viewport()};
  }
  if(!PAGE_OPS.has(op))throw failure(400,`unknown browser op: ${op}`);
  const pick=async()=>{
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
  };
  if(op!=='snapshot')return pick();
  const snapshot=await this.withScreencastsPaused(tab,pick);
  const loadError=this.loadErrorOf(tab);
  return loadError&&snapshot&&typeof snapshot==='object'?{...snapshot,loadError}:snapshot;
 }
 loadErrorOf(tab){return tab.page.url().startsWith('chrome-error://')?tab.loadError:undefined;
 }
 // T3's applySetting, without zoom: fixed sizes win, fill follows the newest viewer request.
 async applySetting(tab,setting){
  this.setting=setting;
  const size=setting._tag==='fixed'?{width:setting.width,height:setting.height}:
   [...tab.viewers].map(viewer=>viewer.requestedSize).filter(requested=>requested!==null).sort((left,right)=>right.order-left.order)[0]??DEFAULT_VIEWPORT;
  await tab.page.setViewportSize({width:size.width,height:size.height});
  await this.broadcastViewport(tab);
 }
 layoutSize(tab){return tab.page.viewportSize();}
 async broadcastViewport(tab){
  const size=this.layoutSize(tab);
  if(!size||tab.closing)return;
  for(const viewer of tab.viewers)viewer.push({_tag:'viewport',width:size.width,height:size.height});
 }
 dialogStatus(tab){
  return tab.dialog?{type:tab.dialog.type(),message:tab.dialog.message().slice(0,4000),defaultValue:tab.dialog.defaultValue().slice(0,4000)}:null;
 }
 // T3's file chooser lifecycle (offerFileChooser, pushFileChooser, closeFileChooser, setChooserFiles).
 // Not isConnected: upload helpers often click an input never added to the page.
 isFileChooserCurrent(chooser){
  return chooser.element().evaluate(element=>element.ownerDocument===document).catch(()=>false);
 }
 async offerFileChooser(tab,chooser){
  const previous=tab.fileChooser;
  const accept=(await chooser.element().getAttribute('accept').catch(()=>null))??'';
  if(!(await this.isFileChooserCurrent(chooser)))return;
  if(previous)this.closeFileChooser(tab);
  tab.fileChooser={id:randomUUID(),chooser,accept:accept.slice(0,1024),offeredTo:null};
  this.pushFileChooser(tab);
 }
 pushFileChooser(tab){
  const open=tab.fileChooser;
  const controller=[...tab.viewers].find(viewer=>viewer.id===tab.control.controller);
  if(!open||!controller)return;
  if(open.offeredTo!==controller.id){
   tab.fileChooser={...open,id:randomUUID(),offeredTo:controller.id};
   if(open.offeredTo!==null)for(const viewer of tab.viewers)viewer.push({_tag:'fileChooserClosed',id:open.id});
  }
  const current=tab.fileChooser;
  controller.push({_tag:'fileChooser',id:current.id,multiple:current.chooser.isMultiple(),accept:current.accept});
 }
 closeFileChooser(tab){
  const open=tab.fileChooser;
  if(!open)return;
  tab.fileChooser=null;
  for(const viewer of tab.viewers)viewer.push({_tag:'fileChooserClosed',id:open.id});
 }
 /** Canopy difference: the host runs on the person's own computer, so the IDE
  *  answers with paths from its native file dialog instead of T3's upload route. */
 async setChooserFiles(tab,viewer,input){
  const open=tab.fileChooser;
  if(!open||open.id!==input.id||open.offeredTo===null||open.offeredTo!==viewer.id||tab.control.controller!==viewer.id)return false;
  const paths=Array.isArray(input.paths)?input.paths.filter(path=>typeof path==='string'&&isAbsolute(path)).slice(0,20):[];
  if(paths.length>0)await open.chooser.setFiles(open.chooser.isMultiple()?paths:paths.slice(0,1));
  if(tab.fileChooser===open)this.closeFileChooser(tab);
  return true;
 }
 broadcastControl(tab){
  if(this.fileChooser)this.pushFileChooser(tab);
  for(const viewer of tab.viewers)viewer.push({
   _tag:'control',canOperate:viewer.canOperate,
   controller:tab.control.controller===viewer.id?'you':tab.control.controller!==null?'another-viewer':tab.control.agentId!==null?'agent':'unclaimed',
   generation:tab.control.generation,dialog:this.dialogStatus(tab),
  });
 }
 async resolveDialog(tab,input){
  const dialog=tab.dialog;
  if(!dialog)throw new Error('No dialog is pending.');
  if(input.accept)await dialog.accept(input.promptText);
  else await dialog.dismiss();
  if(tab.dialog===dialog)tab.dialog=null;
  this.broadcastControl(tab);
 }
 withCaptureLock(tab,operation){
  const run=tab.captureLock.then(()=>{
   if(tab.closing)throw new Error('The preview tab closed.');
   return operation();
  });
  tab.captureLock=run.then(constVoid,constVoid);
  return run;
 }
 withScreencastsPaused(tab,capture){
  return this.withCaptureLock(tab,async()=>{
   tab.capturing+=1;
   try{
    await Promise.all([...tab.viewers].map(viewer=>viewer.pause()));
    return await capture();
   }finally{
    tab.capturing-=1;
    await Promise.all([...tab.viewers].map(viewer=>viewer.resume()));
   }
  });
 }
 async recordCopies(cdp){
  // Scripts for new documents run only while this session's Page domain is on.
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:CLIPBOARD_SCRIPT,worldName:CLIPBOARD_WORLD,runImmediately:true});
 }
 /** Out-of-process frames need their own copy-recording session until target closure. */
 async recordFrameCopies(tab,frame){
  if(frame===tab.page.mainFrame()||tab.frameSessions.has(frame))return;
  const cdp=await tab.context.newCDPSession(frame).catch(()=>null);
  if(!cdp)return;
  if(tab.frameSessions.has(frame)||frame.isDetached()){await cdp.detach().catch(constVoid);return;}
  tab.frameSessions.set(frame,cdp);
  cdp.on('close',()=>{
   if(tab.frameSessions.get(frame)!==cdp)return;
   tab.frameSessions.delete(frame);
   if(!frame.isDetached())void this.recordFrameCopies(tab,frame);
  });
  await this.recordCopies(cdp).catch(constVoid);
 }
 async takeSessionCopies(cdp,since,until){
  const tree=await cdp.send('Page.getFrameTree').catch(()=>null);
  if(!tree)return [];
  const frameIds=node=>[node.frame.id,...(node.childFrames??[]).flatMap(frameIds)];
  return Promise.all(frameIds(tree.frameTree).map(frameId=>cdp.send('Page.createIsolatedWorld',{frameId,worldName:CLIPBOARD_WORLD})
   .then(({executionContextId})=>cdp.send('Runtime.evaluate',{contextId:executionContextId,expression:`globalThis.takeCopy?.(${since}, ${until})`,returnByValue:true}))
   .then(({result})=>typeof result.value==='string'?result.value:'',()=>'')));
 }
 async takeCopiedText(tab,since,until){
  const copies=await Promise.all([tab.cdp,...tab.frameSessions.values()].map(cdp=>this.takeSessionCopies(cdp,since,until)));
  return copies.flat().find(text=>text.length>0);
 }
 async releaseViewerInput(viewer,session){
  for(const {key,code} of viewer.pressedKeys.values())await session.send('Input.dispatchKeyEvent',{type:'keyUp',key,code}).catch(constVoid);
  viewer.pressedKeys.clear();
  for(const [button,point] of viewer.pressedButtons)await session.send('Input.dispatchMouseEvent',{type:'mouseReleased',button,...point,buttons:0,clickCount:1}).catch(constVoid);
  viewer.pressedButtons.clear();
  viewer.requestedSize=null;
 }
 async dispatchViewerInput(tab,session,viewer,raw){
  const message=asRecord(raw);
  if(!message)return;
  const modifiers=modifiersOf(message);
  switch(message.type){
   case 'mouse':{
    const action=message.action;
    const type=action==='down'?'mousePressed':action==='up'?'mouseReleased':'mouseMoved';
    const button=['none','left','middle','right'].includes(String(message.button))?message.button:'none';
    await session.send('Input.dispatchMouseEvent',{type,x:num(message.x),y:num(message.y),button,buttons:num(message.buttons),clickCount:num(message.clickCount,type==='mouseMoved'?0:1),modifiers});
    if(button!=='none'){
     if(action==='down')viewer.pressedButtons.set(button,{x:num(message.x),y:num(message.y)});
     else if(action==='up')viewer.pressedButtons.delete(button);
    }
    return;
   }
   case 'wheel':
    viewer.scrolledAt=Date.now();
    await session.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:num(message.x),y:num(message.y),deltaX:num(message.deltaX),deltaY:num(message.deltaY),modifiers});
    return;
   case 'key':{
    const key=typeof message.key==='string'?message.key:'';
    const code=typeof message.code==='string'?message.code:'';
    const text=typeof message.text==='string'?message.text:undefined;
    if(message.action==='up'){
     await session.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers});
     viewer.pressedKeys.delete(code||key);
     return;
    }
    const command=editingCommand(key,modifiers);
    const copying=command?.commands[0]==='copy'||command?.commands[0]==='cut';
    // Copy keys get disjoint millisecond windows so each frame's copy belongs to one key.
    if(copying)while(Date.now()<=tab.copyKeyedUntil)await sleepUntil(tab.copyKeyedUntil+1);
    const since=Date.now();
    await session.send('Input.dispatchKeyEvent',{
     type:text?'keyDown':'rawKeyDown',key,code,modifiers,
     ...(text?{text,unmodifiedText:text}:{}),
     ...command,
     windowsVirtualKeyCode:num(message.keyCode,key.length===1?key.toUpperCase().charCodeAt(0):0),
    });
    viewer.pressedKeys.set(code||key,{key,code});
    if(!copying)return;
    const until=Date.now();
    tab.copyKeyedUntil=until;
    // A busy frame answers late; its read must not hold later input.
    const read=tab.copyReads.then(async()=>{
     const copied=await this.takeCopiedText(tab,since,until);
     if(copied)viewer.push({_tag:'clipboard',text:copied});
    });
    tab.copyReads=read;
    return()=>read;
   }
   case 'text':
    if(typeof message.text==='string'&&message.text.length>0)await session.send('Input.insertText',{text:message.text.slice(0,10_000)});
    return;
   case 'resize':{
    const width=Math.min(Math.round(num(message.width)),3840);
    const height=Math.min(Math.round(num(message.height)),2160);
    if(width<100||height<100)return;
    viewer.requestedSize={width,height,order:++this.viewerResizeOrder};
    if(this.setting._tag!=='fill')return;
    const current=tab.page.viewportSize();
    if(current?.width===width&&current.height===height)return;
    await tab.page.setViewportSize({width,height});
    await this.broadcastViewport(tab);
    return;
   }
   // A stalled navigation must not block a corrected URL or further viewer input.
   case 'navigate':
    // Canopy difference: T3 normalizes with normalizePreviewUrl; the agent
    // browser opens only http(s) pages, as validateBrowserOp does.
    if(typeof message.url==='string'){
     const url=httpUrl(message.url);
     if(url)tab.control.trackUntilHandoff(tab.page.goto(url,VIEWER_NAVIGATION_OPTIONS));
    }
    return;
   case 'history':
    tab.control.trackUntilHandoff(num(message.delta)<0?tab.page.goBack(VIEWER_NAVIGATION_OPTIONS):tab.page.goForward(VIEWER_NAVIGATION_OPTIONS));
    return;
   case 'reload':
    if(message.ignoreCache===true){await session.send('Page.reload',{ignoreCache:true});return;}
    tab.control.trackUntilHandoff(tab.page.reload(VIEWER_NAVIGATION_OPTIONS));
    return;
   case 'probe':{
    const x=num(message.x),y=num(message.y);
    const result=await session.send('Runtime.evaluate',{expression:`(${EDITABLE_AT_POINT_SCRIPT})(${x}, ${y})`,returnByValue:true});
    viewer.push({_tag:'probe',x,y,editable:result.result.value===true});
    return;
   }
  }
 }
 /**
  * T3's attachViewer. Returns the viewer's bounded output (frames carry an
  * `ack()` that releases Chromium), its `input`, and `close()`, which runs
  * T3's scope finalizers in reverse order.
  * @param {{maxWidth:number,maxHeight:number,quality:number,canOperate:boolean}} input
  */
 async attachViewer(input){
  const tab=await this.open();
  const output=new ViewerOutput(VIEWER_OUTPUT_LIMIT);
  const session=await tab.context.newCDPSession(tab.page);
  const finalizers=[()=>session.send('Page.stopScreencast').catch(constVoid).then(()=>session.detach()).catch(constVoid)];
  let closed=false;
  const close=async()=>{
   if(closed)return;closed=true;
   output.shutdown();
   for(const finalize of finalizers.reverse())await finalize();
  };
  try{
   const quality=Math.min(100,Math.max(1,Math.round(input.quality)));
   // Chromium may drop the final frame during a burst; send a still when it settles.
   let framesInFlight=0,mayHaveDropped=false,motion=false;
   const recentFrames=[];
   let screencastParams=Promise.resolve(),screencastScale=1;
   const startScreencast=scale=>{
    screencastScale=scale;
    screencastParams=screencastParams.then(async()=>{
     if(tab.capturing>0)return;
     await session.send('Page.stopScreencast').catch(constVoid);
     await session.send('Page.startScreencast',{
      format:'jpeg',
      quality:screencastScale<1?Math.min(quality,SCREENCAST_MOTION_QUALITY):quality,
      maxWidth:Math.max(1,Math.round(input.maxWidth*screencastScale)),
      maxHeight:Math.max(1,Math.round(input.maxHeight*screencastScale)),
     }).catch(constVoid);
    });
    return screencastParams;
   };
   const viewer={
    id:randomUUID(),canOperate:input.canOperate,pressedKeys:new Map(),pressedButtons:new Map(),
    push:next=>{
     // Dropped frames must still release Chromium.
     if(output.offer(next))return;
     if(next._tag==='frame')void next.ack();
     // State a stalled viewer cannot miss compacts its backlog. It runs
     // synchronously so an older compaction can never land after a newer one.
     else if(['gone','reconnect','control','viewport','fileChooser'].includes(next._tag)){
      if(output.shut)return;
      const dropped=output.clear();
      const items=[...dropped,next];
      // Without its latest size and control the viewer cannot map input at all.
      const state=['control','viewport'].flatMap(tag=>items.findLast(item=>item._tag===tag)??[]);
      // Everything else is one-time; if it no longer fits, the oldest goes first.
      const rest=items.filter(item=>item._tag!=='frame'&&item._tag!=='control'&&item._tag!=='viewport');
      for(const item of [...rest.slice(state.length-VIEWER_OUTPUT_LIMIT),...state])output.offer(item);
      for(const item of dropped)if(item._tag==='frame')void item.ack();
     }
    },
    pause:()=>{
     screencastParams=screencastParams.then(()=>session.send('Page.stopScreencast').then(constVoid,constVoid));
     return screencastParams;
    },
    resume:()=>startScreencast(screencastScale),
    scrolledAt:0,
    requestedSize:null,
   };
   tab.viewers.add(viewer);
   finalizers.push(async()=>{
    await tab.control.disconnect(viewer.id,()=>this.releaseViewerInput(viewer,session)).catch(constVoid);
    tab.viewers.delete(viewer);
    this.broadcastControl(tab);
   });
   // In T3 a tab no agent owns (agentId === null) is taken by its first
   // operating viewer. Canopy's agent owns this page, so this never fires and
   // the viewer shows "Agent has control" until the person takes it.
   if(input.canOperate&&tab.control.agentId===null&&tab.control.controller===null)await tab.control.take(viewer.id);
   this.broadcastControl(tab);
   const pushStill=async()=>{
    const data=await this.withCaptureLock(tab,async()=>(await session.send('Page.captureScreenshot',{format:'jpeg',quality})).data).catch(()=>null);
    if(data)viewer.push({_tag:'frame',data:Buffer.from(data,'base64'),ack:async()=>{}});
   };
   let settleTimer=null;
   finalizers.push(async()=>{if(settleTimer!==null)clearTimeout(settleTimer);});
   let screencastStarted=false;
   session.on('Page.screencastFrame',frame=>{
    screencastStarted=true;
    if(framesInFlight>0)mayHaveDropped=true;
    framesInFlight+=1;
    const arrivedAt=Date.now();
    recentFrames.push(arrivedAt);
    while(recentFrames[0]<arrivedAt-SCREENCAST_MOTION_WINDOW_MS)recentFrames.shift();
    if(!motion&&recentFrames.length>=SCREENCAST_MOTION_FRAMES&&arrivedAt-viewer.scrolledAt<SCREENCAST_MOTION_WINDOW_MS){
     motion=true;
     void startScreencast(0.5);
    }else if(motion&&arrivedAt-viewer.scrolledAt>SCREENCAST_SETTLE_MS){
     motion=false;
     recentFrames.length=0;
     void startScreencast(1);
    }
    if(settleTimer!==null)clearTimeout(settleTimer);
    settleTimer=setTimeout(()=>{
     settleTimer=null;
     if(!motion&&!mayHaveDropped)return;
     mayHaveDropped=false;
     if(motion){motion=false;recentFrames.length=0;void startScreencast(1);}
     void pushStill();
    },SCREENCAST_SETTLE_MS);
    viewer.push({
     _tag:'frame',
     data:Buffer.from(frame.data,'base64'),
     ack:()=>sleepUntil(arrivedAt+SCREENCAST_ACK_PACE_MS).then(()=>{
      framesInFlight-=1;
      return session.send('Page.screencastFrameAck',{sessionId:frame.sessionId}).catch(constVoid);
     }),
    });
   });
   void this.broadcastViewport(tab).catch(constVoid);
   await startScreencast(1);
   // An idle page does not repaint for a new screencast, so the viewer
   // starts from a still unless a live frame beat it.
   if(!screencastStarted)await pushStill();
   // autoControl: the page is taken by a person's input and given back once it stops.
   let releaseTimer=null;
   finalizers.push(async()=>{if(releaseTimer!==null)clearTimeout(releaseTimer);});
   const scheduleRelease=()=>{
    if(releaseTimer!==null)clearTimeout(releaseTimer);
    releaseTimer=setTimeout(()=>{
     releaseTimer=null;
     if(closed||tab.control.controller!==viewer.id)return;
     // Never mid-gesture, and never while a dialog or file chooser waits on this person.
     if(viewer.pressedKeys.size||viewer.pressedButtons.size||tab.dialog||tab.fileChooser?.offeredTo===viewer.id){scheduleRelease();return;}
     const releasing=tab.control.release(viewer.id,()=>this.releaseViewerInput(viewer,session));
     this.broadcastControl(tab);
     void releasing.catch(constVoid);
    },this.autoReleaseMs);
   };
   const autoTake=async message=>{
    const hover=message.type==='mouse'&&message.action==='move'&&message.button==='none'&&message.buttons===0;
    if(tab.control.controller===viewer.id){if(!hover)scheduleRelease();return true;}
    if(tab.control.controller!==null)return false;
    // Nobody holds the page: a hover passes straight through, real input takes it.
    if(hover)return 'direct';
    if(!TAKING_INPUT.has(message.type))return 'direct';
    const taking=tab.control.take(viewer.id);
    this.broadcastControl(tab);
    await taking;
    scheduleRelease();
    return true;
   };
   const inputFor=async raw=>{
    if(!viewer.canOperate||closed)return;
    const message=asRecord(raw);
    if(!message)return;
    try{
     if(message.type==='picker'){
      // Picker commands (annotate mode, marks) steer the IDE's overlay, not the page's state.
      const command=asRecord(message.message);
      if(command&&this.autoControl)await tab.page.evaluate(d=>window.__canopyBrowser?window.__canopyBrowser.cmd(d):false,command).catch(constVoid);
      return;
     }
     if(this.autoControl&&!['takeControl','releaseControl','dialog'].includes(String(message.type))){
      const taken=await autoTake(message);
      if(taken===false)return;
      if(taken==='direct'){await this.dispatchViewerInput(tab,session,viewer,message).catch(constVoid);return;}
     }
     if(message.type==='fileChooser'&&this.fileChooser){await this.setChooserFiles(tab,viewer,message);return;}
     if(message.type==='takeControl'){
      const taking=tab.control.take(viewer.id);
      this.broadcastControl(tab);
      await taking;
     }else if(message.type==='releaseControl'){
      const releasing=tab.control.release(viewer.id,()=>this.releaseViewerInput(viewer,session));
      this.broadcastControl(tab);
      await releasing;
     }else if(message.type==='dialog'&&tab.control.controller===viewer.id&&typeof message.accept==='boolean'){
      await this.resolveDialog(tab,{accept:message.accept,...(typeof message.promptText==='string'?{promptText:message.promptText}:{})});
     }else{
      const dispatch=async next=>{await this.dispatchViewerInput(tab,session,viewer,next);};
      if(message.type==='mouse'&&message.action==='move'&&message.button==='none'&&message.buttons===0){
       await tab.control.humanLatest(viewer.id,`hover:${modifiersOf(message)}`,message,dispatch);
      }else if(message.type==='wheel'){
       // A reversal stays separate so scrolling clamped at an edge behaves as if unmerged.
       await tab.control.humanLatest(viewer.id,`wheel:${num(message.x)}:${num(message.y)}:${modifiersOf(message)}:${Math.sign(num(message.deltaX))}:${Math.sign(num(message.deltaY))}`,message,dispatch,
        (waiting,next)=>({...next,deltaX:num(waiting.deltaX)+num(next.deltaX),deltaY:num(waiting.deltaY)+num(next.deltaY)}));
      }else{
       const copyRead=await tab.control.human(viewer.id,()=>this.dispatchViewerInput(tab,session,viewer,message));
       await copyRead?.();
      }
     }
    }catch{
     this.broadcastControl(tab);
    }
   };
   return {id:viewer.id,output,input:inputFor,close};
  }catch(error){await close();throw error;}
 }
 async close(){
  const tab=this.current;
  if(tab)this.dropTab(tab);
  if(this.ownsContexts)await this.contexts.close();
  else{this.ended=true;await tab?.closed;}
 }
}
