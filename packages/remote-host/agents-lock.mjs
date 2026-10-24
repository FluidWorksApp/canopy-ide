#!/usr/bin/env node
// The workspace image's agent CLIs are data: agents.lock.json names each tool,
// its kind and its pinned source; install-agents.sh switches on kind, never on
// tool name. Adding or bumping a tool is a lock edit made by this command.
//   node agents-lock.mjs bump <tool> <version>   pin a version (hashes fetched)
//   node agents-lock.mjs check                   validate the lock
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

export const LOCK=new URL('./agents.lock.json',import.meta.url);
export const ARCHES=['amd64','arm64'];
const KINDS={archive:['kind','version','format','strip','bin','platforms'],npm:['kind','package','version','bin','lazy'],pip:['kind','package','version','bin']};
const FORMATS=['tar.gz','zip','binary'];
const NAME=/^[a-z][a-z0-9-]*$/;

/** Every rule a tool must satisfy. Archives are only ever immutable, versioned,
 * checksummed artifacts: no mutable installer URL can be pinned here. */
export function validateLock(lock){
 const problems=[];
 for(const [name,tool] of Object.entries(lock)){
  const fail=message=>problems.push(`${name}: ${message}`);
  if(!NAME.test(name))fail('tool names are lowercase words');
  const fields=KINDS[tool?.kind];
  if(!fields){fail(`unknown kind ${tool?.kind}`);continue;}
  for(const key of Object.keys(tool))if(!fields.includes(key))fail(`unexpected field ${key}`);
  if(typeof tool.version!=='string'||!/^[0-9][0-9A-Za-z.+-]*$/.test(tool.version))fail('version must be an exact version');
  const bins=tool.kind==='archive'?Object.keys(tool.bin??{}):tool.bin;
  if(!Array.isArray(bins)||!bins.length||!bins.every(bin=>NAME.test(bin)))fail('bin must name the commands it provides');
  if(tool.kind==='archive'){
   if(!FORMATS.includes(tool.format))fail(`format must be one of ${FORMATS.join(', ')}`);
   if(![0,1].includes(tool.strip))fail('strip must be 0 or 1');
   if(tool.format==='binary'&&(tool.strip!==0||bins.length!==1))fail('a binary provides exactly one command, unstripped');
   for(const path of Object.values(tool.bin??{}))if(typeof path!=='string'||!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(path)||path.split('/').includes('..'))fail(`bin path ${path} must stay inside the package`);
   if(Object.keys(tool.platforms??{}).sort().join()!==ARCHES.join())fail(`platforms must be exactly ${ARCHES.join(', ')}`);
   for(const [arch,platform] of Object.entries(tool.platforms??{})){
    if(typeof platform?.url!=='string'||!platform.url.startsWith('https://'))fail(`${arch} url must be https`);
    else if(!platform.url.includes('{version}'))fail(`${arch} url must contain {version}, so the pin cannot drift`);
    if(!/^[a-f0-9]{128}$/.test(platform?.sha512??''))fail(`${arch} needs a sha512`);
   }
  }else{
   if(typeof tool.package!=='string'||!/^@?[a-z0-9][a-z0-9._/-]*$/.test(tool.package))fail('package must be a registry name');
   if('lazy' in tool&&(tool.lazy!==true||bins.length!==1))fail('lazy installs exactly one command');
  }
 }
 return problems;
}

export const sourceUrl=(tool,arch)=>tool.platforms[arch].url.replaceAll('{version}',tool.version);

async function sha512(url){
 const response=await fetch(url,{redirect:'follow'});
 if(!response.ok)throw Error(`${url}: HTTP ${response.status}`);
 const hash=createHash('sha512');
 for await(const chunk of response.body)hash.update(chunk);
 return hash.digest('hex');
}

export async function bump(lock,name,version,{hash=sha512,exists=registryHas}={}){
 const tool=lock[name];
 if(!tool)throw Error(`No tool ${name} in the lock. Add its entry first.`);
 const next={...tool,version};
 if(tool.kind==='archive'){
  next.platforms=Object.fromEntries(await Promise.all(ARCHES.map(async arch=>[arch,{...tool.platforms[arch],sha512:await hash(sourceUrl(next,arch))}])));
 }else if(!await exists(tool,version))throw Error(`${tool.package}@${version} is not published`);
 const updated={...lock,[name]:next};
 const problems=validateLock(updated);
 if(problems.length)throw Error(problems.join('\n'));
 return updated;
}

async function registryHas(tool,version){
 const url=tool.kind==='npm'?`https://registry.npmjs.org/${tool.package}/${encodeURIComponent(version)}`:`https://pypi.org/pypi/${tool.package}/${encodeURIComponent(version)}/json`;
 return (await fetch(url)).ok;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const [command,name,version]=process.argv.slice(2);
 const lock=JSON.parse(await readFile(LOCK,'utf8'));
 if(command==='check'){
  const problems=validateLock(lock);
  if(problems.length){console.error(problems.join('\n'));process.exit(1);}
  console.log(`${Object.keys(lock).length} tools pinned`);
 }else if(command==='bump'&&name&&version){
  await writeFile(LOCK,JSON.stringify(await bump(lock,name,version),null,2)+'\n');
  console.log(`${name} pinned to ${version}`);
 }else{
  console.error('Usage: node agents-lock.mjs bump <tool> <version> | check');process.exit(2);
 }
}
