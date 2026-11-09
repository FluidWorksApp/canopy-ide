import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {it,expect,vi,afterEach} from 'vitest';
import {WorkspaceMenu,type WorkspaceMenuRow} from './WorkspaceMenu';
afterEach(cleanup);
const anchor=()=>document.body.appendChild(document.createElement('button'));
it('shows why a shared workspace cannot be opened and does not switch to it',()=>{
 const reason='Sharing isn’t turned on for this workspace yet. Ask the owner to turn it on.';
 const rows:WorkspaceMenuRow[]=[{id:'local',name:'Local workspace',kind:'local',detail:'This Mac',tone:'quiet',active:true},{id:'managed:off',name:'Design',kind:'managed',detail:'Running',tone:'running',active:false,disabled:reason}];
 const pick=vi.fn();render(<WorkspaceMenu anchor={anchor()} rows={rows} busyId={null} error="" onPick={pick} onAllWorkspaces={vi.fn()} onManage={vi.fn()} onNew={vi.fn()} onClose={vi.fn()}/>);
 const row=screen.getByRole('menuitemradio',{name:/Design/});
 expect(row).toHaveAttribute('aria-disabled','true');expect(row).toHaveAttribute('title',reason);expect(row).toHaveTextContent(reason);
 fireEvent.click(row);expect(pick).not.toHaveBeenCalled();
});
it('offers all, new, and manage actions with keyboard navigation',()=>{
 const all=vi.fn(),close=vi.fn();
 const opener=anchor();
 render(<WorkspaceMenu anchor={opener} rows={[{id:'local',name:'Local workspace',kind:'local',detail:'This Mac',tone:'quiet',active:true}]} busyId={null} error="" onPick={vi.fn()} onAllWorkspaces={all} onManage={vi.fn()} onNew={vi.fn()} onClose={close}/>);
 const menu=screen.getByRole('menu',{name:'Switch workspace'});
 const actions=screen.getAllByRole('menuitem');
 expect(screen.getByRole('menuitem',{name:'All workspaces…'})).toBeInTheDocument();
 expect(screen.getByRole('menuitem',{name:'New workspace…'})).toBeInTheDocument();
 expect(screen.getByRole('menuitem',{name:'Manage workspaces…'})).toBeInTheDocument();
 fireEvent.keyDown(menu,{key:'End'});expect(actions.at(-1)).toHaveFocus();
 fireEvent.keyDown(menu,{key:'Home'});expect(screen.getByRole('menuitemradio',{name:/Local workspace/})).toHaveFocus();
 fireEvent.click(screen.getByRole('menuitem',{name:'All workspaces…'}));expect(all).toHaveBeenCalledOnce();
 fireEvent.keyDown(document,{key:'Escape'});expect(close).toHaveBeenCalledOnce();expect(opener).toHaveFocus();
});
