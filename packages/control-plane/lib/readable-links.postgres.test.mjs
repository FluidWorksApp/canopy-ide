import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';import {createRequire} from 'node:module';
import {readableLinkAction} from './readable-links.mjs';
const connectionString=process.env.CANOPY_SYNTHETIC_DATABASE_URL;const origin='https://canopyide.dev';
test('real Postgres readable links: allocation, team access, revocation and no reuse',{skip:!connectionString},async()=>{
 assert.equal(new URL(connectionString).hostname,'127.0.0.1');assert.equal(new URL(connectionString).port,'55461');assert.equal(new URL(connectionString).username,'canopy_validation');
 const require=createRequire(process.env.CANOPY_SYNTHETIC_PG_PACKAGE_JSON??new URL('../../../package.json',import.meta.url));const {Pool}=require('pg');const pool=new Pool({connectionString});const db=await pool.connect();
 try{await db.query('BEGIN');await db.query(await readFile(new URL('../readable-link-schema.sql',import.meta.url),'utf8'));
 const owner=randomUUID(),member=randomUUID(),outsider=randomUUID(),org=randomUUID(),team=randomUUID(),workspace='ws-'+randomUUID(),message=randomUUID();
 for(const id of [owner,member,outsider])await db.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[id,'Synthetic '+id.slice(0,4),id+'@example.invalid']);
 await db.query('INSERT INTO organization(id,name,created_by) VALUES($1,$2,$3)',[org,'Synthetic organization',owner]);
 await db.query("INSERT INTO organization_member(organization_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')",[org,owner,member,outsider]);
 await db.query('INSERT INTO team(id,name,owner_id,organization_id) VALUES($1,$2,$3,$4)',[team,'Synthetic Links '+team.slice(0,6),owner,org]);
 await db.query("INSERT INTO team_member(team_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[team,owner,member]);
 await db.query("INSERT INTO workspace(id,owner_id,name,organization_id,state,desired_state) VALUES($1,$2,'Synthetic API',$3,'ready','running')",[workspace,owner,org]);
 await db.query("INSERT INTO workspace_team_access(workspace_id,team_id,role,permissions) VALUES($1,$2,'viewer',$3)",[workspace,team,JSON.stringify({projects:'all',sessions:'view'})]);
 const u=id=>({id,name:'Synthetic',email:id+'@example.invalid'});
 const first=(await readableLinkAction(db,u(owner),{action:'ensure',kind:'workspace',workspaceId:workspace,origin})).link;
 assert.match(first.url,/^https:\/\/canopyide\.dev\/synthetic-links-[a-z0-9-]+\/synthetic-api$/);
 assert.equal((await readableLinkAction(db,u(member),{action:'ensure',kind:'workspace',workspaceId:workspace,origin})).link.url,first.url);
 assert.equal((await readableLinkAction(db,u(member),{action:'resolve',url:first.url,origin})).link.target.workspaceId,workspace);
 await assert.rejects(()=>readableLinkAction(db,u(outsider),{action:'resolve',url:first.url,origin}),e=>e.code===404);
 const session=(await readableLinkAction(db,u(member),{action:'ensure',kind:'session',workspaceId:workspace,projectId:'app',publicationId:'pub-1',title:'Fix login bug',origin})).link;
 assert.ok(session.url.startsWith(first.url+'/s/fix-login-bug-'));
 const chat=(await readableLinkAction(db,u(member),{action:'ensure',kind:'message',teamId:team,peer:null,messageId:message,origin})).link;
 assert.equal((await readableLinkAction(db,u(owner),{action:'resolve',url:chat.url,origin})).link.target.messageId,message);
 assert.equal(JSON.stringify((await db.query('SELECT target FROM readable_link WHERE kind=$1 AND team_id=$2',['message',team])).rows),JSON.stringify([{target:{teamId:team,messageId:message,participants:null}}]));
 // Removal from the team cuts access at once; no stored credential survives.
 await db.query('UPDATE team_member SET removed_at=now() WHERE team_id=$1 AND user_id=$2',[team,member]);
 await assert.rejects(()=>readableLinkAction(db,u(member),{action:'resolve',url:chat.url,origin}),e=>e.code===404);
 await assert.rejects(()=>readableLinkAction(db,u(member),{action:'resolve',url:first.url,origin}),e=>e.code===404);
 assert.deepEqual(await readableLinkAction(db,u(owner),{action:'revoke',url:first.url,origin}),{revoked:true});
 await assert.rejects(()=>readableLinkAction(db,u(owner),{action:'resolve',url:first.url,origin}),e=>e.code===410);
 const again=(await readableLinkAction(db,u(owner),{action:'ensure',kind:'workspace',workspaceId:workspace,origin})).link;
 assert.notEqual(again.url,first.url);
 await db.query('SAVEPOINT reuse');await assert.rejects(()=>db.query("INSERT INTO readable_link(namespace,path,kind,target,target_key,created_by) SELECT namespace,path,kind,target,'other',created_by FROM readable_link WHERE revoked_at IS NOT NULL LIMIT 1"),/duplicate key/);await db.query('ROLLBACK TO SAVEPOINT reuse');
 }finally{await db.query('ROLLBACK');db.release();await pool.end();}
});
