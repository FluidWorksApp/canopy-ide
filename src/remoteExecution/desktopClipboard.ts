/** Keysyms and codes for the shortcuts sent to the workspace desktop. */
export const KEYS = {
  control: [0xffe3, 'ControlLeft'], shift: [0xffe1, 'ShiftLeft'], insert: [0xff63, 'Insert'],
  superLeft: [0xffeb, 'MetaLeft'], superRight: [0xffec, 'MetaRight'],
} as const;

/** VNC's clipboard is Latin-1: anything beyond it arrives as `?`. */
export const fitsVncClipboard = (text: string) => [...text].every(character => character.codePointAt(0)! <= 0xff);

/** What a copy picked up: the clipboard if the copy changed it, otherwise the
 *  highlighted text, which is all a terminal offers without its own shortcut. */
export const copiedText = (before: string, clipboard: string, primary: string) =>
  clipboard && clipboard !== before ? clipboard : primary || clipboard;
