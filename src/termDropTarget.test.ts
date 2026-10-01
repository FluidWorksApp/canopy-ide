// OS file drops must be listened for on the WEBVIEW WINDOW. If this goes red,
// someone has reached for `getCurrentWindow()` or `getCurrentWebview()` again
// — both of which have already shipped as silent, total drag-drop outages.
//
// Tauri routes a drop by the main webview's `WebviewKind`. With
// `features = ["unstable"]` in src-tauri/Cargo.toml — which browser.rs needs
// for `add_child` — tauri-runtime-wry creates the window's own webview as
// `WindowChild`, so every drop is emitted through `emit_to_webview` to the
// `Webview` target. `filter_target` (tauri/src/manager/mod.rs) then decides
// what a listener sees:
//
//   listener target  | AnyLabel | Window | Webview
//   -----------------+----------+--------+---------
//   Window           |   yes    |  yes   |   NO     <- v0.2.18: drops dead
//   Webview          |   yes    |   NO   |  yes     <- v0.2.17: dead w/ preview
//   WebviewWindow    |   yes    |  yes   |  yes     <- the only correct one
//
// So this is not a style preference: either of the other two is one build-config
// change away from being wrong, and nothing else catches it. The failure mode is
// a drop that does nothing, which no behavioural test in this suite observes.
/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

/** Every surface that receives an OS file drop. A new one belongs here — the
 *  claim is that no drop listener anywhere escapes the rule. */
const DROP_SURFACES = ["terminalWindowEvents.ts", "components/ChatView.tsx"];

/** Code only. The rule is explained in prose above the call sites, and that
 *  prose names the two wrong handles — scanning it would fail on the fix. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("OS file drops listen on the webview window", () => {
  for (const rel of DROP_SURFACES) {
    it(`${rel} takes its drop handle from getCurrentWebviewWindow`, () => {
      const code = stripComments(readFileSync(join(SRC, rel), "utf8"));

      expect(code).toContain("onDragDropEvent");
      expect(code).toContain("getCurrentWebviewWindow");

      // `getCurrentWebviewWindow` contains `getCurrentWebview`, so the bare
      // form is matched by its call paren rather than by name alone.
      for (const bad of ["getCurrentWindow", "getCurrentWebview("]) {
        expect(
          code.includes(bad),
          `${rel} still reaches for ${bad} — see the table at the top of this file`,
        ).toBe(false);
      }
    });
  }
});
