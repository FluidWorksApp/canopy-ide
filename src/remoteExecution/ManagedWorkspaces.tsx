import {WorkspaceHero,retryActionLabel} from './WorkspaceHero';
import {GrowStorage} from './GrowStorage';
import {useEffect,useRef,useState} from 'react';
import {peekWorkspaceList,restoreWorkspaceList,refreshWorkspaceList,isWorkspaceAuthenticationError} from './workspaceListCache';
import type {WorkspaceProgressState} from './WorkspaceProgress';
import {invoke} from '@tauri-apps/api/core';
import {Button,TextInput} from '../components/ui';
import {AccountSettings} from '../components/AccountSettings';
import {canSwitchExecutionMode,setExecutionMode} from '../executionMode';
import {activeWorkspace} from './workspace';
import {RemoteExecutionClient} from './client';
import {connectionKey,reportWorkspaceLifecycle} from './connectionState';
import {clearStopRequest,markStopRequested,saveStopSwitchNotice,stopRequestError,useWorkspaceLifecycle,workspaceLifecycle} from './workspaceLifecycle';
import {subscribeWorkspaceList} from './workspaceListCache';
import type {WorkspaceConnection} from './NativeWorkspaceHost';
export type ManagedWorkspace={id:string;name:string;provider?:string;state:string;storage_gib?:number|null;storage_mode?:'disk'|'snapshot'|null;canGrowStorage?:boolean;storage_used_bytes?:number|string|null;canDelete?:boolean;canRemoveConnection?:boolean;canStop?:boolean;access?:{owner:boolean;canManageAccess:boolean;canStop:boolean;canConnect:boolean;canResume?:boolean;connectionUnavailable?:string};memory_max_mib:number;cpu_max:number;operation?:{phase:string;status:string;action?:string;target_storage_gib?:number|null;last_error?:string|null;bootstrap_mode?:'cold'|'prebuilt'|'user-snapshot'|null;save_progress?:string|null;bootstrap_report?:{stage:string;status:string;sequence?:number;startedAt?:number;receivedAt?:string;reason?:'disk-full';freeGB?:number;neededGB?:number;copiedBytes?:number;totalBytes?:number}|null;retry_replaces_host?:boolean}};
const startupSteps=['Starting machine','Connecting saved files','Starting services','Checking connection','Ready'];
const reportStages:Record<string,string>={packages:'Installing host tools',storage:'Connecting saved files','migrating-files':'Moving your files',artifact:'Downloading the workspace runtime',image:'Preparing the workspace image','host-services':'Starting workspace services'};
export function workspaceStartupProblem(w:ManagedWorkspace){
 if(w.state!=='error'&&w.operation?.status!=='failed'&&w.operation?.bootstrap_report?.status!=='failed')return null;
 const report=w.operation?.bootstrap_report,stage=report&&(report.stage==='packages'&&w.operation?.bootstrap_mode==='prebuilt'?'Verifying prebuilt host tools':reportStages[report.stage]);
 const provided=typeof w.operation?.last_error==='string'?w.operation.last_error.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,400).trim():'';
 if(stage&&(!provided||provided.startsWith('Workspace startup failed during ')))return `${stage} failed. Your saved files are retained. ${retryActionLabel(w)}, or stop the workspace to keep compute off.`;
 return provided||'Workspace preparation stopped. Your saved files are retained. Retry preparation, or stop the workspace to keep compute off.';
}
// Once the host is starting its services, readiness is seconds away: the server
// checks it as soon as the host reports in, so look every second, not every 5.
function startupPollDelay(w:ManagedWorkspace){return w.operation?.bootstrap_report?.stage==='host-services'||w.operation?.phase==='connecting-workspace'?1000:5000;}
// A retained disk moving to snapshot storage: "Moving your files… 12.3 / 40.0 GB".
function migrationProgress(report:{copiedBytes?:number;totalBytes?:number}){const gb=(n:number)=>(n/1e9).toFixed(1);return Number.isSafeInteger(report.copiedBytes)&&Number.isSafeInteger(report.totalBytes)&&(report.totalBytes as number)>0?`Moving your files… ${gb(report.copiedBytes as number)} / ${gb(report.totalBytes as number)} GB`:'Moving your files…';}
function bootstrapProgress(w:ManagedWorkspace){const report=w.operation?.bootstrap_report;return report?.status==='progress'?report.stage==='migrating-files'?migrationProgress(report):report.stage==='packages'&&w.operation?.bootstrap_mode==='prebuilt'?'Verifying prebuilt host tools':reportStages[report.stage]:undefined;}

