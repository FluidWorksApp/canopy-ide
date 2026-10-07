import {it,expect} from 'vitest';
import type {KeyboardEvent} from 'react';
import {isSendKey} from './chatComposerKeys';
const key=(init:Partial<{key:string;shiftKey:boolean;altKey:boolean;ctrlKey:boolean;metaKey:boolean;keyCode:number;isComposing:boolean}>)=>({key:'Enter',shiftKey:false,altKey:false,ctrlKey:false,metaKey:false,keyCode:13,...init,nativeEvent:{isComposing:init.isComposing??false}}) as unknown as KeyboardEvent<HTMLElement>;
it('sends on a bare Enter',()=>expect(isSendKey(key({}))).toBe(true));
it('leaves Shift+Enter (and other modified Enters) to the field',()=>{
 expect(isSendKey(key({shiftKey:true}))).toBe(false);
 expect(isSendKey(key({altKey:true}))).toBe(false);
 expect(isSendKey(key({metaKey:true}))).toBe(false);
});
it('ignores Enter while an IME composition is active or just confirmed',()=>{
 expect(isSendKey(key({isComposing:true}))).toBe(false);
 expect(isSendKey(key({keyCode:229}))).toBe(false);
});
it('ignores other keys',()=>expect(isSendKey(key({key:'a'}))).toBe(false));
