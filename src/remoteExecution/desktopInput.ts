// Keeping the workspace desktop's input honest across minimise, sleep and
// reconnects. VNC is stateful: the workspace remembers which keys and buttons
// are down, so a key-up that never arrives (the window lost focus, the stream
// dropped, macOS swallowed it under Cmd) leaves Ctrl, Alt or Cmd held there, and
// every later click is a Ctrl-click and every letter a shortcut.

type KeySender = { sendKey(keysym: number, code: string, down: boolean): void };

/** Every modifier a keyboard can be holding, as keysym and KeyboardEvent.code. */
export const MODIFIER_KEYS: readonly (readonly [number, string])[] = [
  [0xffe1, 'ShiftLeft'], [0xffe2, 'ShiftRight'],
  [0xffe3, 'ControlLeft'], [0xffe4, 'ControlRight'],
  [0xffe9, 'AltLeft'], [0xffea, 'AltRight'],
  [0xffe7, 'MetaLeft'], [0xffe8, 'MetaRight'],
  [0xffeb, 'MetaLeft'], [0xffec, 'MetaRight'], // Super: how Cmd is sent (KEYS)
  [0xfe03, 'AltRight'], // AltGr
];

/** Key-up for every modifier. Harmless for one that is not down. */
export function releaseAllKeys(rfb: KeySender | null | undefined) {
  if (!rfb) return;
  for (const [keysym, code] of MODIFIER_KEYS) {
    try { rfb.sendKey(keysym, code, false); } catch { /* A closing socket has nothing left to release. */ }
  }
}

/** A mouse button still held in the workspace turns the next click into a drag.
 *  noVNC tracks the buttons itself, so letting go through its own canvas is the
 *  only way to clear that state; with nothing held it is just a pointer move. */
export function releaseMouseButtons(root: ParentNode | null | undefined) {
  const canvas = root?.querySelector('canvas');
  if (!canvas) return;
  const box = canvas.getBoundingClientRect();
  const clientX = box.left + box.width / 2, clientY = box.top + box.height / 2;
  for (const button of [0, 1, 2]) canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button, clientX, clientY }));
}

/** Longer away than this and the old stream is not trusted: a socket that died
 *  while the machine slept is not noticed until TCP gives up, which is minutes. */
export const STALE_AFTER_MS = 15_000;
/** A connect that began this recently is still in progress, not stuck. */
export const CONNECT_GRACE_MS = 3_000;
export const RETRY_BASE_MS = 500;
export const RETRY_MAX_MS = 5_000;

/** Wait before reconnect attempt number `drops`, 0-based. Interactive, so it
 *  stays short: a user is looking at a frozen desktop while this runs. */
export const retryDelay = (drops: number) => Math.min(RETRY_BASE_MS * 2 ** Math.min(drops, 4), RETRY_MAX_MS);

/** What to do when the window becomes visible, focused or online again. */
export function wakeAction({ connected, awayMs, connectingForMs }: { connected: boolean; awayMs: number; connectingForMs: number }): 'reconnect' | 'keep' {
  if (connected) return awayMs >= STALE_AFTER_MS ? 'reconnect' : 'keep';
  return connectingForMs < CONNECT_GRACE_MS ? 'keep' : 'reconnect';
}
