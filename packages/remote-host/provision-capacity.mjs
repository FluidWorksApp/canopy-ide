import {createHash} from 'node:crypto';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
export function capacityUnit(workspace){
 const {memoryMiB,cpus}=workspace;const ratio=workspace.swapRatio??0.75;
 if(typeof workspace.id!=='string'||!workspace.id||!Number.isSafeInteger(memoryMiB)||memoryMiB<256||memoryMiB>1048576||!Number.isFinite(cpus)||cpus<=0||cpus>1024||!Number.isFinite(ratio)||ratio<0||ratio>1)throw Error('Invalid workspace capacity');
 const name=`canopy-${createHash('sha256').update(workspace.id).digest('hex').slice(0,24)}.slice`;
 return {name,content:`[Unit]\nDescription=Canopy workspace capacity\nBefore=canopy-host.service\n\n[Slice]\nMemoryAccounting=yes\nCPUAccounting=yes\nMemoryMax=${memoryMiB*1048576}\nMemorySwapMax=${Math.round(memoryMiB*1048576*ratio)}\nCPUQuota=${Math.round(cpus*10000)/100}%\n\n[Install]\nWantedBy=multi-user.target\n`};
}
export async function provisionCapacity(configPath,{write=writeFile,read=readFile,move=rename,candidateOnly=false,run=(args)=>execFileSync('systemctl',args,{stdio:'pipe'})}={}){
 const config=JSON.parse(await read(configPath,'utf8'));
 if(!Array.isArray(config.workspaces)||!config.workspaces.length)throw Error('No workspace capacity configured');
 // Validate everything before writing any unit.
 const units=config.workspaces.map(capacityUnit);
 for(const unit of units)await write(`/etc/systemd/system/${unit.name}`,unit.content,{mode:0o644});
 run(['daemon-reload']);
 for(const unit of units){run(['enable','--now',unit.name]);run(['is-active','--quiet',unit.name]);}
 config.workspaces.forEach((workspace,i)=>{workspace[candidateOnly?'sharingCgroupParent':'cgroupParent']=units[i].name;});
 const temporary=`${configPath}.capacity-tmp`;
 await write(temporary,JSON.stringify(config),{mode:0o600});await move(temporary,configPath);
 return units.map(unit=>unit.name);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('Capacity provisioning requires host root on Linux');
 if(process.argv[3]!==undefined&&process.argv[3]!=='--prepare-sharing')throw Error('Unknown capacity provisioning mode');
 await provisionCapacity(process.argv[2]??'/etc/canopy-host/host.json',{candidateOnly:process.argv[3]==='--prepare-sharing'});
}
