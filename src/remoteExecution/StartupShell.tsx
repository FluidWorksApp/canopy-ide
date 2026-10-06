import {Component,useState,type ReactNode} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Button} from '../components/ui';
import {setExecutionMode} from '../executionMode';
import {startupRoot} from '../startupRoot';
import {cancelStartupWork} from './startupWork';
import {WorkspaceSelector} from './WorkspaceSelector';
import './workspace.css';
import './startupLauncher.css';
export function startupDiagnostic(stage:'begin'|'unavailable'|'selector-error'|'local-choice'|'connected'){
 void invoke('js_log',{level:'boot',message:`startup-stage:${stage}`}).catch(()=>{});
}
class StartupSelectorBoundary extends Component<{children:ReactNode},{failed:boolean}>{
 state={failed:false};static getDerivedStateFromError(){return {failed:true};}
 componentDidCatch(){startupDiagnostic('selector-error');}
 render(){return this.state.failed?<p role="alert">Workspace selection could not load. Retry Canopy, or choose this Mac below.</p>:this.props.children;}
}
export function StartupShell({message,chooseWorkspace=false,workspaceName}:{message:string;chooseWorkspace?:boolean;workspaceName?:string}){
 const [picker,setPicker]=useState(false),[attempt,setAttempt]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function chooseLocal(){cancelStartupWork();startupDiagnostic('local-choice');setBusy(true);setError('');try{await setExecutionMode('local');}catch{setError('Could not select this Mac. Try again.');setBusy(false);}}
 return <main className="startup-launcher" aria-label="Canopy startup recovery"><section className="startup-launcher-content">
  <div className="startup-launcher-brand"><svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M6 17a10 10 0 0 1 20 0" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/><rect x="4" y="16" width="6" height="8" rx="3" fill="currentColor"/><rect x="22" y="16" width="6" height="8" rx="3" fill="currentColor"/><path d="M13 27h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>Canopy</div>
  <h1>{chooseWorkspace?'Where would you like to work?':'Opening Canopy'}</h1>
  <p className="startup-launcher-intro">{chooseWorkspace?'Connect to a remote workspace, or continue locally on this Mac.':'Checking your workspace before opening your projects.'}</p>
  <p className="startup-launcher-status" role="status">{message}</p>
  {chooseWorkspace?<><div className="startup-launcher-remote"><div className="startup-launcher-workspace"><span className="startup-launcher-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6"/></svg></span><div className="startup-launcher-identity"><strong>{workspaceName||'Remote workspace'}</strong><span>Cloud workspace</span></div><span className="startup-launcher-badge"><i/>Not connected</span></div><footer><small>Choose Resume in Workspaces to start compute.</small><Button variant="accent" disabled={busy} onClick={()=>{setAttempt(value=>value+1);setPicker(true);}}>Choose workspace</Button></footer></div></>:<div className="startup-launcher-wait">{message}<div className="startup-launcher-loader" aria-hidden="true"/><Button disabled={busy} onClick={()=>{setAttempt(value=>value+1);setPicker(true);}}>Choose workspace</Button></div>}
  <div className="startup-launcher-local"><span className="startup-launcher-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="4" y="3" width="16" height="13" rx="2"/><path d="M2 20h20M9 16v4m6-4v4"/></svg></span><div className="startup-launcher-identity"><strong>This Mac</strong><span>Local projects and accounts</span></div><Button disabled={busy} onClick={()=>void chooseLocal()}>{busy?'Opening…':'Use this Mac'}</Button></div>
  {chooseWorkspace&&<details className="startup-launcher-details"><summary>Connection details</summary><p>{message}</p><Button size="sm" disabled={busy} onClick={()=>window.location.reload()}>Retry connection</Button></details>}
  {error&&<p className="startup-launcher-error" role="alert">{error}</p>}{picker&&<StartupSelectorBoundary key={attempt}><WorkspaceSelector onboarding/></StartupSelectorBoundary>}
 </section></main>;
}
export function renderStartupShell(message:string,chooseWorkspace=false,workspaceName?:string){startupRoot().render(<StartupShell message={message} chooseWorkspace={chooseWorkspace} workspaceName={workspaceName}/>);}
