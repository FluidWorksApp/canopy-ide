import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';

export type WorkspaceMenuRow={id:string;name:string;kind:'local'|'saved'|'managed';detail:string;tone:'running'|'attention'|'quiet'|'danger';active:boolean;disabled?:string};

/** The header switcher: one row per workspace, one click to switch. Anything
 * that needs more than a click (resume progress, sign-in, errors) surfaces in
 * its own popup rather than in this menu. */
export function WorkspaceMenu({anchor,rows,busyId,error,onPick,onManage,onNew,onClose}:{anchor:HTMLElement|null;rows:WorkspaceMenuRow[];busyId:string|null;error:string;onPick:(row:WorkspaceMenuRow)=>void;onManage:()=>void;onNew:()=>void;onClose:()=>void}){
 const menu=useRef<HTMLDivElement>(null);
 const [position,setPosition]=useState<{top:number;right:number}|null>(null);
 useLayoutEffect(()=>{if(!anchor)return;const place=()=>{const rect=anchor.getBoundingClientRect();setPosition({top:rect.bottom+6,right:Math.max(8,window.innerWidth-rect.right)});};place();window.addEventListener('resize',place);return()=>window.removeEventListener('resize',place);},[anchor]);
 useEffect(()=>{const items=menu.current?.querySelectorAll<HTMLElement>('[role^=menuitem]:not([aria-disabled=true])');(menu.current?.querySelector<HTMLElement>('[aria-checked=true]')??items?.[0])?.focus();},[]);
 useEffect(()=>{
  const down=(event:MouseEvent)=>{const target=event.target as Node;if(!menu.current?.contains(target)&&!anchor?.contains(target))onClose();};
  document.addEventListener('mousedown',down);return()=>document.removeEventListener('mousedown',down);
 },[anchor,onClose]);
 function keys(event:React.KeyboardEvent){
  if(event.key==='Escape'){event.stopPropagation();onClose();anchor?.focus();return;}
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  const items=[...(menu.current?.querySelectorAll<HTMLElement>('[role^=menuitem]:not([aria-disabled=true])')??[])];if(!items.length)return;
  const index=items.indexOf(document.activeElement as HTMLElement);
  const next=event.key==='Home'?0:event.key==='End'?items.length-1:event.key==='ArrowDown'?(index+1)%items.length:(index-1+items.length)%items.length;
  event.preventDefault();items[next].focus();
 }
 return createPortal(<div ref={menu} className="workspace-menu" role="menu" aria-label="Switch workspace" style={position?{top:position.top,right:position.right}:{visibility:'hidden'}} onKeyDown={keys}>
  <div className="workspace-menu-heading">Workspaces</div>
  {rows.map(row=>{const busy=busyId===row.id;return <button type="button" role="menuitemradio" aria-checked={row.active} aria-disabled={!!row.disabled||!!busyId} key={row.id} title={row.disabled} className={`workspace-menu-row${row.active?' is-active':''}`} onClick={()=>{if(!row.disabled&&!busyId)onPick(row);}}>
   <span className={`workspace-menu-icon ${row.kind}`} aria-hidden="true">{row.kind==='local'?<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M5.5 13.5h5"/></svg>:<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2" y="2.5" width="12" height="4.5" rx="1.2"/><rect x="2" y="9" width="12" height="4.5" rx="1.2"/><path d="M4.5 4.75h.01M4.5 11.25h.01"/></svg>}</span>
   <span className="workspace-menu-text"><span className="workspace-menu-name">{row.name}</span><span className={`workspace-menu-detail ${row.tone}`}>{busy?'Switching…':row.disabled??row.detail}</span></span>
   <span className="workspace-menu-check" aria-hidden="true">{row.active?'✓':''}</span>
  </button>;})}
  {error&&<p className="workspace-menu-error" role="alert">{error}</p>}
  <div className="workspace-menu-sep" role="separator"/>
  <button type="button" role="menuitem" className="workspace-menu-action" onClick={onNew}><span aria-hidden="true">＋</span>New workspace…</button>
  <button type="button" role="menuitem" className="workspace-menu-action" onClick={onManage}><span aria-hidden="true">⚙</span>Manage workspaces…</button>
 </div>,document.body);
}
