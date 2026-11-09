import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';

const tauri=vi.fn(),host=vi.fn();
vi.mock('@tauri-apps/api/core',()=>({invoke:(c:string,a?:unknown)=>tauri(c,a)}));
vi.mock('../host',()=>({invoke:(c:string,a?:unknown)=>host(c,a),invokeDesktop:(c:string,a?:unknown)=>tauri(c,a)}));
import {ProjectSetupDialog} from './ProjectSetupDialog';

const component={componentId:'c1',label:'web'};
const candidates=[
 {path:'.env',size:12,category:'secret'},
 {path:'config/local.json',size:30,category:'config'},
 {path:'data/dev.sqlite',size:2048,category:'data'},
 {path:'notes.txt',size:5,category:'other'},
];
beforeEach(()=>{
 tauri.mockReset();host.mockReset();
 tauri.mockImplementation(async(c:string)=>{
  if(c==='execution_mirror_candidates')return {relative:'',files:candidates};
  if(c==='execution_mirror_inspect')return [];
  if(c==='store_load')return 'null';
  return {};
 });
 host.mockImplementation(async()=>'{"projects":[],"openIds":[]}');
});

it('groups candidate files by category and leaves secret-looking ones unchecked with a warning',async()=>{
 render(<ProjectSetupDialog projectId="p1" projectName="Shop" workspaceName="Studio" components={[component]}/>);
 expect(await screen.findByLabelText(/config\/local\.json/)).toBeTruthy();
 expect((screen.getByLabelText(/^\.env/) as HTMLInputElement).checked).toBe(false);
 expect((screen.getByLabelText(/config\/local\.json/) as HTMLInputElement).checked).toBe(true);
 expect((screen.getByLabelText(/data\/dev\.sqlite/) as HTMLInputElement).checked).toBe(true);
 expect(screen.getByText(/look like credentials/i)).toBeTruthy();
 for(const heading of ['Secrets','Config','Data','Other'])expect(screen.getByText(heading)).toBeTruthy();
 expect((screen.getByLabelText(/Copy missing files only/) as HTMLInputElement).checked).toBe(true);
 expect((screen.getByLabelText(/Install dependencies/) as HTMLInputElement).checked).toBe(true);
});

it('sends nothing until the button is pressed, then sets up only the chosen files',async()=>{
 render(<ProjectSetupDialog projectId="p1" projectName="Shop" workspaceName="Studio" components={[component]}/>);
 await screen.findByLabelText(/config\/local\.json/);
 expect(tauri.mock.calls.some(c=>c[0]==='execution_mirror_send')).toBe(false);
 fireEvent.click(screen.getByLabelText(/^\.env/));
 fireEvent.click(screen.getByLabelText(/notes\.txt/));
 fireEvent.click(screen.getByRole('button',{name:'Set up on Studio'}));
 // The project is not on this Mac per the mocked inspection, which the progress view reports.
 expect(await screen.findByText(/not on this Mac/)).toBeTruthy();
 await waitFor(()=>expect(tauri).toHaveBeenCalledWith('execution_mirror_inspect',undefined));
});

it('shows why candidates could not be read',async()=>{
 tauri.mockRejectedValue(new Error('This folder is not a Git repository'));
 render(<ProjectSetupDialog projectId="p1" projectName="Shop" workspaceName="Studio" components={[component]}/>);
 expect((await screen.findByRole('alert')).textContent).toMatch(/not a Git repository/);
});
