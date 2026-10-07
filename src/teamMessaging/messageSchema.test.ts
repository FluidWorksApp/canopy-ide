import {expect,it} from 'vitest';import {validChatMessage,sameChatMessage} from './messageSchema';
const message={id:'11111111-1111-4111-8111-111111111111',sender:'alice',recipient:'bob',text:'synthetic',created:1};
it('bounds logical identifiers, authenticated identity strings and UTF8 payload size',()=>{
 expect(validChatMessage(message)).toBe(true);
 for(const change of [{id:'__proto__'},{id:'x'.repeat(10000)},{sender:''},{sender:'x'.repeat(257)},{recipient:'bad\nidentity'},{text:'😀'.repeat(4001)},{created:NaN},{created:1.5}])expect(validChatMessage({...message,...change})).toBe(false);
});
it('exact duplicates match but crosssender or changed recipient, content, creation and UUID conflict',()=>{
 expect(sameChatMessage(message,{...message})).toBe(true);
 for(const change of [{sender:'mallory'},{recipient:null},{text:'altered'},{created:2},{id:'22222222-2222-4222-8222-222222222222'}])expect(sameChatMessage(message,{...message,...change})).toBe(false);
});
