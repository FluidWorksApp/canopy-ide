import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,readFile,readdir,rm,realpath,utimes,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spotIndexCommands,SPOT_INDEX_READ_ONLY,stripAnsi,tailStamp,parseQuery,underRoots,agePenalty,snippet,appendLineText} from './spot-index.mjs';

const line=v=>JSON.stringify(v)+'\n';
const UUID='0a1b2c3d-1111-2222-3333-444455556666';

async function fixture(){
 const base=await realpath(await mkdtemp(join(tmpdir(),'spot-index-')));
 const home=join(base,'home'),ws=join(base,'workspace'),app=join(ws,'app');
 await mkdir(app,{recursive:true});
 // claude: file named for the session, cwd on every entry; tool traffic and injected context skipped.
 const claudeDir=join(home,'.claude/projects/-workspace-app');await mkdir(claudeDir,{recursive:true});
 const claude=join(claudeDir,UUID+'.jsonl');
 await writeFile(claude,line({type:'user',cwd:app,message:{role:'user',content:'Please fix the flaky zebra parser'}})
  +line({type:'assistant',cwd:app,message:{content:[{type:'text',text:'The zebra parser drops quotes'},{type:'tool_use',name:'Bash'}]}})
  +line({type:'user',cwd:app,message:{content:'<system-reminder>zebra zebra zebra</system-reminder>'}})
  +line({type:'progress',cwd:app,message:{content:'zebra progress'}}));
 // codex: id and cwd from session_meta; only user/assistant response_item messages.
 const codexDir=join(home,'.codex/sessions/2026/10/27');await mkdir(codexDir,{recursive:true});
 await writeFile(join(codexDir,'rollout-2026-10-27T01-02-03-abc.jsonl'),line({type:'session_meta',payload:{session_id:'codex-1',cwd:join(base,'elsewhere')}})
  +line({type:'response_item',payload:{type:'message',role:'developer',content:[{type:'input_text',text:'zebra instructions'}]}})
  +line({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'tune the zebra cache in another project'}]}}));
 // gemini: bucket named by sha256 of the project root.
 const bucket=join(home,'.gemini/tmp',createHash('sha256').update(app).digest('hex'));await mkdir(join(bucket,'chats'),{recursive:true});
 await writeFile(join(bucket,'chats/session-1.json'),JSON.stringify({sessionId:'gem-1',messages:[{type:'user',content:'gemini asks about walrus'},{type:'info',content:'walrus info'}]}));
 // aider: in the repo.
 await writeFile(join(app,'.aider.chat.history.md'),'# aider chat started at 2026-10-01 10:00:00\n\n#### rename the walrus module\n> Aider v0.86\nDone renaming walrus.\n');
 // opencode: SQLite.
 const ocDir=join(home,'.local/share/opencode');await mkdir(ocDir,{recursive:true});
 const db=new DatabaseSync(join(ocDir,'opencode.db'));
 db.exec('CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_updated INTEGER); CREATE TABLE part (session_id TEXT, data TEXT, time_created INTEGER);');
 db.prepare('INSERT INTO session VALUES (?,?,?,?)').run('oc-1',app,'Oc',Date.now());
 db.prepare('INSERT INTO part VALUES (?,?,?)').run('oc-1',JSON.stringify({text:'opencode talks about narwhal'}),1);
 db.prepare('INSERT INTO part VALUES (?,?,?)').run('oc-1',JSON.stringify({type:'tool'}),2);
 db.close();
 // research and notes stores.
 const r=join(home,'.canopy/research/p1/0001-walrus');await mkdir(r,{recursive:true});
 await writeFile(join(home,'.canopy/research/p1/project.json'),JSON.stringify({id:'p1',roots:[app]}));
 await writeFile(join(r,'meta.json'),JSON.stringify({id:'0001-walrus',title:'Walrus survey',status:'researched',digest:'compare narwhal options',updated_at:100}));
 const n=join(home,'.canopy/notes/p1/0002-idea');await mkdir(n,{recursive:true});
 await writeFile(join(n,'meta.json'),JSON.stringify({id:'0002-idea',title:'Idea',status:'open',cwd:app}));await writeFile(join(n,'note.md'),'narwhal note body');
 const sessions=[{id:7,title:'build',kind:'terminal',exitCode:null,cwd:app}];
 const output={7:'\x1b[32m$\x1b[0m npm run build\r\nerror: platypus not found\r\n'};
 const ctx={home,root:ws,scoped:async(p,create=false)=>{const abs=p.startsWith('/')?p:join(ws,p);if(abs!==ws&&!abs.startsWith(ws+'/'))throw Error('Path outside selected workspace');return abs;},
  listSessions:async()=>sessions,sessionOutput:async(id,max)=>{assert.equal(max,256*1024);return output[id]??null;}};
 return {base,home,ws,app,claude,ctx,sessions,output,commands:spotIndexCommands(ctx)};
}

