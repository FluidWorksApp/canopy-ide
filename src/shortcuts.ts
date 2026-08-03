// Every keyboard shortcut in Canopy, resolved for the platform the app is
// actually running on.
//
// The chords live in shared/shortcuts.json, which the Rust side reads too (see
// src-tauri/src/shortcuts.rs) — so a native menu accelerator and the webview
// handler that backs it up can never drift apart, and can never drift apart
// per platform either. Nothing here should hardcode a chord; if you need a new
// one, add it to the manifest.
//
// Why this exists: shortcuts were written on a Mac and read as Mac. Handlers
// spelled `e.metaKey || e.ctrlKey`, which fires on the wrong key on both
// platforms (Ctrl+N on a Mac, Win+N on Windows), and menu accelerators used
// `Control+CmdOrCtrl+Right` — ⌃⌘→ on a Mac, but plain Ctrl+→ everywhere else,
// where it is word-jump in every text field.
import manifest from "../shared/shortcuts.json";
import { IS_MAC } from "./platform";

export type Platform = "macos" | "windows" | "linux";

/** Abstract modifier tokens. `Mod` is the platform's primary command key —
 *  Command on macOS, Control elsewhere — and is what almost every chord wants.
 *  `Ctrl` and `Meta` are the literal physical keys. */
export type Mod = "Mod" | "Ctrl" | "Alt" | "Shift" | "Meta";

/** A chord after platform resolution: the four modifier flags a KeyboardEvent
 *  carries, plus a `KeyboardEvent.code`. `code: null` is a modifier-only chord,
 *  held while clicking. */
export interface Chord {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  code: string | null;
}

interface RawChord {
  mods: Mod[];
  key: string | null;
}

interface RawShortcut {
  id: string;
  label: string;
  surface: "menu" | "app" | "terminal";
  chord: RawChord;
  platform?: Partial<Record<Platform, RawChord | null>>;
  /** Listed in the Help dialog's shortcut table. Defaults to true. */
  help?: boolean;
  /** How the key renders in the help table, when the real binding is a range
   *  rather than one key ("1…9" for the digit jumps). */
  keyLabel?: string;
  /** Live only while one surface has focus, so it may reuse a global chord.
   *  Excluded from the collision check for that reason. */
  scoped?: boolean;
  note?: string;
}

interface RawProfileOverride {
  chord: RawChord;
  platform?: Partial<Record<Platform, RawChord | null>>;
}

interface RawProfile {
  label: string;
  description: string;
  overrides?: Record<string, RawProfileOverride>;
}

export type ShortcutProfile = "canopy" | "vscode" | "jetbrains" | "sublime";

const parsedManifest = manifest as {
  shortcuts: RawShortcut[];
  profiles: Record<ShortcutProfile, RawProfile>;
};
const SHORTCUTS = parsedManifest.shortcuts;
const PROFILES = parsedManifest.profiles;

export const SHORTCUT_PROFILES = (Object.entries(PROFILES) as [ShortcutProfile, RawProfile][]).map(
  ([id, profile]) => ({ id, label: profile.label, description: profile.description }),
);

export function isShortcutProfile(value: unknown): value is ShortcutProfile {
  return typeof value === "string" && value in PROFILES;
}

/** Read directly from the settings envelope to avoid a settings -> shortcuts
 * runtime cycle. Resolution happens on keydown, so a changed profile is live
 * immediately without remounting every surface that uses a shortcut. */
export function currentShortcutProfile(): ShortcutProfile {
  if (typeof localStorage === "undefined") return "canopy";
  try {
    const value = (JSON.parse(localStorage.getItem("canopy.settings") ?? "{}") as {
      keymapProfile?: unknown;
    }).keymapProfile;
    return isShortcutProfile(value) ? value : "canopy";
  } catch {
    return "canopy";
  }
}

export type ShortcutId = string;

/** Which OS the webview runs on. Builds on platform.ts's IS_MAC rather than
 *  sniffing again — one answer to "which machine is this", so a shortcut and a
 *  titlebar can't disagree. */
export function currentPlatform(): Platform {
  if (IS_MAC) return "macos";
  const p = typeof navigator !== "undefined" ? navigator.platform.toUpperCase() : "";
  return p.includes("WIN") ? "windows" : "linux";
}

