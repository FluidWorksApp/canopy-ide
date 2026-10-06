/** Native menus can consume the key before Monaco sees it. Route their action
 * to the focused surface, rather than selecting the surrounding application. */
const targets=new Map<HTMLElement,()=>void>();
export function registerSelectAll(element:HTMLElement,select:()=>void){targets.set(element,select);return()=>{targets.delete(element);};}
export function selectAllFocused(){
 const focused=document.activeElement;
 for(const [element,select] of targets)if(focused&&element.contains(focused)){select();return;}
 if(focused instanceof HTMLInputElement||focused instanceof HTMLTextAreaElement){focused.select();return;}
 if(focused instanceof HTMLElement&&focused.isContentEditable)document.execCommand('selectAll');
}