const stepFor=(w:ManagedWorkspace)=>w.state==='ready'?4:({'creating-storage':0,'creating-compute':0,'starting':0,'attaching-storage':1,'preparing-workspace':2,'connecting-workspace':3,'retiring-previous-compute':3,'replacing-compute':0,'stopping':0,'retaining-storage':0,'saving-storage':0,'growing-storage':0,'retiring-previous-storage':3}[w.operation?.phase??'']??0);
const canDelete=(w:ManagedWorkspace)=>w.canDelete===true&&w.access?.owner!==false&&!['stopping','deleting'].includes(workspaceLifecycle(w));
const canGrowStorage=(w:ManagedWorkspace)=>w.canGrowStorage===true&&w.access?.owner!==false&&!['starting','stopping','deleting'].includes(workspaceLifecycle(w));
const canStop=(w:ManagedWorkspace)=>w.canStop!==false&&w.access?.canStop!==false&&!['not-started','stopped','stopping','deleting'].includes(workspaceLifecycle(w));
const request=<T,>(route:string,body?:unknown)=>invoke<T>('canopy_account_request',{route,body:body??null});
export function ManagedWorkspaces({workspaceId,onList,showAccount=true,showList=true,onProgress,onMinimize,onDeleted,openRequest,onOpenFailed}:{workspaceId?:string;onList?:(items:ManagedWorkspace[])=>void;showAccount?:boolean;showList?:boolean;onProgress?:(progress:WorkspaceProgressState|null)=>void;onMinimize?:()=>void;onDeleted?:(id:string)=>void;openRequest?:{id:string;nonce:number}|null;onOpenFailed?:(id:string)=>void}={}){
 const [workspaces,setWorkspaces]=useState<ManagedWorkspace[]>(()=>peekWorkspaceList()?.workspaces.filter(w=>w.provider==='lightsail')??[]),[busy,setBusy]=useState<string|null>(null),[message,setMessage]=useState('');
 const [loading,setLoading]=useState(!peekWorkspaceList()),[refreshing,setRefreshing]=useState(false),[loadError,setLoadError]=useState('');
 const progressCallback=useRef(onProgress);progressCallback.current=onProgress;
 const [startup,setStartup]=useState<{workspace:ManagedWorkspace;name:string;step:number}|null>(null);
 const [actionTarget,setActionTarget]=useState<{workspace:ManagedWorkspace;action:'hibernate'|'delete'}|null>(null);
 const selectedStartup=startup&&(!workspaceId||startup.workspace.id===workspaceId)?startup:null;
 const [actionBusy,setActionBusy]=useState(false),[confirmName,setConfirmName]=useState(''),[actionError,setActionError]=useState('');
 function confirmAction(workspace:ManagedWorkspace,action:'hibernate'|'delete'){setActionError('');setConfirmName('');setGrowTarget(null);setActionTarget({workspace,action});}
 const [growTarget,setGrowTarget]=useState<ManagedWorkspace|null>(null),[growBusy,setGrowBusy]=useState(false),[growError,setGrowError]=useState('');
 function openGrowStorage(workspace:ManagedWorkspace){setGrowError('');setActionTarget(null);setGrowTarget(workspace);}
 // Growing storage restarts the workspace on a larger disk. A connected window
 // leaves for the local workspace first, as for a stop, and reconnects later.
 async function growStorage(storageGib:number){
  const w=growTarget;if(!w||growBusy)return;
  const host=activeWorkspace(),connected=host?.connection.workspaceId===w.id;
  if(connected&&!canSwitchExecutionMode()){setGrowError('Save or close unsaved files before growing this workspace’s storage.');return;}
  setGrowBusy(true);setBusy(w.id);setGrowError('');
  try{
   await request('/api/operations',{workspaceId:w.id,action:'grow-storage',storageGib,confirmGrowOnly:true,confirmInterrupt:true,requestKey:crypto.randomUUID()});
   setGrowTarget(null);
   if(connected)await setExecutionMode('local');
   setMessage(`Growing storage to ${storageGib} GB. The workspace restarts on the larger disk in a few minutes; your files are kept.`);
   void refreshWorkspaceList().then(result=>{setWorkspaces(result.workspaces.filter(w=>w.provider==='lightsail'));listCallback.current?.(result.workspaces);}).catch(()=>{});
  }catch(error){setGrowError(String(error));}
  finally{setGrowBusy(false);setBusy(null);}
 }

 const listCallback=useRef(onList);listCallback.current=onList;
 useWorkspaceLifecycle(workspaces);
 // The workspace whose stop this view requested; its message follows the
 // lifecycle until compute is confirmed off.
 const stopMessageFor=useRef<string|null>(null);
 const generation=useRef(0);
 const startedAt=useRef(0);const [elapsed,setElapsed]=useState(0);
 useEffect(()=>{if(!busy)return;const timer=setInterval(()=>setElapsed(Math.floor((Date.now()-startedAt.current)/1000)),1000);return()=>clearInterval(timer);},[busy]);
 useEffect(()=>{progressCallback.current?.(busy&&startup?{workspaceId:startup.workspace.id,name:startup.name,step:startup.step,elapsed,message,onStop:canStop(startup.workspace)?()=>confirmAction(startup.workspace,'hibernate'):undefined,onDelete:canDelete(startup.workspace)?()=>confirmAction(startup.workspace,'delete'):undefined}:null);},[busy,startup,elapsed,message]);
 useEffect(()=>{
  let stopped=false;let refreshEpoch=0;
  const publish=(items:ManagedWorkspace[])=>{const visible=items.filter(w=>w.provider==='lightsail');setWorkspaces(visible);listCallback.current?.(visible);};
  const load=async()=>{const current=refreshEpoch;setRefreshing(true);try{const result=await refreshWorkspaceList();if(!stopped&&current===refreshEpoch){publish(result.workspaces);setLoadError('');setLoading(false);}}catch(error){if(!stopped&&current===refreshEpoch){if(isWorkspaceAuthenticationError(error))publish([]);setLoadError(String(error));setLoading(false);}}finally{if(!stopped&&current===refreshEpoch)setRefreshing(false);}};
  const cached=peekWorkspaceList();if(cached)publish(cached.workspaces);
  void restoreWorkspaceList().then(saved=>{if(!stopped&&saved)publish(saved.workspaces);});void load();
  const changed=()=>{refreshEpoch++;generation.current++;setBusy(null);setStartup(null);setActionBusy(false);setActionTarget(null);setWorkspaces([]);listCallback.current?.([]);setLoading(true);setLoadError('');void load();};
  window.addEventListener('canopy:account-changed',changed);
  // Refreshes made elsewhere (the stop watcher, the header switcher) update
  // this view too, so it never shows an older state than the rest of the UI.
  const unsubscribe=subscribeWorkspaceList(snapshot=>{if(!stopped)publish(snapshot.workspaces);});
  const timer=setInterval(()=>void load(),10000);return()=>{stopped=true;generation.current++;clearInterval(timer);unsubscribe();window.removeEventListener('canopy:account-changed',changed);progressCallback.current?.(null);};
 },[]);
 // The header switcher asks for a workspace by id; resume progress and any
 // failure then surface through onProgress / onOpenFailed, not this list.
 const handledOpen=useRef(0);const failedCallback=useRef(onOpenFailed);failedCallback.current=onOpenFailed;
 useEffect(()=>{if(!openRequest||handledOpen.current===openRequest.nonce)return;const w=workspaces.find(item=>item.id===openRequest.id)??peekWorkspaceList()?.workspaces.find(item=>item.id===openRequest.id);if(!w)return;handledOpen.current=openRequest.nonce;void connect(w,true);},[openRequest,workspaces]);
 async function connect(w:ManagedWorkspace,fromSwitcher=false){
  const fail=()=>{if(fromSwitcher)failedCallback.current?.(w.id);};
  if(w.access?.canConnect===false&&w.access.canResume!==true){setMessage(w.access.connectionUnavailable??'You cannot open or resume this workspace.');fail();return;}
  if(!canSwitchExecutionMode()){setMessage('Save or close unsaved files before changing workspace.');fail();return;}
  const lifecycle=workspaceLifecycle(w);
  if(lifecycle==='stopping'||lifecycle==='deleting'){setMessage(lifecycle==='stopping'?'This workspace is still stopping. Resume it once it has stopped.':'This workspace is being deleted.');fail();return;}
  clearStopRequest(w.id);stopMessageFor.current=null;
  startedAt.current=Date.now();setElapsed(0);const current=++generation.current;setBusy(w.id);setStartup({workspace:w,name:w.name,step:stepFor(w)});setMessage('We’ll connect you automatically when your workspace is ready.');
  try{
   if(w.operation?.status==='failed'&&w.state!=='ready')await request('/api/operations',{workspaceId:w.id,action:w.access?.owner===false?'resume':'retry',requestKey:crypto.randomUUID()});
   else if(!['ready','starting'].includes(w.state))await request('/api/operations',{workspaceId:w.id,action:'resume',requestKey:crypto.randomUUID()});
   let connectionErrors=0;
   let observedState=w.state;
   const deadline=Date.now()+30*60*1000;
   while(current===generation.current&&Date.now()<deadline){
    let result:{workspaces:ManagedWorkspace[]},advanceError:unknown;
    try{if(observedState!=='ready')try{await request('/api/operations',{workspaceId:w.id,action:'advance'});}catch(error){advanceError=error;}result=await refreshWorkspaceList();connectionErrors=0;}
    catch(error){if(/sign.?in|401|403/i.test(String(error))||++connectionErrors>=12)throw error;setMessage('Connection interrupted. Retrying automatically…');await new Promise(resolve=>setTimeout(resolve,5000));continue;}

    if(current!==generation.current)return;
    const latest=result.workspaces.find(item=>item.id===w.id);
    if(latest)observedState=latest.state;
    setWorkspaces(result.workspaces.filter(w=>w.provider==='lightsail'));listCallback.current?.(result.workspaces);
    if(!latest)throw Error('This workspace is no longer available. Refresh your workspaces to continue.');
    const problem=workspaceStartupProblem(latest);if(problem)throw Error(problem);
    if(advanceError&&/sign.?in|401|403/i.test(String(advanceError)))throw advanceError;
    setStartup({workspace:latest,name:w.name,step:stepFor(latest)});
    if(latest.state==='ready'){
     setMessage('Connecting securely to your workspace…');
     const clientId=crypto.randomUUID();const {connection:issued,expiresAt}=await request<{connection:WorkspaceConnection;expiresAt?:string}>('/api/operations',{workspaceId:w.id,action:'connect',clientId});const connection={...issued,clientId};
     if(connection.workspaceId!==w.id||connection.endpoint!==`https://${w.id}.workspaces.canopyide.dev`)throw Error('Invalid managed connection');
     await new RemoteExecutionClient(connection.endpoint,connection.token).workspace(w.id,'/open',{resume:connection.scope!=='view'});
     if(current!==generation.current)return;
     if(!canSwitchExecutionMode())throw Error('Your workspace is ready. Save or close unsaved files, then choose Open to connect.');
     if(expiresAt){
      connection.expiresAt=expiresAt;
      connection.credentialAccountKey=await invoke<string|null>('canopy_account_cache_key')??undefined;
     }
     await invoke('execution_remote_set',{connection});await setExecutionMode('remote');return;
    }
    // A step that keeps failing is retried by the server; say so instead of
    // presenting an unchanged "Starting" for the whole startup deadline.
    const retrying=typeof latest.operation?.last_error==='string'?latest.operation.last_error.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,300).trim():'';
    setMessage(retrying?`The last setup step failed (${retrying}). Retrying automatically…`:advanceError?'Could not reach Canopy to continue setup. Retrying automatically…':latest.operation?.phase==='replacing-compute'?'Moving to a fresh machine… Your saved files stay with this workspace.':bootstrapProgress(latest)?`${bootstrapProgress(latest)}… Your saved files stay with this workspace.`:'We’ll connect you automatically when ready. Your saved files and setup stay with this workspace.');
    await new Promise(resolve=>setTimeout(resolve,startupPollDelay(latest)));
   }
   if(current===generation.current)throw Error('The workspace is still preparing. You can retry here or stop the workspace.');
  }catch(error){if(current===generation.current){setMessage(error instanceof Error?error.message:String(error));fail();}}
  finally{if(current===generation.current){setBusy(null);setStartup(null);}}
 }
 async function switchLocal(){
  if(!canSwitchExecutionMode()){setMessage('Save or close unsaved files before changing workspace.');return;}
  try{await setExecutionMode('local');}catch(error){setMessage(String(error));}
 }
 async function mutateWorkspace(){
  if(!actionTarget||actionBusy)return;
  const {workspace:w,action}=actionTarget;
  if(action==='delete'&&confirmName!==w.name)return;
  if(activeWorkspace()?.connection.workspaceId===w.id&&!canSwitchExecutionMode()){setActionError('Save or close unsaved files before changing this workspace.');return;}
  // Cancel pending auto-connect before accepting a shutdown. A late readiness
  // response must never reopen a workspace after the user stops or deletes it.
  const current=++generation.current;setActionBusy(true);setBusy(w.id);setActionError('');
  // Stopping drops the live connection. Mark it as intentional first so the
  // transport parks instead of showing a reconnect loop, and undo on failure.
  const host=activeWorkspace(),connected=host?.connection.workspaceId===w.id,lifecycleKey=connected&&host?connectionKey(host.connection.endpoint,w.id):null;
  if(lifecycleKey)reportWorkspaceLifecycle(lifecycleKey,'stopping');
  let accepted=false;
  try{
   const body={workspaceId:w.id,action,confirmInterrupt:true,confirmName:action==='delete'?confirmName:undefined,requestKey:crypto.randomUUID()};
   const deadline=Date.now()+30000;
   for(;;){
    try{await request('/api/operations',body);break;}
    catch(error){if(current!==generation.current)return;if(!String(error).includes('Finishing the current startup step')||Date.now()>=deadline)throw error;setActionError('Finishing the current startup step before stopping…');await new Promise(resolve=>setTimeout(resolve,2000));}
   }
   accepted=true;
   if(action==='hibernate')markStopRequested(w.id);
   if(current!==generation.current)return;
   setActionTarget(null);setStartup(null);
   if(action==='delete')setWorkspaces(items=>items.map(item=>item.id===w.id?{...item,state:'deleting'}:item));
   if(connected){
    // Leave deliberately: the local workspace takes over and a notice keeps
    // following the stop after the reload, instead of reconnecting to it.
    if(action==='hibernate')saveStopSwitchNotice({workspaceId:w.id,name:w.name,at:Date.now()});
    await setExecutionMode('local');
   }
   if(action==='delete'){
    await invoke('execution_remote_forget',{id:`https://${w.id}.workspaces.canopyide.dev/${w.id}`});onDeleted?.(w.id);
   }
   stopMessageFor.current=action==='hibernate'?w.id:null;
   setMessage(action==='delete'?'Workspace deletion started. Compute, files and backups are being removed.':w.storage_mode==='snapshot'?'Saving your workspace… Files are compacted and stored while compute stops. You can keep working locally.':'Workspace is stopping. Files and setup are saved.');
   void refreshWorkspaceList().then(result=>{if(current===generation.current){setWorkspaces(result.workspaces.filter(w=>w.provider==='lightsail'));listCallback.current?.(result.workspaces);}}).catch(()=>{});
  }catch(error){if(current===generation.current){setStartup(null);setActionError(String(error));}}
  finally{if(lifecycleKey&&!accepted)reportWorkspaceLifecycle(lifecycleKey,null);if(current===generation.current){setBusy(null);setActionBusy(false);}}
 }
 // The stop message follows the same lifecycle as the badge.
 const stopTarget=stopMessageFor.current?workspaces.find(w=>w.id===stopMessageFor.current):undefined;
 const stopTargetLifecycle=stopTarget?workspaceLifecycle(stopTarget):null;
 useEffect(()=>{if(!stopTarget)return;if(stopTargetLifecycle==='stopped'){stopMessageFor.current=null;setMessage('Workspace stopped. Files and setup are saved. Resume it when you’re ready.');}else if(stopTargetLifecycle!=='stopping'){stopMessageFor.current=null;setMessage('');}},[stopTarget,stopTargetLifecycle]);
 return <section className="workspace-access" aria-busy={loading}>{loading&&!workspaces.length&&<div className="workspace-loading" role="status" aria-label="Loading workspaces"><span className="workspace-skeleton"/><span className="workspace-skeleton short"/><span>Loading workspace details…</span></div>}{!selectedStartup&&refreshing&&!!workspaces.length&&<small className="workspace-cache-status" role="status">Refreshing workspace status…</small>}{loadError&&<div className="workspace-feedback error" role="alert">{workspaces.length?'Showing saved details. ':''}{loadError}<Button size="sm" onClick={()=>void refreshWorkspaceList().then(r=>{setWorkspaces(r.workspaces.filter(w=>w.provider==='lightsail'));listCallback.current?.(r.workspaces);setLoadError('');}).catch(e=>setLoadError(String(e)))}>Retry</Button></div>}{!selectedStartup&&showAccount&&<AccountSettings/>}{selectedStartup&&<div className="workspace-startup" aria-label="Workspace startup"><div className="workspace-startup-heading"><strong>{selectedStartup.name}</strong><small>{Math.floor(elapsed/60)}m {elapsed%60}s elapsed</small></div><ol>{startupSteps.map((label,index)=><li key={label} aria-current={index===selectedStartup.step?'step':undefined} className={index<selectedStartup.step?'complete':index===selectedStartup.step?'current':''}><span aria-hidden="true">{index<selectedStartup.step?'✓':index+1}</span>{label}</li>)}</ol><p className="workspace-description">{selectedStartup.step<=2&&selectedStartup.workspace.operation?.bootstrap_mode==='user-snapshot'?"Restoring your saved workspace. Files load in the background after it opens, so the first minutes can be slower.":selectedStartup.step===2&&selectedStartup.workspace.operation?.bootstrap_mode==='prebuilt'?"Starting your saved tools on a verified prebuilt management host.":selectedStartup.step===2?"Preparing your tools and starting workspace services. First-time setup can take several minutes.":selectedStartup.step===3?"Services are up. Verifying a secure connection before opening your projects.":"Your files stay with this workspace."}</p><p role="status">{message}</p><div className="workspace-inline-actions">{busy&&(onMinimize?<Button onClick={onMinimize}>Continue working</Button>:<Button onClick={()=>{generation.current++;setBusy(null);setStartup(null);setMessage('Setup continues. Open this workspace again when you’re ready.');}}>Connect later</Button>)}{canStop(selectedStartup.workspace)&&<Button disabled={actionBusy} onClick={()=>confirmAction(selectedStartup.workspace,'hibernate')}>Stop workspace</Button>}{canDelete(selectedStartup.workspace)&&<Button variant="danger" disabled={actionBusy} onClick={()=>confirmAction(selectedStartup.workspace,'delete')}>Delete workspace</Button>}</div></div>}{showList&&(!busy||!!workspaceId&&busy!==workspaceId)&&workspaces.filter(w=>!workspaceId||w.id===workspaceId).map(w=><div key={w.id}><WorkspaceHero workspace={w} disabled={!!busy} connected={activeWorkspace()?.connection.workspaceId===w.id} onSwitchLocal={()=>void switchLocal()} onOpen={()=>void connect(w)} onStop={canStop(w)?()=>confirmAction(w,'hibernate'):undefined} onDelete={canDelete(w)?()=>confirmAction(w,'delete'):undefined} onGrowStorage={canGrowStorage(w)?()=>openGrowStorage(w):undefined}/>{workspaceStartupProblem(w)&&<p className="workspace-feedback error" role="alert">{workspaceStartupProblem(w)}</p>}{!workspaceStartupProblem(w)&&stopRequestError(w.id)&&<p className="workspace-feedback error" role="alert">{stopRequestError(w.id)}</p>}</div>)}{growTarget&&<GrowStorage workspace={growTarget} busy={growBusy} error={growError} onCancel={()=>setGrowTarget(null)} onGrow={storageGib=>void growStorage(storageGib)}/>}{actionTarget&&<section className="workspace-stop-confirm" role="alertdialog" aria-modal="false" aria-labelledby="workspace-action-title"><strong id="workspace-action-title">{actionTarget.action==='delete'?'Delete':'Stop'} {actionTarget.workspace.name}?</strong><p>{actionTarget.action==='delete'?'Permanently remove this workspace, its files, installed tools and backups for everyone with access. Running agents, terminals and jobs will stop. This cannot be undone.':'All running agents, terminals and jobs in this workspace will stop, including those used by other connected people. Files and installed tools are kept.'}</p>{actionTarget.action==='delete'&&<label>Type the workspace name to confirm<TextInput width="full" autoComplete="off" value={confirmName} disabled={actionBusy} onChange={event=>setConfirmName(event.target.value)}/></label>}{actionError&&<p className="workspace-feedback error" role="alert">{actionError}</p>}<div className="workspace-inline-actions"><Button disabled={actionBusy} onClick={()=>setActionTarget(null)}>Cancel</Button><Button variant={actionTarget.action==='delete'?'danger':'default'} disabled={actionBusy||(actionTarget.action==='delete'&&confirmName!==actionTarget.workspace.name)} onClick={()=>void mutateWorkspace()}>{actionBusy?actionTarget.action==='delete'?'Deleting…':'Stopping…':actionTarget.action==='delete'?'Confirm delete':'Confirm stop'}</Button></div></section>}{!selectedStartup&&(!busy||busy===workspaceId)&&message&&!workspaces.some(w=>workspaceStartupProblem(w)===message)&&<p role="status">{message}</p>}</section>;
}
