import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {HEARTBEAT_MS,LiveGuest,QUIET_MS} from './guest';
import type {LiveOp} from '../teamMessaging/liveEvents';
import type {TeamLiveEvent} from '../teamMessaging/session';

const room='0f8fad5b-d9cb-469f-a165-70867728950e';
const join={team:'core',owner:'sam',ownerName:'Sam',room,title:'Fix login',agent:'claude'};
let sent:{op:LiveOp;reachAll?:boolean}[],listener:((e:TeamLiveEvent)=>void)|null,devices:number,now:number;
const make=()=>new LiveGuest(join,{send:async(_t,_p,_r,op,reachAll)=>{sent.push({op,reachAll});return devices;},subscribe:fn=>{listener=fn;return()=>{listener=null;};},now:()=>now});
const from=(event:Record<string,unknown>,sender='sam',team='core',target=room)=>listener?.({team,user:'ana',sender,event:{type:'live',target,...event} as never});
const flush=()=>new Promise(r=>setTimeout(r,0));
beforeEach(()=>{sent=[];listener=null;devices=1;now=0;vi.useFakeTimers({toFake:['setInterval','clearInterval']});});
afterEach(()=>vi.useRealTimers());

describe('joining a live session',()=>{
 it('says it is watching, reaching every device of the owner the first time, then every 30 s',()=>{
  const g=make();g.start();
  expect(sent).toEqual([{op:{op:'join'},reachAll:true}]);
  vi.advanceTimersByTime(HEARTBEAT_MS);
  expect(sent.at(-1)).toEqual({op:{op:'join'},reachAll:false});
  g.stop();expect(sent.at(-1)?.op).toEqual({op:'leave'});expect(listener).toBeNull();
 });
 it('follows the owner\'s state, turns and answers, and only from the owner about this room',async()=>{
  const g=make();g.start();
  from({op:'state',title:'Fix login',agent:'claude',direct:false,viewers:['ana'],turns:[{id:'p:1',at:1,kind:'prompt',text:'Fix it'}]},'bo');
  expect(g.getSnapshot().status).toBe('connecting');
  from({op:'state',title:'Fix login',agent:'claude',direct:false,viewers:['ana'],turns:[{id:'p:1',at:1,kind:'prompt',text:'Fix it'}]},'sam','core','7c9e6679-7425-40de-944b-e07fc1f90ae7');
  expect(g.getSnapshot().status).toBe('connecting');
  from({op:'state',title:'Fix login',agent:'claude',direct:false,viewers:['ana','bo'],turns:[{id:'p:1',at:1,kind:'prompt',text:'Fix it'}]});
  expect(g.getSnapshot()).toMatchObject({status:'live',viewers:['ana','bo'],turns:[{id:'p:1'}]});
  from({op:'turn',turn:{id:'r:2',at:2,kind:'reply',text:'Fixed.'}});
  expect(g.getSnapshot().turns.map(t=>t.id)).toEqual(['p:1','r:2']);
  await g.say('Use the v2 API');
  const ask=sent.at(-1)!.op as Extract<LiveOp,{op:'say'}>;
  expect(ask).toMatchObject({op:'say',text:'Use the v2 API'});
  expect(g.getSnapshot().requests).toEqual([{id:ask.request,text:'Use the v2 API',state:'waiting'}]);
  from({op:'answer',request:ask.request,outcome:'sent',text:'Use the v2 API, please'});
  expect(g.getSnapshot().requests[0]).toMatchObject({state:'sent',sentAs:'Use the v2 API, please'});
  from({op:'bye',reason:'removed'});
  expect(g.getSnapshot().status).toBe('removed');
  await expect(g.say('again')).rejects.toThrow(/closed/);
  g.stop();expect(sent.at(-1)?.op).not.toEqual({op:'leave'});
 });
 it('says when the owner cannot be reached, or stopped answering',async()=>{
  devices=0;const a=make();a.start();await flush();
  expect(a.getSnapshot().status).toBe('unreachable');a.stop();
  devices=1;const b=make();b.start();
  from({op:'state',title:'T',agent:'a',direct:true,viewers:[]});
  now=QUIET_MS+1;b.check();expect(b.getSnapshot().status).toBe('quiet');
  from({op:'state',title:'T',agent:'a',direct:true,viewers:[]});expect(b.getSnapshot().status).toBe('live');
  b.stop();
 });
});
