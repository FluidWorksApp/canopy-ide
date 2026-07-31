// Which way a keypress moves through the tab strip — the one place the
// tab-cycle chords are spelled.
//
// Ctrl+Tab / Ctrl+Shift+Tab is the chord every IDE and browser trains, and
// Canopy's Help has advertised it since the dictation release; nothing ever
// answered it. It cannot be a native menu accelerator: muda hands macOS the
// glyph "⇥" (U+21E5) as the key equivalent for Tab rather than the tab
// character the key actually produces, so such a menu item renders perfectly
// and never fires. It lives in the webview keydown handler instead, which is
// where the chord has to work anyway — focus is almost always inside xterm or
// Monaco, and macOS never routes an accelerator to the menu from there.
//
// ⌃⌘←/→ (and ⌃⌥←/→, the same chord as the webview sees it off macOS) stays:
// it is what the Tabs menu advertises, and it is the only pair that survives
// native focus.

/** +1 next tab, -1 previous, 0 not a tab-cycle chord. */
export type CycleDir = 1 | -1 | 0;

export function tabCycleDirection(e: KeyboardEvent): CycleDir {
  // Ctrl is literal on every platform here, not Cmd-or-Ctrl: Ctrl+Tab is one
  // chord worldwide, and ⌘⇥ belongs to the macOS app switcher.
  if (e.code === "Tab" && e.ctrlKey && !e.metaKey && !e.altKey) {
    return e.shiftKey ? -1 : 1;
  }
  // The menu accelerator. Off macOS Control+CmdOrCtrl collapses to one Ctrl,
  // which arrives with the alt flag rather than the meta one, so accept both.
  if (e.ctrlKey && (e.metaKey || e.altKey)) {
    if (e.code === "ArrowRight") return 1;
    if (e.code === "ArrowLeft") return -1;
  }
  return 0;
}
