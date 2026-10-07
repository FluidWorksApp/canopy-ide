import {render,screen,fireEvent} from '@testing-library/react';
import {it,expect,vi} from 'vitest';
import {WorkspaceHero} from './WorkspaceHero';
const workspace={id:'synthetic',name:'Machine Works',state:'error',cpu_max:8,memory_max_mib:32768,canDelete:true};
it('gives an attention state one recovery action and keeps destructive actions behind More',()=>{
 const open=vi.fn(),stop=vi.fn(),remove=vi.fn();render(<WorkspaceHero workspace={workspace} onOpen={open} onStop={stop} onDelete={remove}/>);
 expect(screen.getByText('Needs attention')).toBeInTheDocument();expect(screen.queryByText(/^error$/)).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Retry preparation'}));expect(open).toHaveBeenCalledOnce();expect(stop).not.toHaveBeenCalled();expect(remove).not.toHaveBeenCalled();
 const more=screen.getByLabelText('More actions for Machine Works');more.closest('details')!.open=true;
 fireEvent.click(screen.getByRole('button',{name:/Stop workspace/}));expect(stop).toHaveBeenCalledOnce();expect(more.closest('details')).not.toHaveAttribute('open');
});
it('names the fresh-machine restart when the control plane says Retry will replace the host',()=>{
 const open=vi.fn();render(<WorkspaceHero workspace={{...workspace,operation:{phase:'preparing-workspace',status:'failed',action:'resume',bootstrap_report:{stage:'image',status:'failed'},retry_replaces_host:true}}} onOpen={open}/>);
 expect(screen.queryByRole('button',{name:'Retry preparation'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Restart on a fresh machine'}));expect(open).toHaveBeenCalledOnce();
});
