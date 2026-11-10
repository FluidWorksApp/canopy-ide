// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import {ComponentPicker} from './ComponentPicker';
import {automaticPreference,targetPreference,type DisplayTarget} from '../placement/types';
import type {PickerComponent} from '../componentPicker';

afterEach(cleanup);
const C=(id:string,label:string,path:string):PickerComponent=>({id,label,path});
const COMPONENTS=[C('a','api','/w/shop/services/api'),C('w','web','/w/shop/apps/web'),C('k','worker','/w/shop/services/worker')];
const MACHINES:DisplayTarget[]=[
  {target:{kind:'local'},name:'This Mac',online:true},
  {target:{kind:'remote',workspaceId:'design'},name:'Design Studio',online:true},
  {target:{kind:'t3',machineId:'mini'},name:'Build Mini',online:true},
];
const mount=(over:Partial<Parameters<typeof ComponentPicker>[0]>={})=>{
  const onPick=vi.fn(),onCancel=vi.fn();
  render(<ComponentPicker title="New shell" components={COMPONENTS} recents={[]} onPick={onPick} onCancel={onCancel} {...over}/>);
  return {onPick,onCancel,input:screen.getByRole('textbox',{name:'Component'}) as HTMLInputElement};
};
const names=()=>screen.getAllByRole('option').map(o=>o.querySelector('.cpick-name')!.textContent);
const ghost=()=>document.querySelector('.cpick-ghost')!.textContent;

it('asks which component, naming what is being opened',()=>{
  mount({title:'New Claude Code'});
  expect(screen.getByRole('dialog',{name:'New Claude Code'})).toBeTruthy();
  expect(screen.getByText(/in which component\?/)).toBeTruthy();
});
it('shows Automatic, This Mac, and each connected machine for agent launches',()=>{
  mount({title:'New Claude Code',machineTargets:MACHINES});
  expect(screen.getAllByRole('radio').map(row=>row.textContent)).toEqual(['Automatic','This Mac','Design Studio','Build Mini']);
  expect(screen.queryByText(/Balance|Remote|T3 Connect|Cloud/)).toBeNull();
});
it('reaches the machine choices from the initially focused component field',async()=>{
  const user=userEvent.setup();
  const {input}=mount({title:'New Claude Code',machineTargets:MACHINES});
  expect(input).toHaveFocus();
  await user.tab({shift:true});
  expect(screen.getByRole('radio',{name:'Automatic'})).toHaveFocus();
  await user.keyboard('{ArrowRight}');
  expect(screen.getByRole('radio',{name:'This Mac'})).toHaveFocus();
});
it('preserves a disconnected saved machine for an exact refusal',()=>{
  const missing=targetPreference({kind:'remote',workspaceId:'offline-workspace'});
  const {onPick,input}=mount({
    title:'New Claude Code',
    components:[COMPONENTS[0]],
    machineTargets:MACHINES,
    initialMachine:missing,
  });
  expect(screen.getByRole('radio',{name:'Unavailable machine (offline-workspace)'})).toHaveAttribute('aria-checked','true');
  fireEvent.keyDown(input,{key:'Enter'});
  expect(onPick).toHaveBeenCalledWith(COMPONENTS[0],missing);
});
it('returns the exact selected machine and supports arrow-key selection',()=>{
  const {onPick,input}=mount({
    title:'New Claude Code',
    components:[COMPONENTS[0]],
    machineTargets:MACHINES,
    initialMachine:automaticPreference(),
  });
  const automatic=screen.getByRole('radio',{name:'Automatic'});
  automatic.focus();
  fireEvent.keyDown(automatic,{key:'ArrowRight'});
  fireEvent.keyDown(screen.getByRole('radio',{name:'This Mac'}),{key:'ArrowRight'});
  expect(screen.getByRole('radio',{name:'Design Studio'})).toHaveAttribute('aria-checked','true');
  input.focus();
  fireEvent.keyDown(input,{key:'Enter'});
  expect(onPick).toHaveBeenCalledWith(COMPONENTS[0],targetPreference({kind:'remote',workspaceId:'design'}));
});
it('keeps shell selection free of machine controls',()=>{
  mount({title:'New shell',components:[COMPONENTS[0]]});
  expect(screen.queryByRole('radiogroup',{name:'Run on machine'})).toBeNull();
});
it('lists every component, the one used last first and flagged',()=>{
  mount({recents:['k','w']});
  expect(names()).toEqual(['worker','web','api']);
  expect(screen.getByText('last used').closest('[role=option]')!.textContent).toContain('worker');
});
it('flags the component the front tab is in',()=>{
  mount({activePath:'/w/shop/apps/web/src/x.ts'});
  expect(screen.getByText('this tab').closest('[role=option]')!.textContent).toContain('web');
});
it('opens the highlighted component on Enter: two keystrokes for the usual one',()=>{
  const {onPick,input}=mount({recents:['k']});
  fireEvent.keyDown(input,{key:'Enter'});
  expect(onPick).toHaveBeenCalledOnce();
  expect(onPick.mock.calls[0][0].id).toBe('k');
});
it('filters as you type and shows the rest of the best match in grey',()=>{
  const {input}=mount();
  fireEvent.change(input,{target:{value:'wo'}});
  expect(names()).toEqual(['worker']);
  expect(ghost()).toBe('worker');// typed part is invisible; the remainder is what shows
  expect(document.querySelector('.cpick-ghost')!.textContent).toContain('rker');
});
it('fills in the completion on Tab, and Enter then opens that component',()=>{
  const {onPick,input}=mount();
  fireEvent.change(input,{target:{value:'wo'}});
  fireEvent.keyDown(input,{key:'Tab'});
  expect(input.value).toBe('worker');
  fireEvent.keyDown(input,{key:'Enter'});
  expect(onPick.mock.calls[0][0].id).toBe('k');
});
it('moves with the arrow keys',()=>{
  const {onPick,input}=mount();
  fireEvent.keyDown(input,{key:'ArrowDown'});fireEvent.keyDown(input,{key:'ArrowDown'});fireEvent.keyDown(input,{key:'ArrowUp'});
  fireEvent.keyDown(input,{key:'Enter'});
  expect(onPick.mock.calls[0][0].id).toBe('w');
});
it('opens a clicked row',()=>{
  const {onPick}=mount();
  fireEvent.click(screen.getAllByRole('option')[2]);
  expect(onPick.mock.calls[0][0].id).toBe('k');
});
it('says so when nothing matches, and Enter then opens nothing',()=>{
  const {onPick,input}=mount();
  fireEvent.change(input,{target:{value:'zebra'}});
  expect(screen.getByText(/No component matches “zebra”/)).toBeTruthy();
  fireEvent.keyDown(input,{key:'Enter'});
  expect(onPick).not.toHaveBeenCalled();
});
it('cancels from the backdrop without opening anything',()=>{
  const {onPick,onCancel}=mount();
  fireEvent.mouseDown(document.querySelector('.palette-backdrop')!);
  expect(onCancel).toHaveBeenCalledOnce();expect(onPick).not.toHaveBeenCalled();
});
it('cancels on Escape, through the shared overlay stack, without opening anything',()=>{
  const {onPick,onCancel}=mount();
  fireEvent.keyDown(window,{key:'Escape'});
  expect(onCancel).toHaveBeenCalledOnce();expect(onPick).not.toHaveBeenCalled();
});
it('gives the keyboard back to where it was when cancelled',async()=>{
  const outside=document.createElement('textarea');document.body.append(outside);outside.focus();
  const {onCancel}=mount();
  expect(document.activeElement).not.toBe(outside);// the picker took it
  fireEvent.mouseDown(document.querySelector('.palette-backdrop')!);
  await new Promise(r=>requestAnimationFrame(()=>r(null)));
  expect(onCancel).toHaveBeenCalled();expect(document.activeElement).toBe(outside);outside.remove();
});

