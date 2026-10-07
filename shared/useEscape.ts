import { useEffect, useRef } from "react";

/** The overlay stack: every surface that answers Escape, in the order it opened.
 *
 *  Escape has no stack in the DOM. Every overlay used to hang its own listener
 *  on window or document, so one press could close two surfaces at once — and,
 *  worse, the terminal under them still got the key. Focus usually stays in
 *  xterm's hidden textarea while a popup is up (WebKit doesn't focus a button
 *  you click), xterm writes `\x1b` to the pty in its own keydown handler, and
 *  to an agent CLI that is "interrupt": open Settings, press Escape to close
 *  it, and the agent working behind it stops.
 *
 *  So every overlay registers here while it is open, and ONE capture-phase
 *  window listener (installed below, before any component mounts) owns the
 *  key: with anything on the stack, Escape goes to the top layer and to
 *  nothing else — not the layer under it, not the terminal. The terminal also
 *  asks `terminalKeyBlocked` before it sends anything to its pty, so a key that
 *  slips past (a layer that handles Escape itself, a typed character) still
 *  never reaches the agent while an overlay is open. With nothing open the
 *  listener does nothing at all, and Escape is the terminal's again. */

export interface EscapeLayerOptions {
  /** Called when Escape is pressed while this is the top layer. The key is
   *  then consumed: default prevented and propagation stopped, so neither the
   *  surfaces below nor a terminal hear it. Return `false` to decline — the
   *  event carries on to the layer's own key handling; a terminal still never
   *  sees it. Omit it for a surface whose own listener owns Escape (that
   *  listener must then be on window or document, so it hears the key
   *  wherever focus is). */
  onEscape?: (e: KeyboardEvent) => void | boolean;
  /** Whether terminals stop taking keystrokes while this is open. Modal
   *  surfaces (dialogs, menus, palettes, popovers) do; a non-modal panel the
   *  user keeps open while typing in the terminal (the companion chat) does
   *  not. Escape never reaches a terminal while any layer is open either way.
   *  Default true. */
  blocksTerminal?: boolean;
  /** Leave keyboard focus where it is. By default a blocking layer that opens
   *  while a terminal has focus takes focus out of it, and gives it back when
   *  the last such layer closes. Pickers that type into the focused field on
   *  commit (clipboard history, dictation history) must keep it. */
  keepFocus?: boolean;
}

interface Layer {
  options: () => EscapeLayerOptions;
}

const stack: Layer[] = [];

/** The terminal that had focus when the first blocking layer opened. */
let parkedTerminal: HTMLElement | null = null;

function blocking(layer: Layer): boolean {
  return layer.options().blocksTerminal !== false;
}

function inTerminal(el: Element | null): el is HTMLElement {
  return el instanceof HTMLElement && !!el.closest(".xterm");
}

/** Focus is lost (or about to be) rather than deliberately somewhere else:
 *  nothing, the body, a node that was unmounted, or one inside a surface that
 *  was hidden rather than unmounted. */
function focusAbandoned(el: Element | null): boolean {
  if (!el || el === document.body || !el.isConnected) return true;
  return !!el.closest("[hidden], [aria-hidden='true']");
}

function restoreParkedFocus() {
  const target = parkedTerminal;
  parkedTerminal = null;
  if (!target) return;
  // After React has finished unmounting: until then the closing overlay may
  // still be holding focus on a node that is about to go.
  queueMicrotask(() => {
    if (stack.some(blocking)) return;
    if (!target.isConnected) return;
    if (!focusAbandoned(document.activeElement)) return;
    target.focus({ preventScroll: true });
  });
}

/** Register a surface as open until the returned release is called. Layers are
 *  ordered by when they were pushed: the last one pushed is the top. Options
 *  may be a getter, read on every key, so a component's latest handler runs
 *  without re-registering (which would move it to the top). */
export function pushEscapeLayer(
  options: EscapeLayerOptions | (() => EscapeLayerOptions) = {},
): () => void {
  const layer: Layer = {
    options: typeof options === "function" ? options : () => options,
  };
  if (blocking(layer) && !layer.options().keepFocus && !parkedTerminal) {
    const active = document.activeElement;
    if (inTerminal(active)) {
      parkedTerminal = active;
      active.blur();
    }
  }
  stack.push(layer);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const i = stack.indexOf(layer);
    if (i >= 0) stack.splice(i, 1);
    if (!stack.some(blocking)) restoreParkedFocus();
  };
}

