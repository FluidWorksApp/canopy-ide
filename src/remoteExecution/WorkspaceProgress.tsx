import {useState} from 'react';
import {Button} from '../components/ui';
export type WorkspaceProgressState={workspaceId?:string;name:string;step:number;elapsed:number;message:string;onStop?:()=>void;onDelete?:()=>void};
const steps=['Starting machine','Connecting saved files','Starting services','Checking connection','Ready'];
export function WorkspaceProgress({progress,onDetails}:{progress:WorkspaceProgressState;onDetails:()=>void}){
 const [collapsed,setCollapsed]=useState(false);
 return <aside className={`workspace-progress-float${collapsed?' collapsed':''}`} aria-label="Workspace progress">
  <div className="workspace-progress-line"><span className="workspace-progress-dot" aria-hidden="true"/><strong>{progress.name}</strong><span role="status">{steps[progress.step]}</span><Button icon variant="ghost" aria-label={collapsed?'Expand workspace progress':'Collapse workspace progress'} title={collapsed?'Expand':'Collapse'} onClick={()=>setCollapsed(!collapsed)}>{collapsed?'＋':'−'}</Button></div>
  <div className="workspace-progress-track" role="progressbar" aria-label="Workspace startup stages" aria-valuemin={0} aria-valuemax={5} aria-valuenow={progress.step} aria-valuetext={steps[progress.step]}><span style={{width:`${(progress.step+0.5)/5*100}%`}}/></div>
  {!collapsed&&<div className="workspace-progress-meta"><small>{Math.floor(progress.elapsed/60)}m {progress.elapsed%60}s · {progress.message}</small><div className="workspace-inline-actions"><Button size="sm" onClick={onDetails}>Details</Button>{progress.onStop&&<Button size="sm" onClick={progress.onStop}>Stop</Button>}{progress.onDelete&&<Button size="sm" variant="danger" onClick={progress.onDelete}>Delete</Button>}</div></div>}
 </aside>;
}
