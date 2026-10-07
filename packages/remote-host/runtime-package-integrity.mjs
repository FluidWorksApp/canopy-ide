/** Verify root package metadata before reusing a prebuilt dependency tree.
 * Kept self-contained so bootstrap can embed this trusted function before the
 * newly downloaded runtime is allowed to execute any management code. */
export function verifyRuntimePackageMetadata(manifest,lock){
 const invalid=()=>{throw Error('Runtime package metadata does not match its verified dependency lock');};
 const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
 if(!object(manifest)||!object(lock)||![2,3].includes(lock.lockfileVersion)||!object(lock.packages)||!object(lock.packages['']))invalid();
 const root=lock.packages[''];
 for(const key of ['name','version'])if(typeof manifest[key]!=='string'||!manifest[key]||manifest[key]!==root[key]||manifest[key]!==lock[key])invalid();
 const sorted=value=>object(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,sorted(item)])):value;
 for(const key of ['dependencies','devDependencies','optionalDependencies','peerDependencies','peerDependenciesMeta','engines']){
  const left=manifest[key]??{},right=root[key]??{};
  if(!object(left)||!object(right)||JSON.stringify(sorted(left))!==JSON.stringify(sorted(right)))invalid();
 }
 return true;
}
