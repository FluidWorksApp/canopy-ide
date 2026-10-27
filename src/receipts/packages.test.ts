import { describe, expect, it } from "vitest";
import { cargoDeps, newDependencies, plausibleName, pythonDeps, registryArgv, registryStatus, registryUrl } from "./packages";

describe("newDependencies", () => {
  it("finds npm names added in any dependency section, skipping local specs", () => {
    const before = JSON.stringify({ dependencies: { react: "^18" } });
    const after = JSON.stringify({
      dependencies: { react: "^18", "left-padz": "^1.0.0", local: "file:../local" },
      devDependencies: { "@scope/tool": "2.0.0", ws: "workspace:*" },
      scripts: { test: "vitest" },
    });
    expect(newDependencies("web/package.json", before, after).map((d) => d.name)).toEqual(["left-padz", "@scope/tool"]);
  });

  it("treats a brand-new manifest as all-new", () => {
    expect(newDependencies("package.json", null, JSON.stringify({ dependencies: { a: "1" } }))).toEqual([
      { ecosystem: "npm", name: "a", manifest: "package.json" },
    ]);
  });

  it("reads Cargo tables, skipping path, git and workspace deps and following renames", () => {
    const toml = `[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\nlocal = { path = "../local" }\nfork = { git = "https://x" }\nshared = { workspace = true }\nrenamed = { package = "real-crate", version = "1" }\n\n[dev-dependencies]\nproptest = "1"\n\n[dependencies.tokio]\nversion = "1"\n`;
    expect([...cargoDeps(toml).keys()]).toEqual(["serde", "real-crate", "proptest", "tokio"]);
    expect(newDependencies("Cargo.toml", "[dependencies]\nserde = \"1\"\n", toml).map((d) => d.name)).toEqual(["real-crate", "proptest", "tokio"]);
  });

  it("reads requirements files and pyproject dependencies", () => {
    expect([...pythonDeps("# deps\nrequests>=2\n-e .\nFlask==3.0 ; python_version>'3'\nhttps://x/y.whl\n", "requirements.txt").keys()]).toEqual(["requests", "flask"]);
    expect([...pythonDeps('[project]\ndependencies = [\n  "httpx>=0.27",\n  "rich",\n]\n', "pyproject.toml").keys()]).toEqual(["httpx", "rich"]);
    expect(newDependencies("requirements-dev.txt", "requests\n", "requests\nreqeusts\n")[0]).toMatchObject({ ecosystem: "pypi", name: "reqeusts" });
  });

  it("ignores files that are not manifests", () => {
    expect(newDependencies("src/package.ts", null, "{}")).toEqual([]);
  });
});

describe("registry lookups", () => {
  it("builds registry URLs, escaping scoped npm names", () => {
    expect(registryUrl({ ecosystem: "npm", name: "@scope/tool" })).toBe("https://registry.npmjs.org/@scope%2Ftool");
    expect(registryUrl({ ecosystem: "crates", name: "serde" })).toBe("https://crates.io/api/v1/crates/serde");
    expect(registryUrl({ ecosystem: "pypi", name: "httpx" })).toBe("https://pypi.org/pypi/httpx/json");
  });

  it("asks curl for only the status code, with a timeout", () => {
    const argv = registryArgv({ ecosystem: "npm", name: "a", manifest: "package.json" }, "unix");
    expect(argv).toEqual(expect.arrayContaining(["curl", "-I", "-w", "%{http_code}", "--max-time", "/dev/null"]));
    expect(registryArgv({ ecosystem: "crates", name: "a", manifest: "Cargo.toml" }, "windows")).not.toContain("-I");
  });

  it("maps 200 to exists, 404 to unknown, anything else to unchecked", () => {
    expect(registryStatus(0, "200")).toBe("exists");
    expect(registryStatus(0, "404")).toBe("unknown");
    expect(registryStatus(0, "503")).toBe("unchecked");
    expect(registryStatus(28, "000")).toBe("unchecked");
  });

  it("refuses names that are not package-shaped", () => {
    expect(plausibleName({ ecosystem: "npm", name: "@a/b", manifest: "" })).toBe(true);
    expect(plausibleName({ ecosystem: "npm", name: "a b; rm -rf", manifest: "" })).toBe(false);
    expect(plausibleName({ ecosystem: "crates", name: "../x", manifest: "" })).toBe(false);
  });
});
