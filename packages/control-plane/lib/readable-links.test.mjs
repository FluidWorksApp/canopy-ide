import test from 'node:test';import assert from 'node:assert/strict';
import {slugify,wordSlug,sessionSlug,workspaceSlug,handleCandidate,pathKind,parseReadableUrl,readableUrl,maySeeSession,readableLinkAction,RESERVED_HANDLES} from './readable-links.mjs';
const origin='https://canopyide.dev';
const user={id:'alice',name:'Alice Example',email:'alice@example.invalid'};
const team='22222222-2222-4222-8222-222222222222',message='33333333-3333-4333-8333-333333333333';
function dbWith(responder){const calls=[];return {calls,query:async(sql,args)=>{calls.push({sql,args});return {rows:responder(sql,args,calls)??[]};}};}
const inserts=db=>db.calls.filter(q=>q.sql.startsWith('INSERT'));

test('slugs are lowercase ascii words cut on a word boundary',()=>{
 assert.equal(slugify('  Fix the Login Bug!! '),'fix-the-login-bug');
 assert.equal(slugify('Café Ünïcode — Team'),'cafe-unicode-team');
 assert.equal(slugify('alpha beta gamma delta',16),'alpha-beta-gamma');
 assert.equal(slugify('supercalifragilistic',8),'supercal');
 assert.equal(slugify('!!!'),'');
});
test('word slugs are deterministic per seed and attempt, and memorable',()=>{
 assert.equal(wordSlug('message:x',0),wordSlug('message:x',0));
 assert.notEqual(wordSlug('message:x',0),wordSlug('message:x',1));
 assert.match(wordSlug('anything'),/^[a-z]{3,8}-[a-z]{3,8}-[1-9][0-9]$/);
});
test('session slugs use the task name with a short suffix, else words',()=>{
 assert.match(sessionSlug('Fix login bug','k',0),/^fix-login-bug-[1-9][0-9]$/);
 assert.match(sessionSlug('','k',0),/^[a-z]+-[a-z]+-[1-9][0-9]$/);
 assert.match(sessionSlug('Fix login bug','k',12),/^[a-z]+-[a-z]+-[1-9][0-9]$/);
});
test('workspace and team handles avoid reserved and structural names',()=>{
 assert.equal(workspaceSlug('API Server'),'api-server');assert.equal(workspaceSlug('API Server',1),'api-server-2');
 assert.equal(workspaceSlug('S'),'s-workspace');assert.equal(workspaceSlug('T'),'t-workspace');assert.equal(workspaceSlug('★'),'workspace');
 assert.equal(handleCandidate('Platform Eng'),'platform-eng');assert.equal(handleCandidate('Support'),'support-team');assert.equal(handleCandidate('Teams'),'teams-team');assert.equal(handleCandidate('Platform Eng',2),'platform-eng-3');
 for(const route of ['api','teams','workspaces','personal-teams','support','downloads','sign-in','s','t'])assert.ok(RESERVED_HANDLES.includes(route),route);
});
test('path shapes decide the kind',()=>{
 assert.equal(pathKind('api'),'workspace');
 assert.equal(pathKind('api/s/fix-login-27'),'session');
 assert.equal(pathKind('t/general/quiet-otter-41'),'message');assert.equal(pathKind('t/dm/quiet-otter-41'),'message');
 for(const bad of ['','s','t','t/random/x','api/x/y','api/s','API','a//b','-a','a-','api/s/x/y','t/s/x'])assert.equal(pathKind(bad),null,bad);
});
test('readable URLs parse from the canonical form and a team subdomain only',()=>{
 assert.deepEqual(parseReadableUrl('https://canopyide.dev/acme/api',origin),{namespace:'acme',path:'api',kind:'workspace'});
 assert.deepEqual(parseReadableUrl(' https://canopyide.dev/Acme/API/s/fix-login-27/ ',origin),{namespace:'acme',path:'api/s/fix-login-27',kind:'session'});
 assert.deepEqual(parseReadableUrl('https://acme.canopyide.dev/t/general/quiet-otter-41',origin),{namespace:'acme',path:'t/general/quiet-otter-41',kind:'message'});
 assert.equal(parseReadableUrl(readableUrl('acme','t/dm/quiet-otter-41',origin),origin).kind,'message');
 for(const bad of ['http://canopyide.dev/acme/api','https://evil.dev/acme/api','https://canopyide.dev.evil.dev/acme/api','https://canopyide.dev/teams/api','https://canopyide.dev/api/teams','https://ws-1.workspaces.canopyide.dev/x','https://canopyide.dev:8443/acme/api','https://u:p@canopyide.dev/acme/api','https://canopyide.dev/acme','not a url'])assert.equal(parseReadableUrl(bad,origin),null,bad);
});
test('session visibility stays on the grant that shared sessions',()=>{
 assert.equal(maySeeSession([{role:'owner',permissions:{projects:'all'}}],'app'),true);
 assert.equal(maySeeSession([{role:'member',permissions:{projects:'all',sessions:'private'}}],'app'),false);
 assert.equal(maySeeSession([{role:'member',permissions:{projects:'all'}},{role:'viewer',permissions:{projects:'selected',projectIds:['docs'],sessions:'view'}}],'app'),false);
 assert.equal(maySeeSession([{role:'viewer',permissions:{projects:'selected',projectIds:['app'],sessions:'view'}}],'app'),true);
});

