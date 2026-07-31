import { describe, it, expect } from "vitest";
import {
  BUILTIN_MAP,
  EXTRA_ASSOCIATIONS,
  LANGUAGES,
  customLanguageFor,
  describePattern,
  effectiveAssociations,
  extraLanguageFor,
  normalizePattern,
  sanitizeAssociations,
} from "./fileAssociations";

describe("shipped associations", () => {
  it("covers the file types Monaco has no grammar for", () => {
    expect(extraLanguageFor("/repo/src/Card.astro")).toBe("html");
    expect(extraLanguageFor("/repo/src/Card.svelte")).toBe("html");
    expect(extraLanguageFor("/repo/engine/mesh.cpp")).toBe("cpp");
    expect(extraLanguageFor("/repo/engine/mesh.hpp")).toBe("cpp");
    expect(extraLanguageFor("/repo/Cargo.toml")).toBe("ini");
    expect(extraLanguageFor("/repo/package.json")).toBe("javascript");
  });

  it("matches dotfiles and name globs, case-insensitively", () => {
    expect(extraLanguageFor("/repo/.env")).toBe("ini");
    expect(extraLanguageFor("/repo/.env.local")).toBe("ini");
    expect(extraLanguageFor("/repo/.gitignore")).toBe("ini");
    expect(extraLanguageFor("/repo/Dockerfile.dev")).toBe("dockerfile");
    expect(extraLanguageFor("/repo/src/Mesh.CPP")).toBe("cpp");
  });

  it("leaves unknown file types alone", () => {
    expect(extraLanguageFor("/repo/notes.xyz")).toBeUndefined();
  });

  it("only points at grammars the picker offers", () => {
    const ids = new Set(LANGUAGES.map((l) => l.id));
    for (const [pattern, language] of Object.entries(BUILTIN_MAP)) {
      expect(ids.has(language), `${pattern} -> ${language}`).toBe(true);
    }
  });

  it("declares each pattern once", () => {
    const patterns = EXTRA_ASSOCIATIONS.flatMap((g) => g.entries.map((e) => e.pattern));
    expect(new Set(patterns).size).toBe(patterns.length);
  });
});

describe("custom associations", () => {
  it("wins over anything shipped", () => {
    expect(customLanguageFor("/repo/Card.astro", { "*.astro": "typescript" })).toBe(
      "typescript",
    );
  });

  it("prefers the more specific pattern", () => {
    const map = { "*.ts": "typescript", "*.d.ts": "plaintext", "types.ts": "javascript" };
    expect(customLanguageFor("/repo/api.ts", map)).toBe("typescript");
    expect(customLanguageFor("/repo/api.d.ts", map)).toBe("plaintext");
    // A literal name beats every wildcard, however long.
    expect(customLanguageFor("/repo/types.ts", map)).toBe("javascript");
  });

  it("matches on the file name, never the directories above it", () => {
    expect(customLanguageFor("/repo/astro/build.log", { "*.astro": "html" })).toBeUndefined();
  });

  it("ignores a language id this version no longer ships", () => {
    expect(sanitizeAssociations({ "*.astro": "astro", "*.zig": "rust" })).toEqual({
      "*.zig": "rust",
    });
  });
});

describe("normalizePattern", () => {
  it("canonicalises however the extension was typed", () => {
    for (const input of ["astro", ".astro", "*.astro", "  .astro "]) {
      expect(normalizePattern(input, "ext")).toBe("*.astro");
    }
  });

  it("keeps a file name as written, wildcards included", () => {
    expect(normalizePattern("Dockerfile.*", "name")).toBe("Dockerfile.*");
    expect(normalizePattern("/repo/Makefile", "name")).toBe("Makefile");
  });

  it("rejects empty input", () => {
    expect(normalizePattern("   ", "ext")).toBeNull();
    expect(normalizePattern(".", "ext")).toBeNull();
  });
});

describe("effectiveAssociations", () => {
  it("flags overridden and user-added rows", () => {
    const rows = effectiveAssociations({ "*.astro": "typescript", "*.nix": "shell" });
    const astro = rows.find((r) => r.pattern === "*.astro");
    expect(astro).toMatchObject({ language: "typescript", builtin: true, overridden: true });
    const nix = rows.find((r) => r.pattern === "*.nix");
    expect(nix).toMatchObject({ language: "shell", builtin: false, overridden: false });
    // Re-picking the language it already ships with isn't an override.
    const same = effectiveAssociations({ "*.astro": "html" }).find(
      (r) => r.pattern === "*.astro",
    );
    expect(same?.overridden).toBe(false);
  });

  it("lists user-added mappings first", () => {
    expect(effectiveAssociations({ "*.nix": "shell" })[0].pattern).toBe("*.nix");
  });
});

describe("describePattern", () => {
  it("shows extensions as suffixes and names as themselves", () => {
    expect(describePattern("*.astro")).toBe(".astro");
    expect(describePattern("Dockerfile.*")).toBe("Dockerfile.*");
  });
});
