import {it,expect,vi} from 'vitest';
import {render,screen,fireEvent,act} from '@testing-library/react';
const mock=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mock.invoke}));
import {LocalProjectImport} from './LocalProjectImport';
it('registers local folders before Git inspection and enables valid project selection',async()=>{
 let scoped=false;mock.invoke.mockImplementation(async(command,args)=>{
 if(command==='store_load')return JSON.stringify({projects:[{id:'p',name:'Product',components:[{id:'c',label:'App',path:'/local/app'}]}]});
 if(command==='workspace_add'){scoped=true;return args.path;}
 if(command==='git_repos')return scoped?[{path:'/local/app'}]:[];
 if(command==='git_remote_url')return 'https://github.com/example/app';
 });
 render(<LocalProjectImport/>);fireEvent.click(screen.getByText('Import local projects'));fireEvent.click(screen.getByRole('button',{name:'Find local projects'}));await act(async()=>{});
 const checkbox=screen.getByRole('checkbox',{name:/Product/});expect(checkbox).not.toBeDisabled();fireEvent.click(checkbox);expect(checkbox).toBeChecked();expect(screen.getByRole('button',{name:'Import 1 project'})).not.toBeDisabled();
});
it('keeps valid components selectable when another component has no repository',async()=>{
 mock.invoke.mockImplementation(async(command,args)=>{
 if(command==='store_load')return JSON.stringify({projects:[{id:'p2',name:'Grouped project',components:[{id:'good',label:'Frontend',path:'/local/frontend'},{id:'bad',label:'Missing repo',path:'/local/missing'}]}]});
 if(command==='workspace_add')return args.path;
 if(command==='git_repos')return args.components[0][1]==='/local/frontend'?[{path:'/local/frontend'}]:[];
 if(command==='git_remote_url')return 'https://github.com/example/frontend';
 });
 render(<LocalProjectImport/>);fireEvent.click(screen.getByText('Import local projects'));fireEvent.click(screen.getByRole('button',{name:'Find local projects'}));await act(async()=>{});
 expect(screen.getByRole('checkbox',{name:'Missing repo'})).toBeDisabled();
 const project=screen.getByRole('checkbox',{name:'Grouped project'});expect(project).not.toBeDisabled();fireEvent.click(project);
 expect(screen.getByRole('checkbox',{name:'Frontend'})).toBeChecked();expect(screen.getByText('1 of 2 selected')).toBeTruthy();
});
