import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';

const tauri=vi.fn(),host=vi.fn();
vi.mock('@tauri-apps/api/core',()=>({invoke:(c:string,a?:unknown)=>tauri(c,a)}));
vi.mock('../host',()=>({invoke:(c:string,a?:unknown)=>host(c,a)}));
import {MirrorSetup} from './MirrorSetup';

beforeEach(()=>{tauri.mockReset();host.mockReset();});

it('sends nothing until the button is pressed, and offers env files unticked',()=>{
 render(<MirrorSetup workspaceName="Studio"/>);
 expect(tauri).not.toHaveBeenCalled();expect(host).not.toHaveBeenCalled();
 expect((screen.getByLabelText(/Include \.env/) as HTMLInputElement).checked).toBe(false);
 expect((screen.getByLabelText(/Install dependencies/) as HTMLInputElement).checked).toBe(true);
 expect(screen.getByText(/What stays on this Mac/)).toBeTruthy();
});

it('cannot be started while the workspace is not connected',()=>{
 render(<MirrorSetup workspaceName="Studio" disabled/>);
 expect((screen.getByRole('button',{name:'Set up from this Mac'}) as HTMLButtonElement).disabled).toBe(true);
});

it('runs the mirror with the chosen options and reports the outcome',async()=>{
 tauri.mockImplementation(async(c:string)=>{
  if(c==='execution_mirror_inspect')return [];
  if(c==='store_load')return 'null';
  return {};
 });
 host.mockImplementation(async(c:string)=>{
  if(c==='store_load')return '{"projects":[],"openIds":[]}';
  return {};
 });
 render(<MirrorSetup workspaceName="Studio"/>);
 fireEvent.click(screen.getByLabelText(/Include \.env/));
 fireEvent.click(screen.getByRole('button',{name:'Set up from this Mac'}));
 await waitFor(()=>expect(screen.getByRole('status',{name:''}) ).toBeTruthy());
 expect(tauri).toHaveBeenCalledWith('execution_mirror_inspect',undefined);
 expect(screen.getByText(/Your projects are set up/)).toBeTruthy();
});

it('shows a failure of the whole run',async()=>{
 tauri.mockRejectedValue(new Error('Select a remote workspace first'));
 render(<MirrorSetup workspaceName="Studio"/>);
 fireEvent.click(screen.getByRole('button',{name:'Set up from this Mac'}));
 expect((await screen.findByRole('alert')).textContent).toMatch(/Select a remote workspace first/);
});