const ACCOUNTS={profiles:[{id:'default',label:'Default'},{id:'work',label:'Work'}],initial:'work'};

it('offers the agent\'s accounts, preselects the last used one, and returns the choice',()=>{
  const onPick=vi.fn();
  render(<ComponentPicker title="New Codex" components={COMPONENTS} recents={[]} machineTargets={MACHINES} accounts={ACCOUNTS} onPick={onPick} onCancel={()=>{}}/>);
  const group=screen.getByRole('radiogroup',{name:'Account'});
  expect(within(group).getByRole('radio',{name:'Work'})).toHaveAttribute('aria-checked','true');
  fireEvent.click(within(group).getByRole('radio',{name:'Default'}));
  fireEvent.click(screen.getAllByRole('option')[0]);
  expect(onPick).toHaveBeenCalledWith(expect.objectContaining({id:'a'}),expect.anything(),'default');
});

it('shows no account row when the agent has a single account',()=>{
  render(<ComponentPicker title="New Codex" components={COMPONENTS} recents={[]} onPick={()=>{}} onCancel={()=>{}}/>);
  expect(screen.queryByRole('radiogroup',{name:'Account'})).toBeNull();
});

it('with the component already decided, asks only where to run and which account, and opens on Enter',async()=>{
  const onPick=vi.fn();
  render(<ComponentPicker title="New Claude Code" components={COMPONENTS} recents={[]} machineTargets={MACHINES} accounts={ACCOUNTS} fixedComponent={COMPONENTS[1]} onPick={onPick} onCancel={()=>{}}/>);
  expect(screen.queryByRole('listbox',{name:'Components'})).toBeNull();
  expect(screen.queryByLabelText('Component')).toBeNull();
  expect(screen.getByText(/in web/)).toBeTruthy();
  expect(screen.getByRole('radiogroup',{name:'Run on machine'})).toBeTruthy();
  expect(screen.getByRole('radiogroup',{name:'Account'})).toBeTruthy();
  fireEvent.click(within(screen.getByRole('radiogroup',{name:'Account'})).getByRole('radio',{name:'Default'}));
  fireEvent.click(screen.getByRole('button',{name:/Open/}));
  expect(onPick).toHaveBeenCalledWith(expect.objectContaining({id:'w'}),expect.anything(),'default');
});