test('helpers mirror spot.rs', ()=>{
 assert.equal(stripAnsi('\x1b[31mred\x1b[0m line\r\x1b]0;title\x07tail'),'red line\ntail');
 assert.equal(tailStamp(Buffer.from('hello')),5946635); // (5<<20) ^ (fnv1a64("hello") & 0xfffff)
 assert.notEqual(tailStamp(Buffer.from('hello')),tailStamp(Buffer.from('hello world')));
 const a=Buffer.alloc(262144,97),b=Buffer.from(a);b[b.length-1]=122;assert.notEqual(tailStamp(a),tailStamp(b));
 assert.deepEqual(parseQuery('Spo  séa'),[['spo'],['sea']]);
 assert.deepEqual(parseQuery('  - "'),[]);
 assert.ok(underRoots('/w/app/src',['/w/app/']));assert.ok(!underRoots('/w/app-old',['/w/app']));assert.ok(underRoots('/x',[]));
 const now=1_800_000_000;assert.equal(agePenalty(0,now),0);assert.ok(agePenalty(now-86400,now)<agePenalty(now-30*86400,now));
 assert.equal(snippet('alpha beta',[['beta']]),'alpha beta');
 assert.match(snippet(Array.from({length:40},(_,i)=>'w'+i).join(' ')+' needle',[['needle']]),/^ … .*needle$/);
 assert.equal(appendLineText('claude',line({type:'user',message:{content:'  <ide_selection>x'}})),null);
 assert.equal(appendLineText('omp',line({type:'message',message:{role:'user',content:'hi'}})),'hi');
 assert.deepEqual(SPOT_INDEX_READ_ONLY,['spot_search','spot_index_stats']);
});

test('ingest reads every store, terminals, research and notes; search ranks and scopes', async()=>{
 const f=await fixture();
 try{
  const report=await f.commands.spot_ingest({agents:['claude','codex','gemini','aider','opencode'],terminals:true,roots:[f.app],retentionDays:0});
  assert.deepEqual(report,{more:false,pending:0,messages:7,terminals:1,research:1,notes:1,pruned:0});
  const hits=await f.commands.spot_search({query:'zebra',limit:10,roots:[f.app],allProjects:false});
  assert.equal(hits.length,1);
  assert.deepEqual(Object.keys(hits[0]),['kind','key','agent','cwd','title','snippet','meta','ts']);
  assert.equal(hits[0].kind,'transcript');assert.equal(hits[0].key,UUID);assert.equal(hits[0].agent,'claude');assert.equal(hits[0].cwd,f.app);assert.equal(hits[0].title,'');assert.equal(hits[0].meta,f.claude);
  assert.match(hits[0].snippet,/zebra parser/);
  // allProjects ignores roots; codex's session lives in another directory.
  const all=await f.commands.spot_search({query:'zebra',roots:[f.app],allProjects:true});
  assert.deepEqual(all.map(h=>h.key).sort(),[UUID,'codex-1'].sort());
  // prefix terms, ANDed.
  assert.equal((await f.commands.spot_search({query:'zeb pars',roots:[f.app]})).length,1);
  assert.equal((await f.commands.spot_search({query:'zebra walrus',roots:[f.app]})).length,0);
  const term=await f.commands.spot_search({query:'platypus',roots:[f.app]});
  assert.deepEqual(term.map(h=>[h.kind,h.key,h.agent,h.title,h.meta]),[['terminal','pty:7','terminal','build',f.app]]);
  assert.match(term[0].snippet,/error: platypus not found/);
  const walrus=await f.commands.spot_search({query:'walrus',roots:[f.app]});
  assert.deepEqual(walrus.map(h=>h.kind).sort(),['research','transcript','transcript']);
  assert.equal(walrus.find(h=>h.kind==='research').key,'p1/0001-walrus');
  assert.equal(walrus.find(h=>h.kind==='research').title,'Walrus survey · researched');
  const narwhal=await f.commands.spot_search({query:'narwhal'});
  assert.deepEqual(narwhal.map(h=>h.kind).sort(),['note','research','transcript']);
  assert.equal(narwhal.find(h=>h.kind==='transcript').key,'oc-1');
  assert.deepEqual(await f.commands.spot_search({query:'   '}),[]);
  assert.equal((await f.commands.spot_search({query:'walrus',limit:1})).length,1);
  const stats=await f.commands.spot_index_stats();
  assert.equal(stats.messages,7);assert.equal(stats.sessions,5);assert.equal(stats.terminals,1);assert.ok(stats.bytes>0);
  assert.deepEqual(stats.by_agent,[['aider',2],['claude',2],['codex',1],['gemini',1],['opencode',1]]);
  await assert.rejects(f.commands.spot_search({query:1}),/Invalid query/);
 }finally{await rm(f.base,{recursive:true,force:true});}
});

