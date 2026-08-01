// A skin used to be five edits in five files, and forgetting one was silent —
// the app recoloured and the terminal quietly stayed Tokyo Night. This is the
// test that makes "half a skin" impossible. If it goes red, a skin is missing
// a piece; add the piece rather than exempting the skin.
/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SKINS, skinDef } from "./registry";
import { THEMES } from "../settings";
import { terminalTheme } from "../terminalThemes";

const DIR = join(process.cwd(), "src", "skins");
const css = (name: string) => readFileSync(join(DIR, name), "utf8");

/** The eighteen a skin has to declare — the same eighteen `:root` declares in
 *  index.css, in the same order. A skin that leaves one out inherits Default's,
 *  which is how a "warm" skin ends up with one cold border nobody can find. */
const TOKENS = [
  "--bg-deep",
  "--bg-alt",
  "--bg",
  "--bg-raised",
  "--bg-overlay",
  "--border",
  "--border-strong",
  "--text",
  "--text-dim",
  "--text-faint",
  "--accent",
  "--danger",
  "--ok",
  "--warn",
  "--magenta",
  "--cyan",
  "--on-accent",
  "--on-danger",
];

/** The base skin has no file of its own: its palette IS the `:root` contract
 *  that every other block overrides. */
const CSS_LESS = new Set(["gotham"]);

describe("the skin roster", () => {
  it("has a unique id and label for every skin", () => {
    expect(new Set(SKINS.map((s) => s.id)).size).toBe(SKINS.length);
    expect(new Set(SKINS.map((s) => s.label)).size).toBe(SKINS.length);
  });

  it("offers every skin in the picker, between Auto and Custom", () => {
    expect(THEMES.map((t) => t.id)).toEqual([
      "auto",
      ...SKINS.map((s) => s.id),
      "custom",
    ]);
  });

  it("gives every skin a terminal background of its own", () => {
    // The switch this replaced fell through to Default, so pinning the one
    // slot no two skins share is what catches a palette that never landed.
    const backgrounds = SKINS.map((s) => terminalTheme(s.id).background);
    expect(new Set(backgrounds).size).toBe(SKINS.length);
  });

  it("gives every skin a Monaco surface of its own", () => {
    const surfaces = SKINS.map((s) => s.monaco.colors["editor.background"]);
    for (const surface of surfaces) expect(surface).toBeTruthy();
  });

  it("previews a palette, not a placeholder", () => {
    for (const s of SKINS) {
      expect(s.note, s.id).toMatch(/^[^A-Z]/); // lowercase, picker voice
      expect(s.note.endsWith("."), s.id).toBe(false);
      for (const k of ["bg", "raised", "text", "accent"] as const) {
        expect(s.preview[k], `${s.id}.preview.${k}`).toBeTruthy();
      }
    }
  });

  it("resolves an unknown id to the base skin rather than throwing", () => {
    expect(skinDef("no-such-skin").id).toBe("gotham");
  });

  // Retiring a skin is meant to need no migration code: whatever anyone has
  // stored simply stops matching and the base skin answers. If this goes red,
  // someone has made a removed id throw or resolve somewhere else.
  it("answers for a retired id with the base skin", () => {
    expect(skinDef("default").id).toBe("gotham");
    expect(terminalTheme("default" as never).background).toBe(
      skinDef("gotham").term.background,
    );
  });
});

describe("every skin's token block", () => {
  const withCss = SKINS.filter((s) => !CSS_LESS.has(s.id));

  it("is imported by skins.css, in roster order", () => {
    const imports = [
      ...css("skins.css").matchAll(/@import "\.\/(.+)\.css"/g),
    ].map((m) => m[1]);
    expect(imports).toEqual(withCss.map((s) => s.id));
  });

  it("exists as src/skins/<id>.css", () => {
    for (const s of withCss) {
      expect(existsSync(join(DIR, `${s.id}.css`)), s.id).toBe(true);
    }
  });

  it("declares all eighteen tokens, plus the two derivations", () => {
    for (const s of withCss) {
      const block = css(`${s.id}.css`);
      expect(block, s.id).toContain(`:root[data-theme="${s.id}"]`);
      for (const t of TOKENS) {
        // `--bg:` must not match `--bg-deep:`, so anchor on the colon.
        expect(block.includes(`${t}:`), `${s.id} is missing ${t}`).toBe(true);
      }
      expect(block.includes("--accent-soft:"), `${s.id} --accent-soft`).toBe(
        true,
      );
      expect(block.includes("--ring:"), `${s.id} --ring`).toBe(true);
      // Without this the OS paints scrollbars and form controls for the wrong
      // half of the day — the single most visible way a light skin looks broken.
      expect(block, s.id).toMatch(/color-scheme:\s*(light|dark)/);
    }
  });

  it("gives a light skin the shadows to go with it", () => {
    // Shadows in index.css are cool-black and tuned for a dark shell; a light
    // skin that inherits them gets grey smudges under its dialogs.
    for (const s of withCss) {
      const block = css(`${s.id}.css`);
      if (!/color-scheme:\s*light/.test(block)) continue;
      for (const shadow of ["--shadow-1:", "--shadow-2:", "--shadow-3:"]) {
        expect(block.includes(shadow), `${s.id} is missing ${shadow}`).toBe(
          true,
        );
      }
    }
  });
});
