import {useEffect,useRef,type ReactNode} from 'react';
import {Button} from '../components/ui';
/** A workspace utility surface: no scrim, body lock, or focus trap. */
export function WorkspacePanel({open,title,onClose,children}:{open:boolean;title:string;onClose:()=>void;children:ReactNode}){
 const panel=useRef<HTMLElement>(null);
 useEffect(()=>{if(open)panel.current?.focus();},[open]);
 return <section hidden={!open} ref={panel} tabIndex={-1} className="workspace-panel" role="dialog" aria-modal="false" aria-label={title} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();onClose();}}}>
  <header><h2>{title}</h2><Button icon variant="ghost" title="Collapse workspace panel" aria-label="Collapse workspace panel" onClick={onClose}>−</Button></header>
  <div className="workspace-panel-content">{children}</div>
 </section>;
}
