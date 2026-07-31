import { useEffect } from "react";

/** How many surfaces that answer Escape are open right now.
 *
 *  Escape has no stack in the DOM: every handler is a window listener, they all
 *  fire, and `stopPropagation` between two listeners on the same target does
 *  nothing. That is fine while only one thing is open — but the side panel is
 *  open BEHIND the dialogs and menus it raises, and closing it along with them
 *  would take two surfaces away for one press.
 *
 *  So the surfaces that answer Escape count themselves here, and the one
 *  surface that must yield to all of them (`useEscapeBackstop`) asks. It is a
 *  count, not an ordering: a backstop only needs to know whether anything else
 *  is listening, never which one. */
let openLayers = 0;

/** Count a surface as open until the returned release is called. */
export function pushEscapeLayer(): () => void {
  openLayers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openLayers -= 1;
  };
}

/** Is anything that answers Escape open? */
export function escapeLayersOpen(): boolean {
  return openLayers > 0;
}

/** Declare a surface as an Escape layer for as long as it is open, without
 *  taking over its key handling — for popups that already have their own
 *  (Dialog, ContextMenu, the palettes). `useEscape` does this on its own. */
export function useEscapeLayer(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    return pushEscapeLayer();
  }, [enabled]);
}

/** Call `onEscape` when Escape is pressed while a modal/overlay is open. Every
 *  dismissable popup should use this — app chrome has no default Escape-to-close,
 *  so without it a dialog can only be dismissed by mouse. Registered on keydown
 *  with capture so it beats an input that would otherwise swallow the key.
 *
 *  `enabled` MUST gate it for popups whose host component stays mounted (a
 *  confirm dialog inside an always-present panel): a listener that is always on
 *  would swallow Escape everywhere — including a terminal running vim — even
 *  when nothing is open. Popups mounted only while visible can leave it true. */
export function useEscape(onEscape: () => void, enabled = true) {
  useEscapeLayer(enabled);
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onEscape();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onEscape, enabled]);
}

/** Escape for the surface at the bottom of the pile — today, the overlay side
 *  panel. Same capture-phase listener as `useEscape` (a panel lying over the
 *  editor has to answer the key even though focus is still in the terminal
 *  behind it), with two things it stands down for:
 *
 *   * any other Escape layer — a dialog, menu or palette the surface itself
 *     raised. One press should take away the thing on top, not both.
 *   * a text field mid-edit, where Escape means "cancel this edit": an inline
 *     rename, a filter box, a search field. The terminal's hidden textarea is
 *     not one of those — Escape there is just a keystroke on its way to a
 *     shell, and a panel covering that shell outranks it.
 *
 *  This registers no layer of its own: a backstop is what other layers fall
 *  back to, so it must never be what one of them falls back to. */
export function useEscapeBackstop(onEscape: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      if (escapeLayersOpen()) return;
      if (editingInAField(e.target)) return;
      e.preventDefault();
      onEscape();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onEscape, enabled]);
}

function editingInAField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // xterm types into an off-screen textarea. It looks like a field and is not
  // one: nothing in it is being edited, so it holds nothing Escape could cancel.
  if (target.closest(".xterm")) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA"
  );
}
