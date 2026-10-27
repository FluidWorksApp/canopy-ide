import test from 'node:test';import assert from 'node:assert/strict';
import {linksApi,readableRequestDecision,readableLinkPage,appLink,linkSummary} from './readable-link-route.mjs';
const origin='https://canopyide.dev';
const team='22222222-2222-4222-8222-222222222222',message='33333333-3333-4333-8333-333333333333';
const dbWith=responder=>({query:async(sql,args)=>({rows:responder(sql,args)??[]})});
const row={id:'l1',namespace:'platform',path:'t/general/quiet-otter-41',kind:'message',target:{teamId:team,messageId:message,participants:null},created_by:'bob',revoked_at:null};
const memberDb=dbWith(sql=>sql.includes('FROM readable_link l JOIN link_namespace')?[row]:sql.includes('FROM active_team_member m JOIN team t')?[{role:'member',name:'Platform <b>'}]:[]);
test('signed-out visitors are sent to sign in and back',async()=>{
 assert.deepEqual(await readableRequestDecision(memberDb,null,'https://canopyide.dev/platform/t/general/quiet-otter-41',{origin}),{status:302,location:'/sign-in?next=%2Fplatform%2Ft%2Fgeneral%2Fquiet-otter-41'});
});
test('members get an app deep link; others and non-links get 404',async()=>{
 const ok=await readableRequestDecision(memberDb,{id:'alice'},'https://canopyide.dev/platform/t/general/quiet-otter-41',{origin});
 assert.equal(ok.status,200);assert.equal(ok.openInApp,appLink('https://canopyide.dev/platform/t/general/quiet-otter-41'));
 assert.equal(ok.openInApp,'canopy://link?url=https%3A%2F%2Fcanopyide.dev%2Fplatform%2Ft%2Fgeneral%2Fquiet-otter-41');
 assert.deepEqual(await readableRequestDecision(dbWith(sql=>sql.includes('FROM readable_link l')?[row]:[]),{id:'eve'},'https://canopyide.dev/platform/t/general/quiet-otter-41',{origin}),{status:404});
 assert.deepEqual(await readableRequestDecision(memberDb,{id:'alice'},'https://canopyide.dev/teams',{origin}),{status:404});
});
test('the links API refuses anonymous callers and cross-site mutation',async()=>{
 await assert.rejects(()=>linksApi(memberDb,null,{action:'resolve'},{origin}),e=>e.code===401);
 await assert.rejects(()=>linksApi(memberDb,{id:'alice'},{action:'ensure',kind:'workspace',workspaceId:'ws-1'},{origin}),e=>e.code===403);
 await assert.rejects(()=>linksApi(memberDb,{id:'alice'},[],{origin}),e=>e.code===400);
 assert.equal((await linksApi(memberDb,{id:'alice'},{action:'resolve',url:'https://canopyide.dev/platform/t/general/quiet-otter-41'},{origin})).link.kind,'message');
});
test('the fallback page escapes names and reveals nothing on errors',async()=>{
 const ok=await readableRequestDecision(memberDb,{id:'alice'},'https://canopyide.dev/platform/t/general/quiet-otter-41',{origin});
 const page=readableLinkPage(ok);assert.match(page,/Platform &lt;b&gt;/);assert.doesNotMatch(page,/<b>/);assert.doesNotMatch(page,/<script/i);
 assert.doesNotMatch(readableLinkPage({status:404}),/Platform/);assert.match(readableLinkPage({status:410}),/revoked/);
});
test('the page tells someone with access what the link is, then offers the app and a download',()=>{
 const link={url:'https://canopyide.dev/platform/api/s/fix-login-27',kind:'session',target:{workspaceId:'ws-1',workspaceName:'API',projectId:'app',publicationId:'p',title:'Fix login'},about:{teamName:'Platform',activity:'opened',activityAt:'2026-10-20T12:00:00.000Z'}};
 assert.deepEqual(linkSummary(link),{label:'Shared agent session',name:'Fix login',rows:[['Workspace','API'],['Team','Platform'],['Last opened','20 Oct 2026']]});
 const page=readableLinkPage({status:200,link,openInApp:appLink(link.url)});
 for(const text of ['Fix login','<dt>Team</dt><dd>Platform</dd>','<dt>Last opened</dt><dd>20 Oct 2026</dd>','href="canopy://link?url=','Download Canopy','href="https://canopyide.dev/downloads"'])assert.ok(page.includes(text),text);
 assert.doesNotMatch(page,/<script/i);
 const dm=linkSummary({kind:'message',target:{teamId:team,teamName:'Platform',peer:'carol',peerName:'Carol',messageId:message},about:{teamName:'Platform',activity:'shared',activityAt:'2026-10-02T00:00:00.000Z'}});
 assert.deepEqual(dm,{label:'Team message',name:'Direct message with Carol',rows:[['Team','Platform'],['Shared','2 Oct 2026']]});
 assert.equal(linkSummary({kind:'workspace',target:{name:'API'},about:{teamName:null,activity:'shared',activityAt:null}}).rows.length,0);
});