/** Is anything that answers Escape open? */
export function escapeLayersOpen(): boolean {
  return stack.length > 0;
}

/** Must the terminal drop this key rather than send it to its pty? Escape is
 *  never a terminal's while any overlay is open; other keys are not while a
 *  blocking (modal) one is. */
export function terminalKeyBlocked(e: Pick<KeyboardEvent, "key">): boolean {
  if (!stack.length) return false;
  if (e.key === "Escape") return true;
  return stack.some(blocking);
}

/** Set when the dispatcher consumed an Escape keydown, so the matching keyup
 *  is swallowed too: a terminal reporting key releases (kitty keyboard
 *  protocol) must not see half of a press that was never its own. */
let swallowEscapeUp = false;

function runLayer(layer: Layer, e: KeyboardEvent) {
  const { onEscape } = layer.options();
  if (!onEscape || onEscape(e) === false) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  swallowEscapeUp = true;
}

/** The single Escape dispatcher. Capture phase on window: it runs before any
 *  element (the terminal's textarea included) sees the key. */
function onWindowKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.isComposing) return;
  const top = stack[stack.length - 1];
  if (!top || !top.options().onEscape) return;
  if (editingInAField(e.target)) {
    // A real field (an inline rename, a filter box, a draft) gets the key
    // first, the way it always has: Escape there may mean "cancel this edit".
    // If it handles the key (preventDefault, or stopping it) the overlay
    // stays; if it lets the key bubble untouched, the overlay closes. A field
    // is never a terminal, so nothing here can reach a pty.
    const after = (late: KeyboardEvent) => {
      window.removeEventListener("keydown", after);
      if (late !== e || e.defaultPrevented || !stack.includes(top)) return;
      runLayer(top, e);
    };
    window.addEventListener("keydown", after);
    // A field that stopped the key means `after` never runs for it.
    setTimeout(() => window.removeEventListener("keydown", after), 0);
    return;
  }
  runLayer(top, e);
}

function onWindowKeyUp(e: KeyboardEvent) {
  if (e.key !== "Escape" || !swallowEscapeUp) return;
  swallowEscapeUp = false;
  e.stopImmediatePropagation();
}

if (typeof window !== "undefined") {
  window.addEventListener("keydown", onWindowKeyDown, true);
  window.addEventListener("keyup", onWindowKeyUp, true);
}

/** Declare a surface as an overlay for as long as `enabled` is true. Pass
 *  `onEscape` (in `options`) so Escape closes it from wherever focus is. The
 *  options are read live, so a re-render never moves the layer in the stack. */
export function useEscapeLayer(enabled = true, options?: EscapeLayerOptions) {
  const ref = useRef<EscapeLayerOptions>(options ?? {});
  ref.current = options ?? {};
  useEffect(() => {
    if (!enabled) return;
    return pushEscapeLayer(() => ref.current);
  }, [enabled]);
}

/** Call `onEscape` when Escape is pressed while this overlay is the top one.
 *  Every dismissable popup should use this (or `useEscapeLayer` with an
 *  `onEscape`) — app chrome has no default Escape-to-close, so without it a
 *  dialog can only be dismissed by mouse, and the key goes to the terminal.
 *
 *  `enabled` MUST gate it for popups whose host component stays mounted (a
 *  confirm dialog inside an always-present panel): a layer that is always on
 *  would swallow Escape everywhere — including a terminal running vim — even
 *  when nothing is open. Popups mounted only while visible can leave it true. */
export function useEscape(
  onEscape: () => void,
  enabled = true,
  options?: Omit<EscapeLayerOptions, "onEscape">,
) {
  useEscapeLayer(enabled, { ...options, onEscape: () => onEscape() });
}

/** Escape for the surface at the bottom of the pile — today, the overlay side
 *  panel. A capture-phase listener like the stack's (a panel lying over the
 *  editor has to answer the key even though focus is still in the terminal
 *  behind it), with two things it stands down for:
 *
 *   * any Escape layer — a dialog, menu or palette the surface itself raised.
 *     One press should take away the thing on top, not both.
 *   * a text field mid-edit, where Escape means "cancel this edit": an inline
 *     rename, a filter box, a search field. The terminal's hidden textarea is
 *     not one of those — Escape there is just a keystroke on its way to a
 *     shell, and a panel covering that shell outranks it. The press that puts
 *     the panel away stops there: it is not also an interrupt for the agent.
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
      e.stopImmediatePropagation();
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
