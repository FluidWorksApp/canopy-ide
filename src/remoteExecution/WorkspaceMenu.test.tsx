import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {it,expect,vi,afterEach} from 'vitest';
import {WorkspaceMenu,type WorkspaceMenuRow} from './WorkspaceMenu';
afterEach(cleanup);
it('shows why a shared workspace cannot be opened and does not switch to it',()=>{
 const reason='Sharing isn’t turned on for this workspace yet. Ask the owner to turn it on.';
 const rows:WorkspaceMenuRow[]=[{id:'local',name:'Local workspace',kind:'local',detail:'This Mac',tone:'quiet',active:true},{id:'managed:off',name:'Design',kind:'managed',detail:'Running',tone:'running',active:false,disabled:reason}];
 const pick=vi.fn();const anchor=document.body.appendChild(document.createElement('button'));render(<WorkspaceMenu anchor={anchor} rows={rows} busyId={null} error="" onPick={pick} onManage={vi.fn()} onNew={vi.fn()} onClose={vi.fn()}/>);
 const row=screen.getByRole('menuitemradio',{name:/Design/});
 expect(row).toHaveAttribute('aria-disabled','true');expect(row).toHaveAttribute('title',reason);expect(row).toHaveTextContent(reason);
 fireEvent.click(row);expect(pick).not.toHaveBeenCalled();
});
