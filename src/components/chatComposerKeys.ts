import type {KeyboardEvent} from 'react';
/** Chat composers send on Enter and keep Shift+Enter for a new line, as every
 *  messenger does. Enter that confirms an IME candidate (Japanese, Chinese,
 *  Korean input) is part of typing, not a send: `isComposing` covers modern
 *  engines and keyCode 229 covers WebKit, which reports the confirming keydown
 *  after composition has already ended. */
export function isSendKey(e:KeyboardEvent<HTMLElement>):boolean{
 if(e.key!=='Enter'||e.shiftKey||e.altKey||e.ctrlKey||e.metaKey)return false;
 return !(e.nativeEvent.isComposing||e.keyCode===229);
}
