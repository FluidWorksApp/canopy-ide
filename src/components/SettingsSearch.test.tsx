// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {useState} from 'react';
import {SettingsSearch} from './SettingsSearch';
import type {SettingsTab} from './SettingsDialog';

afterEach(cleanup);
const LABELS:Partial<Record<SettingsTab,string>>={appearance:'Appearance',editor:'Editor',terminal:'Terminal',agents:'Agents',browser:'Browser & Vault'};
function Harness({onPick}:{onPick:(hit:any)=>void}){
  const [query,setQuery]=useState('');
  return <SettingsSearch query={query} onQuery={setQuery} onPick={onPick} tabLabels={LABELS}/>;
}
const type=(text:string)=>fireEvent.change(screen.getByRole('textbox',{name:'Search settings'}),{target:{value:text}});

it('shows nothing until something is typed',()=>{
  render(<Harness onPick={vi.fn()}/>);
  expect(screen.queryByRole('listbox')).toBeNull();
});
it('lists matches grouped under their tab',()=>{
  render(<Harness onPick={vi.fn()}/>);type('font');
  expect(screen.getByRole('listbox',{name:'Search results'})).toBeTruthy();
  expect(screen.getByRole('group',{name:'Editor'})).toBeTruthy();
  expect(screen.getByRole('group',{name:'Terminal'})).toBeTruthy();
});
it('opens the clicked result',()=>{
  const onPick=vi.fn();render(<Harness onPick={onPick}/>);type('scrollback');
  fireEvent.click(screen.getAllByRole('option')[0]);
  expect(onPick).toHaveBeenCalledOnce();
  expect(onPick.mock.calls[0][0]).toMatchObject({entry:{tab:'terminal',name:'Scrollback'}});
});
it('moves with the arrow keys and opens with Enter',()=>{
  const onPick=vi.fn();render(<Harness onPick={onPick}/>);type('font');
  const box=screen.getByRole('textbox',{name:'Search settings'});
  fireEvent.keyDown(box,{key:'ArrowDown'});fireEvent.keyDown(box,{key:'Enter'});
  expect(onPick).toHaveBeenCalledOnce();
  const options=screen.getAllByRole('option');
  expect(options[1].getAttribute('aria-selected')).toBe('true');
  expect(onPick.mock.calls[0][0].entry.name).toBe('Font and cursor');
});
it('says so when nothing matches',()=>{
  render(<Harness onPick={vi.fn()}/>);type('zebra');
  expect(screen.getByText(/No settings match “zebra”/)).toBeTruthy();
});
it('does not offer settings from a tab that is not available',()=>{
  render(<Harness onPick={vi.fn()}/>);type('model');// Dictation's Model: that tab is not in LABELS
  expect(screen.queryByRole('group',{name:'Dictation'})).toBeNull();
});
it('clears with the × button',()=>{
  render(<Harness onPick={vi.fn()}/>);type('font');
  fireEvent.click(screen.getByRole('button',{name:'Clear search'}));
  expect((screen.getByRole('textbox',{name:'Search settings'}) as HTMLInputElement).value).toBe('');
  expect(screen.queryByRole('listbox')).toBeNull();
});
