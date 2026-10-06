import {useState} from 'react';
import {Button} from '../components/ui';
import {WorkspaceSelector} from './WorkspaceSelector';
import {activeWorkspace} from './workspace';
export function StartupRecovery({message}:{message:string}){
 const [workspaces,setWorkspaces]=useState(false);
 const active=activeWorkspace();
 return <main className="startup-recovery"><section><div className="pd-section-head">Canopy</div><h1>{active?'Connecting to workspace':'Starting Canopy'}</h1>{active&&<strong>{active.connection.workspaceName}</strong>}<p role="status">{message}</p>{active&&<p className="workspace-description">Your workspace files are stored on the VM. Canopy will reconnect when its services are ready.</p>}<div className="workspace-inline-actions"><Button onClick={()=>window.location.reload()}>Retry now</Button><Button onClick={()=>setWorkspaces(true)}>Choose workspace</Button></div>{workspaces&&<WorkspaceSelector onboarding/>}</section></main>;
}
