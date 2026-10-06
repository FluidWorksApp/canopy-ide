const invalid=()=>{throw Error('Prebuilt management host integrity does not match its approved factory release');};
export function verifyFactoryMetadata({record,marker,stat,nodeVersion,nodeArchitecture,dockerVersion,caddyVersion,lockSha256}){
 if(!stat||stat.uid!==0||(stat.mode&0o022)!==0||stat.symlink||stat.regular!==true||stat.size>16384||!record||!marker||marker.version!==1||record.architecture!=='amd64'||nodeArchitecture!=='x64'||!/^22\.\d+\.\d+$/.test(record.nodeVersion??''))invalid();
 for(const key of ['architecture','revision','runtimeSha256','lockSha256','nodeVersion','dockerVersion','caddyVersion'])if(marker[key]!==record[key])invalid();
 if(!/^[a-f0-9]{40}$/.test(marker.revision)||['runtimeSha256','lockSha256'].some(key=>!/^[a-f0-9]{64}$/.test(marker[key]??''))||['docker','http','sanitized','bootFenced'].some(key=>marker.proof?.[key]!==true||record.proof?.[key]!==true)||nodeVersion!=='v'+record.nodeVersion||dockerVersion!==record.dockerVersion||caddyVersion!==record.caddyVersion||lockSha256!==record.lockSha256)invalid();
 return true;
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const {lstat,readFile}=await import('node:fs/promises');const {createHash}=await import('node:crypto');const {execFileSync}=await import('node:child_process');
 const file='/opt/canopy-host/factory.json',stat=await lstat(file);
 if(stat.uid!==0||(stat.mode&0o022)!==0||stat.isSymbolicLink()||!stat.isFile()||stat.size>16384)invalid();
 const record=JSON.parse(Buffer.from(process.argv[2]??'','base64').toString('utf8'));
 const packageVersion=name=>execFileSync('/usr/bin/dpkg-query',['-W','-f=${Version}',name],{encoding:'utf8',timeout:5000}).trim();
 verifyFactoryMetadata({record,marker:JSON.parse(await readFile(file,'utf8')),stat:{uid:stat.uid,mode:stat.mode,size:stat.size,symlink:stat.isSymbolicLink(),regular:stat.isFile()},nodeVersion:process.version,nodeArchitecture:process.arch,dockerVersion:packageVersion('docker.io'),caddyVersion:packageVersion('caddy'),lockSha256:createHash('sha256').update(await readFile('/opt/canopy-host/package-lock.json')).digest('hex')});
 process.stdout.write('Verified prebuilt management host.\n');
}