const byId = new Map(SHORTCUTS.map((s) => [s.id, s]));

/** Turn abstract modifier tokens into the concrete flags a KeyboardEvent has
 *  on this platform. `Mod` is the only token that moves. */
function toChord(raw: RawChord, platform: Platform): Chord {
  const mac = platform === "macos";
  const has = (m: Mod) => raw.mods.includes(m);
  return {
    meta: has("Meta") || (mac && has("Mod")),
    ctrl: has("Ctrl") || (!mac && has("Mod")),
    alt: has("Alt"),
    shift: has("Shift"),
    code: raw.key,
  };
}

/** The chord for `id` on `platform`, or null when it is deliberately unbound
 *  there (`"platform": { "windows": null }` in the manifest). Throws on an
 *  unknown id — a typo'd shortcut should fail loudly, not silently never fire. */
export function resolve(
  id: ShortcutId,
  platform: Platform = currentPlatform(),
  profile: ShortcutProfile = currentShortcutProfile(),
): Chord | null {
  const s = byId.get(id);
  if (!s) throw new Error(`unknown shortcut id: ${id}`);
  const profileOverride = PROFILES[profile].overrides?.[id];
  const source = profileOverride ?? s;
  const override = source.platform && platform in source.platform ? source.platform[platform] : undefined;
  if (override === null) return null;
  return toChord(override ?? source.chord, platform);
}

/** Does this keydown match `id` on the current platform?
 *
 *  Every modifier flag is compared, not just the ones the chord asks for: a
 *  chord that wants Cmd+N must not also fire on Cmd+Shift+N (which is a
 *  different shortcut) or on Ctrl+N (which is the wrong key on this platform). */
export function matches(
  e: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  id: ShortcutId,
  platform: Platform = currentPlatform(),
  profile: ShortcutProfile = currentShortcutProfile(),
): boolean {
  const c = resolve(id, platform, profile);
  return c !== null && c.code !== null && matchesChord(e, c);
}

/** Chord comparison against an already-resolved chord — for handlers holding a
 *  user-rebound chord (dictation) rather than a manifest id. */
export function matchesChord(
  e: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  c: Chord,
): boolean {
  return (
    e.code === c.code &&
    e.metaKey === c.meta &&
    e.ctrlKey === c.ctrl &&
    e.altKey === c.alt &&
    e.shiftKey === c.shift
  );
}

/** Do this event's modifiers match `id`'s exactly, ignoring which key was
 *  pressed? For chords whose "key" is a range — the digit jumps, where any of
 *  1..9 is valid — so the modifier half still comes from the registry. */
export function modifierOnly(
  e: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  id: ShortcutId,
  platform: Platform = currentPlatform(),
  profile: ShortcutProfile = currentShortcutProfile(),
): boolean {
  const c = resolve(id, platform, profile);
  return (
    c !== null &&
    e.metaKey === c.meta &&
    e.ctrlKey === c.ctrl &&
    e.altKey === c.alt &&
    e.shiftKey === c.shift
  );
}

/** Is this mouse click carrying the modifier-only chord `id`? Used for
 *  Cmd-click-to-open-in-browser, which is Ctrl-click off a Mac — and which must
 *  NOT accept Ctrl on a Mac, where Ctrl+click is the OS's right-click. */
export function matchesModifierClick(
  e: Pick<MouseEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  id: ShortcutId,
  platform: Platform = currentPlatform(),
  profile: ShortcutProfile = currentShortcutProfile(),
): boolean {
  const c = resolve(id, platform, profile);
  if (!c) return false;
  return e.metaKey === c.meta && e.ctrlKey === c.ctrl && e.altKey === c.alt;
}

/** The primary command modifier's flags for this platform: Command on macOS,
 *  Control elsewhere. For the handful of chords whose *key* is open-ended —
 *  window zoom takes +, =, -, 0 and their numpad twins — where a chord id can
 *  name the modifier but not the key. */
export function commandModifier(platform: Platform = currentPlatform()) {
  return platform === "macos"
    ? { meta: true, ctrl: false }
    : { meta: false, ctrl: true };
}

/** Is the platform's command modifier down, and the other platform's not?
 *  Shift and Alt are not considered — callers that care check them. */
