import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export function expectedRelease(version) {
 if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Invalid release version');
 const payloads={
  'darwin-aarch64':'Canopy_aarch64.app.tar.gz',
  'darwin-x86_64':'Canopy_x64.app.tar.gz',
  'linux-x86_64':`Canopy_${version}_amd64.AppImage`,
  'linux-x86_64-appimage':`Canopy_${version}_amd64.AppImage`,
  'linux-x86_64-deb':`Canopy_${version}_amd64.deb`,
  'linux-x86_64-rpm':`Canopy-${version}-1.x86_64.rpm`,
  'windows-x86_64':`Canopy_${version}_x64-setup.exe`,
  'windows-x86_64-nsis':`Canopy_${version}_x64-setup.exe`,
 };
 const installers=[`Canopy_${version}_aarch64.dmg`,`Canopy_${version}_x64.dmg`,'Canopy-macos-arm64.dmg','Canopy-macos-intel.dmg','Canopy-linux-x86_64.AppImage','Canopy-linux-x86_64.deb','Canopy-linux-x86_64.rpm','Canopy-windows-x86_64-setup.exe'];
 return {payloads,names:[...new Set([...Object.values(payloads).flatMap(n=>[n,n+'.sig']),...installers])]};
}
export function requireDraft(release) {
 if(release && (!release.draft || release.immutable))throw Error('Release is already published or immutable. Use a new patch version; do not retag or retry uploads.');
}
export function requireAssets(release,version) {
 requireDraft(release);if(!release)throw Error('Release draft is missing');
 const expected=expectedRelease(version),assets=new Map(release.assets.map(a=>[a.name,a]));
 const missing=expected.names.filter(n=>!assets.has(n)||assets.get(n).state!=='uploaded'||assets.get(n).size<=0);
 if(missing.length)throw Error('Incomplete release assets: '+missing.join(', '));
 for(const n of expected.names)if(!/^sha256:[a-f0-9]{64}$/.test(assets.get(n).digest??''))throw Error('Missing asset digest: '+n);
 return {expected,assets};
}
export function requireReleaseTag(tag,version) {
 if(tag!==`v${version}`&&!new RegExp(`^v${version.replaceAll('.','\\.')}-rebuild\\.[1-9][0-9]*$`).test(tag??''))throw Error('Tag and checked-out package version disagree');
}
export function releaseManifest(version,notes,payloads,signatures,now=new Date().toISOString(),tag=`v${version}`) {
 requireReleaseTag(tag,version);
 const platforms={};for(const [platform,name]of Object.entries(payloads)){
  const signature=signatures.get(name);if(!signature)throw Error('Missing verified signature: '+name);
  platforms[platform]={signature,url:`https://github.com/FluidWorksApp/canopy-ide/releases/download/${tag}/${name}`};
 }
 return {version,notes,pub_date:now,platforms};
}
export function releaseMetadataQuery(tag) {
 return `[.[] | select(.tag_name == ${JSON.stringify(tag)}) | {id,tag_name,draft,immutable,assets:[.assets[] | {name,state,size,digest}]}][0]`;
}
export function parseReleaseMetadata(output) {
 const text=String(output??'').trim();
 return text?JSON.parse(text):null;
}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const gh=(...args)=>execFileSync('gh',args,{encoding:'utf8'});
async function main(){
 const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,tag=process.env.CANOPY_RELEASE_TAG;
 requireReleaseTag(tag,version);
 // Filter in gh before Node captures stdout; release history can exceed its buffer.
 // gh prints nothing (not "null") when no release has this tag yet: the first
 // run for a new tag, before any draft exists. That is an eligible target.
 const release=parseReleaseMetadata(gh('api','repos/FluidWorksApp/canopy-ide/releases?per_page=100','--jq',releaseMetadataQuery(tag)));requireDraft(release);
 if(process.argv.includes('--preflight')){console.log('Release target is unpublished and eligible for uploads.');return;}
 const {expected,assets}=requireAssets(release,version),stage=fs.mkdtempSync(path.join(os.tmpdir(),'canopy-release-complete-'));
 try{
  const config=JSON.parse(fs.readFileSync(path.join(root,'src-tauri/tauri.conf.json'),'utf8'));
  const publicKey=path.join(stage,'public.key');fs.writeFileSync(publicKey,Buffer.from(config.plugins.updater.pubkey,'base64'));
  const signatures=new Map();
  for(const name of expected.names){
   gh('release','download',tag,'--repo','FluidWorksApp/canopy-ide','--pattern',name,'--dir',stage);
   const data=fs.readFileSync(path.join(stage,name));
   if('sha256:'+createHash('sha256').update(data).digest('hex')!==assets.get(name).digest)throw Error('Asset digest mismatch: '+name);
  }
  for(const name of new Set(Object.values(expected.payloads))){
   const encoded=fs.readFileSync(path.join(stage,name+'.sig'),'utf8').trim(),sig=path.join(stage,name+'.minisig');
   fs.writeFileSync(sig,Buffer.from(encoded,'base64'));
   execFileSync('cargo',['run','--quiet','--locked','--manifest-path',path.join(root,'scripts/release-verifier/Cargo.toml'),'--',publicKey,sig,path.join(stage,name)],{stdio:'inherit'});
   signatures.set(name,encoded);
  }
  const notes=fs.readFileSync(path.join(root,`docs/releases/${version}.md`),'utf8');
  fs.writeFileSync(path.join(stage,'latest.json'),JSON.stringify(releaseManifest(version,notes,expected.payloads,signatures,undefined,tag),null,2)+'\n');
  gh('release','upload',tag,'--repo','FluidWorksApp/canopy-ide',path.join(stage,'latest.json'),'--clobber');
  const latest=JSON.parse(gh('api',`repos/FluidWorksApp/canopy-ide/releases/${release.id}`));requireAssets(latest,version);
  if(process.argv.includes('--publish'))gh('release','edit',tag,'--repo','FluidWorksApp/canopy-ide','--draft=false','--latest');
  console.log('Complete cross-platform assets and updater signatures verified.'+(process.argv.includes('--publish')?' Release published.':' Draft retained for review.'));
 }finally{fs.rmSync(stage,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
