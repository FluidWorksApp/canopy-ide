import {workspaceTabs as buildWorkspaceTabs,workspaceTabId,type SavedWorkspaceTab,type WorkspaceTab} from './workspaceTabs';
import {WorkspaceHibernateProgress,type HibernateOperation} from './WorkspaceHibernateProgress';
import {waitForWorkspaceStopped,type HibernateProgressListener} from './hibernateWorkspace';
import {WorkspaceOwnerTools} from './WorkspaceOwnerTools';
import {WorkspaceSharing} from "../components/WorkspaceSharing";
import {SharedSessionsPanel} from "../components/SharedSessionsPanel";
import {CreateWorkspace} from "./CreateWorkspace";
import {ManagedWorkspaces, type ManagedWorkspace} from './ManagedWorkspaces';
import {Dialog} from '../components/Dialog';
import {Button,TextInput,Checkbox} from '../components/ui';
import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { canSwitchExecutionMode, setExecutionMode } from '../executionMode';
import { activeWorkspace } from './workspace';
import { RemoteExecutionClient, type RemoteWorkspace } from './client';
import {LocalProjectImport} from './LocalProjectImport';
import {openLink} from '../links';
import { RemoteDesktop } from './RemoteDesktop';
import './workspace.css';
import {WorkspacePanel} from './WorkspacePanel';
import {WorkspaceProgress,type WorkspaceProgressState} from './WorkspaceProgress';
import {peekWorkspaceList,refreshWorkspaceList} from './workspaceListCache';
import {connectionLabel,useConnectionState} from './connectionState';
import {WorkspaceMenu,type WorkspaceMenuRow} from './WorkspaceMenu';
import {AccountSync} from './AccountSync';
import {workspaceStatus} from './WorkspaceHero';

