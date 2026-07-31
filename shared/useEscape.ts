import { useEffect } from "react";

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
