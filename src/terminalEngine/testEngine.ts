// Tests only: load the committed wasm build from disk (a test DOM cannot
// fetch it the way the app does).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadGhosttyFromBytes } from "./ghostty/engine";

export function loadEngineForTests(): void {
  loadGhosttyFromBytes(
    readFileSync(resolve(process.cwd(), "src/terminalEngine/pkg/canopy_term_wasm_bg.wasm")),
  );
}