// Workspace owned by the caller, personal (no organization).
const ownWorkspace=(sql)=>sql.startsWith('SELECT owner_id,organization_id FROM workspace')?[{owner_id:'alice',organization_id:null}]:sql.startsWith('SELECT id,name,owner_id,organization_id FROM workspace')?[{id:'ws-1',name:'API Server',owner_id:'alice',organization_id:null}]:null;
test('people without access cannot mint a workspace link, and learn nothing',async()=>{
 const db=dbWith(sql=>sql.startsWith('SELECT owner_id,organization_id FROM workspace')?[{owner_id:'bob',organization_id:null}]:[]);
 await assert.rejects(()=>readableLinkAction(db,user,{action:'ensure',kind:'workspace',workspaceId:'ws-1',origin}),e=>e.code===404);
 assert.equal(inserts(db).length,0);
});
test('copying a link twice returns the same URL without writing',async()=>{
 const db=dbWith(sql=>ownWorkspace(sql)??(sql.includes('WHERE target_key=$1')?[{namespace:'acme',path:'api-server'}]:[]));
 assert.deepEqual(await readableLinkAction(db,user,{action:'ensure',kind:'workspace',workspaceId:'ws-1',origin}),{link:{url:'https://canopyide.dev/acme/api-server',kind:'workspace',created:false}});
 assert.equal(inserts(db).length,0);
});
test('a first workspace link names the person, then retries a taken path',async()=>{
 const db=dbWith((sql,args)=>{
  const own=ownWorkspace(sql);if(own)return own;
  if(sql.startsWith('INSERT INTO link_namespace'))return [{handle:args[0]}];
  if(sql.startsWith('INSERT INTO readable_link'))return args[1]==='api-server'?[]:[{namespace:args[0],path:args[1]}];
  return [];
 });
 const {link}=await readableLinkAction(db,user,{action:'ensure',kind:'workspace',workspaceId:'ws-1',origin});
 assert.deepEqual(link,{url:'https://canopyide.dev/alice-example/api-server-2',kind:'workspace',created:true});
 const insert=inserts(db).find(q=>q.sql.startsWith('INSERT INTO readable_link'));assert.deepEqual(insert.args.slice(2,8),['workspace',{workspaceId:'ws-1'},'workspace:ws-1','ws-1',null,'alice']);
 assert.ok(db.calls.some(q=>q.sql.includes('FOR UPDATE')&&q.args[0]==='alice-example'));
});
test('message links need team membership and hold ids, never message text',async()=>{
 const outsider=dbWith(()=>[]);
 await assert.rejects(()=>readableLinkAction(outsider,user,{action:'ensure',kind:'message',teamId:team,peer:null,messageId:message,text:'secret',origin}),e=>e.code===404);
 const db=dbWith((sql,args)=>sql.includes('FROM active_team_member m JOIN team t')?[{role:'member',name:'Platform',organization_id:null}]:sql.startsWith('INSERT INTO link_namespace')?[{handle:args[0]}]:sql.startsWith('INSERT INTO readable_link')?[{namespace:args[0],path:args[1]}]:[]);
 const {link}=await readableLinkAction(db,user,{action:'ensure',kind:'message',teamId:team,peer:'bob',messageId:message,text:'secret',origin});
 assert.match(link.url,/^https:\/\/canopyide\.dev\/platform\/t\/dm\/[a-z]+-[a-z]+-[1-9][0-9]$/);
 const insert=inserts(db).find(q=>q.sql.startsWith('INSERT INTO readable_link'));
 assert.deepEqual(insert.args[3],{teamId:team,messageId:message,participants:['alice','bob']});
 assert.equal(JSON.stringify(db.calls).includes('secret'),false);
});
const linkRow=(over={})=>({id:'l1',namespace:'platform',path:'t/dm/quiet-otter-41',kind:'message',target:{teamId:team,messageId:message,participants:['bob','carol']},created_by:'bob',revoked_at:null,...over});
test('a direct-message link resolves only for its two participants',async()=>{
 const db=dbWith(sql=>sql.includes('FROM readable_link l JOIN link_namespace')?[linkRow()]:sql.includes('FROM active_team_member m JOIN team t')?[{role:'member',name:'Platform'}]:[]);
 await assert.rejects(()=>readableLinkAction(db,user,{action:'resolve',url:'https://canopyide.dev/platform/t/dm/quiet-otter-41',origin}),e=>e.code===404);
 const bob={id:'bob',name:'Bob'};
 const ok=dbWith(sql=>sql.includes('FROM readable_link l JOIN link_namespace')?[linkRow()]:sql.includes('FROM active_team_member m JOIN team t')?[{role:'member',name:'Platform'}]:sql.startsWith('SELECT name FROM "user"')?[{name:'Carol'}]:[]);
 assert.deepEqual((await readableLinkAction(ok,bob,{action:'resolve',url:'https://canopyide.dev/platform/t/dm/quiet-otter-41',origin})).link.target,{teamId:team,teamName:'Platform',peer:'carol',peerName:'Carol',messageId:message,viewer:'bob'});
});
test('revoked links say so only to people who could open them',async()=>{
 const row=linkRow({target:{teamId:team,messageId:message,participants:null},revoked_at:new Date()});
 const member=dbWith(sql=>sql.includes('FROM readable_link l JOIN link_namespace')?[row]:sql.includes('FROM active_team_member m JOIN team t')?[{role:'member',name:'Platform'}]:[]);
 await assert.rejects(()=>readableLinkAction(member,user,{action:'resolve',url:'https://canopyide.dev/platform/t/dm/quiet-otter-41',origin}),e=>e.code===410);
 const outsider=dbWith(sql=>sql.includes('FROM readable_link l JOIN link_namespace')?[row]:[]);
 await assert.rejects(()=>readableLinkAction(outsider,user,{action:'resolve',url:'https://canopyide.dev/platform/t/dm/quiet-otter-41',origin}),e=>e.code===404);
});
test('only the creator, workspace owner or a team admin can revoke',async()=>{
 const row=linkRow({target:{teamId:team,messageId:message,participants:null}});
 const db=role=>dbWith(sql=>sql.includes('FROM readable_link l JOIN link_namespace')?[row]:sql.includes('FROM active_team_member m JOIN team t')?[{role,name:'Platform'}]:[]);
 const member=db('member');await assert.rejects(()=>readableLinkAction(member,user,{action:'revoke',url:'https://canopyide.dev/platform/t/dm/quiet-otter-41',origin}),e=>e.code===403);
 assert.equal(member.calls.some(q=>q.sql.startsWith('UPDATE')),false);
 const admin=db('admin');assert.deepEqual(await readableLinkAction(admin,user,{action:'revoke',url:'https://canopyide.dev/platform/t/dm/quiet-otter-41',origin}),{revoked:true});
 assert.ok(admin.calls.some(q=>q.sql.startsWith('UPDATE readable_link SET revoked_at')));
});
test('a session link needs session sharing, not just workspace access',async()=>{
 const db=dbWith(sql=>sql.startsWith('SELECT owner_id,organization_id FROM workspace')?[{owner_id:'bob',organization_id:null}]:sql.includes('FROM workspace_member')?[{role:'member',permissions:{projects:'all',sessions:'private'}}]:sql.startsWith('SELECT id,name,owner_id')?[{id:'ws-1',name:'API',owner_id:'bob',organization_id:null}]:[]);
 await assert.rejects(()=>readableLinkAction(db,user,{action:'ensure',kind:'session',workspaceId:'ws-1',projectId:'app',publicationId:'pub-1',title:'Fix login',origin}),e=>e.code===404);
 assert.equal(inserts(db).length,0);
});
test('a session link sits under its workspace link',async()=>{
 const db=dbWith((sql,args)=>{
  const own=ownWorkspace(sql);if(own)return own;
  if(sql.includes('WHERE target_key=$1'))return args[0]==='workspace:ws-1'?[{namespace:'alice',path:'api-server'}]:[];
  if(sql.startsWith('INSERT INTO readable_link'))return [{namespace:args[0],path:args[1]}];
  return [];
 });
 const {link}=await readableLinkAction(db,user,{action:'ensure',kind:'session',workspaceId:'ws-1',projectId:'app',publicationId:'pub-1',title:'Fix login bug',origin});
 assert.match(link.url,/^https:\/\/canopyide\.dev\/alice\/api-server\/s\/fix-login-bug-[1-9][0-9]$/);
});
test('unknown actions and kinds are refused',async()=>{
 await assert.rejects(()=>readableLinkAction(dbWith(()=>[]),user,{action:'list',origin}),e=>e.code===400);
 await assert.rejects(()=>readableLinkAction(dbWith(()=>[]),user,{action:'ensure',kind:'file',origin}),e=>e.code===400);
});
test('a team admin can revoke a workspace link in the team namespace',async()=>{
 const row={id:'l2',namespace:'platform',path:'api',kind:'workspace',target:{workspaceId:'ws-1'},created_by:'bob',revoked_at:null,namespace_team:team};
 const db=role=>dbWith(sql=>sql.includes('FROM readable_link l JOIN link_namespace')?[row]:sql.startsWith('SELECT owner_id,organization_id FROM workspace')?[{owner_id:'carol',organization_id:null}]:sql.includes('FROM workspace_member')?[{role:'viewer',permissions:{projects:'all'}}]:sql.startsWith('SELECT name,owner_id FROM workspace')?[{name:'API',owner_id:'carol'}]:sql.includes('FROM active_team_member m JOIN team t')?[{role,name:'Platform'}]:[]);
 await assert.rejects(()=>readableLinkAction(db('member'),user,{action:'revoke',url:'https://canopyide.dev/platform/api',origin}),e=>e.code===403);
 assert.deepEqual(await readableLinkAction(db('admin'),user,{action:'revoke',url:'https://canopyide.dev/platform/api',origin}),{revoked:true});
});
