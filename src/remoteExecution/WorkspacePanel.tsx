import {useEffect,useRef,type ReactNode} from 'react';
import {Button} from '../components/ui';
import {useEscapeLayer} from '../useEscape';
/** Workspace management as a modal dialog: backdrop, focus kept inside, Esc or
 * backdrop click closes. Quick switching lives in the header dropdown. The
 * backdrop sits below the shared Dialog (z 900) so confirmations opened from
 * here appear on top of it. */
export function WorkspacePanel({open,title,onClose,children}:{open:boolean;title:string;onClose:()=>void;children:ReactNode}){
 const panel=useRef<HTMLElement>(null);
 const opener=useRef<Element|null>(null);
 // On the overlay stack while open: Escape closes this panel (or a confirm on
 // top of it first) and never reaches the agent terminal behind it, even when
 // focus never left that terminal. Registered before the focus effect so a
 // terminal that had focus is parked first and given back on close.
 useEscapeLayer(open,{onEscape:onClose});
 useEffect(()=>{
  if(open){opener.current=document.activeElement;panel.current?.focus();}
  else if(opener.current instanceof HTMLElement){opener.current.focus();opener.current=null;}
 },[open]);
 function keys(event:React.KeyboardEvent){
  if(event.key!=='Tab'||!panel.current)return;
  const focusable=[...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),summary')].filter(el=>el.offsetParent!==null||el===document.activeElement);
  if(!focusable.length)return;
  const first=focusable[0],last=focusable[focusable.length-1];
  if(event.shiftKey&&(document.activeElement===first||document.activeElement===panel.current)){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
 }
 return <div hidden={!open} className="workspace-panel-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
  <section ref={panel} tabIndex={-1} className="workspace-panel" role="dialog" aria-modal="true" aria-label={title} onKeyDown={keys}>
   <header><h2>{title}</h2><Button icon variant="ghost" title="Close" aria-label="Close workspaces" onClick={onClose}>×</Button></header>
   <div className="workspace-panel-content">{children}</div>
  </section>
 </div>;
}
