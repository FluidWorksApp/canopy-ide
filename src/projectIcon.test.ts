import { describe, expect, it, beforeEach } from "vitest";
import {
  MAX_ICON_BYTES,
  bytesToDataUrl,
  cachedIcon,
  detectProjectIcons,
  iconLinkHrefs,
  iconSignature,
  isIconFile,
  loadBestIcon,
  normalizeProjectIcon,
  rankIconCandidates,
  rememberIcon,
  resolveIconHref,
  sizeHint,
  sniffImageType,
  tabIconFor,
  type IconCandidate,
  type IconFs,
} from "./projectIcon";
import { resolveProjectIcon } from "./useProjectIcons";

const ROOT = "/home/dev/acme-widgets";
const cand = (rel: string, extra: Partial<IconCandidate> = {}): IconCandidate => ({
  path: `${ROOT}/${rel}`,
  rel,
  component: 0,
  ...extra,
});
const order = (list: IconCandidate[]) => rankIconCandidates(list).map((c) => c.rel);

const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>');
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const ICO = Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16]);

/** An in-memory project tree: path → bytes. Directories are implied. */
function memoryFs(files: Record<string, Uint8Array | string>, opts: { scoped?: boolean } = {}): IconFs & { reads: string[] } {
  const bytes = new Map(
    Object.entries(files).map(([p, v]) => [p, typeof v === "string" ? new TextEncoder().encode(v) : v]),
  );
  const reads: string[] = [];
  const outOfScope = () => new Error("path outside workspace scope");
  return {
    reads,
    async readDir(path) {
      if (opts.scoped === false) throw outOfScope();
      const prefix = path.replace(/\/$/, "") + "/";
      const names = new Map<string, boolean>();
      for (const p of bytes.keys()) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const [head, ...tail] = rest.split("/");
        names.set(head, tail.length > 0 || names.get(head) === true);
      }
      if (!names.size) throw new Error("No such file or directory");
      return [...names].map(([name, is_dir]) => ({ name, path: prefix + name, is_dir }));
    },
    async statMany(paths) {
      return paths.filter((p) => bytes.has(p)).map((p) => ({ path: p, size: bytes.get(p)!.length }));
    },
    async readFile(path, maxBytes) {
      reads.push(path);
      const b = bytes.get(path);
      if (!b) throw new Error("No such file or directory");
      if (b.length > maxBytes) throw new Error("file is too large to load");
      return b;
    },
  };
}

describe("rankIconCandidates", () => {
  it("prefers SVG, then PNG, then ICO", () => {
    expect(order([cand("public/favicon.ico"), cand("public/favicon.png"), cand("public/favicon.svg")])).toEqual([
      "public/favicon.svg",
      "public/favicon.png",
      "public/favicon.ico",
    ]);
  });

  it("makes a favicon the default over any other icon found", () => {
    expect(
      order([cand("src-tauri/icons/128x128.png"), cand("app/icon.png"), cand("assets/icon.svg"), cand("public/favicon.ico")])[0],
    ).toBe("public/favicon.ico");
    expect(order([cand("public/favicon.ico"), cand("favicon.svg")])[0]).toBe("favicon.svg");
  });

  it("prefers a PNG of a sensible size over a tiny or a huge one", () => {
    expect(
      order([
        cand("src-tauri/icons/icon.png"),
        cand("src-tauri/icons/1024x1024.png"),
        cand("src-tauri/icons/16x16.png"),
        cand("src-tauri/icons/128x128.png"),
        cand("src-tauri/icons/32x32.png"),
      ])[0],
    ).toBe("src-tauri/icons/128x128.png");
    expect(order([cand("public/favicon-16x16.png"), cand("public/favicon-32x32.png")])[0]).toBe(
      "public/favicon-32x32.png",
    );
  });

  it("prefers root and public over deeper folders", () => {
    expect(order([cand("src-tauri/icons/128x128.png"), cand("public/icon.png")])[0]).toBe("public/icon.png");
    expect(order([cand("assets/icon.svg"), cand("favicon.svg")])[0]).toBe("favicon.svg");
  });

  it("drops dependencies, build output, oversized files and non-icons", () => {
    expect(
      order([
        cand("node_modules/some-lib/favicon.svg"),
        cand("dist/favicon.svg"),
        cand("build/icon.png"),
        cand(".next/static/favicon.ico"),
        cand("public/huge.png", { size: MAX_ICON_BYTES + 1 }),
        cand("public/empty.png", { size: 0 }),
        cand("src-tauri/icons/icon.icns"),
        cand("public/favicon.ico", { size: 4000 }),
      ]),
    ).toEqual(["public/favicon.ico"]);
  });

  it("favours a file the project's index.html links to, and breaks ties deterministically", () => {
    expect(order([cand("public/icon.svg"), cand("public/logo-mark.svg", { fromHtml: true })])[0]).toBe(
      "public/logo-mark.svg",
    );
    expect(order([cand("public/icon-b.svg"), cand("public/icon-a.svg")])).toEqual(["public/icon-a.svg", "public/icon-b.svg"]);
  });

  it("prefers the first component when two components tie", () => {
    const ranked = rankIconCandidates([
      { path: "/w/api/public/favicon.svg", rel: "public/favicon.svg", component: 1 },
      { path: "/w/web/public/favicon.svg", rel: "public/favicon.svg", component: 0 },
    ]);
    expect(ranked[0].path).toBe("/w/web/public/favicon.svg");
  });
});

