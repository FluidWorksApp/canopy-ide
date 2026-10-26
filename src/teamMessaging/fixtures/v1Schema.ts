/** Frozen copy of how a 0.4.9/0.4.10 client (chat protocol v1) checks an
 * incoming chat message: `validChatMessage` and `sameChatMessage` from
 * messageSchema.ts and `PeerClient.validateMessage` from client.ts, as of the
 * v0.4.10 release. Never edit this to match newer code: tests use it to prove
 * that what newer clients send is still accepted, saved and shown by old ones. */
type Attachment={id:string;name:string;size:number;type:string;sha256:string};
type ChatMessage={id:string;sender:string;recipient:string|null;text:string;created:number;attachments?:Attachment[]};
const hasControl=(value:string,del=true)=>{for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c<32||(del&&c===127))return true;}return false;};
const identity=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=256&&!hasControl(value,false);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_ATTACHMENT_BYTES=100*1024*1024,MAX_ATTACHMENTS=10;
const validFileName=(name:unknown):name is string=>typeof name==='string'&&name.length>0&&name.length<=255&&!hasControl(name)&&!/[/\\]/.test(name)&&!/^\.+$/.test(name);
function validAttachment(value:Attachment):boolean {
 return !!value&&typeof value==='object'&&typeof value.id==='string'&&UUID.test(value.id)&&validFileName(value.name)&&Number.isSafeInteger(value.size)&&value.size>=1&&value.size<=MAX_ATTACHMENT_BYTES&&typeof value.type==='string'&&value.type.length<=255&&!hasControl(value.type)&&typeof value.sha256==='string'&&/^[a-f0-9]{64}$/.test(value.sha256)&&Object.keys(value).every(key=>['id','name','size','type','sha256'].includes(key));
}
const validAttachments=(value:ChatMessage['attachments'])=>value===undefined||(Array.isArray(value)&&value.length>=1&&value.length<=MAX_ATTACHMENTS&&value.every(validAttachment)&&new Set(value.map(a=>a.id)).size===value.length);
export function v1ValidChatMessage(message:ChatMessage):boolean {
 return !!message&&typeof message.id==='string'&&UUID.test(message.id)&&identity(message.sender)&&(message.recipient===null||identity(message.recipient))&&typeof message.text==='string'&&new TextEncoder().encode(message.text).length<=16000&&Number.isSafeInteger(message.created)&&message.created>0&&validAttachments(message.attachments);
}
const sameAttachments=(a:ChatMessage['attachments']=[],b:ChatMessage['attachments']=[])=>a.length===b.length&&a.every((x,i)=>(['id','name','size','type','sha256'] as const).every(field=>x[field]===b[i][field]));
export function v1SameChatMessage(a:ChatMessage,b:ChatMessage):boolean {
 return ['id','sender','recipient','text','created'].every(field=>a[field as keyof ChatMessage]===b[field as keyof ChatMessage])&&sameAttachments(a.attachments,b.attachments);
}
/** `PeerClient.validateMessage`, with the sending device's account and this account passed in. Throws like the original. */
export function v1ValidateMessage(m:ChatMessage,senderUser:string,me:string,envelope:{created:number;expires:number}){
 if(!v1ValidChatMessage(m)||m.sender!==senderUser||(m.recipient!==null&&m.recipient!==me)||typeof m.text!=='string'||new TextEncoder().encode(m.text).length>16000||!Number.isSafeInteger(m.created)||m.created<envelope.created-300000||m.created>envelope.expires)throw Error('Invalid peer message');
}
/** What a v1 client puts on screen for a message: its text and attachments. Empty text with no files is a blank bubble. */
export const v1Renders=(m:ChatMessage)=>m.text.trim().length>0||!!m.attachments?.length;
