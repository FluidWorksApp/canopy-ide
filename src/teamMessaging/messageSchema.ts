import type {ChatMessage} from './client';
const identity=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x1f]/.test(value);
export function validChatMessage(message:ChatMessage):boolean {
 return !!message&&typeof message.id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(message.id)&&identity(message.sender)&&(message.recipient===null||identity(message.recipient))&&typeof message.text==='string'&&new TextEncoder().encode(message.text).length<=16000&&Number.isSafeInteger(message.created)&&message.created>0;
}
export function sameChatMessage(a:ChatMessage,b:ChatMessage):boolean {
 return ['id','sender','recipient','text','created'].every(field=>a[field as keyof ChatMessage]===b[field as keyof ChatMessage]);
}
