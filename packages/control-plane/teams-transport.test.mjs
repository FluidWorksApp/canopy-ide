import test from 'node:test';
import assert from 'node:assert/strict';
import {teamAction} from './lib/teams.mjs';
test('account service refuses plaintext message reads and writes without accessing message storage',async()=>{
 const queries=[];const db={query:async(sql)=>{queries.push(sql);return {rows:[{role:'member'}]};}};
 for(const action of ['send','messages'])await assert.rejects(teamAction(db,{id:'member'},{action,teamId:'11111111-1111-4111-8111-111111111111',body:'private plaintext'}),e=>e.code===410);
 assert.equal(queries.some(sql=>sql.includes('team_message')),false);
});
