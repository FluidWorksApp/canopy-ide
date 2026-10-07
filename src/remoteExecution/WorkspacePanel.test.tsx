import {render,screen,fireEvent} from '@testing-library/react';
import {it,expect,vi} from 'vitest';
import {WorkspacePanel} from './WorkspacePanel';
it('is a modal dialog that closes on Escape and on a backdrop click, not on clicks inside',()=>{
 const onClose=vi.fn();
 render(<WorkspacePanel open title="Workspaces" onClose={onClose}><button type="button">Inside</button></WorkspacePanel>);
 const dialog=screen.getByRole('dialog',{name:'Workspaces'});
 expect(dialog.getAttribute('aria-modal')).toBe('true');
 fireEvent.mouseDown(screen.getByRole('button',{name:'Inside'}));expect(onClose).not.toHaveBeenCalled();
 fireEvent.keyDown(dialog,{key:'Escape'});expect(onClose).toHaveBeenCalledTimes(1);
 fireEvent.mouseDown(dialog.parentElement!);expect(onClose).toHaveBeenCalledTimes(2);
 fireEvent.click(screen.getByRole('button',{name:'Close workspaces'}));expect(onClose).toHaveBeenCalledTimes(3);
});
it('renders nothing visible while closed',()=>{
 render(<WorkspacePanel open={false} title="Workspaces" onClose={()=>{}}><span>Body</span></WorkspacePanel>);
 expect(screen.queryByRole('dialog')).toBeNull();
});
