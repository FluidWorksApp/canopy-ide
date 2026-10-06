import test from 'node:test';import assert from 'node:assert/strict';
import {expectedRelease,requireDraft,requireAssets,releaseManifest,requireReleaseTag} from './release-assets.mjs';
const version='0.4.1';
const complete=()=>({draft:true,immutable:false,assets:expectedRelease(version).names.map(name=>({name,state:'uploaded',size:42,digest:'sha256:'+'a'.repeat(64)}))});
test('published or immutable targets are rejected before building or uploading',()=>{assert.doesNotThrow(()=>requireDraft(undefined));assert.throws(()=>requireDraft({...complete(),draft:false}),/published/);assert.throws(()=>requireDraft({...complete(),immutable:true}),/immutable/);});
test('a Mac-only release cannot be finalized',()=>{const r=complete();r.assets=r.assets.filter(a=>a.name.includes('aarch64')||a.name.includes('arm64'));assert.throws(()=>requireAssets(r,version),/Incomplete release assets/);});
test('missing, empty or unfinished signatures and missing digests fail closed',()=>{for(const change of [a=>a.pop(),a=>{a[1].size=0;},a=>{a[1].state='new';},a=>{delete a[1].digest;}]){const r=complete();change(r.assets);assert.throws(()=>requireAssets(r,version));}});
test('complete artifacts produce every platform, independent of matrix upload ordering',()=>{const {expected}=requireAssets(complete(),version);const signatures=new Map(Object.values(expected.payloads).map(n=>[n,'verified-signature']));const manifest=releaseManifest(version,'Core feature notes',expected.payloads,signatures);assert.deepEqual(Object.keys(manifest.platforms),Object.keys(expected.payloads));assert.ok(Object.values(manifest.platforms).every(p=>p.url.includes('/v0.4.1/')&&p.signature==='verified-signature'));signatures.delete('Canopy_x64.app.tar.gz');assert.throws(()=>releaseManifest(version,'',expected.payloads,signatures),/Missing verified signature/);});

test('rebuild tags retain the app version and use the real download tag',()=>{
 const {payloads}=expectedRelease('0.4.0'), signatures=new Map(Object.values(payloads).map(n=>[n,'verified-signature']));
 const manifest=releaseManifest('0.4.0','Core feature notes',payloads,signatures,undefined,'v0.4.0-rebuild.1');
 assert.equal(manifest.version,'0.4.0');assert.ok(Object.values(manifest.platforms).every(p=>p.url.includes('/v0.4.0-rebuild.1/')));
 for(const tag of ['v0.4.1','v0.4.0-rebuild.0','v0.4.0-rebuild.bad','v0.4.0/other'])assert.throws(()=>requireReleaseTag(tag,'0.4.0'),/disagree/);
});
