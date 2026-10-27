import test from 'node:test';import assert from 'node:assert/strict';import {ADJECTIVES,NOUNS,EXCLUDED_WORDS} from './readable-words.mjs';
test('readable words are short lowercase words, unique across both lists',()=>{
 const all=[...ADJECTIVES,...NOUNS];
 assert.ok(all.length>=1000&&all.length<=2000,`${all.length} words`);
 for(const word of all)assert.match(word,/^[a-z]{3,8}$/,word);
 assert.equal(new Set(all).size,all.length);
});
test('homophones, heteronyms and ambiguous spellings never appear',()=>{
 const excluded=new Set(EXCLUDED_WORDS);
 assert.deepEqual([...ADJECTIVES,...NOUNS].filter(w=>excluded.has(w)),[]);
 for(const word of ['bear','bare','tail','tale','sea','see','lead','wind','grey','gray'])assert.ok(excluded.has(word),word);
});
