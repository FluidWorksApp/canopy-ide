import {execFileSync} from 'node:child_process';import test from 'node:test';import assert from 'node:assert/strict';
import {expectedRelease,requireDraft,requireAssets,releaseManifest,requireReleaseTag,releaseMetadataQuery,parseReleaseMetadata,draftCreateArgs} from './release-assets.mjs';
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

test('large release history is filtered before the subprocess output buffer',()=>{
 const target={...complete(),id:42,tag_name:'v0.4.1',body:'release-notes'.repeat(4000)};
 const history=Array.from({length:100},(_,i)=>({...target,id:i,tag_name:`v0.3.${i}`}));history.push(target);
 const input=JSON.stringify(history);assert.ok(Buffer.byteLength(input)>1024*1024);
 assert.throws(()=>execFileSync('jq',['.'],{input,encoding:'utf8'}),{code:'ENOBUFS'});
 const selected=JSON.parse(execFileSync('jq',[releaseMetadataQuery('v0.4.1')],{input,encoding:'utf8'}));
 assert.equal(selected.id,42);assert.equal(selected.body,undefined);requireAssets(selected,version);
 assert.equal(JSON.parse(execFileSync('jq',[releaseMetadataQuery('v9.9.9')],{input,encoding:'utf8'})),null);
 assert.equal(JSON.parse(execFileSync('jq',[releaseMetadataQuery('v0.4.1" | .[]')],{input,encoding:'utf8'})),null);
});

test('a tag with no release yet is an eligible target, as gh prints it (nothing, not "null")',()=>{
 // jq prints null for a missing release; `gh api --jq` prints an empty line.
 // v0.4.3's first release run died on JSON.parse('') before any draft existed.
 for(const output of ['','\n','null\n'])assert.equal(parseReleaseMetadata(output),null);
 requireDraft(parseReleaseMetadata(''));
 assert.deepEqual(parseReleaseMetadata('{"id":1,"draft":true}\n'),{id:1,draft:true});
 assert.throws(()=>requireDraft(parseReleaseMetadata('{"id":1,"draft":false}')),/already published/);
});

test('preflight creates the single draft every build uploads into',()=>{
 // v0.4.3-rebuild.1: no draft existed, each build job created one, and two
 // raced into existence with half the assets each.
 assert.deepEqual(draftCreateArgs('v0.4.4','0.4.4','/r/docs/releases/0.4.4.md'),['release','create','v0.4.4','--repo','FluidWorksApp/canopy-ide','--draft','--verify-tag','--title','Canopy 0.4.4','--notes-file','/r/docs/releases/0.4.4.md']);
 assert.equal(draftCreateArgs('v0.4.4-rebuild.1','0.4.4','n.md')[2],'v0.4.4-rebuild.1');
 assert.throws(()=>draftCreateArgs('v0.4.5','0.4.4','n.md'),/disagree/);
});