test('bm25 prefers denser matches; one row per container with its best score', async()=>{
 const f=await fixture();
 try{
  const dir=join(f.home,'.claude/projects/x');await mkdir(dir,{recursive:true});
  await writeFile(join(dir,'s-dense.jsonl'),line({type:'user',cwd:f.app,message:{content:'quokka quokka quokka'}}));
  await writeFile(join(dir,'s-sparse.jsonl'),line({type:'user',cwd:f.app,message:{content:'quokka in a very long sentence with many other words around it today'}})+line({type:'user',cwd:f.app,message:{content:'second quokka mention padded with even more words to dilute'}}));
  await f.commands.spot_ingest({agents:['claude'],terminals:false,roots:[]});
  const hits=await f.commands.spot_search({query:'quokka'});
  assert.deepEqual(hits.map(h=>h.key),['s-dense','s-sparse']);
 }finally{await rm(f.base,{recursive:true,force:true});}
});

test('ingest is incremental, pages through a large backlog and prunes what went away', async()=>{
 const f=await fixture();
 try{
  const big=join(f.home,'.claude/projects/big');await mkdir(big,{recursive:true});
  const file=join(big,'big-session.jsonl');
  const row=line({type:'user',cwd:f.app,message:{content:'filler '.repeat(140)+'echidna'}});
  await writeFile(file,row.repeat(Math.ceil(5*1024*1024/row.length)));
  const first=await f.commands.spot_ingest({agents:['claude'],terminals:false,roots:[]});
  assert.equal(first.more,true);assert.ok(first.pending>0&&first.pending<1024*1024+row.length*2,String(first.pending));
  const second=await f.commands.spot_ingest({agents:['claude'],terminals:false,roots:[]});
  assert.equal(second.more,false);assert.equal(second.pending,0);
  const total=Math.ceil(5*1024*1024/row.length)+2;
  assert.equal(first.messages+second.messages,total);
  // Nothing new: nothing read.
  assert.equal((await f.commands.spot_ingest({agents:['claude'],terminals:false,roots:[]})).messages,0);
  // A half-written line waits for its newline.
  await appendFile(f.claude,JSON.stringify({type:'user',cwd:f.app,message:{content:'dingo arrives'}}));
  assert.equal((await f.commands.spot_ingest({agents:['claude'],terminals:false,roots:[]})).messages,0);
  await appendFile(f.claude,'\n');
  assert.equal((await f.commands.spot_ingest({agents:['claude'],terminals:false,roots:[]})).messages,1);
  assert.equal((await f.commands.spot_search({query:'dingo'})).length,1);
  // A rewritten (shrunk) file is read again from zero.
  await writeFile(f.claude,line({type:'user',cwd:f.app,message:{content:'only wombat now'}}));
  const rewritten=await f.commands.spot_ingest({agents:['claude'],terminals:false,roots:[]});
  assert.equal(rewritten.messages,1);
  assert.equal((await f.commands.spot_search({query:'dingo'})).length,0);
  assert.equal((await f.commands.spot_search({query:'wombat'})).length,1);
  // A vanished file takes its rows; a disabled agent is purged.
  await rm(file);
  const gone=await f.commands.spot_ingest({agents:['claude'],terminals:false,roots:[]});
  assert.equal(gone.pruned,total-2); // the big file's rows; the rewrite above is not a prune
  assert.equal((await f.commands.spot_index_stats()).messages,1);
  assert.equal((await f.commands.spot_ingest({agents:[],terminals:false,roots:[]})).pruned,1);
  assert.equal((await f.commands.spot_index_stats()).messages,0);
 }finally{await rm(f.base,{recursive:true,force:true});}
});

