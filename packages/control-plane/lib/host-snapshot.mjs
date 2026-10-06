const bundles=['medium_3_0','large_3_0','xlarge_3_0','2xlarge_3_0'];
const fail=()=>{throw Error('Prebuilt management snapshot is not verified for this location and package');};
export function selectHostSnapshot(value,region,bundle,expectedRuntimeSha256){
 if(!value)return null;
 let catalog;try{catalog=typeof value==='string'?JSON.parse(value):value;}catch{fail();}
 if(!catalog||catalog.version!==1||!Array.isArray(catalog.entries)||catalog.entries.length>16)fail();
 const candidates=catalog.entries.filter(entry=>entry?.region===region);if(!candidates.length)return null;if(candidates.length!==1)fail();
 const record=candidates[0];
 if(!/^22\.\d+\.\d+$/.test(record.nodeVersion??'')||!/^\d[\w.+:~-]*$/.test(record.dockerVersion??'')||!/^\d[\w.+:~-]*$/.test(record.caddyVersion??'')||record.architecture!=='amd64'||record.sourceBundle!=='medium_3_0'||!Array.isArray(record.targetBundles)||!record.targetBundles.includes(bundle)||record.targetBundles.some(id=>!bundles.includes(id))||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(record.snapshotName??'')||!/^arn:aws:lightsail:[a-z0-9-]+:\d{12}:InstanceSnapshot\/[A-Za-z0-9-]+$/.test(record.snapshotArn??'')||record.snapshotArn.split(':')[3]!==region||!/^[a-f0-9]{40}$/.test(record.revision??'')||!/^[a-f0-9]{64}$/.test(record.runtimeSha256??'')||!/^[a-f0-9]{64}$/.test(record.lockSha256??'')||!Number.isFinite(Date.parse(record.verifiedAt))||!record.proof||['docker','http','sanitized','bootFenced'].some(key=>record.proof[key]!==true))fail();
 if(expectedRuntimeSha256!==undefined&&record.runtimeSha256!==expectedRuntimeSha256)fail();
 return record;
}
// Debian package versions may contain '~', which Lightsail tags reject.
// Preserve legacy safe values; encode unsafe version strings without changing
// the exact versions compared against the installed tools and signed catalog.
const versionTag=value=>/^[A-Za-z0-9+_.:/@=-]+$/.test(value)?value:'base64:'+Buffer.from(value,'utf8').toString('base64url');
export function hostSnapshotTags(record){return [
 {key:'managed-by',value:'canopy-host-factory'}, {key:'canopy-factory-schema',value:'1'},
 {key:'canopy-node-version',value:versionTag(record.nodeVersion)},{key:'canopy-docker-version',value:versionTag(record.dockerVersion)},{key:'canopy-caddy-version',value:versionTag(record.caddyVersion)},{key:'canopy-architecture',value:record.architecture},{key:'canopy-revision',value:record.revision},
 {key:'canopy-runtime-sha256',value:record.runtimeSha256},{key:'canopy-lock-sha256',value:record.lockSha256},
 {key:'canopy-factory-verified',value:'docker-http-sanitized-fenced'}
];}
export function verifyHostSnapshot(record,snapshot){
 if(!snapshot||snapshot.state!=='available'||snapshot.name!==record.snapshotName||snapshot.arn!==record.snapshotArn||snapshot.location?.regionName!==record.region||snapshot.fromBlueprintId!=='ubuntu_24_04'||snapshot.fromBundleId!==record.sourceBundle||snapshot.isFromAutoSnapshot===true||snapshot.fromAttachedDisks?.some(disk=>disk.isSystemDisk!==true)||hostSnapshotTags(record).some(tag=>snapshot.tags?.filter(value=>value.key===tag.key).length!==1||snapshot.tags?.find(value=>value.key===tag.key)?.value!==tag.value))fail();
 return record;
}
