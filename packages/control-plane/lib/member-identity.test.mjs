import test from 'node:test';import assert from 'node:assert/strict';import {memberGitIdentity} from './member-identity.mjs';
test('member identity is resolved from the authenticated database member, without credentials',async()=>{
 const db={query:async(sql,args)=>{assert.deepEqual(args,['authenticated-member']);return {rows:[{name:'Ada',email:'ada@example.invalid',token:'NEVER RETURN'}]};}};
 assert.deepEqual(await memberGitIdentity(db,'authenticated-member'),{name:'Ada',email:'ada@example.invalid'});
});
test('missing and malformed member identities fail closed',async()=>{
 for(const row of [null,{name:'Ada\nOther',email:'ada@example.invalid'},{name:'Ada',email:'invalid'},{name:'Ada',email:'ada\x00@example.invalid'}])await assert.rejects(memberGitIdentity({query:async()=>({rows:row?[row]:[]})},'member'));
});
