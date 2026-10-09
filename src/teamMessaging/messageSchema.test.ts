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
const file={id:'33333333-3333-4333-8333-333333333333',name:'report.pdf',size:2048,type:'application/pdf',sha256:'a'.repeat(64)};
it('bounds attachment metadata: count, name, size, type and hash',()=>{
 expect(validChatMessage({...message,text:'',attachments:[file]})).toBe(true);
 expect(validChatMessage({...message,attachments:Array.from({length:10},(_,i)=>({...file,id:`33333333-3333-4333-8333-33333333333${i}`}))})).toBe(true);
 expect(validChatMessage({...message,attachments:Array.from({length:11},(_,i)=>({...file,id:`33333333-3333-4333-8333-3333333333${String(i).padStart(2,'0')}`}))})).toBe(false);
 expect(validChatMessage({...message,attachments:[]})).toBe(false);
 expect(validChatMessage({...message,attachments:[file,file]})).toBe(false);
 for(const change of [{id:'nope'},{name:''},{name:'x'.repeat(256)},{name:'../etc/passwd'},{name:'a\\b'},{name:'bad\nname'},{name:'..'},{size:0},{size:104857601},{size:1.5},{type:'x'.repeat(256)},{type:'text/\u0000'},{sha256:'A'.repeat(64)},{sha256:'a'.repeat(63)},{extra:1}])
  expect(validChatMessage({...message,attachments:[{...file,...change}]}),JSON.stringify(change)).toBe(false);
});
it('treats changed attachment metadata as a conflicting message',()=>{
 const withFile={...message,attachments:[file]};
 expect(sameChatMessage(withFile,{...withFile,attachments:[{...file}]})).toBe(true);
 expect(sameChatMessage(message,withFile)).toBe(false);
 for(const change of [{name:'other.pdf'},{size:2049},{sha256:'b'.repeat(64)},{type:'text/plain'}])expect(sameChatMessage(withFile,{...withFile,attachments:[{...file,...change}]})).toBe(false);
});