describe("file name helpers", () => {
  it("recognises icon file names", () => {
    expect(isIconFile("public", "favicon.svg")).toBe(true);
    expect(isIconFile("public", "favicon-32x32.png")).toBe(true);
    expect(isIconFile("", "apple-touch-icon.png")).toBe(true);
    expect(isIconFile("app", "icon.png")).toBe(true);
    expect(isIconFile("public", "hero.png")).toBe(false);
    expect(isIconFile("public", "favicon.txt")).toBe(false);
    expect(isIconFile("src-tauri/icons", "Square44x44Logo.png")).toBe(true);
    expect(isIconFile("src-tauri/icons", "icon.icns")).toBe(false);
  });

  it("reads a size hint from the name", () => {
    expect(sizeHint("public/favicon-32x32.png")).toBe(32);
    expect(sizeHint("public/icon-192.png")).toBe(192);
    expect(sizeHint("src-tauri/icons/128x128@2x.png")).toBe(256);
    expect(sizeHint("public/apple-touch-icon.png")).toBe(180);
    expect(sizeHint("public/favicon.png")).toBeUndefined();
  });
});

describe("index.html icon links", () => {
  it("collects icon links and skips other links", () => {
    const html = `<head>
      <link rel="stylesheet" href="/style.css">
      <link rel="mask-icon" href="/mask.svg" color="#000">
      <link rel="icon" type="image/svg+xml" href="/brand/mark.svg" />
      <link href='favicon.ico' rel='shortcut icon'>
      <link rel=apple-touch-icon href=/touch.png>
    </head>`;
    expect(iconLinkHrefs(html)).toEqual(["/brand/mark.svg", "favicon.ico", "/touch.png"]);
  });

  it("resolves hrefs inside the project only", () => {
    expect(resolveIconHref("/favicon.svg?v=2")).toEqual(["public/favicon.svg", "favicon.svg"]);
    expect(resolveIconHref("./img/icon.png")).toEqual(["img/icon.png"]);
    expect(resolveIconHref("https://cdn.example.test/icon.png")).toEqual([]);
    expect(resolveIconHref("//cdn.example.test/icon.png")).toEqual([]);
    expect(resolveIconHref("data:image/png;base64,AAAA")).toEqual([]);
    expect(resolveIconHref("../../secret.png")).toEqual([]);
    expect(resolveIconHref("%E0%A4%A")).toEqual([]);
  });
});

describe("image bytes", () => {
  it("types by content, not by name", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(ICO)).toBe("image/x-icon");
    expect(sniffImageType(SVG)).toBe("image/svg+xml");
    expect(sniffImageType(new TextEncoder().encode('<?xml version="1.0"?>\n<svg>'))).toBe("image/svg+xml");
    expect(sniffImageType(new TextEncoder().encode("<html><script>alert(1)</script>"))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });

  it("encodes a data: URL", () => {
    expect(bytesToDataUrl(new TextEncoder().encode("hi"), "image/png")).toBe("data:image/png;base64,aGk=");
  });
});

describe("the user's choice", () => {
  it("accepts well-formed choices and treats anything else as auto", () => {
    expect(normalizeProjectIcon({ kind: "none" })).toEqual({ kind: "none" });
    expect(normalizeProjectIcon({ kind: "emoji", emoji: "🚀" })).toEqual({ kind: "emoji", emoji: "🚀" });
    expect(normalizeProjectIcon({ kind: "emoji", emoji: "a very long label" })).toBeUndefined();
    expect(normalizeProjectIcon({ kind: "image", dataUrl: "data:image/png;base64,AAAA" })).toEqual({
      kind: "image",
      dataUrl: "data:image/png;base64,AAAA",
    });
    expect(normalizeProjectIcon({ kind: "image", dataUrl: "javascript:alert(1)" })).toBeUndefined();
    expect(normalizeProjectIcon({ kind: "image", dataUrl: "data:text/html;base64,AAAA" })).toBeUndefined();
    expect(normalizeProjectIcon({ kind: "bogus" })).toBeUndefined();
    expect(normalizeProjectIcon(null)).toBeUndefined();
  });

  it("wins over the detected icon", () => {
    const found = "data:image/png;base64,Zm91bmQ=";
    expect(tabIconFor(undefined, found)).toEqual({ kind: "img", src: found });
    expect(tabIconFor({ kind: "path", path: "/x/icon.png" }, found)).toEqual({ kind: "img", src: found });
    expect(tabIconFor({ kind: "none" }, found)).toBeNull();
    expect(tabIconFor({ kind: "emoji", emoji: "🌲" }, found)).toEqual({ kind: "emoji", text: "🌲" });
    expect(tabIconFor({ kind: "image", dataUrl: "data:image/png;base64,bWluZQ==" }, found)).toEqual({
      kind: "img",
      src: "data:image/png;base64,bWluZQ==",
    });
    expect(tabIconFor(undefined, undefined)).toBeNull();
    expect(tabIconFor(undefined, "https://example.test/x.png")).toBeNull();
  });
});

