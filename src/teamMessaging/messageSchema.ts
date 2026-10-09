import type {ChatMessage,Attachment} from './client';
/** C0 controls (and DEL unless `del` is false), by code point rather than a control-char regex. */
export const hasControl=(value:string,del=true)=>{for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c<32||(del&&c===127))return true;}return false;};
const identity=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=256&&!hasControl(value,false);
export const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Per-file and per-message attachment bounds. Bytes travel peer to peer, so the
 * cap protects the receiving device's memory, not a server. */
export const MAX_ATTACHMENT_BYTES=100*1024*1024,MAX_ATTACHMENTS=10;
/** A bare file name: no path separators, control characters or dot-only names,
 * since it becomes the default name when the recipient saves the file. */
export const validFileName=(name:unknown):name is string=>typeof name==='string'&&name.length>0&&name.length<=255&&!hasControl(name)&&!/[/\\]/.test(name)&&!/^\.+$/.test(name);
export function validAttachment(value:Attachment):boolean {
 return !!value&&typeof value==='object'&&typeof value.id==='string'&&UUID.test(value.id)&&validFileName(value.name)&&Number.isSafeInteger(value.size)&&value.size>=1&&value.size<=MAX_ATTACHMENT_BYTES&&typeof value.type==='string'&&value.type.length<=255&&!hasControl(value.type)&&typeof value.sha256==='string'&&/^[a-f0-9]{64}$/.test(value.sha256)&&Object.keys(value).every(key=>['id','name','size','type','sha256'].includes(key));
}
const validAttachments=(value:ChatMessage['attachments'])=>value===undefined||(Array.isArray(value)&&value.length>=1&&value.length<=MAX_ATTACHMENTS&&value.every(validAttachment)&&new Set(value.map(a=>a.id)).size===value.length);
export function validChatMessage(message:ChatMessage):boolean {
 return !!message&&typeof message.id==='string'&&UUID.test(message.id)&&identity(message.sender)&&(message.recipient===null||identity(message.recipient))&&typeof message.text==='string'&&new TextEncoder().encode(message.text).length<=16000&&Number.isSafeInteger(message.created)&&message.created>0&&validAttachments(message.attachments);
}
const sameAttachments=(a:ChatMessage['attachments']=[],b:ChatMessage['attachments']=[])=>a.length===b.length&&a.every((x,i)=>(['id','name','size','type','sha256'] as const).every(field=>x[field]===b[i][field]));
export function sameChatMessage(a:ChatMessage,b:ChatMessage):boolean {
 return ['id','sender','recipient','text','created'].every(field=>a[field as keyof ChatMessage]===b[field as keyof ChatMessage])&&sameAttachments(a.attachments,b.attachments);
}
