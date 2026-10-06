import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {pkceChallenge,matchesVerifier,validChallenge} from './lib/pairing.mjs';
test('device pairing only accepts the initiating device verifier',()=>{
 const verifier=randomBytes(48).toString('base64url'), challenge=pkceChallenge(verifier);
 assert.equal(validChallenge(challenge),true);
 assert.equal(matchesVerifier(challenge,verifier),true);
 for(const wrong of ['',challenge,randomBytes(48).toString('base64url'),null,'x'.repeat(200)])assert.equal(matchesVerifier(challenge,wrong),false);
 assert.equal(matchesVerifier('invalid',verifier),false);
});
