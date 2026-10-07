import {useState,useRef} from 'react';
import {isRemoteHost} from '../host';
import * as ipc from '../ipc';
import {Dialog} from '../components/Dialog';
import {DirectoryPicker} from './DirectoryPicker';

export function useRemoteUpload(notice:(message:string,kind?:'info'|'success'|'warn'|'error')=>void,refresh:()=>void){
 const [progress,setProgress]=useState<ipc.RemoteUploadProgress|null>(null);
 const [cancelling,setCancelling]=useState(false);
 const [destinationChoice,setDestinationChoice]=useState<{path:string;kind:'files'|'folder'}|null>(null);
 const busy=useRef(false);
 const cancel=()=>{if(!progress||cancelling)return;setCancelling(true);void ipc.remoteUploadCancel(progress.id).catch(error=>notice(String(error),'error'));};
 const start=async(destination:string,kind:'files'|'folder')=>{
   if(busy.current){notice('Another upload is already running.','info');return;}
   busy.current=true;const id=crypto.randomUUID();let stop:(()=>void)|undefined;
   setCancelling(false);setProgress({id,destination,name:'Choose files on your computer',bytes:0,totalBytes:0,files:0,totalFiles:0,skipped:0,cancelled:false});
   try{
     stop=await ipc.onRemoteUploadProgress(p=>{if(p.id===id)setProgress(p);});
     const result=await ipc.remoteUpload(destination,kind,id);
     if(result.cancelled){if(result.files)notice(`Upload cancelled. ${result.files} completed files were kept.`,'info');}
     else notice(`Uploaded ${result.files} ${result.files===1?'file':'files'} to ${destination}.${result.skipped?` Skipped ${result.skipped} symbolic links or special files.`:''}`,'success');
   }catch(error){notice(String(error),'error');}
   finally{stop?.();busy.current=false;setProgress(null);setCancelling(false);refresh();}
 };
 const percent=progress?.totalBytes?Math.min(100,Math.floor(progress.bytes/progress.totalBytes*100)):0;
 const chooseDestination=(path:string,kind:'files'|'folder')=>{if(!busy.current)setDestinationChoice({path,kind});};
 return {startUpload:isRemoteHost()?start:undefined,chooseUploadDestination:isRemoteHost()?chooseDestination:undefined,busy:progress!==null||destinationChoice!==null,uploadDialog:destinationChoice?<DirectoryPicker initialPath={destinationChoice.path} editablePath title="Upload to remote workspace" body="Choose the destination, then select files from your computer." confirmLabel={destinationChoice.kind==='files'?'Choose files…':'Choose folder…'} onCancel={()=>setDestinationChoice(null)} onSelect={paths=>{const kind=destinationChoice.kind;setDestinationChoice(null);void start(paths[0],kind);}}/>:progress?<Dialog title="Upload to remote workspace" size="sm" meta={progress.destination} dismissLabel={cancelling?'Cancelling…':'Cancel upload'} onDismiss={cancel}>
   <p>{progress.name}</p>
   {progress.totalFiles>0&&<><progress aria-label="Upload progress" value={progress.bytes} max={progress.totalBytes||1}/><p>{percent}% · {progress.files} / {progress.totalFiles} files</p></>}
   <p>Existing files are kept. Completed files remain if you cancel.</p>
 </Dialog>:null};
}
