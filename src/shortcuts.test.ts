import { describe, expect, it } from "vitest";
// Source read as text (Vite's ?raw) rather than through node:fs — these tests
// run under the app's tsconfig, which has no Node types.
import libRs from "../src-tauri/src/lib.rs?raw";
import appTsx from "./App.tsx?raw";
import microTasksTs from "./microTasks.ts?raw";
import settingsTs from "./settings.ts?raw";
import agentWorkspaceTsx from "./components/AgentWorkspaceView.tsx?raw";
import agentsPanelTsx from "./components/AgentsPanel.tsx?raw";
import changesPanelTsx from "./components/ChangesPanel.tsx?raw";
import helpDialogTsx from "./components/HelpDialog.tsx?raw";
import instructionsTsx from "./components/InstructionsView.tsx?raw";
import onboardingTsx from "./components/Onboarding.tsx?raw";
import projectViewTsx from "./components/ProjectView/index.tsx?raw";
import tasksPanelTsx from "./components/TasksPanel.tsx?raw";
import termTsx from "./components/Term.tsx?raw";
import {
  ALL_PLATFORMS,
  accelerator,
  format,
  formatChord,
  helpRows,
  globallyBoundIds,
  idsOnSurface,
  keyLabel,
  matches,
  matchesModifierClick,
  resolve,
  withShortcut,
  type Platform,
} from "./shortcuts";

/** A keydown, spelled out. Every flag is explicit so a test can never pass by
 *  leaving the modifier it cares about undefined. */
const key = (
  code: string,
  mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {},
) =>
  ({
    code,
    metaKey: !!mods.meta,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
  }) as KeyboardEvent;

describe("resolve", () => {
  it("maps Mod to Command on macOS and Control everywhere else", () => {
    expect(resolve("quick-open", "macos")).toMatchObject({ meta: true, ctrl: false });
    expect(resolve("quick-open", "windows")).toMatchObject({ meta: false, ctrl: true });
    expect(resolve("quick-open", "linux")).toMatchObject({ meta: false, ctrl: true });
  });

  it("keeps a literal Ctrl as Control on every platform", () => {
    // ⌃⌘→ on a Mac: Ctrl is the physical key, Mod is Command.
    expect(resolve("next-tab", "macos")).toMatchObject({ ctrl: true, meta: true });
  });

  it("never resolves a chord to Meta off macOS — that is the OS's own key", () => {
    for (const p of ["windows", "linux"] as Platform[]) {
      for (const id of idsOnSurface("menu").concat(idsOnSurface("app"), idsOnSurface("terminal"))) {
        expect(resolve(id, p)?.meta ?? false, `${id} on ${p}`).toBe(false);
      }
    }
  });

  it("returns null where the manifest unbinds a chord", () => {
    expect(resolve("term-line-start", "windows")).toBeNull();
    expect(resolve("term-line-start", "macos")).not.toBeNull();
  });

  it("throws on an unknown id rather than silently never firing", () => {
    expect(() => resolve("not-a-shortcut")).toThrow(/unknown shortcut/);
  });
});

describe("matches", () => {
  it("accepts the platform's own chord and rejects the other platform's", () => {
    expect(matches(key("KeyO", { meta: true }), "open-project", "macos")).toBe(true);
    expect(matches(key("KeyO", { ctrl: true }), "open-project", "macos")).toBe(false);
    expect(matches(key("KeyO", { ctrl: true }), "open-project", "windows")).toBe(true);
    expect(matches(key("KeyO", { meta: true }), "open-project", "windows")).toBe(false);
  });

  it("rejects a superset of the chord's modifiers", () => {
    // ⌘⇧P is the command palette in other editors — it must not open Quick Open.
    expect(matches(key("KeyP", { meta: true, shift: true }), "quick-open", "macos")).toBe(false);
  });

  it("cycles tabs on the chord each platform's menu advertises", () => {
    expect(matches(key("ArrowRight", { ctrl: true, meta: true }), "next-tab", "macos")).toBe(true);
    expect(matches(key("PageDown", { ctrl: true }), "next-tab", "windows")).toBe(true);
    // The old hand-written test was `ctrlKey && (metaKey || altKey)`, so this
    // fired off a Mac on a chord no menu ever offered.
    expect(matches(key("ArrowRight", { ctrl: true, alt: true }), "next-tab", "windows")).toBe(false);
    // And plain Ctrl+Arrow — word-jump — must never move a tab.
    expect(matches(key("ArrowRight", { ctrl: true }), "next-tab", "windows")).toBe(false);
  });

  it("never fires for a chord unbound on this platform", () => {
    expect(matches(key("ArrowLeft", { ctrl: true }), "term-line-start", "windows")).toBe(false);
  });
});

