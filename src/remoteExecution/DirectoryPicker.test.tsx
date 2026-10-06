import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {describe,it,expect,vi} from 'vitest';
import {DirectoryPicker} from './DirectoryPicker';
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));vi.mock('../host',()=>({invoke:mocks.invoke}));
describe('remote directory selection',()=>{
 it('selects multiple components using VM paths',async()=>{
  mocks.invoke.mockResolvedValue([{name:'web',path:'/workspace/web',is_dir:true,is_symlink:false},{name:'api',path:'/workspace/api',is_dir:true,is_symlink:false},{name:'escape',path:'/workspace/escape',is_dir:true,is_symlink:true}]);
  const select=vi.fn(),cancel=vi.fn();render(<DirectoryPicker multiple onSelect={select} onCancel={cancel}/>);
  await screen.findByLabelText('Select web');expect(screen.queryByText('escape/')).toBeNull();
  fireEvent.click(screen.getByLabelText('Select web'));fireEvent.click(screen.getByLabelText('Select api'));fireEvent.click(screen.getByRole('button',{name:'Use 2 folders'}));
  expect(select).toHaveBeenCalledWith(['/workspace/web','/workspace/api']);expect(cancel).not.toHaveBeenCalled();
 });
 it('creates and selects a folder in the remote workspace',async()=>{
  mocks.invoke.mockResolvedValue([]);const select=vi.fn();render(<DirectoryPicker onSelect={select} onCancel={()=>{}}/>);
  await waitFor(()=>expect(screen.getByRole('button',{name:'Use this folder'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:'＋ New folder'}));
  fireEvent.change(screen.getByLabelText('New folder'),{target:{value:'project'}});fireEvent.click(screen.getByRole('button',{name:'Create folder'}));
  await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('fs_create_dir',{path:'/workspace/project'}));
  await screen.findByText('/workspace/project');await waitFor(()=>expect(screen.getByRole('button',{name:'Use this folder'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'Use this folder'}));expect(select).toHaveBeenCalledWith(['/workspace/project']);
 });
});

it('validates a typed upload destination before allowing selection',async()=>{
 mocks.invoke.mockImplementation(async(_command,args)=>{if(args.path==='/workspace/missing')throw Error('Directory not found');return [];});
 const select=vi.fn();render(<DirectoryPicker initialPath="/workspace/repo" editablePath title="Upload to remote workspace" confirmLabel="Choose files…" onSelect={select} onCancel={()=>{}}/>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Choose files…'})).toBeEnabled());
 fireEvent.change(screen.getByLabelText('Destination'),{target:{value:'/workspace/missing'}});
 expect(screen.getByRole('button',{name:'Choose files…'})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'Go'}));
 await screen.findByRole('alert');expect(screen.getByRole('button',{name:'Choose files…'})).toBeDisabled();
 fireEvent.change(screen.getByLabelText('Destination'),{target:{value:'/workspace/other'}});fireEvent.click(screen.getByRole('button',{name:'Go'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Choose files…'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'Choose files…'}));expect(select).toHaveBeenCalledWith(['/workspace/other']);
});