describe("detectProjectIcons", () => {
  it("finds icons in the conventional folders, best first", async () => {
    const fs = memoryFs({
      [`${ROOT}/package.json`]: "{}",
      [`${ROOT}/public/favicon.ico`]: ICO,
      [`${ROOT}/public/favicon.svg`]: SVG,
      [`${ROOT}/public/hero.png`]: PNG,
      [`${ROOT}/src-tauri/icons/128x128.png`]: PNG,
      [`${ROOT}/node_modules/pkg/favicon.svg`]: SVG,
    });
    const found = await detectProjectIcons([ROOT], fs);
    // Favicons first (SVG over ICO), then the app icon.
    expect(found.map((c) => c.rel)).toEqual(["public/favicon.svg", "public/favicon.ico", "src-tauri/icons/128x128.png"]);
    expect(found[0].size).toBe(SVG.length);
  });

  it("follows a <link rel=icon> in the root index.html", async () => {
    const fs = memoryFs({
      [`${ROOT}/index.html`]: '<link rel="icon" href="/brand/mark.png">',
      [`${ROOT}/public/brand/mark.png`]: PNG,
      [`${ROOT}/public/favicon.ico`]: ICO,
    });
    const found = await detectProjectIcons([ROOT], fs);
    expect(found[0]).toMatchObject({ rel: "public/brand/mark.png", fromHtml: true });
  });

  it("looks in every component folder", async () => {
    const fs = memoryFs({
      "/w/api/main.go": "package main",
      "/w/web/app/icon.png": PNG,
    });
    const found = await detectProjectIcons(["/w/api", "/w/web"], fs);
    expect(found.map((c) => c.path)).toEqual(["/w/web/app/icon.png"]);
  });

  it("says 'can't look' rather than 'no icon' when the folders are out of reach", async () => {
    await expect(detectProjectIcons([ROOT], memoryFs({}, { scoped: false }))).rejects.toThrow(/scope/);
    await expect(resolveProjectIcon({ components: [{ id: "c", label: "c", path: ROOT }] }, memoryFs({}, { scoped: false }))).resolves.toBeUndefined();
  });

  it("loads the first candidate that is really an image", async () => {
    const fs = memoryFs({
      [`${ROOT}/public/favicon.svg`]: "<html>not an svg</html>",
      [`${ROOT}/public/favicon.png`]: PNG,
    });
    const url = await loadBestIcon(await detectProjectIcons([ROOT], fs), fs);
    expect(url).toBe(bytesToDataUrl(PNG, "image/png"));
  });

  it("resolves a chosen project file, and nothing for a non-file choice", async () => {
    const fs = memoryFs({ [`${ROOT}/assets/icon.svg`]: SVG, [`${ROOT}/public/favicon.ico`]: ICO });
    const components = [{ id: "c", label: "c", path: ROOT }];
    await expect(resolveProjectIcon({ components, icon: { kind: "path", path: `${ROOT}/public/favicon.ico` } }, fs)).resolves.toBe(
      bytesToDataUrl(ICO, "image/x-icon"),
    );
    // Auto: the favicon, though an SVG app icon exists too.
    await expect(resolveProjectIcon({ components }, fs)).resolves.toBe(bytesToDataUrl(ICO, "image/x-icon"));
    await expect(resolveProjectIcon({ components, icon: { kind: "none" } }, fs)).resolves.toBeNull();
    // Gone from a readable folder: no icon. Folder unreadable: can't tell yet.
    await expect(resolveProjectIcon({ components, icon: { kind: "path", path: `${ROOT}/public/gone.png` } }, fs)).resolves.toBeNull();
    await expect(
      resolveProjectIcon({ components, icon: { kind: "path", path: `${ROOT}/public/favicon.ico` } }, memoryFs({}, { scoped: false })),
    ).resolves.toBeUndefined();
  });
});

describe("remembered icons", () => {
  beforeEach(() => localStorage.clear());

  it("are kept per project and setup", () => {
    const project = { components: [{ id: "c", label: "c", path: ROOT }] };
    const sig = iconSignature(project);
    expect(cachedIcon("p1", sig)).toBeUndefined();
    rememberIcon("p1", sig, "data:image/png;base64,AAAA");
    expect(cachedIcon("p1", sig)).toBe("data:image/png;base64,AAAA");
    const moved = iconSignature({ components: [{ id: "c", label: "c", path: "/elsewhere" }] });
    expect(cachedIcon("p1", moved)).toBeUndefined();
    rememberIcon("p1", sig, null);
    expect(cachedIcon("p1", sig)).toBeNull();
  });
});
