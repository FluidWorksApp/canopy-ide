import {expect,it,vi} from 'vitest';
import {APPLY_DEADLINE_MS,POLL_FAILURES_TOLERATED,runMirror,type MirrorProgress} from './mirror';

type Status={state:string;phase:string;steps:{name:string;state:string;detail?:string}[];notes:string[];installs:never[];error:string|null};
const done:Status={state:'complete',phase:'complete',steps:[{name:'checkout',state:'done',detail:'On main'}],notes:[],installs:[],error:null};
const SKIPPED=['1 stash entries stayed on this Mac'];

function harness(opts:{poll?:(call:number)=>Status|Error;start?:Error;remoteStore?:string;sent?:Partial<{skipped:string[];artifacts:Record<string,number>}>}={}){
 const calls:{command:string;args?:Record<string,unknown>}[]=[];
 let remoteStore=opts.remoteStore??'{"projects":[],"openIds":[]}',polls=0;
 const row={projectId:'p1',projectName:'Shop',componentId:'c1',label:'web',path:'/w/shop',repo:'/w/shop',relative:'',origin:'https://github.com/o/shop.git',head:'a'.repeat(40),branch:'main',unpushed:0,staged:1,unstaged:0,untracked:0,stashes:1,envFiles:[]};
 const local=async(command:string,args?:Record<string,unknown>):Promise<any>=>{
  calls.push({command,args});
  switch(command){
   case 'execution_mirror_inspect':return [row];
   case 'store_load':return JSON.stringify({projects:[{id:'p1',name:'Shop',components:[{id:'c1',label:'web',path:'/w/shop'}]}]});
   case 'execution_remote_import_accounts':return {imported:['Claude']};
   case 'execution_remote_import_git':return {};
   case 'execution_mirror_send':return {head:'a'.repeat(40),branch:'main',upstream:'origin/main',relative:'',sent:{commits:false,staged:true,unstaged:false,files:0,envFiles:0,skipped:opts.sent?.skipped??SKIPPED,artifacts:opts.sent?.artifacts??{'staged.patch':3}}};
  }
  throw Error('unexpected local '+command);
 };
 const remote=async(command:string,args?:Record<string,unknown>):Promise<any>=>{
  calls.push({command,args});
  switch(command){
   case 'fs_create_dir':case 'fs_stat':case 'mirror_apply_discard':return {};
   case 'git_clone_start':return {id:'c',state:'complete',path:'/workspace/x/repo-1/shop'};
   case 'store_load':return remoteStore;
   case 'store_save':remoteStore=String(args!.data);return {};
   case 'mirror_apply_start':if(opts.start)throw opts.start;return {};
   case 'mirror_apply_status':{
    if(args?.id==='00000000-0000-0000-0000-000000000000')return done;
    const result=(opts.poll??(()=>done))(++polls);if(result instanceof Error)throw result;return result;
   }
  }
  throw Error('unexpected remote '+command);
 };
 return {calls,local,remote,store:()=>JSON.parse(remoteStore) as {projects:{mirroredFrom?:string;mirrorIncomplete?:boolean}[]}};
}
const run=(h:ReturnType<typeof harness>,extra={})=>{let last!:MirrorProgress;return runMirror({local:h.local,remote:h.remote,sleep:async()=>{},newId:()=>'11111111-1111-1111-1111-111111111111',...extra},{includeEnv:false,install:false},p=>{last=p;}).then(()=>last);};

it('reports what stayed on the Mac as a note, not a failure, and sends the artifact sizes',async()=>{
 const h=harness();const result=await run(h);
 const repo=result.projects[0].repos[0];
 expect(repo.state).toBe('done');expect(repo.problems).toEqual([]);expect(repo.notes).toEqual(SKIPPED);
 expect(result.projects[0].state).toBe('done');
 expect(h.calls.find(c=>c.command==='mirror_apply_start')!.args).toMatchObject({expect:{'staged.patch':3}});
});

it('rides out a few failed polls',async()=>{
 const h=harness({poll:n=>n<=POLL_FAILURES_TOLERATED?Error('fetch failed'):done});
 expect((await run(h)).projects[0].state).toBe('done');
});

it('gives up after too many failed polls in a row',async()=>{
 const h=harness({poll:()=>Error('fetch failed')});
 const result=await run(h);
 expect(result.projects[0].repos[0].state).toBe('failed');expect(result.projects[0].repos[0].detail).toMatch(/fetch failed/);
});

it('stops waiting at the deadline',async()=>{
 let t=0;const h=harness({poll:()=>({...done,state:'running',phase:'dependencies'})});
 const result=await run(h,{now:()=>(t+=APPLY_DEADLINE_MS/4)});
 expect(result.projects[0].repos[0].detail).toMatch(/taking too long/);
});

it('stops when the workspace no longer knows the job',async()=>{
 const poll=vi.fn(()=>Error('Setup job not found'));const h=harness({poll});
 await run(h);expect(poll).toHaveBeenCalledTimes(1);
});

it('removes the staged files when the setup cannot start',async()=>{
 const h=harness({start:Error('Setup artifact staged.patch is missing or incomplete; retry setup')});
 const result=await run(h);
 expect(result.projects[0].repos[0].state).toBe('failed');
 expect(h.calls.find(c=>c.command==='mirror_apply_discard')!.args).toEqual({id:'11111111-1111-1111-1111-111111111111'});
});

it('leaves a started job to clean up after itself',async()=>{
 const h=harness({poll:()=>({...done,state:'failed',error:'Local commits could not be added'})});
 await run(h);
 expect(h.calls.some(c=>c.command==='mirror_apply_discard')).toBe(false);
});

it('retries a project whose last attempt failed instead of calling it already set up',async()=>{
 const first=harness({poll:()=>({...done,state:'failed',error:'boom'})});
 await run(first);
 const saved=first.store().projects;
 expect(saved).toHaveLength(0);// nothing mirrored: no entry to resume
 const partial=harness({poll:()=>({...done,steps:[{name:'unstaged',state:'failed',detail:'did not apply'}]})});
 const result=await run(partial);
 expect(result.projects[0].state).toBe('failed');
 const stored=partial.store().projects;
 expect(stored).toHaveLength(1);expect(stored[0]).toMatchObject({mirroredFrom:'p1',mirrorIncomplete:true});

 const retry=harness({remoteStore:JSON.stringify({projects:stored,openIds:[]})});
 const again=await run(retry);
 expect(again.projects[0].state).toBe('done');
 const after=retry.store().projects;
 expect(after).toHaveLength(1);expect(after[0].mirrorIncomplete).toBeUndefined();
});

it('skips a project that was set up completely',async()=>{
 const h=harness({remoteStore:JSON.stringify({projects:[{id:'x',name:'Shop',mirroredFrom:'p1',components:[]}],openIds:[]})});
 const result=await run(h);
 expect(result.projects[0].state).toBe('skipped');expect(h.calls.some(c=>c.command==='execution_mirror_send')).toBe(false);
});
