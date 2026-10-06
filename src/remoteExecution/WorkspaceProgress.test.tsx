import {it,expect,vi} from 'vitest';
import {render,screen,fireEvent} from '@testing-library/react';
import {WorkspaceProgress} from './WorkspaceProgress';
import {WorkspacePanel} from './WorkspacePanel';
it('collapses to compact progress without cancelling startup and keeps the IDE available',()=>{
 const details=vi.fn();render(<><button>Editor action</button><WorkspaceProgress progress={{name:'Machine Works',step:2,elapsed:169,message:'Preparing tools'}} onDetails={details}/></>);
 expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext','Starting services');
 fireEvent.click(screen.getByRole('button',{name:'Collapse workspace progress'}));
 expect(screen.queryByText(/Preparing tools/)).toBeNull();expect(screen.getByRole('progressbar')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Editor action'}));
 fireEvent.click(screen.getByRole('button',{name:'Expand workspace progress'}));fireEvent.click(screen.getByRole('button',{name:'Details'}));expect(details).toHaveBeenCalledOnce();
});
it('workspace panel has no modal focus trap or document scroll lock and retains children when collapsed',()=>{
 const close=vi.fn();const {rerender}=render(<WorkspacePanel open title="Workspaces" onClose={close}><input aria-label="Workspace filter" defaultValue="Saved"/></WorkspacePanel>);
 expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal','false');expect(document.body.style.overflow).not.toBe('hidden');
 rerender(<WorkspacePanel open={false} title="Workspaces" onClose={close}><input aria-label="Workspace filter" defaultValue="Saved"/></WorkspacePanel>);
 expect(screen.queryByRole('dialog')).toBeNull();expect(screen.getByLabelText('Workspace filter')).toHaveValue('Saved');
});
it('offers Stop and Delete from floating progress without directly mutating the workspace',()=>{
 const stop=vi.fn(),remove=vi.fn();render(<WorkspaceProgress progress={{name:'Machine Works',step:2,elapsed:12,message:'Preparing',onStop:stop,onDelete:remove}} onDetails={()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:'Stop'}));fireEvent.click(screen.getByRole('button',{name:'Delete'}));expect(stop).toHaveBeenCalledOnce();expect(remove).toHaveBeenCalledOnce();
});