export function commandHeld(
  e: Pick<KeyboardEvent, "metaKey" | "ctrlKey">,
  platform: Platform = currentPlatform(),
): boolean {
  const m = commandModifier(platform);
  return e.metaKey === m.meta && e.ctrlKey === m.ctrl;
}

/** Ctrl down without Command. This belongs to the program in the terminal
 *  (readline's C-u, C-0), and off macOS it is *also* the app's command
 *  modifier — which is exactly the collision the zoom handler has to sidestep. */
export function terminalOwnsCtrl(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey">): boolean {
  return e.ctrlKey && !e.metaKey;
}

// ---------- display ----------

const MAC_KEY_GLYPHS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  // Enter is deliberately absent: "⌘⇧Enter" reads better than "⌘⇧⏎", and
  // that is how the Help dialog has always spelled focus mode.
  Backspace: "⌫",
  Delete: "⌦",
  Tab: "⇥",
  Escape: "⎋",
  Space: "␣",
  Comma: ",",
  Period: ".",
  PageUp: "⇞",
  PageDown: "⇟",
  Home: "↖",
  End: "↘",
};

const KEY_WORDS: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Backspace: "Backspace",
  Delete: "Delete",
  Escape: "Esc",
  Space: "Space",
  Comma: ",",
  Period: ".",
  PageUp: "PgUp",
  PageDown: "PgDn",
};

/** How this platform names a bare modifier key — "⌘ Command" on a Mac, "Win"
 *  off it. One place decides, so a key list and a chord can't disagree. */
export function modifierLabel(
  base: "Shift" | "Control" | "Alt" | "Meta",
  platform: Platform = currentPlatform(),
): string {
  const mac: Record<string, string> = {
    Shift: "⇧ Shift",
    Control: "⌃ Control",
    Alt: "⌥ Option",
    Meta: "⌘ Command",
  };
  const other: Record<string, string> = {
    Shift: "Shift",
    Control: "Ctrl",
    Alt: "Alt",
    Meta: "Win",
  };
  return (platform === "macos" ? mac : other)[base];
}

/** Human label for a KeyboardEvent.code (KeyD → "D", Digit1 → "1"). */
export function keyLabel(code: string, platform: Platform = currentPlatform()): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (platform === "macos" && MAC_KEY_GLYPHS[code]) return MAC_KEY_GLYPHS[code];
  return KEY_WORDS[code] ?? code;
}

/** Render a resolved chord for the user: "⌘⇧F" on a Mac, "Ctrl+Shift+F"
 *  elsewhere — the conventions of each platform, not a translation of ours. */
export function formatChord(c: Chord, platform: Platform = currentPlatform()): string {
  const parts: string[] = [];
  if (platform === "macos") {
    if (c.ctrl) parts.push("⌃");
    if (c.alt) parts.push("⌥");
    if (c.shift) parts.push("⇧");
    if (c.meta) parts.push("⌘");
    if (c.code) parts.push(keyLabel(c.code, platform));
    return parts.join("");
  }
  if (c.ctrl) parts.push("Ctrl");
  if (c.alt) parts.push("Alt");
  if (c.shift) parts.push("Shift");
  if (c.meta) parts.push("Win");
  if (c.code) parts.push(keyLabel(c.code, platform));
  return parts.join("+");
}

/** Render a shortcut by id, e.g. `format("quick-open")` → "⌘P" / "Ctrl+P".
 *  Empty string when it is unbound on this platform.
 *
 *  A manifest `keyLabel` replaces just the key and keeps the platform's own
 *  modifiers — "⌘1…9" / "Ctrl+1…9" for a chord whose key is really a range. */
export function format(
  id: ShortcutId,
  platform: Platform = currentPlatform(),
  profile: ShortcutProfile = currentShortcutProfile(),
): string {
  const c = resolve(id, platform, profile);
  if (!c) return "";
  const override = byId.get(id)?.keyLabel;
  if (!override) return formatChord(c, platform);
  const mods = formatChord({ ...c, code: null }, platform);
  return mods + (platform === "macos" || !mods ? "" : "+") + override;
}

/** "Toggle sidebar (⌘B)" — for a title/tooltip that names its shortcut. */
export function withShortcut(text: string, id: ShortcutId): string {
  const f = format(id);
  return f ? `${text} (${f})` : text;
}

// ---------- introspection (Help dialog, tests) ----------