describe("matchesModifierClick", () => {
  const click = (mods: Partial<{ meta: boolean; ctrl: boolean }> = {}) =>
    ({
      metaKey: !!mods.meta,
      ctrlKey: !!mods.ctrl,
      altKey: false,
      shiftKey: false,
    }) as MouseEvent;

  it("is Cmd-click on a Mac and Ctrl-click elsewhere", () => {
    expect(matchesModifierClick(click({ meta: true }), "open-external", "macos")).toBe(true);
    expect(matchesModifierClick(click({ ctrl: true }), "open-external", "windows")).toBe(true);
  });

  /** Ctrl+click on macOS is the OS's right-click. Accepting it there meant a
   *  user opening a context menu on a port chip got the system browser. */
  it("does not accept Ctrl-click on macOS", () => {
    expect(matchesModifierClick(click({ ctrl: true }), "open-external", "macos")).toBe(false);
  });
});

describe("formatting", () => {
  it("uses Mac glyphs on macOS and words elsewhere", () => {
    // Apple's order is Control-Option-Shift-Command, which is how macOS
    // renders it in its own menus — "⇧⌘F", not "⌘⇧F".
    expect(format("find-in-files", "macos")).toBe("⇧⌘F");
    expect(format("find-in-files", "windows")).toBe("Ctrl+Shift+F");
  });

  it("spells the per-platform tab chords the way each platform is pressed", () => {
    expect(format("next-tab", "macos")).toBe("⌃⌘→");
    expect(format("next-tab", "linux")).toBe("Ctrl+PgDn");
  });

  it("renders a modifier-only chord as just the modifier", () => {
    expect(format("open-external", "macos")).toBe("⌘");
    expect(format("open-external", "windows")).toBe("Ctrl");
  });

  it("returns an empty string, not a broken chord, when unbound here", () => {
    expect(format("term-line-start", "windows")).toBe("");
    expect(withShortcut("Start of line", "term-line-start")).not.toContain("(");
  });

  it("humanizes key codes", () => {
    expect(keyLabel("KeyD", "macos")).toBe("D");
    expect(keyLabel("Digit1", "macos")).toBe("1");
    expect(keyLabel("ArrowLeft", "macos")).toBe("←");
    expect(keyLabel("ArrowLeft", "windows")).toBe("Left");
    // Spelled out on both — "⌘⇧Enter" reads better than "⌘⇧⏎".
    expect(keyLabel("Enter", "macos")).toBe("Enter");
  });

  it("formats an arbitrary resolved chord", () => {
    expect(
      formatChord({ meta: false, ctrl: false, alt: true, shift: true, code: "KeyD" }, "windows"),
    ).toBe("Alt+Shift+D");
  });
});

describe("helpRows", () => {
  it("shows every platform a table it can actually type", () => {
    const mac = helpRows("macos");
    const win = helpRows("windows");
    expect(mac.some((r) => r.keys.includes("⌘"))).toBe(true);
    // The Windows table must contain no Mac glyph anywhere — this is the bug
    // the user hit: a hardcoded ⌘K on a keyboard with no Command key.
    expect(win.every((r) => !/[⌘⌥⌃]/.test(r.keys))).toBe(true);
    // Mac-only terminal chords simply aren't listed off a Mac.
    expect(mac.some((r) => r.id === "term-line-start")).toBe(true);
    expect(win.some((r) => r.id === "term-line-start")).toBe(false);
  });
});

