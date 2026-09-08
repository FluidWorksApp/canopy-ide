import { beforeEach, expect, it, vi } from "vitest";
import * as ipc from "./ipc";
import { emptyBuildProject } from "./vibeBootstrap";
vi.mock("./ipc", () => ({ fsReadDir: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
it("accepts a new repository's metadata and README", async () => {
  vi.mocked(ipc.fsReadDir).mockResolvedValue([".git", "README.md", ".gitignore"].map((name) => ({ name, path: `/app/${name}`, is_dir: name === ".git" })));
  expect(await emptyBuildProject([{ id: "app", label: "App", path: "/app" }])).toBe(true);
});
it("never scaffolds over source files or a configured command", async () => {
  vi.mocked(ipc.fsReadDir).mockResolvedValue([{ name: "src", path: "/app/src", is_dir: true }]);
  expect(await emptyBuildProject([{ id: "app", label: "App", path: "/app" }])).toBe(false);
  expect(await emptyBuildProject([{ id: "app", label: "App", path: "/app", commands: [{ id: "dev", name: "Dev", command: "npm run dev" }] }])).toBe(false);
  expect(await emptyBuildProject([])).toBe(false);
});
