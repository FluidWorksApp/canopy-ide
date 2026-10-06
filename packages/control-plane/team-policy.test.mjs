import test from 'node:test';
import assert from 'node:assert/strict';
import {permits,sharingPolicy,invitationRole,canRevoke} from './lib/team-policy.mjs';
test('membership never implies shared credentials',()=>assert.deepEqual(sharingPolicy(),{projects:'selected',projectIds:[],git:'personal',agents:'personal',sessions:'private'}));
test('viewer cannot execute and members cannot interrupt teammates',()=>{for(const action of ['connect','resume','stop','invite','delete'])assert.equal(permits('viewer',action),false);assert.equal(permits('member','connect'),true);assert.equal(permits('member','stop'),false);assert.equal(permits('admin','billing'),false);});
test('admins cannot escalate or revoke owners or peers',()=>{assert.throws(()=>invitationRole('admin','admin'));assert.throws(()=>invitationRole('owner','owner'));assert.equal(canRevoke('admin','owner'),false);assert.equal(canRevoke('admin','admin'),false);assert.equal(canRevoke('owner','member'),true);});
test('reject invalid grants, normalize explicit selections',()=>{assert.throws(()=>sharingPolicy({projectIds:['../owner']}));assert.throws(()=>sharingPolicy({git:'everyone'}));assert.deepEqual(sharingPolicy({projectIds:['b','a','b']}).projectIds,['a','b']);assert.equal(permits('invalid','view'),false);});