export interface ShortcutRow {
  id: string;
  label: string;
  keys: string;
  surface: RawShortcut["surface"];
}

/** Fill {mod}/{alt} in a label with this platform's spelling, so prose like
 *  "hold {mod} and the tabs show their numbers" never hardcodes a ⌘. */
export function fillLabel(label: string, platform: Platform = currentPlatform()): string {
  const mac = platform === "macos";
  return label
    .replace(/\{mod\}/g, mac ? "⌘" : "Ctrl")
    .replace(/\{alt\}/g, mac ? "⌥" : "Alt");
}

/** Every shortcut worth showing the user, in manifest order, formatted for
 *  this platform. Unbound and `help: false` entries are dropped, which is how
 *  the Mac-only terminal chords disappear from the Windows help table. */
export function helpRows(
  platform: Platform = currentPlatform(),
  profile: ShortcutProfile = currentShortcutProfile(),
): ShortcutRow[] {
  return SHORTCUTS.filter((s) => s.help !== false)
    .map((s) => ({
      id: s.id,
      label: fillLabel(s.label, platform),
      keys: format(s.id, platform, profile),
      surface: s.surface,
    }))
    .filter((r) => r.keys !== "");
}

/** Ids of every shortcut on a given surface — the menu builder's checklist and
 *  what the parity test walks. */
export function idsOnSurface(surface: RawShortcut["surface"]): string[] {
  return SHORTCUTS.filter((s) => s.surface === surface).map((s) => s.id);
}

/** Ids whose chord must be globally unique — everything except the ones the
 *  manifest marks `scoped` (bound only while one dialog has focus). */
export function globallyBoundIds(): string[] {
  return SHORTCUTS.filter((s) => !s.scoped && s.surface !== "terminal").map((s) => s.id);
}

export const ALL_PLATFORMS: Platform[] = ["macos", "windows", "linux"];

/** A chord that is bound on this platform and has a key — the shape a stored,
 *  user-rebindable hotkey needs. Throws if the manifest leaves `id` unbound
 *  here, so it is only for shortcuts defined on every platform. */
export function requireKeyChord(id: ShortcutId): Chord & { code: string } {
  const c = resolve(id);
  if (!c || c.code === null) throw new Error(`${id} has no key chord on this platform`);
  return c as Chord & { code: string };
}

// ---------- Tauri accelerators ----------

const ACCEL_KEYS: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Comma: ",",
  Period: ".",
  Space: "Space",
};

const ACCEL_MODS: Record<Mod, string> = {
  Mod: "CmdOrCtrl",
  Ctrl: "Control",
  Alt: "Alt",
  Shift: "Shift",
  Meta: "Super",
};

/** The chord as written in the manifest for `platform`, before Mod is resolved
 *  to a physical key. Accelerators are built from this rather than from the
 *  resolved flags: Tauri has its own token for "Mod" (CmdOrCtrl), and going
 *  through flags would lose the distinction between it and a literal Control. */
function rawFor(id: ShortcutId, platform: Platform, profile: ShortcutProfile): RawChord | null {
  const s = byId.get(id);
  if (!s) throw new Error(`unknown shortcut id: ${id}`);
  const profileOverride = PROFILES[profile].overrides?.[id];
  const source = profileOverride ?? s;
  const override = source.platform && platform in source.platform ? source.platform[platform] : undefined;
  if (override === null) return null;
  return override ?? source.chord;
}

/** The accelerator string Tauri's menu wants for `id` on `platform`. The Rust
 *  side computes this from the same manifest; shortcuts.test.ts asserts the two
 *  agree, so this is the contract between them rather than a second opinion. */
export function accelerator(
  id: ShortcutId,
  platform: Platform = currentPlatform(),
  profile: ShortcutProfile = currentShortcutProfile(),
): string | null {
  const raw = rawFor(id, platform, profile);
  if (!raw || !raw.key) return null;
  const order: Mod[] = ["Ctrl", "Mod", "Alt", "Shift", "Meta"];
  const parts = order.filter((m) => raw.mods.includes(m)).map((m) => ACCEL_MODS[m]);
  let key = raw.key;
  if (key.startsWith("Key")) key = key.slice(3);
  else if (key.startsWith("Digit")) key = key.slice(5);
  else key = ACCEL_KEYS[key] ?? key;
  parts.push(key);
  return parts.join("+");
}