test('terminal rows mirror live sessions, retention drops old transcript rows', async()=>{
 const f=await fixture();
 try{
  assert.equal((await f.commands.spot_ingest({agents:[],roots:[]})).terminals,1);
  assert.equal((await f.commands.spot_ingest({agents:[],roots:[]})).terminals,0); // unchanged tail
  f.output[7]+='koala\n';
  assert.equal((await f.commands.spot_ingest({agents:[],roots:[]})).terminals,1);
  assert.equal((await f.commands.spot_search({query:'koala'}))[0].key,'pty:7');
  f.sessions.length=0;
  const r=await f.commands.spot_ingest({agents:[],roots:[]});
  assert.equal(r.pruned,1);assert.equal((await f.commands.spot_index_stats()).terminals,0);
  // terminals:false purges them too.
  f.sessions.push({id:9,title:'t',pid:process.pid});f.output[9]='lemur';
  await f.commands.spot_ingest({agents:[],roots:[]});
  const hit=(await f.commands.spot_search({query:'lemur'}))[0];assert.equal(hit.cwd,process.cwd()); // cwd from /proc/<pid>/cwd
  assert.equal((await f.commands.spot_ingest({agents:[],terminals:false,roots:[]})).pruned,1);
  // retention: transcript ts is the file mtime for append stores.
  const old=Date.now()/1000-40*86400;await utimes(f.claude,old,old);
  await f.commands.spot_ingest({agents:['claude'],terminals:false,roots:[]});
  assert.equal((await f.commands.spot_index_stats()).messages,2);
  const kept=await f.commands.spot_ingest({agents:['claude'],terminals:false,roots:[],retentionDays:30});
  assert.equal(kept.pruned,2);assert.equal((await f.commands.spot_index_stats()).messages,0);
 }finally{await rm(f.base,{recursive:true,force:true});}
});

test('index persists across processes, repairs a torn shard, and clears', async()=>{
 const f=await fixture();
 try{
  await f.commands.spot_ingest({agents:['claude','gemini'],terminals:false,roots:[f.app]});
  const fresh=(await import('./spot-index.mjs?reload='+Date.now())).spotIndexCommands(f.ctx);
  assert.equal((await fresh.spot_search({query:'zebra'})).length,1);
  assert.equal((await fresh.spot_ingest({agents:['claude','gemini'],terminals:false,roots:[f.app]})).messages,0);
  // A shard with a tail the bookmark never recorded (a crash between the two writes) is cut back.
  const docs=join(f.home,'.canopy/spot/docs');const shard=(await readdir(docs)).find(n=>n.startsWith('t-')&&!n.includes('.next'));
  for(const name of await readdir(docs)){const raw=await readFile(join(docs,name),'utf8');if(raw.includes('zebra')){await appendFile(join(docs,name),JSON.stringify(['transcript','ghost','claude',f.app,'','ghost capybara',f.claude,1])+'\n');}}
  assert.ok(shard);
  const again=(await import('./spot-index.mjs?reload2='+Date.now())).spotIndexCommands(f.ctx);
  assert.equal((await again.spot_search({query:'capybara'})).length,0);
  assert.equal((await again.spot_index_stats()).messages,3);
  assert.equal(await again.spot_index_clear(),null);
  assert.deepEqual(await again.spot_index_stats(),{messages:0,sessions:0,terminals:0,bytes:0,by_agent:[]});
  assert.deepEqual(await again.spot_search({query:'zebra'}),[]);
  assert.equal((await again.spot_ingest({agents:['claude'],terminals:false,roots:[]})).messages,2);
 }finally{await rm(f.base,{recursive:true,force:true});}
});

test('spot_save_context_text writes <dir>/.canopy/spot/brief-<secs>.md without overwriting', async()=>{
 const f=await fixture();
 try{
  const a=await f.commands.spot_save_context_text({dir:f.app,text:'long brief one'});
  assert.match(a,new RegExp('^'+f.app+'/\\.canopy/spot/brief-\\d+\\.md$'));
  assert.equal(await readFile(a,'utf8'),'long brief one');
  const stamp=a.match(/brief-(\d+)\.md$/)[1];
  // Same second: the next free suffix.
  await writeFile(join(f.app,'.canopy/spot',`brief-${Number(stamp)+1}.md`),'x');await writeFile(join(f.app,'.canopy/spot',`brief-${Number(stamp)+2}.md`),'x');
  const b=await f.commands.spot_save_context_text({dir:f.app,text:'two'});
  assert.notEqual(a,b);assert.match(b,/brief-\d+(-\d+)?\.md$/);assert.equal(await readFile(b,'utf8'),'two');
  await assert.rejects(f.commands.spot_save_context_text({dir:f.home,text:'x'}),/outside/);
  await assert.rejects(f.commands.spot_save_context_text({dir:f.app,text:5}),/Invalid text/);
  // A .canopy that points out of the workspace is refused before anything is written there.
  const other=join(f.ws,'other');await mkdir(other);await symlink(f.home,join(other,'.canopy'));
  const strict={...f.ctx,scoped:async(p,create)=>{const real=await realpath(p).catch(e=>{if(create&&e.code==='ENOENT')return p;throw e;});return f.ctx.scoped(real,create);}};
  await assert.rejects(spotIndexCommands(strict).spot_save_context_text({dir:other,text:'x'}),/outside/);
 }finally{await rm(f.base,{recursive:true,force:true});}
});
