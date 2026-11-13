/* tslint:disable */
/* eslint-disable */
/**
 * One terminal screen. Feed it PTY output, read the screen back.
 */
export class Terminal {
  free(): void;
  /**
   * The bytes a key event sends to the program under its current modes
   * (cursor and keypad application modes, kitty keyboard flags); empty
   * when the event sends nothing.
   *
   * `key` is a single character (the unshifted character of the key) or a
   * name: `Escape`, `Enter`, `Tab`, `Backspace`, `Insert`, `Delete`,
   * `Left`, `Right`, `Up`, `Down`, `PageUp`, `PageDown`, `Home`, `End`,
   * `CapsLock`, `ScrollLock`, `NumLock`, `PrintScreen`, `Pause`, `Menu`,
   * `F1`..`F35`, `Kp<name>` for the keypad (`Kp0`..`Kp9`, `KpDecimal`,
   * `KpDivide`, `KpMultiply`, `KpSubtract`, `KpAdd`, `KpEnter`, `KpEqual`)
   * and `Mod<name>` for a modifier key (`ModLeftShift`...). An unknown
   * name sends nothing.
   *
   * `kind`: 0 press, 1 repeat, 2 release. `mods`: shift 1, alt 2, ctrl 4,
   * super 8, caps lock 64, num lock 128. `text` is what the key types
   * (empty for none); `shifted` and `base` are the kitty alternates as
   * code points (0 for none).
   */
  encode_key(key: string, mods: number, kind: number, text: string, shifted: number, base: number): Uint8Array;
  damage_full(since: number): boolean;
  /**
   * Rows changed since frame `since`, as `[first, last, first, last, ...]`
   * inclusive; empty and `damage_full()` true when everything changed.
   */
  damage_rows(since: number): Uint16Array;
  /**
   * Bell, OSC 52 and OSC 133 events since the last call, as JSON.
   */
  take_events(): string;
  /**
   * The focus report (`CSI I` / `CSI O`); empty unless the program asked
   * for focus events.
   */
  encode_focus(focused: boolean): Uint8Array;
  /**
   * The report a mouse event sends under the program's mouse mode and
   * encoding; empty when the mode does not report it.
   *
   * `kind`: 0 press (or one wheel step), 1 release, 2 motion. `button`: 0
   * left, 1 middle, 2 right, 3 none (motion only), 4 wheel up, 5 wheel
   * down, 6 wheel left, 7 wheel right, 8 back, 9 forward. `col` and `row`
   * are 0-based cells.
   */
  encode_mouse(kind: number, button: number, col: number, row: number, mods: number): Uint8Array;
  /**
   * A paste as the program should receive it: bracketed when it asked for
   * that, newlines as Enter otherwise. `strip_controls` removes control
   * characters (ESC included) so pasted text can neither end the bracket
   * early nor type key sequences.
   */
  encode_paste(text: string, strip_controls: boolean): Uint8Array;
  /**
   * The OSC 8 link target on a visible cell.
   */
  hyperlink_at(row: number, col: number): string | undefined;
  /**
   * Answers the program asked for (device attributes, cursor position,
   * colour queries...), to be written back to the PTY. Drain after every
   * `advance`.
   */
  take_replies(): Uint8Array;
  scrollback_len(): number;
  /**
   * The scrollback lines' text, one string per line.
   */
  scrollback_text(start: number, count: number): string[];
  /**
   * `count` scrollback lines from `start` (0 is the oldest), packed, each
   * padded or cut to the current width. Clusters come from
   * [`Terminal::scrollback_clusters`] with the same arguments.
   */
  scrollback_cells(start: number, count: number): Uint32Array;
  /**
   * Default fg, bg and cursor as 0xRRGGBB (negative: unset), for answering
   * OSC 10/11/12 queries.
   */
  set_reply_colors(fg: number, bg: number, cursor: number): void;
  /**
   * Cluster texts of each scrollback line, flattened as `[line0 count,
   * ...line0 clusters, line1 count, ...]` (index 0 of each line included).
   */
  scrollback_clusters(start: number, count: number): string[];
  /**
   * The 16 ANSI colours as 0xRRGGBB, for answering OSC 4 queries.
   */
  set_default_palette(colors: Uint32Array): void;
  constructor(cols: number, rows: number, scrollback: number);
  cols(): number;
  rows(): number;
  /**
   * Visible screen as text (rows joined with `\n`).
   */
  text(): string;
  /**
   * The visible grid, packed (see the crate docs).
   */
  cells(): Uint32Array;
  /**
   * `[mouse (0 off, 1 press, 2 normal, 3 drag, 4 any), encoding (0 default,
   * 1 utf8, 2 sgr), bracketed_paste, app_cursor_keys, app_keypad,
   * focus_events, sync_output, kitty_keyboard, alt_screen]`.
   */
  modes(): Uint32Array;
  title(): string | undefined;
  /**
   * `[row, col, shape (0 block, 1 underline, 2 bar), visible, blinking]`.
   */
  cursor(): Uint32Array;
  /**
   * See [`digest`].
   */
  digest(): string;
  resize(cols: number, rows: number): void;
  /**
   * Feed PTY output. Any split of the same stream gives the same screen.
   */
  advance(bytes: Uint8Array): void;
  /**
   * Read the current screen into this handle. Returns its sequence number;
   * the getters below describe this frame until the next `refresh`.
   */
  refresh(): number;
  /**
   * A screen brought to the state of a [`Terminal::snapshot`].
   */
  static restore(cols: number, rows: number, snapshot: Uint8Array): Terminal;
  /**
   * Cluster texts; index 0 is unused.
   */
  clusters(): string[];
  /**
   * Escape sequences that bring a fresh screen to this one's visible state.
   */
  snapshot(): Uint8Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_terminal_free: (a: number, b: number) => void;
  readonly terminal_advance: (a: number, b: number, c: number) => void;
  readonly terminal_cells: (a: number) => [number, number];
  readonly terminal_clusters: (a: number) => [number, number];
  readonly terminal_cols: (a: number) => number;
  readonly terminal_cursor: (a: number) => [number, number];
  readonly terminal_damage_full: (a: number, b: number) => number;
  readonly terminal_damage_rows: (a: number, b: number) => [number, number];
  readonly terminal_digest: (a: number) => [number, number];
  readonly terminal_encode_focus: (a: number, b: number) => [number, number];
  readonly terminal_encode_key: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
  readonly terminal_encode_mouse: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
  readonly terminal_encode_paste: (a: number, b: number, c: number, d: number) => [number, number];
  readonly terminal_hyperlink_at: (a: number, b: number, c: number) => [number, number];
  readonly terminal_modes: (a: number) => [number, number];
  readonly terminal_new: (a: number, b: number, c: number) => number;
  readonly terminal_refresh: (a: number) => number;
  readonly terminal_resize: (a: number, b: number, c: number) => void;
  readonly terminal_restore: (a: number, b: number, c: number, d: number) => number;
  readonly terminal_rows: (a: number) => number;
  readonly terminal_scrollback_cells: (a: number, b: number, c: number) => [number, number];
  readonly terminal_scrollback_clusters: (a: number, b: number, c: number) => [number, number];
  readonly terminal_scrollback_len: (a: number) => number;
  readonly terminal_scrollback_text: (a: number, b: number, c: number) => [number, number];
  readonly terminal_set_default_palette: (a: number, b: number, c: number) => void;
  readonly terminal_set_reply_colors: (a: number, b: number, c: number, d: number) => void;
  readonly terminal_snapshot: (a: number) => [number, number];
  readonly terminal_take_events: (a: number) => [number, number];
  readonly terminal_take_replies: (a: number) => [number, number];
  readonly terminal_text: (a: number) => [number, number];
  readonly terminal_title: (a: number) => [number, number];
  readonly __wbindgen_export_0: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __externref_drop_slice: (a: number, b: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
