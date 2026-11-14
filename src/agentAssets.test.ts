import { describe, expect, it, vi } from "vitest";
import { assetKind, collectAssets, hasTextPreview, imageMime, isPreviewUrl, previewAssets, resolveAssetPath, stopServerFor } from "./agentAssets";

describe("assetKind", () => {
  it("recognises documents, images and pages, and ignores source code", () => {
    expect(assetKind("docs/plan.md")).toBe("markdown");
    expect(assetKind("a/hero.PNG")).toBe("image");
    expect(assetKind("out/index.html")).toBe("html");
    expect(assetKind("report.pdf")).toBe("pdf");
    expect(assetKind("data/rows.csv")).toBe("sheet");
    expect(assetKind("src/app.ts")).toBeNull();
    expect(assetKind("Cargo.toml")).toBeNull();
    expect(assetKind("README")).toBeNull();
  });
  it("leaves out project configuration that happens to be json", () => {
    expect(assetKind("package.json")).toBeNull();
    expect(assetKind("web/tsconfig.json")).toBeNull();
    expect(assetKind("schema.json")).toBe("json");
  });
});

describe("resolveAssetPath", () => {
  it("joins a relative entry to the agent's folder and keeps an absolute one", () => {
    expect(resolveAssetPath("docs/a.md", "/w/repo")).toBe("/w/repo/docs/a.md");
    expect(resolveAssetPath("./a.md", "/w/repo/")).toBe("/w/repo/a.md");
    expect(resolveAssetPath("/tmp/scratch/b.png", "/w/repo")).toBe("/tmp/scratch/b.png");
    expect(resolveAssetPath("C:\\x\\b.png", "/w")).toBe("C:\\x\\b.png");
  });
});

describe("collectAssets", () => {
  const files = ["src/a.ts", "docs/old.md", "hero.png", "/tmp/scratch/risk report.md", "docs/old.md", "src/b.rs", "page.html"];
  it("lists assets newest first, once each, with absolute paths", () => {
    const out = collectAssets(files, "/w/repo");
    // A file written again moves to the top: old.md was touched after hero.png.
    expect(out.map((a) => a.name)).toEqual(["page.html", "old.md", "risk report.md", "hero.png"]);
    expect(out[2]).toMatchObject({ path: "/tmp/scratch/risk report.md", kind: "markdown" });
    expect(out[1].path).toBe("/w/repo/docs/old.md");
  });
  it("is empty for no files and bounded for many", () => {
    expect(collectAssets(undefined, "/w")).toEqual([]);
    const many = Array.from({ length: 100 }, (_, i) => `d/${i}.md`);
    expect(collectAssets(many, "/w", 40)).toHaveLength(40);
  });
  it("skips anything that is not a string", () => {
    expect(collectAssets([1 as never, "", "a.md"], "/w").map((a) => a.name)).toEqual(["a.md"]);
  });
});

describe("previews", () => {
  it("knows image types and which kinds have a text excerpt", () => {
    expect(imageMime("x/a.JPG")).toBe("image/jpeg");
    expect(imageMime("x/a.bin")).toBe("application/octet-stream");
    expect(hasTextPreview("markdown")).toBe(true);
    expect(hasTextPreview("pdf")).toBe(false);
  });
});

describe("previewAssets", () => {
  it("lists the servers an agent is running, once each, lowest first", () => {
    expect(previewAssets([5173, 3000, 3000, 80, 70000, 1.5]).map((a) => a.path)).toEqual(["http://localhost:3000", "http://localhost:5173"]);
    expect(previewAssets(undefined)).toEqual([]);
    expect(previewAssets([3000])[0]).toMatchObject({ name: "localhost:3000", kind: "preview" });
    expect(isPreviewUrl("http://localhost:3000")).toBe(true);
    expect(isPreviewUrl("/tmp/a.md")).toBe(false);
  });
});

describe("stopServerFor", () => {
  const stat = {
    id: 3,
    procs: [
      { pid: 10, parent: 1 },
      { pid: 11, parent: 10, ports: [5173] },
      { pid: 12, parent: 10, ports: [5173, 9229] },
      { pid: 13, parent: 10, ports: [] },
    ],
  };

  it("kills exactly the processes listening on that port", async () => {
    const kill = vi.fn().mockResolvedValue(undefined);
    const s = stopServerFor(stat, kill)!;
    expect(s.ports).toEqual([5173, 9229]);
    await s.stop(9229);
    expect(kill.mock.calls).toEqual([[12]]);
    await s.stop(5173);
    expect(kill.mock.calls.slice(1)).toEqual([[11], [12]]);
    await expect(s.stop(8080)).rejects.toThrow("nothing is listening");
  });

  it("never offers the terminal's own process or the agent CLI", async () => {
    const kill = vi.fn().mockResolvedValue(undefined);
    const agentTerminal = {
      id: 4,
      agent_hint: { bin: "claude" },
      procs: [
        { pid: 20, parent: 1, ports: [7000] }, // the shell
        { pid: 21, parent: 20, ports: [54545] }, // the agent CLI, with its own port
        { pid: 22, parent: 21 },
        { pid: 23, parent: 22, ports: [5173] }, // a dev server the agent started
      ],
    };
    const s = stopServerFor(agentTerminal, kill)!;
    expect(s.ports).toEqual([5173]);
    await s.stop(5173);
    expect(kill.mock.calls).toEqual([[23]]);
    // A plain shell: what it runs directly is the server.
    expect(stopServerFor({ ...agentTerminal, agent_hint: null }, kill)!.ports).toEqual([54545, 5173]);
  });

  it("offers nothing when no process reports a port", () => {
    expect(stopServerFor({ id: 1, procs: [{ pid: 1, parent: null }] }, vi.fn())).toBeUndefined();
    expect(stopServerFor(undefined, vi.fn())).toBeUndefined();
  });
});
