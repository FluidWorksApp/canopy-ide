import {render} from '@testing-library/react';import {expect,it,vi} from 'vitest';
import {MonacoEditor} from './MonacoEditor';import type {monaco} from '../monaco-setup';
const mocks=vi.hoisted(()=>({focus:vi.fn(),model:null as unknown,command:vi.fn(),selection:vi.fn()}));
vi.mock('../monaco-setup',()=>({monaco:{KeyMod:{CtrlCmd:1},KeyCode:{KeyS:2,KeyA:4},editor:{create:()=>({setModel:(model:unknown)=>{mocks.model=model;},getModel:()=>mocks.model,focus:mocks.focus,setSelection:mocks.selection,addCommand:mocks.command,getPosition:()=>null,saveViewState:()=>null,restoreViewState:vi.fn(),updateOptions:vi.fn(),onDidChangeCursorSelection:()=>({dispose:vi.fn()}),dispose:vi.fn()})}}}));
vi.mock('../settings',()=>({getSettings:()=>({}),THEME_CHANGE_EVENT:'theme'}));
vi.mock('../editorState',()=>({setCaret:vi.fn(),truncateSelection:vi.fn()}));
vi.mock('../editorViewState',()=>({editorViewState:()=>null,rememberEditorViewState:vi.fn()}));
it('focuses a newly opened editor so native paste and save target the file',()=>{
 const save=vi.fn();const model={uri:{path:'/workspace/new.env',toString:()=>'/workspace/new.env'},onDidChangeContent:()=>({dispose:vi.fn()})} as unknown as monaco.editor.ITextModel;
 const view=render(<MonacoEditor model={model} onSave={save} onDirty={vi.fn()}/>);
 expect(mocks.model).toBe(model);expect(mocks.focus).toHaveBeenCalledOnce();mocks.command.mock.calls[0][1]();expect(save).toHaveBeenCalledOnce();view.unmount();
});

it('selects the entire file independently of its extension',()=>{
 const range={startLineNumber:1,startColumn:1,endLineNumber:40,endColumn:12};
 const model={uri:{path:'/workspace/unknown.ab',toString:()=>'/workspace/unknown.ab'},getFullModelRange:()=>range,onDidChangeContent:()=>({dispose:vi.fn()})} as unknown as monaco.editor.ITextModel;
 mocks.command.mockClear();const view=render(<MonacoEditor model={model} onSave={vi.fn()} onDirty={vi.fn()}/>);
 mocks.command.mock.calls.find(call=>call[0]===5)?.[1]();expect(mocks.selection).toHaveBeenCalledWith(range);view.unmount();
});

it('a read-only editor suppresses save even when the keyboard command is invoked directly',()=>{
 mocks.command.mockClear();const save=vi.fn(),model={uri:{path:'/workspace/shared.md',toString:()=>'/workspace/shared.md'},onDidChangeContent:()=>({dispose:vi.fn()})} as unknown as monaco.editor.ITextModel;
 const view=render(<MonacoEditor readOnly model={model} onSave={save} onDirty={vi.fn()}/>);mocks.command.mock.calls[0][1]();expect(save).not.toHaveBeenCalled();view.rerender(<MonacoEditor readOnly={false} model={model} onSave={save} onDirty={vi.fn()}/>);mocks.command.mock.calls[0][1]();expect(save).toHaveBeenCalledOnce();view.unmount();
});