describe("the shell keeps its own keys", () => {
  /** Canopy is terminal-first, and off macOS `Mod` is Ctrl — the same key
   *  readline and the terminal driver use for line editing. A bare
   *  Ctrl+<letter> app chord is consumed before the shell ever sees it (on
   *  Windows the menu's accelerator table is drained by TranslateAcceleratorW,
   *  in the message pump, ahead of the webview), so binding one silently
   *  breaks a key people use constantly.
   *
   *  This is the same reasoning that already kept dictation off Ctrl+D. */
  const READLINE = {
    KeyA: "beginning-of-line",
    KeyB: "backward-char (and the tmux prefix)",
    KeyD: "delete-char / EOF",
    KeyE: "end-of-line",
    KeyF: "forward-char",
    KeyG: "abort",
    KeyK: "kill-line",
    KeyL: "clear-screen",
    KeyN: "next-history",
    KeyP: "previous-history",
    KeyR: "reverse-search-history",
    KeyS: "forward-search-history (and XOFF)",
    KeyT: "transpose-chars",
    KeyU: "unix-line-discard",
    KeyW: "unix-word-rubout (and termios werase)",
    KeyY: "yank",
  } as const;

  /** The four we accepted keeping, because their readline bindings are ones
   *  almost nobody reaches for. Anything else has to justify itself here. */
  const ACCEPTED = new Set(["new-launcher", "new-terminal", "open-project", "save-file"]);

  it("binds no bare Ctrl+<letter> that readline needs", () => {
    for (const p of ["windows", "linux"] as Platform[]) {
      for (const id of globallyBoundIds()) {
        if (ACCEPTED.has(id)) continue;
        const c = resolve(id, p);
        if (!c?.code || !c.ctrl || c.shift || c.alt || c.meta) continue;
        const clash = READLINE[c.code as keyof typeof READLINE];
        expect(clash, `${id} takes ${format(id, p)} from the shell (${clash})`).toBeUndefined();
      }
    }
  });

  it("keeps the Mac chords exactly as they were", () => {
    // None of this applies on macOS: Mod is Command, which no shell uses. The
    // moves are per-platform overrides, so muscle memory here is untouched.
    expect(format("quick-open", "macos")).toBe("⌘P");
    expect(format("spot-search", "macos")).toBe("⌘K");
    expect(format("close-tab", "macos")).toBe("⌘W");
    expect(format("toggle-sidebar", "macos")).toBe("⌘B");
    expect(format("close-project", "macos")).toBe("⇧⌘W");
  });

  it("gives close-project its own key once close-tab takes Ctrl+Shift+W", () => {
    expect(format("close-tab", "windows")).toBe("Ctrl+Shift+W");
    // Ctrl+Alt is the project level off macOS, matching prev/next-project.
    expect(format("close-project", "windows")).toBe("Ctrl+Alt+W");
    expect(format("next-project", "windows")).toBe("Ctrl+Alt+PgDn");
  });
});

describe("the manifest itself", () => {
  it("binds every menu shortcut on every platform", () => {
    for (const id of idsOnSurface("menu")) {
      for (const p of ALL_PLATFORMS) {
        expect(accelerator(id, p), `${id} on ${p}`).toBeTruthy();
      }
    }
  });

  it("has no two shortcuts on the same chord on any platform", () => {
    for (const p of ALL_PLATFORMS) {
      const seen = new Map<string, string>();
      for (const id of globallyBoundIds()) {
        const c = resolve(id, p);
        if (!c || !c.code) continue;
        const k = `${c.meta}${c.ctrl}${c.alt}${c.shift}${c.code}`;
        expect(seen.get(k), `${id} collides with ${seen.get(k)} on ${p}`).toBeUndefined();
        seen.set(k, id);
      }
    }
  });
});

describe("main's own chords", () => {
  it("puts SpotSearch on the platform's own key", () => {
    expect(format("spot-search", "macos")).toBe("⌘K");
    // Ctrl+K is kill-line; off a Mac the chord takes Shift so the shell keeps it.
    expect(format("spot-search", "windows")).toBe("Ctrl+Shift+K");
    expect(matches(key("KeyK", { meta: true }), "spot-search", "macos")).toBe(true);
    expect(matches(key("KeyK", { ctrl: true }), "spot-search", "macos")).toBe(false);
    expect(matches(key("KeyK", { ctrl: true }), "spot-search", "windows")).toBe(false);
    expect(matches(key("KeyK", { ctrl: true, shift: true }), "spot-search", "windows")).toBe(true);
  });

  it("renders a digit range with the platform's modifier", () => {
    const mac = helpRows("macos").find((r) => r.id === "tab-jump")!;
    const win = helpRows("windows").find((r) => r.id === "tab-jump")!;
    expect(mac.keys).toBe("⌘1…9");
    expect(win.keys).toBe("Ctrl+1…9");
    // …and the prose that names the key follows the platform too.
    expect(mac.label).toContain("hold ⌘");
    expect(win.label).toContain("hold Ctrl");
  });

  it("lets a scoped chord reuse a global one", () => {
    // Settings' section jump is only live while Settings is open, so it may
    // share tab-jump's chord — the collision check above skips it by design.
    expect(resolve("settings-section", "macos")).toEqual(resolve("tab-jump", "macos"));
    expect(globallyBoundIds()).not.toContain("settings-section");
  });
});

