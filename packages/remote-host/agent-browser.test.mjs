import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentBrowser,validateBrowserOp} from './agent-browser.mjs';

test('ops are checked like the desktop /ctx/browser handler before touching the page',()=>{
 const rejects=[['navigate',{}],['navigate',{url:'file:///etc/passwd'}],['navigate',{url:'javascript:alert(1)'}],['click',{}],['type',{ref:1}],['eval',{code:'  '}],['resize',{width:100,height:800}],['resize',{reset:true,width:800}],['screenshot',{scope:'window'}],['devtools',{}],['snapshot',[]]];
 for(const [op,args] of rejects)assert.throws(()=>validateBrowserOp(op,args),error=>error.status===400,`${op} ${JSON.stringify(args)}`);
 assert.throws(()=>validateBrowserOp('screenshot',{scope:'ide'}),error=>error.status===503&&/no IDE/.test(error.message));
 for(const [op,args] of [['navigate',{url:'https://example.com'}],['navigate',{action:'back'}],['click',{ref:3}],['type',{selector:'#q',text:'hi'}],['resize',{reset:true}],['resize',{width:390,height:844}],['screenshot',{}],['console',{lines:5}],['network',{}],['snapshot',{}]])validateBrowserOp(op,args);
});

function fakeBrowser(){
 const state={url:'about:blank',viewport:null,launches:0,profile:null,commands:[]};let binding,closeHandler;
 const page={
  isClosed:()=>false,url:()=>state.url,title:async()=>'Title',mainFrame:()=>'main',
  exposeBinding:async(name,fn)=>{assert.equal(name,'__canopyStreamSend');binding=fn;},
  addInitScript:async({content})=>{assert.match(content,/__canopyStreamBrowser = true/);assert.match(content,/PICKER/);},
  evaluate:async(fn,arg)=>{
   if(typeof fn==='string')return;
   if(arg?.canopy!=='agent')return;
   state.commands.push(arg);
   queueMicrotask(()=>binding({frame:'main'},arg.op==='eval'?{canopy:'agent-result',id:arg.id,ok:false,data:'ReferenceError: x'}:{canopy:'agent-result',id:arg.id,ok:true,data:{op:arg.op,bg:arg.bg}}));
   // A forged answer from a child frame is ignored.
   queueMicrotask(()=>binding({frame:'child'},{canopy:'agent-result',id:arg.id,ok:true,data:'forged'}));
   return true;
  },
  goto:async url=>{state.url=new URL(url).href;},goBack:async()=>{},goForward:async()=>{},reload:async()=>{},
  setViewportSize:async size=>{state.viewport=size;},
  screenshot:async()=>Buffer.from('png'),
 };
 const context={pages:()=>[page],newPage:async()=>page,on:(event,fn)=>{if(event==='close')closeHandler=fn;},close:async()=>closeHandler?.()};
 return {state,launch:async profile=>{state.launches++;state.profile=profile;return context;}};
}

test('the agent browser drives one private page through the injected picker with desktop shapes',async()=>{
 const home=await mkdtemp(join(tmpdir(),'agent-browser-'));const picker=join(home,'picker.js');await writeFile(picker,'/* PICKER */');
 const fake=fakeBrowser(),browser=new AgentBrowser({home,launch:fake.launch,picker});
 try{
  assert.deepEqual(await browser.run('navigate',{url:'http://localhost:3000'}),{url:'http://localhost:3000/',title:'Title'});
  assert.equal(fake.state.profile,join(home,'.canopy','browser-profiles','agent-tools'));
  assert.deepEqual(await browser.run('snapshot',{max:20,project:'ignored'}),{op:'snapshot',bg:true});
  assert.deepEqual(fake.state.commands[0],{canopy:'agent',id:1,op:'snapshot',bg:true,max:20});
  await assert.rejects(browser.run('eval',{code:'x'}),error=>error.status===400&&/ReferenceError/.test(error.message));
  assert.deepEqual(await browser.run('resize',{width:390,height:844}),{url:'http://localhost:3000/',width:390,height:844,reset:false});
  assert.deepEqual(await browser.run('screenshot',{}),{image:Buffer.from('png').toString('base64'),mimeType:'image/png',url:'http://localhost:3000/',width:390,height:844});
  assert.deepEqual(await browser.run('resize',{reset:true}),{url:'http://localhost:3000/',width:1280,height:720,reset:true});
  assert.equal(fake.state.launches,1,'one browser per workspace runtime');
 }finally{await browser.close();await rm(home,{recursive:true,force:true});}
});

test('every op has a bounded deadline and a hung op does not wedge the queue',async()=>{
 const home=await mkdtemp(join(tmpdir(),'agent-browser-'));const picker=join(home,'picker.js');await writeFile(picker,'/* PICKER */');
 const fake=fakeBrowser();let hang=true;
 const browser=new AgentBrowser({home,picker,timeoutMs:100,launch:async profile=>{const context=await fake.launch(profile);const page=context.pages()[0],goto=page.goto;page.goto=async url=>{if(hang)return new Promise(()=>{});return goto(url);};return context;}});
 try{
  await assert.rejects(browser.run('navigate',{url:'http://localhost:1'}),error=>error.status===504);
  hang=false;assert.equal((await browser.run('navigate',{url:'http://localhost:2'})).url,'http://localhost:2/');
 }finally{await browser.close();await rm(home,{recursive:true,force:true});}
});