export function WorkspaceSelector({ onboarding = false,onHibernateWorkspace }: { onboarding?: boolean;onHibernateWorkspace?:(onProgress?:HibernateProgressListener)=>Promise<void> }) {
  const active = activeWorkspace();
  const [managed,setManaged]=useState<ManagedWorkspace[]>(()=>peekWorkspaceList()?.workspaces.filter(w=>w.provider==='lightsail')??[]);
  useEffect(()=>{const changed=()=>{accountRemovalEpoch.current++;hibernateRun.current++;hibernateTask.current=false;setHibernateOperation(null);setHibernateConfirm(false);setStoppingVm(false);setManaged([]);setAccountRemoval(null);setAccountRemovalName('');setBusy(false);};window.addEventListener('canopy:account-changed',changed);return()=>window.removeEventListener('canopy:account-changed',changed);},[]);
  const [stopConfirm,setStopConfirm]=useState(false);
  const [forgetConfirm,setForgetConfirm]=useState(false);
  const accountRemovalEpoch=useRef(0);
  const [accountRemoval,setAccountRemoval]=useState<ManagedWorkspace|null>(null),[accountRemovalName,setAccountRemovalName]=useState('');
  async function removeAccountConnection(){
    const epoch=accountRemovalEpoch.current,target=accountRemoval;if(!target||accountRemovalName!==target.name||busy)return;
    if(!canSwitchExecutionMode()){setError('Save or close unsaved files before removing this connection.');return;}
    setBusy(true);setError('');
    try{await invoke('canopy_account_request',{route:'/api/workspaces',body:{action:'remove-connection',id:target.id,confirmName:accountRemovalName}});
      if(epoch!==accountRemovalEpoch.current)return;
      if(selected?.managedId===target.id)await invoke('execution_remote_forget',{id:selected.savedId??selected.id});
      setManaged(items=>items.filter(item=>item.id!==target.id));setSaved(items=>items.filter(item=>item.workspaceId!==target.id&&!item.id.endsWith('/'+target.id)));setSelectedId('local');setAccountRemoval(null);setNotice('Connection removed. The VM, disks, files and usage history are kept.');void refreshWorkspaceList().catch(()=>{});
      if(active?.connection.workspaceId===target.id)await setExecutionMode('local');
    }catch(error){if(epoch===accountRemovalEpoch.current)setError(String(error));}finally{if(epoch===accountRemovalEpoch.current)setBusy(false);}
  }
  async function forgetConnection(){
    if(!selected||!canSwitchExecutionMode()){setError('Save or close unsaved files before removing this connection.');return;}
    setBusy(true);setError('');
    try{if(selectedActive)await setExecutionMode('local');await invoke('execution_remote_forget',{id:selected.savedId??selected.id});setSaved(items=>items.filter(item=>item.id!==(selected.savedId??selected.id)));setSelectedId('local');setForgetConfirm(false);}
    catch(error){setError(String(error));}finally{setBusy(false);}
  }
  const [hibernateConfirm,setHibernateConfirm]=useState(false);
  const [stoppingVm,setStoppingVm]=useState(false);
  const [hibernateOperation,setHibernateOperation]=useState<HibernateOperation|null>(null);
  const [hibernateMinimized,setHibernateMinimized]=useState(false);
  const hibernateRun=useRef(0);
  const hibernateTask=useRef(false);
  async function hibernateVm(checkExisting=false){
    if(stoppingVm||hibernateTask.current||!onHibernateWorkspace)return;
    const target=checkExisting?hibernateOperation?.workspaceId:active?.connection.workspaceId;
    if(!target)return;
    if(!checkExisting&&hibernateOperation&&active?.connection.workspaceId!==hibernateOperation.workspaceId){setHibernateOperation({...hibernateOperation,error:'Switch back to this workspace before retrying hibernation.'});return;}
    hibernateTask.current=true;
    const run=++hibernateRun.current;
    const name=checkExisting?hibernateOperation!.name:active?.connection.workspaceName??'Workspace';
    setStoppingVm(true);setError('');setHibernateConfirm(false);setOpen(false);setProgress(null);setHibernateMinimized(false);
    setHibernateOperation(previous=>({workspaceId:target,name,startedAt:Date.now(),progress:checkExisting?previous?.progress??{phase:'stopping-compute',shutdownAccepted:true}:{phase:'saving-projects',shutdownAccepted:false}}));
    const onProgress:HibernateProgressListener=progress=>{if(run===hibernateRun.current)setHibernateOperation(previous=>previous?{...previous,progress:{...previous.progress,...progress},error:undefined}:previous);};
    try{if(checkExisting)await waitForWorkspaceStopped(target,onProgress,undefined,{accepted:hibernateOperation?.progress.shutdownAccepted??false});else await onHibernateWorkspace(onProgress);
      if(run!==hibernateRun.current)return;
      setHibernateOperation(previous=>previous?{...previous,progress:{...previous.progress,phase:'completed',shutdownAccepted:true}}:previous);setNotice('Workspace hibernated. Compute is stopped.');
    }catch(error){if(run===hibernateRun.current)setHibernateOperation(previous=>previous?{...previous,error:String(error)}:previous);}
    finally{if(run===hibernateRun.current){hibernateTask.current=false;setStoppingVm(false);}}
  }
  async function stopVm(){
    if(!active||!canSwitchExecutionMode()){setError('Save or close unsaved files before stopping this workspace.');setStopConfirm(false);return;}
    setStoppingVm(true);setError('');
    try{await invoke('canopy_account_request',{route:'/api/operations',body:{workspaceId:active.connection.workspaceId,action:'hibernate',confirmInterrupt:true,requestKey:crypto.randomUUID()}});setStopConfirm(false);setNotice('Workspace is stopping. Files and setup are saved.');await setExecutionMode('local');}
    catch(error){setError(String(error));setStopConfirm(false);}
    finally{setStoppingVm(false);}
  }
  const activeId=active?workspaceTabId({id:`${active.connection.endpoint}/${active.connection.workspaceId}`,endpoint:active.connection.endpoint,workspaceId:active.connection.workspaceId,workspaceName:active.connection.workspaceName},managed):'local';
  const connectionState=useConnectionState(active?`${active.connection.endpoint}/${active.connection.workspaceId}`:'local');
  const [selectedId,setSelectedId]=useState(activeId);
  const [section,setSection]=useState<'overview'|'access'|'tools'>('overview');
  useEffect(()=>{setSection('overview');},[selectedId]);
  const [adding,setAdding]=useState(false);
  const previousTabs=useRef<WorkspaceTab[]>([]);
  const [signInLink,setSignInLink]=useState('');
  const pendingBrowser=useRef<string|null>(null);
  const [browserRequest,setBrowserRequest]=useState<string|null>(null);
  useEffect(()=>{if(!active)return;let stopped=false;let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{if(!pendingBrowser.current){
      const browser=await active.client.workspace<{result:string|null}>(active.connection.workspaceId,'/native',{command:'workspace_browser_request'});
      if(!stopped&&browser.result){pendingBrowser.current=browser.result;setBrowserRequest(browser.result);}
    }}catch{/* A disconnected workspace can retry on the next tick. */}
    finally{if(!stopped)timer=setTimeout(()=>void poll(),3000);}};
    void poll();return()=>{stopped=true;clearTimeout(timer);};},[active]);

  const [saved, setSaved] = useState<SavedWorkspaceTab[]>([]);
  useEffect(() => { void invoke<typeof saved>('execution_remote_list').then(setSaved).catch(() => {}); }, []);
  async function chooseSaved(id:string) {
    if (!canSwitchExecutionMode()) { setError('Save or close unsaved files before changing workspace.'); return; }
    setBusy(true);setError('');
    try { await invoke('execution_remote_activate',{id}); await setExecutionMode('remote'); }
    catch(e) {setError(String(e));setBusy(false);}
  }
  const [open, setOpen] = useState(onboarding);
  const [panelMounted,setPanelMounted]=useState(onboarding);
  const [progress,setProgress]=useState<WorkspaceProgressState|null>(null);
  useEffect(()=>{if(open)setPanelMounted(true);},[open]);
  const menuAnchor=useRef<HTMLButtonElement>(null);
  const [menuOpen,setMenuOpen]=useState(false),[menuBusy,setMenuBusy]=useState<string|null>(null),[menuError,setMenuError]=useState('');
  const [openRequest,setOpenRequest]=useState<{id:string;nonce:number}|null>(null);
  useEffect(()=>{const show=()=>setOpen(true);window.addEventListener('canopy:open-workspaces',show);return()=>window.removeEventListener('canopy:open-workspaces',show);},[]);
  const [desktop, setDesktop] = useState(false);
  const [endpoint, setEndpoint] = useState(active?.connection.endpoint ?? 'http://127.0.0.1:8787');
  const [token, setToken] = useState(active?.connection.token ?? '');
  const [workspaces, setWorkspaces] = useState<RemoteWorkspace[]>([]);
  const [error, setError] = useState('');
  const [copyAccounts,setCopyAccounts]=useState(false);
  const [notice,setNotice]=useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { const report=(event:Event)=>{setError(String((event as CustomEvent).detail));setOpen(true);};window.addEventListener('canopy:remote-login-error',report);return()=>window.removeEventListener('canopy:remote-login-error',report); }, []);
  async function choose(workspace?: RemoteWorkspace) {
    if (!canSwitchExecutionMode()) { setError('Save or close unsaved files before changing workspace.'); return; }
    setBusy(true); setError('');
    try {
      if (workspace) {
        const client = new RemoteExecutionClient(endpoint, token);
        await client.workspace(workspace.id, '/open', {resume:true});
        await invoke('execution_remote_set', {connection: {endpoint: client.endpoint, token, workspaceId: workspace.id, workspaceName: workspace.name}});
        if(copyAccounts)await invoke('execution_remote_import_accounts');
      }
      await setExecutionMode(workspace ? 'remote' : 'local');
    } catch (e) { setError(String(e)); setBusy(false); }
  }
  async function connect() {
    setBusy(true); setError(''); setWorkspaces([]);
    try { setWorkspaces((await new RemoteExecutionClient(endpoint, token).list()).workspaces); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  const workspaceTabs=buildWorkspaceTabs(saved,managed,active?{id:`${active.connection.endpoint}/${active.connection.workspaceId}`,endpoint:active.connection.endpoint,workspaceId:active.connection.workspaceId,workspaceName:active.connection.workspaceName}:null,previousTabs.current);
  const previousSelection=previousTabs.current.find(tab=>tab.id===selectedId);
  const resolvedSelectedId=workspaceTabs.some(tab=>tab.id===selectedId)?selectedId:workspaceTabs.find(tab=>tab.savedId&&tab.savedId===previousSelection?.savedId)?.id??(active&&selectedId===`${active.connection.endpoint}/${active.connection.workspaceId}`?activeId:selectedId);
  previousTabs.current=workspaceTabs;
  const selected=resolvedSelectedId==='local'?null:workspaceTabs.find(tab=>tab.id===resolvedSelectedId)??null;
  const selectedActive=resolvedSelectedId===activeId;
  const managedSelection=managed.find(w=>selected?.managedId===w.id);
  const legacySelection=managedSelection?.canRemoveConnection===true&&managedSelection.access?.owner!==false?managedSelection:undefined;
  const selectedManagedId=selected?.managedId;
  // A newly loaded account ID may normalize the chosen connection, but a poll
  // never changes which workspace the user is viewing.
  useEffect(()=>{if(resolvedSelectedId!==selectedId)setSelectedId(resolvedSelectedId);},[resolvedSelectedId,selectedId]);
  async function runSetup(command:string){
    // Native credential import targets the current execution connection only.
    if(!active||!selectedActive)return;
    setBusy(true);setError('');setNotice('');
    try{const result=await invoke<{imported?:string[];skipped?:string[];existingProfiles?:string[];skippedProfiles?:string[]}>(command);
      setNotice(command==='execution_remote_import_git'?'GitHub connected. Private repositories are ready to clone.':`${result.imported?.join(' and ')??'Agent'} accounts copied. Select an account when opening a new agent tab.${result.existingProfiles?.length?` Existing cloud profiles kept: ${result.existingProfiles.join(', ')}.`:''}${result.skipped?.length?` No local ${result.skipped.join(' or ')} login found.`:''}${result.skippedProfiles?.length?` Sign in within the cloud workspace for: ${result.skippedProfiles.join(', ')}. Their local credentials could not be copied.`:''}`);
    }catch(e){setError(String(e));}finally{setBusy(false);}
  }
  const rowFor=(tab:WorkspaceTab):WorkspaceMenuRow=>{
    const isActive=tab.id===activeId;
    if(tab.id==='local')return {id:'local',name:'Local workspace',kind:'local',detail:'This Mac',tone:'quiet',active:isActive};
    if(isActive&&active)return {id:tab.id,name:tab.workspaceName,kind:tab.managedId?'managed':'saved',detail:connectionLabel(connectionState),tone:connectionState.phase==='connected'?'running':connectionState.phase==='authentication-error'?'danger':'attention',active:true};
    const workspace=managed.find(w=>w.id===tab.managedId);
    if(workspace){const status=workspaceStatus(workspace),unavailable=workspace.access?.canConnect===false&&workspace.access?.canResume!==true;
      return {id:tab.id,name:tab.workspaceName,kind:'managed',detail:workspace.state==='stopped'?'Stopped · resumes when opened':status.label,tone:status.tone as WorkspaceMenuRow['tone'],active:false,disabled:unavailable?workspace.access?.connectionUnavailable??'Shared access pending':undefined};}
    return {id:tab.id,name:tab.workspaceName,kind:'saved',detail:'Saved host',tone:'quiet',active:false};
  };
  const menuRows=workspaceTabs.map(rowFor);
  async function pick(row:WorkspaceMenuRow){
    setMenuError('');
    if(row.active){setMenuOpen(false);return;}
    if(!canSwitchExecutionMode()){setMenuError('Save or close unsaved files before changing workspace.');return;}
    const tab=workspaceTabs.find(item=>item.id===row.id);
    // Resume and connect run in the background with their own progress popup.
    if(tab?.managedId){setMenuOpen(false);setOpenRequest({id:tab.managedId,nonce:Date.now()});return;}
    setMenuBusy(row.id);
    try{if(tab?.savedId){await invoke('execution_remote_activate',{id:tab.savedId});await setExecutionMode('remote');}else await setExecutionMode('local');setMenuOpen(false);}
    catch(error){setMenuError(String(error));}finally{setMenuBusy(null);}
  }
  return <>
    {menuOpen&&!onboarding&&<WorkspaceMenu anchor={menuAnchor.current} rows={menuRows} busyId={menuBusy} error={menuError} onClose={()=>setMenuOpen(false)} onPick={row=>void pick(row)} onNew={()=>{setMenuOpen(false);setError('');setOpen(true);setAdding(true);}} onManage={()=>{setMenuOpen(false);setSelectedId(activeId);setOpen(true);}}/>}
    {hibernateOperation&&createPortal(<WorkspaceHibernateProgress operation={hibernateOperation} minimized={hibernateMinimized} onMinimize={()=>setHibernateMinimized(true)} onExpand={()=>setHibernateMinimized(false)} onRetry={()=>void hibernateVm(hibernateOperation.progress.phase==='stopping-compute')} onDismiss={()=>{if(!stoppingVm)setHibernateOperation(null);}}/>,document.body)}
    {accountRemoval&&createPortal(<Dialog title={`Remove ${accountRemoval.name} connection?`} body="Remove this saved connection from your Canopy account. The VM keeps running until you stop it separately. Its disks, files, setup and usage history stay untouched." onDismiss={()=>{if(!busy)setAccountRemoval(null);}} actions={[{label:'Keep connection',onClick:()=>setAccountRemoval(null)},{label:busy?'Removing…':'Remove connection',disabled:busy||accountRemovalName!==accountRemoval.name,onClick:()=>void removeAccountConnection()}]}><label>Type the workspace name to confirm<TextInput aria-label="Workspace name confirmation" width="full" autoComplete="off" value={accountRemovalName} disabled={busy} onChange={event=>setAccountRemovalName(event.target.value)}/></label>{error&&<p role="alert">{error}</p>}</Dialog>,document.body)}
    {forgetConfirm&&createPortal(<Dialog title={`Remove ${selected?.workspaceName??'workspace'} connection?`} body="Remove this saved connection from this Mac. The workspace and its files stay on the remote host. This does not stop or delete the VM." onDismiss={()=>{if(!busy)setForgetConfirm(false);}} actions={[{label:'Cancel',onClick:()=>setForgetConfirm(false)},{label:busy?'Removing…':'Remove connection',onClick:()=>{if(!busy)void forgetConnection();}}]}/>,document.body)}
    {hibernateConfirm&&createPortal(<Dialog title={`Hibernate ${active?.connection.workspaceName??'workspace'}?`} body="Save all open projects, then stop this workspace’s compute. Running agents, terminals and jobs—including those used by other connected people—will stop. Files and account settings stay saved. Wake a project to start the workspace again." onDismiss={()=>{if(!stoppingVm)setHibernateConfirm(false);}} actions={[{label:'Cancel',onClick:()=>setHibernateConfirm(false)},{label:'Hibernate workspace',primary:true,onClick:()=>{if(!stoppingVm)void hibernateVm();}}]}/>,document.body)}
    {stopConfirm&&createPortal(<Dialog title={`Stop ${active?.connection.workspaceName??'workspace'}?`} body="Running agents, terminals and jobs will stop. Your files and setup will be saved. Canopy will return to your local workspace." onDismiss={()=>{if(!stoppingVm)setStopConfirm(false);}} actions={[{label:'Cancel',onClick:()=>setStopConfirm(false)},{label:stoppingVm?'Stopping…':'Stop workspace',primary:true,onClick:()=>{if(!stoppingVm)void stopVm();}}]}/>,document.body)}
    {!onboarding && <div className="workspace-header-group" aria-label="Execution workspace">
      <Button ref={menuAnchor} className="workspace-choice" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => {setMenuError('');setPanelMounted(true);setMenuOpen(value=>!value);}} title={active?`${active.connection.workspaceName} · ${connectionLabel(connectionState)}`:'Select workspace'}><span className={`workspace-location ${active ? connectionState.phase : ''}`} aria-label={active ? connectionLabel(connectionState) : 'Local'}>{active ? '●' : '⌂'}</span><span className="workspace-name">{active?.connection.workspaceName ?? 'Local workspace'}</span>{active&&connectionState.phase!=='connected'&&<span className="workspace-header-state">{connectionState.phase==='authentication-error'?'Sign in':connectionState.phase==='hibernated'?'Hibernated':connectionState.phase==='stopping'?'Stopping…':connectionState.phase==='connecting'?'Connecting…':'Reconnecting'}</span>}<span aria-hidden="true">⌄</span></Button>
      {active && <Button variant="ghost" icon onClick={() => setDesktop(true)} title={`Open ${active.connection.workspaceName} desktop`} aria-label="Open remote desktop">▣</Button>}
      {active&&onHibernateWorkspace&&<Button variant="ghost" icon disabled={stoppingVm||['stopping','hibernated'].includes(connectionState.phase)} onClick={()=>setHibernateConfirm(true)} title="Hibernate workspace — save all projects and stop compute" aria-label="Hibernate workspace">❄</Button>}
      {browserRequest && <Button variant="ghost" icon onClick={()=>{openLink(browserRequest,true);pendingBrowser.current=null;setBrowserRequest(null);}} title="Remote CLI sign-in needs your browser" aria-label="Open browser ↗">↗</Button>}
    </div>}
    {progress&&!hibernateOperation&&(!open||progress.workspaceId!==selectedManagedId)&&createPortal(<WorkspaceProgress progress={progress} onDetails={()=>{if(progress.workspaceId)setSelectedId(`managed:${progress.workspaceId}`);setOpen(true);}}/>,document.body)}
    {panelMounted && !adding && createPortal(<WorkspacePanel open={open} title="Workspaces" onClose={()=>setOpen(false)}><div className="workspace-tools">
      <div className="workspace-manage"><nav className="workspace-rail" aria-label="Workspace list"><div role="tablist" aria-orientation="vertical" aria-label="Workspaces">{workspaceTabs.map((workspace,index)=>{const row=rowFor(workspace);return <button type="button" role="tab" id={`workspace-tab-${index}`} aria-controls="workspace-controls" aria-selected={resolvedSelectedId===workspace.id} aria-label={workspace.workspaceName} aria-describedby={`workspace-tab-detail-${index}`} tabIndex={resolvedSelectedId===workspace.id?0:-1} className={`workspace-rail-row${resolvedSelectedId===workspace.id?' is-selected':''}`} key={workspace.id} onClick={()=>{setSelectedId(workspace.id);setNotice('');setError('');}} onKeyDown={event=>{let next=index;if(event.key==='ArrowDown')next=(index+1)%workspaceTabs.length;else if(event.key==='ArrowUp')next=(index-1+workspaceTabs.length)%workspaceTabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=workspaceTabs.length-1;else return;event.preventDefault();setSelectedId(workspaceTabs[next].id);setNotice('');setError('');document.getElementById(`workspace-tab-${next}`)?.focus();}}><span className="workspace-rail-name">{workspace.workspaceName}</span><span id={`workspace-tab-detail-${index}`} className={`workspace-rail-detail ${row.active?'running':row.tone}`}>{row.active?'● Active':row.detail}</span></button>;})}</div><Button size="sm" variant="ghost" onClick={()=>{setError('');setAdding(true);}}>＋ New workspace</Button></nav><div className="workspace-main">
      <div className={selectedManagedId?"workspace-lifecycle":"workspace-discovery"}><ManagedWorkspaces workspaceId={selectedManagedId??"__discovery__"} showAccount={false} onList={setManaged} onProgress={value=>setProgress(value?{...value,onStop:value.onStop?()=>{if(value.workspaceId)setSelectedId(`managed:${value.workspaceId}`);setOpen(true);value.onStop?.();}:undefined,onDelete:value.onDelete?()=>{if(value.workspaceId)setSelectedId(`managed:${value.workspaceId}`);setOpen(true);value.onDelete?.();}:undefined}:null)} onMinimize={()=>setOpen(false)} onDeleted={id=>{setSaved(items=>items.filter(item=>item.workspaceId!==id&&!item.id.endsWith('/'+id)));setSelectedId('local');}} openRequest={openRequest} onOpenFailed={id=>{setSelectedId(`managed:${id}`);setSection('overview');setOpen(true);}}/></div>
      {managedSelection&&<nav className="workspace-section-tabs" aria-label="Workspace sections">{(['overview','access','tools'] as const).map(item=><button type="button" key={item} aria-current={section===item?'page':undefined} className={section===item?'selected':''} onClick={()=>setSection(item)}>{item==='overview'?'Overview':item==='access'?'Access':'Tools & accounts'}</button>)}</nav>}
      {managedSelection&&section==='access'&&(managedSelection.access?.canManageAccess!==false?<WorkspaceSharing key={managedSelection.id} workspaceId={managedSelection.id} workspaceName={managedSelection.name}/>:<div className="workspace-section-empty"><h3>Your workspace access</h3><p>Your workspace owner manages team and individual permissions. Contact them to change your access.</p></div>)}
      {managedSelection&&section==='overview'&&<div className="workspace-overview"><div className="workspace-overview-copy"><h3>{managedSelection.state==='error'?'Preparation needs attention':selectedActive?'Your active workspace':managedSelection.state==='stopped'?'Workspace is stopped':'Ready when you are'}</h3><p>{managedSelection.state==='error'?'Preparation stopped before the workspace was ready. Retry to recover, or use More to stop it. Your saved files are kept.':managedSelection.state==='stopped'?'Compute is off. Resume this workspace to return to your projects. Files and setup stay saved.':'Projects, terminals and agents run together in this workspace.'}</p></div><button type="button" className="workspace-overview-access" onClick={()=>setSection('access')}><span><strong>Manage access</strong><small>Teams, people and workspace permissions</small></span><span aria-hidden="true">→</span></button></div>}
      {managedSelection&&section==='tools'&&managedSelection.access?.owner===true&&<WorkspaceOwnerTools key={managedSelection.id} workspaceId={managedSelection.id}/>}
      {managedSelection&&section==='tools'&&!selectedActive&&<p className="workspace-section-hint">Open this workspace to connect your personal accounts, import projects or use its desktop.</p>}
      {managedSelection&&section==='overview'&&<SharedSessionsPanel key={'sessions-'+managedSelection.id} workspaceId={managedSelection.id} owner={managedSelection.access?.owner===true}/>}
      <section id="workspace-controls" role="tabpanel" aria-labelledby={`workspace-tab-${workspaceTabs.findIndex(workspace=>workspace.id===resolvedSelectedId)}`} className="workspace-detail" hidden={!!managedSelection&&section!=='tools'}>
        {!selectedManagedId&&<div className="workspace-detail-heading"><div><strong>{selected?.workspaceName??'Local workspace'}</strong><small>{selected?'Remote workspace · files and processes run here':'This Mac · files and processes run on this device'}</small></div><span className="workspace-selected">{selectedActive?(active?connectionLabel(connectionState):'Active'):'Not active'}</span></div>}
        {!selectedActive&&!managedSelection?<div className="workspace-activate"><p>Switch to this workspace to use its projects, accounts and desktop.</p><Button variant="accent" disabled={busy} onClick={()=>selected?void chooseSaved(selected.savedId??selected.id):void choose()}>{busy?'Switching…':'Use this workspace'}</Button></div>:selectedActive&&active?<>
          {!['connected','stopping','hibernated'].includes(connectionState.phase)&&<div className="workspace-feedback error" role="status"><span>{connectionLabel(connectionState)}. {connectionState.phase==='authentication-error'?'Reconnect with an updated access token.':'Your files remain on the VM. Waiting for the host connection.'}</span><Button size="sm" disabled={busy} onClick={()=>{setBusy(true);void active.client.workspace(active.connection.workspaceId,'/open',{resume:true}).catch(e=>setError(String(e))).finally(()=>setBusy(false));}}>Retry now</Button></div>}
          <section className="workspace-card"><header><h3>Personal accounts</h3><p className="workspace-description">Sync agent accounts from this Mac, then pick which one new agents in {active.connection.workspaceName} launch as.</p></header><AccountSync workspaceName={active.connection.workspaceName}/></section>
          <section className="workspace-card"><header><h3>Git</h3></header><div className="workspace-action-row"><div><strong>GitHub & Git</strong><small>Repository access and commit identity</small></div><Button disabled={busy} onClick={()=>void runSetup('execution_remote_import_git')}>Connect GitHub</Button></div>{notice&&<p className="workspace-feedback" role="status">✓ {notice}</p>}</section>
          <section className="workspace-card workspace-utilities"><header><h3>Workspace tools</h3></header><div className="workspace-inline-actions"><Button onClick={()=>{setOpen(false);setDesktop(true);}}>▣ Open desktop</Button>{onHibernateWorkspace&&<Button disabled={stoppingVm||['stopping','hibernated'].includes(connectionState.phase)} onClick={()=>setHibernateConfirm(true)}>Hibernate workspace</Button>}{!managedSelection&&active.connection.workspaceId==='shoaib-work'&&<Button disabled={stoppingVm} onClick={()=>setStopConfirm(true)}>Stop workspace</Button>}</div><LocalProjectImport/>
          <details><summary>Browser sign-in</summary><p>Open a CLI sign-in link on this Mac, or use this workspace’s browser for a localhost callback.</p><label>Sign-in URL<TextInput width="full" type="url" autoComplete="off" placeholder="https://…" value={signInLink} onChange={e=>setSignInLink(e.target.value)}/></label><div className="workspace-inline-actions"><Button disabled={!/^https:\/\//i.test(signInLink)} onClick={()=>{openLink(signInLink,true);setSignInLink('');}}>Open on this Mac</Button><Button disabled={busy||!/^https:\/\//i.test(signInLink)} onClick={()=>{setBusy(true);setError('');void active.client.workspace(active.connection.workspaceId,'/desktop',{}).then(()=>active.client.workspace(active.connection.workspaceId,'/native',{command:'workspace_browser_open',args:{url:signInLink}})).then(()=>{setOpen(false);setDesktop(true);setSignInLink('');}).catch(e=>setError(String(e))).finally(()=>setBusy(false));}}>Open in {active.connection.workspaceName}</Button></div></details></section>
        </>:!selected?<p className="workspace-description">Projects, agent sign-ins and Git settings use this Mac. Open or create projects from the project tabs.</p>:null}
      </section>
      {legacySelection&&section==='tools'&&<div className="workspace-connection-remove"><Button size="sm" disabled={busy} onClick={()=>{setError('');setAccountRemovalName('');setAccountRemoval(legacySelection);}}>Remove connection from account</Button><small>The VM, disks, files and usage history are kept. Compute is not stopped.</small></div>}
      {selected&&!selectedManagedId&&<div className="workspace-connection-remove"><Button size="sm" disabled={busy} onClick={()=>setForgetConfirm(true)}>Remove saved connection</Button><small>Removes it from this Mac. Remote files stay on the host.</small></div>}
      {error && <p className="workspace-feedback error" role="alert">{error}</p>}
    </div></div></div></WorkspacePanel>, document.body)}
    {open && adding && createPortal(<Dialog title="Cloud workspaces" body="Sign in once, then open a workspace from your account." size="md" dismissLabel="Back" onDismiss={()=>{setAdding(false);setError('');}}><div className="workspace-tools"><ManagedWorkspaces showList={false}/><CreateWorkspace onCreated={()=>setAdding(false)}/><details><summary>Advanced: connect your own host</summary><label>Remote host<TextInput width="full" value={endpoint} onChange={e => setEndpoint(e.target.value)} autoComplete="off" /></label><label>Access token<TextInput width="full" type="password" value={token} onChange={e => setToken(e.target.value)} autoComplete="off" /></label><Button disabled={busy || !token} onClick={() => void connect()}>{busy ? 'Connecting…' : 'Find workspaces'}</Button>{!!workspaces.length && <Checkbox checked={copyAccounts} onChange={setCopyAccounts} label="Copy local Claude and Codex accounts" hint="One-time copy into the workspace you select."/>}{workspaces.map(workspace => <Button key={workspace.id} disabled={busy} onClick={() => void choose(workspace)}>{workspace.name}</Button>)}{error&&<p className="workspace-feedback error" role="alert">{error}</p>}</details></div></Dialog>,document.body)}
    {desktop && active && createPortal(<div className="remote-workspace-overlay"><section className="workspace-desktop" role="dialog" aria-modal="true" aria-label="Workspace desktop"><RemoteDesktop client={active.client} workspaceId={active.connection.workspaceId} workspaceName={active.connection.workspaceName} onClose={() => setDesktop(false)} /></section></div>, document.body)}
  </>;
}
