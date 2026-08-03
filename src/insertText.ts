/** The one route for text that should land at the current cursor. Fields and
 * Monaco accept a DOM edit; xterm needs its active Term to use bracketed paste. */
export const INSERT_TEXT_EVENT = "canopy:insert-text";

export function insertTextAtCursor(
  text: string,
  target: Element | null = document.activeElement,
): void {
  const el = target as HTMLElement | null;
  const isField =
    el &&
    el.isConnected &&
    !el.classList.contains("xterm-helper-textarea") &&
    (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable);
  if (isField) {
    el.focus();
    document.execCommand("insertText", false, text);
    return;
  }
  window.dispatchEvent(new CustomEvent(INSERT_TEXT_EVENT, { detail: text }));
}
