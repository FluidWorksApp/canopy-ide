// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {ComponentPicker} from './ComponentPicker';
import type {PickerComponent} from '../componentPicker';

afterEach(cleanup);
const C=(id:string,label:string,path:string):PickerComponent=>({id,label,path});
const COMPONENTS=[C('a','api','/w/shop/services/api'),C('w','web','/w/shop/apps/web'),C('k','worker','/w/shop/services/worker')];
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
