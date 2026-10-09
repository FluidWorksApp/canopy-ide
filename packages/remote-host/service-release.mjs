import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
// canopy-serviced ships inside the host release archive, one static Linux
// binary per architecture, each bound by sha256 to workspace-release.json
// (as runtimeLockSha256 binds the dependency lock).
export const SERVICE_TARGETS=['linux-amd64','linux-arm64'];
const fileName=target=>`canopy-serviced-${target}`;
const sha256=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
export function serviceBinaryManifest(directory,{all=true}={}){
 const present=new Set(readdirSync(directory));
 return Object.fromEntries(SERVICE_TARGETS.filter(target=>all||present.has(fileName(target))).map(target=>{const file=join(directory,fileName(target));const bytes=readFileSync(file);if(bytes.length<1024||bytes.subarray(0,4).toString('latin1')!=='\x7fELF')throw Error(`${fileName(target)} is not a Linux executable`);return [target,{sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length}];}));
}
/** Every target present, exactly the manifest's bytes, nothing extra. */
export function verifyServiceBinaries(manifest,directory){
 const declared=manifest?.serviceBinaries;
 if(!declared||typeof declared!=='object'||Object.keys(declared).sort().join()!==[...SERVICE_TARGETS].sort().join())throw Error('Release manifest must declare canopy-serviced for every Linux target');
 const present=readdirSync(directory).sort(),expected=SERVICE_TARGETS.map(fileName).sort();
 if(present.join()!==expected.join())throw Error('Service binary directory must hold exactly the declared binaries');
 for(const target of SERVICE_TARGETS)if(!/^[a-f0-9]{64}$/.test(declared[target]?.sha256??'')||sha256(join(directory,fileName(target)))!==declared[target].sha256)throw Error(`canopy-serviced ${target} does not match the release manifest`);
 return true;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const [first]=process.argv.slice(2);
 if(first==='--merge'){ // --merge release.json binDir: record the binaries in an existing manifest
  const [,release,directory]=process.argv.slice(2),manifest=JSON.parse(readFileSync(release,'utf8'));
  manifest.serviceBinaries=serviceBinaryManifest(directory);writeFileSync(release,JSON.stringify(manifest,null,2));
 }else if(first){process.stdout.write(JSON.stringify({serviceBinaries:serviceBinaryManifest(first,{all:false})},null,2));} // local deploys may carry one architecture
 else{console.error('Usage: service-release.mjs binDir | --merge release.json binDir');process.exit(2);}
}