describe("Rust parity", () => {
  /** The Rust menu builder resolves the same manifest (src-tauri/src/shortcuts.rs).
   *  These are the accelerator strings it produces; if the mapping here changes,
   *  the two sides have drifted and the native menu would advertise a key the
   *  webview does not answer. */
  it("produces the accelerator strings the native menu expects", () => {
    expect(accelerator("settings", "macos")).toBe("CmdOrCtrl+,");
    expect(accelerator("spot-search", "macos")).toBe("CmdOrCtrl+K");
    expect(accelerator("new-launcher", "windows")).toBe("CmdOrCtrl+N");
    expect(accelerator("new-project", "windows")).toBe("CmdOrCtrl+Shift+N");
    expect(accelerator("quick-open", "macos")).toBe("CmdOrCtrl+P");
    expect(accelerator("find-in-files", "windows")).toBe("CmdOrCtrl+Shift+F");
    expect(accelerator("next-tab", "macos")).toBe("Control+CmdOrCtrl+Right");
    expect(accelerator("next-tab", "windows")).toBe("CmdOrCtrl+PageDown");
    expect(accelerator("prev-project", "linux")).toBe("CmdOrCtrl+Alt+PageUp");
    expect(accelerator("toggle-zen", "macos")).toBe("CmdOrCtrl+Shift+Enter");
  });

  it("covers every id the Rust menu binds", () => {
    const rust = libRs;
    const bound = [...rust.matchAll(/accel\("([a-z-]+)"\)/g)].map((m) => m[1]);
    expect(bound.length).toBeGreaterThan(10);
    for (const id of bound) expect(() => resolve(id, "macos")).not.toThrow();
    // MENU_SHORTCUT_IDS is what the Rust parity test walks; it has to list
    // everything the menu actually binds or the coverage is a fiction.
    const listed = rust
      .slice(rust.indexOf("MENU_SHORTCUT_IDS"), rust.indexOf("fn build_menu"))
      .match(/"([a-z-]+)"/g)!
      .map((q: string) => q.slice(1, -1));
    for (const id of bound) expect(listed, `MENU_SHORTCUT_IDS is missing ${id}`).toContain(id);
  });
});

describe("no hand-rolled chords", () => {
  /** The regression guard. Every one of these bugs was a handler spelling its
   *  own chord: `metaKey || ctrlKey` fires on Ctrl+N on a Mac and Win+N on
   *  Windows, and a hardcoded ⌘ glyph tells a Windows user to press a key their
   *  keyboard does not have. Route new shortcuts through ./shortcuts instead. */
  const SOURCES: [string, string][] = [
    ["src/App.tsx", appTsx],
    ["src/microTasks.ts", microTasksTs],
    ["src/settings.ts", settingsTs],
    ["src/components/AgentWorkspaceView.tsx", agentWorkspaceTsx],
    ["src/components/AgentsPanel.tsx", agentsPanelTsx],
    ["src/components/ChangesPanel.tsx", changesPanelTsx],
    ["src/components/HelpDialog.tsx", helpDialogTsx],
    ["src/components/InstructionsView.tsx", instructionsTsx],
    ["src/components/Onboarding.tsx", onboardingTsx],
    ["src/components/ProjectView/index.tsx", projectViewTsx],
    ["src/components/TasksPanel.tsx", tasksPanelTsx],
    ["src/components/Term.tsx", termTsx],
  ];

  const stripComments = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  it("has no component testing metaKey or ctrlKey by hand", () => {
    for (const [name, src] of SOURCES) {
      expect(stripComments(src), `${name} reads modifier flags directly`).not.toMatch(
        /\.(metaKey|ctrlKey)\b/,
      );
    }
  });

  it("has no Mac glyph or Cmd+ literal in user-visible strings", () => {
    for (const [name, src] of SOURCES) {
      expect(stripComments(src), `${name} hardcodes a Mac-only shortcut label`).not.toMatch(
        /[⌘⌥⌃⇧]|Cmd\+/,
      );
    }
  });

  it("keeps the Rust menu free of literal accelerators", () => {
    const rust = libRs;
    expect(rust).not.toMatch(/Some\("(CmdOrCtrl|Control|Command|Alt|Shift)[+"]/);
  });
});
